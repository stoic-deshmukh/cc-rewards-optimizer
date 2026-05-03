require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // needed for Twilio webhooks
app.use(express.static(path.join(__dirname, 'public')));

// ─── Supabase ────────────────────────────────────────────────────────────────

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url) throw new Error('SUPABASE_URL not configured');
  if (!key) throw new Error('SUPABASE_KEY not configured');
  return createClient(url, key);
}

async function getCardStructures() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('cards')
    .select('card_name, issuer, reward_structure, last_updated')
    .eq('is_active', true)
    .order('card_name');

  if (error) throw new Error(`Failed to fetch card data: ${error.message}`);
  if (!data || data.length === 0) throw new Error('No active cards found in database');

  return data
    .map((card, i) =>
      `### ${i + 1}. ${card.card_name} (${card.issuer})\nLast updated: ${new Date(card.last_updated).toDateString()}\n${card.reward_structure}`
    )
    .join('\n\n');
}

// ─── Claude recommendation ───────────────────────────────────────────────────

async function getRecommendation({ category, merchant, amount, transactionType }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const cardStructures = await getCardStructures();
  const client = new Anthropic({ apiKey });

  const prompt = `You are a credit card rewards expert specializing in Indian credit cards. Analyze the following transaction and rank ALL cards from best to worst for this specific transaction.

## Indian Credit Card Reward Structures (sourced from latest MITC)

${cardStructures}

## Transaction Details
- Category: ${category}
- Merchant: ${merchant || 'Not specified'}
- Amount: ₹${amount}
- Transaction Type: ${transactionType} (online = via app/website; offline = physical swipe/tap at store)

## Instructions
Analyze each card for this exact transaction. Consider:
1. The specific category and merchant (e.g., Swiggy orders get 10% on HDFC Swiggy card)
2. Whether online/offline matters (SBI Cashback gives 5% online vs 1% offline)
3. Calculate exact reward amount in ₹
4. Note any caps that may apply
5. Account for forex markup if international category

Return a JSON object with this exact structure (no markdown, raw JSON only):
{
  "recommendations": [
    {
      "rank": 1,
      "card": "Card Name",
      "reward_type": "Cashback/Points/Coins",
      "reward_earned": "₹XX.XX",
      "effective_cashback_pct": "X.XX%",
      "key_reason": "One-line winner reason",
      "reasoning": "2-3 sentence detailed reasoning explaining why this card ranks here and any caveats/caps"
    }
  ],
  "winner_summary": "2-sentence summary of the best card for this transaction and why it wins clearly"
}

Rank all cards. The array must have exactly one entry per card ordered rank 1 (best) to last (worst).`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = message.content[0].text.trim();
  const jsonStr = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(jsonStr);
}

// ─── Web API ─────────────────────────────────────────────────────────────────

app.post('/api/recommend', async (req, res) => {
  const { category, merchant, amount, transactionType } = req.body;
  if (!category || !amount || !transactionType) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const result = await getRecommendation({ category, merchant, amount, transactionType });
    res.json(result);
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message || 'Failed to get recommendation' });
  }
});

// ─── WhatsApp bot session state ───────────────────────────────────────────────

const sessions = new Map();
// session shape: { step: 'category'|'merchant'|'amount'|'txntype'|'processing', data: {} }

const CATEGORIES = ['dining', 'groceries', 'travel', 'fuel', 'online shopping', 'international'];

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, { step: 'category', data: {} });
  }
  return sessions.get(from);
}

function resetSession(from) {
  sessions.set(from, { step: 'category', data: {} });
}

function categoryMenu() {
  return `👋 Welcome to *CardIQ*! Which category is this transaction?

1️⃣ Dining
2️⃣ Groceries
3️⃣ Travel
4️⃣ Fuel
5️⃣ Online Shopping
6️⃣ International

Reply with a number (1-6)`;
}

function formatWhatsAppResult(result) {
  const winner = result.recommendations[0];
  const lines = [
    `🏆 *Best Card: ${winner.card}*`,
    `💰 ${winner.reward_earned} cashback (${winner.effective_cashback_pct})`,
    `💡 ${winner.key_reason}`,
    ``,
    `📊 *All Cards Ranked:*`,
  ];

  result.recommendations.forEach((rec) => {
    const medal = rec.rank === 1 ? '🥇' : rec.rank === 2 ? '🥈' : rec.rank === 3 ? '🥉' : `${rec.rank}.`;
    lines.push(`${medal} ${rec.card} — ${rec.reward_earned} (${rec.effective_cashback_pct})`);
  });

  lines.push('');
  lines.push(`📝 ${result.winner_summary}`);
  lines.push('');
  lines.push('_Reply *menu* to analyse another transaction_');

  return lines.join('\n');
}

// ─── WhatsApp webhook ─────────────────────────────────────────────────────────

app.post('/webhook/whatsapp', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const from = req.body.From;
  const body = (req.body.Body || '').trim();
  const lower = body.toLowerCase();

  // Reset command
  if (lower === 'menu' || lower === 'hi' || lower === 'hello' || lower === 'start') {
    resetSession(from);
  }

  const session = getSession(from);

  try {
    if (session.step === 'category') {
      const num = parseInt(body);
      if (num >= 1 && num <= 6) {
        session.data.category = CATEGORIES[num - 1];
        session.step = 'merchant';
        twiml.message(`Got it — *${session.data.category}*! 🛍️\n\nMerchant name? (e.g. Zomato, Amazon, MakeMyTrip)\nOr reply *skip* to continue`);
      } else {
        twiml.message(categoryMenu());
      }

    } else if (session.step === 'merchant') {
      session.data.merchant = lower === 'skip' ? '' : body;
      session.step = 'amount';
      twiml.message(`💸 How much is the transaction amount in ₹?\n\n(Just the number, e.g. 1500)`);

    } else if (session.step === 'amount') {
      const amount = parseFloat(body.replace(/,/g, ''));
      if (isNaN(amount) || amount <= 0) {
        twiml.message(`Please enter a valid amount in ₹ (e.g. 1500)`);
      } else {
        session.data.amount = amount;
        session.step = 'txntype';
        twiml.message(`Online or offline transaction?\n\n1️⃣ Online (app/website)\n2️⃣ Offline (physical store/swipe)\n\nReply 1 or 2`);
      }

    } else if (session.step === 'txntype') {
      if (body === '1' || body === '2') {
        session.data.transactionType = body === '1' ? 'online' : 'offline';
        session.step = 'processing';

        twiml.message(`⏳ Analysing across all 6 cards... give me a moment!`);
        res.type('text/xml');
        res.send(twiml.toString());

        // Call Claude in background and send result
        try {
          const result = await getRecommendation(session.data);
          const msg = formatWhatsAppResult(result);
          const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await client.messages.create({
            from: req.body.To,
            to: from,
            body: msg
          });
        } catch (err) {
          const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await client.messages.create({
            from: req.body.To,
            to: from,
            body: `❌ Sorry, something went wrong: ${err.message}\n\nReply *menu* to try again`
          });
        }

        resetSession(from);
        return; // already sent response above

      } else {
        twiml.message(`Please reply 1 for Online or 2 for Offline`);
      }

    } else {
      resetSession(from);
      twiml.message(categoryMenu());
    }

  } catch (err) {
    console.error('WhatsApp error:', err);
    twiml.message(`❌ Something went wrong. Reply *menu* to start again.`);
    resetSession(from);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ─── Server ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`CardIQ running at http://localhost:${PORT}`);
  });
}

module.exports = app;

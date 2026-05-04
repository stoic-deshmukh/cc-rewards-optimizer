require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
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

async function saveTransaction({ userId, category, merchant, amount, transactionType, result, source }) {
  try {
    const supabase = getSupabase();
    const winner = result.recommendations[0];
    await supabase.from('transactions').insert({
      user_id: userId,
      category,
      merchant: merchant || null,
      amount,
      transaction_type: transactionType,
      best_card: winner.card,
      reward_earned: winner.reward_earned,
      cashback_pct: winner.effective_cashback_pct,
      all_recommendations: result.recommendations,
      source
    });
  } catch (err) {
    console.error('Failed to save transaction:', err.message);
    // non-fatal — don't break the main flow
  }
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
  const { category, merchant, amount, transactionType, userId } = req.body;
  if (!category || !amount || !transactionType) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const result = await getRecommendation({ category, merchant, amount, transactionType });
    // Save to history (non-blocking)
    saveTransaction({ userId: userId || 'web-anonymous', category, merchant, amount, transactionType, result, source: 'web' });
    res.json(result);
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message || 'Failed to get recommendation' });
  }
});

app.get('/api/history', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('transactions')
      .select('id, category, merchant, amount, transaction_type, best_card, reward_earned, cashback_pct, source, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WhatsApp bot ─────────────────────────────────────────────────────────────

const CATEGORIES = ['dining', 'groceries', 'travel', 'fuel', 'online shopping', 'international'];

async function getSession(from) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('whatsapp_sessions')
    .select('step, data')
    .eq('phone', from)
    .single();
  return data || { step: 'category', data: {} };
}

async function saveSession(from, step, data) {
  const supabase = getSupabase();
  await supabase.from('whatsapp_sessions').upsert({
    phone: from, step, data, updated_at: new Date().toISOString()
  }, { onConflict: 'phone' });
}

async function resetSession(from) {
  const supabase = getSupabase();
  await supabase.from('whatsapp_sessions').upsert({
    phone: from, step: 'category', data: {}, updated_at: new Date().toISOString()
  }, { onConflict: 'phone' });
}

function categoryMenu() {
  return `👋 Welcome to *CardIQ*! Which category is this transaction?\n\n1️⃣ Dining\n2️⃣ Groceries\n3️⃣ Travel\n4️⃣ Fuel\n5️⃣ Online Shopping\n6️⃣ International\n\nReply with a number (1-6)`;
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
  lines.push('', `📝 ${result.winner_summary}`, '', '_Reply *menu* to analyse another transaction_');
  return lines.join('\n');
}

app.post('/webhook/whatsapp', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const from = req.body.From;
  const body = (req.body.Body || '').trim();
  const lower = body.toLowerCase();

  try {
    if (['menu', 'hi', 'hello', 'start'].includes(lower)) {
      await resetSession(from);
      twiml.message(categoryMenu());
      return res.type('text/xml').send(twiml.toString());
    }

    const session = await getSession(from);

    if (session.step === 'category') {
      const num = parseInt(body);
      if (num >= 1 && num <= 6) {
        const category = CATEGORIES[num - 1];
        await saveSession(from, 'merchant', { category });
        twiml.message(`Got it — *${category}*! 🛍️\n\nMerchant name? (e.g. Zomato, Amazon)\nOr reply *skip*`);
      } else {
        twiml.message(categoryMenu());
      }

    } else if (session.step === 'merchant') {
      const merchant = lower === 'skip' ? '' : body;
      await saveSession(from, 'amount', { ...session.data, merchant });
      twiml.message(`💸 Amount in ₹? (just the number, e.g. 1500)`);

    } else if (session.step === 'amount') {
      const amount = parseFloat(body.replace(/,/g, ''));
      if (isNaN(amount) || amount <= 0) {
        twiml.message(`Please enter a valid amount in ₹ (e.g. 1500)`);
      } else {
        await saveSession(from, 'txntype', { ...session.data, amount });
        twiml.message(`Online or offline?\n\n1️⃣ Online (app/website)\n2️⃣ Offline (physical store)\n\nReply 1 or 2`);
      }

    } else if (session.step === 'txntype') {
      if (body === '1' || body === '2') {
        const transactionType = body === '1' ? 'online' : 'offline';
        const txnData = { ...session.data, transactionType };
        await resetSession(from);

        try {
          const result = await getRecommendation(txnData);
          saveTransaction({ userId: from, ...txnData, result, source: 'whatsapp' });
          twiml.message(formatWhatsAppResult(result));
        } catch (err) {
          twiml.message(`❌ Sorry, something went wrong. Reply *menu* to try again.\n\nError: ${err.message}`);
        }

      } else {
        twiml.message(`Please reply 1 for Online or 2 for Offline`);
      }

    } else {
      await resetSession(from);
      twiml.message(categoryMenu());
    }

  } catch (err) {
    console.error('WhatsApp error:', err);
    twiml.message(`❌ Something went wrong. Reply *menu* to start again.`);
  }

  res.type('text/xml').send(twiml.toString());
});

// ─── Server ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`CardIQ running at http://localhost:${PORT}`));
}

module.exports = app;

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
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

let cardCache = { data: null, fetchedAt: 0 };
const CARD_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getCardStructures() {
  const now = Date.now();
  if (cardCache.data && now - cardCache.fetchedAt < CARD_CACHE_TTL_MS) {
    return cardCache.data;
  }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('cards')
      .select('card_name, issuer, reward_structure, last_updated')
      .eq('is_active', true)
      .order('card_name');

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) throw new Error('No active cards found in database');

    const formatted = data
      .map((card, i) =>
        `### ${i + 1}. ${card.card_name} (${card.issuer})\nLast updated: ${new Date(card.last_updated).toDateString()}\n${card.reward_structure}`
      )
      .join('\n\n');

    cardCache = { data: formatted, fetchedAt: now };
    return formatted;
  } catch (err) {
    // If Supabase is unreachable but we have stale cache, use it rather than failing
    if (cardCache.data) {
      console.warn('Supabase fetch failed, using stale cache:', err.message);
      return cardCache.data;
    }
    throw new Error(`Failed to fetch card data: ${err.message}`);
  }
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

// ─── API ──────────────────────────────────────────────────────────────────────

app.post('/api/recommend', async (req, res) => {
  const { category, merchant, amount, transactionType, userId } = req.body;
  if (!category || !amount || !transactionType) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const result = await getRecommendation({ category, merchant, amount, transactionType });
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

// ─── Server ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`CardIQ running at http://localhost:${PORT}`));
}

module.exports = app;

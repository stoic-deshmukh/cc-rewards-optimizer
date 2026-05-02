require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Fetch active card structures from Supabase
async function getCardStructures() {
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

app.post('/api/recommend', async (req, res) => {
  const { category, merchant, amount, transactionType } = req.body;

  if (!category || !amount || !transactionType) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  try {
    // Fetch latest card structures from DB
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
    const parsed = JSON.parse(jsonStr);
    res.json(parsed);

  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message || 'Failed to get recommendation' });
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Credit Card Rewards Optimizer running at http://localhost:${PORT}`);
  });
}

module.exports = app;

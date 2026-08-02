require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Card reward structures (hardcoded — edit here to update, no DB needed) ──

const CARD_STRUCTURES = `### 1. Scapia Federal Credit Card (Federal Bank)
Annual Fee: ₹0 (Lifetime Free)
Travel (flights, hotels, any platform): 10% in ScapiaCoins (1 ScapiaCoin = ₹1)
All other spends: 2% in ScapiaCoins
International transactions: 0% forex markup (excellent for international)
Fuel: 2% ScapiaCoins (no surcharge waiver)
Exclusions: No reward on EMI transactions, cash advances
Best for: Travel bookings, international transactions

### 2. Tata Neu Plus HDFC Bank Credit Card (HDFC Bank)
Annual Fee: ₹499
Tata ecosystem spends (BigBasket, 1mg, Croma, Tata Cliq, Air Asia India, Westside, Starbucks): 2% NeuCoins (1 NeuCoin = ₹1)
All other non-EMI spends: 1% NeuCoins
Dining at non-Tata restaurants: 1% NeuCoins
EMI transactions: 0% NeuCoins
International: 1% NeuCoins + 3.5% forex markup
Fee waiver: Spend ₹1L in a year
Best for: Tata ecosystem shopping (groceries via BigBasket, electronics via Croma)

### 3. ICICI Bank Sapphiro Credit Card (ICICI Bank)
Annual Fee: ₹3,500
Dining (restaurants): 4 reward points per ₹100 = 1% effective cashback (1 RP = ₹0.25)
Online shopping: 2 reward points per ₹100 = 0.5% effective cashback
Offline retail: 2 reward points per ₹100 = 0.5% effective cashback
Groceries: 2 reward points per ₹100 = 0.5% effective cashback
International: 2 reward points per ₹100 = 0.5% + 3.5% forex markup (net negative)
Fuel: 1 reward point per ₹100 = 0.25% effective (low value)
Exclusions: No reward points on fuel surcharge, cash advances, EMI
Perks: Airport lounge access (2/quarter domestic), golf privileges, concierge service
Best for: Dining, premium lifestyle benefits

### 4. SBI Cashback Credit Card (SBI Card)
Annual Fee: ₹999 (waived on ₹2L annual spend)
Online transactions (all categories): 5% cashback — capped at ₹5,000/month total cashback
Offline transactions: 1% cashback — capped at ₹5,000/month total cashback
Dining online (Swiggy, Zomato): 5% cashback (counts as online)
Groceries online (BigBasket, Blinkit, Zepto): 5% cashback
Travel online (MakeMyTrip, IRCTC, Cleartrip): 5% cashback
International online: 5% cashback + 3.5% forex markup (nearly negates benefit)
Exclusions: No cashback on fuel, utilities, EMI, rent, wallet loads, government transactions
Best for: All online transactions — highest flat rate for online spends

### 5. HDFC Diners Club Millennia Credit Card (HDFC Bank)
Annual Fee: ₹1,000 (waived on ₹1L quarterly spend)
Preferred partners online (Amazon, Flipkart, BookMyShow, Cult.fit, Myntra, Swiggy, Tata Cliq, Zomato): 5% cashback — capped at ₹750/month per merchant
All other online spends: 1% cashback
Offline retail spends: 1% cashback
Dining offline (non-preferred partners): 1% cashback
Dining at preferred partners (Swiggy, Zomato — online): 5% cashback
Fuel: No cashback
International: 1% cashback + 3.5% forex markup (poor for international)
Exclusions: No cashback on wallet loads, EMI, fuel, rent
Best for: Shopping at preferred partners (Amazon, Flipkart, Swiggy, Zomato)

### 6. HDFC Bank Swiggy Credit Card (HDFC Bank)
Annual Fee: ₹500
Swiggy app (food ordering + Instamart groceries): 10% cashback — capped at ₹1,500/month combined with partner cashback
Online spends at select partners (Amazon, BookMyShow, Cleartrip, Myntra, Ola, PhonePe, Uber, Zomato): 5% cashback — combined cap of ₹1,500/month with Swiggy cashback
All other spends (online and offline): 1% cashback
Dining offline (non-Swiggy restaurants): 1% cashback
Travel offline: 1% cashback
International: 1% cashback + 3.5% forex markup
Exclusions: No cashback on fuel, utilities, EMI, wallet loads
Best for: Swiggy orders, Instamart groceries, Uber/Ola rides`;

// ─── Supabase (used only for transaction history — non-critical) ──────────────

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

async function saveTransaction({ userId, category, merchant, amount, transactionType, result, source }) {
  try {
    const supabase = getSupabase();
    if (!supabase) return; // Supabase not configured — skip silently
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

  const cardStructures = CARD_STRUCTURES;
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

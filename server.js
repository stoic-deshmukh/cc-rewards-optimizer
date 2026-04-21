require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CARD_REWARD_STRUCTURES = `
## Indian Credit Card Reward Structures (2025)

### 1. Scapia Federal Credit Card
- Annual Fee: ₹0 (Lifetime Free)
- Travel (flights, hotels, any platform): 10% in ScapiaCoins (1 ScapiaCoin = ₹1)
- All other spends: 2% in ScapiaCoins
- International transactions: 0% forex markup (excellent for international)
- Fuel: 2% ScapiaCoins (no surcharge waiver)
- Best for: Travel bookings, international transactions

### 2. Tata Neu Plus HDFC Bank Credit Card
- Annual Fee: ₹499
- Tata ecosystem spends (BigBasket, 1mg, Croma, Tata Cliq, Air Asia India, Westside, Starbucks): 2% NeuCoins (1 NeuCoin = ₹1)
- All other non-EMI spends: 1% NeuCoins
- Dining at non-Tata restaurants: 1% NeuCoins
- EMI transactions: 0% NeuCoins
- International: 1% NeuCoins + 3.5% forex markup
- Best for: Tata ecosystem shopping (groceries via BigBasket, electronics via Croma)

### 3. ICICI Bank Sapphiro Credit Card
- Annual Fee: ₹3,500
- Dining (restaurants): 2 reward points per ₹100 (1 RP = ₹0.25, so ~0.5% base; dining actually gets 4 RP per ₹100 = 1%)
  - Dining: 4 RP per ₹100 = 1% effective cashback
- Online shopping: 2 RP per ₹100 = 0.5% effective cashback
- Offline retail: 2 RP per ₹100 = 0.5% effective cashback
- Grocery: 2 RP per ₹100 = 0.5% effective cashback
- International: 2 RP per ₹100 = 0.5% effective cashback + 3.5% forex markup (net negative for international)
- Travel (domestic flights via Yatra): bonus offers occasionally
- Fuel: 1 RP per ₹100 = 0.25% effective (low value)
- Perks: Airport lounge access (2/quarter domestic), golf, concierge
- Best for: Dining, premium lifestyle benefits

### 4. SBI Cashback Credit Card
- Annual Fee: ₹999 (waived on ₹2L annual spend)
- Online transactions (all categories): 5% cashback — capped at ₹5,000/month
- Offline transactions: 1% cashback — capped at ₹5,000/month
- Exclusions: No cashback on fuel, utilities, EMI, rent, wallet loads, government transactions
- Dining online (Swiggy, Zomato): 5% cashback (counts as online)
- Groceries online (BigBasket, Blinkit): 5% cashback
- Travel online (MakeMyTrip, IRCTC): 5% cashback
- International online: 5% cashback + 3.5% forex markup (nearly negates benefit internationally)
- Best for: All online transactions — highest flat rate for online

### 5. HDFC Diners Club Millennia Credit Card
- Annual Fee: ₹1,000 (waived on ₹1L quarterly spend)
- Preferred partners online (Amazon, Flipkart, BookMyShow, Cult.fit, Myntra, Swiggy, Tata Cliq, Zomato): 5% cashback — capped at ₹750/month per merchant
- All other online spends: 1% cashback
- Offline retail spends: 1% cashback
- Dining offline: 1% cashback
- Dining at preferred partners (Swiggy, Zomato): 5% cashback
- Fuel: No cashback
- International: 1% cashback + 3.5% forex markup (poor for international)
- Best for: Shopping at preferred partners (Amazon, Flipkart, Swiggy, Zomato)

### 6. HDFC Bank Swiggy Credit Card
- Annual Fee: ₹500
- Swiggy app (food ordering + Instamart groceries): 10% cashback — capped at ₹1,500/month combined
- Online spends at select partners (Amazon, BookMyShow, Cleartrip, Myntra, Ola, PhonePe, Uber, Zomato): 5% cashback — combined cap of ₹1,500/month with above
- All other spends (online and offline): 1% cashback
- Dining offline (non-Swiggy): 1% cashback
- Travel offline: 1% cashback
- International: 1% cashback + 3.5% forex markup
- Best for: Swiggy orders, Instamart groceries, Uber/Ola rides
`;

app.post('/api/recommend', async (req, res) => {
  const { category, merchant, amount, transactionType } = req.body;

  if (!category || !amount || !transactionType) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const client = new Anthropic({ apiKey });

  const prompt = `You are a credit card rewards expert specializing in Indian credit cards. Analyze the following transaction and rank ALL 6 credit cards from best to worst for this specific transaction.

${CARD_REWARD_STRUCTURES}

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

Rank all 6 cards. The array must have exactly 6 entries ordered rank 1 (best) to rank 6 (worst).`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0].text.trim();
    // Strip markdown code fences if present
    const jsonStr = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(jsonStr);
    res.json(parsed);
  } catch (err) {
    console.error('API error:', err);
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

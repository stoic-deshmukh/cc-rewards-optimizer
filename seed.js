require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const cards = [
  {
    card_name: 'Scapia Federal Credit Card',
    issuer: 'Federal Bank',
    mitc_url: 'https://www.scapia.app/terms',
    reward_structure: `
Annual Fee: ₹0 (Lifetime Free)
Travel (flights, hotels, any platform): 10% in ScapiaCoins (1 ScapiaCoin = ₹1)
All other spends: 2% in ScapiaCoins
International transactions: 0% forex markup (excellent for international)
Fuel: 2% ScapiaCoins (no surcharge waiver)
Exclusions: No reward on EMI transactions, cash advances
Best for: Travel bookings, international transactions
    `.trim()
  },
  {
    card_name: 'Tata Neu Plus HDFC Bank Credit Card',
    issuer: 'HDFC Bank',
    mitc_url: 'https://www.hdfcbank.com/content/api/contentstream-id/723fb80a-2dde-42a3-9793-7ae1be57c87f/tata-neu-plus-mitc',
    reward_structure: `
Annual Fee: ₹499
Tata ecosystem spends (BigBasket, 1mg, Croma, Tata Cliq, Air Asia India, Westside, Starbucks): 2% NeuCoins (1 NeuCoin = ₹1)
All other non-EMI spends: 1% NeuCoins
Dining at non-Tata restaurants: 1% NeuCoins
EMI transactions: 0% NeuCoins
International: 1% NeuCoins + 3.5% forex markup
Fee waiver: Spend ₹1L in a year
Best for: Tata ecosystem shopping (groceries via BigBasket, electronics via Croma)
    `.trim()
  },
  {
    card_name: 'ICICI Bank Sapphiro Credit Card',
    issuer: 'ICICI Bank',
    mitc_url: 'https://www.icicibank.com/managed-assets/docs/personal/cards/credit-cards/sapphiro-credit-card-mitc.pdf',
    reward_structure: `
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
    `.trim()
  },
  {
    card_name: 'SBI Cashback Credit Card',
    issuer: 'SBI Card',
    mitc_url: 'https://www.sbicard.com/sbi-card-en/assets/docs/pdf/cashback-sbi-card-mitc.pdf',
    reward_structure: `
Annual Fee: ₹999 (waived on ₹2L annual spend)
Online transactions (all categories): 5% cashback — capped at ₹5,000/month total cashback
Offline transactions: 1% cashback — capped at ₹5,000/month total cashback
Dining online (Swiggy, Zomato): 5% cashback (counts as online)
Groceries online (BigBasket, Blinkit, Zepto): 5% cashback
Travel online (MakeMyTrip, IRCTC, Cleartrip): 5% cashback
International online: 5% cashback + 3.5% forex markup (nearly negates benefit)
Exclusions: No cashback on fuel, utilities, EMI, rent, wallet loads, government transactions
Best for: All online transactions — highest flat rate for online spends
    `.trim()
  },
  {
    card_name: 'HDFC Diners Club Millennia Credit Card',
    issuer: 'HDFC Bank',
    mitc_url: 'https://www.hdfcbank.com/content/api/contentstream-id/723fb80a-2dde-42a3-9793-7ae1be57c87f/diners-club-millennia-mitc',
    reward_structure: `
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
    `.trim()
  },
  {
    card_name: 'HDFC Bank Swiggy Credit Card',
    issuer: 'HDFC Bank',
    mitc_url: 'https://www.hdfcbank.com/content/api/contentstream-id/723fb80a-2dde-42a3-9793-7ae1be57c87f/swiggy-hdfc-bank-credit-card-mitc',
    reward_structure: `
Annual Fee: ₹500
Swiggy app (food ordering + Instamart groceries): 10% cashback — capped at ₹1,500/month combined with partner cashback
Online spends at select partners (Amazon, BookMyShow, Cleartrip, Myntra, Ola, PhonePe, Uber, Zomato): 5% cashback — combined cap of ₹1,500/month with Swiggy cashback
All other spends (online and offline): 1% cashback
Dining offline (non-Swiggy restaurants): 1% cashback
Travel offline: 1% cashback
International: 1% cashback + 3.5% forex markup
Exclusions: No cashback on fuel, utilities, EMI, wallet loads
Best for: Swiggy orders, Instamart groceries, Uber/Ola rides
    `.trim()
  }
];

async function seed() {
  console.log('Seeding cards into Supabase...\n');

  for (const card of cards) {
    const { error } = await supabase
      .from('cards')
      .insert({ ...card, last_updated: new Date().toISOString() });

    if (error) {
      console.error(`❌ Failed to insert ${card.card_name}:`, error.message);
    } else {
      console.log(`✅ ${card.card_name}`);
    }
  }

  console.log('\nDone! All cards seeded.');
  process.exit(0);
}

seed();

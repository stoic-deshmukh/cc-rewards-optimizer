CREATE TABLE cards (
  id SERIAL PRIMARY KEY,
  card_name TEXT NOT NULL,
  issuer TEXT NOT NULL,
  reward_structure TEXT NOT NULL,
  mitc_url TEXT,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE
);

-- Bills Paid by Billionaires — Postgres schema
-- Run automatically on server start (src/db.js) and idempotently here.
-- All timestamps are UTC (timestamptz).

CREATE TABLE IF NOT EXISTS members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username CITEXT UNIQUE NOT NULL,
  email CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  -- 'pending' = signed up but no active paid subscription yet
  -- 'active'  = active $14.99/mo Poster Membership (verified via Stripe)
  -- 'past_due' / 'cancelled' = re-locked; may not post new bills
  subscription_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (subscription_status IN ('pending','active','past_due','cancelled','incomplete')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  -- token is stored as a SHA-256 hash; the raw token only ever lives in the cookie
  token_hash TEXT PRIMARY KEY,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_member ON sessions(member_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- Anonymous display name only. Never a full name, address, phone, email or account number.
  display_name TEXT NOT NULL DEFAULT 'Anonymous Member',
  category TEXT NOT NULL DEFAULT 'Other',
  title TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  story TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','help_offered','paid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bills_created ON bills(created_at DESC);

CREATE TABLE IF NOT EXISTS help_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  giver_name TEXT NOT NULL DEFAULT 'Anonymous Giver',
  message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_help_bill ON help_offers(bill_id);

-- Stripe webhook events, for idempotency: an event ID is processed once only.
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

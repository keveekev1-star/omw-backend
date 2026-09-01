-- ─────────────────────────────────────────────────────────────────────────────
-- On My Way — Database Schema
-- Region: AWS us-west-2 (Oregon)
-- Privacy principle: GPS coordinates are NEVER stored server-side.
--                    Only distance (miles) and general region are stored.
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── USERS ───────────────────────────────────────────────────────────────────
-- Minimal user record — most profile data lives in Auth0 user_metadata.
-- We store only what we need for trip matching and legal compliance.
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth0_id        TEXT UNIQUE NOT NULL,        -- Auth0 sub (e.g. auth0|abc123)
  account_type    TEXT NOT NULL                -- 'traveler' | 'passenger'
                  CHECK (account_type IN ('traveler','passenger')),
  traveler_tier   TEXT                         -- 'starter' | 'pro' | 'elite' | NULL
                  CHECK (traveler_tier IN ('starter','pro','elite') OR traveler_tier IS NULL),
  special_rate    TEXT DEFAULT 'none'          -- 'none' | 'senior' | 'vet'
                  CHECK (special_rate IN ('none','senior','vet')),
  verified        BOOLEAN DEFAULT FALSE,
  verified_at     TIMESTAMPTZ,
  active          BOOLEAN DEFAULT TRUE,
  rating          NUMERIC(3,2) DEFAULT 5.00,   -- average driver rating
  rating_count    INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),

  -- Auto-deletion: account data kept for active life + 30 days
  -- Scheduled job deletes rows where deleted_at < NOW() - INTERVAL '30 days'
  deleted_at      TIMESTAMPTZ                  -- soft delete timestamp
);

-- ─── TRIPS ───────────────────────────────────────────────────────────────────
-- PRIVACY: No GPS coordinates stored. Distance only.
-- Exact pickup/dropoff locations never leave the user's device.
CREATE TABLE IF NOT EXISTS trips (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  passenger_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','active','completed','cancelled')),

  -- Distance only — no coordinates (privacy by design)
  distance_miles  NUMERIC(6,2) NOT NULL,       -- e.g. 4.20

  -- General region only — no precise location (privacy by design)
  -- e.g. "Seattle Metro", "Bellevue", "Tacoma"
  region          TEXT,

  -- Financials (kept 7 years for tax compliance — IRS requirement)
  contribution    NUMERIC(8,2),                -- agreed contribution in USD
  peak_rate       BOOLEAN DEFAULT FALSE,

  -- Timestamps
  -- Date only — not precise time, reduces location pattern inference
  trip_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,

  -- Auto-deletion: exact timestamps deleted after 90 days
  -- Only trip_date (day precision) kept for 7-year tax record
  timestamps_purged_at TIMESTAMPTZ            -- when exact times were scrubbed
);

-- ─── VERIFICATION RECORDS ─────────────────────────────────────────────────────
-- Stores verification STATUS only. Documents live in S3, encrypted.
-- S3 keys (not the documents themselves) stored here.
-- Documents auto-deleted from S3 after 30 days post-approval.
CREATE TABLE IF NOT EXISTS verifications (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID REFERENCES users(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','expired')),
  account_type        TEXT NOT NULL,

  -- S3 object keys (pointers only — actual files in S3)
  -- Set to NULL after documents are purged from S3
  id_document_key     TEXT,                    -- encrypted in S3
  selfie_key          TEXT,                    -- auto-deleted after 24hrs
  abstract_key        TEXT,                    -- traveler only

  -- Verification details (no PII stored here)
  has_interior_cam    BOOLEAN DEFAULT FALSE,
  has_exterior_cam    BOOLEAN DEFAULT FALSE,
  special_rate        TEXT DEFAULT 'none',
  background_declared BOOLEAN DEFAULT FALSE,

  -- Dates (not precise timestamps for privacy)
  submitted_date      DATE DEFAULT CURRENT_DATE,
  reviewed_date       DATE,
  documents_purged_at TIMESTAMPTZ,            -- when S3 files were deleted

  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── CONTRIBUTIONS (FINANCIAL RECORDS) ────────────────────────────────────────
-- Kept 7 years — IRS / tax compliance requirement.
-- No location data. Amount + date only.
CREATE TABLE IF NOT EXISTS contributions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trip_id         UUID REFERENCES trips(id) ON DELETE SET NULL,
  driver_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  passenger_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  amount          NUMERIC(8,2) NOT NULL,
  peak_rate       BOOLEAN DEFAULT FALSE,
  distance_miles  NUMERIC(6,2) NOT NULL,
  trip_date       DATE NOT NULL,              -- date only, no time
  created_at      TIMESTAMPTZ DEFAULT NOW(),

  -- Tax retention: auto-delete after 7 years
  retain_until    DATE NOT NULL
                  DEFAULT (CURRENT_DATE + INTERVAL '7 years')
);

-- ─── LAW ENFORCEMENT ACCESS LOG ───────────────────────────────────────────────
-- Every access to user data by law enforcement is logged.
-- This log itself is NEVER deleted (permanent audit trail).
CREATE TABLE IF NOT EXISTS law_enforcement_log (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requesting_agency TEXT NOT NULL,
  badge_number      TEXT,
  warrant_number    TEXT,
  warrant_type      TEXT NOT NULL
                    CHECK (warrant_type IN (
                      'court_order',
                      'search_warrant',
                      'emergency_life',        -- life endangerment, no warrant
                      'emergency_child',       -- child endangerment, no warrant
                      'emergency_trafficking', -- sex trafficking, no warrant
                      'subpoena'
                    )),
  target_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  data_disclosed    TEXT NOT NULL,            -- description of what was shared
  disclosed_by      TEXT NOT NULL,           -- On My Way staff who handled it
  legal_review      BOOLEAN DEFAULT FALSE,   -- was legal counsel consulted
  legal_notes       TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─── RATINGS ──────────────────────────────────────────────────────────────────
-- Kept 1 year then aggregated into users.rating — raw ratings deleted
CREATE TABLE IF NOT EXISTS ratings (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trip_id     UUID REFERENCES trips(id) ON DELETE CASCADE,
  rater_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  rated_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  score       INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  purge_after DATE DEFAULT (CURRENT_DATE + INTERVAL '1 year')
);

-- ─── DATA DELETION REQUESTS ───────────────────────────────────────────────────
-- Tracks user requests to delete their data (WPA / GDPR requirement)
CREATE TABLE IF NOT EXISTS deletion_requests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  requested_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  status          TEXT DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','completed')),
  -- What was deleted
  deleted_profile     BOOLEAN DEFAULT FALSE,
  deleted_trips       BOOLEAN DEFAULT FALSE,
  deleted_documents   BOOLEAN DEFAULT FALSE,
  deleted_auth0       BOOLEAN DEFAULT FALSE    -- Auth0 user deleted
);

-- ─── DATA EXPORT REQUESTS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS export_requests (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status      TEXT DEFAULT 'pending'
              CHECK (status IN ('pending','processing','completed','failed')),
  s3_key      TEXT        -- temporary export file in S3 (auto-deleted after 48hrs)
);

-- ─── INDEXES ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_auth0_id      ON users(auth0_id);
CREATE INDEX IF NOT EXISTS idx_trips_driver        ON trips(driver_id);
CREATE INDEX IF NOT EXISTS idx_trips_passenger     ON trips(passenger_id);
CREATE INDEX IF NOT EXISTS idx_trips_date          ON trips(trip_date);
CREATE INDEX IF NOT EXISTS idx_contributions_date  ON contributions(trip_date);
CREATE INDEX IF NOT EXISTS idx_contributions_retain ON contributions(retain_until);
CREATE INDEX IF NOT EXISTS idx_verifications_user  ON verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_ratings_purge       ON ratings(purge_after);
CREATE INDEX IF NOT EXISTS idx_users_deleted       ON users(deleted_at)
  WHERE deleted_at IS NOT NULL;

-- ─── AUTO-UPDATE updated_at ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- DealFlow AI — Database Schema Migration v3.0.0
-- PostgreSQL 15+
-- Run with: psql -d dealflow_db -f 001_initial_schema.sql
-- ============================================================

BEGIN;

-- ─────────────────────────────────────────────────────────
-- EXTENSIONS
-- ─────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- fuzzy phone/name search
CREATE EXTENSION IF NOT EXISTS "btree_gin"; -- composite GIN indexes

-- ─────────────────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────────────────

CREATE TYPE user_role AS ENUM (
  'ADMIN', 'ACQUISITION_MANAGER', 'DISPOSITION_MANAGER',
  'VIRTUAL_ASSISTANT', 'READ_ONLY'
);

CREATE TYPE seller_status AS ENUM (
  'NEW', 'WARM', 'NEGOTIATING', 'AGREED', 'LOST', 'COLD', 'DO_NOT_CONTACT'
);

CREATE TYPE buyer_status AS ENUM (
  'NEW', 'INTERESTED', 'NEGOTIATING', 'AGREED', 'COLD', 'DO_NOT_CONTACT'
);

CREATE TYPE contract_status AS ENUM (
  'PENDING', 'SENT', 'SIGNED', 'CANCELLED', 'EXPIRED'
);

CREATE TYPE assignment_status AS ENUM (
  'AVAILABLE', 'PITCHED', 'NEGOTIATING', 'ASSIGNED', 'CANCELLED', 'CLOSED'
);

CREATE TYPE message_role AS ENUM ('AI', 'PROSPECT', 'OWNER', 'SYSTEM');
CREATE TYPE message_channel AS ENUM ('SMS', 'EMAIL', 'INTERNAL');
CREATE TYPE negotiation_side AS ENUM ('SELLER', 'BUYER');
CREATE TYPE offer_party AS ENUM ('AI', 'PROSPECT');
CREATE TYPE notification_type AS ENUM ('SUCCESS', 'WARNING', 'DANGER', 'INFO');
CREATE TYPE task_status AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');
CREATE TYPE activity_color AS ENUM ('GREEN', 'AMBER', 'RED', 'BLUE', 'ACCENT', 'TEXT3');
CREATE TYPE consent_status AS ENUM ('PENDING', 'CONFIRMED', 'OPTED_OUT');
CREATE TYPE follow_up_status AS ENUM ('SCHEDULED', 'SENT', 'CANCELLED', 'FAILED');

CREATE TYPE audit_action AS ENUM (
  'CREATED', 'UPDATED', 'DELETED', 'SENT_SMS', 'RECEIVED_SMS',
  'AI_RESPONSE', 'PRICE_SET', 'NEGOTIATION_STARTED',
  'OFFER_MADE', 'OFFER_RECEIVED', 'DEAL_AGREED', 'DEAL_LOST',
  'CONTRACT_SENT', 'CONTRACT_SIGNED', 'ASSIGNMENT_SENT',
  'ASSIGNMENT_SIGNED', 'OPTED_OUT', 'REINSTATED',
  'AI_PAUSED', 'AI_RESUMED', 'USER_LOGIN', 'USER_LOGOUT',
  'SETTINGS_CHANGED', 'WEBHOOK_RECEIVED'
);

-- ─────────────────────────────────────────────────────────
-- ORGANIZATIONS
-- ─────────────────────────────────────────────────────────

CREATE TABLE organizations (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name                 TEXT NOT NULL,
  slug                 TEXT NOT NULL UNIQUE,
  plan                 TEXT NOT NULL DEFAULT 'starter',
  logo_url             TEXT,
  timezone             TEXT NOT NULL DEFAULT 'America/New_York',

  -- AI Config
  ai_persona           TEXT NOT NULL DEFAULT 'Alex',
  msg_tone             TEXT NOT NULL DEFAULT 'professional',
  max_followups        INTEGER NOT NULL DEFAULT 5,
  followup_delay_hours INTEGER NOT NULL DEFAULT 24,

  -- Credentials (encrypted at application layer via AES-256-GCM)
  twilio_sid           TEXT,
  twilio_token_enc     TEXT,  -- encrypted
  twilio_from          TEXT,
  anthropic_key_enc    TEXT,  -- encrypted
  docusign_key_enc     TEXT,  -- encrypted
  s3_bucket            TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_organizations_slug ON organizations(slug);

-- ─────────────────────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────────────────────

CREATE TABLE users (
  id                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email                  TEXT NOT NULL,
  password_hash          TEXT NOT NULL,
  first_name             TEXT NOT NULL,
  last_name              TEXT NOT NULL,
  role                   user_role NOT NULL DEFAULT 'VIRTUAL_ASSISTANT',
  avatar_url             TEXT,
  phone                  TEXT,

  -- Auth
  email_verified         BOOLEAN NOT NULL DEFAULT FALSE,
  email_verify_token     TEXT UNIQUE,
  password_reset_token   TEXT UNIQUE,
  password_reset_expiry  TIMESTAMPTZ,
  mfa_enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_secret_enc         TEXT,           -- encrypted TOTP secret
  mfa_backup_codes       TEXT[],         -- bcrypt-hashed backup codes
  last_login_at          TIMESTAMPTZ,
  failed_login_attempts  INTEGER NOT NULL DEFAULT 0,
  locked_until           TIMESTAMPTZ,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(organization_id, email)
);

CREATE INDEX idx_users_org ON users(organization_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_org_email ON users(organization_id, email);

CREATE TABLE refresh_tokens (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,  -- SHA-256 of actual token
  expires_at  TIMESTAMPTZ NOT NULL,
  user_agent  TEXT,
  ip          INET,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- ─────────────────────────────────────────────────────────
-- CAMPAIGNS
-- ─────────────────────────────────────────────────────────

CREATE TABLE campaigns (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  type                 TEXT NOT NULL CHECK (type IN ('seller', 'buyer')),
  description          TEXT,
  ai_persona           TEXT,
  msg_tone             TEXT,
  max_followups        INTEGER,
  followup_delay_hours INTEGER,

  -- Denormalized stats
  total_leads          INTEGER NOT NULL DEFAULT 0,
  sent_count           INTEGER NOT NULL DEFAULT 0,
  responded_count      INTEGER NOT NULL DEFAULT 0,
  interested_count     INTEGER NOT NULL DEFAULT 0,
  converted_count      INTEGER NOT NULL DEFAULT 0,

  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  started_at           TIMESTAMPTZ,
  ended_at             TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_campaigns_org ON campaigns(organization_id);
CREATE INDEX idx_campaigns_org_type ON campaigns(organization_id, type);

-- ─────────────────────────────────────────────────────────
-- SELLER LEADS
-- ─────────────────────────────────────────────────────────

CREATE TABLE seller_leads (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id          TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  owner_id             TEXT REFERENCES users(id) ON DELETE SET NULL,

  -- Contact
  name                 TEXT NOT NULL,
  phone                TEXT NOT NULL,  -- E.164 format: +15551234567
  email                TEXT,
  address              TEXT,
  city                 TEXT,
  state                TEXT,
  zip                  TEXT,

  -- Status & Scoring
  status               seller_status NOT NULL DEFAULT 'NEW',
  score                INTEGER NOT NULL DEFAULT 50 CHECK (score BETWEEN 0 AND 100),
  motivation_score     INTEGER CHECK (motivation_score BETWEEN 0 AND 100),
  probability_score    NUMERIC(5,4) CHECK (probability_score BETWEEN 0 AND 1),

  -- AI Control
  ai_paused            BOOLEAN NOT NULL DEFAULT FALSE,
  negotiation_active   BOOLEAN NOT NULL DEFAULT FALSE,

  -- Negotiation Config
  price_min            INTEGER,
  price_max            INTEGER,
  price_lowball        INTEGER,
  price_notes          TEXT,
  last_ai_offer        INTEGER,
  agreed_price         INTEGER,
  agreed_at            TIMESTAMPTZ,

  -- Tracking
  followup_count       INTEGER NOT NULL DEFAULT 0,
  contract_sent        BOOLEAN NOT NULL DEFAULT FALSE,
  contract_sent_at     TIMESTAMPTZ,
  removed_at           TIMESTAMPTZ,
  reinstated_at        TIMESTAMPTZ,

  -- Compliance
  consent_status       consent_status NOT NULL DEFAULT 'PENDING',
  consent_method       TEXT,
  consent_at           TIMESTAMPTZ,
  opted_out_at         TIMESTAMPTZ,
  opted_out_method     TEXT,

  -- Source / Meta
  source               TEXT,
  custom_fields        JSONB NOT NULL DEFAULT '{}',
  imported_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(organization_id, phone),
  CONSTRAINT price_range_valid CHECK (price_min IS NULL OR price_max IS NULL OR price_min < price_max)
);

CREATE INDEX idx_seller_leads_org ON seller_leads(organization_id);
CREATE INDEX idx_seller_leads_org_status ON seller_leads(organization_id, status);
CREATE INDEX idx_seller_leads_org_campaign ON seller_leads(organization_id, campaign_id);
CREATE INDEX idx_seller_leads_phone ON seller_leads(phone);
CREATE INDEX idx_seller_leads_score ON seller_leads(organization_id, score DESC);
-- Trigram index for fuzzy name search
CREATE INDEX idx_seller_leads_name_trgm ON seller_leads USING gin(name gin_trgm_ops);
CREATE INDEX idx_seller_leads_custom ON seller_leads USING gin(custom_fields);
CREATE INDEX idx_seller_leads_created ON seller_leads(organization_id, created_at DESC);

-- ─────────────────────────────────────────────────────────
-- BUYER LEADS
-- ─────────────────────────────────────────────────────────

CREATE TABLE buyer_leads (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id          TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  owner_id             TEXT REFERENCES users(id) ON DELETE SET NULL,

  -- Contact
  name                 TEXT NOT NULL,
  phone                TEXT NOT NULL,
  email                TEXT,

  -- Buyer Profile
  interest             TEXT,
  target_markets       TEXT[],
  max_purchase_price   INTEGER,
  buying_criteria      TEXT,

  -- Status & Scoring
  status               buyer_status NOT NULL DEFAULT 'NEW',
  score                INTEGER NOT NULL DEFAULT 50 CHECK (score BETWEEN 0 AND 100),
  qualification_score  NUMERIC(5,4) CHECK (qualification_score BETWEEN 0 AND 1),

  -- AI Control
  ai_paused            BOOLEAN NOT NULL DEFAULT FALSE,
  negotiation_active   BOOLEAN NOT NULL DEFAULT FALSE,

  -- Negotiation Config
  assignment_contract_id TEXT,
  fee_min              INTEGER NOT NULL DEFAULT 5000,
  fee_max              INTEGER NOT NULL DEFAULT 15000,
  last_ai_offer        INTEGER,
  agreed_fee           INTEGER,
  agreed_at            TIMESTAMPTZ,

  -- Tracking
  followup_count       INTEGER NOT NULL DEFAULT 0,
  contract_sent        BOOLEAN NOT NULL DEFAULT FALSE,
  contract_sent_at     TIMESTAMPTZ,

  -- Compliance
  consent_status       consent_status NOT NULL DEFAULT 'PENDING',
  consent_method       TEXT,
  consent_at           TIMESTAMPTZ,
  opted_out_at         TIMESTAMPTZ,
  opted_out_method     TEXT,

  -- Source / Meta
  source               TEXT,
  custom_fields        JSONB NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(organization_id, phone),
  CONSTRAINT fee_range_valid CHECK (fee_min <= fee_max)
);

CREATE INDEX idx_buyer_leads_org ON buyer_leads(organization_id);
CREATE INDEX idx_buyer_leads_org_status ON buyer_leads(organization_id, status);
CREATE INDEX idx_buyer_leads_phone ON buyer_leads(phone);
CREATE INDEX idx_buyer_leads_score ON buyer_leads(organization_id, score DESC);
CREATE INDEX idx_buyer_leads_name_trgm ON buyer_leads USING gin(name gin_trgm_ops);

-- ─────────────────────────────────────────────────────────
-- MESSAGES
-- ─────────────────────────────────────────────────────────

CREATE TABLE messages (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id            TEXT REFERENCES seller_leads(id) ON DELETE SET NULL,
  buyer_id             TEXT REFERENCES buyer_leads(id) ON DELETE SET NULL,
  sent_by_id           TEXT REFERENCES users(id) ON DELETE SET NULL,

  role                 message_role NOT NULL,
  channel              message_channel NOT NULL DEFAULT 'SMS',
  content              TEXT NOT NULL,
  twilio_sid           TEXT UNIQUE,
  sms_status           TEXT,
  error_code           TEXT,
  error_message        TEXT,
  retry_count          INTEGER NOT NULL DEFAULT 0,

  is_ai_generated      BOOLEAN NOT NULL DEFAULT FALSE,
  prompt_tokens        INTEGER,
  completion_tokens    INTEGER,
  model_used           TEXT,

  is_opt_out_message   BOOLEAN NOT NULL DEFAULT FALSE,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_seller ON messages(seller_id, created_at);
CREATE INDEX idx_messages_buyer ON messages(buyer_id, created_at);
CREATE INDEX idx_messages_org ON messages(organization_id, created_at DESC);
CREATE INDEX idx_messages_twilio_sid ON messages(twilio_sid) WHERE twilio_sid IS NOT NULL;
CREATE INDEX idx_messages_status ON messages(organization_id, sms_status);

-- ─────────────────────────────────────────────────────────
-- NEGOTIATIONS
-- ─────────────────────────────────────────────────────────

CREATE TABLE negotiations (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id            TEXT UNIQUE REFERENCES seller_leads(id) ON DELETE SET NULL,
  buyer_id             TEXT UNIQUE REFERENCES buyer_leads(id) ON DELETE SET NULL,
  side                 negotiation_side NOT NULL,

  floor_price          INTEGER NOT NULL,
  ceil_price           INTEGER NOT NULL,
  opening_offer        INTEGER NOT NULL,
  current_offer        INTEGER,
  agreed_amount        INTEGER,
  agreed_at            TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'active',

  max_concessions      INTEGER NOT NULL DEFAULT 3,
  concessions_made     INTEGER NOT NULL DEFAULT 0,
  notes                TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT floor_below_ceil CHECK (floor_price <= ceil_price),
  CONSTRAINT one_side_required CHECK (seller_id IS NOT NULL OR buyer_id IS NOT NULL)
);

CREATE INDEX idx_negotiations_org ON negotiations(organization_id);
CREATE INDEX idx_negotiations_status ON negotiations(organization_id, status);

CREATE TABLE negotiation_offers (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  negotiation_id       TEXT NOT NULL REFERENCES negotiations(id) ON DELETE CASCADE,
  party                offer_party NOT NULL,
  amount               INTEGER NOT NULL,
  message              TEXT,
  is_counter_offer     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_offers_negotiation ON negotiation_offers(negotiation_id);

-- ─────────────────────────────────────────────────────────
-- CONTRACTS
-- ─────────────────────────────────────────────────────────

CREATE TABLE contracts (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id            TEXT UNIQUE REFERENCES seller_leads(id) ON DELETE SET NULL,
  version              INTEGER NOT NULL DEFAULT 1,

  address              TEXT NOT NULL,
  seller_name          TEXT NOT NULL,
  purchase_price       INTEGER NOT NULL,
  closing_date         DATE,
  earnest_money        INTEGER,

  status               contract_status NOT NULL DEFAULT 'PENDING',

  pdf_key              TEXT,
  pdf_url              TEXT,
  docusign_envelope_id TEXT,
  signed_at            TIMESTAMPTZ,
  signed_pdf_key       TEXT,

  default_fee_min      INTEGER,
  default_fee_max      INTEGER,
  notes                TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contracts_org ON contracts(organization_id);
CREATE INDEX idx_contracts_org_status ON contracts(organization_id, status);

CREATE TABLE assignment_contracts (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contract_id          TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  buyer_id             TEXT REFERENCES buyer_leads(id) ON DELETE SET NULL,
  version              INTEGER NOT NULL DEFAULT 1,

  assignment_fee       INTEGER NOT NULL,
  status               assignment_status NOT NULL DEFAULT 'AVAILABLE',

  pdf_key              TEXT,
  pdf_url              TEXT,
  docusign_envelope_id TEXT,
  signed_at            TIMESTAMPTZ,
  signed_pdf_key       TEXT,

  closing_date         DATE,
  notes                TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assignments_org ON assignment_contracts(organization_id);
CREATE INDEX idx_assignments_contract ON assignment_contracts(contract_id);
CREATE INDEX idx_assignments_org_status ON assignment_contracts(organization_id, status);

-- ─────────────────────────────────────────────────────────
-- FOLLOW-UPS
-- ─────────────────────────────────────────────────────────

CREATE TABLE follow_ups (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id            TEXT REFERENCES seller_leads(id) ON DELETE CASCADE,
  buyer_id             TEXT REFERENCES buyer_leads(id) ON DELETE CASCADE,
  sequence_number      INTEGER NOT NULL,
  content              TEXT NOT NULL,
  scheduled_for        TIMESTAMPTZ NOT NULL,
  status               follow_up_status NOT NULL DEFAULT 'SCHEDULED',
  sent_at              TIMESTAMPTZ,
  failed_at            TIMESTAMPTZ,
  fail_reason          TEXT,
  bull_job_id          TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_followups_org ON follow_ups(organization_id);
CREATE INDEX idx_followups_scheduled ON follow_ups(scheduled_for, status);
CREATE INDEX idx_followups_seller ON follow_ups(seller_id);
CREATE INDEX idx_followups_buyer ON follow_ups(buyer_id);

-- ─────────────────────────────────────────────────────────
-- TASKS
-- ─────────────────────────────────────────────────────────

CREATE TABLE tasks (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assigned_to_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  seller_id            TEXT REFERENCES seller_leads(id) ON DELETE CASCADE,
  buyer_id             TEXT REFERENCES buyer_leads(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  description          TEXT,
  due_at               TIMESTAMPTZ,
  status               task_status NOT NULL DEFAULT 'OPEN',
  priority             INTEGER NOT NULL DEFAULT 2,
  completed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_org ON tasks(organization_id);
CREATE INDEX idx_tasks_assigned ON tasks(organization_id, assigned_to_id);
CREATE INDEX idx_tasks_status ON tasks(organization_id, status);
CREATE INDEX idx_tasks_due ON tasks(due_at, status) WHERE status NOT IN ('DONE', 'CANCELLED');

-- ─────────────────────────────────────────────────────────
-- NOTIFICATIONS & ACTIVITY
-- ─────────────────────────────────────────────────────────

CREATE TABLE notifications (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type                 notification_type NOT NULL DEFAULT 'INFO',
  title                TEXT NOT NULL,
  body                 TEXT NOT NULL,
  action_label         TEXT,
  action_data          JSONB,
  read_at              TIMESTAMPTZ,
  dismissed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_org ON notifications(organization_id);
CREATE INDEX idx_notifications_org_active ON notifications(organization_id, dismissed_at)
  WHERE dismissed_at IS NULL;

CREATE TABLE activities (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  text                 TEXT NOT NULL,
  color                activity_color NOT NULL DEFAULT 'BLUE',
  entity_type          TEXT,
  entity_id            TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_activities_org ON activities(organization_id, created_at DESC);

-- ─────────────────────────────────────────────────────────
-- AUDIT LOG
-- ─────────────────────────────────────────────────────────

CREATE TABLE audit_logs (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id              TEXT REFERENCES users(id) ON DELETE SET NULL,
  action               audit_action NOT NULL,
  entity_type          TEXT NOT NULL,
  entity_id            TEXT NOT NULL,
  before               JSONB,
  after                JSONB,
  ip                   INET,
  user_agent           TEXT,
  meta                 JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

-- Monthly partitions for audit logs (add more as needed)
CREATE TABLE audit_logs_2026_01 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE audit_logs_2026_06 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE audit_logs_2026_07 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE audit_logs_2026_12 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;

CREATE INDEX idx_audit_logs_org ON audit_logs(organization_id, created_at DESC);
CREATE INDEX idx_audit_logs_entity ON audit_logs(organization_id, entity_type, entity_id);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id, created_at DESC);

-- ─────────────────────────────────────────────────────────
-- TAGS & CUSTOM FIELDS
-- ─────────────────────────────────────────────────────────

CREATE TABLE tags (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  color                TEXT NOT NULL DEFAULT '#6c63ff',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, name)
);

CREATE TABLE tags_on_sellers (
  seller_id            TEXT NOT NULL REFERENCES seller_leads(id) ON DELETE CASCADE,
  tag_id               TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(seller_id, tag_id)
);

CREATE TABLE tags_on_buyers (
  buyer_id             TEXT NOT NULL REFERENCES buyer_leads(id) ON DELETE CASCADE,
  tag_id               TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(buyer_id, tag_id)
);

CREATE TABLE custom_fields (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type          TEXT NOT NULL,
  field_key            TEXT NOT NULL,
  field_label          TEXT NOT NULL,
  field_type           TEXT NOT NULL DEFAULT 'text',
  options              TEXT[],
  required             BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, entity_type, field_key)
);

-- ─────────────────────────────────────────────────────────
-- SMS STATS
-- ─────────────────────────────────────────────────────────

CREATE TABLE sms_stats (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id      TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  sent                 BIGINT NOT NULL DEFAULT 0,
  received             BIGINT NOT NULL DEFAULT 0,
  failed               BIGINT NOT NULL DEFAULT 0,
  delivered            BIGINT NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────
-- FUNCTIONS & TRIGGERS
-- ─────────────────────────────────────────────────────────

-- Auto-update updated_at on all relevant tables
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations', 'users', 'campaigns', 'seller_leads', 'buyer_leads',
    'negotiations', 'contracts', 'assignment_contracts', 'tasks'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER update_%s_updated_at BEFORE UPDATE ON %s
       FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()',
      t, t
    );
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Auto-create SMS stats row for new orgs
CREATE OR REPLACE FUNCTION create_org_sms_stats()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sms_stats(organization_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER after_org_insert
  AFTER INSERT ON organizations
  FOR EACH ROW EXECUTE FUNCTION create_org_sms_stats();

-- Increment sms_stats atomically
CREATE OR REPLACE FUNCTION increment_sms_stat(p_org_id TEXT, p_field TEXT)
RETURNS VOID AS $$
BEGIN
  EXECUTE format(
    'UPDATE sms_stats SET %I = %I + 1, updated_at = now() WHERE organization_id = $1',
    p_field, p_field
  ) USING p_org_id;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────
-- VIEWS
-- ─────────────────────────────────────────────────────────

-- Dashboard stats view
CREATE VIEW v_org_dashboard AS
SELECT
  o.id AS organization_id,
  COUNT(DISTINCT sl.id) FILTER (WHERE sl.status != 'DO_NOT_CONTACT') AS total_sellers,
  COUNT(DISTINCT sl.id) FILTER (WHERE sl.status = 'WARM') AS warm_sellers,
  COUNT(DISTINCT sl.id) FILTER (WHERE sl.status = 'NEGOTIATING') AS negotiating_sellers,
  COUNT(DISTINCT sl.id) FILTER (WHERE sl.status = 'AGREED') AS agreed_sellers,
  COUNT(DISTINCT sl.id) FILTER (WHERE sl.status = 'LOST') AS lost_sellers,
  COUNT(DISTINCT bl.id) FILTER (WHERE bl.status != 'DO_NOT_CONTACT') AS total_buyers,
  COUNT(DISTINCT bl.id) FILTER (WHERE bl.status = 'NEGOTIATING') AS negotiating_buyers,
  COUNT(DISTINCT bl.id) FILTER (WHERE bl.status = 'AGREED') AS agreed_buyers,
  COUNT(DISTINCT c.id) FILTER (WHERE c.status IN ('PENDING','SENT','SIGNED')) AS active_contracts,
  COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'SIGNED') AS signed_contracts,
  COUNT(DISTINCT ac.id) FILTER (WHERE ac.status = 'CLOSED') AS closed_assignments,
  COALESCE(SUM(ac.assignment_fee) FILTER (WHERE ac.status = 'CLOSED'), 0) AS total_revenue,
  ss.sent AS sms_sent,
  ss.received AS sms_received,
  ss.failed AS sms_failed,
  ss.delivered AS sms_delivered
FROM organizations o
LEFT JOIN seller_leads sl ON sl.organization_id = o.id
LEFT JOIN buyer_leads bl ON bl.organization_id = o.id
LEFT JOIN contracts c ON c.organization_id = o.id
LEFT JOIN assignment_contracts ac ON ac.organization_id = o.id
LEFT JOIN sms_stats ss ON ss.organization_id = o.id
GROUP BY o.id, ss.sent, ss.received, ss.failed, ss.delivered;

COMMIT;

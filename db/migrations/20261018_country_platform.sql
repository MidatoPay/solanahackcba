BEGIN;
CREATE TABLE IF NOT EXISTS platform_merchants (
  scope TEXT NOT NULL, user_id TEXT NOT NULL, business_name TEXT NOT NULL DEFAULT '',
  policy JSONB NOT NULL DEFAULT '{"mode":"percentage","value":"100.00"}',
  customer_id TEXT, customer_key UUID NOT NULL, customer_input_hash TEXT, customer_body JSONB,
  wallet_address TEXT, sync_signature TEXT, sync_before TEXT, sync_head TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(scope,user_id)
);
CREATE TABLE IF NOT EXISTS platform_acceptances (
  scope TEXT NOT NULL, user_id TEXT NOT NULL, country TEXT NOT NULL, document_id TEXT NOT NULL,
  version TEXT NOT NULL, document_hash TEXT NOT NULL, accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(scope,user_id,document_id,version,document_hash)
);
CREATE TABLE IF NOT EXISTS platform_provider_customers (
  scope TEXT NOT NULL, user_id TEXT NOT NULL, provider TEXT NOT NULL,
  customer_id TEXT, customer_key UUID NOT NULL, customer_input_hash TEXT, customer_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(scope,user_id,provider)
);
-- Preserve the request/key of any identity prepared by the first Colombia
-- version, including a provider response that may still need recovery.
INSERT INTO platform_provider_customers(scope,user_id,provider,customer_id,customer_key,customer_input_hash,customer_body)
  SELECT scope,user_id,'onepay',customer_id,customer_key,customer_input_hash,customer_body
  FROM platform_merchants WHERE customer_body IS NOT NULL OR customer_id IS NOT NULL
  ON CONFLICT(scope,user_id,provider) DO NOTHING;
CREATE TABLE IF NOT EXISTS platform_destinations (
  id UUID PRIMARY KEY, scope TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('bank','breb')),
  label TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'onepay', provider_account_id TEXT, provider_customer_id TEXT NOT NULL,
  idempotency_key UUID NOT NULL, input_hash TEXT NOT NULL, provider_body JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating', last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(scope,user_id,idempotency_key)
);
ALTER TABLE platform_destinations ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'onepay';
CREATE TABLE IF NOT EXISTS platform_operations (
  id UUID PRIMARY KEY, scope TEXT NOT NULL, country TEXT NOT NULL, currency TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment='sandbox'), network TEXT NOT NULL CHECK(network='devnet'),
  user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('collection','buy','sell','withdrawal','transfer','receive')),
  parent_id UUID REFERENCES platform_operations(id), provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating', idempotency_key UUID NOT NULL, input_hash TEXT NOT NULL,
  fiat_minor BIGINT NOT NULL DEFAULT 0 CHECK(fiat_minor>=0), fee_minor BIGINT NOT NULL DEFAULT 0 CHECK(fee_minor>=0),
  usdc_raw BIGINT NOT NULL DEFAULT 0 CHECK(usdc_raw>=0), retained_minor BIGINT NOT NULL DEFAULT 0 CHECK(retained_minor>=0),
  reserve_raw BIGINT NOT NULL DEFAULT 0 CHECK(reserve_raw>=0), reserve_minor BIGINT NOT NULL DEFAULT 0 CHECK(reserve_minor>=0),
  quote JSONB, policy JSONB, metadata JSONB NOT NULL DEFAULT '{}', provider_body JSONB NOT NULL DEFAULT '{}',
  provider_id TEXT, wallet_address TEXT, treasury_address TEXT, destination_id UUID REFERENCES platform_destinations(id),
  qr_data TEXT, expires_at TIMESTAMPTZ, paid_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  signature TEXT, unsigned_wire TEXT, signed_wire TEXT, last_valid_block_height BIGINT, fee_payer TEXT,
  cost_lamports BIGINT, sponsor_day TEXT, last_error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(scope,user_id,idempotency_key), UNIQUE(scope,provider,provider_id),
  UNIQUE(scope,user_id,signature)
);
CREATE INDEX IF NOT EXISTS platform_operations_history ON platform_operations(scope,user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS platform_operations_jobs ON platform_operations(scope,next_attempt_at)
  WHERE status NOT IN ('completed','failed','canceled','expired');
CREATE UNIQUE INDEX IF NOT EXISTS platform_collection_buy ON platform_operations(parent_id) WHERE kind='buy' AND parent_id IS NOT NULL;

-- Store an entire balanced batch atomically. The database independently checks
-- the accounting invariant, including statements outside the application.
CREATE OR REPLACE FUNCTION platform_balanced_journal(items JSONB) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(items)<>'array' THEN false ELSE
    jsonb_array_length(items)>=2 AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(items) e
      WHERE jsonb_typeof(e)<>'object' OR coalesce(e->>'account','')='' OR coalesce(e->>'asset','') !~ '^[A-Z]{3,12}$'
        OR coalesce(e->>'raw','') !~ '^-?[0-9]{1,18}$'
    ) AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(items) e GROUP BY e->>'asset'
      HAVING SUM(CASE WHEN e->>'raw' ~ '^-?[0-9]{1,18}$' THEN (e->>'raw')::numeric ELSE 1 END)<>0
    ) END;
$$;
CREATE TABLE IF NOT EXISTS platform_journals (
  id UUID PRIMARY KEY, scope TEXT NOT NULL, event_key TEXT NOT NULL,
  operation_id UUID NOT NULL REFERENCES platform_operations(id),
  entries JSONB NOT NULL CHECK(platform_balanced_journal(entries)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(scope,event_key)
);
CREATE INDEX IF NOT EXISTS platform_journals_scope ON platform_journals(scope,created_at);
CREATE TABLE IF NOT EXISTS platform_inbox (
  id UUID PRIMARY KEY, scope TEXT NOT NULL, event_key TEXT NOT NULL, event_type TEXT NOT NULL,
  resource_id TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'onepay', payload JSONB NOT NULL, processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_error TEXT, UNIQUE(scope,event_key)
);
ALTER TABLE platform_inbox ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'onepay';
CREATE TABLE IF NOT EXISTS platform_quotes (
  id UUID PRIMARY KEY, scope TEXT NOT NULL, user_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('buy','sell')),
  input_amount TEXT NOT NULL, quote JSONB NOT NULL, calculation JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_closed_attempts (
  scope TEXT NOT NULL, user_id TEXT NOT NULL, idempotency_key UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(scope,user_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS platform_wallet_audit (
  id UUID PRIMARY KEY, scope TEXT NOT NULL, user_id TEXT NOT NULL,
  previous_address TEXT, primary_address TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_contacts (
  id UUID PRIMARY KEY, scope TEXT NOT NULL, user_id TEXT NOT NULL,
  name TEXT NOT NULL, alias TEXT NOT NULL, address TEXT,
  bank_accounts JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(scope,user_id,alias)
);
ALTER TABLE platform_contacts ALTER COLUMN address DROP NOT NULL;
ALTER TABLE platform_contacts ADD COLUMN IF NOT EXISTS bank_accounts JSONB NOT NULL DEFAULT '[]'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='platform_contacts_destinations_check' AND conrelid='platform_contacts'::regclass) THEN
    ALTER TABLE platform_contacts ADD CONSTRAINT platform_contacts_destinations_check CHECK (
      jsonb_typeof(bank_accounts)='array' AND jsonb_array_length(bank_accounts)<=5
      AND (NULLIF(address,'') IS NOT NULL OR jsonb_array_length(bank_accounts)>0)
    );
  END IF;
END; $$;
-- Journal history is append-only, including for accidental UPDATE/DELETE paths.
CREATE OR REPLACE FUNCTION platform_immutable_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'platform_journal_is_immutable'; END; $$;
DROP TRIGGER IF EXISTS platform_journal_immutable ON platform_journals;
CREATE TRIGGER platform_journal_immutable BEFORE UPDATE OR DELETE ON platform_journals
FOR EACH ROW EXECUTE FUNCTION platform_immutable_journal();
COMMIT;

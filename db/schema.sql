-- Agenda de contactos — se corre a mano una vez contra Aiven (psql o su consola web).
-- Ver docs/superpowers/specs/2026-08-05-contacts-agenda-design.md § 1.2

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,           -- Privy DID (p.ej. "did:privy:abc123")
  name        TEXT NOT NULL,
  alias       TEXT NOT NULL,
  address     TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contacts_user_id_idx ON contacts (user_id);

-- UNIQUE de tabla no acepta expresiones (LOWER(alias)) — hace falta un
-- índice único aparte para el alias case-insensitive por usuario.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_user_alias_uidx ON contacts (user_id, LOWER(alias));

-- Historial de transacciones — ver
-- docs/superpowers/specs/2026-08-07-transactions-history-design.md § 1.2

CREATE TABLE IF NOT EXISTS transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,           -- Privy DID
  hash        TEXT NOT NULL,           -- hash on-chain; único por usuario, no global (ver charge P2P)
  kind        TEXT NOT NULL,           -- 'voice' | 'pay' | 'charge_p2p' | 'convert_ars_usdc' | 'convert_usdc_ars'
  direction   TEXT NOT NULL,           -- 'in' | 'out'
  who         TEXT NOT NULL,           -- contraparte mostrada
  amt         NUMERIC NOT NULL,        -- monto en USDC
  fx_rate     NUMERIC NOT NULL,        -- ARS por USDC al momento de la tx
  ars         NUMERIC NOT NULL,        -- monto en ARS al momento de la tx (no se recalcula, ver spec)
  factura     TEXT,
  block       BIGINT,
  fee         NUMERIC,
  memo        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transactions_user_id_idx ON transactions (user_id, created_at DESC);

-- Un mismo hash on-chain puede tener una fila por cada lado del cobro P2P
-- por QR (quien cobra: 'in', quien paga: 'out') — ver
-- docs/superpowers/specs/2026-08-08-qr-charge-design.md § 5.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_hash_key'
  ) THEN
    ALTER TABLE transactions DROP CONSTRAINT transactions_hash_key;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_user_hash_key'
  ) THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_user_hash_key UNIQUE (user_id, hash);
  END IF;
END $$;

-- Mapeo user_id (Privy DID) -> address de su wallet embebida, con
-- checkpoint de reconciliación de fondo. Ver
-- docs/superpowers/specs/2026-08-08-background-reconciliation-design.md § 1.

CREATE TABLE IF NOT EXISTS wallets (
  user_id            TEXT PRIMARY KEY,     -- Privy DID (una wallet por usuario, embedded wallet)
  address            TEXT NOT NULL,
  last_synced_block  BIGINT,               -- checkpoint: bloque más alto ya reconciliado
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wallets_address_idx ON wallets (address);

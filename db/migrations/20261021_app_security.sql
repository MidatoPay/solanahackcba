BEGIN;
CREATE TABLE IF NOT EXISTS app_security_users (
 user_id text PRIMARY KEY,
 pin jsonb,
 failed_attempts integer NOT NULL DEFAULT 0,
 blocked_until timestamptz
);
CREATE TABLE IF NOT EXISTS app_security_passkeys (
 credential_id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES app_security_users(user_id),
 rp_id text NOT NULL,
 credential jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS app_security_passkeys_user ON app_security_passkeys(user_id);
CREATE TABLE IF NOT EXISTS app_security_challenges (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES app_security_users(user_id),
 privy_session text NOT NULL,
 purpose text NOT NULL,
 payload jsonb NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS app_security_sessions (
 token_hash text PRIMARY KEY,
 user_id text NOT NULL REFERENCES app_security_users(user_id),
 privy_session text NOT NULL,
 scope text NOT NULL CHECK (scope IN ('unlock','manage','recover')),
 expires_at timestamptz NOT NULL,
 absolute_expires_at timestamptz NOT NULL,
 revoked boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS app_security_sessions_user ON app_security_sessions(user_id);
CREATE TABLE IF NOT EXISTS app_security_limits (
 key text PRIMARY KEY,
 attempts integer NOT NULL,
 expires_at timestamptz NOT NULL
);
COMMIT;

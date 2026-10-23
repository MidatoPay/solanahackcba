BEGIN;
ALTER TABLE app_security_users ADD COLUMN IF NOT EXISTS recovery_email text;
ALTER TABLE app_security_users ADD COLUMN IF NOT EXISTS recovery_verified_at timestamptz;
ALTER TABLE app_security_users ADD COLUMN IF NOT EXISTS recovery_version integer NOT NULL DEFAULT 0;
ALTER TABLE app_security_challenges ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'sent';
ALTER TABLE app_security_challenges ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE app_security_challenges ADD COLUMN IF NOT EXISTS contact_version integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS app_security_challenges_user_purpose ON app_security_challenges(user_id,purpose);
COMMIT;

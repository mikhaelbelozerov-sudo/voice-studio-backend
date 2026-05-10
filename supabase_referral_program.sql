-- Creator Invite Program (MVP-safe). Run after supabase_mvp_credits.sql
-- Existing referral rows get legacy_row = true (no new payouts). New rows default legacy_row = false.

ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_telegram_id bigint NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS fraud_score integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS users_referred_by_idx ON users (referred_by_telegram_id);

ALTER TABLE referrals ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS first_generation_at timestamptz NULL;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS download_ack_at timestamptz NULL;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS invitee_bonus_due_at timestamptz NULL;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS invitee_bonus_paid_at timestamptz NULL;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referrer_bonus_due_at timestamptz NULL;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referrer_bonus_paid_at timestamptz NULL;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS device_fingerprint text NULL;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS ip_hash text NULL;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS fraud_flag boolean NOT NULL DEFAULT false;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS fraud_reason text NULL;

-- Pre-migration rows: do not process under new reward engine (instant-invite era)
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS legacy_row boolean NOT NULL DEFAULT true;
ALTER TABLE referrals ALTER COLUMN legacy_row SET DEFAULT false;

COMMENT ON COLUMN referrals.status IS 'pending | activated | rewarded | rejected | flagged';

CREATE UNIQUE INDEX IF NOT EXISTS referrals_device_fingerprint_unique
  ON referrals (device_fingerprint)
  WHERE device_fingerprint IS NOT NULL AND length(device_fingerprint) >= 8 AND status <> 'rejected';

ALTER TABLE core.book_registry ADD COLUMN IF NOT EXISTS heal_status TEXT DEFAULT 'healthy';
ALTER TABLE core.book_registry ADD COLUMN IF NOT EXISTS last_healed_at TIMESTAMPTZ;
ALTER TABLE core.book_registry ADD COLUMN IF NOT EXISTS next_heal_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE core.book_registry ADD COLUMN IF NOT EXISTS heal_attempts INTEGER DEFAULT 0;
ALTER TABLE core.book_registry ADD COLUMN IF NOT EXISTS heal_error TEXT;
ALTER TABLE core.book_registry ADD COLUMN IF NOT EXISTS heal_lease_until TIMESTAMPTZ;

ALTER TABLE core.message_ledger ADD COLUMN IF NOT EXISTS env TEXT NOT NULL DEFAULT 'prod';
ALTER TABLE core.message_ledger ADD COLUMN IF NOT EXISTS detected_lang TEXT;

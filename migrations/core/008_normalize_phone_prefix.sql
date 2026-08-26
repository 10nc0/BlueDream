-- Migration 008: Normalize stored phone numbers to leading "+" form (E.164).
-- Older rows in core.book_registry stored creator_phone / phone_number without
-- the leading "+" (e.g. "19704439545"), while newer Twilio activations store
-- "+19704439545". This drift caused the password reset flow to silently fail
-- for tenants whose first activated book pre-dated the normalization fix.
--
-- Idempotent: only rows that look like a digit-only international number get
-- the "+" prefix. Already-prefixed values and NULLs are left untouched.

UPDATE core.book_registry
SET creator_phone = '+' || creator_phone
WHERE creator_phone IS NOT NULL
  AND creator_phone ~ '^[0-9]+$';

UPDATE core.book_registry
SET phone_number = '+' || phone_number
WHERE phone_number IS NOT NULL
  AND phone_number ~ '^[0-9]+$';

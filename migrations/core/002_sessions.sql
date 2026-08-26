-- Public sessions table for express-session (connect-pg-simple).
-- Auto-fixes old schema missing the 'expire' column.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'expire'
    ) THEN
        IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'sessions'
        ) THEN
            DROP TABLE public.sessions CASCADE;
        END IF;

        CREATE TABLE public.sessions (
            sid VARCHAR NOT NULL PRIMARY KEY,
            sess JSON NOT NULL,
            expire TIMESTAMP(6) NOT NULL
        );

        CREATE INDEX idx_sessions_expire ON public.sessions(expire);
    END IF;
END $$;

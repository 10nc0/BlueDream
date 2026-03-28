const logger = require('./logger');

function createDbInit(pool, tenantManager) {

    async function _initSessions() {
        const schemaCheck = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
              AND table_name = 'sessions' 
              AND column_name = 'expire'
        `);

        if (schemaCheck.rows.length === 0) {
            const tableExists = await pool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_schema = 'public' 
                      AND table_name = 'sessions'
                )
            `);

            if (tableExists.rows[0].exists) {
                logger.warn('Sessions table has wrong schema, auto-fixing...');
                await pool.query('DROP TABLE public.sessions CASCADE');
            }

            await pool.query(`
                CREATE TABLE public.sessions (
                    sid VARCHAR NOT NULL PRIMARY KEY,
                    sess JSON NOT NULL,
                    expire TIMESTAMP(6) NOT NULL
                )
            `);

            await pool.query(`
                CREATE INDEX idx_sessions_expire ON public.sessions(expire)
            `);

            logger.info('Sessions table created with correct schema');
        }
    }

    async function _initBookRegistry() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS core.book_registry (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                book_name TEXT NOT NULL,
                join_code TEXT UNIQUE NOT NULL,
                fractal_id TEXT UNIQUE NOT NULL,
                tenant_schema TEXT NOT NULL,
                tenant_email TEXT NOT NULL,
                phone_number TEXT,
                status TEXT DEFAULT 'pending',
                inpipe_type TEXT DEFAULT 'whatsapp',
                outpipe_ledger TEXT NOT NULL,
                outpipes_user JSONB DEFAULT '[]'::jsonb,
                created_at TIMESTAMP DEFAULT NOW(),
                activated_at TIMESTAMP,
                updated_at TIMESTAMP DEFAULT NOW(),
                heal_status TEXT DEFAULT 'healthy',
                last_healed_at TIMESTAMP,
                next_heal_at TIMESTAMP,
                heal_attempts INTEGER DEFAULT 0,
                heal_error TEXT,
                creator_phone TEXT
            )
        `);

        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                               WHERE table_schema = 'core' AND table_name = 'book_registry' AND column_name = 'heal_status') THEN
                    ALTER TABLE core.book_registry ADD COLUMN heal_status TEXT DEFAULT 'healthy';
                    ALTER TABLE core.book_registry ADD COLUMN last_healed_at TIMESTAMPTZ;
                    ALTER TABLE core.book_registry ADD COLUMN next_heal_at TIMESTAMPTZ DEFAULT NOW();
                    ALTER TABLE core.book_registry ADD COLUMN heal_attempts INTEGER DEFAULT 0;
                    ALTER TABLE core.book_registry ADD COLUMN heal_error TEXT;
                    ALTER TABLE core.book_registry ADD COLUMN heal_lease_until TIMESTAMPTZ;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                               WHERE table_schema = 'core' AND table_name = 'book_registry' AND column_name = 'heal_lease_until') THEN
                    ALTER TABLE core.book_registry ADD COLUMN heal_lease_until TIMESTAMPTZ;
                END IF;
            END $$;
        `);

        await Promise.all([
            pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_book_registry_join_code ON core.book_registry(join_code)`),
            pool.query(`CREATE INDEX IF NOT EXISTS idx_book_registry_tenant_schema ON core.book_registry(tenant_schema)`),
            pool.query(`CREATE INDEX IF NOT EXISTS idx_book_registry_fractal_id ON core.book_registry(fractal_id)`),
            pool.query(`CREATE INDEX IF NOT EXISTS idx_book_registry_status ON core.book_registry(status) WHERE status = 'pending'`),
            pool.query(`CREATE INDEX IF NOT EXISTS idx_book_registry_tenant_book ON core.book_registry(tenant_schema, id)`),
            pool.query(`CREATE INDEX IF NOT EXISTS idx_book_heal_priority ON core.book_registry(next_heal_at ASC) WHERE heal_status IN ('pending', 'healing')`),
            pool.query(`CREATE INDEX IF NOT EXISTS idx_book_heal_lease ON core.book_registry(heal_lease_until ASC NULLS FIRST) WHERE heal_status IN ('pending', 'healing')`),
        ]);

        logger.info('📚 Book registry initialized with dynamic indexing + heal queue');
    }

    async function _initBookEngagedPhones() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS core.book_engaged_phones (
                id SERIAL PRIMARY KEY,
                book_registry_id UUID NOT NULL REFERENCES core.book_registry(id) ON DELETE CASCADE,
                phone TEXT NOT NULL,
                is_creator BOOLEAN DEFAULT FALSE,
                first_engaged_at TIMESTAMP DEFAULT NOW(),
                last_engaged_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(book_registry_id, phone)
            )
        `);

        await Promise.all([
            pool.query(`CREATE INDEX IF NOT EXISTS idx_book_engaged_phones_phone ON core.book_engaged_phones(phone)`),
            pool.query(`CREATE INDEX IF NOT EXISTS idx_book_engaged_phones_book ON core.book_engaged_phones(book_registry_id)`),
            pool.query(`CREATE INDEX IF NOT EXISTS idx_book_engaged_phones_last_engaged ON core.book_engaged_phones(phone, last_engaged_at DESC)`),
        ]);

        logger.info('📱 Book engaged phones table initialized');
    }

    async function _initChannelIdentifiers() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS core.channel_identifiers (
                id              SERIAL PRIMARY KEY,
                channel         VARCHAR(50)  NOT NULL,
                external_id     VARCHAR(255) NOT NULL,
                book_fractal_id TEXT         NOT NULL,
                tenant_schema   VARCHAR(100) NOT NULL,
                created_at      TIMESTAMPTZ  DEFAULT NOW(),
                UNIQUE(channel, external_id)
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_channel_identifiers_lookup ON core.channel_identifiers(channel, external_id)`);
        logger.info('🔗 Channel identifiers table initialized');
    }

    async function _initMessageLedger() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS core.message_ledger (
                message_fractal_id   TEXT        PRIMARY KEY,
                book_fractal_id      TEXT        NOT NULL,
                ipfs_cid             TEXT,
                sender_hash          TEXT        NOT NULL,
                content_hash         TEXT        NOT NULL,
                has_attachment       BOOLEAN     DEFAULT false,
                attachment_disclosed BOOLEAN     DEFAULT true,
                attachment_cid       TEXT,
                env                  TEXT        NOT NULL DEFAULT 'prod',
                recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await pool.query(`ALTER TABLE core.message_ledger ADD COLUMN IF NOT EXISTS env TEXT NOT NULL DEFAULT 'prod'`);
        await pool.query(`ALTER TABLE core.message_ledger ADD COLUMN IF NOT EXISTS detected_lang TEXT`);

        await Promise.all([
            pool.query(`CREATE INDEX IF NOT EXISTS idx_message_ledger_book ON core.message_ledger(book_fractal_id)`),
            pool.query(`CREATE INDEX IF NOT EXISTS idx_message_ledger_ipfs ON core.message_ledger(ipfs_cid) WHERE ipfs_cid IS NOT NULL`),
            pool.query(`CREATE INDEX IF NOT EXISTS idx_message_ledger_env ON core.message_ledger(env)`),
        ]);

        logger.info('📜 Message ledger initialized');
    }

    async function _initPasswordResetTokens() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS core.password_reset_tokens (
                id SERIAL PRIMARY KEY,
                token TEXT UNIQUE NOT NULL,
                user_email TEXT NOT NULL,
                tenant_schema TEXT NOT NULL,
                phone TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                used BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await Promise.all([
            pool.query(`CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON core.password_reset_tokens(token)`),
            pool.query(`CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_email ON core.password_reset_tokens(user_email)`),
        ]);

        logger.info('🔑 Password reset tokens table initialized');
    }

    async function _initSystemTables() {
        await Promise.all([
            pool.query(`CREATE TABLE IF NOT EXISTS core.migrations (name TEXT PRIMARY KEY, completed_at TIMESTAMP DEFAULT NOW())`),
            pool.query(`
                CREATE TABLE IF NOT EXISTS core.system_counters (
                    id SERIAL PRIMARY KEY,
                    key TEXT UNIQUE NOT NULL,
                    value BIGINT NOT NULL,
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                )
            `),
            pool.query(`
                CREATE TABLE IF NOT EXISTS core.message_queue (
                    id SERIAL PRIMARY KEY,
                    priority TEXT NOT NULL DEFAULT 'text',
                    payload JSONB NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `),
            pool.query(`
                CREATE TABLE IF NOT EXISTS core.processed_sids (
                    sid TEXT PRIMARY KEY,
                    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `),
        ]);

        await Promise.all([
            pool.query(`INSERT INTO core.system_counters (key, value) VALUES ('phi_breathe_count', 0) ON CONFLICT (key) DO NOTHING`),
            pool.query(`CREATE INDEX IF NOT EXISTS message_queue_dequeue_idx ON core.message_queue (status, priority, created_at) WHERE status = 'pending'`),
            pool.query(`CREATE INDEX IF NOT EXISTS processed_sids_processed_at_idx ON core.processed_sids (processed_at)`),
        ]);
    }

    async function initUsageTable() {
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS core.playground_usage (
                    id SERIAL PRIMARY KEY,
                    date DATE NOT NULL,
                    service_type TEXT NOT NULL,
                    requests INTEGER DEFAULT 0,
                    prompt_tokens INTEGER DEFAULT 0,
                    completion_tokens INTEGER DEFAULT 0,
                    total_tokens INTEGER DEFAULT 0,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(date, service_type)
                )
            `);
            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_playground_usage_date ON core.playground_usage(date)
            `);
            logger.info('🎮 Playground usage table ready');
        } catch (error) {
            logger.warn({ err: error }, 'Failed to create usage table');
        }
    }

    async function initializeDatabase() {
        try {
            await tenantManager.initializeCoreSchema();
            await Promise.all([
                _initSessions(),
                _initBookRegistry(),
                _initMessageLedger(),
                _initPasswordResetTokens(),
                _initSystemTables(),
            ]);
            await Promise.all([
                _initBookEngagedPhones(),
                _initChannelIdentifiers(),
            ]);
            logger.info('🏗️ Core schema initialized with security tables');
            logger.info('🗄️ Database initialized successfully');
        } catch (error) {
            logger.error({ err: error }, 'Database initialization error');
            throw error;
        }
    }

    return { initializeDatabase, initUsageTable };
}

module.exports = { createDbInit };

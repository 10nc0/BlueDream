const axios = require('axios');
const querystring = require('querystring');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const { Pool } = require('pg');
const session = require('express-session');
const connectPg = require('connect-pg-simple');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const authService = require('./auth-service');
const TenantManager = require('./tenant-manager');
const { setTenantContext, getAllTenantSchemas, sanitizeForRole } = require('./tenant-middleware');
const HermesBot = require('./hermes-bot');
const ThothBot = require('./thoth-bot');
const IdrisBot = require('./idris-bot');
const HorusBot = require('./horus-bot');
const fractalId = require('./utils/fractal-id');
const MetadataExtractor = require('./metadata-extractor');
const genesisCounter = require('./server/genesis-counter');
const Prometheus = require('./prometheus');
const { extractTextFromDocument, getDocumentPrompt } = require('./utils/document-parser');
const { identifyFileType, executeExtractionCascade, formatJSONForGroq, getFinancialPhysicsSeed, intelligentChunking, buildMultiDocContext } = require('./utils/attachment-cascade');
const JSZip = require('jszip');
const CONSTANTS = require('./config/constants');
const { NYAN_PROTOCOL_SYSTEM_PROMPT } = require('./prompts/nyan-protocol');

// SECURITY: Enforce FRACTAL_SALT configuration before server starts
if (!process.env.FRACTAL_SALT) {
    const autoSalt = crypto.randomBytes(32).toString('hex');
    console.error('❌ CRITICAL: FRACTAL_SALT environment variable not set!');
    console.error('');
    console.error('🔐 FRACTAL_SALT is required for secure book ID generation.');
    console.error('');
    console.error('📋 SETUP INSTRUCTIONS:');
    console.error('   1. Go to Replit Secrets tab');
    console.error('   2. Add a new secret: FRACTAL_SALT');
    console.error('   3. Generate a secure value: https://www.random.org/strings/?num=1&len=64&digits=on&upperalpha=on&loweralpha=on&unique=on&format=plain');
    console.error('   4. Paste the generated string as the value');
    console.error('   5. Restart the server');
    console.error('');
    console.error('⚠️  For your convenience, here\'s a pre-generated salt (use this if you prefer):');
    console.error(`   ${autoSalt}`);
    console.error('');
    console.error('🛑 Server will not start until FRACTAL_SALT is configured.');
    process.exit(1);
}

const ALLOWED_GROUPS = process.env.ALLOWED_GROUPS ? process.env.ALLOWED_GROUPS.split(',').map(g => g.trim()) : [];
const ALLOWED_NUMBERS = process.env.ALLOWED_NUMBERS ? process.env.ALLOWED_NUMBERS.split(',').map(n => n.trim()) : [];

// GLOBAL CONSTANTS: Nyanbook Ledger (Output #01) - centralized monitoring for all tenants
// SECURITY: Loaded from environment variable (never hardcode webhooks in source code)
const NYANBOOK_LEDGER_WEBHOOK = process.env.NYANBOOK_WEBHOOK_URL;

if (!NYANBOOK_LEDGER_WEBHOOK) {
    console.error('❌ CRITICAL: NYANBOOK_WEBHOOK_URL environment variable not set!');
    console.error('   Book creation will fail without Output #01 webhook configured.');
}

// TRANSACTION MODE: Append pool_mode=transaction to DATABASE_URL for scalability
// This allows 10,000+ concurrent connections (vs 3-10 in Session mode)
// Trade-off: Cannot use SET search_path (must use explicit schema prefixes)
const databaseUrl = process.env.DATABASE_URL;
const poolModeParam = 'pool_mode=transaction';
const connectionString = databaseUrl?.includes('?')
    ? `${databaseUrl}&${poolModeParam}`  // Has existing params, append with &
    : `${databaseUrl}?${poolModeParam}`;  // No params yet, start with ?

const pool = new Pool({
    connectionString,
    ssl: databaseUrl?.includes('localhost') ? false : { 
        rejectUnauthorized: false
    },
    max: 20, // Transaction Mode supports 10,000+ connections - using 20 for production workload
    min: 2,
    connectionTimeoutMillis: 30000, // 30s for cold starts
    idleTimeoutMillis: 30000, // Release idle connections after 30s
    statement_timeout: 30000,
    query_timeout: 30000,
    idle_in_transaction_session_timeout: 30000
});

// CONNECTION POOL MONITORING: Track connection lifecycle
pool.on('connect', () => {
    console.log(`🔌 Pool: Connection acquired (Total: ${pool.totalCount}, Idle: ${pool.idleCount}, Waiting: ${pool.waitingCount})`);
});

pool.on('error', (err) => {
    console.error('💥 Pool: Unexpected error on idle client', err);
});

pool.on('remove', () => {
    console.log(`🔓 Pool: Connection released (Total: ${pool.totalCount}, Idle: ${pool.idleCount})`);
});

// ENVIRONMENT CHECK
// Replit sets REPLIT_DEPLOYMENT=1 when deployed (not 'true')
const isProd = process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production';
const dbHost = process.env.DATABASE_URL?.split('@')[1]?.split('.')[0] || 'unknown';

console.log(`🚀 Mode: ${isProd ? 'PRODUCTION' : 'DEVELOPMENT'}`);
console.log(`🗄️  DB Host: ${dbHost}`);
console.log(`📊 Pool: max=${pool.options.max}, min=${pool.options.min}, idleTimeout=${pool.options.idleTimeoutMillis}ms`);

const tenantManager = new TenantManager(pool);

// Timestamp helper function with timezone
function getTimestamp() {
    const now = new Date();
    return now.toLocaleString('en-US', { 
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZoneName: 'short'
    });
}

// Cache-busting headers helper (prevents browsers/CDNs from caching sensitive responses)
function noCacheHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
}

// REQUEST CONTEXT: AsyncLocalStorage for request-scoped data (no global console patching)
const requestContext = new AsyncLocalStorage();

// Get current request ID (returns empty string if not in request context)
function getRequestId() {
    const store = requestContext.getStore();
    return store?.requestId || '';
}

// Request-aware logging helper (only prefixes when in request context)
function rlog(...args) {
    const reqId = getRequestId();
    if (reqId) {
        console.log(`[${reqId}]`, ...args);
    } else {
        console.log(...args);
    }
}

function rerror(...args) {
    const reqId = getRequestId();
    if (reqId) {
        console.error(`[${reqId}]`, ...args);
    } else {
        console.error(...args);
    }
}

const app = express();

// Make pool available to middleware
app.locals.pool = pool;

// Trust proxy - required for HTTPS cookie support in Replit environment
app.set('trust proxy', 1);

// SECURITY: Helmet for production-grade security headers with strict CSP
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"], // External JS externalized to /vendor/
            styleSrc: ["'self'", "'unsafe-inline'"], // Inline styles required for dynamic UI
            imgSrc: ["'self'", "data:", "https:"], // Discord CDN media + data URIs
            connectSrc: ["'self'"], // API calls to same origin only
            fontSrc: ["'self'"],
            frameSrc: ["'self'"], // For iframe embedding if needed
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false // Required for iframe embedding
}));

// Track startup phase for health checks (30s grace period for Autoscale)
const serverStartTime = Date.now();
const STARTUP_GRACE_PERIOD_MS = 30000;

app.get('/health', async (req, res) => {
    const isStartupPhase = (Date.now() - serverStartTime) < STARTUP_GRACE_PERIOD_MS;
    
    try {
        // Quick timeout for DB check - don't block health response
        const dbCheck = await Promise.race([
            pool.query('SELECT 1 as health').then(() => 'connected').catch(() => 'unavailable'),
            new Promise(resolve => setTimeout(() => resolve('timeout'), 2000))
        ]);
        
        const poolStats = {
            total: pool.totalCount || 0,
            idle: pool.idleCount || 0,
            waiting: pool.waitingCount || 0,
            max: pool.options?.max || 20
        };
        
        const isDbHealthy = dbCheck === 'connected';
        
        // During startup: always return 200 (Autoscale needs time for DB init)
        // After startup: return 503 if DB is down
        if (isDbHealthy || isStartupPhase) {
            res.json({
                status: isDbHealthy ? 'healthy' : 'starting',
                message: 'Nyan breathes φ — Server alive',
                database: dbCheck,
                pool: poolStats,
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(503).json({
                status: 'unhealthy',
                message: 'Database connection failed',
                database: dbCheck,
                pool: poolStats,
                timestamp: new Date().toISOString()
            });
        }
    } catch (err) {
        // During startup: return 200 to allow initialization
        // After startup: return 503 for real failures
        if (isStartupPhase) {
            res.json({
                status: 'starting',
                message: 'Server initializing',
                database: 'initializing',
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(503).json({
                status: 'unhealthy',
                message: 'Health check failed',
                error: err.message,
                timestamp: new Date().toISOString()
            });
        }
    }
});

// SECURITY: CORS with origin whitelist
const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : [];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, Postman, etc.)
        if (!origin) return callback(null, true);
        
        // Allow localhost for development
        if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
            return callback(null, true);
        }
        
        // Allow any Replit domain (for development and production)
        if (origin.includes('.replit.dev') || origin.includes('.repl.co') || origin.includes('.replit.app')) {
            return callback(null, true);
        }
        
        // Allow custom domain (nyanbook.io)
        if (origin.includes('nyanbook.io')) {
            return callback(null, true);
        }
        
        // Check against whitelist (if configured)
        if (allowedOrigins.length > 0 && allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        
        // Log blocked origin for debugging
        console.error(`❌ CORS blocked origin: ${origin}`);
        
        // SECURITY: Default deny if not in Replit domains or whitelist
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true, // Required for cookie-based auth
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json({ limit: '10mb' })); // Increased for image uploads
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' })); // For Twilio webhooks

// REQUEST ID MIDDLEWARE: Add unique ID to every request for tracing
// Uses AsyncLocalStorage for proper request-scoped context (no global console patching)
app.use((req, res, next) => {
    req.requestId = crypto.randomUUID();
    res.setHeader('X-Request-ID', req.requestId);
    // Run the rest of the request in context with requestId
    requestContext.run({ requestId: req.requestId }, () => {
        next();
    });
});

// PostgreSQL session store with explicit schema to prevent search_path pollution
const pgSession = connectPg(session);
app.use(session({
    store: new pgSession({
        pool,
        schemaName: 'public', // CRITICAL: Explicit schema prevents tenant_X.sessions targeting
        tableName: 'sessions',
        createTableIfMissing: false, // Disabled: We manage schema in initializeDatabase()
        pruneSessionInterval: 60 * 60, // 1 hour (reduced from 15 min to avoid Transaction Mode timeouts)
        errorLog: (err) => {
            // Graceful error handling for Transaction Mode connection resets
            if (err.message && err.message.includes('terminated unexpectedly')) {
                console.warn('⚠️  Session prune failed (connection reset) – will retry next cycle');
            } else {
                console.error('❌ Session store error:', err.message || err);
            }
        }
    }),
    secret: process.env.SESSION_SECRET || 'book-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false, // Don't create session until something is stored
    rolling: true, // Reset expiration on every request
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 1 week
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // true in production, false in dev
        sameSite: 'none', // Required for cross-site iframe embedding
        partitioned: true // Required for Safari to accept cookies in iframes (CHIPS)
    },
    name: 'book.sid' // Custom session cookie name
}));

// Google OAuth removed - email/password authentication only

// Middleware to block HTML files from static serving
app.use((req, res, next) => {
    if (req.path.endsWith('.html') && req.path !== '/login.html') {
        return next(); // Let explicit routes handle HTML files
    }
    next();
});

// Serve AI Playground (public, no auth - sovereign gift to the world)
app.get('/AI', (req, res) => {
    console.log(`[${getTimestamp()}] 🎮 AI Playground accessed - IP: ${req.ip}`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(__dirname + '/public/playground.html');
});

// Serve login page without authentication (must come before requireAuth check)
app.get('/login.html', (req, res) => {
    console.log(`[${getTimestamp()}] 📱 Login page accessed - IP: ${req.ip}, User-Agent: ${req.get('user-agent')}`);
    // Prevent browser caching to ensure latest JavaScript is always loaded
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(__dirname + '/public/login.html');
});

// Serve signup page without authentication
app.get('/signup.html', (req, res) => {
    console.log(`[${getTimestamp()}] 📝 Signup page accessed - IP: ${req.ip}, User-Agent: ${req.get('user-agent')}`);
    // Prevent browser caching to ensure latest JavaScript is always loaded
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(__dirname + '/public/signup.html');
});

// Serve dev panel (auth happens client-side via JWT)
app.get('/dev', (req, res) => {
    console.log(`[${getTimestamp()}] 🛠️  Dev panel accessed - IP: ${req.ip}`);
    res.sendFile(__dirname + '/public/dev.html');
});

// UAT/Test route removed - use real signup flow for multi-tenant architecture

// Root redirects to AI Playground (public landing page)
app.get('/', (req, res) => {
    // Health check support: return 200 for HEAD requests (used by deployment health checks)
    if (req.method === 'HEAD') {
        return res.status(200).end();
    }
    
    // Redirect to AI Playground as the public landing page
    res.redirect('/AI');
});

// Serve main dashboard - client-side JWT auth will handle access control
app.get('/dashboard', (req, res) => {
    // Cache-busting headers to ensure UI updates are immediately visible
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(__dirname + '/public/index.html');
});

// Serve index.html - client-side JWT auth will handle access control
app.get('/index.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(__dirname + '/public/index.html');
});

// Serve only non-HTML static files without authentication
// HTML files are served through explicit authenticated routes above
app.use(express.static('public', { 
    index: false,
    ignore: ['*.html'], // Don't serve HTML files through static middleware
    setHeaders: (res, path) => {
        // Cache-busting for JS/CSS files to ensure production deployments update immediately
        if (path.endsWith('.js') || path.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// Apply tenant context middleware to all API routes (except auth routes)
app.use('/api/books', setTenantContext);
app.use('/api/messages', setTenantContext);
app.use('/api/users', setTenantContext);
app.use('/api/sessions', setTenantContext);
app.use('/api/audit', setTenantContext);
app.use('/api/analytics', setTenantContext);

// Discord Bot Manager for automatic thread creation per book
let hermesBot = null;

// Trinity: Thoth bot for read-only message fetching
let thothBot = null;

// Prometheus Trinity: Idris (write-only) + Horus (read-only) for AI audit logs
let idrisBot = null;
let horusBot = null;

async function initializeDatabase() {
    try {
        await tenantManager.initializeCoreSchema();
        
        // ✅ PURE TENANT_X ARCHITECTURE:
        // - users, active_sessions, audit_logs, refresh_tokens: ALL in tenant_X schemas (created by TenantManager)
        // - core schema: Only tenant_catalog, user_email_to_tenant, invites, sybil_protection, rate_limits
        // - public schema: Only sessions (express-session global store)
        
        // Create sessions table for express-session (global session store)
        // Note: connect-pg-simple expects column "expire" (singular), not "expires"
        // Auto-fix: Check if table has wrong schema and repair it
        const schemaCheck = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
              AND table_name = 'sessions' 
              AND column_name = 'expire'
        `);
        
        // If table exists but doesn't have "expire" column, drop and recreate
        if (schemaCheck.rows.length === 0) {
            const tableExists = await pool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_schema = 'public' 
                      AND table_name = 'sessions'
                )
            `);
            
            if (tableExists.rows[0].exists) {
                console.log('⚠️  Sessions table has wrong schema, auto-fixing...');
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
            
            console.log('✅ Sessions table created with correct schema');
        }
        
        // Note: RLS for public.sessions is configured directly in Supabase dashboard
        
        // CENTRALIZED BOOK REGISTRY: Global substrate for O(1) join code lookups
        // Eliminates N-schema loops (26+ queries → 1 query per message)
        // Hierarchy: Tenant (email) → Book (join_code) → Message → Drops + Attachments
        await pool.query(`
            CREATE TABLE IF NOT EXISTS core.book_registry (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                
                -- Book identity
                book_name TEXT NOT NULL,
                join_code TEXT UNIQUE NOT NULL,
                fractal_id TEXT UNIQUE NOT NULL,
                
                -- Tenant linkage (email substrate)
                tenant_schema TEXT NOT NULL,
                tenant_email TEXT NOT NULL,
                
                -- Activation tracking (placeholder → code → active)
                phone_number TEXT,
                status TEXT DEFAULT 'pending',
                
                -- Pipeline architecture (inpipe + multi-outpipe)
                inpipe_type TEXT DEFAULT 'whatsapp',
                outpipe_ledger TEXT NOT NULL,
                outpipes_user JSONB DEFAULT '[]'::jsonb,
                
                -- Timestamps
                created_at TIMESTAMP DEFAULT NOW(),
                activated_at TIMESTAMP,
                updated_at TIMESTAMP DEFAULT NOW(),
                
                -- Healing system (O(1) priority queue for auto-heal)
                heal_status TEXT DEFAULT 'healthy',
                last_healed_at TIMESTAMP,
                next_heal_at TIMESTAMP,
                heal_attempts INTEGER DEFAULT 0,
                heal_error TEXT,
                creator_phone TEXT
            )
        `);
        
        // Add healing columns if table already exists (migration)
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
                -- Add heal_lease_until if missing (incremental migration)
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                               WHERE table_schema = 'core' AND table_name = 'book_registry' AND column_name = 'heal_lease_until') THEN
                    ALTER TABLE core.book_registry ADD COLUMN heal_lease_until TIMESTAMPTZ;
                END IF;
            END $$;
        `);
        
        // Dynamic indexes for fast O(1) lookups on any dimension
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_book_registry_join_code 
            ON core.book_registry(join_code)
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_book_registry_tenant_schema 
            ON core.book_registry(tenant_schema)
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_book_registry_fractal_id 
            ON core.book_registry(fractal_id)
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_book_registry_status 
            ON core.book_registry(status) WHERE status = 'pending'
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_book_registry_tenant_book 
            ON core.book_registry(tenant_schema, id)
        `);
        
        // Priority queue index for O(log n) heal job pops (lease-based)
        // Note: Can't use NOW() in partial index, so we index all pending books
        // The query filters by lease_until at runtime
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_book_heal_priority 
            ON core.book_registry(next_heal_at ASC) 
            WHERE heal_status IN ('pending', 'healing')
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_book_heal_lease 
            ON core.book_registry(heal_lease_until ASC NULLS FIRST) 
            WHERE heal_status IN ('pending', 'healing')
        `);
        
        console.log('✅ Book registry initialized with dynamic indexing + heal queue');
        
        // MULTI-SOURCE UPLOADS: Track all phones that have engaged with each book
        // Enables contributors (not just creator) to send files without join code
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
        
        // Indexes for fast phone lookups
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_book_engaged_phones_phone 
            ON core.book_engaged_phones(phone)
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_book_engaged_phones_book 
            ON core.book_engaged_phones(book_registry_id)
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_book_engaged_phones_last_engaged 
            ON core.book_engaged_phones(phone, last_engaged_at DESC)
        `);
        
        console.log('✅ Book engaged phones table initialized');
        
        // MIGRATION TRACKING: Create table to track completed migrations
        await pool.query(`
            CREATE TABLE IF NOT EXISTS core.migrations (
                name TEXT PRIMARY KEY,
                completed_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        // SYSTEM COUNTERS: Persistent counters for phi breathe and other eternal values
        await pool.query(`
            CREATE TABLE IF NOT EXISTS core.system_counters (
                id SERIAL PRIMARY KEY,
                key TEXT UNIQUE NOT NULL,
                value BIGINT NOT NULL,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        
        // Initialize phi breathe counter if it doesn't exist
        await pool.query(`
            INSERT INTO core.system_counters (key, value) 
            VALUES ('phi_breathe_count', 0)
            ON CONFLICT (key) DO NOTHING
        `);
        
        // MIGRATION: Add audit_queries table to existing tenant schemas
        const auditQueriesMigration = await pool.query(`
            SELECT name FROM core.migrations WHERE name = 'audit_queries_table'
        `);
        
        if (auditQueriesMigration.rows.length === 0) {
            console.log('🔄 Running migration: audit_queries_table for existing tenants...');
            
            // Get all tenant schemas
            const tenantSchemas = await pool.query(`
                SELECT tenant_schema FROM core.tenant_catalog
            `);
            
            for (const row of tenantSchemas.rows) {
                const schema = row.tenant_schema;
                // Validate schema name format (tenant_X where X is numeric) for SQL injection protection
                if (!/^tenant_\d+$/.test(schema)) {
                    console.warn(`  ⚠️ Skipping invalid schema name: ${schema}`);
                    continue;
                }
                // Schema is validated, safe to use with double-quote identifier quoting
                const safeSchema = `"${schema}"`;
                try {
                    await pool.query(`
                        CREATE TABLE IF NOT EXISTS ${safeSchema}.audit_queries (
                            id SERIAL PRIMARY KEY,
                            user_id INTEGER NOT NULL,
                            book_id INTEGER,
                            rule_type TEXT NOT NULL,
                            language TEXT DEFAULT 'en',
                            input_messages JSONB NOT NULL,
                            result_status TEXT,
                            result_confidence NUMERIC(4,3),
                            result_reason TEXT,
                            result_data JSONB,
                            raw_response TEXT,
                            processing_time_ms INTEGER,
                            created_at TIMESTAMPTZ DEFAULT NOW()
                        )
                    `);
                    
                    await pool.query(`
                        CREATE INDEX IF NOT EXISTS idx_audit_queries_user_id ON ${safeSchema}.audit_queries(user_id)
                    `);
                    
                    await pool.query(`
                        CREATE INDEX IF NOT EXISTS idx_audit_queries_book_id ON ${safeSchema}.audit_queries(book_id)
                    `);
                    
                    console.log(`  ✅ Added audit_queries table to ${schema}`);
                } catch (err) {
                    console.error(`  ⚠️ Failed to add audit_queries to ${schema}:`, err.message);
                }
            }
            
            // Mark migration as complete
            await pool.query(`
                INSERT INTO core.migrations (name) VALUES ('audit_queries_table')
            `);
            console.log('✅ Migration audit_queries_table completed');
        }
        
        // NOTE: One-time migrations (updated_at, creator_phone, join_code, drops) have been
        // applied to production database and removed from startup code for clean deploys.
        // Migration records preserved in core.migrations table for audit trail.
        
        // MIGRATION: Add AI log columns to tenant_catalog for Prometheus Trinity
        const aiLogMigration = await pool.query(`
            SELECT name FROM core.migrations WHERE name = 'ai_log_columns'
        `);
        
        if (aiLogMigration.rows.length === 0) {
            console.log('🔄 Running migration: ai_log_columns for tenant_catalog...');
            
            try {
                // Add AI log columns to core.tenant_catalog
                await pool.query(`
                    ALTER TABLE core.tenant_catalog 
                    ADD COLUMN IF NOT EXISTS ai_log_thread_id TEXT,
                    ADD COLUMN IF NOT EXISTS ai_log_channel_id TEXT
                `);
                
                // Mark migration as complete
                await pool.query(`
                    INSERT INTO core.migrations (name) VALUES ('ai_log_columns')
                `);
                console.log('✅ Migration ai_log_columns completed');
            } catch (err) {
                console.error(`⚠️ Failed to add AI log columns:`, err.message);
            }
        }
        
        // ARCHITECTURE: Messages stored ONLY in Discord (not PostgreSQL)
        // No messages table needed - Discord threads provide permanent storage at zero cost
        
        // NOTE: All tenant schemas (users, books, media_buffer, etc.) are created by TenantManager
        // during tenant initialization. No manual migrations needed for N+1 scalability.
        
        console.log('✅ Core schema initialized with security tables');
        console.log('✅ Database initialized successfully');
    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
        throw error;
    }
}

// Initialize playground usage table for internal scribe (token tracking)
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
        
        console.log('✅ Playground usage table ready');
    } catch (error) {
        console.error('⚠️ Failed to create usage table:', error.message);
    }
}

// WEBHOOK-CENTRIC ARCHITECTURE: Dual-output delivery (Book #01 + Book #0n)
// Output #01: Nyanbook Ledger (eternal, masked, Dev #01 only) via output_01_url
// Output #0n: User Discord (mutable, visible, Admin #0n only) via output_0n_url
// UI MASKING: "webhook" → "book" terminology everywhere except create form
// DATABASE ROLE: Stores ONLY routing metadata (webhook URLs, thread IDs) - NOT messages

// HELPER: Get file extension from MIME type (supports ALL formats)
function getFileExtension(mimetype) {
    const mimeMap = {
        // Images
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/svg+xml': 'svg',
        'image/bmp': 'bmp',
        'image/tiff': 'tiff',
        // Videos
        'video/mp4': 'mp4',
        'video/mpeg': 'mpeg',
        'video/quicktime': 'mov',
        'video/x-msvideo': 'avi',
        'video/webm': 'webm',
        'video/3gpp': '3gp',
        // Audio
        'audio/mpeg': 'mp3',
        'audio/mp3': 'mp3',
        'audio/ogg': 'ogg',
        'audio/opus': 'opus',
        'audio/wav': 'wav',
        'audio/webm': 'weba',
        'audio/aac': 'aac',
        'audio/x-m4a': 'm4a',
        // Documents - Microsoft Office
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-excel': 'xls',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'application/vnd.ms-powerpoint': 'ppt',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
        // Documents - Other
        'application/pdf': 'pdf',
        'application/zip': 'zip',
        'application/x-rar-compressed': 'rar',
        'application/x-7z-compressed': '7z',
        'text/plain': 'txt',
        'text/csv': 'csv',
        'application/json': 'json',
        'application/xml': 'xml',
        'text/html': 'html',
        'application/rtf': 'rtf',
        // Archives
        'application/gzip': 'gz',
        'application/x-tar': 'tar',
    };
    
    // Return mapped extension or extract from mimetype
    return mimeMap[mimetype] || mimetype.split('/').pop().replace(/[^a-z0-9]/gi, '');
}

// Send to Ledger (Output #01 - internal monitoring thread)
// WEBHOOK-FIRST: Accepts book object directly, no database queries needed
// Message chunking for Discord's limits (4096 char embed description)
const MESSAGE_CHUNK_SIZE = 3800; // Safe margin under 4096 limit

function splitMessageIntoChunks(text, chunkSize = MESSAGE_CHUNK_SIZE) {
    if (text.length <= chunkSize) {
        return [text]; // No split needed
    }
    
    const chunks = [];
    let remaining = text;
    
    while (remaining.length > 0) {
        if (remaining.length <= chunkSize) {
            chunks.push(remaining);
            break;
        }
        
        // Try to split at newline for cleaner breaks
        let splitIndex = remaining.lastIndexOf('\n', chunkSize);
        if (splitIndex === -1 || splitIndex < chunkSize * 0.5) {
            // No good newline, split at word boundary
            splitIndex = remaining.lastIndexOf(' ', chunkSize);
            if (splitIndex === -1 || splitIndex < chunkSize * 0.5) {
                // No good word boundary, hard split
                splitIndex = chunkSize;
            }
        }
        
        chunks.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).trimStart();
    }
    
    return chunks;
}

// HELPER: Post to webhook with optional media (eliminates duplicate logic)
async function postPayloadToWebhook(url, payload, options = {}) {
    if (!url) throw new Error('Webhook URL required');
    
    try {
        let response;
        
        // Handle direct media buffer (from Twilio download)
        if (options.mediaBuffer) {
            const FormData = require('form-data');
            const form = new FormData();
            form.append('files[0]', options.mediaBuffer, {
                filename: options.mediaFilename || 'attachment',
                contentType: options.mediaContentType || 'application/octet-stream'
            });
            form.append('payload_json', JSON.stringify(payload));
            response = await axios.post(url, form, { headers: form.getHeaders() });
        } 
        // Handle media from DB buffer table
        else if (options.isMedia && options.mediaBufferId && options.tenantSchema && options.pool) {
            const mediaClient = await options.pool.connect();
            try {
                const mediaResult = await mediaClient.query(`
                    SELECT media_data, media_type, filename 
                    FROM ${options.tenantSchema}.media_buffer 
                    WHERE id = $1
                `, [options.mediaBufferId]);
                
                if (mediaResult.rows.length === 0) {
                    throw new Error(`Media buffer ID ${options.mediaBufferId} not found`);
                }
                
                const { media_data, media_type, filename } = mediaResult.rows[0];
                const FormData = require('form-data');
                const form = new FormData();
                form.append('file', media_data, {
                    filename: filename,
                    contentType: media_type
                });
                form.append('payload_json', JSON.stringify(payload));
                response = await axios.post(url, form, { headers: form.getHeaders() });
            } finally {
                mediaClient.release();
            }
        }
        // Text-only payload
        else {
            response = await axios.post(url, payload);
        }
        
        return response;
    } catch (error) {
        console.error(`  ❌ Webhook POST failed: ${error.message}`);
        throw error;
    }
}

async function sendToLedger(payload, options = {}, book = null) {
    // WEBHOOK-FIRST: Use webhook URL directly from book object
    let ledgerUrl = book?.output_01_url;
    
    // Fallback to global constant if book doesn't have URL configured
    if (!ledgerUrl || !ledgerUrl.trim()) {
        ledgerUrl = NYANBOOK_LEDGER_WEBHOOK;
    }
    
    if (!ledgerUrl) {
        console.log('  ℹ️  No ledger configured - skipping Output #01');
        return null;
    }

    try {
        // DUAL-OUTPUT: Detect channel vs thread routing
        const output = options.output;
        const destinationType = output?.type || 'unknown';
        const destinationId = output?.type === 'thread' ? output?.thread_id : output?.channel_id;
        
        // Debug logging (mask webhook URL for security)
        console.log(`  🔍 Ledger URL: ${ledgerUrl ? '[MASKED_LEDGER_WEBHOOK]' : 'none'}`);
        console.log(`  🔍 Destination: ${destinationType} (ID: ${destinationId || 'none'})`);
        
        const url = new URL(ledgerUrl);
        url.searchParams.set('wait', 'true');
        
        // CRITICAL: thread_id is only added for threads (not channels)
        if (output?.type === 'thread' && output?.thread_id) {
            url.searchParams.set('thread_id', output.thread_id);
            console.log(`  📍 Targeting thread: ${output.thread_id}`);
        } else if (output?.type === 'channel') {
            console.log(`  📍 Targeting channel: ${output.channel_id}`);
        }

        // Use unified webhook helper
        const response = await postPayloadToWebhook(url.toString(), payload, {
            mediaBuffer: options.mediaBuffer,
            mediaFilename: options.mediaFilename,
            mediaContentType: options.mediaContentType,
            isMedia: options.isMedia,
            mediaBufferId: options.mediaBufferId,
            tenantSchema: options.tenantSchema,
            pool
        });

        console.log(`  ✅ Sent to Output #01 (Ledger) - Thread: ${options.threadId || 'channel'}`);
        return response.data?.channel_id || null;
    } catch (error) {
        console.error(`  ❌ Output #01 failed: ${error.message}`);
        console.error(`  🔍 URL attempted: ${ledgerUrl?.substring(0, 50)}...`);
        if (error.response?.data) {
            console.error(`  🔍 Discord error response:`, JSON.stringify(error.response.data, null, 2));
        }
        return null;
    }
}

// Send to User Output (Output #0n = user's personal Discord, mutable)
// DUAL-OUTPUT: Routes to output_0n (channel OR thread) for user visibility
// MULTI-WEBHOOK: Sends to ALL webhooks in output_credentials.webhooks array
async function sendToUserOutput(payload, options = {}, book = null) {
    if (!book) {
        console.log('  ℹ️  No book context - skipping Output #0n');
        return false;
    }

    try {
        // MULTI-WEBHOOK: Get all webhooks from output_credentials.webhooks array
        const webhooks = book.output_credentials?.webhooks || [];
        const fallbackUrl = book.output_0n_url; // Backward compatibility
        
        // If no webhooks in array, try fallback single URL
        if (webhooks.length === 0 && (!fallbackUrl || !fallbackUrl.trim())) {
            console.log(`  ℹ️  No Output #0n configured - skipping user Discord`);
            return false;
        }
        
        // Build webhook list: prioritize webhooks array, fall back to single URL
        const webhookList = webhooks.length > 0 
            ? webhooks.filter(w => w.url && w.url.trim())
            : (fallbackUrl ? [{ name: 'Personal Webhook', url: fallbackUrl }] : []);
        
        if (webhookList.length === 0) {
            console.log(`  ℹ️  No valid webhooks configured - skipping user Discord`);
            return false;
        }
        
        console.log(`  📤 Sending to ${webhookList.length} personal webhook(s)...`);
        
        // Send to ALL webhooks in parallel (unified helper handles media)
        const sendPromises = webhookList.map(async (webhook, index) => {
            try {
                const url = new URL(webhook.url);
                url.searchParams.set('wait', 'true');
                
                // DUAL-OUTPUT: Route to output_0n (channel OR thread)
                const output = options.output;
                if (output?.type === 'thread' && output?.thread_id) {
                    url.searchParams.set('thread_id', output.thread_id);
                }
                
                // Use unified webhook helper
                await postPayloadToWebhook(url.toString(), payload, {
                    isMedia: options.isMedia,
                    mediaBufferId: options.mediaBufferId,
                    tenantSchema: options.tenantSchema,
                    pool
                });
                
                console.log(`    ✅ Sent to "${webhook.name || 'Webhook ' + (index + 1)}"`);
                return true;
            } catch (error) {
                console.error(`    ❌ Failed to send to "${webhook.name || 'Webhook ' + (index + 1)}": ${error.message}`);
                return false;
            }
        });
        
        const results = await Promise.all(sendPromises);
        const successCount = results.filter(r => r).length;
        console.log(`  📊 Sent to ${successCount}/${webhookList.length} webhook(s)`);
        
        // Mark media as delivered (only if at least one webhook succeeded)
        if (successCount > 0 && options.isMedia && options.mediaBufferId) {
            const deliveryClient = await pool.connect();
            try {
                await deliveryClient.query(`
                    UPDATE ${options.tenantSchema}.media_buffer 
                    SET delivered_to_user = true,
                        delivery_attempts = delivery_attempts + 1,
                        last_delivery_attempt = NOW()
                    WHERE id = $1
                `, [options.mediaBufferId]);
            } finally {
                deliveryClient.release();
            }
        }

        console.log(`  ✅ Sent to Output #0n (User Discord)`);
        return true;
    } catch (error) {
        console.error(`  ❌ Output #0n failed: ${error.message}`);
        if (error.response?.data) {
            console.error(`  🔍 Discord error response:`, JSON.stringify(error.response.data, null, 2));
        }
        return false;
    }
}

async function saveMessage(client, message, bookId = 1) {
    // ARCHITECTURE: Messages stored ONLY in Discord (not PostgreSQL)
    // This function is kept for backward compatibility but does nothing
    // Discord threads provide permanent storage, search, and UI at zero cost
    return null;
}

// DEAD CODE REMOVED: updateMessageStatus, getMessages, getMessageStats
// REASON: Messages stored ONLY in Discord (not PostgreSQL)
// Discord threads provide permanent storage, search, and message management
// No PostgreSQL messages table exists in tenant schemas

// ===== GENESIS COUNTER API (Red Herring) =====
// Expose counter state for debugging/monitoring
app.get('/api/genesis', (req, res) => {
    res.json({
        genesis: genesisCounter.getGenesis(),
        age_ms: genesisCounter.getAge(),
        cat_breath: genesisCounter.getCount(),
        phi_breath: genesisCounter.getPhiCount(),
        timestamp: Date.now()
    });
});

// Manager initialization moved to app.listen() to prevent race conditions
// This ensures managers are fully initialized before server accepts requests

/**
 * Get the tenant schema that owns a specific book
 * This ensures book activities are tracked in the correct tenant's database
 * 
 * FRACTALIZED ID VERSION: Parses fractal_id to extract tenant (no database query needed!)
 */
async function getBookTenantSchema(fractalIdOrLegacyId) {
    try {
        // Try parsing as fractalized ID first (e.g., book_t6_abc123 or dev_book_t1_abc123)
        const parsed = fractalId.parse(fractalIdOrLegacyId);
        if (parsed && parsed.tenantId) {
            const tenantSchema = `tenant_${parsed.tenantId}`;
            console.log(`✅ Parsed fractal_id: Book belongs to ${tenantSchema}`);
            return tenantSchema;
        }
        
        // Fallback: Legacy numeric ID - query database (slow path for backward compatibility)
        const legacyId = parseInt(fractalIdOrLegacyId);
        if (!isNaN(legacyId)) {
            console.warn(`⚠️ Using legacy book ID ${legacyId} - querying database (slow)`);
            const schemasResult = await pool.query(`
                SELECT schema_name 
                FROM information_schema.schemata 
                WHERE schema_name LIKE 'tenant_%'
                ORDER BY schema_name
            `);
            
            for (const row of schemasResult.rows) {
                const schema = row.schema_name;
                const bookCheck = await pool.query(`
                    SELECT id FROM ${schema}.books WHERE id = $1
                `, [legacyId]);
                
                if (bookCheck.rows.length > 0) {
                    console.log(`✅ Legacy book ${legacyId} belongs to ${schema}`);
                    return schema;
                }
            }
        }
        
        // Fallback to public if not found (shouldn't happen)
        console.warn(`⚠️ Book ${fractalIdOrLegacyId} not found, defaulting to public`);
        return 'public';
    } catch (error) {
        console.error(`❌ Error finding tenant for book ${fractalIdOrLegacyId}:`, error);
        return 'public';
    }
}

// ============ BAILEYS MESSAGE HANDLER - REMOVED ============
// The old createTenantAwareMessageHandler() has been removed - Twilio webhook handles inbound messages.
// See /api/twilio/webhook endpoint below for message routing.

// Legacy compatibility: Remove old session directory if it exists
function cleanupLegacySession() {
    const legacyPath = './.wwebjs_auth/session';
    if (fs.existsSync(legacyPath)) {
        console.log('🧹 Cleaning up legacy session...');
        fs.rmSync(legacyPath, { recursive: true, force: true });
        console.log('✅ Legacy session cleaned');
    }
}

cleanupLegacySession();

// OLD initializeWhatsAppClient() function removed - replaced with per-book management
// See book-level API endpoints below: POST /api/books/:id/start, DELETE /api/books/:id/stop, etc.
// Each book now has its own independent message session managed by WhatsAppClientManager

// ============ SESSION TRACKING SYSTEM ============

// Parse user agent to extract device, browser, and OS
function parseUserAgent(userAgent) {
    const ua = userAgent || '';
    
    // Detect device type
    let deviceType = 'Desktop';
    if (/Mobile|Android|iPhone|iPod/i.test(ua)) deviceType = 'Mobile';
    else if (/iPad|Tablet/i.test(ua)) deviceType = 'Tablet';
    
    // Detect browser
    let browser = 'Unknown';
    if (/Edg/i.test(ua)) browser = 'Edge';
    else if (/Chrome/i.test(ua)) browser = 'Chrome';
    else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
    else if (/Firefox/i.test(ua)) browser = 'Firefox';
    else if (/MSIE|Trident/i.test(ua)) browser = 'Internet Explorer';
    
    // Detect OS
    let os = 'Unknown';
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/iOS|iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
    
    return { deviceType, browser, os };
}

// Simple location detection from IP (basic implementation)
async function getLocationFromIP(ipAddress) {
    try {
        // For local/private IPs, return Unknown
        if (!ipAddress || ipAddress === '::1' || ipAddress.startsWith('127.') || ipAddress.startsWith('192.168.') || ipAddress.startsWith('10.')) {
            return 'Local Network';
        }
        
        // Use free ipapi.co service for geolocation (no API key needed)
        const response = await fetch(`https://ipapi.co/${ipAddress}/json/`, {
            timeout: 3000 // 3 second timeout
        });
        
        if (response.ok) {
            const data = await response.json();
            if (data.city && data.country_name) {
                return `${data.city}, ${data.country_name}`;
            } else if (data.country_name) {
                return data.country_name;
            }
        }
        
        return 'Unknown Location';
    } catch (error) {
        console.error('Error getting location:', error.message);
        return 'Unknown Location';
    }
}

// Create session tracking record (multi-tenant)
async function createSessionRecord(userId, sessionId, req, tenantSchema) {
    try {
        const userAgent = req.get('user-agent') || '';
        const { deviceType, browser, os } = parseUserAgent(userAgent);
        const location = await getLocationFromIP(req.ip);
        
        // Use tenant-scoped active_sessions table
        await pool.query(`
            INSERT INTO ${tenantSchema}.active_sessions (user_id, session_id, ip_address, user_agent, device_type, browser, os, location)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [userId, sessionId, req.ip, userAgent, deviceType, browser, os, location]);
        
        console.log(`[${getTimestamp()}] 📱 Session created - User: ${userId}, Device: ${deviceType}, Browser: ${browser}, OS: ${os}, IP: ${req.ip}, Location: ${location}`);
    } catch (error) {
        console.error('Error creating session record:', error.message);
    }
}

// ============ AUDIT LOGGING SYSTEM ============

// Helper function to log audit events (multi-tenant)
async function logAudit(client, req, actionType, targetType, targetId, targetEmail, details = {}, tenantSchema = null) {
    try {
        // AUDIT FIX: Use req.userId (from requireAuth) first, fallback to session
        // This prevents audit gaps when session is destroyed during logout
        const actorUserId = req.userId || req.session?.userId || null;
        let actorEmail = req.userEmail || null;
        
        // Auto-detect tenant schema from req.tenantSchema if not provided
        const schema = tenantSchema || req.tenantSchema;
        
        if (!schema) {
            console.warn('⚠️ Audit logging skipped - no tenant schema available');
            return;
        }
        
        // Fetch email if we have userId but not email (from tenant-scoped users table)
        if (actorUserId && !actorEmail) {
            const userResult = await client.query(`SELECT email FROM ${schema}.users WHERE id = $1`, [actorUserId]);
            actorEmail = userResult.rows[0]?.email || null;
        }
        
        // Use tenant-scoped audit_logs table
        await client.query(`
            INSERT INTO ${schema}.audit_logs (
                actor_user_id, action_type, target_type, 
                target_id, details, ip_address, user_agent
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
            actorUserId,
            actionType,
            targetType,
            targetId,
            JSON.stringify(details),
            req.ip || req.connection?.remoteAddress || 'system',
            (req.get && typeof req.get === 'function') ? req.get('user-agent') : 'system'
        ]);
    } catch (error) {
        console.error('Audit logging failed:', error);
        // Don't throw - audit logging failure shouldn't break the main operation
    }
}

// ============ AUTHENTICATION MIDDLEWARE ============

// Middleware to check if user is authenticated (supports both JWT and cookies)
async function requireAuth(req, res, next) {
    // Try JWT authentication first (Authorization header)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const decoded = authService.verifyToken(token);
        
        if (decoded && decoded.type === 'access') {
            // Valid JWT token - set user context from JWT payload
            req.userId = decoded.userId;
            req.userEmail = decoded.email;
            req.userRole = decoded.role;
            req.tenantId = decoded.tenantId;
            req.tenantSchema = `tenant_${decoded.tenantId}`; // CRITICAL: Set tenant schema for multi-tenant isolation
            req.authMethod = 'jwt';
            return next();
        } else {
            // SECURITY: Invalid JWT present - do NOT fall back to session
            // An attacker could send a bad JWT to bypass token revocation
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
    }
    
    // Fall back to cookie-based session auth (only if no JWT provided)
    if (req.session && req.session.userId) {
        // Lookup email → tenant mapping for session-based auth
        try {
            const mappingResult = await pool.query(
                'SELECT tenant_id, tenant_schema FROM core.user_email_to_tenant WHERE email = $1',
                [req.session.userEmail]
            );
            
            if (mappingResult.rows.length === 0) {
                return res.status(401).json({ error: 'User not found' });
            }
            
            const { tenant_id, tenant_schema } = mappingResult.rows[0];
            
            req.userId = req.session.userId;
            req.userEmail = req.session.userEmail;
            req.userRole = req.session.userRole;
            req.tenantId = tenant_id;
            req.tenantSchema = tenant_schema;
            req.authMethod = 'cookie';
            return next();
        } catch (error) {
            console.error('Session auth error:', error);
            return res.status(500).json({ error: 'Authentication failed' });
        }
    }
    
    // No valid authentication found
    if (req.originalUrl.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    // Redirect to login page for browser requests
    return res.redirect('/login.html');
}

// Middleware to check roles with hierarchy: dev > admin > user
// PREREQUISITE: Must be used AFTER requireAuth (which sets req.tenantSchema)
function requireRole(...allowedRoles) {
    return async (req, res, next) => {
        if (!req.userId || !req.tenantSchema) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        // Query user role from tenant-scoped table (tenantSchema already set by requireAuth)
        const result = await pool.query(
            `SELECT role FROM ${req.tenantSchema}.users WHERE id = $1`,
            [req.userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'User not found' });
        }
        
        const userRole = result.rows[0].role;
        
        // Role hierarchy: dev > admin > user
        // Dev has access to everything
        if (userRole === 'dev') {
            req.userRole = userRole;
            return next();
        }
        
        // Admin has access to admin and user endpoints
        if (userRole === 'admin' && (allowedRoles.includes('admin') || allowedRoles.includes('user'))) {
            req.userRole = userRole;
            return next();
        }
        
        // Otherwise check exact match
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        
        req.userRole = userRole;
        next();
    };
}

// ============ AUTHENTICATION ROUTES ============

// Check if user is logged in (supports both JWT and cookies) - TENANT-AWARE
app.get('/api/auth/status', async (req, res) => {
    noCacheHeaders(res);
    
    try {
        // Check JWT first
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const decoded = authService.verifyToken(token);
            
            if (decoded && decoded.type === 'access') {
                // Get tenant from JWT and query tenant_X.users
                const mappingResult = await pool.query(
                    'SELECT tenant_schema FROM core.user_email_to_tenant WHERE email = $1',
                    [decoded.email]
                );
                
                if (mappingResult.rows.length > 0) {
                    const { tenant_schema } = mappingResult.rows[0];
                    const result = await pool.query(
                        `SELECT id, email, role, is_genesis_admin, tenant_id FROM ${tenant_schema}.users WHERE id = $1`,
                        [decoded.userId]
                    );
                    
                    if (result.rows.length > 0) {
                        return res.json({ authenticated: true, user: result.rows[0], authMethod: 'jwt' });
                    }
                }
            }
        }
        
        // Fall back to session
        if (req.session && req.session.userId && req.session.userEmail) {
            const mappingResult = await pool.query(
                'SELECT tenant_schema FROM core.user_email_to_tenant WHERE email = $1',
                [req.session.userEmail]
            );
            
            if (mappingResult.rows.length > 0) {
                const { tenant_schema } = mappingResult.rows[0];
                const result = await pool.query(
                    `SELECT id, email, role, is_genesis_admin, tenant_id FROM ${tenant_schema}.users WHERE id = $1`,
                    [req.session.userId]
                );
                
                if (result.rows.length > 0) {
                    return res.json({ authenticated: true, user: result.rows[0], authMethod: 'cookie' });
                }
            }
        }
        
        res.json({ authenticated: false });
    } catch (error) {
        console.error('Auth status error:', error);
        res.json({ authenticated: false });
    }
});

// Email/Password Login
app.post('/api/auth/login', async (req, res) => {
    noCacheHeaders(res);
    
    const { email, password } = req.body;
    
    // Log all login attempts
    console.log(`[${getTimestamp()}] 🔐 Login attempt - Email: ${email}, IP: ${req.ip}, User-Agent: ${req.get('user-agent')}`);
    
    try {
        // Validate input before normalization
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }
        
        // Normalize email for case-insensitive lookup
        const normalizedEmail = email.toLowerCase().trim();
        
        // Lookup email → tenant mapping
        const mappingResult = await pool.query(
            'SELECT tenant_id, tenant_schema, user_id FROM core.user_email_to_tenant WHERE LOWER(email) = $1',
            [normalizedEmail]
        );
        
        if (mappingResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const { tenant_schema, user_id } = mappingResult.rows[0];
        
        // Query user from tenant-scoped table
        const result = await pool.query(
            `SELECT * FROM ${tenant_schema}.users WHERE id = $1 AND LOWER(email) = $2`,
            [user_id, normalizedEmail]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        req.session.userId = user.id;
        req.session.userEmail = user.email;
        req.session.userRole = user.role;
        req.session.tenantId = user.tenant_id;
        
        // Generate JWT tokens with full tenant context
        const adminId = user.is_genesis_admin ? '01' : null;
        const accessToken = authService.signAccessToken(
            user.id, 
            user.email, 
            user.role,
            user.tenant_id,
            adminId,
            user.is_genesis_admin
        );
        const { token: refreshToken, tokenId } = authService.signRefreshToken(
            user.id, 
            user.email, 
            user.role,
            user.tenant_id,
            adminId,
            user.is_genesis_admin
        );
        
        // Store refresh token in tenant-scoped database
        const deviceInfo = req.get('user-agent') || 'unknown';
        await authService.storeRefreshToken(pool, tenant_schema, user.id, tokenId, deviceInfo, req.ip);
        
        // Save session explicitly before sending response
        req.session.save(async (err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Session save failed' });
            }
            
            // Create session tracking record
            await createSessionRecord(user.id, req.sessionID, req, tenant_schema);
            
            // Log successful login
            logAudit(pool, req, 'LOGIN', 'USER', user.id.toString(), user.email, {
                method: 'email_password',
                role: user.role,
                authType: 'jwt+cookie'
            }, tenant_schema);
            
            console.log(`[${getTimestamp()}] ✅ Login successful - User: ${user.email}, SessionID: ${req.sessionID}, JWT issued`);
            
            res.json({ 
                success: true,
                user: { 
                    id: user.id, 
                    email: user.email, 
                    role: user.role 
                },
                // JWT tokens for token-based auth
                accessToken,
                refreshToken,
                tokenExpiry: authService.ACCESS_TOKEN_EXPIRY
            });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Check if next signup would be the genesis user (first user)
app.get('/api/auth/check-genesis', async (req, res) => {
    noCacheHeaders(res);
    
    try {
        // Multi-tenant: Check tenant_catalog instead of public.users
        const tenantCount = await pool.query('SELECT COUNT(*) FROM core.tenant_catalog');
        const isFirstUser = parseInt(tenantCount.rows[0].count) === 0;
        res.json({ isFirstUser });
    } catch (error) {
        res.status(500).json({ error: 'Failed to check status' });
    }
});

// Public Signup Endpoint - Handles both new tenant creation and invite-based signup
app.post('/api/auth/signup', async (req, res) => {
    const { email, password, inviteToken } = req.body;
    
    console.log(`[${getTimestamp()}] 📝 Signup attempt - Email: ${email}, IP: ${req.ip}, HasInvite: ${!!inviteToken}`);
    
    try {
        // Validate input
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        
        // Normalize email to lowercase for case-insensitive uniqueness
        const normalizedEmail = email.toLowerCase().trim();
        
        // CRITICAL: Email uniqueness gatefencing - check BEFORE any writes
        // Read-Check-Bounce pattern to enforce one email = one tenant globally
        const emailCheck = await pool.query(
            'SELECT tenant_id FROM core.user_email_to_tenant WHERE LOWER(email) = $1',
            [normalizedEmail]
        );
        if (emailCheck.rows.length > 0) {
            console.log(`[${getTimestamp()}] 🚫 Signup blocked - Email already exists in tenant ${emailCheck.rows[0].tenant_id}`);
            return res.status(409).json({ error: 'Email already registered' });
        }
        
        let newUser;
        let isGenesisAdmin = false;
        let tenantId = null;
        let tenantUserId = null;
        
        // BRANCH: Invite-based signup (join existing tenant)
        if (inviteToken) {
            const validation = await tenantManager.validateInviteToken(inviteToken);
            if (!validation.valid) {
                return res.status(400).json({ error: validation.reason });
            }
            
            const invite = validation.invite;
            const passwordHash = await bcrypt.hash(password, 10);
            
            // Create user in tenant-scoped users table (first principles!)
            const schemaName = `tenant_${invite.tenant_id}`;
            const result = await pool.query(`
                INSERT INTO ${schemaName}.users (email, password_hash, role, tenant_id, is_genesis_admin)
                VALUES ($1, $2, $3, $4, false)
                RETURNING id, email, role, tenant_id, is_genesis_admin
            `, [normalizedEmail, passwordHash, invite.target_role, invite.tenant_id]);
            
            newUser = result.rows[0];
            tenantUserId = newUser.id;
            tenantId = invite.tenant_id;
            
            // Map email to tenant in core (for login routing)
            await pool.query(`
                INSERT INTO core.user_email_to_tenant (email, tenant_id, tenant_schema, user_id)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (email) DO NOTHING
            `, [normalizedEmail, tenantId, schemaName, tenantUserId]);
            
            // Consume the invite token
            await tenantManager.consumeInviteToken(inviteToken);
            
            console.log(`[${getTimestamp()}] ✅ User joined tenant ${tenantId} via invite - Email: ${email}, Role: ${invite.target_role}`);
        }
        // BRANCH: Fractalized multi-tenant signup (no invite needed)
        else {
            // Check if this is the FIRST tenant ever (Genesis Admin #01)
            const tenantCountResult = await pool.query('SELECT COUNT(*) as count FROM core.tenant_catalog');
            const isFirstUser = parseInt(tenantCountResult.rows[0].count) === 0;
            
            // FIRST PRINCIPLES: Genesis admin should NEVER be blocked by rate limits
            // Only apply sybil/rate limit checks for non-genesis signups
            if (!isFirstUser) {
                // Check Sybil attack prevention
                const sybilCheck = await tenantManager.checkSybilRisk(email, req.ip);
                if (!sybilCheck.allowed) {
                    console.log(`[${getTimestamp()}] 🚫 Sybil protection blocked - Email: ${email}, Reason: ${sybilCheck.reason}`);
                    return res.status(429).json({ error: sybilCheck.reason });
                }
                
                // Check rate limits
                const rateLimitEmail = await tenantManager.checkRateLimit('tenant_creation', 'email', email);
                if (!rateLimitEmail.allowed) {
                    return res.status(429).json({ error: rateLimitEmail.reason });
                }
                
                const rateLimitIP = await tenantManager.checkRateLimit('tenant_creation', 'ip', req.ip);
                if (!rateLimitIP.allowed) {
                    return res.status(429).json({ error: rateLimitIP.reason });
                }
            } else {
                console.log(`[${getTimestamp()}] 🌟 Genesis admin signup detected - skipping all rate limits and sybil protection`);
            }
            
            const passwordHash = await bcrypt.hash(password, 10);
            
            // FIRST USER EVER: Dev #01 (Genesis Admin with global access)
            // SUBSEQUENT USERS: Admin #0n (isolated tenant with their own schema)
            const userRole = isFirstUser ? 'dev' : 'admin';
            const isGenesis = isFirstUser;
            
            // Create new fractalized tenant schema (pass placeholder ID since tenant creates the user)
            const tenant = await tenantManager.createTenant(0);  // Placeholder, will be updated
            tenantId = tenant.tenantId;
            const schemaName = `tenant_${tenantId}`;
            
            // Insert user ONLY into tenant-scoped users table (first principles!)
            const tenantUserResult = await pool.query(`
                INSERT INTO ${schemaName}.users (email, password_hash, role, tenant_id, is_genesis_admin)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id, email, role, tenant_id, is_genesis_admin
            `, [normalizedEmail, passwordHash, userRole, tenantId, isGenesis]);
            
            newUser = tenantUserResult.rows[0];
            tenantUserId = newUser.id;
            
            // Map email to tenant in core (for login routing)
            await pool.query(`
                INSERT INTO core.user_email_to_tenant (email, tenant_id, tenant_schema, user_id)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (email) DO NOTHING
            `, [normalizedEmail, tenantId, schemaName, tenantUserId]);
            
            // Record tenant creation for Sybil tracking (non-blocking - don't fail signup if this fails)
            try {
                await tenantManager.recordTenantCreation(email, req.ip);
            } catch (analyticsError) {
                console.error('⚠️ Analytics recording failed (non-critical):', analyticsError.message);
            }
            
            isGenesisAdmin = isGenesis;
            
            if (isGenesis) {
                console.log(`[${getTimestamp()}] 🌟 GENESIS ADMIN #01 created - Email: ${email}, Tenant: ${tenantId}, TenantUser: ${tenantUserId}`);
            } else {
                console.log(`[${getTimestamp()}] ✅ Admin #0${tenantId} created - Email: ${email}, Tenant: ${tenantId}, TenantUser: ${tenantUserId} (Fractalized)`);
            }
        }
        
        // Auto-login after signup
        req.session.userId = newUser.id;
        req.session.userEmail = newUser.email;
        req.session.userRole = newUser.role;
        req.session.tenantId = tenantId;
        
        // Generate JWT tokens with full tenant context (CRITICAL: must include isGenesisAdmin!)
        const adminId = isGenesisAdmin ? '01' : null;
        const accessToken = authService.signAccessToken(
            newUser.id, 
            newUser.email, 
            newUser.role,
            tenantId,
            adminId,
            isGenesisAdmin
        );
        const { token: refreshToken, tokenId } = authService.signRefreshToken(
            newUser.id, 
            newUser.email, 
            newUser.role,
            tenantId,
            adminId,
            isGenesisAdmin
        );
        
        // Store refresh token in tenant schema using tenant-scoped user ID
        const deviceInfo = req.get('user-agent') || 'unknown';
        const tenantUserIdForToken = tenantUserId ||  newUser.id; // Use tenant user ID if available
        await authService.storeRefreshToken(pool, `tenant_${tenantId}`, tenantUserIdForToken, tokenId, deviceInfo, req.ip);
        
        // Save session
        req.session.save(async (err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Session save failed' });
            }
            
            // Create session tracking record
            await createSessionRecord(newUser.id, req.sessionID, req);
            
            // Log signup
            logAudit(pool, req, 'SIGNUP', 'USER', newUser.id.toString(), newUser.email, {
                role: newUser.role,
                is_genesis_admin: isGenesisAdmin,
                tenant_id: tenantId,
                via_invite: !!inviteToken
            });
            
            res.json({
                success: true,
                user: {
                    id: newUser.id,
                    email: newUser.email,
                    role: newUser.role,
                    tenantId: tenantId,
                    isGenesisAdmin
                },
                accessToken,
                refreshToken,
                message: isGenesisAdmin 
                    ? '🌟 Welcome! You are a Genesis Admin with your own isolated database.' 
                    : 'Account created successfully. Welcome to the team!'
            });
        });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: 'Signup failed: ' + error.message });
    }
});

// Google OAuth removed - email/password authentication only

// ===========================
// INVITE MANAGEMENT API
// ===========================

// Create invite token (admin only)
app.post('/api/invites', requireAuth, async (req, res) => {
    try {
        if (req.userRole !== 'admin' && req.userRole !== 'dev') {
            return res.status(403).json({ error: 'Only admins can create invites' });
        }
        
        const { targetRole = 'read-only', expiresInDays = 7, maxUses = 1 } = req.body;
        
        // Validate target role
        if (!['admin', 'read-only', 'write-only'].includes(targetRole)) {
            return res.status(400).json({ error: 'Invalid target role' });
        }
        
        // Use tenant context from requireAuth middleware (already set!)
        if (!req.tenantId) {
            return res.status(400).json({ error: 'User not associated with a tenant' });
        }
        
        const token = await tenantManager.generateInviteToken(
            req.tenantId,
            req.userId,
            targetRole,
            expiresInDays,
            maxUses
        );
        
        logAudit(pool, req, 'CREATE_INVITE', 'INVITE', token, req.userEmail, {
            tenant_id: req.tenantId,
            target_role: targetRole,
            expires_in_days: expiresInDays,
            max_uses: maxUses
        }, req.tenantSchema);
        
        // Generate full invite URL
        const baseUrl = `https://${req.get('host')}`;
        const inviteUrl = `${baseUrl}/signup.html?invite=${token}`;
        
        res.json({ 
            success: true, 
            token,
            inviteUrl,
            expiresInDays,
            maxUses,
            targetRole
        });
    } catch (error) {
        console.error('Create invite error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Validate invite token (public)
app.get('/api/invites/validate/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const validation = await tenantManager.validateInviteToken(token);
        
        if (validation.valid) {
            res.json({
                valid: true,
                targetRole: validation.invite.target_role,
                remainingUses: validation.invite.max_uses - validation.invite.current_uses,
                expiresAt: validation.invite.expires_at
            });
        } else {
            res.json({
                valid: false,
                reason: validation.reason
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// List invites for current tenant (admin only)
app.get('/api/invites', requireAuth, async (req, res) => {
    try {
        if (req.userRole !== 'admin' && req.userRole !== 'dev') {
            return res.status(403).json({ error: 'Only admins can list invites' });
        }
        
        // Use tenant context from requireAuth middleware (already set!)
        if (!req.tenantId) {
            return res.status(400).json({ error: 'User not associated with a tenant' });
        }
        
        const result = await pool.query(`
            SELECT id, token, created_by_user_id, expires_at, max_uses, current_uses, 
                   target_role, status, created_at
            FROM core.invites
            WHERE tenant_id = $1
            ORDER BY created_at DESC
        `, [req.tenantId]);
        
        res.json({ invites: result.rows });
    } catch (error) {
        console.error('List invites error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Revoke invite (admin only)
app.delete('/api/invites/:id', requireAuth, async (req, res) => {
    try {
        if (req.userRole !== 'admin' && req.userRole !== 'dev') {
            return res.status(403).json({ error: 'Only admins can revoke invites' });
        }
        
        const { id } = req.params;
        
        await pool.query(`
            UPDATE core.invites
            SET status = 'revoked'
            WHERE id = $1 AND tenant_id = $2
        `, [id, req.tenantId]);
        
        logAudit(pool, req, 'REVOKE_INVITE', 'INVITE', id, req.userEmail, {
            tenant_id: req.tenantId
        }, req.tenantSchema);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Revoke invite error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Phone OTP auth removed - use email-based auth (/api/auth/register/public, /api/auth/login) for multi-tenant architecture

// Token Refresh - Get new access token using refresh token
app.post('/api/auth/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;
        
        if (!refreshToken) {
            return res.status(401).json({ error: 'Refresh token required' });
        }
        
        // Verify refresh token
        const decoded = authService.verifyToken(refreshToken);
        if (!decoded || decoded.type !== 'refresh') {
            return res.status(401).json({ error: 'Invalid refresh token' });
        }
        
        // Get tenant schema from JWT tenantId
        const tenantSchema = `tenant_${decoded.tenantId}`;
        
        // Check if refresh token is still valid in tenant-scoped database
        const isValid = await authService.isRefreshTokenValid(pool, tenantSchema, decoded.tokenId, decoded.userId);
        if (!isValid) {
            return res.status(401).json({ error: 'Refresh token revoked or expired' });
        }
        
        // Generate new access token with full tenant context
        const accessToken = authService.signAccessToken(
            decoded.userId, 
            decoded.email, 
            decoded.role,
            decoded.tenantId,
            decoded.adminId,
            decoded.isGenesisAdmin
        );
        
        res.json({ 
            success: true,
            accessToken,
            tokenExpiry: authService.ACCESS_TOKEN_EXPIRY
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Logout (requires authentication)
app.post('/api/auth/logout', requireAuth, async (req, res) => {
    const userId = req.userId;
    const sessionId = req.sessionID;
    const tenantSchema = req.tenantSchema || `tenant_${req.tenantId}`;
    
    console.log(`🔓 Logout request from user ${userId}, session ${sessionId}, tenant ${tenantSchema}`);
    
    try {
        // Step 1: Revoke all refresh tokens for this user (non-fatal if table missing)
        if (userId && tenantSchema) {
            try {
                console.log(`🔐 Revoking tokens for user ${userId} in ${tenantSchema}...`);
                await authService.revokeAllUserTokens(pool, tenantSchema, userId);
                console.log(`✅ Tokens revoked`);
            } catch (tokenError) {
                console.warn(`⚠️ Token revocation failed (non-fatal):`, tokenError.message);
                // Continue logout even if token revocation fails
            }
            
            // Step 2: Mark session as inactive in tenant active_sessions (non-fatal if table missing)
            if (sessionId) {
                try {
                    console.log(`📋 Marking session ${sessionId} as inactive in ${tenantSchema}.active_sessions...`);
                    await pool.query(`
                        UPDATE ${tenantSchema}.active_sessions 
                        SET is_active = FALSE
                        WHERE user_id = $1 AND session_id = $2
                    `, [userId, sessionId]);
                    console.log(`✅ Session marked inactive`);
                } catch (sessionError) {
                    console.warn(`⚠️ Session marking failed (non-fatal):`, sessionError.message);
                    // Continue logout even if session marking fails
                }
            }
        }
        
        // Step 3: Destroy PostgreSQL session (connect-pg-simple store)
        // NON-BLOCKING: Don't fail logout if session destroy times out
        console.log(`💣 Destroying PostgreSQL session ${sessionId}...`);
        try {
            await Promise.race([
                new Promise((resolve, reject) => {
                    if (!req.session) {
                        console.log(`⚠️ No session object found on request`);
                        return resolve();
                    }
                    
                    req.session.destroy((err) => {
                        if (err) {
                            console.error('❌ Session destroy error:', err.message);
                            reject(err);
                        } else {
                            console.log(`✅ PostgreSQL session destroyed`);
                            resolve();
                        }
                    });
                }),
                // Timeout after 5 seconds - don't block logout
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Session destroy timeout')), 5000)
                )
            ]);
        } catch (destroyError) {
            console.warn(`⚠️ Session destroy failed (non-fatal, will be pruned later):`, destroyError.message);
            // Continue - session will be cleaned up by pruneSessionInterval
        }
        
        // Step 4: Clear session cookie
        console.log(`🍪 Clearing book.sid cookie...`);
        res.clearCookie('book.sid', {
            path: '/',
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'none',
            partitioned: true
        });
        console.log(`✅ Cookie cleared`);
        
        // Step 5: Log logout audit (capture context before session destroyed)
        try {
            await logAudit(pool, req, 'LOGOUT', 'USER', userId?.toString() || 'unknown', null, {});
            console.log(`✅ Audit logged`);
        } catch (auditError) {
            console.error('⚠️ Audit logging failed (non-fatal):', auditError);
        }
        
        console.log('✅ User logged out successfully');
        
        // Send success response
        res.json({ success: true });
    } catch (error) {
        console.error('❌ LOGOUT ERROR:', error);
        console.error('Stack:', error.stack);
        res.status(500).json({ error: error.message });
    }
});

// ============ TWILIO WEBHOOK ROUTES ============

// Twilio WhatsApp webhook - JOIN-CODE-FIRST ROUTING
app.post('/api/twilio/webhook', async (req, res) => {
    try {
        const { From, Body, MessageSid, MediaUrl0, MediaContentType0 } = req.body;
        // E.164 NORMALIZATION: Keep + prefix for global compatibility
        // Twilio format: "whatsapp:+6281234567890" → "+6281234567890"
        const phone = From.replace('whatsapp:', '').trim();
        
        console.log(`📱 Twilio webhook: From=${From}, Phone=${phone} (E.164), Body=${Body?.substring(0, 50)}...`);
        
        const bodyText = Body?.trim() || '';
        const bodyLower = bodyText.toLowerCase();
        
        // STEP 1: Ignore Twilio sandbox join command
        if (bodyLower === 'join baby-ability') {
            console.log(`⏭️  Ignoring Twilio sandbox join command`);
            return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
        }
        
        // STEP 2: HYBRID ROUTING - Extract join code using regex
        // Format: bookname-abc123 (6 hex chars)
        const joinCodeMatch = bodyText.match(/([a-z0-9]+)-([a-f0-9]{6})/i);
        const joinCode = joinCodeMatch ? joinCodeMatch[0] : null;
        console.log(`🔍 Extracted join code: ${joinCode || 'none'} (from body: "${bodyText.substring(0, 100)}")`);
        
        // STEP 3: JOIN-CODE-FIRST ROUTING - Join code supersedes phone lookup
        let bookRecord = null;
        let routingMethod = 'unknown';
        
        if (joinCode) {
            // Message contains join code → ONLY use join code (no phone fallback)
            console.log(`🔑 Join code provided: ${joinCode} → Checking registry (NO phone fallback)`);
            const registryLookup = await pool.query(`
                SELECT id, tenant_schema, tenant_email, fractal_id, book_name, join_code,
                       outpipe_ledger, outpipes_user, status, phone_number, creator_phone
                FROM core.book_registry
                WHERE LOWER(join_code) = LOWER($1)
            `, [joinCode]);
            
            console.log(`🔍 Registry lookup result: ${registryLookup.rows.length} rows for join_code="${joinCode}"`);
            if (registryLookup.rows.length > 0) {
                bookRecord = registryLookup.rows[0];
                routingMethod = 'join_code';
                console.log(`✅ Found via join code: fractal_id=${bookRecord.fractal_id}, book_name="${bookRecord.book_name}", stored_join_code="${bookRecord.join_code}" (status: ${bookRecord.status})`);
            } else {
                console.log(`❌ Join code "${joinCode}" not found in registry → Routing to limbo (no phone fallback)`);
            }
        } else {
            // No join code in message → Use phone lookup via book_engaged_phones (multi-source support)
            console.log(`📞 No join code in message → Using engaged phones lookup for active books`);
            const phoneLookup = await pool.query(`
                SELECT br.id, br.tenant_schema, br.tenant_email, br.fractal_id, br.book_name, br.join_code,
                       br.outpipe_ledger, br.outpipes_user, br.status, br.phone_number, br.creator_phone, br.updated_at,
                       ep.last_engaged_at
                FROM core.book_engaged_phones ep
                JOIN core.book_registry br ON br.id = ep.book_registry_id
                WHERE ep.phone = $1 AND br.status = 'active'
                ORDER BY ep.last_engaged_at DESC
                LIMIT 1
            `, [phone]);
            
            console.log(`🔍 Phone lookup result: ${phoneLookup.rows.length} rows for phone="${phone}"`);
            if (phoneLookup.rows.length > 0) {
                bookRecord = phoneLookup.rows[0];
                routingMethod = 'phone';
                console.log(`✅ Found via phone: fractal_id=${bookRecord.fractal_id}, book_name="${bookRecord.book_name}", join_code="${bookRecord.join_code}", last_engaged: ${bookRecord.last_engaged_at}`);
            } else {
                console.log(`❌ No active book found for phone ${phone} → Routing to limbo`);
            }
        }
        
        // ROUTING DECISION LOG
        if (bookRecord) {
            console.log(`🚀 ROUTING DECISION: method=${routingMethod}, target_book="${bookRecord.book_name}" (${bookRecord.fractal_id}), join_code="${bookRecord.join_code}"`);
        }
        
        if (!bookRecord) {
            // CASE C: No book found via join code OR phone → LIMBO
            console.log(`❌ No book found for join code: "${joinCode}" → Routing to limbo`);
            
            // LIMBO ROUTING: Forward all messages without valid join code to t1-b1 Ledger thread
            const LIMBO_THREAD_ID = '1433850939751534672';
            
            // Build Discord payload
            const limboPayload = {
                embeds: [{
                    title: `🔮 Limbo Message (No Join Code)`,
                    description: Body || '_(No text content)_',
                    color: 0xFF6B6B, // Red for limbo messages
                    fields: [
                        { name: '📱 Phone', value: phone, inline: true },
                        { name: '🕐 Time', value: new Date().toLocaleString(), inline: true },
                        { name: '🔓 Status', value: 'No valid join code found', inline: false },
                        { name: '📝 Message', value: `\`${(Body || '').substring(0, 100)}\``, inline: false }
                    ],
                    timestamp: new Date().toISOString(),
                    footer: { text: 'User needs to send a valid join code (e.g., "bookname-abc123")' }
                }]
            };
            
            // DISCORD-NATIVE: Download and attach media for limbo messages
            let limboMediaBuffer = null;
            let limboMediaFilename = null;
            let limboMediaContentType = null;
            
            if (MediaUrl0) {
                try {
                    console.log(`📥 [Limbo] Downloading media from Twilio (no auth)...`);
                    const mediaResponse = await axios.get(MediaUrl0, { 
                        responseType: 'arraybuffer',
                        timeout: 30000
                    });
                    limboMediaBuffer = Buffer.from(mediaResponse.data);
                    limboMediaContentType = MediaContentType0 || mediaResponse.headers['content-type'] || 'application/octet-stream';
                    
                    // Map MIME types to proper file extensions
                    const mimeToExt = {
                        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
                        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
                        'application/pdf': 'pdf',
                        'image/jpeg': 'jpg',
                        'image/png': 'png',
                        'image/gif': 'gif',
                        'image/webp': 'webp',
                        'video/mp4': 'mp4',
                        'video/quicktime': 'mov',
                        'audio/mpeg': 'mp3',
                        'audio/ogg': 'ogg',
                        'audio/opus': 'opus',
                        'application/zip': 'zip',
                        'text/plain': 'txt'
                    };
                    const ext = mimeToExt[limboMediaContentType] || limboMediaContentType.split('/')[1]?.split(';')[0] || 'bin';
                    limboMediaFilename = `limbo_media_${Date.now()}.${ext}`;
                    
                    console.log(`✅ [Limbo] Downloaded ${limboMediaBuffer.length} bytes`);
                    
                    limboPayload.embeds[0].fields.push({ 
                        name: '📎 Media', 
                        value: `${limboMediaContentType} (${(limboMediaBuffer.length / 1024).toFixed(1)} KB)`,
                        inline: false 
                    });
                } catch (downloadError) {
                    console.error(`❌ [Limbo] Failed to download media:`, downloadError.message);
                    console.error(`   Status: ${downloadError.response?.status}, URL: ${MediaUrl0.substring(0, 60)}`);
                    limboPayload.embeds[0].fields.push({ 
                        name: '⚠️ Media (download failed)', 
                        value: `[${MediaContentType0 || 'attachment'}](${MediaUrl0})`,
                        inline: false 
                    });
                }
            }
            
            // Create minimal book object for sendToLedger
            const limboBook = {
                output_01_url: NYANBOOK_LEDGER_WEBHOOK
            };
            
            // Send to t1-b1 Ledger using proper pipeline
            const limboOptions = {
                output: {
                    type: 'thread',
                    thread_id: LIMBO_THREAD_ID
                },
                // DISCORD-NATIVE: Pass media buffer if downloaded
                mediaBuffer: limboMediaBuffer,
                mediaFilename: limboMediaFilename,
                mediaContentType: limboMediaContentType
            };
            
            try {
                await sendToLedger(limboPayload, limboOptions, limboBook);
                console.log(`✅ Limbo message forwarded to t1-b1 thread from ${phone}`);
            } catch (discordError) {
                console.error(`❌ Failed to forward limbo message to t1-b1:`, discordError.message);
                console.error(`⚠️  CRITICAL: Limbo message delivery failed - phone ${phone} message lost!`);
            }
            
            // Send help message to user
            try {
                const twilioHelper = require('./twilio-client');
                const twilioClient = await twilioHelper.getTwilioClient();
                const twilioNumber = await twilioHelper.getTwilioFromPhoneNumber();
                
                await twilioClient.messages.create({
                    from: `whatsapp:${twilioNumber}`,
                    to: From,
                    body: `👋 Welcome to Nyanbook! To activate your book, send your join code (format: bookname-abc123).\n\nCreate a book at: ${process.env.REPLIT_DOMAINS?.split(',')[0] || 'your dashboard'}`
                });
                console.log(`📤 Help message sent to ${phone}`);
            } catch (twilioError) {
                console.warn(`⚠️ Could not send help message (non-fatal):`, twilioError.message);
            }
            
            return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
        }
        
        // Book found in registry - extract tenant schema
        const tenantSchema = bookRecord.tenant_schema;
        
        console.log(`✅ Found book ${bookRecord.fractal_id} in registry: status=${bookRecord.status}, tenant=${tenantSchema}`);
        
        if (bookRecord.status === 'pending') {
            // CASE A: Book found with status='pending' → ACTIVATE
            console.log(`🔓 Activating pending book ${bookRecord.fractal_id} for phone ${phone}`);
            
            // Get book_id from tenant's books table (NOT phone_to_book)
            const bookIdResult = await pool.query(`
                SELECT id FROM ${tenantSchema}.books 
                WHERE fractal_id = $1
                LIMIT 1
            `, [bookRecord.fractal_id]);
            
            if (bookIdResult.rows.length === 0) {
                console.error(`❌ Book ${bookRecord.fractal_id} not found in ${tenantSchema}.books`);
                return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
            }
            
            const bookId = bookIdResult.rows[0].id;
            
            // Update registry (activate and set phone)
            // CRITICAL: Update updated_at to track most recent activation for routing
            // CREATOR TRACKING: First activator becomes the creator_phone
            await pool.query(`
                UPDATE core.book_registry 
                SET phone_number = $1, creator_phone = $1, status = 'active', activated_at = NOW(), updated_at = NOW()
                WHERE id = $2
            `, [phone, bookRecord.id]);
            
            // Update book status in tenant schema
            await pool.query(`
                UPDATE ${tenantSchema}.books 
                SET status = 'active'
                WHERE id = $1
            `, [bookId]);
            
            console.log(`🔗 Activated book ${bookRecord.fractal_id} (book_id: ${bookId}) for phone ${phone}`);
            
            // MULTI-SOURCE: Add creator to engaged phones (is_creator = true)
            await pool.query(`
                INSERT INTO core.book_engaged_phones (book_registry_id, phone, is_creator, first_engaged_at, last_engaged_at)
                VALUES ($1, $2, TRUE, NOW(), NOW())
                ON CONFLICT (book_registry_id, phone) DO UPDATE 
                SET last_engaged_at = NOW(), is_creator = TRUE
            `, [bookRecord.id, phone]);
            console.log(`📱 Added ${phone} as creator to engaged phones for book ${bookRecord.fractal_id}`);
            
            // HERMES: Create Discord thread now that book is activated
            if (hermesBot && hermesBot.isReady()) {
                try {
                    const tenantIdMatch = tenantSchema.match(/tenant_(\d+)/);
                    const tenantId = tenantIdMatch ? parseInt(tenantIdMatch[1]) : 0;
                    
                    console.log(`🧵 Hermes creating dual outputs for: ${bookRecord.book_name} (t${tenantId}-b${bookId})`);
                    const dualThreads = await hermesBot.createDualThreadsForBook(
                        bookRecord.outpipe_ledger,
                        null,
                        bookRecord.book_name,
                        tenantId,
                        bookId
                    );
                    
                    // Update book with thread info
                    await pool.query(`
                        UPDATE ${tenantSchema}.books 
                        SET output_credentials = jsonb_set(
                            COALESCE(output_credentials, '{}'::jsonb),
                            '{output_01}',
                            $1::jsonb
                        )
                        WHERE id = $2
                    `, [JSON.stringify(dualThreads.output_01), bookId]);
                    
                    // Send activation confirmation to Ledger thread
                    const activationEmbed = {
                        embeds: [{
                            title: `🎉 Book Activated`,
                            description: `Join code: \`${joinCode}\``,
                            color: 0x00FF00,
                            fields: [
                                { name: '📱 Phone', value: phone, inline: true },
                                { name: '📖 Book', value: bookRecord.book_name, inline: true },
                                { name: '🔗 Fractal ID', value: bookRecord.fractal_id, inline: false }
                            ],
                            timestamp: new Date().toISOString()
                        }]
                    };
                    
                    const activationOptions = {
                        output: dualThreads.output_01
                    };
                    
                    const minimalBook = {
                        output_01_url: bookRecord.outpipe_ledger
                    };
                    
                    await sendToLedger(activationEmbed, activationOptions, minimalBook);
                    console.log(`✅ Hermes thread created: ${dualThreads.output_01?.thread_id}`);
                } catch (hermesError) {
                    console.error(`❌ Failed to create Hermes thread:`, hermesError.message);
                }
            }
            
            // Send confirmation message to user
            try {
                const twilioHelper = require('./twilio-client');
                const twilioClient = await twilioHelper.getTwilioClient();
                const twilioNumber = await twilioHelper.getTwilioFromPhoneNumber();
                
                await twilioClient.messages.create({
                    from: `whatsapp:${twilioNumber}`,
                    to: From,
                    body: `✅ Book activated! Your messages will now be saved to "${bookRecord.book_name}". Send anything to test it out! 🌈`
                });
            } catch (twilioError) {
                console.warn(`⚠️ Could not send confirmation (non-fatal):`, twilioError.message);
            }
            
            return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
            
        } else if (bookRecord.status === 'active') {
            // CASE B: Book found with status='active' → FORWARD MESSAGE
            console.log(`📨 Forwarding message to active book ${bookRecord.fractal_id}`);
            
            // Get full book details from tenant schema
            const bookDetailsResult = await pool.query(`
                SELECT id, name, fractal_id, output_credentials 
                FROM ${tenantSchema}.books 
                WHERE fractal_id = $1
                LIMIT 1
            `, [bookRecord.fractal_id]);
            
            if (bookDetailsResult.rows.length === 0) {
                console.error(`❌ Book ${bookRecord.fractal_id} not found in ${tenantSchema}.books`);
                return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
            }
            
            const book = bookDetailsResult.rows[0];
            
            // MULTI-SOURCE: Track sender engagement with this book (contributor or creator)
            try {
                console.log(`📱 [ENGAGE] Updating engagement: book_registry_id=${bookRecord.id}, phone=${phone}, book=${bookRecord.fractal_id}`);
                const engageResult = await pool.query(`
                    INSERT INTO core.book_engaged_phones (book_registry_id, phone, is_creator, first_engaged_at, last_engaged_at)
                    VALUES ($1, $2, FALSE, NOW(), NOW())
                    ON CONFLICT (book_registry_id, phone) DO UPDATE 
                    SET last_engaged_at = NOW()
                    RETURNING id, last_engaged_at
                `, [bookRecord.id, phone]);
                console.log(`📱 [ENGAGE] Tracked ${phone} engagement with book ${bookRecord.fractal_id}, result: ${JSON.stringify(engageResult.rows[0])}`);
                
                // VERIFICATION: Check what books this phone is now engaged with
                const verifyResult = await pool.query(`
                    SELECT br.fractal_id, br.book_name, ep.last_engaged_at, ep.is_creator
                    FROM core.book_engaged_phones ep
                    JOIN core.book_registry br ON br.id = ep.book_registry_id
                    WHERE ep.phone = $1 AND br.status = 'active'
                    ORDER BY ep.last_engaged_at DESC
                    LIMIT 3
                `, [phone]);
                console.log(`📱 [VERIFY] Phone ${phone} engaged books (top 3): ${JSON.stringify(verifyResult.rows)}`);
            } catch (engageErr) {
                console.error(`❌ [ENGAGE] Could not track engagement:`, engageErr.message, engageErr.stack);
            }
            
            const outputCreds = book.output_credentials || {};
            const output01 = outputCreds.output_01;
            const webhooks = outputCreds.webhooks || [];
            
            // Determine if sender is the book creator
            // FALLBACK: If creator_phone is NULL (pre-migration books), treat phone_number as creator
            const isCreator = (bookRecord.creator_phone && phone === bookRecord.creator_phone) ||
                              (!bookRecord.creator_phone && phone === bookRecord.phone_number);
            const senderRole = isCreator ? '🌟' : '👥';
            
            // Build Discord embed
            const embed = {
                description: Body || '_(No text content)_',
                color: isCreator ? 0x25D366 : 0x7289DA, // WhatsApp green for creator, Discord blue for contributor
                fields: [
                    { name: '📱 Phone', value: phone, inline: true },
                    { name: '📖 Book', value: book.name, inline: true },
                    { name: '🕐 Time', value: new Date().toLocaleString(), inline: true }
                ],
                timestamp: new Date().toISOString()
            };
            
            // DISCORD-NATIVE: Download media from Twilio MediaUrl
            let mediaBuffer = null;
            let mediaFilename = null;
            let mediaContentType = null;
            
            if (MediaUrl0) {
                try {
                    console.log(`📥 Downloading media from Twilio (no auth): ${MediaUrl0.substring(0, 80)}...`);
                    const mediaResponse = await axios.get(MediaUrl0, { 
                        responseType: 'arraybuffer',
                        timeout: 30000
                    });
                    mediaBuffer = Buffer.from(mediaResponse.data);
                    mediaContentType = MediaContentType0 || mediaResponse.headers['content-type'] || 'application/octet-stream';
                    
                    // Map MIME types to proper file extensions
                    const mimeToExt = {
                        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
                        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
                        'application/pdf': 'pdf',
                        'image/jpeg': 'jpg',
                        'image/png': 'png',
                        'image/gif': 'gif',
                        'image/webp': 'webp',
                        'video/mp4': 'mp4',
                        'video/quicktime': 'mov',
                        'audio/mpeg': 'mp3',
                        'audio/ogg': 'ogg',
                        'audio/opus': 'opus',
                        'application/zip': 'zip',
                        'text/plain': 'txt'
                    };
                    const ext = mimeToExt[mediaContentType] || mediaContentType.split('/')[1]?.split(';')[0] || 'bin';
                    mediaFilename = `media_${Date.now()}.${ext}`;
                    
                    console.log(`✅ Downloaded ${mediaBuffer.length} bytes (${mediaContentType})`);
                    
                    // Add metadata embed field
                    embed.fields.push({ 
                        name: '📎 Media', 
                        value: `${mediaContentType} (${(mediaBuffer.length / 1024).toFixed(1)} KB)`,
                        inline: false 
                    });
                } catch (downloadError) {
                    console.error(`❌ Failed to download media:`, downloadError.message);
                    console.error(`   Status: ${downloadError.response?.status}, URL: ${MediaUrl0.substring(0, 60)}`);
                    embed.fields.push({ 
                        name: '⚠️ Media (download failed)', 
                        value: `[${MediaContentType0 || 'attachment'}](${MediaUrl0})`,
                        inline: false 
                    });
                }
            }
            
            // Send to Ledger thread (output_01) with attachment
            if (output01?.type === 'thread' && output01?.thread_id) {
                try {
                    if (mediaBuffer) {
                        const FormData = require('form-data');
                        const form = new FormData();
                        form.append('files[0]', mediaBuffer, {
                            filename: mediaFilename,
                            contentType: mediaContentType
                        });
                        form.append('payload_json', JSON.stringify({ embeds: [embed] }));
                        
                        await axios.post(`https://discord.com/api/v10/channels/${output01.thread_id}/messages`, form, {
                            headers: {
                                'Authorization': `Bot ${process.env.HERMES_TOKEN}`,
                                ...form.getHeaders()
                            }
                        });
                        console.log(`✅ Sent to Ledger thread ${output01.thread_id} with ${mediaFilename}`);
                    } else {
                        await axios.post(`https://discord.com/api/v10/channels/${output01.thread_id}/messages`, {
                            embeds: [embed]
                        }, {
                            headers: {
                                'Authorization': `Bot ${process.env.HERMES_TOKEN}`,
                                'Content-Type': 'application/json'
                            }
                        });
                        console.log(`✅ Sent to Ledger thread ${output01.thread_id}`);
                    }
                } catch (error) {
                    console.error(`❌ Failed to send to Ledger:`, error.message);
                }
            }
            
            // Send to user webhooks (output_0n) with attachment
            for (const webhook of webhooks) {
                try {
                    if (mediaBuffer) {
                        const FormData = require('form-data');
                        const form = new FormData();
                        form.append('files[0]', mediaBuffer, {
                            filename: mediaFilename,
                            contentType: mediaContentType
                        });
                        form.append('payload_json', JSON.stringify({ embeds: [embed] }));
                        
                        await axios.post(webhook.url, form, {
                            headers: form.getHeaders()
                        });
                        console.log(`✅ Sent to webhook ${webhook.name || 'Personal'} with ${mediaFilename}`);
                    } else {
                        await axios.post(webhook.url, {
                            embeds: [embed]
                        });
                        console.log(`✅ Sent to webhook ${webhook.name || 'Personal'}`);
                    }
                } catch (error) {
                    console.error(`❌ Failed to send to webhook ${webhook.name || 'Personal'}:`, error.message);
                }
            }
            
            return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
            
        } else {
            // Unknown status - log and ignore
            console.warn(`⚠️  Unknown book status: ${bookRecord.status} for ${bookRecord.fractal_id}`);
            return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
        }
        
    } catch (error) {
        console.error('❌ Twilio webhook error:', error);
        console.error('Stack:', error.stack);
        res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
});

// ============ SESSION MANAGEMENT ROUTES ============

// Get all active sessions (admin only) with filtering and sorting
app.get('/api/sessions', requireRole('admin'), async (req, res) => {
    try {
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const { userId, sortBy = 'login_time', sortOrder = 'desc', filterDevice, filterBrowser, filterLocation } = req.query;
        
        let query = `
            SELECT 
                s.id, s.user_id, s.session_id, s.ip_address, s.user_agent,
                s.device_type, s.browser, s.os, s.location, s.login_time, s.last_activity,
                s.is_active,
                u.email, u.phone
            FROM ${tenantSchema}.active_sessions s
            LEFT JOIN ${tenantSchema}.users u ON s.user_id = u.id
            WHERE 1=1
        `;
        const params = [];
        let paramCount = 1;
        
        // Filter by user ID
        if (userId) {
            query += ` AND s.user_id = $${paramCount}`;
            params.push(userId);
            paramCount++;
        }
        
        // Filter by device type
        if (filterDevice) {
            query += ` AND s.device_type = $${paramCount}`;
            params.push(filterDevice);
            paramCount++;
        }
        
        // Filter by browser
        if (filterBrowser) {
            query += ` AND s.browser = $${paramCount}`;
            params.push(filterBrowser);
            paramCount++;
        }
        
        // Filter by location (partial match)
        if (filterLocation) {
            query += ` AND s.location ILIKE $${paramCount}`;
            params.push(`%${filterLocation}%`);
            paramCount++;
        }
        
        // Add sorting
        const validColumns = ['login_time', 'last_activity', 'device_type', 'browser', 'ip_address', 'location'];
        const sortColumn = validColumns.includes(sortBy) ? sortBy : 'login_time';
        const order = sortOrder === 'asc' ? 'ASC' : 'DESC';
        query += ` ORDER BY s.${sortColumn} ${order}`;
        
        const result = await pool.query(query, params);
        
        res.json({ sessions: result.rows });
    } catch (error) {
        console.error('Error fetching sessions:', error);
        res.status(500).json({ error: error.message });
    }
});

// Revoke a specific session (admin only)
app.delete('/api/sessions/:id', requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const tenantSchema = req.tenantSchema;
        
        // Get session details before deletion for audit log
        const sessionResult = await pool.query(`
            SELECT user_id, session_id FROM ${tenantSchema}.active_sessions WHERE id = $1
        `, [id]);
        
        if (sessionResult.rows.length === 0) {
            return res.status(404).json({ error: 'Session not found' });
        }
        
        const session = sessionResult.rows[0];
        
        // Mark session as inactive
        await pool.query(`
            UPDATE ${tenantSchema}.active_sessions SET is_active = FALSE WHERE id = $1
        `, [id]);
        
        // Destroy the actual session from sessions table (public schema)
        await pool.query(`
            DELETE FROM sessions WHERE sid = $1
        `, [session.session_id]);
        
        // Log session revocation
        await logAudit(pool, req, 'REVOKE_SESSION', 'SESSION', id.toString(), null, {
            target_user_id: session.user_id,
            session_id: session.session_id
        });
        
        res.json({ success: true, message: 'Session revoked' });
    } catch (error) {
        console.error('Error revoking session:', error);
        res.status(500).json({ error: error.message });
    }
});

// Revoke all sessions for current user or all users (admin only)
app.post('/api/sessions/revoke-all', requireRole('admin'), async (req, res) => {
    try {
        const { userId } = req.body; // Optional: revoke all for specific user
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        
        let sessionQuery;
        let params = [];
        
        if (userId) {
            // Revoke all sessions for specific user
            sessionQuery = `SELECT session_id FROM ${tenantSchema}.active_sessions WHERE user_id = $1`;
            params = [userId];
        } else {
            // Revoke ALL sessions for ALL users (except current session)
            sessionQuery = `SELECT session_id FROM ${tenantSchema}.active_sessions WHERE session_id != $1`;
            params = [req.sessionID];
        }
        
        const sessionsResult = await pool.query(sessionQuery, params);
        const sessionIds = sessionsResult.rows.map(row => row.session_id);
        
        if (sessionIds.length === 0) {
            return res.json({ success: true, message: 'No sessions to revoke', count: 0 });
        }
        
        // Mark all as inactive
        if (userId) {
            await pool.query(`
                UPDATE ${tenantSchema}.active_sessions SET is_active = FALSE WHERE user_id = $1
            `, [userId]);
        } else {
            await pool.query(`
                UPDATE ${tenantSchema}.active_sessions SET is_active = FALSE WHERE session_id != $1
            `, [req.sessionID]);
        }
        
        // Destroy all sessions from sessions table
        for (const sessionId of sessionIds) {
            await pool.query('DELETE FROM sessions WHERE sid = $1', [sessionId]);
        }
        
        // Log mass revocation
        await logAudit(pool, req, 'REVOKE_ALL_SESSIONS', 'SESSION', userId || 'all', null, {
            count: sessionIds.length,
            target_user_id: userId || 'all'
        });
        
        res.json({ 
            success: true, 
            message: `${sessionIds.length} session(s) revoked`,
            count: sessionIds.length
        });
    } catch (error) {
        console.error('Error revoking all sessions:', error);
        res.status(500).json({ error: error.message });
    }
});

// Public registration (no auth required) - Multi-tenant architecture
app.post('/api/auth/register/public', async (req, res) => {
    noCacheHeaders(res);
    
    const { email, password } = req.body;
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    
    try {
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        
        // Normalize email to lowercase for case-insensitive uniqueness
        const normalizedEmail = email.toLowerCase().trim();
        
        // CRITICAL: Email uniqueness gatefencing - check BEFORE any writes
        // Read-Check-Bounce pattern to enforce one email = one tenant globally
        const emailCheck = await pool.query(
            'SELECT tenant_id FROM core.user_email_to_tenant WHERE LOWER(email) = $1',
            [normalizedEmail]
        );
        if (emailCheck.rows.length > 0) {
            console.log(`[${getTimestamp()}] 🚫 Signup blocked (PUBLIC) - Email already exists in tenant ${emailCheck.rows[0].tenant_id}`);
            return res.status(409).json({ error: 'Email already registered' });
        }

        // Check if this is the first user (Genesis Admin) BEFORE rate limits
        const tenantCountResult = await pool.query('SELECT COUNT(*) as count FROM core.tenant_catalog');
        const isFirstUser = parseInt(tenantCountResult.rows[0].count) === 0;
        const isGenesisAdmin = isFirstUser;

        // FIRST PRINCIPLES: Genesis admin should NEVER be blocked by rate limits or sybil protection
        if (!isFirstUser) {
            // Rate limit check for non-genesis signups
            const rateLimitCheck = await tenantManager.checkRateLimit('signup', 'email', email);
            if (!rateLimitCheck.allowed) {
                return res.status(429).json({ error: rateLimitCheck.reason });
            }

            // Sybil protection check for non-genesis signups
            const sybilCheck = await tenantManager.checkSybilRisk(email, ip);
            if (!sybilCheck.allowed) {
                return res.status(403).json({ error: sybilCheck.reason });
            }
        } else {
            console.log(`[${getTimestamp()}] 🌟 Genesis admin signup (PUBLIC) detected - skipping all rate limits and sybil protection`);
        }
        
        // Hash password
        const passwordHash = await bcrypt.hash(password, 12);

        // Create tenant + schema (which creates tenant_X.users table)
        const tempGenesisId = 0; // Placeholder ID (will be replaced after user creation)
        const { tenantId, schemaName } = await tenantManager.createTenant(tempGenesisId);

        // Insert genesis user into tenant_X.users
        const userResult = await pool.query(`
            INSERT INTO ${schemaName}.users (email, password_hash, role, tenant_id, is_genesis_admin)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, email, role, tenant_id, is_genesis_admin
        `, [normalizedEmail, passwordHash, isGenesisAdmin ? 'dev' : 'admin', tenantId, isGenesisAdmin]);

        const newUser = userResult.rows[0];

        // Insert email → tenant mapping for fast login lookups
        await pool.query(`
            INSERT INTO core.user_email_to_tenant (email, tenant_id, tenant_schema, user_id)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (email) DO NOTHING
        `, [normalizedEmail, tenantId, schemaName, newUser.id]);

        // Generate JWT tokens
        const accessToken = authService.signAccessToken(
            newUser.id, 
            newUser.email, 
            newUser.role,
            newUser.tenant_id,
            isGenesisAdmin ? '01' : null,
            newUser.is_genesis_admin
        );
        
        const refreshTokenData = authService.signRefreshToken(
            newUser.id, 
            newUser.email, 
            newUser.role,
            newUser.tenant_id,
            isGenesisAdmin ? '01' : null,
            newUser.is_genesis_admin
        );
        const refreshToken = refreshTokenData.token;

        // Record tenant creation for analytics (non-blocking - don't fail signup if this fails)
        try {
            await tenantManager.recordTenantCreation(email, ip);
        } catch (analyticsError) {
            console.error('⚠️ Analytics recording failed (non-critical):', analyticsError.message);
        }

        console.log(`${isGenesisAdmin ? '🌟 GENESIS ADMIN' : '👤 New admin'} created: ${email} (tenant_${tenantId})`);

        res.json({ 
            success: true, 
            user: {
                id: newUser.id,
                email: newUser.email,
                role: newUser.role,
                tenant_id: newUser.tenant_id,
                is_genesis_admin: newUser.is_genesis_admin
            },
            accessToken,
            refreshToken,
            message: isGenesisAdmin ? 'Genesis Admin created!' : 'Account created successfully!'
        });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Email already registered' });
        } else {
            console.error('❌ Registration error:', error);
            return res.status(500).json({ error: error.message || 'Internal server error' });
        }
    }
});


// ===========================
// DEV PANEL API (Admin Role Only)
// ===========================

// Get global Discord webhook (admin only)
app.get('/api/dev/webhook', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const webhook = getGlobalWebhook();
        res.json({ webhook_url: webhook || '' });
    } catch (error) {
        console.error('❌ Error fetching global webhook:', error);
        res.status(500).json({ error: error.message });
    }
});

// Set global Discord webhook (admin only)
app.post('/api/dev/webhook', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const { webhook_url } = req.body;
        
        // Validate webhook URL
        if (!webhook_url || !webhook_url.trim()) {
            return res.status(400).send('Webhook URL is required');
        }
        
        if (!webhook_url.includes('discord.com/api/webhooks')) {
            return res.status(400).send('Invalid Discord webhook URL');
        }
        
        // Save webhook
        const success = await saveGlobalWebhook(webhook_url.trim());
        
        if (success) {
            // Log admin action
            await pool.query(`
                INSERT INTO ${tenantSchema}.audit_logs (actor, action, target, details, ip_address)
                VALUES ($1, $2, $3, $4, $5)
            `, [
                req.userEmail || `user_${req.userId}`,
                'GLOBAL_WEBHOOK_UPDATE',
                'system',
                JSON.stringify({ webhook_preview: webhook_url.substring(0, 50) + '...' }),
                req.ip || req.connection?.remoteAddress || 'unknown'
            ]);
            
            res.send('OK');
        } else {
            res.status(500).send('Failed to save webhook');
        }
    } catch (error) {
        console.error('❌ Error saving global webhook:', error);
        res.status(500).send(error.message);
    }
});

// Get all books across all tenants (dev role only)
app.get('/api/dev/books', requireAuth, requireRole('dev'), async (req, res) => {
    try {
        // Use tenant schema from requireAuth middleware
        const tenantSchema = req.tenantSchema;
        
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // SECURITY CHECK: Dev Panel requires dev + genesis_admin
        const userResult = await pool.query(
            `SELECT role, is_genesis_admin, tenant_id FROM ${tenantSchema}.users WHERE id = $1`,
            [req.userId]
        );
        
        if (!userResult.rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userResult.rows[0];
        
        // Enforce security check: dev role + genesis_admin flag
        if (user.role !== 'dev' || !user.is_genesis_admin) {
            console.warn(`⚠️  SECURITY: User ${req.userId} attempted Dev Panel access without proper credentials`);
            console.warn(`   - Role: ${user.role} (needs: dev)`);
            console.warn(`   - Genesis Admin: ${user.is_genesis_admin} (needs: true)`);
            return res.status(403).json({ 
                error: 'Access denied. Dev Panel requires dev role + genesis_admin status.' 
            });
        }
        
        console.log('🔧 Dev Panel: Triple security check passed. Fetching all books across all tenants...');
        
        // MULTI-TENANT FIX: Find all tenants via core.user_email_to_tenant, then check each tenant schema
        const tenantsResult = await pool.query(`
            SELECT DISTINCT 
                tenant_id,
                tenant_schema
            FROM core.user_email_to_tenant
            ORDER BY tenant_id ASC
        `);
        
        const allBooks = [];
        
        // Query each tenant's books
        for (const tenant of tenantsResult.rows) {
            const tenantSchema = tenant.tenant_schema;
            
            try {
                // Get tenant owner email (genesis admin)
                const ownerResult = await pool.query(`
                    SELECT email FROM ${tenantSchema}.users 
                    WHERE is_genesis_admin = true 
                    LIMIT 1
                `);
                
                const ownerEmail = ownerResult.rows.length > 0 ? ownerResult.rows[0].email : 'unknown';
                
                // DISCORD-FIRST: No message counts - Discord threads are sole storage
                const booksResult = await pool.query(`
                    SELECT 
                        b.*,
                        $1::integer as tenant_id,
                        $2::text as tenant_schema,
                        $3::text as tenant_owner_email
                    FROM ${tenantSchema}.books b
                    WHERE b.archived = false
                    ORDER BY b.created_at DESC
                `, [tenant.tenant_id, tenantSchema, ownerEmail]);
                
                allBooks.push(...booksResult.rows);
            } catch (error) {
                console.warn(`⚠️  Could not fetch books from ${tenantSchema}:`, error.message);
            }
        }
        
        console.log(`✅ Dev Panel: Found ${allBooks.length} books across ${tenantsResult.rows.length} tenants`);
        res.json(allBooks);
    } catch (error) {
        console.error('❌ Error in /api/dev/books:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all users (admin and dev roles)
app.get('/api/users', requireAuth, requireRole('admin', 'dev'), async (req, res) => {
    try {
        // Use tenant schema from middleware
        const tenantSchema = req.tenantSchema;
        
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // Get requesting user's info
        const userResult = await pool.query(
            `SELECT role, is_genesis_admin, tenant_id FROM ${tenantSchema}.users WHERE id = $1`,
            [req.userId]
        );
        
        if (!userResult.rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userResult.rows[0];
        
        // SECURITY CHECK for Dev Panel cross-tenant access
        if (user.role === 'dev' && user.is_genesis_admin) {
            // Genesis Admin: Return users from their own tenant only (for now)
            // Cross-tenant visibility requires additional security controls
            const result = await pool.query(
                `SELECT id, email, role, tenant_id, is_genesis_admin, created_at FROM ${tenantSchema}.users ORDER BY created_at DESC`
            );
            res.json(result.rows);
        } else if (user.role === 'admin') {
            // Admin users only see their own tenant
            const result = await pool.query(
                `SELECT id, email, role, tenant_id, is_genesis_admin, created_at FROM ${tenantSchema}.users ORDER BY created_at DESC`
            );
            res.json(result.rows);
        } else {
            return res.status(403).json({ error: 'Access denied' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update user role (admin only)
app.put('/api/users/:id/role', requireAuth, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    
    try {
        // Use tenant schema from middleware
        const tenantSchema = req.tenantSchema;
        
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // Get old role before update
        const oldData = await pool.query(`SELECT role, email FROM ${tenantSchema}.users WHERE id = $1`, [id]);
        const oldRole = oldData.rows[0]?.role;
        
        const result = await pool.query(`
            UPDATE ${tenantSchema}.users 
            SET role = $1, updated_at = NOW()
            WHERE id = $2
            RETURNING id, email, role, tenant_id, is_genesis_admin
        `, [role, id]);
        
        const updatedUser = result.rows[0];
        
        // Log role change
        await logAudit(pool, req, 'UPDATE_ROLE', 'USER', id, updatedUser.email, {
            old_role: oldRole,
            new_role: role
        }, tenantSchema);
        
        res.json(updatedUser);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete user (admin only)
app.delete('/api/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    
    try {
        // Use tenant schema from middleware
        const tenantSchema = req.tenantSchema;
        
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // Prevent deleting yourself
        if (parseInt(id) === req.userId) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }
        
        // Get user info before deletion for audit log
        const userData = await client.query(`SELECT email, role FROM ${tenantSchema}.users WHERE id = $1`, [id]);
        if (userData.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const deletedUser = userData.rows[0];
        
        // CRITICAL: Use dedicated client for atomic transaction
        await client.query('BEGIN');
        
        try {
            // Delete user from tenant schema
            await client.query(`DELETE FROM ${tenantSchema}.users WHERE id = $1`, [id]);
            
            // Delete email mapping from core schema (prevents re-registration issues)
            await client.query(`DELETE FROM core.user_email_to_tenant WHERE email = $1`, [deletedUser.email]);
            
            await client.query('COMMIT');
            
            // Log user deletion (outside transaction)
            await logAudit(pool, req, 'DELETE_USER', 'USER', id, deletedUser.email, {
                role: deletedUser.role
            }, tenantSchema);
            
            res.json({ success: true });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

// Update user email (admin only)
app.put('/api/users/:id/email', requireAuth, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { email } = req.body;
    
    try {
        // Use tenant schema from middleware
        const tenantSchema = req.tenantSchema;
        
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // Validate email presence and format
        if (!email || !email.trim()) {
            return res.status(400).json({ error: 'Email is required' });
        }
        
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        
        // Check if email already exists in this tenant
        const existingUser = await pool.query(`SELECT id FROM ${tenantSchema}.users WHERE email = $1 AND id != $2`, [email, id]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'Email already exists' });
        }
        
        // Get old email before update
        const oldData = await pool.query(`SELECT email FROM ${tenantSchema}.users WHERE id = $1`, [id]);
        const oldEmail = oldData.rows[0]?.email;
        
        const result = await pool.query(`
            UPDATE ${tenantSchema}.users 
            SET email = $1, updated_at = NOW()
            WHERE id = $2
            RETURNING id, email, role
        `, [email, id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const updatedUser = result.rows[0];
        
        // Update email mapping in core schema
        await pool.query(`
            UPDATE core.user_email_to_tenant 
            SET email = $1, updated_at = NOW()
            WHERE email = $2
        `, [email, oldEmail]);
        
        // Log email change
        await logAudit(pool, req, 'UPDATE_EMAIL', 'USER', id, updatedUser.email, {
            old_email: oldEmail,
            new_email: email
        }, tenantSchema);
        
        res.json(updatedUser);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update user password (admin only)
app.put('/api/users/:id/password', requireAuth, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { password } = req.body;
    
    try {
        // Use tenant schema from middleware
        const tenantSchema = req.tenantSchema;
        
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // Validate password presence and strength
        if (!password || !password.trim()) {
            return res.status(400).json({ error: 'Password is required' });
        }
        
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters long' });
        }
        
        // Get user info for audit log
        const userData = await pool.query(`SELECT email FROM ${tenantSchema}.users WHERE id = $1`, [id]);
        if (userData.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userData.rows[0];
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await pool.query(`
            UPDATE ${tenantSchema}.users 
            SET password_hash = $1, updated_at = NOW()
            WHERE id = $2
        `, [hashedPassword, id]);
        
        // Log password change
        await logAudit(pool, req, 'UPDATE_PASSWORD', 'USER', id, user.email, {
            updated_by_admin: true
        }, tenantSchema);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// Get audit logs (admin only)
app.get('/api/audit-logs', requireRole('admin'), async (req, res) => {
    try {
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const { limit = 100, offset = 0, action_type, target_type } = req.query;
        
        let query = `
            SELECT 
                id, timestamp, actor_email, action_type, target_type, 
                target_id, target_email, details, ip_address
            FROM ${tenantSchema}.audit_logs
        `;
        
        const conditions = [];
        const params = [];
        let paramIndex = 1;
        
        if (action_type) {
            conditions.push(`action_type = $${paramIndex++}`);
            params.push(action_type);
        }
        
        if (target_type) {
            conditions.push(`target_type = $${paramIndex++}`);
            params.push(target_type);
        }
        
        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }
        
        query += ` ORDER BY timestamp DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
        params.push(limit, offset);
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ PROMETHEUS AI CHECK API ============
// AI-powered message verification with H(0) guard rails

// Helper: Detect book names in user query and lookup their fractal IDs
async function detectAndLookupBookNames(userQuery, tenantSchema, client = pool) {
    if (!userQuery || typeof userQuery !== 'string') return [];
    
    try {
        // Fetch all books for this tenant with their names
        const result = await client.query(
            `SELECT fractal_id, name FROM ${tenantSchema}.books WHERE status != 'archived' ORDER BY name ASC`
        );
        
        const books = result.rows;
        if (books.length === 0) return [];
        
        const detectedFractalIds = [];
        const queryLower = userQuery.toLowerCase();
        
        // Look for book names in the query
        for (const book of books) {
            const bookNameLower = book.name.toLowerCase();
            // Match book name as whole word or with "and" separator
            if (queryLower.includes(bookNameLower) || 
                new RegExp(`\\b${bookNameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(userQuery)) {
                if (!detectedFractalIds.includes(book.fractal_id)) {
                    detectedFractalIds.push(book.fractal_id);
                }
            }
        }
        
        if (detectedFractalIds.length > 1) {
            console.log(`📖 Detected ${detectedFractalIds.length} books in query: ${detectedFractalIds.join(', ')}`);
        }
        
        return detectedFractalIds;
    } catch (error) {
        console.warn(`⚠️ Failed to detect book names:`, error.message);
        return [];
    }
}

// Helper: Fetch book context for Prometheus
async function fetchBookContextForPrometheus(fractalId, tenantSchema, client = pool) {
    if (!fractalId || !tenantSchema) return null;
    
    try {
        // Get book info
        const bookResult = await client.query(
            `SELECT id, name, output_credentials, created_at FROM ${tenantSchema}.books WHERE fractal_id = $1`,
            [fractalId]
        );
        
        if (bookResult.rows.length === 0) return null;
        
        const book = bookResult.rows[0];
        const bookCreatedAt = new Date(book.created_at);
        
        // Parse output_credentials
        let outputCredentials = book.output_credentials;
        if (typeof outputCredentials === 'string') {
            outputCredentials = JSON.parse(outputCredentials);
        }
        
        const outputData = outputCredentials?.output_01;
        if (!outputData?.thread_id) {
            return {
                name: book.name,
                fractalId: fractalId,
                createdAt: bookCreatedAt.toISOString(),
                totalMessages: 0,
                messagesThisMonth: 0,
                dateRange: 'No messages yet',
                recentMessages: []
            };
        }
        
        // Fetch messages from Discord
        if (!thothBot || !thothBot.client || !thothBot.ready) {
            return {
                name: book.name,
                fractalId: fractalId,
                createdAt: bookCreatedAt.toISOString(),
                totalMessages: 0,
                messagesThisMonth: 0,
                dateRange: 'Discord bot not ready',
                recentMessages: []
            };
        }
        
        const thread = await thothBot.client.channels.fetch(outputData.thread_id);
        if (!thread) return null;
        
        // Fetch up to 100 messages for context
        const discordMessages = await thread.messages.fetch({ limit: 100, force: true });
        
        // Filter messages after book creation and transform
        const now = new Date();
        const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        
        const messages = Array.from(discordMessages.values())
            .filter(msg => msg.createdAt >= bookCreatedAt)
            .map(msg => {
                // Extract content from embeds if present
                let content = msg.content;
                if (!content && msg.embeds.length > 0) {
                    const embed = msg.embeds[0];
                    content = embed.description || '';
                    const bodyField = embed.fields?.find(f => f.name === '📝 Body');
                    if (bodyField) content = bodyField.value;
                }
                
                return {
                    id: msg.id,
                    content: content,
                    timestamp: msg.createdAt.toISOString(),
                    createdAt: msg.createdAt
                };
            })
            .sort((a, b) => b.createdAt - a.createdAt);
        
        // Calculate stats by month
        const messagesByMonth = {};
        messages.forEach(msg => {
            const monthKey = `${msg.createdAt.getFullYear()}-${String(msg.createdAt.getMonth() + 1).padStart(2, '0')}`;
            messagesByMonth[monthKey] = (messagesByMonth[monthKey] || 0) + 1;
        });
        
        const messagesThisMonth = messages.filter(m => m.createdAt >= thisMonth).length;
        
        const dateRange = messages.length > 0
            ? `${messages[messages.length - 1].timestamp.split('T')[0]} to ${messages[0].timestamp.split('T')[0]}`
            : 'No messages';
        
        console.log(`📚 Prometheus context: Book "${book.name}" has ${messages.length} messages`);
        
        return {
            name: book.name,
            fractalId: fractalId,
            createdAt: bookCreatedAt.toISOString(),
            totalMessages: messages.length,
            messagesThisMonth: messagesThisMonth,
            dateRange: dateRange,
            messageStats: messagesByMonth,
            recentMessages: messages.slice(0, 100).map(m => ({
                timestamp: m.timestamp,
                content: m.content
            }))
        };
    } catch (error) {
        console.error(`❌ Failed to fetch book context: ${error.message}`);
        return null;
    }
}

// Helper: Fetch context from multiple books for Prometheus multi-book queries
async function fetchMultiBookContextForPrometheus(bookIds, tenantSchema, userRole, client = pool) {
    if (!bookIds || !Array.isArray(bookIds) || bookIds.length === 0 || !tenantSchema) {
        return null;
    }
    
    console.log(`📚 Prometheus multi-book: Fetching ${bookIds.length} books for ${tenantSchema}...`);
    
    const books = [];
    const accessibleSchemas = new Set();
    
    // For dev users with genesis access, they can access all tenant schemas
    const hasExtendedAccess = userRole === 'dev';
    
    if (hasExtendedAccess) {
        // Dev can access all tenant schemas
        const allSchemas = await getAllTenantSchemas(client, userRole);
        allSchemas.forEach(s => accessibleSchemas.add(s.tenant_schema));
    } else {
        // Regular users only access their own tenant
        accessibleSchemas.add(tenantSchema);
    }
    
    // Fetch each book's context
    for (const bookId of bookIds) {
        let bookContext = null;
        
        // Try the user's tenant schema first
        bookContext = await fetchBookContextForPrometheus(bookId, tenantSchema, client);
        
        // If not found and user has extended access, search other schemas
        if (!bookContext && hasExtendedAccess) {
            for (const schema of accessibleSchemas) {
                if (schema === tenantSchema) continue; // Already tried
                bookContext = await fetchBookContextForPrometheus(bookId, schema, client);
                if (bookContext) {
                    bookContext.sourceSchema = schema;
                    break;
                }
            }
        }
        
        if (bookContext && bookContext.totalMessages > 0) {
            bookContext.sourceSchema = bookContext.sourceSchema || tenantSchema;
            books.push(bookContext);
        } else {
            console.warn(`⚠️ Book ${bookId} not accessible or has no messages`);
        }
    }
    
    if (books.length === 0) {
        return null;
    }
    
    // Aggregate all messages across books
    const allMessages = [];
    const bookSummaries = [];
    
    for (const book of books) {
        bookSummaries.push({
            name: book.name,
            fractalId: book.fractalId,
            totalMessages: book.totalMessages,
            dateRange: book.dateRange
        });
        
        // Add book name to each message for cross-book context
        for (const msg of book.recentMessages) {
            allMessages.push({
                ...msg,
                bookName: book.name,
                bookFractalId: book.fractalId
            });
        }
    }
    
    // Sort all messages by timestamp (newest first)
    allMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    const totalMessages = books.reduce((sum, b) => sum + b.totalMessages, 0);
    
    console.log(`📚 Prometheus multi-book: Aggregated ${totalMessages} messages from ${books.length} books`);
    
    return {
        isMultiBook: true,
        bookCount: books.length,
        books: bookSummaries,
        totalMessages: totalMessages,
        recentMessages: allMessages.slice(0, 150), // Up to 150 messages across all books (increased from 50 to cover older data)
        dateRange: allMessages.length > 0
            ? `${allMessages[allMessages.length - 1].timestamp.split('T')[0]} to ${allMessages[0].timestamp.split('T')[0]}`
            : 'No messages'
    };
}

// Check messages against business rules (with optional book context)
// Supports single book (fractalId) or multi-book (bookIds array) queries
app.post('/api/prometheus/check', requireAuth, async (req, res) => {
    try {
        const { messages, ruleType = 'general', language, bookId, fractalId, bookIds } = req.body;
        
        console.log(`🔮 Prometheus API received: fractalId="${fractalId}", bookIds=${JSON.stringify(bookIds)}, tenantSchema="${req.tenantContext?.tenantSchema || req.tenantSchema}"`);
        
        if (!messages || (Array.isArray(messages) && messages.length === 0)) {
            return res.status(400).json({ 
                error: 'messages is required (string or array of strings)' 
            });
        }
        
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const userRole = req.userRole;
        const startTime = Date.now();
        let result;
        let hasBookContext = false;
        let multiBookContext = null;
        
        // Convert messages array to query string for book name detection
        const userQuery = Array.isArray(messages) ? messages.join('\n') : messages;
        
        // SINGULARITY: Client provides bookIds from user's authorized book list (highest priority)
        // This ensures AI sees exactly what user sees - no separate permission computation
        let detectedBookIds = null;
        
        if (bookIds && Array.isArray(bookIds) && bookIds.length > 0) {
            // Client-detected book names from user's authorized list (singularity approach)
            detectedBookIds = bookIds;
            console.log(`📖 Using client-provided bookIds (singularity): ${detectedBookIds.length} book(s)`);
        } else {
            // Fallback: server-side detection (for API calls without frontend)
            const autoDetectedFractalIds = await detectAndLookupBookNames(userQuery, tenantSchema);
            if (autoDetectedFractalIds && autoDetectedFractalIds.length > 0) {
                detectedBookIds = autoDetectedFractalIds;
                console.log(`📖 Server auto-detected ${detectedBookIds.length} book(s) from query text`);
            }
        }
        
        // MULTI-BOOK QUERY: If any books detected or explicitly provided, use multi-book context
        if (detectedBookIds && Array.isArray(detectedBookIds) && detectedBookIds.length > 0 && tenantSchema) {
            console.log(`🔮 Prometheus API: Multi-book query for ${detectedBookIds.length} books`);
            
            multiBookContext = await fetchMultiBookContextForPrometheus(detectedBookIds, tenantSchema, userRole);
            
            if (multiBookContext && multiBookContext.totalMessages > 0) {
                result = await Prometheus.checkWithMultiBookContext(userQuery, multiBookContext, { language });
                hasBookContext = true;
            } else {
                console.log(`⚠️ No multi-book context available, using regular check`);
                result = await Prometheus.check(messages, ruleType, { language });
            }
        }
        // SINGLE BOOK QUERY: If fractalId provided and no books detected, fetch book context
        else if (fractalId && fractalId !== 'null' && fractalId !== 'undefined' && tenantSchema) {
            console.log(`🔮 Prometheus API: Context query for book ${fractalId}`);
            
            const bookContext = await fetchBookContextForPrometheus(fractalId, tenantSchema);
            
            if (bookContext && bookContext.totalMessages > 0) {
                const userQuery = Array.isArray(messages) ? messages.join('\n') : messages;
                result = await Prometheus.checkWithContext(userQuery, bookContext, { language });
                hasBookContext = true;
            } else {
                console.log(`⚠️ No book context available, using regular check`);
                result = await Prometheus.check(messages, ruleType, { language });
            }
        } 
        // NO BOOK CONTEXT: Regular message check
        else {
            console.log(`🔮 Prometheus API: Checking ${Array.isArray(messages) ? messages.length : 1} message(s) with rule: ${ruleType}`);
            result = await Prometheus.check(messages, ruleType, { language });
        }
        
        const processingTime = Date.now() - startTime;
        
        const userId = req.user?.id || req.session?.userId;
        
        // Save to audit_queries table for history
        if (tenantSchema && userId) {
            try {
                const resultObj = Array.isArray(result) ? result[0] : result;
                await pool.query(`
                    INSERT INTO ${tenantSchema}.audit_queries 
                    (user_id, book_id, rule_type, language, input_messages, result_status, 
                     result_confidence, result_reason, result_data, raw_response, processing_time_ms)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                `, [
                    userId,
                    bookId ? parseInt(bookId) : null,
                    ruleType,
                    language || 'en',
                    JSON.stringify(Array.isArray(messages) ? messages : [messages]),
                    resultObj?.status || 'UNKNOWN',
                    resultObj?.confidence || 0,
                    resultObj?.reason || null,
                    resultObj?.data_extracted ? JSON.stringify(resultObj.data_extracted) : null,
                    resultObj?.raw_response || null,
                    processingTime
                ]);
                console.log(`✅ Prometheus audit saved to ${tenantSchema}.audit_queries`);
            } catch (dbError) {
                console.error('⚠️ Failed to save audit query (table may not exist):', dbError.message);
            }
        }
        
        // Log the check
        await logAudit(pool, req, 'PROMETHEUS_CHECK', 'MESSAGE', null, null, {
            rule_type: ruleType,
            message_count: Array.isArray(messages) ? messages.length : 1,
            result_status: Array.isArray(result) ? result.map(r => r.status) : result.status
        }, tenantSchema);
        
        // POST TO DISCORD: Use Idris to log audit result to AI log thread
        if (idrisBot && idrisBot.isReady() && tenantSchema) {
            try {
                const tenantId = parseInt(tenantSchema.replace('tenant_', ''));
                console.log(`🧿 Prometheus Discord: Looking up AI log thread for ${tenantSchema}...`);
                
                // Get or create AI log thread for this tenant (query by tenant_schema for reliability)
                const tenantInfo = await pool.query(`
                    SELECT id, ai_log_thread_id, ai_log_channel_id 
                    FROM core.tenant_catalog 
                    WHERE tenant_schema = $1
                `, [tenantSchema]);
                
                // Check if tenant exists in catalog
                if (tenantInfo.rows.length === 0) {
                    console.warn(`⚠️ Prometheus Discord: ${tenantSchema} not found in tenant_catalog - skipping Discord logging`);
                } else {
                    const catalogId = tenantInfo.rows[0].id;
                    let threadId = tenantInfo.rows[0]?.ai_log_thread_id;
                    
                    // Create thread if doesn't exist
                    if (!threadId) {
                        console.log(`🧿 Creating AI log thread for ${tenantSchema}...`);
                        const threadInfo = await idrisBot.createAILogThread(tenantId, tenantSchema);
                        threadId = threadInfo.threadId;
                        
                        // Save thread ID to tenant_catalog (using catalog id for reliable update)
                        await pool.query(`
                            UPDATE core.tenant_catalog 
                            SET ai_log_thread_id = $1, ai_log_channel_id = $2 
                            WHERE id = $3
                        `, [threadInfo.threadId, threadInfo.channelId, catalogId]);
                        console.log(`✅ AI log thread created: ${threadId}`);
                    } else {
                        console.log(`🧿 Using existing AI log thread: ${threadId}`);
                    }
                    
                    // Post audit result to Discord
                    const resultObj = Array.isArray(result) ? result[0] : result;
                    const userQuery = Array.isArray(messages) ? messages.join('\n') : messages;
                    const bookName = hasBookContext ? resultObj.bookName : null;
                    
                    await idrisBot.postAuditResult(threadId, resultObj, userQuery, bookName);
                    console.log(`📜 Prometheus audit posted to Discord thread ${threadId}`);
                }
            } catch (discordError) {
                console.error('⚠️ Failed to post audit to Discord:', discordError.message);
                // Don't fail the request, just log the error
            }
        } else {
            if (!idrisBot) console.log('⚠️ Prometheus Discord: Idris bot not available');
            else if (!idrisBot.isReady()) console.log('⚠️ Prometheus Discord: Idris bot not ready');
            else if (!tenantSchema) console.log('⚠️ Prometheus Discord: No tenant schema available');
        }
        
        res.json({ 
            success: true, 
            result,
            rule_type: ruleType,
            has_book_context: hasBookContext,
            processing_time_ms: processingTime,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Prometheus API error:', error);
        res.status(500).json({ 
            error: error.message,
            needs_human_review: true
        });
    }
});

// List available rule types
app.get('/api/prometheus/rules', requireAuth, async (req, res) => {
    try {
        const rules = Prometheus.listRuleTypes();
        res.json({ rules });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get Prometheus audit history
app.get('/api/prometheus/history', requireAuth, async (req, res) => {
    try {
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const userId = req.user?.id || req.session?.userId;
        const { limit = 50, offset = 0 } = req.query;
        
        if (!tenantSchema) {
            return res.status(400).json({ error: 'Tenant context required' });
        }
        
        const result = await pool.query(`
            SELECT 
                aq.id,
                aq.rule_type,
                aq.language,
                aq.input_messages,
                aq.result_status,
                aq.result_confidence,
                aq.result_reason,
                aq.result_data,
                aq.processing_time_ms,
                aq.created_at,
                b.name as book_name,
                b.fractal_id as book_fractal_id
            FROM ${tenantSchema}.audit_queries aq
            LEFT JOIN ${tenantSchema}.books b ON aq.book_id = b.id
            WHERE aq.user_id = $1
            ORDER BY aq.created_at DESC
            LIMIT $2 OFFSET $3
        `, [userId, parseInt(limit), parseInt(offset)]);
        
        const countResult = await pool.query(`
            SELECT COUNT(*) as total FROM ${tenantSchema}.audit_queries WHERE user_id = $1
        `, [userId]);
        
        res.json({
            success: true,
            history: result.rows,
            total: parseInt(countResult.rows[0].total),
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        console.error('❌ Prometheus history error:', error);
        // Table might not exist yet
        if (error.code === '42P01') {
            return res.json({ success: true, history: [], total: 0, limit: 50, offset: 0 });
        }
        res.status(500).json({ error: error.message });
    }
});

// Get AI audit logs from Discord via Horus (Prometheus Trinity)
app.get('/api/prometheus/discord-history', requireAuth, async (req, res) => {
    try {
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const { limit = 50 } = req.query;
        
        if (!tenantSchema) {
            return res.status(400).json({ error: 'Tenant context required' });
        }
        
        if (!horusBot || !horusBot.isReady()) {
            return res.status(503).json({ error: 'AI audit log reader not available' });
        }
        
        // Get AI log thread ID for this tenant (query by tenant_schema for reliability)
        const tenantInfo = await pool.query(`
            SELECT ai_log_thread_id FROM core.tenant_catalog WHERE tenant_schema = $1
        `, [tenantSchema]);
        
        const threadId = tenantInfo.rows[0]?.ai_log_thread_id;
        
        if (!threadId) {
            return res.json({ success: true, logs: [], message: 'No AI audit log thread exists yet' });
        }
        
        // Fetch logs via Horus
        const logs = await horusBot.fetchAuditLogs(threadId, parseInt(limit));
        const stats = await horusBot.getAuditStats(threadId);
        
        res.json({
            success: true,
            logs,
            stats,
            thread_id: threadId
        });
    } catch (error) {
        console.error('❌ Discord history error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Revoke session (admin only)
app.delete('/api/sessions/:sid', requireRole('admin'), async (req, res) => {
    const { sid } = req.params;
    
    try {
        // Prevent revoking your own session
        if (sid === req.sessionID) {
            return res.status(400).json({ error: 'Cannot revoke your own session' });
        }
        
        // Get session info before deletion for audit log
        const sessionData = await pool.query(`
            SELECT s.sess->>'userId' as user_id, u.email, u.phone
            FROM sessions s
            LEFT JOIN users u ON (s.sess->>'userId')::integer = u.id
            WHERE s.sid = $1
        `, [sid]);
        
        const result = await pool.query('DELETE FROM sessions WHERE sid = $1 RETURNING sid', [sid]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Session not found' });
        }
        
        const sessionInfo = sessionData.rows[0];
        
        // Log session revocation
        await logAudit(pool, req, 'REVOKE_SESSION', 'SESSION', sid, sessionInfo?.email || sessionInfo?.phone, {
            target_user_id: sessionInfo?.user_id
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ PROTECTED API ROUTES ============
// All routes below require authentication, with role-based access where specified

// DISCORD-FIRST: Messages stored in Discord threads, not PostgreSQL
app.get('/api/messages', requireAuth, async (req, res) => {
    try {
        // Return empty messages array - Discord threads are the sole storage
        res.json({ 
            messages: [], 
            total: 0, 
            page: 1, 
            limit: 50, 
            totalPages: 0,
            note: 'Messages are stored in Discord threads. Use the Discord UI to view message history.'
        });
    } catch (error) {
        console.error('❌ Error in /api/messages:', error);
        res.status(500).json({ error: error.message });
    }
});

// DISCORD-FIRST: Stats not available - Discord threads are sole storage
app.get('/api/stats', requireAuth, async (req, res) => {
    try {
        // Return zero stats - Discord manages all message data
        res.json({ 
            total: 0, 
            success: 0, 
            failed: 0, 
            pending: 0,
            note: 'Message statistics are not tracked in PostgreSQL. View full history in Discord threads.'
        });
    } catch (error) {
        console.error('❌ Error in /api/stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// Book management endpoints
// CRITICAL: Complete horizontal tenant isolation with EXPLICIT SCHEMA INDEXING
// Uses dynamic schema names via variable placeholders (fractalized architecture)
app.get('/api/books', requireAuth, async (req, res) => {
    console.log(`🔍 /api/books called by user ${req.userId}`);
    
    try {
        // Use tenant schema from requireAuth middleware
        const tenantSchema = req.tenantSchema;
        
        if (!tenantSchema) {
            console.error(`❌ No tenant schema set for user ${req.userId}`);
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // Get user info from tenant-scoped table
        const userResult = await pool.query(
            `SELECT id, email, tenant_id, is_genesis_admin FROM ${tenantSchema}.users WHERE id = $1`,
            [req.userId]
        );
        
        if (!userResult.rows.length) {
            console.error(`❌ User ${req.userId} not found in ${tenantSchema}`);
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userResult.rows[0];
        const tenantId = user.tenant_id;
        
        console.log(`📊 Loading books for ${user.email} (user_id=${req.userId}) from ${tenantSchema}`);
        
        // Books query with role-based access
        let books = [];
        const hasExtendedAccess = req.userRole === 'dev' && user.is_genesis_admin;
        
        // Limbo book filter: Hide t{X}-b1 books from non-dev users
        // These are default/limbo books only visible to dev admin
        const limboFilter = hasExtendedAccess ? '' : `AND b.name NOT LIKE '%(t%-b1)'`;
        
        if (hasExtendedAccess) {
            // Query all tenant schemas
            const allSchemas = await getAllTenantSchemas(pool, req.userRole);
            
            for (const schemaRow of allSchemas) {
                const schemaName = schemaRow.tenant_schema;
                try {
                    const schemaResult = await pool.query(`
                        SELECT b.*, '${schemaName}'::text as tenant_schema
                        FROM ${schemaName}.books b
                        WHERE b.archived = false
                        ORDER BY b.created_at DESC
                    `);
                    books.push(...schemaResult.rows);
                } catch (error) {
                    console.warn(`⚠️  Could not query schema ${schemaName}:`, error.message);
                }
            }
            
            console.log(`✅ Found ${books.length} active books across ${allSchemas.length} schemas`);
        } else {
            // Standard tenant-scoped query with limbo filter (owned books)
            const result = await pool.query(`
                SELECT b.*
                FROM ${tenantSchema}.books b
                WHERE b.archived = false
                ${limboFilter}
                ORDER BY b.created_at DESC
            `);
            books = result.rows;
            
            console.log(`✅ Found ${books.length} owned books in ${tenantSchema} for ${user.email}`);
            
            // CONTRIBUTOR ACCESS: Find books user contributed to (not created)
            // Step 1: Get user's phone number(s) from books they created
            const userPhonesResult = await pool.query(`
                SELECT DISTINCT ep.phone
                FROM core.book_engaged_phones ep
                JOIN core.book_registry br ON br.id = ep.book_registry_id
                WHERE br.tenant_email = $1 AND ep.is_creator = true
            `, [user.email]);
            
            const userPhones = userPhonesResult.rows.map(r => r.phone);
            
            if (userPhones.length > 0) {
                console.log(`📱 User ${user.email} has verified phone(s): ${userPhones.join(', ')}`);
                
                // Step 2: Find all books where user's phone is a contributor (not creator)
                // Excludes revoked contributors (last_engaged_at = NULL means 60-day dormancy revoked)
                const contributedBooksResult = await pool.query(`
                    SELECT DISTINCT 
                        br.fractal_id, br.book_name, br.tenant_schema, br.tenant_email,
                        ep.is_creator, ep.first_engaged_at, ep.last_engaged_at
                    FROM core.book_engaged_phones ep
                    JOIN core.book_registry br ON br.id = ep.book_registry_id
                    WHERE ep.phone = ANY($1::text[])
                      AND ep.is_creator = false
                      AND ep.last_engaged_at IS NOT NULL
                      AND br.status = 'active'
                      AND br.tenant_email != $2
                    ORDER BY ep.last_engaged_at DESC
                `, [userPhones, user.email]);
                
                // Step 3: Fetch full book details from each tenant schema
                for (const contrib of contributedBooksResult.rows) {
                    try {
                        const bookResult = await pool.query(`
                            SELECT b.*, '${contrib.tenant_schema}'::text as tenant_schema,
                                   true as is_contributed
                            FROM ${contrib.tenant_schema}.books b
                            WHERE b.fractal_id = $1 AND b.archived = false
                        `, [contrib.fractal_id]);
                        
                        if (bookResult.rows.length > 0) {
                            books.push(bookResult.rows[0]);
                        }
                    } catch (error) {
                        console.warn(`⚠️ Could not fetch contributed book ${contrib.fractal_id}:`, error.message);
                    }
                }
                
                console.log(`✅ Total: ${books.length} books (owned + contributed) for ${user.email}`);
            }
        }
        
        // PHASE 2 TRANSITION: Include both id and fractal_id during migration period
        // TODO: Remove raw id once ALL endpoints and frontend are migrated to fractal_id
        const booksWithFractalIds = books.map(book => {
            // Generate fractal_id if missing (for backward compatibility)
            if (!book.fractal_id) {
                book.fractal_id = fractalId.generate('book', tenantId, book.id, book.created_by_admin_id);
            }
            
            // ARCHITECTURAL SWITCHEROO: Hide the silent cat (webhook01/output_01)
            // Users should never see the Nyanbook Ledger webhook
            // Only expose output_0n (user's webhook) in the UI
            delete book.output_01_url;
            
            return book;
        });
        
        // SECURITY: Strip raw IDs for non-dev users (IDOR protection)
        const sanitized = sanitizeForRole(booksWithFractalIds, user.role);
        res.json({ books: sanitized });
    } catch (error) {
        console.error(`❌ Error in /api/books for user ${req.userId}:`, error);
        console.error('Stack trace:', error.stack);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/books', requireAuth, setTenantContext, requireRole('admin', 'write-only'), async (req, res) => {
    try {
        const client = req.dbClient || pool;
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const userRole = req.tenantContext?.userRole || 'read-only';
        const tenantId = req.tenantContext?.tenantId;
        const isGenesisAdmin = req.tenantContext?.isGenesisAdmin || false;
        const { name, inputPlatform, userOutputUrl, contactInfo, tags, outputCredentials: userOutputCredentials } = req.body;
        
        if (!tenantId) {
            return res.status(400).json({ error: 'Tenant context required' });
        }
        
        // VALIDATION: Reject blank or whitespace-only book names
        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'Book name is required and cannot be blank' });
        }
        
        // WEBHOOK-CENTRIC: Dual-output architecture
        // Output #01: Nyanbook Ledger (eternal, automatic, masked from Admin #0n)
        const output01Url = NYANBOOK_LEDGER_WEBHOOK;
        
        // Output #0n: User's Discord (mutable, optional, visible to owner)
        const output0nUrl = userOutputUrl || null;
        
        // SECURITY: Prevent user webhook from being same as Ledger webhook (privacy breach)
        if (output0nUrl && output0nUrl === NYANBOOK_LEDGER_WEBHOOK) {
            return res.status(400).json({ 
                error: 'Security violation: User output webhook cannot be the same as the system Ledger webhook. This would expose all tenant messages to your webhook.'
            });
        }
        
        // Tag dev-created books with admin_id='01' for fractalized ID generation
        const createdByAdminId = (userRole === 'dev' && isGenesisAdmin) ? '01' : null;
        
        // Generate unique Discord thread name for ledger tracking
        const threadName = `book-t${tenantId}-${Date.now()}`;
        
        // Store thread metadata + user webhooks in output_credentials
        const outputCredentials = {
            thread_name: threadName,
            webhooks: userOutputCredentials?.webhooks || []
        };
        
        // For WhatsApp books, set default join code if not provided
        const finalContactInfo = contactInfo || (inputPlatform === 'whatsapp' ? 'join baby-ability' : null);
        
        console.log(`📋 Book creation request: name="${name}", inputPlatform="${inputPlatform}", contactInfo="${contactInfo}"`);
        
        const result = await client.query(
            `INSERT INTO ${tenantSchema}.books (name, input_platform, output_platform, input_credentials, output_credentials, output_01_url, output_0n_url, contact_info, tags, status, archived, created_by_admin_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
            [name, inputPlatform, 'discord', {}, outputCredentials, output01Url, output0nUrl, finalContactInfo, tags || [], 'inactive', false, createdByAdminId]
        );
        
        const book = result.rows[0];
        
        // Generate fractalized ID (opaque, tenant-scoped, non-enumerable)
        // Dev admin (admin_id='01') gets special prefix: dev_bridge_t1_...
        const generatedFractalId = fractalId.generate('book', tenantId, book.id, book.created_by_admin_id);
        
        // Update book with fractalized ID
        await client.query(
            `UPDATE ${tenantSchema}.books SET fractal_id = $1 WHERE id = $2`,
            [generatedFractalId, book.id]
        );
        
        book.fractal_id = generatedFractalId;
        
        // Generate unique join code for books (sybil-proof activation)
        let joinCode = null;
        console.log(`🔍 Checking join code generation: inputPlatform="${inputPlatform}", condition=${inputPlatform === 'whatsapp'}`);
        if (inputPlatform === 'whatsapp') {
            // Format: "BOOKNAME-abc123" (6 hex chars = 24 bits entropy = 16.7M combinations)
            const randomCode = crypto.randomBytes(3).toString('hex');
            const bookNameSlug = name.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
            joinCode = `${bookNameSlug}-${randomCode}`;
            
            
            // Update contact_info with unique join code
            await client.query(`
                UPDATE ${tenantSchema}.books 
                SET contact_info = $1 
                WHERE id = $2
            `, [`join baby-ability ${joinCode}`, book.id]);
            
            book.contact_info = `join baby-ability ${joinCode}`;
            console.log(`🔐 Generated join code for book ${generatedFractalId}: ${joinCode}`);
        }
        
        // REGISTRY INSERT: Add book to centralized global registry for O(1) lookups
        // This eliminates N-schema loops (26 queries → 1 query per WhatsApp message)
        const tenantEmail = req.tenantContext.userEmail;
        
        // Prepare outpipes array from output_credentials webhooks
        const outpipesUser = outputCredentials?.webhooks?.map(w => ({
            type: 'webhook',
            url: w.url,
            name: w.name || 'User Webhook'
        })) || [];
        
        // If output_0n_url exists but not in webhooks array, add it
        if (output0nUrl && !outpipesUser.find(w => w.url === output0nUrl)) {
            outpipesUser.push({
                type: 'webhook',
                url: output0nUrl,
                name: 'Primary Webhook'
            });
        }
        
        await pool.query(`
            INSERT INTO core.book_registry (
                book_name, join_code, fractal_id, tenant_schema, tenant_email,
                phone_number, status, inpipe_type, outpipe_ledger, outpipes_user
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
            name,
            joinCode || `no-code-${generatedFractalId}`, // Fallback for non-WhatsApp books
            generatedFractalId,
            tenantSchema,
            tenantEmail,
            null, // phone_number = NULL until activated
            'pending', // status = pending until Join Code authentication and activation
            inputPlatform,
            output01Url,
            JSON.stringify(outpipesUser)
        ]);
        
        console.log(`📚 Registered book in global registry: ${generatedFractalId} (tenant: ${tenantEmail})`);
        
        // AUTO-CREATE DUAL DISCORD THREADS VIA BOT
        // thread_01 → Nyanbook Ledger (webhook01) - dev-only visibility
        // thread_0n → User Discord (webhook0n) - user-facing visibility
        if (hermesBot && hermesBot.isReady()) {
            try {
                console.log(`🧵 Initiating dual thread creation for book ${book.id}...`);
                const dualThreads = await hermesBot.createDualThreadsForBook(
                    output01Url,
                    output0nUrl,
                    name,
                    tenantId,
                    book.id
                );
                
                // Build output_credentials with typed destinations (channel OR thread)
                const outputDestinations = {};
                
                if (dualThreads.output_01) {
                    outputDestinations.output_01 = dualThreads.output_01;
                    if (dualThreads.output_01.type === 'thread') {
                        console.log(`  ✅ Stored output_01 (thread): ${dualThreads.output_01.thread_id}`);
                    } else {
                        console.log(`  ✅ Stored output_01 (channel): ${dualThreads.output_01.channel_id}`);
                    }
                }
                
                if (dualThreads.output_0n) {
                    outputDestinations.output_0n = dualThreads.output_0n;
                    if (dualThreads.output_0n.type === 'thread') {
                        console.log(`  ✅ Stored output_0n (thread): ${dualThreads.output_0n.thread_id}`);
                    } else {
                        console.log(`  ✅ Stored output_0n (channel): ${dualThreads.output_0n.channel_id}`);
                    }
                }
                
                // Log any errors but don't fail book creation
                if (dualThreads.errors.length > 0) {
                    console.warn(`⚠️  Output creation errors:`, dualThreads.errors);
                }
                
                await client.query(
                    `UPDATE ${tenantSchema}.books 
                     SET output_credentials = output_credentials || $1::jsonb
                     WHERE id = $2`,
                    [JSON.stringify(outputDestinations), book.id]
                );
                
                // Update book object with output credentials
                book.output_credentials = { ...book.output_credentials, ...outputDestinations };
                
                // Send initial messages to both outputs (only for threads)
                if (dualThreads.output_01 && dualThreads.output_01.type === 'thread') {
                    try {
                        await hermesBot.sendInitialMessage(dualThreads.output_01.thread_id, name, output01Url);
                        console.log(`  ✅ Sent initial message to output_01 thread`);
                    } catch (msgError) {
                        console.error(`  ⚠️  Failed to send initial message to output_01:`, msgError.message);
                    }
                }
                
                if (dualThreads.output_0n && dualThreads.output_0n.type === 'thread') {
                    try {
                        await hermesBot.sendInitialMessage(dualThreads.output_0n.thread_id, name, output0nUrl);
                        console.log(`  ✅ Sent initial message to output_0n thread`);
                    } catch (msgError) {
                        console.error(`  ⚠️  Failed to send initial message to output_0n:`, msgError.message);
                    }
                }
                
                console.log(`🧵 Dual-thread setup complete for book ${generatedFractalId}`);
            } catch (error) {
                console.error(`⚠️  Failed to create dual threads for book ${generatedFractalId}:`, error.message);
                console.log(`❌ Book will use webhook-only mode (no Discord thread UI)`);
            }
        }
        
        // Return sanitized book data (output_01_url is automatically stripped for non-dev users)
        const sanitized = sanitizeForRole(book, userRole);
        
        console.log(`✅ Created book ${generatedFractalId} (Output #01: ${output01Url ? '[LEDGER]' : 'None'}, Output #0n: ${output0nUrl ? '[USER_WEBHOOK]' : 'None'})`);
        res.json(sanitized);
    } catch (error) {
        console.error('❌ Error in POST /api/books:', error);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/books/:id', requireAuth, setTenantContext, requireRole('admin', 'write-only'), async (req, res) => {
    try {
        const client = req.dbClient || pool;
        const userRole = req.tenantContext?.userRole || 'read-only';
        const tenantSchema = req.tenantContext.tenantSchema;
        const userId = req.userId;
        const { id } = req.params; // fractal_id
        const { name, inputPlatform, outputPlatform, inputCredentials, outputCredentials, contactInfo, tags, status, userOutputUrl, password } = req.body;
        
        // SECURITY: Prevent user webhook from being same as Ledger webhook (privacy breach)
        if (userOutputUrl && userOutputUrl === NYANBOOK_LEDGER_WEBHOOK) {
            return res.status(400).json({ 
                error: 'Security violation: User output webhook cannot be the same as the system Ledger webhook. This would expose all tenant messages to your webhook.'
            });
        }
        
        // SECURITY: Password required when changing webhook0n URL
        if (userOutputUrl !== undefined || (outputCredentials && outputCredentials.webhooks)) {
            // Check if webhook URL is actually changing
            const currentBook = await client.query(
                `SELECT output_0n_url, output_credentials FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [id]
            );
            
            if (currentBook.rows.length > 0) {
                const existingWebhookUrl = currentBook.rows[0].output_0n_url;
                const newWebhookUrl = userOutputUrl || (outputCredentials?.webhooks?.[0]?.url);
                
                // If webhook is changing, require password verification
                if (newWebhookUrl && newWebhookUrl !== existingWebhookUrl) {
                    if (!password) {
                        return res.status(403).json({ 
                            error: 'Password required to change webhook URL',
                            requiresPassword: true
                        });
                    }
                    
                    // Verify password
                    const userResult = await client.query(
                        `SELECT password_hash FROM ${tenantSchema}.users WHERE id = $1`,
                        [userId]
                    );
                    
                    if (userResult.rows.length === 0) {
                        return res.status(401).json({ error: 'User not found' });
                    }
                    
                    const isPasswordValid = await bcrypt.compare(password, userResult.rows[0].password_hash);
                    if (!isPasswordValid) {
                        return res.status(401).json({ 
                            error: 'Invalid password. Webhook URL not changed.',
                            invalidPassword: true
                        });
                    }
                    
                    console.log(`🔐 Password verified for webhook change on book ${id} by user ${userId}`);
                }
            }
        }
        
        // Build update query dynamically based on what's provided
        const updates = [];
        const values = [];
        let paramCount = 1;
        
        if (name !== undefined) {
            updates.push(`name = $${paramCount++}`);
            values.push(name);
        }
        if (inputPlatform !== undefined) {
            updates.push(`input_platform = $${paramCount++}`);
            values.push(inputPlatform);
        }
        if (outputPlatform !== undefined) {
            updates.push(`output_platform = $${paramCount++}`);
            values.push(outputPlatform);
        }
        if (inputCredentials !== undefined) {
            updates.push(`input_credentials = $${paramCount++}`);
            values.push(inputCredentials);
        }
        if (outputCredentials !== undefined) {
            // CRITICAL: Merge webhooks into existing output_credentials (preserve thread data)
            updates.push(`output_credentials = output_credentials || $${paramCount++}::jsonb`);
            values.push(JSON.stringify({ webhooks: outputCredentials.webhooks || [] }));
        }
        if (contactInfo !== undefined) {
            updates.push(`contact_info = $${paramCount++}`);
            values.push(contactInfo || null);
        }
        if (tags !== undefined) {
            updates.push(`tags = $${paramCount++}`);
            values.push(tags || []);
        }
        if (status !== undefined) {
            updates.push(`status = $${paramCount++}`);
            values.push(status);
        }
        if (userOutputUrl !== undefined) {
            updates.push(`output_0n_url = $${paramCount++}`);
            values.push(userOutputUrl);
        }
        
        updates.push(`updated_at = NOW()`);
        values.push(id); // fractal_id at end
        
        const result = await client.query(
            `UPDATE ${tenantSchema}.books 
             SET ${updates.join(', ')}
             WHERE fractal_id = $${paramCount} RETURNING *`,
            values
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Book not found' });
        }
        
        const sanitized = sanitizeForRole(result.rows[0], userRole);
        res.json(sanitized);
    } catch (error) {
        console.error('❌ Error in PUT /api/books/:id:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete book (soft delete - archives book preserving all data)
app.delete('/api/books/:id', requireAuth, setTenantContext, requireRole('admin'), async (req, res) => {
    const { id } = req.params; // fractal_id
    
    try {
        const client = req.dbClient || pool;
        const tenantSchema = req.tenantContext.tenantSchema;
        
        // SECURITY: Verify book belongs to user's tenant using fractal_id
        // CRITICAL: Get webhook URLs BEFORE archiving so we can delete them
        const bookResult = await client.query(
            `SELECT id, fractal_id, output_01_url, output_0n_url FROM ${tenantSchema}.books WHERE fractal_id = $1`,
            [id]
        );
        
        if (!bookResult.rows.length) {
            console.warn(`⚠️  User ${req.userId} attempted to delete book ${id} outside their tenant`);
            return res.status(404).json({ error: 'Book not found' });
        }
        
        const book = bookResult.rows[0];
        const internalId = book.id;
        console.log(`🗄️  Archiving book ${id} (internal ${internalId}) from ${tenantSchema} (soft delete)...`);
        
        // SECURITY: Delete Discord webhooks to prevent ghost messages (NYAN TRUTH)
        // ONE BOOK = ONE WEBHOOK URL. On delete: DESTROY + DELETE WEBHOOK.
        const webhooksToDelete = [];
        if (book.output_0n_url) webhooksToDelete.push({ url: book.output_0n_url, name: 'User Discord' });
        
        for (const webhook of webhooksToDelete) {
            try {
                await axios.delete(webhook.url);
                console.log(`🗑️  Discord webhook deleted for book ${id} (${webhook.name})`);
            } catch (err) {
                // Webhook might already be deleted or invalid - log but don't fail
                console.warn(`⚠️  Failed to delete ${webhook.name} webhook (maybe already gone):`, err.message);
            }
        }
        
        // NOTE: output_01_url (Nyanbook Ledger) is ETERNAL and shared - never delete it
        if (book.output_01_url) {
            console.log(`ℹ️  Preserving output_01_url (Nyanbook Ledger) - eternal webhook, not book-specific`);
        }
        
        // SCRIBE OF SCRIBE PRINCIPLE: Discord threads are PERMANENT and IMMUTABLE
        // NEVER delete or archive threads - they are the eternal record
        if (book.output_credentials?.thread_id) {
            console.log(`📜 Preserving Discord thread ${book.output_credentials.thread_id} - eternal ledger, never deleted`);
        }
        
        // SOFT DELETE: Set archived=true and status='archived' (preserves all data)
        // Note: updated_at will automatically track when the archive happened
        const result = await client.query(`
            UPDATE ${tenantSchema}.books 
            SET archived = true, status = 'archived', updated_at = NOW() 
            WHERE fractal_id = $1 
            RETURNING *
        `, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Book not found' });
        }
        
        console.log(`✅ Book ${id} archived successfully by user ${req.userId}`);
        res.json({ 
            success: true, 
            message: 'Book deleted successfully'
        });
        
        // Log audit AFTER response (don't block transaction commit)
        setImmediate(() => {
            logAudit(pool, req, 'ARCHIVE', 'BOT', id, null, {
                message: 'Book archived (soft delete) - all messages and session preserved',
                tenant_schema: tenantSchema,
                updated_at: new Date().toISOString()
            }).catch(err => console.error('Audit log failed:', err.message));
        });
    } catch (error) {
        console.error(`❌ Error archiving book ${id}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Archive book (soft delete - keeps all message history)
app.post('/api/books/:id/archive', requireAuth, setTenantContext, requireRole('admin'), async (req, res) => {
    try {
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const { id } = req.params;
        
        // Prevent archiving the default active bot
        if (parseInt(id) === 1) {
            return res.status(400).json({ 
                error: 'Cannot archive the default book (currently active). Create and activate a new book first.' 
            });
        }
        
        await pool.query(`UPDATE ${tenantSchema}.books SET archived = true, status = $1 WHERE id = $2`, ['archived', id]);
        
        logAudit(pool, req, 'ARCHIVE', 'BOT', id, null, {
            message: 'Book archived - message history preserved'
        });
        
        res.json({ success: true, message: 'Book archived. All message history preserved.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Unarchive book (restore archived bot)
app.post('/api/books/:id/unarchive', requireAuth, setTenantContext, requireRole('admin'), async (req, res) => {
    try {
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const { id } = req.params;
        await pool.query(`UPDATE ${tenantSchema}.books SET archived = false, status = $1 WHERE id = $2`, ['inactive', id]);
        
        logAudit(pool, req, 'UNARCHIVE', 'BOT', id, null, {
            message: 'Book unarchive and restored'
        });
        
        res.json({ success: true, message: 'Book restored successfully.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Stub endpoint for Twilio - no "relink" needed (just show QR again)
app.post('/api/books/:id/relink', requireAuth, setTenantContext, requireRole('admin'), async (req, res) => {
    res.json({ 
        success: true, 
        message: 'With Twilio, no relink needed - just show the join code to your user again' 
    });
});

// ============ WEBHOOK INPUT ENDPOINT (HYBRID MODEL) ============
// Support ANY input: Telegram bot, Twitter/X, SMS, Email → Discord
// Example: POST /api/webhook/bridge_t6_abc123 with { text, username, avatar_url, media_url }
app.post('/api/webhook/:fractalId', async (req, res) => {
    try {
        const fractalIdParam = req.params.fractalId;
        const { text, username = 'External', avatar_url, media_url, phone, email } = req.body;
        
        // Parse fractal_id to get tenant
        const parsed = fractalId.parse(fractalIdParam);
        if (!parsed || !parsed.tenantId) {
            return res.status(400).json({ error: 'Invalid book ID format' });
        }
        
        const tenantSchema = `tenant_${parsed.tenantId}`;
        
        // Get tenant-scoped database client
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // TRANSACTION MODE: Use explicit schema prefix instead of SET LOCAL search_path
            
            // Find book by fractal_id
            const bookResult = await client.query(
                `SELECT id, fractal_id, output_01_url, output_0n_url, output_credentials FROM ${tenantSchema}.books WHERE fractal_id = $1`,
                [fractalIdParam]
            );
            
            if (bookResult.rows.length === 0) {
                await client.query('ROLLBACK');
                client.release();
                return res.status(404).json({ error: 'Book not found' });
            }
            
            const book = bookResult.rows[0];
            const internalId = book.id;
            
            // Parse JSON if needed (PostgreSQL returns JSON as string sometimes)
            if (book && typeof book.output_credentials === 'string') {
                book.output_credentials = JSON.parse(book.output_credentials);
            }
            
            // ARCHITECTURE: Messages stored ONLY in Discord (not PostgreSQL)
            const senderName = username || phone || email || 'External';
            
            // Prepare Discord payload
            const discordPayload = {
                username: senderName,
                avatar_url: avatar_url || 'https://cdn.discordapp.com/embed/avatars/0.png',
                content: text || '',
                embeds: []
            };
            
            // Add media embed if provided
            if (media_url) {
                discordPayload.embeds.push({
                    image: { url: media_url }
                });
            }
            
            // WEBHOOK-FIRST ARCHITECTURE: Dual-output delivery
            // Output #01: Nyanbook Ledger (eternal, Dev #01 only)
            // Output #0n: User Discord (mutable, Admin #0n only)
            const threadName = book.output_credentials?.thread_name;
            const threadId = book.output_credentials?.thread_id;
            
            // Path 1: Nyanbook Ledger (Output #01)
            await sendToLedger(discordPayload, {
                isMedia: !!media_url,
                threadName,
                threadId
            }, book);
            
            // Path 2: User Webhook (Output #0n)
            await sendToUserOutput(discordPayload, {
                isMedia: !!media_url
            }, book);
            
            await client.query('COMMIT');
            client.release();
            
            console.log(`✅ [Webhook] Forwarded message from ${senderName} to book ${fractalIdParam}`);
            res.json({ success: true, message: 'Message forwarded to Discord' });
            
        } catch (error) {
            await client.query('ROLLBACK');
            client.release();
            throw error;
        }
    } catch (error) {
        console.error(`❌ [Webhook] Error processing webhook:`, error);
        res.status(500).json({ error: error.message });
    }
});

// WhatsApp endpoints removed - Baileys library no longer used

// Get archived books (with message history)
app.get('/api/books/archived', requireAuth, async (req, res) => {
    try {
        // Use tenant schema from requireAuth middleware (already set!)
        const tenantSchema = req.tenantSchema;
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // TENANT-AWARE: Query from tenant schema
        const result = await pool.query(`
            SELECT 
                b.*,
                COUNT(m.id) as message_count,
                COUNT(m.id) FILTER (WHERE m.discord_status = 'success') as forwarded_count,
                COUNT(m.id) FILTER (WHERE m.discord_status = 'failed') as failed_count,
                COUNT(m.id) FILTER (WHERE m.discord_status = 'pending') as pending_count
            FROM ${tenantSchema}.books b
            LEFT JOIN ${tenantSchema}.messages m ON b.id = m.book_id
            WHERE b.archived = true
            GROUP BY b.id
            ORDER BY b.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('❌ Error in /api/books/archived:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/books/:id/stats', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Use tenant schema from requireAuth middleware (already set!)
        const tenantSchema = req.tenantSchema;
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // TENANT-AWARE: Query from tenant schema
        const result = await pool.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE discord_status = 'success') as success,
                COUNT(*) FILTER (WHERE discord_status = 'failed') as failed,
                COUNT(*) FILTER (WHERE discord_status = 'pending') as pending
            FROM ${tenantSchema}.messages WHERE book_id = $1
        `, [id]);
        res.json(result.rows[0]);
    } catch (error) {
        console.error('❌ Error in /api/books/:id/stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ DROPS API - Personal Cloud OS ============
// Initialize metadata extractor (zero-cost regex extraction)
const metadataExtractor = new MetadataExtractor();

// Create a drop (link metadata to Discord message)
app.post('/api/drops', requireAuth, setTenantContext, async (req, res) => {
    try {
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const { book_id, discord_message_id, metadata_text } = req.body;
        const client = req.dbClient || pool;
        
        if (!book_id || !discord_message_id || !metadata_text) {
            return res.status(400).json({ 
                error: 'Missing required fields: book_id, discord_message_id, metadata_text' 
            });
        }
        
        // Verify book belongs to user's tenant
        const bookResult = await client.query(
            `SELECT id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
            [book_id]
        );
        
        if (bookResult.rows.length === 0) {
            return res.status(404).json({ error: 'Book not found in your tenant' });
        }
        
        const internalBookId = bookResult.rows[0].id;
        
        // Check if drop already exists to APPEND text instead of replacing
        const existingDrop = await client.query(
            `SELECT * FROM ${tenantSchema}.drops WHERE book_id = $1 AND discord_message_id = $2`,
            [internalBookId, discord_message_id]
        );
        
        let dropResult;
        let extracted;
        
        if (existingDrop.rows.length > 0) {
            // APPEND new text to existing text
            const combinedText = existingDrop.rows[0].metadata_text + ' ' + metadata_text;
            
            // Extract metadata from COMBINED text (not just new text) to catch all tags
            extracted = metadataExtractor.extract(combinedText);
            console.log('🏷️ UPDATE - Extracted from combinedText:', { combinedText, extracted });
            
            // Convert JavaScript arrays to PostgreSQL arrays using ARRAY[]::text[]
            dropResult = await client.query(`
                UPDATE ${tenantSchema}.drops
                SET metadata_text = $1,
                    extracted_tags = $2::text[],
                    extracted_dates = $3::text[],
                    updated_at = NOW()
                WHERE book_id = $4 AND discord_message_id = $5
                RETURNING *
            `, [combinedText, extracted.tags, extracted.dates, internalBookId, discord_message_id]);
        } else {
            // Extract metadata from NEW text for first save
            extracted = metadataExtractor.extract(metadata_text);
            console.log('🏷️ INSERT - Extracted from metadata_text:', { metadata_text, extracted });
            
            // Convert JavaScript arrays to PostgreSQL arrays using ARRAY[]::text[]
            dropResult = await client.query(`
                INSERT INTO ${tenantSchema}.drops (book_id, discord_message_id, metadata_text, extracted_tags, extracted_dates)
                VALUES ($1, $2, $3, $4::text[], $5::text[])
                RETURNING *
            `, [internalBookId, discord_message_id, metadata_text, extracted.tags, extracted.dates]);
        }
        
        console.log('✅ Drop saved successfully:', {
            metadata_text: dropResult.rows[0].metadata_text,
            extracted_tags: dropResult.rows[0].extracted_tags,
            extracted_dates: dropResult.rows[0].extracted_dates
        });
        
        res.json({ 
            success: true, 
            drop: dropResult.rows[0],
            extracted: extracted
        });
    } catch (error) {
        console.error('❌ Error creating drop:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all drops for a book
app.get('/api/drops/:book_id', requireAuth, setTenantContext, async (req, res) => {
    try {
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const { book_id } = req.params;
        const client = req.dbClient || pool;
        
        // Verify book belongs to user's tenant
        const bookResult = await client.query(
            `SELECT id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
            [book_id]
        );
        
        if (bookResult.rows.length === 0) {
            return res.status(404).json({ error: 'Book not found in your tenant' });
        }
        
        const internalBookId = bookResult.rows[0].id;
        
        // Fetch all drops for this book
        const dropsResult = await client.query(
            `SELECT * FROM ${tenantSchema}.drops WHERE book_id = $1 ORDER BY created_at DESC`,
            [internalBookId]
        );
        
        res.json({ drops: dropsResult.rows });
    } catch (error) {
        console.error('❌ Error fetching drops:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete a specific tag from a message's drop
app.delete('/api/drops/tag', requireAuth, setTenantContext, async (req, res) => {
    try {
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const { book_id, discord_message_id, tag } = req.body;
        const client = req.dbClient || pool;
        
        console.log('🗑️ DELETE /api/drops/tag request:', { book_id, discord_message_id, tag });
        
        if (!book_id || !discord_message_id || !tag) {
            console.log('❌ Missing required fields');
            return res.status(400).json({ 
                error: 'Missing required fields: book_id, discord_message_id, tag' 
            });
        }
        
        // Verify book belongs to user's tenant
        const bookResult = await client.query(
            `SELECT id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
            [book_id]
        );
        
        console.log('🔍 Book lookup result:', bookResult.rows);
        
        if (bookResult.rows.length === 0) {
            console.log('❌ Book not found for fractal_id:', book_id);
            return res.status(404).json({ error: 'Book not found in your tenant' });
        }
        
        const internalBookId = bookResult.rows[0].id;
        console.log('✅ Internal book ID:', internalBookId);
        
        // CRITICAL FIX: Remove tag from BOTH extracted_tags array AND metadata_text string
        // This prevents deleted tags from reappearing when new tags are added
        // Escape regex metacharacters in JavaScript before passing to SQL
        const escapedTag = tag.replace(/[.+*?[\](){}|\\^$]/g, '\\$&');
        
        const dropResult = await client.query(`
            UPDATE ${tenantSchema}.drops
            SET extracted_tags = array_remove(extracted_tags, $1),
                metadata_text = TRIM(
                    REGEXP_REPLACE(
                        REGEXP_REPLACE(
                            metadata_text,
                            '(^|\\s)#?' || $2 || '(\\s|$)',
                            ' ',
                            'gi'
                        ),
                        '\\s+', ' ', 'g'
                    )
                ),
                updated_at = NOW()
            WHERE book_id = $3 AND discord_message_id = $4
            RETURNING *
        `, [tag, escapedTag, internalBookId, discord_message_id]);
        
        console.log('🗑️ Tag removal result:', {
            rowsAffected: dropResult.rows.length,
            updatedTags: dropResult.rows[0]?.extracted_tags,
            messageId: discord_message_id
        });
        
        if (dropResult.rows.length === 0) {
            console.log('❌ Drop not found for deletion');
            return res.status(404).json({ error: 'Drop not found' });
        }
        
        console.log('✅ Tag removed successfully');
        res.json({ 
            success: true, 
            drop: dropResult.rows[0]
        });
    } catch (error) {
        console.error('❌ Error removing tag:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete a specific date from a message's drop
app.delete('/api/drops/date', requireAuth, setTenantContext, async (req, res) => {
    try {
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const { book_id, discord_message_id, date } = req.body;
        const client = req.dbClient || pool;
        
        console.log('🗑️ DELETE /api/drops/date request:', { book_id, discord_message_id, date });
        
        if (!book_id || !discord_message_id || !date) {
            console.log('❌ Missing required fields');
            return res.status(400).json({ 
                error: 'Missing required fields: book_id, discord_message_id, date' 
            });
        }
        
        // Verify book belongs to user's tenant
        const bookResult = await client.query(
            `SELECT id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
            [book_id]
        );
        
        console.log('🔍 Book lookup result:', bookResult.rows);
        
        if (bookResult.rows.length === 0) {
            console.log('❌ Book not found for fractal_id:', book_id);
            return res.status(404).json({ error: 'Book not found in your tenant' });
        }
        
        const internalBookId = bookResult.rows[0].id;
        console.log('✅ Internal book ID:', internalBookId);
        
        // CRITICAL FIX: Remove date from BOTH extracted_dates array AND metadata_text string
        // This prevents deleted dates from reappearing when new tags are added
        // Escape regex metacharacters in JavaScript before passing to SQL
        const escapedDate = date.replace(/[.+*?[\](){}|\\^$]/g, '\\$&');
        
        const dropResult = await client.query(`
            UPDATE ${tenantSchema}.drops
            SET extracted_dates = array_remove(extracted_dates, $1),
                metadata_text = TRIM(
                    REGEXP_REPLACE(
                        REGEXP_REPLACE(
                            metadata_text,
                            '(^|\\s)' || $2 || '(\\s|$)',
                            ' ',
                            'gi'
                        ),
                        '\\s+', ' ', 'g'
                    )
                ),
                updated_at = NOW()
            WHERE book_id = $3 AND discord_message_id = $4
            RETURNING *
        `, [date, escapedDate, internalBookId, discord_message_id]);
        
        console.log('🔍 Drop update result:', dropResult.rows.length > 0 ? 'SUCCESS' : 'NOT FOUND');
        
        if (dropResult.rows.length === 0) {
            console.log('❌ No drop found for:', { internalBookId, discord_message_id });
            return res.status(404).json({ error: 'Drop not found' });
        }
        
        console.log('✅ Date removed successfully');
        res.json({ 
            success: true, 
            drop: dropResult.rows[0]
        });
    } catch (error) {
        console.error('❌ Error removing date:', error);
        res.status(500).json({ error: error.message });
    }
});

// Search drops using PostgreSQL full-text search
app.get('/api/drops/search/:book_id', requireAuth, setTenantContext, async (req, res) => {
    try {
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const { book_id } = req.params;
        const { query } = req.query;
        const client = req.dbClient || pool;
        
        if (!query) {
            return res.status(400).json({ error: 'Query parameter required' });
        }
        
        // Verify book belongs to user's tenant
        const bookResult = await client.query(
            `SELECT id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
            [book_id]
        );
        
        if (bookResult.rows.length === 0) {
            return res.status(404).json({ error: 'Book not found in your tenant' });
        }
        
        const internalBookId = bookResult.rows[0].id;
        
        // PostgreSQL full-text search (zero-cost, blazing fast)
        const searchResult = await client.query(`
            SELECT *, ts_rank(search_vector, plainto_tsquery('english', $1)) as rank
            FROM ${tenantSchema}.drops
            WHERE book_id = $2 AND search_vector @@ plainto_tsquery('english', $1)
            ORDER BY rank DESC, created_at DESC
            LIMIT 100
        `, [query, internalBookId]);
        
        res.json({ 
            query: query,
            results: searchResult.rows,
            count: searchResult.rows.length
        });
    } catch (error) {
        console.error('❌ Error searching drops:', error);
        res.status(500).json({ error: error.message });
    }
});

// Export book data (messages + drops metadata) as ZIP
// Supports both GET (all messages) and POST (selected message IDs)
const exportBookHandler = async (req, res) => {
    console.log('🔔 EXPORT HANDLER CALLED');
    console.log('🔔 URL:', req.originalUrl);
    console.log('🔔 Params:', req.params);
    console.log('🔔 Query:', req.query);
    console.log('🔔 User ID:', req.userId);
    console.log('🔔 Tenant Context:', req.tenantContext?.tenantSchema);
    
    const archiver = require('archiver');
    const { book_id } = req.params;
    const selectedMessageIds = req.body?.messageIds || null; // POST: selected IDs, GET: null (all)
    
    console.log('📦 ===== EXPORT HANDLER START =====');
    console.log('📦 Method:', req.method);
    console.log('📦 Book ID:', book_id);
    console.log('📦 Selected Message IDs:', selectedMessageIds);
    console.log('📦 Selected Count:', selectedMessageIds ? selectedMessageIds.length : 0);
    
    try {
        const client = req.dbClient || pool;
        
        // Verify book access
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const bookResult = await client.query(
            `SELECT id, name, output_credentials FROM ${tenantSchema}.books WHERE fractal_id = $1`,
            [book_id]
        );
        
        if (bookResult.rows.length === 0) {
            console.log('📦 ERROR: Book not found');
            return res.status(404).json({ error: 'Book not found in your tenant' });
        }
        
        const book = bookResult.rows[0];
        const outputCreds = book.output_credentials;
        console.log('📦 Book found:', book.name);
        console.log('📦 Output thread:', outputCreds?.output_01?.thread_id);
        
        // Fetch messages from Discord (output_01 - Ledger) using Thoth bot
        let messages = [];
        
        // Check if Thoth bot is ready
        if (!thothBot || !thothBot.client || !thothBot.ready) {
            console.log('📦 ERROR: Discord bot not ready');
            messages = [];
        } else {
            try {
                const threadId = outputCreds?.output_01?.thread_id;
                if (threadId) {
                    const channel = await thothBot.client.channels.fetch(threadId);
                    const fetchedMessages = await channel.messages.fetch({ limit: 100 });
                    console.log('📦 Fetched', fetchedMessages.size, 'messages from Discord');
                    
                    let allMessages = fetchedMessages.map(m => ({
                        id: m.id,
                        content: m.content,
                        author: m.author.username,
                        timestamp: m.createdAt.toISOString(),
                        embeds: m.embeds.map(e => ({
                            title: e.title,
                            description: e.description,
                            fields: e.fields
                        })),
                        attachments: m.attachments.map(a => ({
                            url: a.url,
                            filename: a.name,
                            size: a.size
                        }))
                    }));
                    
                    console.log('📦 Sample message:', {
                        id: allMessages[0]?.id,
                        content: allMessages[0]?.content?.substring(0, 50),
                        attachments: allMessages[0]?.attachments?.length
                    });
                    
                    // Filter to selected messages if POST request with messageIds
                    if (selectedMessageIds && selectedMessageIds.length > 0) {
                        const selectedSet = new Set(selectedMessageIds);
                        messages = allMessages.filter(m => selectedSet.has(m.id));
                        console.log('📦 Filtered to', messages.length, 'selected messages out of', allMessages.length);
                    } else {
                        messages = allMessages;
                        console.log('📦 Using all', messages.length, 'messages (no selection)');
                    }
                }
            } catch (err) {
                console.log('📦 ERROR fetching Discord messages:', err.message);
            }
        }
        
        // Fetch drops from PostgreSQL
        const dropsResult = await client.query(
            `SELECT * FROM ${tenantSchema}.drops WHERE book_id = $1 ORDER BY created_at DESC`,
            [book.id]
        );
        
        // Merge drops with messages
        const dropsMap = new Map();
        dropsResult.rows.forEach(drop => {
            dropsMap.set(drop.discord_message_id, drop);
        });
        
        const enrichedMessages = messages.map(msg => ({
            ...msg,
            metadata: dropsMap.get(msg.id) || null
        }));
        
        // Create export data
        const exportData = {
            book: {
                id: book_id,
                name: book.name,
                exported_at: new Date().toISOString()
            },
            messages: enrichedMessages,
            drops: dropsResult.rows,
            statistics: {
                total_messages: messages.length,
                total_drops: dropsResult.rows.length,
                messages_with_metadata: enrichedMessages.filter(m => m.metadata).length
            }
        };
        
        // Create ZIP archive
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        res.attachment(`${book.name.replace(/[^a-z0-9]/gi, '_')}_export.zip`);
        res.setHeader('Content-Type', 'application/zip');
        
        archive.pipe(res);
        
        // Add messages.json to ZIP
        archive.append(JSON.stringify(exportData, null, 2), { name: 'messages.json' });
        
        // Download and add attachments to ZIP
        let attachmentStats = { total: 0, downloaded: 0, failed: 0 };
        
        for (const msg of enrichedMessages) {
            if (msg.attachments && msg.attachments.length > 0) {
                // Format timestamp as YYYY-MM-DD/HhMMmSSs_GMTxx for folder organization
                const timestamp = new Date(msg.timestamp);
                const dateFolder = timestamp.toISOString().split('T')[0]; // YYYY-MM-DD
                const isoTime = timestamp.toISOString().split('T')[1].substring(0, 8); // HH:MM:SS
                const timeFolder = isoTime.replace(/:/g, '').replace(/(\d{2})(\d{2})(\d{2})/, '$1h$2m$3s'); // 7h38m07s
                
                // Get timezone offset
                const offset = -timestamp.getTimezoneOffset();
                const sign = offset >= 0 ? '+' : '-';
                const absOffset = Math.abs(offset);
                const tzHours = Math.floor(absOffset / 60);
                const tzMinutes = absOffset % 60;
                const tzString = `GMT${sign}${tzHours.toString().padStart(2, '0')}${tzMinutes > 0 ? ':' + tzMinutes.toString().padStart(2, '0') : ''}`;
                
                for (const attachment of msg.attachments) {
                    attachmentStats.total++;
                    try {
                        console.log(`📦 Downloading attachment: ${attachment.filename}`);
                        const response = await axios.get(attachment.url, { 
                            responseType: 'arraybuffer',
                            timeout: 30000 
                        });
                        
                        // Organize by timestamp with timezone: attachments/YYYY-MM-DD/HhMMmSSs_GMTxx/{filename}
                        const folderPath = `attachments/${dateFolder}/${timeFolder}_${tzString}/${attachment.filename}`;
                        archive.append(response.data, { name: folderPath });
                        attachmentStats.downloaded++;
                        console.log(`📦 Added to ZIP: ${folderPath}`);
                    } catch (err) {
                        attachmentStats.failed++;
                        console.log(`📦 Failed to download ${attachment.filename}: ${err.message}`);
                    }
                }
            }
        }
        
        // Add README with attachment info
        const readme = `# Your Nyanbook Export
        
Book: ${book.name}
Exported: ${new Date().toISOString()}

This archive contains:
- messages.json: All messages with drops metadata
  - ${messages.length} messages total
  - ${dropsResult.rows.length} metadata drops
  - ${enrichedMessages.filter(m => m.metadata).length} messages with metadata

- attachments/: Media files organized by timestamp
  - ${attachmentStats.downloaded} files downloaded
  - ${attachmentStats.failed} files failed to download
  - Total attempted: ${attachmentStats.total}

Folder Structure:
attachments/YYYY-MM-DD/HhMMmSSs_GMTxx/{filename}

Example:
  attachments/2025-12-07/7h38m07s_GMT+08/phi12.xlsx
  attachments/2025-12-07/6h46m03s_GMT+08/3x3+1.xlsx

Each attachment is organized by:
- Date (YYYY-MM-DD)
- Time (HhMMmSSs) with timezone (GMT+XX)
- Filename
`;
        archive.append(readme, { name: 'README.txt' });
        
        await archive.finalize();
        
        console.log(`📦 Export created for book ${book_id}: ${messages.length} messages, ${dropsResult.rows.length} drops`);
        
    } catch (error) {
        console.error('❌ Error creating export:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
};

// Register both GET (all messages) and POST (selected messages) routes
console.log('🔄 Registering export routes: GET/POST /api/books/:book_id/export');
app.get('/api/books/:book_id/export', requireAuth, setTenantContext, exportBookHandler);
app.post('/api/books/:book_id/export', requireAuth, setTenantContext, exportBookHandler);
console.log('✅ Export routes registered successfully');

// REMOVED: Duplicate QR endpoint - using the multi-instance version above (line ~2741)

// DISCORD-FIRST: Media stored in Discord threads, not PostgreSQL  
// Frontend should use Discord CDN URLs directly (from message.media_url)
app.get('/api/messages/:id/media', requireAuth, async (req, res) => {
    try {
        // Media is stored in Discord threads
        // The frontend should use message.media_url (Discord CDN URL) directly
        res.status(404).json({ 
            error: 'Media not available via this endpoint',
            note: 'Use message.media_url (Discord CDN URL) directly from message data'
        });
    } catch (error) {
        console.error(`❌ Error in /api/messages/:id/media:`, error);
        res.status(500).json({ error: error.message });
    }
});

// UNIFIED DISCORD MESSAGE FETCH: Schema switcheroo for 2 tabs, 2 databases
// Books Tab (source=user) → output_0n webhook (user choice: channel OR thread)
// Dev Panel (source=ledger) → output_01 webhook (always thread, dev-only, permanent)
app.get('/api/books/:id/messages', requireAuth, setTenantContext, async (req, res) => {
    try {
        const { id } = req.params; // fractal_id
        const client = req.dbClient || pool;
        let limit = parseInt(req.query.limit) || 50;
        const before = req.query.before; // Discord message ID for pagination
        const after = req.query.after; // For polling - get messages newer than this ID
        const around = req.query.around; // For jump-to-message - get context around this ID
        const context = parseInt(req.query.context) || 10; // Context window size (messages before + after)
        const source = req.query.source || 'user'; // Schema switcheroo: ledger|user
        
        // Input validation for jump-to-message and polling
        if (around && isNaN(Number(around))) {
            return res.status(400).json({ error: 'Invalid message ID for around parameter' });
        }
        if (after && isNaN(Number(after))) {
            return res.status(400).json({ error: 'Invalid message ID for after parameter' });
        }
        if (context < 0 || !Number.isInteger(context)) {
            return res.status(400).json({ error: 'Context must be a non-negative integer' });
        }
        if (context > 25) {
            return res.status(400).json({ error: 'Context window too large - maximum 25 messages' });
        }
        
        // ROLE GATE: Only dev users can access Ledger (source=ledger)
        if (source === 'ledger' && req.tenantContext?.userRole !== 'dev') {
            console.warn(`⚠️  Non-dev user ${req.userId} attempted to access Ledger messages`);
            return res.status(403).json({ 
                error: 'Access denied: Ledger messages are only accessible to dev role users'
            });
        }
        
        // Validate source parameter
        if (!['user', 'ledger'].includes(source)) {
            return res.status(400).json({ error: 'Invalid source parameter. Use: user or ledger' });
        }
        
        // Get book with thread info and creation timestamp
        // DEV ADMIN FIX: Use book registry to resolve cross-tenant access
        let tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const isDev = req.tenantContext?.userRole === 'dev';
        
        // For dev users, check registry first to find the correct tenant
        if (isDev) {
            const registryLookup = await client.query(
                `SELECT tenant_schema FROM core.book_registry WHERE fractal_id = $1 LIMIT 1`,
                [id]
            );
            
            if (registryLookup.rows.length > 0) {
                const registryTenant = registryLookup.rows[0].tenant_schema;
                console.log(`🔧 Dev user accessing book ${id} from ${registryTenant} (user tenant: ${tenantSchema})`);
                tenantSchema = registryTenant;
            }
        }
        
        const bookResult = await client.query(
            `SELECT id, name, output_credentials, created_at FROM ${tenantSchema}.books WHERE fractal_id = $1`,
            [id]
        );
        
        if (bookResult.rows.length === 0) {
            return res.status(404).json({ error: 'Book not found' });
        }
        
        const book = bookResult.rows[0];
        const bookCreatedAt = new Date(book.created_at);
        
        // Fetch creator_phone from book registry for is_creator comparison
        // FALLBACK: For pre-migration books, use phone_number when creator_phone is NULL
        let creatorPhone = null;
        const registryResult = await client.query(
            `SELECT creator_phone, phone_number FROM core.book_registry WHERE fractal_id = $1 LIMIT 1`,
            [id]
        );
        if (registryResult.rows.length > 0) {
            creatorPhone = registryResult.rows[0].creator_phone || registryResult.rows[0].phone_number;
        }
        
        // Parse JSON if needed
        let outputCredentials = book.output_credentials;
        if (typeof outputCredentials === 'string') {
            outputCredentials = JSON.parse(outputCredentials);
        }
        
        // ALWAYS FETCH FROM LEDGER (output_01): Bot has read access to Ledger thread only
        // output_0n is WEBHOOK-ONLY (write-only) - bot cannot read from user's Discord server
        // Messages sent to BOTH outputs, but fetched from Ledger only
        const outputData = outputCredentials?.output_01;
        const sourceName = source === 'ledger' ? 'Ledger (Dev Panel)' : 'User View (via Ledger)';
        
        console.log(`  📍 ${sourceName} fetching from output_01 (Ledger thread): ${outputData ? `${outputData.type} (${outputData.thread_id})` : 'none'}`);
        
        if (!outputData || !outputData.thread_id) {
            return res.json({ 
                messages: [], 
                total: 0,
                hasMore: false,
                note: 'No Ledger thread configured for this book yet. Create the book thread first.'
            });
        }
        
        // Fetch messages from Discord using Thoth (read-only bot)
        if (!thothBot || !thothBot.client || !thothBot.ready) {
            return res.json({ 
                messages: [], 
                total: 0,
                hasMore: false,
                note: 'Discord bot not ready - messages temporarily unavailable'
            });
        }
        
        try {
            // Fetch from Ledger thread (output_01 is always a thread)
            const threadId = outputData.thread_id;
            const thread = await thothBot.client.channels.fetch(threadId);
            
            if (!thread) {
                return res.json({ 
                    messages: [], 
                    total: 0,
                    hasMore: false,
                    note: `Ledger thread not found (ID: ${threadId})`
                });
            }
            
            // Fetch messages from Discord (force: true bypasses cache for real-time updates)
            const options = { force: true };
            
            // SMART FETCH: Support 3 modes - pagination, polling, and jump-to-message
            if (around) {
                // Jump-to-message mode: Fetch context window around target message
                // Discord API returns messages around the ID (half before, half after)
                options.around = around;
                options.limit = Math.min(context * 2 + 1, 51); // Ensure target is included (odd number)
                console.log(`  🎯 Jump mode: Fetching ${options.limit} messages around ${around}`);
            } else if (after) {
                // Polling mode: Fetch only NEW messages since last poll
                options.after = after;
                options.limit = 100; // Get up to 100 new messages
                console.log(`  🔄 Polling mode: Fetching messages after ${after}`);
            } else {
                // Normal pagination mode
                options.limit = limit;
                if (before) options.before = before;
            }
            
            const discordMessages = await thread.messages.fetch(options);
            
            console.log(`  🔍 Filtering messages: book created ${bookCreatedAt.toISOString()}, fetched ${discordMessages.size} messages`);
            
            // Transform Discord messages to UI format and filter by book creation time
            const messages = Array.from(discordMessages.values())
                .filter(msg => {
                    // Only show messages created AFTER the book was created
                    const isAfterCreation = msg.createdAt >= bookCreatedAt;
                    if (!isAfterCreation) {
                        console.log(`  ⏭️  Skipping legacy message from ${msg.createdAt.toISOString()} (before book creation)`);
                    }
                    return isAfterCreation;
                })
                .map(msg => {
                    const attachment = msg.attachments.size > 0 ? msg.attachments.first() : null;
                    
                    // TWILIO MEDIA: Parse "📎 Media" field from embeds (format: [content-type](url))
                    // Also extract sender_contact (📱 Phone) from embeds
                    let mediaFromEmbed = null;
                    let senderContact = null;
                    for (const embed of msg.embeds) {
                        const mediaField = embed.fields?.find(f => f.name === '📎 Media');
                        if (mediaField && mediaField.value) {
                            // Parse markdown link: [content-type](url)
                            const match = mediaField.value.match(/\[(.*?)\]\((.*?)\)/);
                            if (match) {
                                mediaFromEmbed = {
                                    url: match[2],
                                    contentType: match[1]
                                };
                            }
                        }
                        // Extract phone number from "📱 Phone" field
                        const phoneField = embed.fields?.find(f => f.name === '📱 Phone');
                        if (phoneField && phoneField.value) {
                            senderContact = phoneField.value;
                        }
                    }
                    
                    // DEBUG: Log attachment details for media messages
                    if (msg.attachments.size > 0) {
                        console.log(`  🖼️  Message ${msg.id} has ${msg.attachments.size} attachment(s):`, 
                            Array.from(msg.attachments.values()).map(a => ({
                                filename: a.name,
                                url: a.url.substring(0, 80),
                                contentType: a.contentType,
                                size: a.size
                            }))
                        );
                    } else if (mediaFromEmbed) {
                        console.log(`  📎 Message ${msg.id} has media from embed field: ${mediaFromEmbed.contentType}`);
                    } else {
                        console.log(`  📝 Message ${msg.id} has NO attachments (embeds: ${msg.embeds.length})`);
                    }
                    
                    // SERVER-SIDE is_creator: Compare sender phone against book's creator_phone
                    // Normalize phones by removing +, spaces, and non-digits for comparison
                    const normalizePhone = (phone) => phone ? phone.replace(/\D/g, '') : '';
                    const senderPhoneNorm = normalizePhone(senderContact);
                    const creatorPhoneNorm = normalizePhone(creatorPhone);
                    const isCreator = senderPhoneNorm && creatorPhoneNorm && senderPhoneNorm === creatorPhoneNorm;
                    
                    return {
                        id: msg.id,
                        sender_name: msg.author.username,
                        sender_avatar: msg.author.displayAvatarURL(),
                        sender_contact: senderContact,
                        is_creator: isCreator,
                        message_content: msg.content || '',
                        timestamp: msg.createdAt.toISOString(),
                        has_media: msg.attachments.size > 0 || !!mediaFromEmbed,
                        media_url: attachment ? attachment.url : (mediaFromEmbed ? mediaFromEmbed.url : null),
                        media_type: attachment ? attachment.contentType : (mediaFromEmbed ? mediaFromEmbed.contentType : null),
                        embeds: msg.embeds.map(e => ({
                            title: e.title === '🎉 Book Activated' ? e.title : null,
                            description: e.description,
                            color: e.color,
                            fields: e.fields ? e.fields.filter(f => f.name !== '📖 Book' && f.name !== '👤 Sender') : []
                        }))
                    };
                });
            
            res.json({ 
                messages,
                total: messages.length,
                hasMore: discordMessages.size === limit,
                oldestMessageId: messages.length > 0 ? messages[messages.length - 1].id : null
            });
        } catch (discordError) {
            console.error('❌ Failed to fetch from Discord:', discordError.message);
            return res.json({ 
                messages: [], 
                total: 0,
                hasMore: false,
                error: 'Failed to fetch messages from Discord: ' + discordError.message
            });
        }
    } catch (error) {
        console.error('❌ Error in /api/books/:id/messages:', error);
        res.status(500).json({ error: error.message });
    }
});

// DEPRECATED: Removed duplicate endpoint - use /api/books/:id/messages?source=ledger instead

// ===========================
// ONBOARDING API
// ===========================

// Get onboarding status
app.get('/api/onboarding/status', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT onboarding_completed, settings FROM user_settings WHERE user_id = $1',
            [req.userId]
        );
        
        if (result.rows.length === 0) {
            return res.json({ completed: false, state: {} });
        }
        
        res.json({
            completed: result.rows[0].onboarding_completed,
            state: result.rows[0].settings || {}
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Save onboarding progress
app.post('/api/onboarding/status', requireAuth, async (req, res) => {
    const { completed, state } = req.body;
    
    try {
        await pool.query(`
            INSERT INTO user_settings (user_id, onboarding_completed, settings)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id)
            DO UPDATE SET 
                onboarding_completed = $2,
                settings = $3,
                updated_at = NOW()
        `, [req.userId, completed || false, JSON.stringify(state || {})]);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===========================
// SERVER-SIDE MESSAGE SEARCH API
// Searches messages in Discord threads for uncached books
// ===========================

app.get('/api/search', requireAuth, async (req, res) => {
    const { term, bookIds } = req.query;
    
    if (!term || term.trim().length === 0) {
        return res.status(400).json({ error: 'Search term is required' });
    }
    
    const searchTerm = term.toLowerCase().trim();
    
    try {
        // PERMISSION MODEL: Follow same access as /api/books (not setTenantContext)
        // This ensures search works on any book the user can see in dashboard
        const tenantSchema = req.tenantSchema;
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        // Get user info for permission check
        const userResult = await pool.query(
            `SELECT id, email, tenant_id, is_genesis_admin FROM ${tenantSchema}.users WHERE id = $1`,
            [req.userId]
        );
        
        if (!userResult.rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userResult.rows[0];
        const hasExtendedAccess = req.userRole === 'dev' && user.is_genesis_admin;
        
        // Parse bookIds if provided (comma-separated list of fractal_ids to search)
        let targetBookIds = null;
        if (bookIds) {
            targetBookIds = bookIds.split(',').map(id => id.trim()).filter(id => id);
        }
        
        // EXHAUSTIVE SEARCH: Detect if this is a tag search (starts with #)
        const isTagSearch = searchTerm.startsWith('#');
        const tagQuery = isTagSearch ? searchTerm.slice(1) : searchTerm;
        
        // PERMISSION-AWARE: Query books based on user's access level (same as /api/books)
        let books = [];
        
        if (hasExtendedAccess) {
            // Dev users: query all tenant schemas (same as /api/books)
            const allSchemas = await getAllTenantSchemas(pool, req.userRole);
            
            for (const schemaRow of allSchemas) {
                const schemaName = schemaRow.tenant_schema;
                try {
                    let schemaQuery = `
                        SELECT fractal_id, name as book_name, output_credentials, created_at, tags
                        FROM ${schemaName}.books
                        WHERE status = 'active' AND archived = false
                    `;
                    const schemaParams = [];
                    
                    if (targetBookIds && targetBookIds.length > 0) {
                        schemaQuery += ` AND fractal_id = ANY($1)`;
                        schemaParams.push(targetBookIds);
                    }
                    
                    const schemaResult = await pool.query(schemaQuery, schemaParams);
                    books.push(...schemaResult.rows);
                } catch (error) {
                    // Skip schemas that fail
                }
            }
        } else {
            // Regular users: query their tenant's books (same as /api/books)
            let booksQuery = `
                SELECT fractal_id, name as book_name, output_credentials, created_at, tags
                FROM ${tenantSchema}.books
                WHERE status = 'active' AND archived = false
            `;
            const queryParams = [];
            
            if (targetBookIds && targetBookIds.length > 0) {
                booksQuery += ` AND fractal_id = ANY($1)`;
                queryParams.push(targetBookIds);
            }
            
            const booksResult = await pool.query(booksQuery, queryParams);
            books = booksResult.rows;
        }
        
        // EXHAUSTIVE SEARCH: First check book metadata (tags, name) for matches
        // This ensures tag searches find books even if Discord messages don't contain the tag
        const metadataMatches = new Set();
        for (const book of books) {
            // Check book name
            if ((book.book_name || '').toLowerCase().includes(tagQuery)) {
                metadataMatches.add(book.fractal_id);
                continue;
            }
            
            // Check tags (especially for hashtag searches)
            if (book.tags && Array.isArray(book.tags)) {
                const hasTagMatch = book.tags.some(tag => 
                    (tag || '').toLowerCase().includes(tagQuery)
                );
                if (hasTagMatch) {
                    metadataMatches.add(book.fractal_id);
                }
            }
        }
        
        if (books.length === 0) {
            return res.json({ matchingBooks: [] });
        }
        
        // Use books array instead of booksResult.rows
        const booksResult = { rows: books };
        
        // Check if Thoth bot is ready
        if (!thothBot || !thothBot.client || !thothBot.ready) {
            return res.json({ 
                matchingBooks: [],
                note: 'Discord bot not ready - search temporarily unavailable'
            });
        }
        
        const matchingBooks = [];
        let searchedCount = 0;
        const DISCORD_DELAY_MS = 150;   // Delay between Discord API calls to avoid 429s
        const TIMEOUT_MS = 5000;        // 5 second timeout per Discord call
        
        // Search each book's Discord thread for matches
        for (const book of booksResult.rows) {
            try {
                let outputCredentials = book.output_credentials;
                if (typeof outputCredentials === 'string') {
                    outputCredentials = JSON.parse(outputCredentials);
                }
                
                const outputData = outputCredentials?.output_01;
                if (!outputData || !outputData.thread_id) {
                    continue; // Skip books without Ledger thread
                }
                
                const threadId = outputData.thread_id;
                const bookCreatedAt = new Date(book.created_at);
                
                // Add delay between Discord API calls to avoid rate limits
                if (searchedCount > 0) {
                    await new Promise(resolve => setTimeout(resolve, DISCORD_DELAY_MS));
                }
                
                // Fetch thread with timeout
                let thread;
                try {
                    thread = await Promise.race([
                        thothBot.client.channels.fetch(threadId),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS))
                    ]);
                } catch (fetchError) {
                    console.warn(`⚠️  Thread fetch failed for ${book.fractal_id}: ${fetchError.message}`);
                    continue;
                }
                if (!thread) continue;
                
                // Fetch ALL messages from thread (paginate through all)
                let allMessages = [];
                let lastId = null;
                let fetchCount = 0;
                const maxFetches = 10; // Fetch up to 10 batches (1000+ messages)
                
                try {
                    while (fetchCount < maxFetches) {
                        const options = { limit: 100, force: true };
                        if (lastId) options.before = lastId;
                        
                        const batch = await Promise.race([
                            thread.messages.fetch(options),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS))
                        ]);
                        
                        if (batch.size === 0) break; // No more messages
                        
                        for (const msg of batch.values()) {
                            allMessages.push(msg);
                            lastId = msg.id;
                        }
                        
                        fetchCount++;
                    }
                } catch (fetchError) {
                    // Log but continue with what we have
                    console.warn(`⚠️  Partial message fetch for ${book.fractal_id}: ${fetchError.message} (got ${allMessages.length} msgs)`);
                }
                
                searchedCount++;
                
                // Search through all fetched messages
                let hasMatch = false;
                for (const msg of allMessages) {
                    // Skip messages before book creation
                    if (msg.createdAt < bookCreatedAt) continue;
                    
                    // Build searchable text from message
                    let searchableText = (msg.content || '').toLowerCase();
                    
                    // Add embed content
                    for (const embed of msg.embeds) {
                        if (embed.description) searchableText += ' ' + embed.description.toLowerCase();
                        if (embed.title) searchableText += ' ' + embed.title.toLowerCase();
                        if (embed.fields) {
                            for (const field of embed.fields) {
                                searchableText += ' ' + (field.name || '').toLowerCase();
                                searchableText += ' ' + (field.value || '').toLowerCase();
                            }
                        }
                    }
                    
                    // Add attachment filenames and content types
                    for (const attachment of msg.attachments.values()) {
                        if (attachment.name) searchableText += ' ' + attachment.name.toLowerCase();
                        if (attachment.contentType) searchableText += ' ' + attachment.contentType.toLowerCase();
                    }
                    
                    // Check for match
                    if (searchableText.includes(searchTerm)) {
                        hasMatch = true;
                        break;
                    }
                }
                
                if (hasMatch) {
                    matchingBooks.push(book.fractal_id);
                }
            } catch (bookError) {
                // Handle rate limits gracefully - stop search entirely but signal partial results
                if (bookError.message?.includes('429')) {
                    console.warn(`⚠️  Discord rate limited, returning partial results`);
                    // Merge metadata matches before returning
                    const allMatches = [...new Set([...matchingBooks, ...metadataMatches])];
                    return res.json({ 
                        matchingBooks: allMatches, 
                        partial: true, 
                        reason: 'Rate limited by Discord - some books not searched' 
                    });
                }
                console.warn(`⚠️  Search failed for book ${book.fractal_id}:`, bookError.message);
            }
        }
        
        // EXHAUSTIVE: Merge metadata matches with Discord message matches
        const allMatches = [...new Set([...matchingBooks, ...metadataMatches])];
        
        console.log(`🔍 Server search for "${term}": ${allMatches.length} matches (${matchingBooks.length} Discord + ${metadataMatches.size} metadata) from ${searchedCount} books searched`);
        
        res.json({ matchingBooks: allMatches, partial: false });
    } catch (error) {
        console.error('❌ Server search error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===========================
// ANALYTICS API
// ===========================

app.get('/api/analytics/daily', requireAuth, async (req, res) => {
    const { days = 30, book_id } = req.query;
    
    try {
        // Use tenant schema from requireAuth middleware (already set!)
        const tenantSchema = req.tenantSchema;
        if (!tenantSchema) {
            return res.status(500).json({ error: 'Tenant context not found' });
        }
        
        console.log(`📊 Analytics request from ${req.userEmail} (tenant: ${tenantSchema}, book: ${book_id || 'all'})`);
        
        // Build WHERE clause for book filter
        const bookFilter = book_id ? `AND book_id = ${parseInt(book_id)}` : '';
        
        // TENANT-AWARE: Get daily aggregates from tenant schema
        const result = await pool.query(`
            SELECT 
                date,
                SUM(total_messages) as total_messages,
                SUM(failed_messages) as failed_messages,
                SUM(rate_limit_events) as rate_limit_events,
                AVG(avg_response_time_ms) as avg_response_time_ms
            FROM ${tenantSchema}.message_analytics
            WHERE date >= CURRENT_DATE - $1::integer ${bookFilter}
            GROUP BY date
            ORDER BY date ASC
        `, [days]);
        
        // TENANT-AWARE: Get summary totals from tenant schema
        const summaryResult = await pool.query(`
            SELECT 
                COUNT(*) as total_messages,
                COUNT(*) FILTER (WHERE discord_status = 'failed') as failed_messages
            FROM ${tenantSchema}.messages
            WHERE timestamp >= CURRENT_DATE - $1::integer ${bookFilter}
        `, [days]);
        
        // TENANT-AWARE: Get rate limit events from tenant schema
        const rateLimitResult = await pool.query(`
            SELECT SUM(rate_limit_events) as rate_limit_events
            FROM ${tenantSchema}.message_analytics
            WHERE date >= CURRENT_DATE - $1::integer ${bookFilter}
        `, [days]);
        
        // Get book info if filtering by specific book
        let bookInfo = null;
        if (book_id) {
            const bookResult = await pool.query(`
                SELECT id, name, input_platform, output_platform
                FROM ${tenantSchema}.books
                WHERE id = $1
            `, [book_id]);
            bookInfo = bookResult.rows[0] || null;
        }
        
        console.log(`✅ Analytics data loaded: ${summaryResult.rows[0]?.total_messages || 0} total messages`);
        
        res.json({
            daily: result.rows,
            summary: {
                total_messages: parseInt(summaryResult.rows[0]?.total_messages || 0),
                failed_messages: parseInt(summaryResult.rows[0]?.failed_messages || 0),
                rate_limit_events: parseInt(rateLimitResult.rows[0]?.rate_limit_events || 0)
            },
            book: bookInfo
        });
    } catch (error) {
        console.error(`❌ Analytics error for user ${req.userId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Update analytics (called periodically or on message insert)
async function updateAnalytics(bookId, tenantSchema) {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE discord_status = 'failed') as failed
            FROM ${tenantSchema}.messages
            WHERE book_id = $1 AND DATE(timestamp) = $2
        `, [bookId, today]);
        
        await pool.query(`
            INSERT INTO ${tenantSchema}.message_analytics (date, book_id, total_messages, failed_messages)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (date, book_id)
            DO UPDATE SET
                total_messages = $3,
                failed_messages = $4
        `, [today, bookId, stats.rows[0].total, stats.rows[0].failed]);
    } catch (error) {
        console.error('Failed to update analytics:', error);
    }
}

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
    // Log unhandled rejections
    console.error('❌ Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
    // Log and exit for uncaught exceptions
    console.error('❌ Uncaught exception:', error);
    process.exit(1);
});

// Create Discord thread for output_01 (Nyanbook Ledger) manually
// Use this to fix books that didn't get threads during creation
app.post('/api/books/:id/create-thread', requireAuth, setTenantContext, async (req, res) => {
    try {
        const { id } = req.params; // fractal_id
        const client = req.dbClient || pool;
        const tenantSchema = req.tenantContext?.tenantSchema || req.tenantSchema;
        const tenantId = req.tenantContext?.tenantId;
        
        if (!tenantId) {
            return res.status(400).json({ error: 'Tenant context required' });
        }
        
        // Get book by fractal_id
        const book = await client.query(
            `SELECT id, name, output_01_url, output_credentials, tenant_id FROM ${tenantSchema}.books WHERE fractal_id = $1`,
            [id]
        );
        
        if (!book.rows.length) {
            return res.status(404).json({ error: 'Book not found' });
        }
        
        const bookData = book.rows[0];
        
        // Check if thread already exists
        let outputCredentials = bookData.output_credentials;
        if (typeof outputCredentials === 'string') {
            outputCredentials = JSON.parse(outputCredentials);
        }
        
        if (outputCredentials?.output_01?.thread_id) {
            return res.json({ 
                success: true, 
                message: 'Thread already exists',
                threadInfo: outputCredentials.output_01
            });
        }
        
        // Check Discord bot status
        if (!hermesBot || !hermesBot.isReady()) {
            return res.status(503).json({ 
                error: 'Discord bot not ready',
                note: 'Thread creation temporarily unavailable'
            });
        }
        
        // Create thread for output_01 (Nyanbook Ledger)
        console.log(`🧵 Creating output_01 thread for book ${id} (${bookData.name})...`);
        const threadInfo = await hermesBot.createThreadForBook(
            bookData.output_01_url,
            `${bookData.name} [Ledger]`,
            bookData.tenant_id,
            bookData.id
        );
        
        // Update output_credentials with output_01 thread info
        const updatedCredentials = {
            ...outputCredentials,
            output_01: {
                type: 'thread',
                thread_id: threadInfo.threadId,
                thread_name: threadInfo.threadName,
                channel_id: threadInfo.channelId
            }
        };
        
        await client.query(
            `UPDATE ${tenantSchema}.books 
             SET output_credentials = $1::jsonb
             WHERE fractal_id = $2`,
            [JSON.stringify(updatedCredentials), id]
        );
        
        // Send initial activation message to thread
        await hermesBot.sendInitialMessage(
            threadInfo.threadId, 
            bookData.name, 
            bookData.output_01_url
        );
        
        console.log(`✅ output_01 thread created: ${threadInfo.threadId}`);
        
        res.json({ 
            success: true, 
            message: 'Thread created successfully',
            threadInfo: updatedCredentials.output_01
        });
    } catch (error) {
        console.error('❌ Thread creation error:', error);
        res.status(500).json({ error: error.message });
    }
});


// ===========================
// AI PLAYGROUND API (Public, No Auth)
// Dynamic capacity sharing: distributes API quota among active IPs (180-min window)
// ===========================

const PLAYGROUND_GROQ_TOKEN = process.env.PLAYGROUND_GROQ_TOKEN;  // Text (Llama 3.3 70B)
const PLAYGROUND_GROQ_VISION_TOKEN = process.env.PLAYGROUND_GROQ_VISION_TOKEN || process.env.PLAYGROUND_GROQ_TOKEN;  // Vision (Llama 4 Scout) - fallback to text token

// Dynamic capacity manager with adaptive rate limiting
const capacityManager = require('./utils/playground-capacity');

// Usage tracking for internal scribe (token consumption visibility)
const usageTracker = require('./utils/playground-usage');

// Initialize exempt IPs from environment
const RATE_LIMIT_EXEMPT_IPS = [
    '127.0.0.1',
    '::1',
    ...(process.env.RATE_LIMIT_EXEMPT_IPS || '').split(',').map(ip => ip.trim()).filter(Boolean)
];
capacityManager.setExemptIPs(RATE_LIMIT_EXEMPT_IPS);
console.log(`🛡️ Capacity exempt IPs: ${RATE_LIMIT_EXEMPT_IPS.length} configured`);

// Exponential backoff retry for Groq 429 (rate limit)
async function groqWithRetry(axiosConfig, maxRetries = 3, serviceType = 'text') {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.post(axiosConfig.url, axiosConfig.data, axiosConfig.config);
            
            // Record usage from successful response
            if (response.data?.usage) {
                usageTracker.recordUsage(serviceType, response.data.usage);
            }
            
            return response;
        } catch (error) {
            lastError = error;
            
            // Detailed error logging for diagnosis
            const status = error.response?.status;
            const headers = error.response?.headers || {};
            const errorBody = error.response?.data;
            
            console.log(`🔴 Groq Error (attempt ${attempt + 1}/${maxRetries + 1}):`);
            console.log(`   Status: ${status}`);
            console.log(`   x-ratelimit-limit-requests: ${headers['x-ratelimit-limit-requests'] || 'N/A'}`);
            console.log(`   x-ratelimit-limit-tokens: ${headers['x-ratelimit-limit-tokens'] || 'N/A'}`);
            console.log(`   x-ratelimit-remaining-requests: ${headers['x-ratelimit-remaining-requests'] || 'N/A'}`);
            console.log(`   x-ratelimit-remaining-tokens: ${headers['x-ratelimit-remaining-tokens'] || 'N/A'}`);
            console.log(`   x-ratelimit-reset-requests: ${headers['x-ratelimit-reset-requests'] || 'N/A'}`);
            console.log(`   x-ratelimit-reset-tokens: ${headers['x-ratelimit-reset-tokens'] || 'N/A'}`);
            console.log(`   retry-after: ${headers['retry-after'] || 'N/A'}`);
            console.log(`   Error body: ${JSON.stringify(errorBody) || 'N/A'}`);
            
            // Also log prompt size for context
            const promptTokensEstimate = axiosConfig.data?.messages 
                ? JSON.stringify(axiosConfig.data.messages).length / 4 
                : 'unknown';
            console.log(`   Prompt size estimate: ~${Math.round(promptTokensEstimate)} tokens`);
            
            if (status === 429 && attempt < maxRetries) {
                // Use retry-after header if available, otherwise exponential backoff
                const retryAfter = headers['retry-after'];
                const delayMs = retryAfter 
                    ? parseInt(retryAfter) * 1000 
                    : Math.min(1000 * Math.pow(2, attempt), 8000);
                console.log(`⏳ Groq 429: Retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            } else {
                throw error;
            }
        }
    }
    throw lastError;
}

// H₀ PROTOCOL: temperature = 0.15 (sweet spot: 0.1 too rigid, 0.2 hallucinates)
const H0_TEMPERATURE = 0.15;

// ===== IMPROVEMENT 1: QUERY CLASSIFICATION (saves 0.8s latency) =====
// Regex patterns to route queries directly without Groq compression
const QUERY_PATTERNS = {
    // DDG-first: Simple factual queries (Wikipedia-style)
    ddgFirst: /^(what is|who is|what are|who are|define|meaning of|definition of|explain what|tell me about)\s/i,
    
    // Brave-first: Time-sensitive queries (skip DDG, go straight to Brave)
    braveFirst: /\b(latest|recent|today|yesterday|this week|this month|2024|2025|breaking|current|now|news|update|price today)\b/i,
    
    // Groq-only: Complex reasoning, calculations, or creative tasks (skip search entirely)
    groqOnly: /\b(calculate|compute|analyze|compare|summarize|write|create|generate|explain how|step by step|think about|reason|help me|code|program|solve)\b/i,
    
    // Nyan Protocol: Land/price/affordability topics (special handling, never cache)
    nyanProtocol: /\b(land price|price.*income|income.*price|affordability|housing cost|fertility|700.*m²|land.*afford|city.*collapse|empire|extinction|inequality|φ|cycle|breath|fatalism|optimism)\b/i
};

function classifyQuery(message) {
    const trimmed = message.trim();
    const isShort = trimmed.length < 80; // Only bypass compression for short queries
    
    // Check Nyan Protocol first (special handling, always use Groq extraction)
    if (QUERY_PATTERNS.nyanProtocol.test(trimmed)) {
        return { type: 'nyan', skipCache: true, searchStrategy: 'brave', skipCompression: false };
    }
    
    // Check if DDG-first (simple facts) - only skip compression if SHORT
    if (QUERY_PATTERNS.ddgFirst.test(trimmed) && isShort) {
        return { type: 'ddg-first', skipCache: false, searchStrategy: 'ddg', skipCompression: true };
    }
    
    // Check if Brave-first (time-sensitive) - still use search, just skip DDG
    if (QUERY_PATTERNS.braveFirst.test(trimmed)) {
        return { type: 'brave-first', skipCache: true, searchStrategy: 'brave', skipCompression: isShort };
    }
    
    // Check if Groq-only (complex reasoning) - but STILL allow search fallback
    if (QUERY_PATTERNS.groqOnly.test(trimmed)) {
        return { type: 'groq-only', skipCache: false, searchStrategy: 'cascade', skipCompression: false };
    }
    
    // Default: try DDG first, then Brave
    return { type: 'default', skipCache: false, searchStrategy: 'cascade', skipCompression: false };
}

// ===== IMPROVEMENT 2: FACTUAL RESPONSE CACHE (24h TTL) =====
// Cache simple factual queries to reduce Groq load
// NEVER cache: Nyan Protocol topics, calculations, time-sensitive queries
const factualCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function getCacheKey(message) {
    // Normalize: lowercase, trim, remove punctuation, collapse whitespace
    return message.toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
}

function getCachedResponse(message, queryClass) {
    // Never cache Nyan Protocol or time-sensitive queries
    if (queryClass.skipCache) {
        return null;
    }
    
    const key = getCacheKey(message);
    const cached = factualCache.get(key);
    
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`📦 Cache HIT for: "${message.substring(0, 40)}..." (age: ${Math.round((Date.now() - cached.timestamp) / 60000)}min)`);
        return cached.response;
    }
    
    if (cached) {
        // Expired, remove it
        factualCache.delete(key);
    }
    
    return null;
}

function setCachedResponse(message, response, queryClass) {
    // Never cache Nyan Protocol, time-sensitive, or complex queries
    if (queryClass.skipCache || queryClass.type === 'nyan' || queryClass.type === 'brave-first') {
        return;
    }
    
    // Only cache DDG-first queries (simple facts)
    if (queryClass.type !== 'ddg-first') {
        return;
    }
    
    const key = getCacheKey(message);
    factualCache.set(key, { response, timestamp: Date.now() });
    console.log(`📦 Cache SET for: "${message.substring(0, 40)}..." (cache size: ${factualCache.size})`);
    
    // Proper LRU eviction: keep only 1000 entries by removing oldest
    while (factualCache.size > 1000) {
        const oldestKey = factualCache.keys().next().value;
        factualCache.delete(oldestKey);
        console.log(`📦 Cache evicted oldest entry (limit: 1000)`);
    }
}

// Clean up expired cache entries every hour
setInterval(() => {
    const now = Date.now();
    let evicted = 0;
    for (const [key, value] of factualCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            factualCache.delete(key);
            evicted++;
        }
    }
    if (evicted > 0) {
        console.log(`📦 Cache cleanup: evicted ${evicted} expired entries`);
    }
}, 60 * 60 * 1000);

// ===== DOCUMENT CONTEXT CACHE (Two-Tier: Session + Global) =====
// Cache expensive document parsing/analysis, NOT the AI response
// AI output stays fresh; only the extracted context is cached
//
// SESSION CACHE: Immediate caching per IP (30min TTL) - for follow-up queries
// GLOBAL CACHE: 3-upload threshold (2h TTL) - for cross-session reuse

// Session cache: IP:fileHash -> context (immediate, 30min TTL)
const sessionDocumentCache = new Map();
const SESSION_DOC_TTL = 30 * 60 * 1000;  // 30 minutes of inactivity

// Global cache: fileHash -> context (3-upload threshold, 2h TTL)
const globalDocumentCache = new Map();
const documentUploadCounter = new Map();
const GLOBAL_DOC_TTL = 2 * 60 * 60 * 1000;  // 2 hours
const GLOBAL_CACHE_THRESHOLD = 3;            // Only global-cache after 3 uploads

function getDocumentHash(docData, docName) {
    // Use SHA-256 of full raw data + filename for collision-free hashing
    const crypto = require('crypto');
    const rawData = typeof docData === 'string' ? docData : JSON.stringify(docData);
    const hash = crypto.createHash('sha256')
        .update(docName + ':' + rawData)
        .digest('hex');
    return hash; // 64-char hex string, unique per document
}

function getSessionCacheKey(clientIp, fileHash) {
    return `${clientIp}:${fileHash}`;
}

function incrementDocumentUpload(fileHash) {
    const current = documentUploadCounter.get(fileHash) || 0;
    const newCount = current + 1;
    documentUploadCounter.set(fileHash, newCount);
    return newCount;
}

// Get cached context: check session first, then global
function getCachedDocumentContext(fileHash, clientIp) {
    const now = Date.now();
    
    // 1. Check session cache first (IP-specific, immediate)
    if (clientIp) {
        const sessionKey = getSessionCacheKey(clientIp, fileHash);
        const sessionCached = sessionDocumentCache.get(sessionKey);
        if (sessionCached && now - sessionCached.timestamp < SESSION_DOC_TTL) {
            // Refresh timestamp on access (sliding window)
            sessionCached.timestamp = now;
            console.log(`📂 Session Cache HIT: "${fileHash.substring(0, 16)}..." for ${clientIp}`);
            return sessionCached;
        }
        if (sessionCached) {
            sessionDocumentCache.delete(sessionKey);
        }
    }
    
    // 2. Check global cache (cross-session, 3-upload threshold)
    const globalCached = globalDocumentCache.get(fileHash);
    if (globalCached && now - globalCached.timestamp < GLOBAL_DOC_TTL) {
        console.log(`📂 Global Cache HIT: "${fileHash.substring(0, 16)}..." (age: ${Math.round((now - globalCached.timestamp) / 60000)}min)`);
        return globalCached;
    }
    if (globalCached) {
        globalDocumentCache.delete(fileHash);
        documentUploadCounter.delete(fileHash);
    }
    
    return null;
}

// Set cached context: always session (immediate), try global (3-upload threshold)
function setCachedDocumentContext(fileHash, context, clientIp) {
    const now = Date.now();
    
    // 1. Always cache in session (immediate, per-IP)
    if (clientIp) {
        const sessionKey = getSessionCacheKey(clientIp, fileHash);
        sessionDocumentCache.set(sessionKey, {
            ...context,
            timestamp: now,
            fileHash // Store hash for reference
        });
        console.log(`📂 Session Cache SET: "${fileHash.substring(0, 16)}..." for ${clientIp}`);
        
        // LRU eviction: max 500 session entries
        while (sessionDocumentCache.size > 500) {
            const oldestKey = sessionDocumentCache.keys().next().value;
            sessionDocumentCache.delete(oldestKey);
        }
    }
    
    // 2. Try global cache (respects 3-upload threshold)
    const uploadCount = documentUploadCounter.get(fileHash) || 0;
    if (uploadCount >= GLOBAL_CACHE_THRESHOLD) {
        globalDocumentCache.set(fileHash, {
            ...context,
            timestamp: now
        });
        console.log(`📂 Global Cache SET: "${fileHash.substring(0, 16)}..." (${uploadCount} uploads)`);
        
        // LRU eviction: max 100 global entries
        while (globalDocumentCache.size > 100) {
            const oldestKey = globalDocumentCache.keys().next().value;
            globalDocumentCache.delete(oldestKey);
            documentUploadCounter.delete(oldestKey);
        }
    }
    
    return true;
}

// Get cached context by hash only (for follow-up queries with cached file reference)
function getCachedDocumentByHash(fileHash, clientIp) {
    return getCachedDocumentContext(fileHash, clientIp);
}

// Clean up expired cache entries
setInterval(() => {
    const now = Date.now();
    let sessionEvicted = 0, globalEvicted = 0;
    
    // Clean session cache
    for (const [key, value] of sessionDocumentCache.entries()) {
        if (now - value.timestamp > SESSION_DOC_TTL) {
            sessionDocumentCache.delete(key);
            sessionEvicted++;
        }
    }
    
    // Clean global cache
    for (const [key, value] of globalDocumentCache.entries()) {
        if (now - value.timestamp > GLOBAL_DOC_TTL) {
            globalDocumentCache.delete(key);
            documentUploadCounter.delete(key);
            globalEvicted++;
        }
    }
    
    if (sessionEvicted > 0 || globalEvicted > 0) {
        console.log(`📂 Cache cleanup: ${sessionEvicted} session + ${globalEvicted} global entries evicted`);
    }
}, 10 * 60 * 1000); // Every 10 minutes

// ===== DUCKDUCKGO SEARCH FUNCTION =====
async function searchDuckDuckGo(query) {
    const params = {
        q: query,
        format: 'json',
        no_html: 1,
        skip_disambig: 1,
        t: 'nyanbook'
    };
    const url = `https://api.duckduckgo.com/?${querystring.stringify(params)}`;
    
    try {
        const response = await axios.get(url, { timeout: 5000 });
        const data = response.data;
        
        // Extract instant answer + top 3 related topics
        const context = [];
        if (data.AbstractText) {
            context.push(`📚 ${data.AbstractText}`);
            console.log(`🔍 DDG: Found instant answer for "${query.substring(0, 40)}..."`);
        }
        if (data.RelatedTopics && data.RelatedTopics.length > 0) {
            const relevantTopics = data.RelatedTopics.filter(t => t.Text && !t.FirstURL).slice(0, 3);
            if (relevantTopics.length > 0) {
                context.push('Related information:');
                relevantTopics.forEach(topic => {
                    if (topic.Text) context.push(`  • ${topic.Text}`);
                });
            }
        }
        
        if (context.length > 0) {
            console.log(`🔍 DDG: Injecting ${context.length} search results into prompt`);
            return context.join('\n');
        } else {
            console.log(`🔍 DDG: No results found for "${query.substring(0, 40)}..." - using base knowledge only`);
            return null;
        }
    } catch (err) {
        console.error('🔍 DDG search error:', err.message);
        return null;
    }
}

// ===== QUERY EXTRACTION (Compress long messages to core question) =====
async function extractCoreQuestion(message) {
    const GROQ_TOKEN = process.env.PLAYGROUND_GROQ_TOKEN;
    if (!GROQ_TOKEN || message.length < 100) {
        return message.substring(0, 200);
    }
    
    // Check if message is NYAN protocol (land/city/price related)
    const isNyanProtocol = /\{money|city|land price|empire|collapse|extinction|inequality|φ|cycle|breath\}/i.test(message) ||
        /price.*income|land.*afford|fertility|700.*m²|housing.*cost/i.test(message);
    
    try {
        console.log(`🧠 Extracting core question from ${message.length} char message...`);
        const systemPrompt = isNyanProtocol 
            ? 'Extract the core question about land price, housing affordability, or city cost. Include "50 years ago" or "historical" to get comparative data. Return ONLY a short search query (max 30 words). No explanation.'
            : 'Extract the core question or topic from the user message. Return ONLY a short search query (max 25 words) that captures what they want to know. No explanation, just the query.';
        
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'llama-3.3-70b-versatile',
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt
                    },
                    { role: 'user', content: message.substring(0, 1000) }
                ],
                temperature: 0.1,
                max_tokens: 40
            },
            {
                headers: {
                    'Authorization': `Bearer ${GROQ_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                timeout: 3000
            }
        );
        
        const extractedQuery = response.data?.choices?.[0]?.message?.content?.trim();
        if (extractedQuery && extractedQuery.length > 3) {
            console.log(`🧠 Extracted query: "${extractedQuery}"`);
            // If protocol query, ensure it searches both current AND historical
            if (isNyanProtocol && !extractedQuery.toLowerCase().includes('ago') && !extractedQuery.toLowerCase().includes('historical')) {
                const enhancedQuery = extractedQuery + ' vs 50 years ago';
                console.log(`🧠 Enhanced with historical: "${enhancedQuery}"`);
                return enhancedQuery;
            }
            return extractedQuery;
        }
        return message.substring(0, 200);
    } catch (err) {
        console.error('🧠 Query extraction error:', err.message);
        return message.substring(0, 200);
    }
}

// ===== BRAVE SEARCH FUNCTION (Fallback for real-time data) =====
async function searchBrave(query, clientIp = null) {
    const BRAVE_API_KEY = process.env.PLAYGROUND_BRAVE_API;
    if (!BRAVE_API_KEY) {
        console.log('🦁 Brave: API key not configured, skipping');
        return null;
    }
    
    // Check brave capacity if IP provided
    if (clientIp) {
        const braveCapacity = await capacityManager.consumeToken(clientIp, 'brave');
        if (!braveCapacity.allowed) {
            console.log(`🦁 Brave: Capacity exhausted for ${clientIp} - ${braveCapacity.reason}`);
            return null;
        }
    }
    
    try {
        console.log(`🦁 Brave: Searching for real-time context: "${query.substring(0, 40)}..."`);
        const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
            headers: {
                'Accept': 'application/json',
                'X-Subscription-Token': BRAVE_API_KEY
            },
            params: {
                q: query,
                count: 5,
                text_decorations: false,
                safesearch: 'moderate'
            },
            timeout: 5000
        });
        
        const results = response.data?.web?.results || [];
        if (results.length === 0) {
            console.log(`🦁 Brave: No results found for "${query.substring(0, 40)}..."`);
            return null;
        }
        
        const context = results.slice(0, 5).map((r, i) => 
            `${i + 1}. ${r.title}\n   ${r.description || ''}`
        ).join('\n\n');
        
        console.log(`🦁 Brave: Found ${results.length} results, injecting top 5 into prompt`);
        return `🌐 Web search results:\n${context}`;
    } catch (err) {
        console.error('🦁 Brave search error:', err.message);
        return null;
    }
}

// Internal scribe: Token usage visibility (no auth required - dev tool)
app.get('/api/playground/usage', (req, res) => {
    try {
        const stats = usageTracker.getAllUsageStats();
        res.json(stats);
    } catch (error) {
        console.error('❌ Usage stats error:', error.message);
        res.status(500).json({ error: 'Failed to get usage stats' });
    }
});

app.post('/api/playground', async (req, res) => {
    const clientIp = req.ip || req.connection.remoteAddress;
    
    // Record activity for capacity sharing (180-min window)
    capacityManager.recordActivity(clientIp);
    
    try {
        let { message, photo, audio, document, documentName, photos, audios, documents, history, zipData, contextAttachments, cachedFileHashes } = req.body;
        let finalPrompt = message || '';
        let extractedContent = [];
        
        // Track file hashes for this response (sent back to client for follow-up queries)
        const responseFileHashes = [];
        
        // Extract attachments from ZIP if present (bandwidth optimization)
        if (zipData) {
            try {
                const zipBuffer = Buffer.from(zipData, 'base64');
                const zip = await JSZip.loadAsync(zipBuffer);
                const manifestFile = zip.file('manifest.json');
                
                if (manifestFile) {
                    const manifestContent = await manifestFile.async('string');
                    const manifest = JSON.parse(manifestContent);
                    
                    // Initialize arrays if not present
                    photos = photos || [];
                    audios = audios || [];
                    documents = documents || [];
                    
                    // Extract each file based on manifest
                    for (const entry of manifest) {
                        const fileContent = await zip.file(entry.filename)?.async('base64');
                        if (!fileContent) continue;
                        
                        const dataUrl = `data:${entry.mimeType};base64,${fileContent}`;
                        
                        if (entry.type === 'photo') {
                            photos.push(dataUrl);
                        } else if (entry.type === 'audio') {
                            audios.push(dataUrl);
                        } else if (entry.type === 'document') {
                            documents.push({ data: dataUrl, name: entry.originalName });
                        }
                    }
                    
                    console.log(`📦 Extracted from ZIP: ${photos.length} photos, ${audios.length} audios, ${documents.length} docs`);
                }
            } catch (zipErr) {
                console.error('❌ ZIP extraction failed:', zipErr.message);
                // Continue with any existing attachments
            }
        }
        
        // Abuse detection (burst, duplicate, gibberish)
        const abuseCheck = capacityManager.checkAbuse(clientIp, message);
        if (abuseCheck.abusive) {
            console.log(`🚫 Abuse detected from ${clientIp}: ${abuseCheck.reason}`);
            return res.status(429).json({ reply: abuseCheck.message });
        }
        
        // Normalize to arrays (support both single and multi-file)
        let photoList = photos || (photo ? [photo] : []);
        let audioList = audios || (audio ? [audio] : []);
        let docList = documents || (document ? [{ data: document, name: documentName }] : []);
        
        // Deduplicate attachments by content hash (saves rate limit tokens)
        const hashData = (data) => {
            const sample = typeof data === 'string' ? data.substring(0, 500) + data.length : JSON.stringify(data).substring(0, 500);
            return sample;
        };
        
        // Dedupe photos by data hash
        const photoSeen = new Set();
        const uniquePhotos = [];
        for (const p of photoList) {
            const hash = hashData(p);
            if (!photoSeen.has(hash)) {
                photoSeen.add(hash);
                uniquePhotos.push(p);
            }
        }
        if (uniquePhotos.length < photoList.length) {
            console.log(`📎 Deduped photos: ${photoList.length} → ${uniquePhotos.length}`);
        }
        photoList = uniquePhotos;
        
        // Dedupe audio by data hash
        const audioSeen = new Set();
        const uniqueAudios = [];
        for (const a of audioList) {
            const hash = hashData(a);
            if (!audioSeen.has(hash)) {
                audioSeen.add(hash);
                uniqueAudios.push(a);
            }
        }
        if (uniqueAudios.length < audioList.length) {
            console.log(`📎 Deduped audio: ${audioList.length} → ${uniqueAudios.length}`);
        }
        audioList = uniqueAudios;
        
        // Dedupe documents by name + data hash
        const docSeen = new Set();
        const uniqueDocs = [];
        for (const d of docList) {
            const hash = (d.name || '') + ':' + hashData(d.data);
            if (!docSeen.has(hash)) {
                docSeen.add(hash);
                uniqueDocs.push(d);
            }
        }
        if (uniqueDocs.length < docList.length) {
            console.log(`📎 Deduped docs: ${docList.length} → ${uniqueDocs.length}`);
        }
        docList = uniqueDocs;
        
        // Validation
        if (!message?.trim() && photoList.length === 0 && audioList.length === 0 && docList.length === 0) {
            return res.status(400).json({ 
                reply: 'Please enter text or upload a photo, audio, or document file.' 
            });
        }
        
        // Enforce max 10 total attachments
        const totalAttachments = photoList.length + audioList.length + docList.length;
        if (totalAttachments > 10) {
            return res.status(400).json({ 
                reply: 'Maximum 10 attachments allowed.' 
            });
        }
        
        // Build conversation history, filtering out non-message fields
        const conversationHistory = Array.isArray(history) 
            ? history.filter(msg => msg && typeof msg === 'object' && msg.role && msg.content)
            : [];
        
        // OPTIMIZED SEARCH CASCADE with Query Classification + Caching
        let searchContext = null;
        let queryClass = { type: 'default', skipCache: false, searchStrategy: 'cascade' };
        let noSearchDisclaimer = false;
        
        // CLOSED-LOOP DETECTION: Skip web search for document analysis
        // Financial documents (Excel, PDF) contain user's own data - nothing to verify externally
        const isClosedLoopAnalysis = docList.length > 0;
        if (isClosedLoopAnalysis) {
            queryClass.searchStrategy = 'none';
            console.log(`📎 Document analysis mode: Skipping web search (closed-loop)`);
        }
        
        if (message) {
            // Step 0: Classify query to determine optimal routing
            queryClass = classifyQuery(message);
            
            // Override: Force 'none' for document analysis (closed-loop)
            if (isClosedLoopAnalysis) {
                queryClass.searchStrategy = 'none';
            }
            console.log(`🎯 Query classified as: ${queryClass.type} (strategy: ${queryClass.searchStrategy})`);
            
            // Step 0.5: Check cache for simple factual queries
            const cachedResponse = getCachedResponse(message, queryClass);
            if (cachedResponse) {
                console.log(`✅ Returning cached response (saved Groq call)`);
                return res.json({ reply: cachedResponse });
            }
            
            // Step 1: Route based on classification (saves 0.8s Groq compression for SHORT simple queries)
            let searchQuery;
            if (queryClass.skipCompression) {
                // Direct routing for short simple queries
                searchQuery = message.substring(0, 200);
                console.log(`⚡ Direct routing (skipped Groq compression): "${searchQuery.substring(0, 50)}..."`);
            } else {
                // Use Groq extraction for long/complex queries
                searchQuery = await extractCoreQuestion(message);
                console.log(`🔍 Playground: Searching for: "${searchQuery.substring(0, 50)}..."`);
            }
            
            // Step 2: Execute search based on strategy (skip for 'none' = closed-loop)
            if (searchQuery && queryClass.searchStrategy !== 'none') {
                if (queryClass.searchStrategy === 'ddg') {
                    // DDG-first: try DDG, fallback to Brave
                    searchContext = await searchDuckDuckGo(searchQuery);
                    if (!searchContext) {
                        console.log(`🔄 DDG returned nothing, trying Brave fallback...`);
                        searchContext = await searchBrave(searchQuery, clientIp);
                    }
                } else if (queryClass.searchStrategy === 'brave') {
                    // Brave-first: skip DDG for time-sensitive/Nyan queries
                    console.log(`⚡ Brave-first mode (${queryClass.type})`);
                    searchContext = await searchBrave(searchQuery, clientIp);
                    // Smart retry: if Brave returned nothing, try DDG
                    if (!searchContext) {
                        console.log(`🔄 Brave returned nothing, trying DDG fallback...`);
                        searchContext = await searchDuckDuckGo(searchQuery);
                    }
                } else {
                    // Default cascade: DDG → Brave
                    searchContext = await searchDuckDuckGo(searchQuery);
                    if (!searchContext) {
                        console.log(`🔄 DDG returned nothing, trying Brave fallback...`);
                        searchContext = await searchBrave(searchQuery, clientIp);
                    }
                }
                
                // Smart retry: if all search failed, try simplified query on DDG
                if (!searchContext) {
                    const coreWords = searchQuery.split(/\s+/).slice(0, 5).join(' ');
                    console.log(`🔄 All search failed, trying DDG with core words: "${coreWords}"`);
                    searchContext = await searchDuckDuckGo(coreWords);
                }
            }
            
            // Inject context or add disclaimer
            if (searchContext) {
                finalPrompt = `Context from web search:\n${searchContext}\n\nUser query: ${message}`;
                console.log(`✅ Search context injected into prompt for knowledge augmentation`);
            } else if (queryClass.searchStrategy !== 'none') {
                // No search results - add disclaimer about knowledge cutoff
                noSearchDisclaimer = true;
                console.log(`⚠️ No search results - will add knowledge cutoff disclaimer`);
            }
        }
        
        // File size limits (base64 encoded)
        for (const p of photoList) {
            const photoSizeKB = (p.length * 3) / 4 / 1024;
            if (photoSizeKB > 5000) {
                return res.status(400).json({ 
                    reply: 'Photo too large. Maximum size is 5MB per file.' 
                });
            }
        }
        
        for (const a of audioList) {
            const audioSizeKB = (a.length * 3) / 4 / 1024;
            if (audioSizeKB > 10000) {
                return res.status(400).json({ 
                    reply: 'Audio too large. Maximum size is 10MB per file.' 
                });
            }
        }
        
        // Process all photos via Groq Llama 4 Scout Vision
        if (photoList.length > 0) {
            if (!PLAYGROUND_GROQ_VISION_TOKEN) {
                return res.status(503).json({ 
                    reply: 'Photo analysis is not configured. Please try text only.' 
                });
            }
            
            console.log(`🎮 Playground: Analyzing ${photoList.length} photo(s) via Groq Vision for ${clientIp}`);
            
            // LaTeX OCR Enhancement: Detect and extract equations for pharmacy/research users
            const LATEX_ENHANCEMENT = `
IF you see LaTeX math notation (\\frac, \\sum, \\int, \\begin{align}, \\ce{}, chemical formulas, greek letters):
- Extract the raw LaTeX code exactly as written
- Also provide the human-readable rendered form
- Example: \\ce{C21H30O2} → Output both: "LaTeX: \\ce{C21H30O2}" AND "Rendered: C₂₁H₃₀O₂ (Tetrahydrocannabinol)"
- Example: \\frac{d}{dx} → Output both: "LaTeX: \\frac{d}{dx}" AND "Rendered: d/dx (derivative)"
- For chemical structures, identify the compound name if recognizable
`;
            
            const visionPrompt = message 
                ? `${message}\n\n${LATEX_ENHANCEMENT}`
                : `Extract all text exactly from this image. Describe the image factually. If this is a receipt, plate, or sign, output structured text.\n\n${LATEX_ENHANCEMENT}`;
            
            for (let i = 0; i < photoList.length; i++) {
                const photoData = photoList[i];
                
                // Check vision capacity (dynamic sharing among active IPs)
                const visionCapacity = await capacityManager.consumeToken(clientIp, 'vision');
                if (!visionCapacity.allowed) {
                    const replenishMsg = capacityManager.getNyanRestMessage(visionCapacity.replenishMinutes || 1);
                    extractedContent.push(`[Photo ${i + 1}]: ${replenishMsg}`);
                    console.log(`⏸️ Photo ${i + 1} skipped: capacity exhausted, replenish in ${visionCapacity.replenishMinutes}min`);
                    continue;
                }
                
                // Preserve original MIME type from data URL
                let imageUrl = photoData;
                if (!photoData.startsWith('data:')) {
                    imageUrl = `data:image/jpeg;base64,${photoData}`;
                }
                
                try {
                    const visionResponse = await groqWithRetry({
                        url: 'https://api.groq.com/openai/v1/chat/completions',
                        data: {
                            model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                            messages: [
                                { 
                                    role: 'system', 
                                    content: `You are an expert image analyst with special expertise in scientific notation.

CORE DUTIES:
1. Extract all text exactly as shown
2. Describe images factually
3. For Indonesian text (receipts, plates, signs), output structured text

LATEX/CHEMISTRY EXPERTISE:
- Detect LaTeX equations: \\frac, \\int, \\sum, \\begin{equation}, \\ce{}, greek letters (α, β, γ, Δ)
- Extract both RAW LaTeX code AND human-readable form
- Identify chemical compounds: molecular formulas → common names
- For hand-drawn structures: describe bonds, functional groups, attempt identification

EXAMPLES:
- "\\ce{C8H10N4O2}" → "Caffeine (C₈H₁₀N₄O₂)"
- "\\frac{\\partial f}{\\partial x}" → "∂f/∂x (partial derivative)"
- Benzene ring sketch → "Benzene ring structure (C₆H₆)"

No hallucinations. If uncertain, say "possibly" or "structure resembles".` 
                                },
                                { 
                                    role: 'user', 
                                    content: [
                                        { type: 'text', text: visionPrompt },
                                        { type: 'image_url', image_url: { url: imageUrl } }
                                    ] 
                                }
                            ],
                            temperature: H0_TEMPERATURE,
                            max_tokens: 500
                        },
                        config: {
                            headers: {
                                'Authorization': `Bearer ${PLAYGROUND_GROQ_VISION_TOKEN}`,
                                'Content-Type': 'application/json'
                            },
                            timeout: 30000
                        }
                    }, 2, 'vision');
                    
                    const photoDescription = visionResponse.data.choices?.[0]?.message?.content || 'Unable to analyze image';
                    extractedContent.push(`[Photo ${i + 1}]: ${photoDescription}`);
                    
                } catch (visionError) {
                    console.error(`❌ Photo ${i + 1} vision error:`, visionError.response?.data || visionError.message);
                    
                    if (visionError.response?.status === 429) {
                        extractedContent.push(`[Photo ${i + 1}]: Vision API rate limited`);
                    } else {
                        extractedContent.push(`[Photo ${i + 1}]: Analysis failed`);
                    }
                }
            }
        }
        
        // ===== CACHED FILE REFERENCES: Use session cache for follow-up queries =====
        // If user sends cachedFileHashes without new uploads, retrieve from session cache
        if (cachedFileHashes && Array.isArray(cachedFileHashes) && cachedFileHashes.length > 0 && docList.length === 0) {
            console.log(`📂 Follow-up query with ${cachedFileHashes.length} cached file reference(s)`);
            const extractedDocs = [];
            
            for (const fileHash of cachedFileHashes) {
                const cachedContext = getCachedDocumentByHash(fileHash, clientIp);
                if (cachedContext) {
                    extractedDocs.push({
                        fileName: cachedContext.fileName || 'cached-document',
                        fileType: cachedContext.fileType,
                        text: cachedContext.text,
                        fileHash: fileHash,
                        fromCache: true
                    });
                    responseFileHashes.push(fileHash);
                    console.log(`📂 Retrieved cached context for hash "${fileHash.substring(0, 16)}..."`);
                } else {
                    console.log(`📂 Cache miss for hash "${fileHash.substring(0, 16)}..." - may have expired`);
                }
            }
            
            if (extractedDocs.length > 0) {
                if (extractedDocs.length > 1) {
                    const mergedContext = buildMultiDocContext(extractedDocs);
                    extractedContent.push(mergedContext);
                } else {
                    extractedContent.push(`[Document (cached): ${extractedDocs[0].fileName}]:\n${extractedDocs[0].text}`);
                }
                console.log(`📂 Using ${extractedDocs.length} cached document(s) for follow-up query`);
            }
        }
        
        // Process all documents with CASCADE WORKFLOW + CONTEXT CACHING
        // Cache the expensive parsing/analysis; AI output stays fresh
        if (docList.length > 0) {
            if (!PLAYGROUND_GROQ_TOKEN) {
                return res.status(503).json({ 
                    reply: 'Document analysis is not configured. Please try text only.' 
                });
            }
            
            console.log(`🎮 Playground: Processing ${docList.length} document(s) for ${clientIp}`);
            
            // Collect all extracted documents for multi-doc context merge
            const extractedDocs = [];
            
            for (let i = 0; i < docList.length; i++) {
                const doc = docList[i];
                const docData = doc.data;
                const docName = doc.name || `document-${i + 1}`;
                
                // Compute file hash for caching
                const fileHash = getDocumentHash(docData, docName);
                const uploadCount = incrementDocumentUpload(fileHash);
                console.log(`📂 Document ${i + 1}: upload #${uploadCount} for hash "${fileHash.substring(0, 25)}..."`);
                
                // Check cache first (skip expensive parsing if cached)
                // Session cache (per-IP) is checked first, then global cache
                const cachedContext = getCachedDocumentContext(fileHash, clientIp);
                if (cachedContext) {
                    // Use cached context - skip expensive parsing
                    doc.extractedData = cachedContext.extractedData;
                    doc.extracted = cachedContext.extracted; // For financial analysis
                    doc.fileHash = fileHash; // Store hash for follow-up reference
                    extractedDocs.push({
                        fileName: docName,
                        fileType: cachedContext.fileType,
                        text: cachedContext.text,
                        fileHash: fileHash,
                        fromCache: true
                    });
                    console.log(`📂 Using cached context for "${docName}"`);
                    continue;
                }
                
                // No cache hit - do expensive parsing
                try {
                    const base64Data = docData.split(',')[1] || docData;
                    const buffer = Buffer.from(base64Data, 'base64');
                    
                    const fileType = identifyFileType(docName);
                    console.log(`📋 Document ${i + 1}: ${fileType.type} (${fileType.extension})`);
                    
                    const cascadeResult = await executeExtractionCascade(buffer, fileType, docName, {
                        imagePrompt: message || 'Describe this image in detail. Extract any text, numbers, or data visible.'
                    });
                    
                    doc.extractedData = cascadeResult.jsonOutput || null;
                    
                    let docContent = '[Could not extract content]';
                    if (cascadeResult.success && cascadeResult.jsonOutput) {
                        docContent = formatJSONForGroq(cascadeResult, '');
                    }
                    
                    doc.fileHash = fileHash; // Store hash for follow-up reference
                    extractedDocs.push({
                        fileName: docName,
                        fileType: fileType.type,
                        text: docContent,
                        fileHash: fileHash
                    });
                    
                    // Cache the context: session (immediate) + global (3-upload threshold)
                    setCachedDocumentContext(fileHash, {
                        extractedData: doc.extractedData,
                        extracted: doc.extracted,
                        fileType: fileType.type,
                        text: docContent
                    }, clientIp);
                    
                } catch (docError) {
                    console.error(`❌ Document ${i + 1} error:`, docError.message);
                    extractedDocs.push({
                        fileName: docName,
                        fileType: 'error',
                        text: `[Error: ${docError.message}]`
                    });
                }
            }
            
            // Use multi-doc context merge for corporate multi-attachment queries
            if (extractedDocs.length > 1) {
                const mergedContext = buildMultiDocContext(extractedDocs);
                extractedContent.push(mergedContext);
                const cachedCount = extractedDocs.filter(d => d.fromCache).length;
                console.log(`📦 Multi-Doc: Merged ${extractedDocs.length} documents (${cachedCount} from cache)`);
            } else if (extractedDocs.length === 1) {
                // Single document - use simple format
                const cacheNote = extractedDocs[0].fromCache ? ' (cached)' : '';
                extractedContent.push(`[Document 1: ${extractedDocs[0].fileName}${cacheNote}]:\n${extractedDocs[0].text}`);
            }
            
            // Collect file hashes for response (client uses these for follow-up queries)
            extractedDocs.forEach(d => {
                if (d.fileHash) responseFileHashes.push(d.fileHash);
            });
        }
        
        // Process all audio files via Groq Whisper
        if (audioList.length > 0) {
            if (!PLAYGROUND_GROQ_TOKEN) {
                return res.status(503).json({ 
                    reply: 'Audio transcription is not configured. Please try text only.' 
                });
            }
            
            console.log(`🎮 Playground: Transcribing ${audioList.length} audio file(s) for ${clientIp}`);
            const FormData = require('form-data');
            
            for (let i = 0; i < audioList.length; i++) {
                const audioData = audioList[i];
                
                try {
                    const base64Data = audioData.split(',')[1] || audioData;
                    const audioBuffer = Buffer.from(base64Data, 'base64');
                    
                    const formData = new FormData();
                    formData.append('file', audioBuffer, {
                        filename: 'audio.webm',
                        contentType: 'audio/webm'
                    });
                    formData.append('model', 'whisper-large-v3-turbo');
                    formData.append('response_format', 'json');
                    
                    const whisperResponse = await axios.post(
                        'https://api.groq.com/openai/v1/audio/transcriptions',
                        formData,
                        {
                            headers: {
                                ...formData.getHeaders(),
                                'Authorization': `Bearer ${PLAYGROUND_GROQ_TOKEN}`
                            },
                            timeout: 30000
                        }
                    );
                    
                    const transcript = whisperResponse.data.text || '';
                    extractedContent.push(`[Audio ${i + 1}]: "${transcript}"`);
                    
                } catch (audioError) {
                    console.error(`❌ Audio ${i + 1} error:`, audioError.message);
                    extractedContent.push(`[Audio ${i + 1}]: Transcription failed`);
                }
            }
        }
        
        // Build attachment context for memory (metadata from previous uploads)
        let attachmentContextPart = '';
        if (contextAttachments && contextAttachments.length > 0) {
            const attachmentList = contextAttachments
                .flatMap(item => item.attachments || [])
                .map((att, idx) => `${idx + 1}. ${att.name} (${att.type})`)
                .join('\n');
            if (attachmentList) {
                attachmentContextPart = `\nRelevant files from conversation history:\n${attachmentList}`;
            }
        }
        
        // Combine all extracted content into final prompt (preserve search context if present)
        if (extractedContent.length > 0) {
            const allExtracted = extractedContent.join('\n\n');
            const searchPart = searchContext ? `Web context:\n${searchContext}\n\n` : '';
            if (message) {
                finalPrompt = `${searchPart}Attachments analyzed:\n${allExtracted}${attachmentContextPart}\n\nUser query: ${message}`;
            } else {
                finalPrompt = `Attachments analyzed:\n${allExtracted}${attachmentContextPart}\n\nProvide a comprehensive analysis of all the above content.`;
            }
            console.log(`📎 Combined ${extractedContent.length} attachment(s) into prompt${searchContext ? ' (with search context)' : ''}${attachmentContextPart ? ' + attachment history' : ''}`);
        } else if (attachmentContextPart) {
            // Even if no current attachments, include historical context
            if (message) {
                finalPrompt = `${message}${attachmentContextPart}`;
            }
        }
        
        // ===== FINANCIAL PHYSICS: Detect financial documents for seed injection =====
        // Revolutionary financial cognition: observe flows (+/−), not labels
        // Inject FINANCIAL_PHYSICS_SEED for Excel OR PDFs with detected financial content
        const hasExcelDoc = docList.some(d => d.name?.match(/\.(xlsx|xls)$/i));
        const hasFinancialPDF = docList.some(d => 
            d.name?.match(/\.pdf$/i) && 
            d.extracted?.financialAnalysis?.documentType?.type !== 'unknown' &&
            d.extracted?.financialAnalysis?.documentType?.confidence > 0.5
        );
        const hasFinancialDoc = hasExcelDoc || hasFinancialPDF;
        if (hasFinancialDoc) {
            console.log(`🧠 Financial Physics: ${hasExcelDoc ? 'Excel' : 'Financial PDF'} detected - will inject physics seed`);
        }
        
        // ===== FINANCE TEXT DETECTION: Detect commercial/investment topics in text (no file required) =====
        // This ensures post-guard (confidence + physical audit) runs for text-based finance queries
        const financeTextPatterns = /\b(stock|stocks|shares|equity|earnings|revenue|EPS|GMV|TPV|NPL|EBITDA|profit|margin|dividend|valuation|PE ratio|P\/E|market cap|quarterly|fiscal|analyst|investor|portfolio|fintech|IPO|YoY|QoQ|yield|credit rating|balance sheet|income statement|cash flow|loan|debt|capital|operating income|net income|gross margin|operating margin|venture capital|private equity|M&A|merger|acquisition|buyout|IPO|SPAC)\b/i;
        const hasFinanceText = message && financeTextPatterns.test(message);
        const hasFinanceContext = hasFinancialDoc || hasFinanceText;
        if (hasFinanceText && !hasFinancialDoc) {
            console.log(`💰 Finance Text: Commercial/investment topic detected in query text`);
        }
        
        // Final reasoning via Groq Llama 3.3 70B
        if (!PLAYGROUND_GROQ_TOKEN) {
            return res.status(503).json({ 
                reply: 'AI service is not configured. Please try again later.' 
            });
        }
        
        // Check text capacity (dynamic sharing among active IPs)
        const textCapacity = await capacityManager.consumeToken(clientIp, 'text');
        if (!textCapacity.allowed) {
            const replenishMinutes = textCapacity.replenishMinutes || 1;
            console.log(`⏸️ Text generation blocked for ${clientIp}: capacity exhausted, replenish in ${replenishMinutes}min`);
            return res.status(429).json({ 
                reply: capacityManager.getNyanRestMessage(replenishMinutes)
            });
        }
        
        console.log(`🎮 Playground: Generating response for ${clientIp} (${textCapacity.activeUsers} active users)`);
        
        // ===== CONVERSATION MEMORY: 8-turn sliding window with summarization =====
        const MAX_MESSAGES = 8;        // 8 turns = 16 messages (user + assistant)
        const SUMMARIZE_AFTER = 6;     // After 6 user messages → trigger summarization
        
        // Clean & limit history from client (strip attachments - Groq rejects extra fields)
        let conversationContext = (history || [])
            .filter(msg => msg.role && msg.content)
            .slice(-(MAX_MESSAGES * 2))
            .map(msg => ({ role: msg.role, content: msg.content }));
        
        // Auto-summarize if history is long (preserves H₀ purity)
        if (conversationContext.length >= SUMMARIZE_AFTER * 2) {
            try {
                const oldContext = conversationContext.slice(0, -4);  // everything except last 2 turns
                const recent = conversationContext.slice(-4);
                
                // One-shot summarization call
                const summaryResponse = await axios.post(
                    'https://api.groq.com/openai/v1/chat/completions',
                    {
                        model: 'llama-3.3-70b-versatile',
                        messages: [
                            { role: 'system', content: 'Summarize this conversation in 2-3 sentences. Focus on key facts, compounds discussed, and user intent. Be concise.' },
                            ...oldContext
                        ],
                        temperature: 0.1,
                        max_tokens: 300
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${PLAYGROUND_GROQ_TOKEN}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 10000
                    }
                );
                
                const summary = summaryResponse.data.choices[0]?.message?.content?.trim() || '';
                if (summary) {
                    console.log(`🧠 Memory: Summarized ${oldContext.length} messages → ${summary.length} chars`);
                    conversationContext = [
                        { role: 'system', content: `Previous conversation summary: ${summary}` },
                        ...recent
                    ];
                }
            } catch (summaryErr) {
                console.log(`⚠️ Summarization skipped: ${summaryErr.message}`);
                // Continue with truncated history if summarization fails
            }
        }
        
        // Build messages array: system prompts + conversation context + current message
        // For financial documents: inject FINANCIAL_PHYSICS_SEED LAST (takes priority over NYAN)
        // LLMs follow the LAST system instruction, so financial rules must come after NYAN
        // getFinancialPhysicsSeed() injects current date for temporal reality checks
        const systemMessages = hasFinancialDoc
            ? [
                { role: 'system', content: NYAN_PROTOCOL_SYSTEM_PROMPT },
                { role: 'system', content: getFinancialPhysicsSeed() }
              ]
            : [
                { role: 'system', content: NYAN_PROTOCOL_SYSTEM_PROMPT }
              ];
        
        const messages = [
            ...systemMessages,
            ...conversationContext,
            {
                role: 'user',
                content: finalPrompt
            }
        ];
        
        // Temperature 0.3 for financial documents (semantic flexibility for synonym matching)
        // Temperature 0.15 for everything else (H₀ factual accuracy)
        const temperature = hasFinancialDoc ? 0.3 : 0.15;
        
        const groqResponse = await groqWithRetry({
            url: 'https://api.groq.com/openai/v1/chat/completions',
            data: {
                model: 'llama-3.3-70b-versatile',
                messages,
                temperature,
                max_tokens: 1500,
                top_p: 0.95
            },
            config: {
                headers: {
                    'Authorization': `Bearer ${PLAYGROUND_GROQ_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        }, 3, 'text');
        
        let reply = groqResponse.data.choices[0]?.message?.content || 'No response generated.';
        
        // ===== FINANCIAL PHYSICS POST-GUARD: Enforce temporal warnings + physical audit disclaimer =====
        // Runs for BOTH uploaded financial docs AND text-based finance queries
        if (hasFinanceContext) {
            // Check if any document had temporal errors (guard against undefined docList for cached paths)
            const allTemporalErrors = Array.isArray(docList) 
                ? docList
                    .filter(d => d.extracted?.financialAnalysis?.temporalErrors?.length > 0)
                    .flatMap(d => d.extracted.financialAnalysis.temporalErrors)
                : [];
            
            // Inject temporal warnings if AI didn't flag them
            if (allTemporalErrors.length > 0 && !reply.includes('TEMPORAL') && !reply.includes('impossible') && !reply.includes('cannot be Actual')) {
                const warnings = allTemporalErrors.slice(0, 3).join('\n');
                reply = `${warnings}\n\n${reply}`;
                console.log(`🚨 Post-guard: Injected ${allTemporalErrors.length} temporal warning(s)`);
            }
            
            // Inject physical audit disclaimer if AI didn't include it
            if (!reply.includes('PHYSICAL AUDIT') && !reply.includes('warehouse visit') && !reply.includes('stock taking')) {
                reply = `${reply}\n\n⚠️ **PHYSICAL AUDIT ADVISORY**: Reported numbers are vulnerable to human error and financial acrobatics. Recommend combining with real physical audits: warehouse visits (stock taking), sample PO/AR/vendor verification, counting trucks (P×Q proxy), and similar "seeing is believing" H₀ approaches.`;
                console.log(`📋 Post-guard: Injected physical audit disclaimer`);
            }
        }
        
        // Add knowledge cutoff disclaimer when no search context was found
        if (noSearchDisclaimer && !photo && !audio && !document) {
            reply = `${reply}\n\n⚠️ *Note: Unable to verify with current web data. Information based on knowledge cutoff (September 2023).*`;
        }
        
        // Cache simple factual responses for future queries
        if (message && !photo && !audio && !document) {
            setCachedResponse(message, reply, queryClass);
        }
        
        console.log(`✅ Playground response sent (${reply.length} chars)${responseFileHashes.length > 0 ? ` + ${responseFileHashes.length} file hash(es)` : ''}`);
        res.json({ 
            reply,
            // Include file hashes for follow-up queries (client stores these)
            ...(responseFileHashes.length > 0 && { cachedFileHashes: responseFileHashes })
        });
        
    } catch (error) {
        console.error('❌ Playground error:', error.message);
        
        if (error.response?.status === 429) {
            return res.status(429).json({ 
                reply: 'AI service is busy. Please try again in a few seconds.' 
            });
        }
        
        res.status(500).json({ 
            reply: 'An error occurred. Please try again.' 
        });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🌐 Dashboard available at http://localhost:${PORT}`);
    
    // TRINITY ARCHITECTURE: Hermes (φ - Creator) + Thoth (0 - Mirror)
    // Security: Principle of least privilege - each bot has minimal permissions
    hermesBot = new HermesBot();
    thothBot = new ThothBot();
    
    // PROMETHEUS TRINITY: Idris (ι - Scribe) + Horus (Ω - Watcher)
    // Separate channel/bots for AI audit logging (data silo)
    idrisBot = new IdrisBot();
    horusBot = new HorusBot();
    
    console.log('🌈 Initializing Trinity architecture...');
    try {
        // Initialize bots sequentially to reduce connection spike
        await hermesBot.initialize();
        await thothBot.initialize();
        console.log('✨ Trinity ready: Hermes (φ) + Thoth (0)');
    } catch (error) {
        console.error('❌ Trinity initialization failed:', error.message);
        console.error('   Book thread creation/reading may be unavailable');
    }
    
    console.log('🧿 Initializing Prometheus Trinity...');
    try {
        await idrisBot.initialize();
        await horusBot.initialize();
        console.log('✨ Prometheus Trinity ready: Idris (ι) + Horus (Ω)');
    } catch (error) {
        console.error('❌ Prometheus Trinity initialization failed:', error.message);
        console.error('   AI audit logging may be unavailable');
    }
    
    await initializeDatabase();
    
    // Initialize capacity manager with database for reputation persistence
    capacityManager.setDbPool(pool);
    await capacityManager.initReputationTable();
    
    // Initialize usage tracker with database for persistence
    usageTracker.setDbPool(pool);
    await initUsageTable();
    await usageTracker.loadTodayUsageFromDb();
    
    // Server is now ready for requests
    console.log('✅ Multi-tenant NyanBook~ ready');
    
    // DEFERRED STARTUP: Run non-critical tasks after server is ready
    // This prevents connection pool exhaustion during startup
    setTimeout(() => {
        runDeferredStartupTasks();
    }, 2000); // 2 second delay to let initial connections settle
});

// ============================================================================
// AUTO-HEAL IMMUNE SYSTEM (Lease-Based Priority Queue)
// O(log n) selection, O(1) lookup, survives restarts, exponential backoff
// ============================================================================

async function initializeHealQueue() {
    // One-time migration: Set default heal_status for books without it
    await pool.query(`
        UPDATE core.book_registry
        SET heal_status = 'healthy',
            next_heal_at = NOW() + INTERVAL '7 days'
        WHERE heal_status IS NULL
    `);
    
    // Reset stale leases (crashed workers) - books stuck in 'healing' with expired lease
    const staleLeases = await pool.query(`
        UPDATE core.book_registry
        SET heal_status = 'pending',
            heal_lease_until = NULL
        WHERE heal_status = 'healing' 
          AND heal_lease_until < NOW()
        RETURNING id
    `);
    if (staleLeases.rowCount > 0) {
        console.log(`🔧 Reset ${staleLeases.rowCount} stale heal leases`);
    }
    
    // Check for books missing Discord threads (from tenant schemas) - mark as pending
    const brokenBooks = await pool.query(`
        SELECT br.id, br.fractal_id, br.tenant_schema, br.book_name
        FROM core.book_registry br
        WHERE br.status = 'active'
          AND br.heal_status = 'healthy'
          AND NOT EXISTS (
              SELECT 1 FROM information_schema.tables 
              WHERE table_schema = br.tenant_schema 
              AND table_name = 'books'
          )
    `);
    
    if (brokenBooks.rows.length > 0) {
        const brokenIds = brokenBooks.rows.map(b => b.id);
        await pool.query(`
            UPDATE core.book_registry
            SET heal_status = 'pending', next_heal_at = NOW()
            WHERE id = ANY($1::uuid[])
        `, [brokenIds]);
        console.log(`🔧 Queued ${brokenIds.length} orphaned books for healing`);
    }
    
    // Count pending heals
    const pending = await pool.query(`
        SELECT COUNT(*) as count FROM core.book_registry WHERE heal_status = 'pending'
    `);
    console.log(`🏥 Heal queue initialized: ${pending.rows[0].count} books pending`);
}

async function runAutoHealCycle() {
    if (!hermesBot || !hermesBot.isReady()) return;
    
    const client = await pool.connect();
    try {
        // STEP 1: Grab up to 20 books that need healing — O(log n) + SKIP LOCKED
        const res = await client.query(`
            SELECT id, fractal_id, tenant_schema, book_name,
                   outpipe_ledger, outpipes_user, heal_attempts
            FROM core.book_registry
            WHERE heal_status = 'pending'
              AND next_heal_at <= NOW()
              AND (heal_lease_until IS NULL OR heal_lease_until < NOW())
            ORDER BY next_heal_at ASC
            LIMIT 20
            FOR UPDATE SKIP LOCKED
        `);

        if (res.rows.length === 0) return; // nothing to do → sleep

        const books = res.rows;
        console.log(`🏥 Heal cycle: Processing ${books.length} books`);

        // STEP 2: Claim lease for 60 seconds
        const leaseUntil = new Date(Date.now() + 60000);
        await client.query(`
            UPDATE core.book_registry
            SET heal_status = 'healing',
                heal_lease_until = $1
            WHERE id = ANY($2::uuid[])
        `, [leaseUntil, books.map(b => b.id)]);

        // STEP 3: Heal in parallel (bounded concurrency)
        const healPromises = books.map(book => 
            healSingleBook(book).catch(err => 
                console.error(`❌ Heal failed for ${book.fractal_id}:`, err.message)
            )
        );
        
        await Promise.allSettled(healPromises);

    } finally {
        client.release();
    }
}

async function healSingleBook(book) {
    try {
        // Get full book details from tenant schema
        const tenantId = parseInt(book.tenant_schema.replace('tenant_', ''));
        
        // Check if books table exists in tenant schema
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = $1 AND table_name = 'books'
            ) as exists
        `, [book.tenant_schema]);
        
        if (!tableCheck.rows[0].exists) {
            throw new Error(`Tenant schema ${book.tenant_schema} has no books table`);
        }
        
        // Get book details from tenant schema
        const bookDetails = await pool.query(`
            SELECT id, name, output_01_url, output_0n_url, output_credentials
            FROM ${book.tenant_schema}.books
            WHERE id = (
                SELECT fractal_id::uuid FROM core.book_registry WHERE id = $1
            ) OR name = $2
            LIMIT 1
        `, [book.id, book.book_name]);
        
        if (bookDetails.rows.length === 0) {
            // Try using fractal_id directly
            const altLookup = await pool.query(`
                SELECT id, name, output_01_url, output_0n_url, output_credentials
                FROM ${book.tenant_schema}.books
                WHERE id::text = $1
                LIMIT 1
            `, [book.fractal_id]);
            
            if (altLookup.rows.length === 0) {
                throw new Error(`Book ${book.fractal_id} not found in ${book.tenant_schema}`);
            }
            bookDetails.rows = altLookup.rows;
        }
        
        const tenantBook = bookDetails.rows[0];
        const outputCreds = tenantBook.output_credentials || {};
        
        // Check if thread already exists (idempotent)
        if (outputCreds.output_01?.thread_id) {
            // Already healed, mark as healthy
            await pool.query(`
                UPDATE core.book_registry
                SET heal_status = 'healthy',
                    heal_attempts = 0,
                    last_healed_at = NOW(),
                    next_heal_at = NOW() + INTERVAL '7 days',
                    heal_lease_until = NULL,
                    heal_error = NULL
                WHERE id = $1
            `, [book.id]);
            console.log(`✅ ${book.fractal_id} already healthy (thread exists)`);
            return;
        }
        
        // Create Discord threads
        const dualThreads = await hermesBot.createDualThreadsForBook(
            tenantBook.output_01_url,
            tenantBook.output_0n_url,
            tenantBook.name,
            tenantId,
            tenantBook.id,
            true,
            outputCreds
        );

        if (dualThreads.output_01?.thread_id) {
            // Build output_credentials
            const outputDestinations = {};
            if (dualThreads.output_01) outputDestinations.output_01 = dualThreads.output_01;
            if (dualThreads.output_0n) outputDestinations.output_0n = dualThreads.output_0n;
            
            // Save to tenant schema
            await pool.query(`
                UPDATE ${book.tenant_schema}.books 
                SET output_credentials = output_credentials || $1::jsonb
                WHERE id = $2
            `, [JSON.stringify(outputDestinations), tenantBook.id]);
            
            // Send initial message
            if (dualThreads.output_01?.type === 'thread') {
                try {
                    await hermesBot.sendInitialMessage(
                        dualThreads.output_01.thread_id, 
                        tenantBook.name, 
                        tenantBook.output_01_url
                    );
                } catch (msgError) {
                    console.warn(`  ⚠️ Initial message failed: ${msgError.message}`);
                }
            }
            
            // Mark as healed
            await pool.query(`
                UPDATE core.book_registry
                SET heal_status = 'healthy',
                    heal_attempts = 0,
                    last_healed_at = NOW(),
                    next_heal_at = NOW() + INTERVAL '7 days',
                    heal_lease_until = NULL,
                    heal_error = NULL
                WHERE id = $1
            `, [book.id]);
            
            console.log(`✅ Healed ${book.fractal_id} → thread ${dualThreads.output_01.thread_id}`);
        } else {
            throw new Error('Thread creation returned no thread_id');
        }
        
    } catch (err) {
        const attempts = (book.heal_attempts || 0) + 1;
        const backoffMinutes = Math.min(Math.pow(2, attempts) * 5, 1440); // max 24h

        await pool.query(`
            UPDATE core.book_registry
            SET heal_status = 'pending',
                heal_attempts = $1,
                next_heal_at = NOW() + $2 * INTERVAL '1 minute',
                heal_lease_until = NULL,
                heal_error = $3
            WHERE id = $4
        `, [attempts, backoffMinutes, err.message, book.id]);

        console.warn(`⚠️ Heal failed ${book.fractal_id} (attempt ${attempts}), retry in ${backoffMinutes}min`);
    }
}

// Event-driven: Queue a book for healing when webhook fails
async function queueBookForHealing(fractalId, reason = 'webhook failure') {
    try {
        await pool.query(`
            UPDATE core.book_registry
            SET heal_status = 'pending',
                next_heal_at = NOW(),
                heal_error = $2
            WHERE fractal_id = $1 AND heal_status = 'healthy'
        `, [fractalId, reason]);
    } catch (err) {
        console.error(`Failed to queue ${fractalId} for healing:`, err.message);
    }
}

// Non-critical background tasks that run after server is ready
async function runDeferredStartupTasks() {
    console.log('🔄 Running deferred startup tasks...');
    
    // AUTO-HEAL: Priority queue-based healing (O(log n) instead of O(n²))
    // Phase 1: Initial scan to populate heal queue (one-time on startup)
    // Phase 2: Background worker consumes queue every 20 seconds
    if (hermesBot && hermesBot.isReady()) {
        try {
            console.log('🔧 Auto-healing: Initializing heal queue...');
            await initializeHealQueue();
            
            // Start background heal worker (runs every 20 seconds, cat-approved)
            setInterval(runAutoHealCycle, 20000);
            console.log('✅ Heal immune system active (20s cycle, batch=20, lease=60s)');
        } catch (error) {
            console.error('❌ Auto-heal initialization failed:', error.message);
        }
    } else {
        console.warn('⚠️  Hermes not ready, skipping auto-heal');
    }
    
    // Start genesis counter (noisy constant for future security)
    // Tier 1: Cat breath (500ms constant)
    // Tier 2: φ breath (4000-6472ms sine wave, synchronized with UI φ-breath)
    genesisCounter.start();
    console.log('🔢 Genesis counter started (cat + φ breath tiers)');
    
    // === PHI BREATHE COUNTER: PROD (ETERNAL DB) vs DEV (FRESH MEMORY) ===
    const PHI = 1.618033988749895;
    const BASE_BREATH = 4000; // ms

    if (isProd) {
        // PRODUCTION: Atomic DB increment for eternal count (multi-instance safe)
        async function atomicPhiBreathe() {
            try {
                // Atomic increment: UPDATE ... RETURNING ensures no race conditions
                // Each instance gets a unique, sequential count from the database
                const res = await pool.query(
                    `INSERT INTO core.system_counters (key, value) 
                     VALUES ('phi_breathe_count', 1)
                     ON CONFLICT (key) DO UPDATE 
                     SET value = core.system_counters.value + 1, updated_at = NOW()
                     RETURNING value`
                );
                
                const phiBreatheCount = parseInt(res.rows[0].value, 10);
                const isInhale = phiBreatheCount % 2 === 1;
                const duration = isInhale ? BASE_BREATH : Math.round(BASE_BREATH * PHI);
                const type = isInhale ? 'inhale' : 'exhale';
                const multiplier = isInhale ? '' : '(φ×1.618)';

                console.log(`🌬️  phi breathe #${phiBreatheCount} ${type} ${duration}ms ${multiplier}`);

                // Schedule next breath
                setTimeout(atomicPhiBreathe, duration);
                
            } catch (err) {
                console.error('❌ Phi breathe error:', err.message);
                // Retry after a delay on error
                setTimeout(atomicPhiBreathe, BASE_BREATH);
            }
        }

        // Log current genesis count and begin eternal breath
        try {
            const res = await pool.query(
                `SELECT value FROM core.system_counters WHERE key = 'phi_breathe_count'`
            );
            if (res.rows[0]) {
                console.log(`✨ Genesis restored: phi breathe #${res.rows[0].value} (eternal count since genesis)`);
            }
        } catch (err) {
            console.log('⚠️  Phi counter table not ready yet, will initialize on first breath');
        }
        
        // Begin eternal breath (atomic increment handles multi-instance safety)
        atomicPhiBreathe();
    } else {
        // DEVELOPMENT: In-memory counter (resets on refresh, no DB writes)
        let phiBreatheCount = 0;

        function devPhiBreathe() {
            phiBreatheCount++;
            const isInhale = phiBreatheCount % 2 === 1;
            const duration = isInhale ? BASE_BREATH : Math.round(BASE_BREATH * PHI);
            const type = isInhale ? 'inhale' : 'exhale';
            const multiplier = isInhale ? '' : '(φ×1.618)';

            console.log(`🌬️  phi breathe #${phiBreatheCount} ${type} ${duration}ms ${multiplier} (dev mode)`);

            // Schedule next breath
            setTimeout(devPhiBreathe, duration);
        }

        console.log(`🔄 Dev mode: phi breathe starts fresh (in-memory, resets on refresh)`);
        devPhiBreathe();
    }
    
    // 3-DAY MEDIA PURGE: Clean up old media from buffer
    // Nyanbook Ledger has permanent copy, so buffer only needed for retry safety
    // Uses single client connection to reduce pool exhaustion
    async function purgeOldMedia() {
        let client = null;
        try {
            console.log('🧹 Starting 3-day media purge...');
            
            // Use single client for all batch queries
            client = await pool.connect();
            
            // Get all tenant schemas
            const schemas = await client.query(`
                SELECT schema_name 
                FROM information_schema.schemata 
                WHERE schema_name LIKE 'tenant_%'
                ORDER BY schema_name
            `);
            
            let totalPurged = 0;
            
            for (const { schema_name } of schemas.rows) {
                // Check if media_buffer table exists (skip empty tenant schemas)
                const tableCheck = await client.query(`
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables 
                        WHERE table_schema = $1 
                        AND table_name = 'media_buffer'
                    ) as exists
                `, [schema_name]);
                
                if (!tableCheck.rows[0].exists) {
                    continue; // Skip empty tenant schema
                }
                
                const result = await client.query(`
                    DELETE FROM ${schema_name}.media_buffer 
                    WHERE created_at < NOW() - INTERVAL '3 days'
                    RETURNING id
                `);
                
                if (result.rowCount > 0) {
                    console.log(`  🗑️  Purged ${result.rowCount} media entries from ${schema_name}`);
                    totalPurged += result.rowCount;
                }
            }
            
            console.log(`✅ Media purge complete: ${totalPurged} total entries removed`);
        } catch (error) {
            console.error('❌ Media purge failed:', error.message);
        } finally {
            // Always release the client back to the pool
            if (client) {
                client.release();
            }
        }
    }
    
    // Run purge immediately on startup
    await purgeOldMedia();
    
    // Schedule purge every 24 hours
    setInterval(purgeOldMedia, 24 * 60 * 60 * 1000);
    console.log('⏰ 3-day media purge scheduled (runs every 24 hours)');
    
    // 60-DAY DORMANCY CLEANUP: Revoke access for unregistered contributors
    // Only affects phones NOT linked to a registered user (no email anchor)
    // Protects against phone recycling for global users
    async function revokeDormantContributors() {
        try {
            console.log('🔒 Starting 60-day dormancy cleanup...');
            
            // Find unregistered phone contributors with no activity in 60 days
            // Unregistered = phone exists in book_engaged_phones BUT
            // NOT linked to any email via is_creator=true in ANY book
            const dormantResult = await pool.query(`
                WITH registered_phones AS (
                    -- Phones that are creators of at least one book (email-linked)
                    SELECT DISTINCT ep.phone
                    FROM core.book_engaged_phones ep
                    WHERE ep.is_creator = true
                )
                UPDATE core.book_engaged_phones ep
                SET last_engaged_at = NULL
                WHERE ep.is_creator = false
                  AND ep.last_engaged_at < NOW() - INTERVAL '60 days'
                  AND ep.phone NOT IN (SELECT phone FROM registered_phones)
                RETURNING ep.phone, ep.book_registry_id
            `);
            
            if (dormantResult.rowCount > 0) {
                console.log(`🔒 Revoked access for ${dormantResult.rowCount} dormant unregistered contributors`);
                
                // Log to Discord via Idris if available
                if (idrisBot && idrisBot.ready) {
                    const revokedPhones = [...new Set(dormantResult.rows.map(r => r.phone))];
                    console.log(`   Revoked phones: ${revokedPhones.join(', ')}`);
                }
            } else {
                console.log('✅ No dormant unregistered contributors to revoke');
            }
        } catch (error) {
            console.error('❌ Dormancy cleanup failed:', error.message);
        }
    }
    
    // Run dormancy cleanup on startup and every 24 hours
    revokeDormantContributors();
    setInterval(revokeDormantContributors, 24 * 60 * 60 * 1000);
    console.log('⏰ 60-day dormancy cleanup scheduled (runs every 24 hours)');
    
    console.log('✅ All deferred startup tasks completed');
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    process.exit(0);
});

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
const { getLegalAnalysisSeed, detectLegalDocument, LEGAL_KEYWORDS_REGEX } = require('./prompts/legal-analysis');
const { formatAuditBadge, runAuditPass } = require('./utils/two-pass-verification');
const { preflightRouter } = require('./utils/preflight-router');
const { createPipelineOrchestrator, PIPELINE_STEPS, fastStreamPersonality, applyPersonalityFormat } = require('./utils/pipeline-orchestrator');
const { recordInMemory, clearSessionMemory } = require('./utils/context-extractor');
const { getMemoryManager, cleanupOldSessions } = require('./utils/memory-manager');

const { initialize: initDeps, setMiddleware: setDepsMiddleware, deps } = require('./lib/deps');
const { registerAuthRoutes, createAuthMiddleware } = require('./routes/auth');
// Admin routes merged into routes/auth.js (no separate admin terminology)
const { registerBooksRoutes } = require('./routes/books');
const { registerInpipeRoutes } = require('./routes/inpipe');
const { registerExportRoutes } = require('./routes/export');
const { registerPrometheusRoutes } = require('./routes/prometheus');
const { registerNyanAIRoutes, capacityManager, usageTracker } = require('./routes/nyan-ai');
const { healQueue } = require('./lib/heal-queue');
const phiBreathe = require('./lib/heartbeat');
const { splitMessageIntoChunks, postPayloadToWebhook, createSendToLedger, createSendToUserOutput } = require('./lib/discord-webhooks');

// ============================================================================
// SECURITY: Fail-Closed Secret Guards (Critical Infrastructure Only)
// ============================================================================
// Strategy: Throw hard errors on startup if critical secrets missing
// Only enforce truly essential secrets - don't require optional integrations

const criticalSecrets = {
    FRACTAL_SALT: 'Secure book ID generation (crypto salt)',
    NYANBOOK_WEBHOOK_URL: 'Discord Ledger #01 (output book)',
    PLAYGROUND_GROQ_TOKEN: 'AI Playground reasoning (Groq Llama 3.3)'
};

const missingCriticalSecrets = Object.entries(criticalSecrets).filter(([key]) => !process.env[key]);

if (missingCriticalSecrets.length > 0) {
    console.error('❌ CRITICAL: Missing essential secrets (fail-closed)');
    console.error('');
    missingCriticalSecrets.forEach(([key, description]) => {
        console.error(`   • ${key}: ${description}`);
    });
    console.error('');
    console.error('📋 Configuration required in Replit Secrets tab before startup');
    console.error('');
    console.error('🛑 Server will NOT start until all secrets are configured.');
    process.exit(1);
}

const ALLOWED_GROUPS = process.env.ALLOWED_GROUPS ? process.env.ALLOWED_GROUPS.split(',').map(g => g.trim()) : [];
const ALLOWED_NUMBERS = process.env.ALLOWED_NUMBERS ? process.env.ALLOWED_NUMBERS.split(',').map(n => n.trim()) : [];

// GLOBAL CONSTANTS: Nyanbook Ledger (Output #01) - centralized monitoring for all tenants
// SECURITY: Loaded from environment variable (fail-closed check above)
const NYANBOOK_LEDGER_WEBHOOK = process.env.NYANBOOK_WEBHOOK_URL;

// ENVIRONMENT CHECK (must be defined before pool for SSL config)
// Replit sets REPLIT_DEPLOYMENT=1 when deployed (not 'true')
const isProd = process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production';

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
        rejectUnauthorized: isProd
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

const dbHost = process.env.DATABASE_URL?.split('@')[1]?.split('.')[0] || 'unknown';

console.log(`🚀 Mode: ${isProd ? 'PRODUCTION' : 'DEVELOPMENT'}`);
console.log(`🗄️  DB Host: ${dbHost}`);
console.log(`📊 Pool: max=${pool.options.max}, min=${pool.options.min}, idleTimeout=${pool.options.idleTimeoutMillis}ms`);

const tenantManager = new TenantManager(pool);

// AUTH MIDDLEWARE: Create early so routes can use requireAuth/requireRole
// Using simple console logger for early initialization
const earlyLogger = {
    info: (...args) => console.log('[auth]', ...args),
    warn: (...args) => console.warn('[auth]', ...args),
    error: (...args) => console.error('[auth]', ...args),
    debug: (...args) => {} // Silent in production
};
const { requireAuth, requireRole } = createAuthMiddleware(pool, authService, earlyLogger);

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

app.get('/health/deep', async (req, res) => {
    const checks = {
        database: { healthy: false, latency: null, pool: null },
        discord: { 
            hermes: { healthy: false, status: 'not_initialized' },
            thoth: { healthy: false, status: 'not_initialized' },
            idris: { healthy: false, status: 'not_initialized' },
            horus: { healthy: false, status: 'not_initialized' }
        },
        twilio: { configured: false }
    };
    
    const startTime = Date.now();
    
    try {
        const dbStart = Date.now();
        await pool.query('SELECT 1 as health');
        checks.database.healthy = true;
        checks.database.latency = Date.now() - dbStart;
        checks.database.pool = {
            total: pool.totalCount || 0,
            idle: pool.idleCount || 0,
            waiting: pool.waitingCount || 0
        };
    } catch (err) {
        checks.database.error = err.message;
    }
    
    if (typeof hermesBot !== 'undefined' && hermesBot) {
        checks.discord.hermes.healthy = hermesBot.isReady?.() || false;
        checks.discord.hermes.status = checks.discord.hermes.healthy ? 'ready' : 'disconnected';
    }
    if (typeof thothBot !== 'undefined' && thothBot) {
        checks.discord.thoth.healthy = thothBot.ready || false;
        checks.discord.thoth.status = checks.discord.thoth.healthy ? 'ready' : 'disconnected';
    }
    if (typeof idrisBot !== 'undefined' && idrisBot) {
        checks.discord.idris.healthy = idrisBot.isReady?.() || false;
        checks.discord.idris.status = checks.discord.idris.healthy ? 'ready' : 'disconnected';
    }
    if (typeof horusBot !== 'undefined' && horusBot) {
        checks.discord.horus.healthy = horusBot.isReady?.() || false;
        checks.discord.horus.status = checks.discord.horus.healthy ? 'ready' : 'disconnected';
    }
    
    checks.twilio.configured = !!process.env.TWILIO_AUTH_TOKEN;
    
    const allHealthy = checks.database.healthy && 
        (checks.discord.hermes.healthy || checks.discord.hermes.status === 'not_initialized') &&
        (checks.discord.thoth.healthy || checks.discord.thoth.status === 'not_initialized');
    
    res.status(allHealthy ? 200 : 503).json({
        status: allHealthy ? 'healthy' : 'degraded',
        checks,
        totalLatency: Date.now() - startTime,
        timestamp: new Date().toISOString()
    });
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
        
        // PASSWORD RESET TOKENS: Secure tokens for forgot password flow via WhatsApp
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
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token 
            ON core.password_reset_tokens(token)
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_email 
            ON core.password_reset_tokens(user_email)
        `);
        
        console.log('✅ Password reset tokens table initialized');
        
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
        
        // NOTE: One-time migrations have been applied to production database and removed 
        // from startup code for clean deploys:
        // - audit_queries_table (added audit_queries table to tenant schemas)
        // - ai_log_columns (added ai_log columns to tenant_catalog)
        // - updated_at, creator_phone, join_code, drops
        // Migration records preserved in core.migrations table for audit trail.
        
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

// Discord webhook helpers moved to lib/discord-webhooks.js
// Factory functions created in app.listen() for DI pattern
let sendToLedger;
let sendToUserOutput;

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
async function getBookTenantSchema(fractalIdInput) {
    try {
        const parsed = fractalId.parse(fractalIdInput);
        if (parsed && parsed.tenantId) {
            const tenantSchema = `tenant_${parsed.tenantId}`;
            console.log(`✅ Parsed fractal_id: Book belongs to ${tenantSchema}`);
            return tenantSchema;
        }
        
        // Detect legacy numeric IDs and reject explicitly
        const numericId = parseInt(fractalIdInput);
        if (!isNaN(numericId)) {
            console.error(`❌ DEPRECATED: Numeric book ID ${numericId} rejected. Use fractal_id instead.`);
            throw new Error(`Legacy numeric book ID not supported. Use fractal_id format.`);
        }
        
        console.warn(`⚠️ Invalid fractal_id format: ${fractalIdInput}`);
        return 'public';
    } catch (error) {
        console.error(`❌ Error resolving tenant for book ${fractalIdInput}:`, error.message);
        throw error;
    }
}

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

// NOTE: Authentication middleware (requireAuth, requireRole) moved to routes/auth.js
// NOTE: /api/messages, /api/stats routes moved to routes/books.js
// NOTE: GET /api/books moved to routes/books.js (full implementation with contributor access)
// NOTE: POST /api/books (create) moved to routes/books.js
// NOTE: PUT /api/books/:id (update) moved to routes/books.js
// NOTE: DELETE /api/books/:id (soft delete) moved to routes/books.js
// NOTE: POST /api/books/:id/archive moved to routes/books.js
// NOTE: POST /api/books/:id/unarchive moved to routes/books.js
// NOTE: POST /api/books/:id/relink moved to routes/books.js

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

// NOTE: GET /api/books/archived moved to routes/books.js
// NOTE: GET /api/books/:id/stats moved to routes/books.js

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
        
        // Remove tag from both extracted_tags array AND metadata_text string
        // Escape regex metacharacters before passing to SQL
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
        
        // Remove date from both extracted_dates array AND metadata_text string
        // Escape regex metacharacters before passing to SQL
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

// NOTE: Export handler moved to routes/export.js (registered in app.listen)

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

// ONBOARDING API: Moved to routes/auth.js (user lifecycle)

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
    
    // Initialize Discord webhook factories (DI pattern)
    sendToLedger = createSendToLedger(pool, NYANBOOK_LEDGER_WEBHOOK);
    sendToUserOutput = createSendToUserOutput(pool);
    
    // Initialize capacity manager with database for reputation persistence
    capacityManager.setDbPool(pool);
    await capacityManager.initReputationTable();
    
    // Initialize usage tracker with database for persistence
    usageTracker.setDbPool(pool);
    await initUsageTable();
    await usageTracker.loadTodayUsageFromDb();
    
    // Server is now ready for requests
    console.log('✅ Multi-tenant NyanBook~ ready');
    
    // Initialize dependency injection container with all dependencies
    initDeps({
        pool,
        tenantManager,
        authService,
        fractalId: process.env.FRACTAL_ID,
        constants: {
            NYANBOOK_LEDGER_WEBHOOK: process.env.NYANBOOK_LEDGER_WEBHOOK,
            LIMBO_THREAD_ID: process.env.LIMBO_THREAD_ID,
            HERMES_TOKEN: process.env.HERMES_TOKEN
        },
        bots: {
            hermes: hermesBot,
            thoth: thothBot,
            idris: idrisBot,
            horus: horusBot
        },
        tenantMiddleware: {
            setTenantContext,
            getAllTenantSchemas: () => tenantManager.getAllSchemas(),
            sanitizeForRole
        },
        helpers: {
            logAudit,
            getTimestamp,
            noCacheHeaders,
            createSessionRecord
        }
    });
    
    // Register modular routes (after deps initialized with live bots)
    const authMiddleware = registerAuthRoutes(app, deps);
    setDepsMiddleware(authMiddleware.requireAuth, authMiddleware.requireRole);
    registerBooksRoutes(app, deps);
    registerInpipeRoutes(app, deps);
    registerExportRoutes(app, deps);
    registerPrometheusRoutes(app, deps);
    registerNyanAIRoutes(app, deps);
    console.log('📦 Modular routes registered: auth, books, inpipe, export, prometheus, nyan-ai');
    
    // DEFERRED STARTUP: Run non-critical tasks via unified phi breathe orchestrator
    // This prevents connection pool exhaustion during startup
    setTimeout(async () => {
        // AUTO-HEAL: Priority queue-based healing (O(log n) instead of O(n²))
        // Uses modular heal-queue system from lib/heal-queue.js
        if (hermesBot && hermesBot.isReady()) {
            try {
                console.log('🔧 Auto-healing: Initializing heal queue...');
                healQueue.setDependencies(pool, hermesBot);
                await healQueue.initialize();
                healQueue.start(20000);
            } catch (error) {
                console.error('❌ Auto-heal initialization failed:', error.message);
            }
        } else {
            console.warn('⚠️  Hermes not ready, skipping auto-heal');
        }
        
        // Start genesis counter (noisy constant for future security)
        genesisCounter.start();
        console.log('🔢 Genesis counter started (cat + φ breath tiers)');
        
        // === PHI BREATHE: Unified orchestrator for all background tasks ===
        phiBreathe.setPool(pool);
        phiBreathe.setBots({ idris: idrisBot });
        phiBreathe.setCleanupFunctions({ cleanupOldSessions });
        await phiBreathe.startPhiBreathe();
        await phiBreathe.orchestrateStartup();
        
        // Register usage cleanup with phi breathe (1h cycle)
        usageTracker.registerWithHeartbeat(phiBreathe);
    }, 2000); // 2 second delay to let initial connections settle
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    process.exit(0);
});

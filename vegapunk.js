// Vegapunk.js - The Kernel (previously index.js 8000+ lines)
// Named after Dr. Vegapunk (One Piece) - the genius scientist who splits
// his consciousness into satellite bodies while maintaining a pure core.
// This kernel orchestrates 4 modular routes (satellites) via dependency injection.

const { execSync } = require('child_process');
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
const rateLimit = require('express-rate-limit');
const logger = require('./lib/logger');
const twilio = require('twilio');
const authService = require('./auth-service');
const TenantManager = require('./tenant-manager');
const { setTenantContext, getAllTenantSchemas, sanitizeForRole } = require('./tenant-middleware');
const HermesBot = require('./hermes-bot');
const ThothBot = require('./thoth-bot');
const IdrisBot = require('./idris-bot');
const HorusBot = require('./horus-bot');
const fractalId = require('./utils/fractal-id');
const genesisCounter = require('./server/genesis-counter');
const { extractTextFromDocument, getDocumentPrompt } = require('./utils/document-parser');
const { identifyFileType, executeExtractionCascade, formatJSONForGroq, getFinancialPhysicsSeed, intelligentChunking, buildMultiDocContext } = require('./utils/attachment-cascade');
const CONSTANTS = require('./config/constants');
const { getLegalAnalysisSeed, detectLegalDocument, LEGAL_KEYWORDS_REGEX } = require('./prompts/legal-analysis');
const { formatAuditBadge, runAuditPass } = require('./utils/two-pass-verification');
const { preflightRouter } = require('./utils/preflight-router');
const { createPipelineOrchestrator, PIPELINE_STEPS, fastStreamPersonality, applyPersonalityFormat } = require('./utils/pipeline-orchestrator');
const { recordInMemory, clearSessionMemory } = require('./utils/context-extractor');
const { getMemoryManager, cleanupOldSessions } = require('./utils/memory-manager');

const { initialize: initDeps, setMiddleware: setDepsMiddleware, deps } = require('./lib/deps');
const { createAuthMiddleware, registerAuthRoutes } = require('./routes/auth');
const { registerBooksRoutes } = require('./routes/books');
const { registerInpipeRoutes } = require('./routes/inpipe');
const { registerNyanAIRoutes, capacityManager, usageTracker } = require('./routes/nyan-ai');
const { healQueue } = require('./lib/heal-queue');
const phiBreathe = require('./lib/phi-breathe');
const { splitMessageIntoChunks, postPayloadToWebhook, createSendToLedger, createSendToUserOutput } = require('./lib/discord-webhooks');
const { createErrorHandler, notFoundHandler } = require('./lib/error-handler');
const { config, buildConnectionString, getDbHost } = require('./config');
const { z } = require('zod');  // SECURITY: For webhook payload validation

// ============================================================================
// SECURITY: Fail-Closed Secret Guards (Critical Infrastructure Only)
// ============================================================================
// Strategy: Throw hard errors on startup if critical secrets missing
// Only enforce truly essential secrets - don't require optional integrations

const criticalSecrets = {
    DATABASE_URL: 'PostgreSQL connection (Supabase pooler)',
    SESSION_SECRET: 'Session encryption key',
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
// Supabase pooler handles 10,000+ concurrent connections; local pool max=20 is direct connection limit
// Trade-off: Cannot use SET search_path (must use explicit schema prefixes)
const databaseUrl = process.env.DATABASE_URL;
const poolModeParam = 'pool_mode=transaction';
const connectionString = databaseUrl?.includes('?')
    ? `${databaseUrl}&${poolModeParam}`  // Has existing params, append with &
    : `${databaseUrl}?${poolModeParam}`;  // No params yet, start with ?

// SECURITY NOTE: Supabase SSL/TLS
// - SSL/TLS is automatic and enforced by Supabase pooler
// - Connection is always encrypted (TLS termination at Supabase edge)
// - Supabase uses self-signed certificates → rejectUnauthorized: false by default
// - Optional: Set DATABASE_CA_CERT for verify-full mode (download from Supabase Dashboard)
// - Production hardening: Use RLS policies, Attack Protection (CAPTCHA), secure key management
// - See: https://supabase.com/docs/guides/platform/ssl-enforcement
const isLocalDb = databaseUrl?.includes('localhost') || databaseUrl?.includes('127.0.0.1');
const hasCustomCA = !!process.env.DATABASE_CA_CERT;

const pool = new Pool({
    connectionString,
    ssl: isLocalDb ? false : { 
        rejectUnauthorized: hasCustomCA,  // verify-full if CA provided, else trust Supabase infrastructure
        ...(hasCustomCA && { ca: process.env.DATABASE_CA_CERT })
    },
    max: 20, // Direct pool limit; Supabase pooler handles 10k+ upstream
    min: 2,
    connectionTimeoutMillis: 30000, // 30s for cold starts
    idleTimeoutMillis: 30000, // Release idle connections after 30s
    statement_timeout: 30000,
    query_timeout: 30000,
    idle_in_transaction_session_timeout: 30000
});

// CONNECTION POOL MONITORING: Track connection lifecycle
pool.on('connect', () => {
    const usage = (pool.totalCount / pool.options.max) * 100;
    if (usage > 80) {
        console.warn(`[${getTimestamp()}] ⚠️ Pool at ${usage.toFixed(0)}% capacity! (${pool.totalCount}/${pool.options.max})`);
    }
    console.log(`🔌 Pool: Connection acquired (Total: ${pool.totalCount}, Idle: ${pool.idleCount}, Waiting: ${pool.waitingCount})`);
});

pool.on('error', (err) => {
    console.error('💥 Pool: Unexpected error on idle client', err);
});

pool.on('remove', () => {
    console.log(`🔓 Pool: Connection released (Total: ${pool.totalCount}, Idle: ${pool.idleCount})`);
});

// SAFETY: Defensive parsing with explicit format assertion
const dbUrlParts = process.env.DATABASE_URL?.split('@');
if (!dbUrlParts || dbUrlParts.length < 2) {
    console.warn('⚠️ DATABASE_URL format unexpected, using fallback host identifier');
}
const dbHost = dbUrlParts?.[1]?.split('.')[0] || 'unknown';

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

// REQUEST TIMING MIDDLEWARE: Adds X-Response-Time header for performance monitoring
app.use((req, res, next) => {
    req.startTime = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - req.startTime;
        // Log response time for monitoring (header already sent, so use finish event)
        if (duration > 1000) {
            console.log(`⏱️  Slow request: ${req.method} ${req.path} - ${duration}ms`);
        }
    });
    // Set header before response is sent
    res.setHeader('X-Response-Time', '0ms'); // Placeholder, will be accurate in logs
    next();
});

// Serve AI Playground (public, no auth - sovereign gift to the world)
app.get('/AI', (req, res) => {
    logger.info({ ip: req.ip }, '🎮 AI Playground accessed');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(__dirname + '/public/playground.html');
});

// Serve login page without authentication (must come before requireAuth check)
app.get('/login.html', (req, res) => {
    logger.info({ ip: req.ip, ua: req.get('user-agent') }, '📱 Login page accessed');
    // Prevent browser caching to ensure latest JavaScript is always loaded
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(__dirname + '/public/login.html');
});

// Serve signup page without authentication
app.get('/signup.html', (req, res) => {
    logger.info({ ip: req.ip, ua: req.get('user-agent') }, '📝 Signup page accessed');
    // Prevent browser caching to ensure latest JavaScript is always loaded
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(__dirname + '/public/signup.html');
});

// Serve dev panel (auth happens client-side via JWT)
app.get('/dev', (req, res) => {
    logger.info({ ip: req.ip }, '🛠️  Dev panel accessed');
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

// FAVICON ROUTE: Explicit handler for browser icon requests (UX polish)
app.get('/favicon.ico', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
    res.sendFile(__dirname + '/public/favicon.ico', (err) => {
        if (err) {
            // Return 204 No Content if favicon doesn't exist (prevents 404 spam in logs)
            res.status(204).end();
        }
    });
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

// Nyan AI Audit: Idris (write-only) + Horus (read-only) for AI audit logs
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
        // SECURITY: Explicitly validate tenantId is a safe positive integer before SQL interpolation
        if (parsed && Number.isInteger(parsed.tenantId) && parsed.tenantId > 0 && parsed.tenantId <= 999999) {
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

// IP geolocation cache: prevents rate limiting on ipapi.co (1h TTL)
const ipGeoCache = new Map();
const IP_GEO_TTL_MS = 60 * 60 * 1000; // 1 hour for success
const IP_GEO_FAILURE_TTL_MS = 5 * 60 * 1000; // 5 mins for failure

// Simple location detection from IP (with caching and proper timeout)
async function getLocationFromIP(ipAddress) {
    try {
        // For local/private IPs, return Unknown
        if (!ipAddress || ipAddress === '::1' || ipAddress.startsWith('127.') || ipAddress.startsWith('192.168.') || ipAddress.startsWith('10.')) {
            return 'Local Network';
        }
        
        // Check cache first
        const cached = ipGeoCache.get(ipAddress);
        if (cached && Date.now() - cached.timestamp < (cached.location === 'Unknown Location' ? IP_GEO_FAILURE_TTL_MS : IP_GEO_TTL_MS)) {
            return cached.location;
        }
        
        // Prune cache if it grows too large (simple LRU-ish: delete first entry)
        if (ipGeoCache.size > 5000) {
            const firstKey = ipGeoCache.keys().next().value;
            ipGeoCache.delete(firstKey);
        }
        
        // Use AbortController for proper fetch timeout (native fetch ignores timeout option)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        
        try {
            const response = await fetch(`https://ipapi.co/${ipAddress}/json/`, {
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            
            if (response.ok) {
                const data = await response.json();
                let location = 'Unknown Location';
                if (data.city && data.country_name) {
                    location = `${data.city}, ${data.country_name}`;
                } else if (data.country_name) {
                    location = data.country_name;
                }
                
                // Cache the result
                ipGeoCache.set(ipAddress, { location, timestamp: Date.now() });
                return location;
            }
        } catch (fetchError) {
            clearTimeout(timeoutId);
            if (fetchError.name === 'AbortError') {
                console.warn(`[${getTimestamp()}] ⏱️ IP geo lookup timed out for ${ipAddress}`);
            } else {
                throw fetchError;
            }
        }
        
        // Cache the failure for 5 mins to prevent immediate retry
        ipGeoCache.set(ipAddress, { location: 'Unknown Location', timestamp: Date.now() });
        return 'Unknown Location';
    } catch (error) {
        console.error(`[${getTimestamp()}] Error getting location:`, error.message);
        return 'Unknown Location';
    }
}

// Create session tracking record (multi-tenant)
async function createSessionRecord(userId, sessionId, req, tenantSchema) {
    try {
        const userAgent = req.get('user-agent') || '';
        const { deviceType, browser, os } = parseUserAgent(userAgent);
        const location = await getLocationFromIP(req.ip);
        
        // SECURITY: Validate tenant schema name before interpolation
        if (!/^[a-z_][a-z0-9_]*$/i.test(tenantSchema)) {
            console.error(`❌ Session creation: Invalid tenant schema: ${tenantSchema}`);
            return;
        }

        // Use tenant-scoped active_sessions table
        await pool.query(`
            INSERT INTO "${tenantSchema}".active_sessions (user_id, session_id, ip_address, user_agent, device_type, browser, os, location)
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

        // SECURITY: Validate schema name before interpolation
        if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
            console.error(`❌ Audit logging: Invalid schema skipped: ${schema}`);
            return;
        }
        
        // Fetch email if we have userId but not email (from tenant-scoped users table)
        if (actorUserId && !actorEmail) {
            const userResult = await client.query(`SELECT email FROM "${schema}".users WHERE id = $1`, [actorUserId]);
            actorEmail = userResult.rows[0]?.email || null;
        }
        
        // Use tenant-scoped audit_logs table
        await client.query(`
            INSERT INTO "${schema}".audit_logs (
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

// ============ WEBHOOK INPUT ENDPOINT (HYBRID MODEL) ============
// Support ANY input: Telegram bot, Twitter/X, SMS, Email → Discord
// Example: POST /api/webhook/bridge_t6_abc123 with { text, username, avatar_url, media_url }

// Rate limiting for the webhook endpoint (prevents flood attacks)
const webhookLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60, // 60 requests per minute per IP
    // Use default keyGenerator (req.ip) - works with trust proxy setting
    // Disable IPv6 validation warning since we're behind Replit's proxy
    validate: { xForwardedForHeader: false },
    handler: (req, res) => {
        console.warn(`[${getTimestamp()}] ⚠️ Webhook rate limit exceeded - IP: ${req.ip}`);
        res.status(429).json({ error: 'Too many requests, please try again later.' });
    }
});

app.post('/api/webhook/:fractalId', webhookLimiter, async (req, res) => {
    try {
        const fractalIdParam = req.params.fractalId;
        
        // SECURITY: Validate fractalId format before any DB queries
        // Format: bridge_<type>_<tenantId> (e.g., bridge_t6_abc123)
        const fractalIdPattern = /^bridge_[a-z][0-9a-z]_[a-zA-Z0-9]{6,32}$/;
        if (!fractalIdParam || !fractalIdPattern.test(fractalIdParam)) {
            return res.status(400).json({ error: 'Invalid book ID format' });
        }
        
        // SECURITY: Validate and sanitize webhook payload using Zod
        const webhookPayloadSchema = z.object({
            text: z.string().max(10000, 'Message too long').optional().default(''),
            username: z.string().max(100, 'Username too long').optional().default('External'),
            avatar_url: z.string().url('Invalid avatar URL').optional().nullable(),
            media_url: z.string().url('Invalid media URL').optional().nullable(),
            phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone format').optional().nullable(),
            email: z.string().email('Invalid email format').optional().nullable()
        });
        
        const payloadResult = webhookPayloadSchema.safeParse(req.body);
        if (!payloadResult.success) {
            return res.status(400).json({ 
                error: 'Invalid payload',
                details: payloadResult.error.issues.map(i => i.message)
            });
        }
        
        const { text, username, avatar_url, media_url, phone, email } = payloadResult.data;
        
        // Parse fractal_id to get tenant
        const parsed = fractalId.parse(fractalIdParam);
        if (!parsed || !parsed.tenantId) {
            return res.status(400).json({ error: 'Invalid book ID format' });
        }
        
        // SECURITY: Explicitly validate tenantId is a safe positive integer before SQL interpolation
        // This provides defense-in-depth even though parse() already validates the format
        if (!Number.isInteger(parsed.tenantId) || parsed.tenantId <= 0 || parsed.tenantId > 999999) {
            return res.status(400).json({ error: 'Invalid tenant ID' });
        }
        const tenantSchema = `tenant_${parsed.tenantId}`;
        
        // SECURITY: Validate schema name before interpolation
        if (!/^[a-z_][a-z0-9_]*$/i.test(tenantSchema)) {
            return res.status(400).json({ error: 'Invalid tenant schema' });
        }
        // SECURITY: Escape identifier for defense-in-depth (doubles any quotes per SQL standard)
        const safeSchema = tenantSchema.replace(/"/g, '""');

        // Get tenant-scoped database client
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // TRANSACTION MODE: Use explicit schema prefix instead of SET LOCAL search_path
            
            // Find book by fractal_id
            const bookResult = await client.query(
                `SELECT id, fractal_id, output_01_url, output_0n_url, output_credentials FROM "${safeSchema}".books WHERE fractal_id = $1`,
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
            // BUG FIX: Wrap in try-catch to handle corrupted JSON gracefully
            if (book && typeof book.output_credentials === 'string') {
                try {
                    book.output_credentials = JSON.parse(book.output_credentials);
                } catch (jsonError) {
                    console.error(`[${getTimestamp()}] ⚠️ Corrupted output_credentials for book ${fractalIdParam}:`, jsonError.message);
                    book.output_credentials = {};
                }
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
            res.json({ success: true, message: 'Message forwarded to Webhook' });
            
        } catch (error) {
            // DEFENSIVE: try/finally ensures connection release even if ROLLBACK fails
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('⚠️ ROLLBACK failed (connection likely broken):', rollbackError.message);
            } finally {
                client.release();
            }
            throw error;
        }
    } catch (error) {
        console.error(`❌ [Webhook] Error processing webhook:`, error);
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
    
    // NYAN AI TRINITY: Idris (ι - Scribe) + Horus (Ω - Watcher)
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
    
    console.log('🧿 Initializing Nyan AI Audit bots...');
    try {
        await idrisBot.initialize();
        await horusBot.initialize();
        console.log('✨ Nyan AI Audit ready: Idris (ι) + Horus (Ω)');
    } catch (error) {
        console.error('❌ Nyan AI Audit initialization failed:', error.message);
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
    // SECURITY: Compartmentalized secrets - each route receives only what it needs
    // Secrets are passed as closures, not raw env vars, to prevent accidental serialization
    initDeps({
        pool,
        tenantManager,
        authService,
        fractalId,
        constants: {
            // Webhook URLs (not tokens) - safe to pass
            NYANBOOK_LEDGER_WEBHOOK: process.env.NYANBOOK_WEBHOOK_URL,
            LIMBO_THREAD_ID: process.env.LIMBO_THREAD_ID
            // NOTE: HERMES_TOKEN removed - bot already initialized, token not needed downstream
        },
        bots: {
            hermes: hermesBot,
            thoth: thothBot,
            idris: idrisBot,
            horus: horusBot
        },
        tenantMiddleware: {
            setTenantContext,
            getAllTenantSchemas,
            sanitizeForRole
        },
        helpers: {
            logAudit,
            getTimestamp,
            noCacheHeaders,
            createSessionRecord
        }
    });
    
    // === SATELLITE REGISTRATION (inlined from route-registry) ===
    const SATELLITE_META = {
        'auth': { emoji: '🔐', desc: 'lifecycle, sessions, JWT, audit trail', endpoints: 19 },
        'books': { emoji: '📚', desc: 'CRUD, drops, messages, search, tags, export', endpoints: 26 },
        'inpipe': { emoji: '📥', desc: 'Twilio webhook, media relay', endpoints: 1 },
        'nyan-ai': { emoji: '🌈', desc: 'playground, vision, audit, book history', endpoints: 7 }
    };
    
    const formatPulseLog = (satellites, phiStatus = 'online') => {
        const timestamp = new Date().toISOString();
        const lines = [`🫀 PULSE │ ${timestamp} │ Vegapunk`];
        const lastIdx = satellites.length - 1;
        satellites.forEach((name, idx) => {
            const meta = SATELLITE_META[name] || { emoji: '📦', desc: 'unknown', endpoints: '?' };
            const prefix = idx === lastIdx ? '└─' : '├─';
            lines.push(`${prefix} ${meta.emoji} ${name.padEnd(10)} (${String(meta.endpoints).padStart(2)}) → ${meta.desc}`);
        });
        const satelliteEndpoints = satellites.reduce((sum, name) => sum + (SATELLITE_META[name]?.endpoints || 0), 0);
        lines.push(`📊 VITALS: ${satelliteEndpoints + 11} endpoints │ ${satellites.length} satellites + kernel(11) │ O(1) │ φ-rhythm: ${phiStatus}`);
        return lines.join('\n');
    };
    
    // Register all satellites in priority order
    const authResult = registerAuthRoutes(app, deps);
    setDepsMiddleware(authResult.requireAuth, authResult.requireRole);
    registerBooksRoutes(app, deps);
    registerInpipeRoutes(app, deps);
    registerNyanAIRoutes(app, deps);
    
    console.log('\n' + formatPulseLog(['auth', 'books', 'inpipe', 'nyan-ai']) + '\n');
    
    // Global error handling (must be after all routes)
    app.use(notFoundHandler);
    app.use(createErrorHandler({ isProd, logger: console }));
    
    // DEFERRED STARTUP: Run non-critical tasks via unified phi breathe orchestrator
    // This prevents connection pool exhaustion during startup
    setTimeout(async () => {
        // AUTO-HEAL: Priority queue-based healing (O(log n) instead of O(n²))
        // Uses modular heal-queue system from lib/heal-queue.js
        // DEFENSIVE: Explicit null guard + ready check (bot instantiated synchronously above)
        if (hermesBot !== null && hermesBot !== undefined && typeof hermesBot.isReady === 'function' && hermesBot.isReady()) {
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
        
        // Heartbeat checkpoint every 86 breaths (~15min)
        phiBreathe.setHeartbeatCallback((breathCount) => {
            const satellites = ['auth', 'books', 'inpipe', 'nyan-ai'];
            console.log('\n' + formatPulseLog(satellites, 'online') + '\n');
        });
        
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

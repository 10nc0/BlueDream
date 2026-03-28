// Vegapunk.js - The Kernel (previously index.js 8000+ lines)
// Named after Dr. Vegapunk (One Piece) - the genius scientist who splits
// his consciousness into satellite bodies while maintaining a pure core.
// This kernel orchestrates 4 modular routes (satellites) via dependency injection.

// EARLY GUARD — fail loudly before any module loads
// Without DATABASE_URL the pool crashes silently and CSS never serves (ghost UI)
// NOTE: intentional console.error — process.exit(1) path fires before logger is initialized
if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set. Add it to Replit Secrets before starting.');
    console.error('   Get a free PostgreSQL URL from https://supabase.com');
    process.exit(1);
}

const { execSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const { Pool } = require('pg');
const format = require('pg-format'); // Safe SQL identifier quoting (pg-format %I)
const session = require('express-session');
const connectPg = require('connect-pg-simple');
const rateLimit = require('express-rate-limit');
const logger = require('./lib/logger');
const { VALID_SCHEMA_PATTERN } = require('./lib/validators');
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
const { createSendToLedger } = require('./lib/discord-webhooks');
const { routeUserOutput } = require('./lib/outpipes/router');
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
    PLAYGROUND_AI_KEY: 'AI Playground reasoning (Groq Llama 3.3)'
};

const missingCriticalSecrets = Object.entries(criticalSecrets).filter(([key]) => !process.env[key]);

if (missingCriticalSecrets.length > 0) {
    // NOTE: intentional console.error — process.exit(1) path fires before logger is reliable
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
        logger.warn({ usage: Math.round(usage), total: pool.totalCount, max: pool.options.max }, 'Pool capacity high');
    }
    logger.debug({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }, '🏊 Pool: connection acquired');
});

pool.on('error', (err) => {
    logger.error({ err }, 'Pool: unexpected error on idle client');
});

pool.on('remove', () => {
    logger.debug({ total: pool.totalCount, idle: pool.idleCount }, 'Pool: connection released');
});

// SAFETY: Defensive parsing with explicit format assertion
const dbUrlParts = process.env.DATABASE_URL?.split('@');
if (!dbUrlParts || dbUrlParts.length < 2) {
    logger.warn('DATABASE_URL format unexpected, using fallback host identifier');
}
const dbHost = dbUrlParts?.[1]?.split('.')[0] || 'unknown';

logger.info({ mode: isProd ? 'production' : 'development', dbHost, poolMax: pool.options.max, poolMin: pool.options.min, idleTimeoutMs: pool.options.idleTimeoutMillis }, '⚙️ Startup config');

const tenantManager = new TenantManager(pool);

// AUTH MIDDLEWARE: Create early so routes can use requireAuth/requireRole
const { requireAuth, requireRole } = createAuthMiddleware(pool, authService, logger);

// Cache-busting headers helper (prevents browsers/CDNs from caching sensitive responses)
function noCacheHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
}

// REQUEST CONTEXT: AsyncLocalStorage for request-scoped data (no global console patching)
const requestContext = new AsyncLocalStorage();

const app = express();

// EARLY STATIC — serve CSS/JS/icons before any auth or DB middleware
// These assets have zero DB dependency. A DB crash must never ghost the UI.
// HTML files are deliberately excluded — they remain behind auth routes below.
['/css', '/js', '/icons', '/vendor', '/lib'].forEach(p =>
    app.use(p, express.static(path.join(__dirname, `public${p}`)))
);
app.use('/manifest.json', express.static(path.join(__dirname, 'public/manifest.json')));
// SW must never be cached — browsers check byte-equality to detect updates.
// If the browser serves a cached sw.js, the version bump never takes effect.
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'public/sw.js'));
});

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
            frameAncestors: ["'self'", "https://replit.com", "https://*.replit.dev", "https://*.replit.com", "https://*.replit.app"], // apex + subdomains; wildcard alone misses bare replit.com
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false, // Required for iframe embedding
    frameguard: false // X-Frame-Options removed; frameAncestors CSP is the modern replacement
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
        
        // During startup: always return 200 (Autoscale needs 30s grace for DB init —
        // changing to 503 here risks a restart loop before the pool has warmed up).
        // After startup: return 503 if DB is down.
        // Body always reflects true state (status: "starting" vs "healthy") for observability.
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
        
        // Allow custom domain (APP_DOMAIN)
        const appDomain = config.replit.primaryDomain;
        if (appDomain && origin.includes(appDomain)) {
            return callback(null, true);
        }
        
        // Check against whitelist (if configured)
        if (allowedOrigins.length > 0 && allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        
        logger.warn({ origin }, 'CORS blocked origin');
        
        // SECURITY: Default deny if not in Replit domains or whitelist
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true, // Required for cookie-based auth
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json({
    limit: '10mb',
    verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
})); // Increased for image uploads; verify captures rawBody for webhook signature validation
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
                logger.warn('Session prune failed (connection reset) – will retry next cycle');
            } else {
                logger.error({ err }, 'Session store error');
            }
        }
    }),
    secret: process.env.SESSION_SECRET,
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
            logger.warn({ method: req.method, path: req.path, durationMs: duration }, 'Slow request');
        }
    });
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

app.get('/api/client-constants.js', (req, res) => {
    const { BOOK_ID_PATTERN } = require('./lib/validators');
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(`window.Nyan=window.Nyan||{};window.Nyan.BOOK_ID_PATTERN=${BOOK_ID_PATTERN};`);
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
app.use(express.static(path.join(__dirname, 'public'), { 
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

// Readiness gate — blocks all API requests until server is fully initialized
// Prevents "unexpected error" hits during the startup window (bot logins + DB init)
let serverReady = false;
app.use('/api/', (req, res, next) => {
    if (!serverReady) {
        return res.status(503).json({
            code: 'warming_up',
            message: 'Server is starting up, please retry in a few seconds.',
            retryAfter: 5
        });
    }
    next();
});

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

        // ── Parallel batch: all independent core.* tables + public.sessions ──
        // Each init function is self-contained (CREATE IF NOT EXISTS + indexes).
        // Only dependency: core schema must exist (satisfied by initializeCoreSchema above).
        await Promise.all([
            _initSessions(),
            _initBookRegistry(),
            _initMessageLedger(),
            _initPasswordResetTokens(),
            _initSystemTables(),
        ]);

        // book_engaged_phones + channel_identifiers depend on book_registry (FK),
        // so they run after the parallel batch, but parallel with each other.
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
        
        logger.info('🎮 Playground usage table ready');
    } catch (error) {
        logger.warn({ err: error }, 'Failed to create usage table');
    }
}

// DUAL-OUTPUT DELIVERY ARCHITECTURE
// Output #01: Nyanbook Ledger (eternal, Discord-only, immutable append-only record)
// Output #0n: User outpipes — per-book configurable: discord | email | webhook
// DATABASE ROLE: Stores ONLY routing metadata (URLs, thread IDs, outpipe configs) — NOT messages

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
// Initialized to explicit throwers — serverReady gate prevents real calls before assignment,
// but this makes any mis-ordering immediately obvious rather than a silent TypeError.
let sendToLedger = () => { throw new Error('sendToLedger called before server initialization'); };

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
            logger.debug({ fractalId: fractalIdInput, tenantSchema }, 'Parsed fractal_id');
            return tenantSchema;
        }
        
        // Detect legacy numeric IDs and reject explicitly
        const numericId = parseInt(fractalIdInput);
        if (!isNaN(numericId)) {
            logger.error({ numericId }, 'DEPRECATED: Numeric book ID rejected — use fractal_id instead');
            throw new Error(`Legacy numeric book ID not supported. Use fractal_id format.`);
        }
        
        logger.error({ fractalId: fractalIdInput }, 'Invalid fractal_id format — refusing to fall back to public schema');
        throw new Error(`Invalid fractal_id format: ${fractalIdInput}`);
    } catch (error) {
        logger.error({ fractalId: fractalIdInput, err: error }, 'Error resolving tenant for book');
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

// User-Agent parsed and IP stored in tenant schema for user-facing session management. No third-party geolocation.
async function createSessionRecord(userId, sessionId, req, tenantSchema) {
    try {
        const userAgent = req.get('user-agent') || '';
        const { deviceType, browser, os } = parseUserAgent(userAgent);
        const ip = req.ip || '';
        const location = (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.'))
            ? 'Local Network'
            : 'Unknown Location';
        
        // SECURITY: Validate tenant schema name before interpolation (primary guard)
        if (!tenantSchema || tenantSchema === 'undefined' || !VALID_SCHEMA_PATTERN.test(tenantSchema)) {
            logger.error({ tenantSchema }, 'Session creation: invalid tenant schema');
            return;
        }

        // Use tenant-scoped active_sessions table
        // SECURITY: pg-format %I safely double-quotes the identifier (defense-in-depth)
        await pool.query(
            format(`INSERT INTO %I.active_sessions (user_id, session_id, ip_address, user_agent, device_type, browser, os, location) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, tenantSchema),
            [userId, sessionId, req.ip, userAgent, deviceType, browser, os, location]);
        
        logger.info({ userId, deviceType, browser, os, ip: req.ip, location }, 'Session created');
    } catch (error) {
        logger.error({ err: error }, 'Error creating session record');
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
            logger.warn('Audit logging skipped — no tenant schema available');
            return;
        }

        // SECURITY: Validate schema name before interpolation
        if (!VALID_SCHEMA_PATTERN.test(schema)) {
            logger.error({ schema }, 'Audit logging: invalid schema skipped');
            return;
        }
        
        // Fetch email if we have userId but not email (from tenant-scoped users table)
        if (actorUserId && !actorEmail) {
            const userResult = await client.query(
                format(`SELECT email FROM %I.users WHERE id = $1`, schema),
                [actorUserId]
            );
            actorEmail = userResult.rows[0]?.email || null;
        }
        
        // Use tenant-scoped audit_logs table
        await client.query(
            format(`INSERT INTO %I.audit_logs (
                actor_user_id, action_type, target_type,
                target_id, details, ip_address, user_agent
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`, schema),
            [
                actorUserId,
                actionType,
                targetType,
                targetId,
                JSON.stringify(details),
                req.ip || req.connection?.remoteAddress || 'system',
                (req.get && typeof req.get === 'function') ? req.get('user-agent') : 'system'
            ]);
    } catch (error) {
        logger.error({ err: error }, 'Audit logging failed');
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
        logger.warn({ ip: req.ip }, 'Webhook rate limit exceeded');
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
        
        // SECURITY: Validate schema name before interpolation (primary guard)
        if (!VALID_SCHEMA_PATTERN.test(tenantSchema)) {
            return res.status(400).json({ error: 'Invalid tenant schema' });
        }
        // safeSchema removed — pg-format %I handles identifier quoting (defense-in-depth)

        // Get tenant-scoped database client
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // TRANSACTION MODE: Use explicit schema prefix instead of SET LOCAL search_path
            
            // Find book by fractal_id
            // SECURITY: pg-format %I safely double-quotes the schema identifier
            const bookResult = await client.query(
                format(`SELECT id, fractal_id, name, output_01_url, output_0n_url, output_credentials, outpipes_user FROM %I.books WHERE fractal_id = $1`, tenantSchema),
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
                    logger.error({ bookId: fractalIdParam, err: jsonError }, 'Corrupted output_credentials for book');
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
            
            // DUAL-OUTPUT DELIVERY
            // Output #01: Nyanbook Ledger (eternal, Discord-only — immutable append-only)
            // Output #0n: User outpipes (per-book config: discord | email | webhook)
            const threadName = book.output_credentials?.thread_name;
            const threadId = book.output_credentials?.thread_id;

            // Path 1: Nyanbook Ledger (Output #01) — stays Discord-only
            await sendToLedger(discordPayload, {
                isMedia: !!media_url,
                threadName,
                threadId
            }, book);

            // Path 2: User outpipes (Output #0n) — binary ledger/user-output routing
            const capsule = {
                sender: senderName,
                text: text || '',
                media_url: media_url || null,
                avatar_url: avatar_url || null,
                book_name: book.name || null,
                timestamp: new Date().toISOString()
            };
            await routeUserOutput(capsule, { isMedia: !!media_url }, book);
            
            await client.query('COMMIT');
            client.release();
            
            logger.info({ sender: senderName, bookId: fractalIdParam }, 'Webhook: forwarded message to book');
            res.json({ success: true, message: 'Message forwarded to Webhook' });
            
        } catch (error) {
            // DEFENSIVE: try/finally ensures connection release even if ROLLBACK fails
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                logger.error({ err: rollbackError }, 'ROLLBACK failed (connection likely broken)');
            } finally {
                client.release();
            }
            throw error;
        }
    } catch (error) {
        logger.error({ err: error }, 'Webhook: error processing request');
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', async () => {
    logger.info({ port: PORT }, '🌐 Dashboard listening');
    
    // TRINITY ARCHITECTURE: Hermes (φ - Creator) + Thoth (0 - Mirror)
    // Security: Principle of least privilege - each bot has minimal permissions
    hermesBot = new HermesBot();
    thothBot = new ThothBot();
    
    // NYAN AI TRINITY: Idris (ι - Scribe) + Horus (Ω - Watcher)
    // Separate channel/bots for AI audit logging (data silo)
    idrisBot = new IdrisBot();
    horusBot = new HorusBot();
    
    // ── Parallel startup ────────────────────────────────────────────────────
    // Discord bots (network: WebSocket handshake + Discord READY event) and
    // database init (network: PostgreSQL) are fully independent — run together.
    // Total time = max(bot_login, db_init) instead of their sum.
    // Bots are only needed for authenticated users / inpipe webhooks, so they
    // are always ready before the first such request can arrive.
    logger.info('⚡ Parallel startup: bots + DB (all 4 bots ∥ DB init)...');

    const initBots = async () => {
        try {
            await Promise.all([
                hermesBot.initialize(),
                thothBot.initialize(),
                idrisBot.initialize(),
                horusBot.initialize()
            ]);
            logger.info('🤖 All bots ready: Hermes (φ) + Thoth (0) + Idris (ι) + Horus (Ω)');
        } catch (error) {
            logger.error({ err: error }, 'Bot initialization failed — Discord features may be unavailable');
        }
    };

    const initDb = async () => {
        await initializeDatabase();

        // Initialize Discord webhook factories (DI pattern)
        sendToLedger = createSendToLedger(pool, NYANBOOK_LEDGER_WEBHOOK);

        // Reputation + usage tables can also run in parallel (independent)
        capacityManager.setDbPool(pool);
        usageTracker.setDbPool(pool);
        await Promise.all([
            capacityManager.initReputationTable(),
            initUsageTable()
        ]);
        await usageTracker.loadTodayUsageFromDb();
    };

    await Promise.all([initBots(), initDb()]);
    
    // Server is now ready for requests
    logger.info('🌸 Multi-tenant NyanBook~ ready');
    
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
            LIMBO_THREAD_ID: process.env.LIMBO_THREAD_ID,
            // Environment tag — inpipe uses this to label ledger rows
            IS_PROD: isProd
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
            noCacheHeaders,
            createSessionRecord
        }
    });
    
    // === SATELLITE REGISTRATION (inlined from route-registry) ===
    const SATELLITE_LABELS = {
        'auth':    { emoji: '🔐', desc: 'lifecycle, sessions, JWT, audit trail' },
        'books':   { emoji: '📚', desc: 'CRUD, drops, messages, search, tags, export' },
        'inpipe':  { emoji: '📥' },
        'nyan-ai': { emoji: '🌈', desc: 'playground, vision, audit, book history, psi-ema data, diagnostics' }
    };

    const formatPulseLog = (satellites, phiStatus = 'online') => {
        const _d = new Date();
        const timestamp = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')} ${String(_d.getHours()).padStart(2,'0')}:${String(_d.getMinutes()).padStart(2,'0')}:${String(_d.getSeconds()).padStart(2,'0')}`;
        const lines = [`🫀 PULSE │ ${timestamp} │ Vegapunk`];
        const lastIdx = satellites.length - 1;
        let totalEndpoints = 0;
        satellites.forEach((sat, idx) => {
            const label = SATELLITE_LABELS[sat.name] || { emoji: '📦' };
            const desc = sat.desc || label.desc || 'unknown';
            const prefix = idx === lastIdx ? '└─' : '├─';
            lines.push(`${prefix} ${label.emoji} ${sat.name.padEnd(10)} (${String(sat.endpoints).padStart(2)}) → ${desc}`);
            totalEndpoints += sat.endpoints;
        });
        lines.push(`📊 VITALS: ${totalEndpoints + 14} endpoints │ ${satellites.length} satellites + kernel(14) │ O(1) │ φ-rhythm: ${phiStatus}`);
        return lines.join('\n');
    };
    
    // Register all satellites in priority order
    const registeredSatellites = [];

    const authResult = registerAuthRoutes(app, deps);
    setDepsMiddleware(authResult.requireAuth, authResult.requireRole);
    registeredSatellites.push({ name: 'auth', endpoints: authResult.endpoints });

    const booksResult = registerBooksRoutes(app, deps);
    registeredSatellites.push({ name: 'books', endpoints: booksResult.endpoints });

    const inpipeResult = registerInpipeRoutes(app, deps);
    const activeChannels = [
        'WhatsApp',
        process.env.LINE_CHANNEL_SECRET ? 'LINE' : null,
        process.env.EMAIL_INPIPE_SECRET ? 'email' : null,
        process.env.TELEGRAM_BOT_TOKEN  ? 'Telegram' : null
    ].filter(Boolean);
    registeredSatellites.push({
        name: 'inpipe',
        endpoints: inpipeResult.endpoints,
        desc: `${activeChannels.join(' + ')} inpipe, per-channel webhooks`
    });

    const nyanAIResult = registerNyanAIRoutes(app, deps);
    registeredSatellites.push({ name: 'nyan-ai', endpoints: nyanAIResult.endpoints });
    
    // NOTE: intentional console.log — multi-line ASCII art; logger would escape newlines
    console.log('\n' + formatPulseLog(registeredSatellites) + '\n');

    // PRODUCTION SAFETY: Hard-fail if critical secrets are still .env.example placeholders.
    // Placeholder SESSION_SECRET → JWTs are trivially forgeable (known string, public repo).
    // Placeholder FRACTAL_SALT  → capsule HMAC proofs restart-invalid (ephemeral fallback corrupts integrity).
    (() => {
        const PLACEHOLDER_SESSION = 'change-me-to-a-long-random-string-in-production';
        const PLACEHOLDER_FRACTAL  = 'change-me-to-a-random-64-char-hex-string-in-production';
        if (process.env.NODE_ENV === 'production') {
            const faults = [];
            if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === PLACEHOLDER_SESSION) {
                faults.push('SESSION_SECRET is unset or still the .env.example placeholder — JWTs are forgeable');
            }
            if (!process.env.FRACTAL_SALT || process.env.FRACTAL_SALT === PLACEHOLDER_FRACTAL) {
                faults.push('FRACTAL_SALT is unset or still the .env.example placeholder — capsule HMAC proofs will be invalid after each restart');
            }
            if (faults.length > 0) {
                faults.forEach(f => logger.error(f));
                logger.error('❌ FATAL: critical secrets are placeholder values — refusing to start in production');
                process.exit(1);
            }
        } else {
            if (process.env.SESSION_SECRET === PLACEHOLDER_SESSION) {
                logger.warn('SESSION_SECRET is still the .env.example placeholder — rotate before deploying to production');
            }
            if (!process.env.FRACTAL_SALT || process.env.FRACTAL_SALT === PLACEHOLDER_FRACTAL) {
                logger.warn('FRACTAL_SALT is unset or placeholder — ephemeral salt active; capsule proofs will not survive restarts (dev only)');
            }
        }
    })();

    // SETUP GUIDE: breadcrumb each unconfigured optional feature so no utility is forgotten
    (() => {
        const checks = [
            // [envKey(s), emoji, feature, hint]
            [['PLAYGROUND_BRAVE_API'],
             '🔍', 'Live web search',
             'AI answers from training data only — set PLAYGROUND_BRAVE_API for real-time knowledge'],
            [['HERMES_TOKEN', 'THOTH_TOKEN', 'IDRIS_AI_LOG_TOKEN', 'HORUS_AI_LOG_TOKEN'],
             '🤖', 'Discord bots (Hermes φ · Thoth 0 · Idris ι · Horus Ω)',
             'Inbound messages will not reach Discord — set all 4 bot tokens + NYANBOOK_WEBHOOK_URL'],
            [['TWILIO_AUTH_TOKEN', 'TWILIO_ACCOUNT_SID'],
             '📱', 'WhatsApp inpipe (Twilio)',
             'WhatsApp → book archiving disabled — set TWILIO_AUTH_TOKEN + TWILIO_ACCOUNT_SID'],
            [['TWILIO_WEBHOOK_URL'],
             '🔗', 'Twilio webhook URL',
             'Signature validation uses guessed URL — set TWILIO_WEBHOOK_URL to your public endpoint (deploy first for persistent URL)'],
            [['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN'],
             '💚', 'LINE OA inpipe',
             'LINE → book archiving disabled — set LINE_CHANNEL_SECRET + LINE_CHANNEL_ACCESS_TOKEN'],
            [['EMAIL_INPIPE_SECRET'],
             '📨', 'Email inpipe (bookcode@yourdomain)',
             'Email → book archiving disabled — set EMAIL_INPIPE_SECRET + configure MX + provider webhook'],
            [['TELEGRAM_BOT_TOKEN'],
             '✈️', 'Telegram inpipe',
             'Telegram → book archiving disabled — set TELEGRAM_BOT_TOKEN (+ optional TELEGRAM_WEBHOOK_SECRET, TELEGRAM_BOT_USERNAME)'],
            [['RESEND_API_KEY'],
             '📧', 'Transactional email (password reset · book sharing)',
             'Users cannot reset password or receive share invites — set RESEND_API_KEY'],
            [['PINATA_JWT'],
             '📌', 'IPFS capsule ledger',
             'Messages archived to Discord only — set PINATA_JWT to enable permanent IPFS backup (pinata.cloud, free 1 GB)'],
            [['NYANBOOK_AI_KEY'],
             '🧠', 'Dashboard AI audit (Nyan AI)',
             'Book audit features disabled — set NYANBOOK_AI_KEY (Groq API key)'],
            [['FRACTAL_SALT'],
             '🔐', 'Fractal ID salt',
             'Using weak dev default — set FRACTAL_SALT to a 64-char random hex in production'],
        ];

        const missing = checks.filter(([keys]) => keys.some(k => !process.env[k]));

        if (missing.length === 0) {
            // NOTE: intentional console.log — human-readable setup banner
            console.log('✅ All optional features configured — full capability unlocked\n');
            return;
        }

        const lines = [
            '┌─ 📋 SETUP GUIDE ─────────────────────────────────────────────────────────────',
            '│  Missing config detected. Each line = one disabled feature.',
            '│',
            ...missing.map(([, emoji, feature, hint]) =>
                `│  ${emoji}  ${feature}\n│     → ${hint}`
            ),
            '│',
            '│  💡 Deploy to Replit for a persistent HTTPS URL (required for webhooks).',
            '│  💡 Each feature works independently — unconfigured ones degrade gracefully.',
            '└───────────────────────────────────────────────────────────────────────────────'
        ];
        // NOTE: intentional console.log — multi-line ASCII setup guide
        console.log(lines.join('\n') + '\n');
    })();

    // Global error handling (must be after all routes)
    app.use(notFoundHandler);
    app.use(createErrorHandler({ isProd, logger }));

    // All routes and error handlers registered — open the gate
    serverReady = true;
    logger.info('🟢 Server ready — accepting API requests');
    
    // BACKGROUND STARTUP: Non-blocking init for background systems.
    // No setTimeout needed — DB pool is already proven alive by initializeDatabase().
    (async () => {
        if (hermesBot !== null && hermesBot !== undefined && typeof hermesBot.isReady === 'function' && hermesBot.isReady()) {
            try {
                logger.info('🏥 Auto-healing: initializing heal queue...');
                healQueue.setDependencies(pool, hermesBot);
                await healQueue.initialize();
                healQueue.start(20000);
            } catch (error) {
                logger.error({ err: error }, 'Auto-heal initialization failed');
            }
        } else {
            logger.warn('Hermes not ready — skipping auto-heal');
        }

        genesisCounter.start();
        logger.info('🔢 Genesis counter started (cat + φ breath tiers)');

        phiBreathe.setPool(pool);
        phiBreathe.setBots({ idris: idrisBot });
        phiBreathe.setCleanupFunctions({ cleanupOldSessions });

        phiBreathe.setHeartbeatCallback((breathCount) => {
            console.log('\n' + formatPulseLog(registeredSatellites, 'online') + '\n');
        });

        await phiBreathe.startPhiBreathe();
        await phiBreathe.orchestrateStartup();

        usageTracker.registerWithHeartbeat(phiBreathe);
    })();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Shutting down gracefully...');
    process.exit(0);
});

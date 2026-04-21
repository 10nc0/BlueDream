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
const session = require('express-session');
const connectPg = require('connect-pg-simple');
const logger = require('./lib/logger');
const twilio = require('twilio');
const authService = require('./lib/auth-service');
const TenantManager = require('./lib/tenant-manager');
const { setTenantContext, getAllTenantSchemas, sanitizeForRole } = require('./lib/tenant-middleware');
const HermesBot = require('./bots/hermes-bot');
const ThothBot = require('./bots/thoth-bot');
const IdrisBot = require('./bots/idris-bot');
const HorusBot = require('./bots/horus-bot');
const fractalId = require('./utils/fractal-id');
const genesisCounter = require('./server/genesis-counter');
const { extractTextFromDocument, getDocumentPrompt } = require('./utils/document-parser');
const { identifyFileType, executeExtractionCascade, formatJSONForGroq, getFinancialPhysicsSeed, intelligentChunking, buildMultiDocContext } = require('./utils/attachment-cascade');
const CONSTANTS = require('./config/constants');
const { modelIdToLabel } = require('./prompts/pharma-analysis');
const { getLegalAnalysisSeed, detectLegalDocument, LEGAL_KEYWORDS_REGEX } = require('./prompts/legal-analysis');
const { formatAuditBadge, runAuditPass } = require('./utils/two-pass-verification');
const { preflightRouter } = require('./utils/preflight-router');
const { createPipelineOrchestrator, PIPELINE_STEPS, fastStreamPersonality, applyPersonalityFormat } = require('./utils/pipeline-orchestrator');
const { recordInMemory, clearSessionMemory } = require('./utils/context-extractor');
const { getMemoryManager, cleanupOldSessions } = require('./utils/memory-manager');

const { initialize: initDeps, setMiddleware: setDepsMiddleware, deps } = require('./lib/deps');
const { createAuthMiddleware, registerAuthRoutes } = require('./routes/auth');
const { registerBooksRoutes } = require('./routes/books');
const { registerPipeRoutes } = require('./routes/pipe');
const { registerNyanAIRoutes, capacityManager, usageTracker } = require('./routes/nyan-ai');
const { healQueue } = require('./lib/heal-queue');
const phiBreathe = require('./lib/phi-breathe');
const { createSendToLedger } = require('./lib/discord-webhooks');
const { createErrorHandler, notFoundHandler } = require('./lib/error-handler');
const { config, buildConnectionString, getDbHost } = require('./config');
const { createSessionRecord: _createSessionRecord, logAudit: _logAudit } = require('./lib/session-utils');
const { createDbInit } = require('./lib/db-init');

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
    PLAYGROUND_AI_KEY: `AI Playground reasoning (${modelIdToLabel(CONSTANTS.getLLMBackend().model)})`
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
        secure: isProd, // true in production (REPLIT_DEPLOYMENT=1 or NODE_ENV=production)
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
            logger.warn({ durationMs: duration }, `🐢 Slow request: ${req.method} ${req.path} (${duration}ms)`);
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

// Model info — used by playground welcome text and sources footer
app.get('/api/playground/model-info', (req, res) => {
    const backend = CONSTANTS.getLLMBackend();
    res.json({
        modelLabel: modelIdToLabel(backend.model),
        modelId:    backend.model
    });
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
    const { PHI_BREATHE } = require('./config/constants');
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(
        `window.Nyan=window.Nyan||{};` +
        `window.Nyan.BOOK_ID_PATTERN=${BOOK_ID_PATTERN};` +
        `window.Nyan.PHI_BREATHE={base:${PHI_BREATHE.BASE_INTERVAL_MS},phi:${PHI_BREATHE.PHI}};`
    );
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


// DUAL-OUTPUT DELIVERY ARCHITECTURE
// Output #01: Nyanbook Ledger (eternal, Discord-only, immutable append-only record)
// Output #0n: User outpipes — per-book configurable: discord | email | webhook
// DATABASE ROLE: Stores ONLY routing metadata (URLs, thread IDs, outpipe configs) — NOT messages

// HELPER: Get file extension from MIME type (supports ALL formats)

// Discord webhook helpers moved to lib/discord-webhooks.js
// Factory functions created in app.listen() for DI pattern
// Initialized to explicit throwers — serverReady gate prevents real calls before assignment,
// but this makes any mis-ordering immediately obvious rather than a silent TypeError.
let sendToLedger = () => { throw new Error('sendToLedger called before server initialization'); };
let _queueProcessorReady = false;
let stopQueueProcessor = () => {
    if (!_queueProcessorReady) logger.warn('SIGTERM arrived before queue processor initialized — skipping wait');
    return Promise.resolve();
};

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

const logAudit = _logAudit;
const createSessionRecord = (userId, sessionId, req, tenantSchema) =>
    _createSessionRecord(pool, userId, sessionId, req, tenantSchema);


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

    const { initializeDatabase, initUsageTable, migrationRunner } = createDbInit(pool, tenantManager);
    tenantManager.setMigrationRunner(migrationRunner);

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
        await Promise.all([
            capacityManager.hydrateAllCircuitBreakers(),
            usageTracker.loadTodayUsageFromDb()
        ]);
    };

    await Promise.all([initBots(), initDb()]);

    // Register all bots in the NyanMesh node registry (in-memory, snapshotted to DB at 86-breath).
    // Initial status reflects actual bot readiness (may be 'offline' if token missing).
    phiBreathe.registerNode('hermes', { role: 'creator', symbol: 'φ', status: hermesBot.isReady() ? 'online' : 'offline' });
    phiBreathe.registerNode('thoth',  { role: 'mirror',  symbol: '0', status: thothBot.isReady()  ? 'online' : 'offline' });
    phiBreathe.registerNode('idris',  { role: 'scribe',  symbol: 'ι', status: idrisBot.isReady()  ? 'online' : 'offline' });
    phiBreathe.registerNode('horus',  { role: 'watcher', symbol: 'Ω', status: horusBot.isReady()  ? 'online' : 'offline' });

    // Wire bot lifecycle events → NyanMesh deregister/reregister
    // Uses public .client property (plain JS object field, not encapsulated)
    const botLifecycle = [
        { name: 'hermes', bot: hermesBot },
        { name: 'thoth',  bot: thothBot  },
        { name: 'idris',  bot: idrisBot  },
        { name: 'horus',  bot: horusBot  }
    ];
    for (const { name, bot } of botLifecycle) {
        if (!bot.client) continue;
        bot.client.on('shardDisconnect', () => {
            logger.warn({ node: name }, '🔌 NyanMesh: bot disconnected — %s', name);
            phiBreathe.deregisterNode(name);
        });
        bot.client.on('error', () => {
            phiBreathe.deregisterNode(name);
        });
        bot.client.on('ready', () => {
            logger.info({ node: name }, '🔌 NyanMesh: bot reconnected — %s', name);
            phiBreathe.updateNodeStatus(name, true);
        });
    }

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
            createSessionRecord,
            sendToLedger
        }
    });
    
    // === SATELLITE REGISTRATION (inlined from route-registry) ===
    const SATELLITE_LABELS = {
        'auth':    { emoji: '🔐', desc: 'lifecycle, sessions, JWT, audit trail' },
        'books':   { emoji: '📚', desc: 'CRUD, drops, messages, search, tags, export, closings' },
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

    const pipeResult = registerPipeRoutes(app, deps);
    stopQueueProcessor = pipeResult.stopQueueProcessor || (() => Promise.resolve());
    _queueProcessorReady = true;
    const activeChannels = [
        'WhatsApp',
        process.env.LINE_CHANNEL_SECRET ? 'LINE' : null,
        process.env.EMAIL_INPIPE_SECRET ? 'email' : null,
        process.env.TELEGRAM_BOT_TOKEN  ? 'Telegram' : null
    ].filter(Boolean);
    registeredSatellites.push({
        name: 'pipe',
        endpoints: pipeResult.endpoints,
        desc: `${activeChannels.join(' + ')} inbound channels + agent read`
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
            [['EXA_API_KEY'],
             '🔍', 'Exa search (semantic cascade tier)',
             'Search cascade is DDG+Brave only — set EXA_API_KEY to add semantic fallback (exa.ai, 1k/month free)'],
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
            [['FIRECRAWL_API_KEY'],
             '🕷️', 'Firecrawl source enrichment',
             'Audit sources use raw HTML — set FIRECRAWL_API_KEY for clean markdown context (firecrawl.dev, 500/month free)'],
            [['NYANBOOK_AI_KEY'],
             '🧠', 'Dashboard AI audit (Nyan AI)',
             'Book audit features disabled — set NYANBOOK_AI_KEY (Groq API key)'],
            [['OPENROUTER_API_KEY'],
             '🔀', 'OpenRouter LLM fallback',
             'Groq-only mode — set OPENROUTER_API_KEY to enable LLM failover (openrouter.ai, free account)'],
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

        const { worker: outboxWorker } = require('./lib/outpipes/worker');
        outboxWorker.setPool(pool);
        outboxWorker.start(3000);

        genesisCounter.start();
        logger.info('🔢 Genesis counter started (cat + φ breath tiers)');

        phiBreathe.setPool(pool);
        phiBreathe.setBots({ hermes: hermesBot, thoth: thothBot, idris: idrisBot, horus: horusBot });
        phiBreathe.setCleanupFunctions({ cleanupOldSessions });

        phiBreathe.setHeartbeatCallback((breathCount) => {
            console.log('\n' + formatPulseLog(registeredSatellites, 'online') + '\n');
            // Refresh NyanMesh node statuses — use Discord.js client.isReady() (checks WS READY state)
            // rather than wrapper isReady() which never resets ready flag on disconnect.
            phiBreathe.updateNodeStatus('hermes', hermesBot.client?.isReady() ?? false);
            phiBreathe.updateNodeStatus('thoth',  thothBot.client?.isReady()  ?? false);
            phiBreathe.updateNodeStatus('idris',  idrisBot.client?.isReady()  ?? false);
            phiBreathe.updateNodeStatus('horus',  horusBot.client?.isReady()  ?? false);
        });

        await phiBreathe.startPhiBreathe();
        await phiBreathe.orchestrateStartup();

        usageTracker.registerWithHeartbeat(phiBreathe);
    })();
});

// Graceful shutdown — stop the queue processor and wait for the current
// in-flight message to finish before exiting, so mid-ledger-write Discord
// calls are not abandoned. A 5s timeout guards against a hung item.
async function gracefulShutdown(signal) {
    logger.info({ signal }, 'Graceful shutdown: stopping queue processor...');
    try {
        await Promise.race([
            stopQueueProcessor(),
            new Promise(resolve => setTimeout(resolve, 5000))
        ]);
    } catch (_) {}
    logger.info('Graceful shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

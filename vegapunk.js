// Vegapunk.js - The Kernel (previously index.js 8000+ lines)
// Named after Dr. Vegapunk (One Piece) - the genius scientist who splits
// his consciousness into satellite bodies while maintaining a pure core.
// This kernel orchestrates 4 modular routes (satellites) via dependency injection.

const { StartupState, featureGate } = require('./lib/startup-state');
const { MaintenanceQueue } = require('./lib/maintenance-queue');
const startup = new StartupState(message => console.log(message));
startup.mark('process-start', 0);

(async function boot() {

// EARLY GUARD — resolve a working PostgreSQL source before any module loads.
// Tries DATABASE_URL first (with a real handshake), falls back to discrete PG*
// vars on network/auth failure. Fails closed only when both sources are
// unavailable. NOTE: intentional console.error — runs before logger init.
const { resolveRuntimePool } = require('./lib/db-resolver');
let __dbResolution;
let runtimePool;
try {
    const resolved = await resolveRuntimePool({
        // Keep total kernel + isolated-heartbeat capacity at 20 connections.
        max: 19, min: 2, idleTimeoutMillis: 30000, statement_timeout: 30000,
        query_timeout: 30000, idle_in_transaction_session_timeout: 30000
    });
    __dbResolution = resolved.resolution;
    runtimePool = resolved.pool;
    startup.queries = 1;
    startup.mark('database-handshake');
} catch (err) {
    console.error(err.message);
    console.error('');
    console.error('   Set DATABASE_URL OR PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT.');
    console.error('   Any PostgreSQL provider works (Replit DB, Neon, Supabase, Cloud SQL, RDS, self-hosted).');
    process.exit(1);
}
if (__dbResolution.attempts.length > 0) {
    for (const a of __dbResolution.attempts) {
        console.warn(`⚠️  ${a.source}: ${a.host} did not accept a postgres handshake (${a.code || 'ERR'}), trying next source`);
    }
}
console.log(`✅ Database: using ${__dbResolution.source === 'DATABASE_URL' ? 'DATABASE_URL' : 'PG* env vars'} (${__dbResolution.shortHost})`);

startup.mark('imports-start');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const connectPg = require('connect-pg-simple');
const logger = require('./lib/logger');
const authService = require('./lib/auth-service');
const TenantManager = require('./lib/tenant-manager');
const { setTenantContext, getAllTenantSchemas, sanitizeForRole } = require('./lib/tenant-middleware');
const HermesBot = require('./bots/hermes-bot');
const ThothBot = require('./bots/thoth-bot');
const IdrisBot = require('./bots/idris-bot');
const HorusBot = require('./bots/horus-bot');
const fractalId = require('./utils/fractal-id');
const genesisCounter = require('./server/genesis-counter');
const CONSTANTS = require('./config/constants');
const { modelIdToLabel } = require('./prompts/pharma-analysis');
const { cleanupOldSessions } = require('./utils/memory-manager');

const { initialize: initDeps, setMiddleware: setDepsMiddleware, deps } = require('./lib/deps');
const { createAuthMiddleware, registerAuthRoutes } = require('./routes/auth');
// Admission state is mandatory; route implementations and their search/media
// integrations are not prerequisites for the isolated counter publisher.
const capacityManager = require('./utils/playground-capacity');
const usageTracker = require('./utils/playground-usage');
const { healQueue } = require('./lib/heal-queue');
const phiBreathe = require('./lib/phi-breathe');
const { runMonthlyEmail } = require('./lib/monthly-email');
const { runMonthlyClosing } = require('./lib/monthly-closing');
const { createSendToLedger } = require('./lib/discord-webhooks');
const { createErrorHandler, notFoundHandler } = require('./lib/error-handler');
const { config } = require('./config');
const { createSessionRecord: _createSessionRecord, logAudit: _logAudit } = require('./lib/session-utils');
const { createDbInit } = require('./lib/db-init');
startup.mark('imports-ready');

// ============================================================================
// SECURITY: Fail-Closed Secret Guards (Critical Infrastructure Only)
// ============================================================================
// Strategy: Throw hard errors on startup if critical secrets missing
// Only enforce truly essential secrets - don't require optional integrations

// NOTE: DATABASE_URL is no longer in this list — DB readiness is enforced
// upstream by resolveDatabase() (handles DATABASE_URL OR PG* equivalently).
// NOTE: LLM provider uses an "at-least-one" check below (Groq / OpenRouter / Ollama).
// NOTE: NYANBOOK_WEBHOOK_URL is a soft-warn — Discord is one of several optional outpipes.
const criticalSecrets = {
    SESSION_SECRET: 'Session encryption key',
    FRACTAL_SALT: 'Secure book ID generation (crypto salt)',
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

// All application-managed model roles use Meta Muse Ember through OpenRouter.
const LLM_PROVIDER_KEYS = ['OPENROUTER_API_KEY'];
const hasLLMProvider = LLM_PROVIDER_KEYS.some(k => process.env[k]);
if (!hasLLMProvider) {
    console.error('❌ CRITICAL: No LLM provider configured (fail-closed)');
    console.error('');
    console.error('   Set OPENROUTER_API_KEY for Meta Muse Ember.');
    console.error('');
    console.error('Server will NOT start until OPENROUTER_API_KEY is configured.');
    process.exit(1);
}

const ALLOWED_GROUPS = process.env.ALLOWED_GROUPS ? process.env.ALLOWED_GROUPS.split(',').map(g => g.trim()) : [];
const ALLOWED_NUMBERS = process.env.ALLOWED_NUMBERS ? process.env.ALLOWED_NUMBERS.split(',').map(n => n.trim()) : [];

// GLOBAL CONSTANTS: Nyanbook Ledger (Output #01) - centralized monitoring for all tenants
// Optional — Discord outpipe. Undefined when NYANBOOK_WEBHOOK_URL is not set; callers guard with ?.
const NYANBOOK_LEDGER_WEBHOOK = process.env.NYANBOOK_WEBHOOK_URL;

// ENVIRONMENT CHECK (must be defined before pool for SSL config)
// Replit sets REPLIT_DEPLOYMENT=1 when deployed (not 'true')
const isProd = process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production';

// POOL: built from the resolver. The resolver only appends pool_mode=transaction
// for PgBouncer-style hosts (Supabase pooler, Neon pooler, *.pgbouncer.*) and
// turns SSL off for loopback / RFC1918 / single-label hosts. Custom CA via
// DATABASE_CA_CERT is honored when present.
const pool = runtimePool;
startup.instrumentPool(pool);
const maintenance = new MaintenanceQueue({ pool, concurrency: 1,
    onError: (name, error) => logger.warn({ name, code: error.code }, `Startup maintenance retry: ${name}`) });
phiBreathe.setMaintenanceQueue(maintenance);

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

// Host identifier resolved upstream by db-resolver (handles URL & PG* uniformly).
const dbHost = __dbResolution.shortHost;

logger.info({ mode: isProd ? 'production' : 'development', dbSource: __dbResolution.source, dbHost, poolMax: pool.options.max, poolMin: pool.options.min, idleTimeoutMs: pool.options.idleTimeoutMillis }, '⚙️ Startup config');

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
// Common admission context for all application routes and provider transports.
require('./utils/ai-capacity').install(app, pool);

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
  noCacheHeaders(res);
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

app.get('/health/ready', (req, res) => {
    res.status(serverReady && !startup.stopping ? 200 : 503).json({
        status: serverReady && !startup.stopping ? 'ready' : 'starting',
        schema: startup.phases['schema-ready'] !== undefined, services: startup.services,
        counterReady: phiBreathe.isCounterReady(), leader: !!phiBreathe.isLeader(),
        phasesMs: startup.phases, databaseRoundtrips: startup.queries,
        heartbeatTiming: phiBreathe.heartbeatTiming
    });
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
        checks.discord.thoth.healthy = thothBot.isReady?.() || false;
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
        // Allow requests with no origin (mobile apps, Postman, curl, etc.)
        if (!origin) return callback(null, true);

        // SECURITY: parse the hostname — never use origin.includes() which
        // allows 'x.replit.dev.attacker.com' to spoof '.replit.dev'.
        let host;
        try { host = new URL(origin).hostname; } catch { return callback(new Error('Not allowed by CORS')); }

        // Allow localhost for development (exact host match, no substring)
        if (host === 'localhost' || host === '127.0.0.1') {
            return callback(null, true);
        }

        // Allow any Replit domain — dot prefix enforces the boundary so
        // 'notreplit.dev' and 'x.replit.dev.evil.com' both correctly fail.
        const replitSuffixes = ['.replit.dev', '.repl.co', '.replit.app'];
        if (replitSuffixes.some(s => host === s.slice(1) || host.endsWith(s))) {
            return callback(null, true);
        }

        // Allow custom domain (APP_DOMAIN) — exact host or *.appDomain subdomain
        const appDomain = config.replit.primaryDomain;
        if (appDomain && (host === appDomain || host.endsWith('.' + appDomain))) {
            return callback(null, true);
        }

        // Exact-match whitelist (ALLOWED_ORIGINS env var, full origin strings)
        if (allowedOrigins.length > 0 && allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        logger.warn({ origin, host }, 'CORS blocked origin');

        // SECURITY: Default deny
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
        // SameSite=None requires Secure=true — browsers silently drop the cookie
        // if Secure is false. In local HTTP dev isProd=false, so we fall back to
        // 'lax' which keeps sessions working without the cross-site requirement.
        sameSite: isProd ? 'none' : 'lax', // 'none' required for cross-site iframe embedding in prod
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
    noCacheHeaders(res);
    res.sendFile(__dirname + '/public/playground.html');
});

// Serve Account Settings page (auth-gated via client-side check in settings.html)
app.get('/settings', (req, res) => {
    noCacheHeaders(res);
    res.sendFile(__dirname + '/public/settings.html');
});

// ─── GET /api/v1/nyan/guide — machine-readable API discovery for agents ──────
// No auth required. Returns a compact JSON spec covering all agent-facing
// endpoints. Low token cost — agents read this instead of crawling the repo.
app.get('/api/v1/nyan/guide', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json({
        api: 'NyanBook~',
        version: '1',
        stability: 'stable — fields are additive-only; no field will be removed or renamed without a new version path',
        guide_url: 'GET /api/v1/nyan/guide',
        auth: {
            agent_bearer: 'Per-book agent token. Pass as: Authorization: Bearer <token>. Token is the sole routing key — no book ID needed in write/read URLs.',
            user_bearer: 'User-level bearer token. GET-only. Works on /api/mesh/* and all requireAuth GET routes. Generate via POST /api/me/token (password required). Scoped to your own tenant — cross-book reads within your account, without a session.',
            session: 'Browser cookie JWT. Not suitable for automation.'
        },
        endpoints: [
            {
                id: 'agent_write',
                method: 'POST',
                path: '/api/agent/message',
                auth: 'bearer',
                description: 'Ingest a message into the book bound to the token.',
                request_body: {
                    text: 'string (max 10 000 chars) — message body',
                    username: 'string (max 100) — sender display name, default "External"',
                    avatar_url: 'string URL | null',
                    media_url: 'string URL | null — remote media attachment',
                    media_type: 'string | null — e.g. "image/jpeg"',
                    phone: 'string E.164 | null — e.g. "+15551234567"',
                    email: 'string | null',
                    photos: 'array[{name?,data:base64}] max 5 — inline image attachments',
                    documents: 'array[{name,data:base64,type?}] max 5 — inline document attachments'
                },
                response: { success: true, message: 'Message accepted', book_id: 'bk_...' },
                errors: { 400: 'Invalid payload', 401: 'Bad/missing token', 503: 'Queue full — retry' }
            },
            {
                id: 'agent_read',
                method: 'GET',
                path: '/api/agent/messages',
                auth: 'bearer',
                description: 'Read messages from the book bound to the token. Newest-first.',
                query_params: {
                    limit: 'integer 1–100, default 50',
                    after: 'ISO 8601 timestamp — return messages newer than this',
                    before: 'ISO 8601 timestamp — return messages older than this'
                },
                response: {
                    book: 'book name',
                    book_id: 'bk_...',
                    messages: '[{ id, message_fractal_id, sender, text, timestamp, has_media, media_ipfs_cid, media_ipfs_gateway_url, media_url }]',
                    total: 'count in this page',
                    hasMore: 'boolean',
                    cursor: { newest: 'ISO 8601 | null', oldest: 'ISO 8601 | null' }
                },
                errors: { 401: 'Bad/missing token', 404: 'Book not found' }
            },
            {
                id: 'agent_read_legacy',
                method: 'GET',
                path: '/api/webhook/:fractalId/messages',
                auth: 'bearer + fractalId in URL',
                description: 'Legacy read path — identical response to /api/agent/messages. Token must match the fractalId. Prefer /api/agent/messages (token-only).',
                query_params: { limit: 'integer 1–100, default 50', after: 'ISO 8601', before: 'ISO 8601' }
            },
            {
                id: 'agent_bootstrap',
                method: 'POST',
                path: '/api/agent/bootstrap',
                auth: 'none (tokens in body)',
                description: 'Cold-start memory load for multi-book agents. Pass up to 20 bearer tokens; receive a structured export (recent messages, tags, stats, metadata) per book in one round-trip.',
                request_body: {
                    books: 'array[{ token: string, limit?: integer }] max 20'
                },
                response: {
                    bootstrap_at: 'ISO 8601',
                    total_books: 'integer',
                    books: '[{ book_id, book_name, status, messages: [...], tags: [...], stats: {...} } | { token_hint, error }]'
                },
                rate_limit: '20 req/min per IP',
                errors: { 400: 'Missing/invalid books array', 429: 'Rate limit' }
            },
            {
                id: 'user_token_generate',
                method: 'POST',
                path: '/api/me/token',
                auth: 'session or JWT (requires current password in body)',
                description: 'Generate a user-level bearer token. GET-only cross-tenant credential. Revokes any prior token for this user.',
                request_body: { currentPassword: 'string — required for verification' },
                response: { success: true, token: '<64-char hex — save this, shown once>' },
                errors: { 400: 'Missing password', 401: 'Wrong password', 429: 'Rate limited' }
            },
            {
                id: 'mesh_tag_query',
                method: 'GET',
                path: '/api/mesh/tag/:tagValue',
                auth: 'user_bearer or session',
                description: 'Cross-book tag search (PITA-AOP). Returns all drops in the tenant carrying the given tag, paginated newest-first.',
                query_params: { limit: 'integer 1–200, default 50', before_cursor: 'opaque string from next_cursor' },
                response: {
                    results: '[{ payload_id, book_fractal_id, book_name, sent_at, metadata_text, extracted_tags }]',
                    next_cursor: 'string | null'
                },
                errors: { 400: 'Bad tag/cursor', 401: 'No session' }
            }
        ],
        payload_id_note: 'payload_id = "pi_" + SHA-256(internal_source_id).hex[:32]. Stable across renames/migrations. Never expose source_id.',
        cursor_note: 'Read cursors are ISO 8601 timestamps (after/before). Mesh cursors are opaque base64url — do not construct manually.',
        changelog: [
            { version: '1', date: '2026-06-09', note: 'Initial stable declaration. All existing /api/* routes declared v1. Guide endpoint added at /api/v1/nyan/guide.' }
        ]
    });
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
    noCacheHeaders(res);
    res.sendFile(__dirname + '/public/login.html');
});

// Serve signup page without authentication
app.get('/signup.html', (req, res) => {
    logger.info({ ip: req.ip, ua: req.get('user-agent') }, '📝 Signup page accessed');
    noCacheHeaders(res);
    res.sendFile(__dirname + '/public/signup.html');
});

// Serve dev panel (auth happens client-side via JWT)
app.get('/dev', (req, res) => {
    logger.info({ ip: req.ip }, '🛠️  Dev panel accessed');
    res.sendFile(__dirname + '/public/dev.html');
});

// Root redirects to AI Playground (public landing page)
app.get('/', (req, res) => {
    // Health probes — return 200 immediately.
    //
    // Probes that MUST get 200 (any non-200 including 302 = failed probe):
    //   • Cloud Run startup probe  → ua 'GoogleHC/1.0'
    //   • Kubernetes liveness      → ua 'kube-probe/...'
    //   • Replit deployment probe  → ua does not contain 'Mozilla'
    //     (Replit's own health layer sits above Cloud Run and uses its own UA)
    //
    // HEAD requests (synthetic checks) also get 200.
    // All real browser requests contain 'Mozilla' → redirect to /AI.
    const ua = req.headers['user-agent'] || '';
    const isBrowser = ua.includes('Mozilla');
    if (!isBrowser) {
        return res.status(200).end();
    }

    // Redirect humans to the AI Playground landing page
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
    noCacheHeaders(res);
    res.sendFile(__dirname + '/public/index.html');
});

// Serve index.html - client-side JWT auth will handle access control
app.get('/index.html', (req, res) => {
    noCacheHeaders(res);
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
            noCacheHeaders(res);
        }
    }
}));

// Readiness gate — blocks all API requests until server is fully initialized
// Prevents "unexpected error" hits during the startup window (bot logins + DB init)
let serverReady = false;
app.use('/api/', (req, res, next) => {
    if (!serverReady) {
        return res.set('Retry-After', '5').status(503).json({
            code: 'warming_up',
            message: 'Server is starting up, please retry in a few seconds.',
            retryAfter: 5
        });
    }
    next();
});
app.use('/api/', featureGate({
    get hermes() { return hermesBot; }, get thoth() { return thothBot; },
    get idris() { return idrisBot; }, get horus() { return horusBot; }
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

// ── Genesis-admin authorization ──────────────────────────────────────────
// Checks is_genesis_admin in the DB. Used instead of requireRole('dev') because
// the dev-role bypass is intentionally blocked in production by auth-middleware.
// Must be composed after requireAuth (which populates req.userId / req.tenantSchema).
async function requireGenesisAdmin(req, res, next) {
    if (!req.userId || !req.tenantSchema) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    try {
        const result = await pool.query(
            `SELECT is_genesis_admin FROM ${req.tenantSchema}.users WHERE id = $1`,
            [req.userId]
        );
        if (!result.rows.length || !result.rows[0].is_genesis_admin) {
            return res.status(403).json({ error: 'Genesis admin access required' });
        }
        next();
    } catch (err) {
        logger.error({ err }, 'requireGenesisAdmin: DB query failed');
        res.status(500).json({ error: 'Authorization check failed' });
    }
}

// ── Admin: force-run monthly email (backfill / testing) ──────────────────
// Protected by requireAuth + requireGenesisAdmin (is_genesis_admin DB flag).
// Works in production — does not rely on the dev-role bypass.
// Accepts optional query params:
//   ?month=YYYY-MM   — override the month window (default: previous month)
//   ?force=true      — clear the guard and re-send even if already ran
//   ?closing=true    — also run monthly closing tallies before sending (default: false)
//   ?tenant=tenant_N — only process this single tenant (used to retry one
//                     bounced recipient without re-sending to everyone else)
app.post('/api/admin/monthly-email/fire', requireAuth, requireGenesisAdmin, async (req, res) => {
    try {
        const overrideMonth = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month)
            ? req.query.month
            : null;
        const force   = req.query.force   === 'true';
        const closing = req.query.closing === 'true';
        const tenantSchemaFilter = typeof req.query.tenant === 'string' && /^tenant_\d+$/.test(req.query.tenant)
            ? req.query.tenant
            : null;

        logger.info({ by: req.userId, overrideMonth, force, closing, tenantSchemaFilter }, '📧 Admin: monthly-email fire requested');

        if (closing) {
            await runMonthlyClosing(pool, phiBreathe.bots || {});
        }

        const result = await runMonthlyEmail(pool, { overrideMonth, force, tenantSchemaFilter });
        res.json({ ok: true, result });
    } catch (err) {
        logger.error({ err }, '📧 Admin: monthly-email fire failed');
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Manager initialization moved to app.listen() to prevent race conditions
// This ensures managers are fully initialized before server accepts requests

const logAudit = _logAudit;
const createSessionRecord = (userId, sessionId, req, tenantSchema) =>
    _createSessionRecord(pool, userId, sessionId, req, tenantSchema);


const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, '0.0.0.0', () => {
    initializeKernel().catch(error => {
        startup.services.schema = 'failed';
        logger.error(`Startup failed (${error.code || error.name}) — required schema or routes unavailable`);
        gracefulShutdown('startup_failure', 1);
    });
});
server.on('error', () => gracefulShutdown('listener_failure', 1));
async function initializeKernel() {
    startup.mark('listener');
    logger.info({ port: PORT }, '🌐 Dashboard listening');
    
    // TRINITY ARCHITECTURE: Hermes (φ - Creator) + Thoth (0 - Mirror)
    // Security: Principle of least privilege - each bot has minimal permissions
    hermesBot = new HermesBot();
    thothBot = new ThothBot();
    
    // NYAN AI TRINITY: Idris (ι - Scribe) + Horus (Ω - Watcher)
    // Separate channel/bots for AI audit logging (data silo)
    idrisBot = new IdrisBot();
    horusBot = new HorusBot();
    
    // Schema/budget setup precedes the worker's first observation. Optional
    // Discord connections start afterward, independently of API readiness.
    // Bot-dependent features and workers check actual service readiness.
    logger.info('⚡ Required schema and budget first; optional bot connections deferred until heartbeat...');

    const botEntries = [['hermes', hermesBot], ['thoth', thothBot], ['idris', idrisBot], ['horus', horusBot]];
    const isBotReady = bot => bot.client?.isReady ? bot.client.isReady() : bot.isReady?.();
    let healingStarted = false;
    const startHealing = () => {
        if (startup.stopping || healingStarted || !startup.phases['schema-ready'] || !isBotReady(hermesBot)) return;
        healingStarted = true;
        maintenance.enqueue('heal-recovery', async () => {
            if (startup.stopping || !isBotReady(hermesBot)) { healingStarted = false; return; }
            healQueue.setDependencies(pool, hermesBot);
            await healQueue.initialize();
            if (!startup.stopping) healQueue.start(20000);
            startup.mark('heal-ready');
        }).catch(() => { healingStarted = false; });
    };
    const wireBot = (name, bot) => {
        if (!bot.client || bot.client._startupWired) return;
        bot.client._startupWired = true;
        const ready = () => {
            if (startup.stopping) return bot.client?.destroy?.();
            startup.services[name] = 'ready';
            startup.mark(`bot-${name}-ready`);
            phiBreathe.updateNodeStatus(name, true);
            if (name === 'hermes') startHealing();
            if (name === 'idris') phiBreathe.retryMonthlyClosing();
        };
        bot.client.on('ready', ready);
        bot.client.on('clientReady', ready);
        bot.client.on('shardDisconnect', () => {
            startup.services[name] = 'disconnected';
            phiBreathe.deregisterNode(name);
        });
        bot.client.on('error', () => { startup.services[name] = 'unavailable'; });
    };
    const startBots = () => { for (const [name, bot] of botEntries) {
        startup.services[name] = 'starting';
        bot.client?.on('ready', () => {
            if (startup.stopping) return bot.client.destroy?.();
            startup.services[name] = 'ready';
            startup.mark(`bot-${name}-ready`);
            if (name === 'hermes') startHealing();
        });
        Promise.resolve().then(() => {
            const initialized = bot.initialize();
            wireBot(name, bot);
            return initialized;
        }).then(() => {
            if (startup.stopping) return bot.client?.destroy?.();
            startup.services[name] = isBotReady(bot) ? 'ready' : 'unavailable';
            if (isBotReady(bot)) startup.mark(`bot-${name}-ready`);
            if (name === 'hermes') startHealing();
        }).catch(error => {
            startup.services[name] = 'unavailable';
            logger.warn({ code: error.code, service: name }, `Optional startup service unavailable: ${name}`);
        });
    } };

    const { initializeDatabase, initUsageTable, migrationRunner } = createDbInit(pool, tenantManager);
    tenantManager.setMigrationRunner(migrationRunner);

    const initDb = async () => {
        await initializeDatabase();
        startup.mark('schema-ready');

        // Initialize Discord webhook factories (DI pattern)
        sendToLedger = createSendToLedger(pool, NYANBOOK_LEDGER_WEBHOOK);

        // Reputation + usage tables can also run in parallel (independent)
        capacityManager.setDbPool(pool);
        usageTracker.setDbPool(pool);
        await Promise.all([
            capacityManager.initReputationTable(),
            initUsageTable()
        ]);
        startup.mark('budget-ready');
        // hydrateAllCircuitBreakers + loadTodayUsageFromDb are NOT awaited here —
        // they are fired as background tasks after the boot gate clears (see below).
    };

    await initDb();
    if (startup.stopping) return;
    startHealing();

    // Background hydration — neither job is required before serving requests.
    // Circuit breakers default to inactive and self-correct on first abuse event.
    // Usage buckets start at 0 and self-correct on the next write.
    const deferredBootstrap = [
        maintenance.enqueue('circuit-hydration', () => capacityManager.hydrateAllCircuitBreakers()),
        maintenance.enqueue('usage-hydration', () => usageTracker.loadTodayUsageFromDb()),

    // One-shot migration shims — parallelized and not awaited.
    // Each self-retires (writes a core.boot_flags row) after completing with
    // zero work, so subsequent boots skip them entirely (O(1) flag check).
    // If the flag is absent (fresh DB / restored checkpoint) they run normally.
        maintenance.enqueue('agent-token-backfill', async () => {
            try {
                const { backfillAgentTokens } = require('./lib/backfill-agent-tokens');
                await backfillAgentTokens(pool, logger);
            } catch (err) {
                logger.warn({ err }, 'Agent token backfill failed (non-fatal)');
            }
        }),
        maintenance.enqueue('output-normalization', async () => {
            try {
                const { normalizeOutputCredentials } = require('./lib/normalize-output-credentials');
                await normalizeOutputCredentials(pool);
            } catch (err) {
                logger.warn({ err: err.message }, 'Output credentials normalizer failed (non-fatal)');
            }
        })
    ];
    Promise.allSettled(deferredBootstrap).then(() => startup.mark('maintenance-ready'));

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
        wireBot(name, bot);
    }

    // Server is now ready for requests
    logger.info('🌸 Multi-tenant NyanBook~ ready');
    phiBreathe.setPool(pool);
    phiBreathe.setBots({ hermes: hermesBot, thoth: thothBot, idris: idrisBot, horus: horusBot });
    phiBreathe.setCleanupFunctions({ cleanupOldSessions });
    phiBreathe.setStartupObserver(timing => startup.observeBreath(timing));
    const heartbeat = phiBreathe.startPhiBreathe();
    // Wait for a real worker observation before synchronous optional imports.
    // The API gate stays closed until all routes are registered; the packet
    // queue still requires the worker's nonzero, fresh, fenced counter.
    await heartbeat;
    if (startup.stopping) return;
    startup.mark('optional-work-start');
    startBots();
    const { registerBooksRoutes } = require('./routes/books');
    const { registerPipeRoutes } = require('./routes/pipe');
    const { registerNyanAIRoutes } = require('./routes/nyan-ai');
    const { register: registerAccountRoutes } = require('./routes/account');
    startup.mark('route-imports-ready');
    
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

    const accountResult = registerAccountRoutes(app, deps);
    registeredSatellites.push({ name: 'account', endpoints: accountResult.endpoints });

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
            [['HERMES_TOKEN', 'THOTH_TOKEN', 'IDRIS_AI_LOG_TOKEN', 'HORUS_AI_LOG_TOKEN', 'NYANBOOK_WEBHOOK_URL'],
             '🤖', 'Discord integration (bots + ledger webhook)',
             'Discord outpipe disabled — set all 4 bot tokens + NYANBOOK_WEBHOOK_URL for Discord-backed books'],
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
            [['OPENROUTER_API_KEY'],
             '🧠', 'Dashboard AI audit (Nyan AI)',
             'Book audit features disabled — set OPENROUTER_API_KEY'],
            [['OPENROUTER_API_KEY'],
             '🔀', 'OpenRouter LLM fallback',
             'Groq-only mode — set OPENROUTER_API_KEY to enable LLM failover (openrouter.ai, free account)'],
            [['FRACTAL_SALT'],
             '🔐', 'Fractal ID salt',
             'Using weak dev default — set FRACTAL_SALT to a 64-char random hex in production'],
            [['BACKUP_DISCORD_CHANNEL_ID'],
             '💾', 'Automated weekly database backup (Discord)',
             'Automated backups disabled — set BACKUP_DISCORD_CHANNEL_ID to a Discord channel ID to enable weekly pg_dump snapshots'],
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
    startup.mark('api-ready');
    logger.info('🟢 Server ready — accepting API requests');
    
    // BACKGROUND STARTUP: Non-blocking init for background systems.
    // No setTimeout needed — DB pool is already proven alive by initializeDatabase().
    (async () => {
        startHealing();

        const { worker: outboxWorker } = require('./lib/outpipes/worker');
        outboxWorker.setPool(pool);
        outboxWorker.start(3000);

        genesisCounter.start();
        logger.info('🔢 Genesis counter started (cat + φ breath tiers)');

        // Warn early if RESEND_API_KEY is absent — monthly emails will silently
        // skip until this is set. Surfaced here (not at fire-time) so the missing
        // secret is visible in logs well before the 1st of the month arrives.
        if (!process.env.RESEND_API_KEY) {
            logger.warn('⚠️ RESEND_API_KEY not set — monthly summary emails will not send until this secret is configured');
        }

        phiBreathe.setHeartbeatCallback((breathCount) => {
            console.log('\n' + formatPulseLog(registeredSatellites, 'online') + '\n');
            // Refresh NyanMesh node statuses — use Discord.js client.isReady() (checks WS READY state)
            // rather than wrapper isReady() which never resets ready flag on disconnect.
            phiBreathe.updateNodeStatus('hermes', hermesBot.client?.isReady() ?? false);
            phiBreathe.updateNodeStatus('thoth',  thothBot.client?.isReady()  ?? false);
            phiBreathe.updateNodeStatus('idris',  idrisBot.client?.isReady()  ?? false);
            phiBreathe.updateNodeStatus('horus',  horusBot.client?.isReady()  ?? false);
        });

        await heartbeat;
        if (startup.stopping) return;
        await phiBreathe.orchestrateStartup();

        usageTracker.registerWithHeartbeat(phiBreathe);

        const { runBackup } = require('./lib/backup');
        const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;
        let _lastBackupRunHour = null;
        phiBreathe.subscribe('db-backup', BACKUP_CHECK_INTERVAL_MS, async () => {
            const now = new Date();
            if (now.getUTCDay() !== 0) return;
            if (now.getUTCHours() !== 4) return;
            const hourKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
            if (_lastBackupRunHour === hourKey) return;
            _lastBackupRunHour = hourKey;
            await runBackup(pool);
        });
    })().catch(error => logger.error({ code: error.code }, 'Background startup failed; core remains available'));
}

// Graceful shutdown — stop the queue processor and wait for the current
// in-flight message to finish before exiting, so mid-ledger-write Discord
// calls are not abandoned. A 5s timeout guards against a hung item.
async function gracefulShutdown(signal, code = 0) {
    if (startup.stopping) return;
    startup.close();
    serverReady = false;
    server.close();
    logger.info({ signal }, 'Graceful shutdown: stopping queue processor...');
    healQueue.stop();
    genesisCounter.stop();
    require('./lib/outpipes/worker').worker.stop();
    try {
        await Promise.race([
            Promise.allSettled([stopQueueProcessor(), phiBreathe.shutdown(), maintenance.stop()]),
            new Promise(resolve => setTimeout(resolve, 5000))
        ]);
    } catch (_) {}
    for (const bot of [hermesBot, thothBot, idrisBot, horusBot]) bot?.client?.destroy?.();
    await Promise.race([pool.end(), new Promise(resolve => setTimeout(resolve, 1000))]);
    logger.info('Graceful shutdown complete');
    process.exit(code);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
})().catch(error => {
    console.error(`Startup failed: ${error.code || 'INITIALIZATION_ERROR'}`);
    process.exit(1);
});

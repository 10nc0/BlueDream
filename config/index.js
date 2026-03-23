/**
 * Centralized Configuration Module
 * All environment variables and settings in one place
 */

const constants = require('./constants');

const isProd = process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production';

const config = {
  env: {
    isProd,
    isDev: !isProd,
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT) || 5000
  },

  database: {
    url: process.env.DATABASE_URL,
    poolMode: 'transaction',
    ssl: {
      rejectUnauthorized: isProd
    },
    pool: {
      max: 20, // Direct pool limit; Supabase pooler handles 10k+ upstream
      min: 2,
      connectionTimeoutMillis: constants.TIMEOUTS.DATABASE_CONNECTION,
      idleTimeoutMillis: constants.TIMEOUTS.SESSION_IDLE,
      statementTimeout: constants.TIMEOUTS.DATABASE_STATEMENT,
      queryTimeout: constants.TIMEOUTS.DATABASE_STATEMENT
    }
  },

  session: {
    secret: process.env.SESSION_SECRET || 'book-secret-key-change-in-production',
    maxAge: constants.SESSION.MAX_AGE_MS,
    cookieName: 'book.sid'
  },

  cors: {
    allowedOrigins: process.env.ALLOWED_ORIGINS 
      ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
      : []
  },

  twilio: {
    authToken: process.env.TWILIO_AUTH_TOKEN,
    allowedGroups: process.env.ALLOWED_GROUPS 
      ? process.env.ALLOWED_GROUPS.split(',').map(g => g.trim()) 
      : [],
    allowedNumbers: process.env.ALLOWED_NUMBERS 
      ? process.env.ALLOWED_NUMBERS.split(',').map(n => n.trim()) 
      : []
  },

  discord: {
    hermesToken: process.env.HERMES_TOKEN,
    thothToken: process.env.THOTH_TOKEN,
    idrisToken: process.env.IDRIS_AI_LOG_TOKEN,
    horusToken: process.env.HORUS_AI_LOG_TOKEN,
    ledgerWebhook: process.env.NYANBOOK_WEBHOOK_URL
  },

  ai: {
    groqToken: process.env.PLAYGROUND_AI_KEY || process.env.PLAYGROUND_GROQ_TOKEN,
    groqVisionToken: process.env.PLAYGROUND_GROQ_VISION_TOKEN || process.env.PLAYGROUND_AI_KEY || process.env.PLAYGROUND_GROQ_TOKEN,
    braveApiKey: process.env.PLAYGROUND_BRAVE_API
  },

  email: {
    resendApiKey: process.env.RESEND_API_KEY
  },

  replit: {
    domains: process.env.REPLIT_DOMAINS?.split(',') || [],
    primaryDomain: process.env.APP_DOMAIN || process.env.REPLIT_DOMAINS?.split(',')[0] || 'localhost:5000'
  },

  line: {
    lineOaId: process.env.LINE_OA_ID || null
  },

  rateLimit: {
    exemptIPs: [
      '127.0.0.1',
      '::1',
      ...(process.env.RATE_LIMIT_EXEMPT_IPS || '').split(',').map(ip => ip.trim()).filter(Boolean)
    ]
  },

  ...constants
};

function getDbHost() {
  return config.database.url?.split('@')[1]?.split('.')[0] || 'unknown';
}

function buildConnectionString() {
  const url = config.database.url;
  if (!url) return null;
  const poolModeParam = `pool_mode=${config.database.poolMode}`;
  return url.includes('?') ? `${url}&${poolModeParam}` : `${url}?${poolModeParam}`;
}

module.exports = {
  config,
  getDbHost,
  buildConnectionString
};

'use strict';

// NOTE: import the module (not the destructured fn) so tests can monkey-patch
// `child_process.spawnSync` without breaking the resolver's reference.
const childProcess = require('child_process');
const path = require('path');
const { Pool } = require('pg');

const HANDSHAKE_TIMEOUT_MS = 5000;

function isLoopbackHost(host) {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  if (/^127\./.test(h)) return true;
  return false;
}

function isPrivateIPv4(host) {
  if (!host) return false;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateOrLoopback(host) {
  return isLoopbackHost(host) || isPrivateIPv4(host) || isSingleLabelHost(host);
}

function isPgBouncerHost(host) {
  if (!host) return false;
  return /pgbouncer|pooler\./i.test(host);
}

function parseHost(connectionTarget) {
  if (!connectionTarget) return null;
  if (typeof connectionTarget === 'object' && connectionTarget.host) {
    return connectionTarget.host;
  }
  if (typeof connectionTarget !== 'string') return null;
  try {
    const u = new URL(connectionTarget);
    return u.hostname.replace(/^\[|\]$/g, '');
  } catch {
    const at = connectionTarget.split('@');
    const tail = at.length > 1 ? at[1] : at[0];
    return tail.split('/')[0].split(':')[0] || null;
  }
}

function isSingleLabelHost(host) {
  if (!host) return false;
  if (host.includes(':')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return !host.includes('.');
}

function shortHost(host) {
  if (!host) return 'unknown';
  if (isLoopbackHost(host) || isPrivateIPv4(host)) return host;
  return host.split('.')[0];
}

function buildConnectionStringFromUrl(url) {
  if (!url) return null;
  const host = parseHost(url);
  if (isPgBouncerHost(host)) {
    return url.includes('?') ? `${url}&pool_mode=transaction` : `${url}?pool_mode=transaction`;
  }
  return url;
}

function buildSslConfig(host) {
  if (isPrivateOrLoopback(host)) return false;
  const customCA = process.env.DATABASE_CA_CERT;
  return {
    rejectUnauthorized: !!customCA,
    ...(customCA && { ca: customCA }),
  };
}

function getPgEnvVars() {
  const { PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT } = process.env;
  if (!PGHOST || !PGUSER || !PGDATABASE) return null;
  return {
    host: PGHOST,
    user: PGUSER,
    password: PGPASSWORD || '',
    database: PGDATABASE,
    port: PGPORT ? parseInt(PGPORT, 10) : 5432,
  };
}

// Handshake the EXACT runtime config that Pool will use. The candidate must
// already have `connectionString` (with pool_mode appended where applicable)
// OR the discrete pgConfig fields, plus the final `ssl` object. Anything less
// risks a false-positive handshake that then fails at runtime with no fallback.
function tryHandshake(candidate) {
  const script = `
    const { Pool } = require('pg');
    const cfg = JSON.parse(process.env.__CFG);
    cfg.connectionTimeoutMillis = 4500;
    const p = new Pool(cfg);
    p.query('SELECT 1').then(() => { p.end(); process.exit(0); })
      .catch((e) => {
        process.stderr.write(JSON.stringify({ code: e.code || '', message: String(e.message || e) }));
        try { p.end(); } catch (_) {}
        process.exit(2);
      });
  `;
  const result = childProcess.spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, __CFG: JSON.stringify(candidate) },
    timeout: HANDSHAKE_TIMEOUT_MS,
    encoding: 'utf8',
  });
  if (result.status === 0) return { ok: true };
  let parsed = {};
  try { parsed = JSON.parse(result.stderr || '{}'); } catch { parsed = { message: result.stderr || 'unknown' }; }
  if (result.signal === 'SIGTERM' || result.error) {
    return { ok: false, code: 'TIMEOUT', message: result.error?.message || 'handshake timeout' };
  }
  return { ok: false, code: parsed.code || '', message: parsed.message || 'handshake failed' };
}

function resolveDatabase({ skipHandshake = false } = {}) {
  const databaseUrl = process.env.DATABASE_URL;
  const pgVars = getPgEnvVars();
  const attempts = [];

  if (databaseUrl) {
    const host = parseHost(databaseUrl);
    const connectionString = buildConnectionStringFromUrl(databaseUrl);
    const ssl = buildSslConfig(host);
    const result = {
      source: 'DATABASE_URL',
      host,
      shortHost: shortHost(host),
      connectionString,
      ssl,
      attempts,
    };
    if (skipHandshake) return result;
    // Handshake the EXACT runtime candidate (same connectionString, same ssl).
    const handshake = tryHandshake({ connectionString, ssl });
    if (handshake.ok) return result;
    attempts.push({ source: 'DATABASE_URL', host: shortHost(host), code: handshake.code, message: handshake.message });
  }

  if (pgVars) {
    const ssl = buildSslConfig(pgVars.host);
    const result = {
      source: 'PG_VARS',
      host: pgVars.host,
      shortHost: shortHost(pgVars.host),
      pgConfig: pgVars,
      ssl,
      attempts,
    };
    if (skipHandshake) return result;
    // Handshake the EXACT runtime candidate (same pg fields, same ssl).
    const handshake = tryHandshake({ ...pgVars, ssl });
    if (handshake.ok) return result;
    attempts.push({ source: 'PG_VARS', host: shortHost(pgVars.host), code: handshake.code, message: handshake.message });
  }

  const lines = ['❌ No working PostgreSQL source available. Tried:'];
  if (!databaseUrl && !pgVars) {
    lines.push('   • DATABASE_URL: not set');
    lines.push('   • PG* vars: PGHOST/PGUSER/PGDATABASE not set');
  } else {
    if (!databaseUrl) lines.push('   • DATABASE_URL: not set');
    if (!pgVars) lines.push('   • PG* vars: PGHOST/PGUSER/PGDATABASE not set');
    for (const a of attempts) {
      lines.push(`   • ${a.source} (${a.host}): ${a.code || 'ERR'} — ${a.message}`);
    }
  }
  const err = new Error(lines.join('\n'));
  err.attempts = attempts;
  throw err;
}

// Singleton: the kernel calls resolveDatabase() once at boot and caches the
// result here so other modules (config helpers, backup, future workers) can
// see which source actually won — without re-running the handshake or
// reading process.env directly. Stays null until vegapunk.js boots.
let _activeResolution = null;
function getActiveResolution() { return _activeResolution; }
function setActiveResolution(res) { _activeResolution = res; }

// Single authority for building a `pg.Pool` outside the kernel. Worker scripts,
// cron jobs, and one-off migration runners MUST use this instead of
// `new Pool({ connectionString: process.env.DATABASE_URL })` — going through
// the resolver guarantees the same handshake fallback (DATABASE_URL → PG*),
// the same PgBouncer pool_mode logic, and the same SSL config the kernel uses.
//
// If the kernel has already booted, the cached resolution is reused (no second
// handshake). Otherwise we resolve on first call so standalone scripts work.
// `overrides` are shallow-merged last and may set max/min/timeouts/etc.
function createPool(overrides = {}) {
  let res = _activeResolution;
  if (!res) {
    res = resolveDatabase();
    setActiveResolution(res);
  }
  const base = {
    ssl: res.ssl,
    max: 5,
    min: 0,
    connectionTimeoutMillis: 30000,
    idleTimeoutMillis: 30000,
  };
  const cfg = res.source === 'DATABASE_URL'
    ? { ...base, connectionString: res.connectionString, ...overrides }
    : { ...base, ...res.pgConfig, ...overrides };
  return new Pool(cfg);
}

// Kernel-only asynchronous bootstrap: prove the exact runtime pool and retain
// its verified connection instead of probing in a child and reconnecting.
// The synchronous public resolver remains compatible with existing scripts.
async function resolveRuntimePool(overrides = {}) {
  const attempts = [];
  const candidates = [];
  if (process.env.DATABASE_URL) {
    const host = parseHost(process.env.DATABASE_URL);
    candidates.push({ source: 'DATABASE_URL', host, shortHost: shortHost(host),
      connectionString: buildConnectionStringFromUrl(process.env.DATABASE_URL), ssl: buildSslConfig(host), attempts });
  }
  const vars = getPgEnvVars();
  if (vars) candidates.push({ source: 'PG_VARS', host: vars.host, shortHost: shortHost(vars.host),
    pgConfig: vars, ssl: buildSslConfig(vars.host), attempts });
  for (const resolution of candidates) {
    const pool = new Pool({ ...overrides, ssl: resolution.ssl,
      ...(resolution.connectionString ? { connectionString: resolution.connectionString } : resolution.pgConfig),
      connectionTimeoutMillis: Math.min(overrides.connectionTimeoutMillis || 4500, 4500) });
    let client;
    const started = Date.now();
    try {
      client = await pool.connect();
      const remaining = 4500 - (Date.now() - started);
      if (remaining <= 0) throw Object.assign(new Error('Database handshake timed out.'), { code: 'TIMEOUT' });
      await client.query({ text: 'SELECT 1', query_timeout: remaining });
      client.release();
      setActiveResolution(resolution);
      return { pool, resolution };
    } catch (error) {
      client?.release(true);
      await pool.end();
      attempts.push({ source: resolution.source, host: resolution.shortHost, code: error.code || 'ERR' });
    }
  }
  throw Object.assign(new Error(candidates.length
    ? `No working PostgreSQL source available (${attempts.map(a => `${a.source}: ${a.code}`).join('; ')}).`
    : 'No working PostgreSQL source available. Set DATABASE_URL or PGHOST/PGUSER/PGDATABASE.'), { attempts });
}

module.exports = {
  resolveDatabase,
  createPool,
  resolveRuntimePool,
  getActiveResolution,
  setActiveResolution,
  parseHost,
  shortHost,
  isLoopbackHost,
  isPrivateIPv4,
  isPrivateOrLoopback,
  isSingleLabelHost,
  isPgBouncerHost,
  buildConnectionStringFromUrl,
  buildSslConfig,
  getPgEnvVars,
};

'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash, createHmac, randomUUID } = require('node:crypto');
const { CAPACITY } = require('../config/constants');
const context = new AsyncLocalStorage();
const POLICY = {
    text: { poolPerHour: CAPACITY.TEXT_REQUESTS_PER_HOUR, costMultiplier: 1 },
    vision: { poolPerHour: CAPACITY.VISION_REQUESTS_PER_HOUR, costMultiplier: 3 },
    brave: { poolPerHour: CAPACITY.BRAVE_REQUESTS_PER_HOUR, costMultiplier: 1 }
};
let pool;
let installed = false;
function problem(message, status = 429) {
    return Object.assign(new Error(message), { status, code: 'AI_CAPACITY', retryAfter: 60 });
}
function configuration() {
    // Non-secret operator policy. No model is enabled implicitly.
    const fs = require('node:fs');
    const path = require('node:path').join(__dirname, '../config/ai-budget.json');
    // Only trusted server callers can create a context policy. HTTP middleware
    // never copies request bodies/headers into this field.
    const override = context.getStore()?.policy;
    if (!override && !fs.existsSync(path)) return {};
    const parsed = override || JSON.parse(fs.readFileSync(path, 'utf8'));
    for (const cap of [parsed.global, parsed.tenant, parsed.principal, ...Object.values(parsed.providers || {})]) {
        for (const name of ['tokens', 'usd']) {
            if (cap?.[name] != null && !(typeof cap[name] === 'number' && Number.isFinite(cap[name]) && cap[name] > 0))
                throw problem('Shared AI budget policy has an invalid ceiling.', 503);
        }
    }
    for (const value of Object.values(parsed.models || {})) {
        for (const name of ['inputUsdPerMillion', 'outputUsdPerMillion', 'imageTokens']) {
            if (value[name] != null && !(typeof value[name] === 'number' && Number.isFinite(value[name]) && value[name] >= 0))
                throw problem('Shared AI budget policy has an invalid model estimate.', 503);
        }
    }
    for (const value of Object.values(parsed.services || {})) {
        if (value.usdPerCall != null && !(typeof value.usdPerCall === 'number' &&
            Number.isFinite(value.usdPerCall) && value.usdPerCall >= 0))
            throw problem('Shared AI budget policy has an invalid service price.', 503);
    }
    for (const name of ['maxConcurrency', 'maxAuditConcurrency']) {
        if (parsed[name] != null && !(Number.isInteger(parsed[name]) && parsed[name] > 0 && parsed[name] <= 16))
            throw problem('Shared AI budget policy has an invalid concurrency limit.', 503);
    }
    return parsed;
}
const hash = s => createHash('sha256').update(String(s)).digest('hex');
function identity() {
    const req = context.getStore()?.req;
    const tenant = req?.tenantContext?.tenantSchema || req?.tenantSchema || 'public';
    const user = req?.userId || req?.tenantContext?.userId || req?.session?.userId;
    // API keys are looked up by the server, never inferred from Origin/Host.
    let anonymous;
    if (req && !user && !req.aiApplication) {
        if (!process.env.SESSION_SECRET) throw problem('Anonymous AI identity is unavailable.', 503);
        anonymous = createHmac('sha256', process.env.SESSION_SECRET).update(String(req.ip)).digest('hex');
    }
    const principal = user ? `user:${tenant}:${user}` : req?.aiApplication
        ? `application:${req.aiApplication}` : req ? `anonymous:${anonymous}` : 'system';
    return { principal, tenant, ctx: context.getStore() };
}
function middleware(req, res, next) {
    context.run({ req, id: randomUUID(), admitted: false, calls: 0, tokens: 0, outputs: 0 }, next);
}
function withContext(value, fn) { return context.run(value, fn); }
async function transaction(fn) {
    if (!pool) throw problem('Shared AI capacity is unavailable. Please try later.', 503);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '3s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        // One short admission transaction, no network/model work inside the lock.
        await client.query('SELECT pg_advisory_xact_lock(708282)');
        const value = await fn(client);
        await client.query('COMMIT');
        return value;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.code === 'AI_CAPACITY') throw err;
        throw problem('Shared AI capacity could not be checked. Please try later.', 503);
    } finally { client.release(); }
}
async function state(client, key, initial) {
    const result = await client.query('SELECT state FROM core.ai_capacity WHERE key=$1', [key]);
    return result.rows[0]?.state || initial;
}
async function save(client, key, value) {
    await client.query(`INSERT INTO core.ai_capacity(key,state) VALUES($1,$2)
        ON CONFLICT(key) DO UPDATE SET state=EXCLUDED.state,updated_at=NOW()`, [key, value]);
}
function consumeBucket(bucket, rate, capacity, cost, now) {
    const available = Math.min(capacity, (bucket?.tokens ?? capacity) +
        Math.max(0, now - (bucket?.at ?? now)) * rate / 3600000);
    if (available < cost) throw problem('Shared AI capacity is resting. Try again shortly.');
    return { tokens: available - cost, at: now };
}
async function admission(service = 'text') {
    const { principal, ctx } = identity();
    if (ctx?.admitted) return;
    let denialReason = 'Too many rapid requests. Please pause before retrying.';
    await transaction(async client => {
        const now = Date.now();
        const key = `actor:${hash(principal)}`;
        const actor = await state(client, key, {});
        if (actor.blockedUntil > now) throw problem('AI cooldown is active. Please try later.');
        const active = await client.query(`SELECT COUNT(*)::int AS n FROM core.ai_capacity
            WHERE key LIKE 'actor:%' AND updated_at > NOW() - INTERVAL '180 minutes'`);
        const count = Math.max(1, active.rows[0].n + (actor.at ? 0 : 1));
        const policy = POLICY[service] || POLICY.text;
        const share = Math.max(policy.poolPerHour / count, count <= 10 ? policy.poolPerHour * 0.1 : 0,
            2 * policy.costMultiplier);
        const req = ctx?.req;
        const prompt = req?.body?.query || req?.body?.message;
        if (prompt) {
            const fingerprint = hash(JSON.stringify([prompt, !!req.body.includeImages, [...(req.body.bookIds || [])].map(String).sort()]));
            actor.prompts = (actor.prompts || (actor.prompt ? [{ hash: actor.prompt, at: actor.promptAt }] : []))
                .filter(item => now - item.at < CAPACITY.DUPLICATE_BLOCK_DURATION_MS);
            if (actor.prompts.some(item => item.hash === fingerprint)) {
                actor.abuse = (actor.abuse || []).filter(t => now - t < CAPACITY.ABUSE_WINDOW_MS);
                actor.abuse.push(now);
                if (actor.abuse.length >= CAPACITY.ABUSE_EVENT_THRESHOLD) actor.blockedUntil = now + CAPACITY.ABUSE_COOLDOWN_MS;
                await save(client, key, actor);
                denialReason = 'This request was recently submitted. Please wait before repeating it.';
                return false;
            }
            actor.prompts.push({ hash: fingerprint, at: now });
            actor.prompts = actor.prompts.slice(-10);
            actor.prompt = fingerprint;
            actor.promptAt = now;
        }
        actor.bursts = (actor.bursts || []).filter(t => now - t < CAPACITY.BURST_WINDOW_MS);
        actor.bursts.push(now);
        if (actor.bursts.length > CAPACITY.BURST_THRESHOLD) {
            actor.abuse = (actor.abuse || []).filter(t => now - t < CAPACITY.ABUSE_FORGIVENESS_HOURS * 3600000);
            actor.abuse.push(now);
            if (actor.abuse.length >= CAPACITY.ABUSE_EVENT_THRESHOLD) actor.blockedUntil = now + CAPACITY.ABUSE_COOLDOWN_MS;
            await save(client, key, actor);
            return false;
        }
        actor.firstSeen = actor.firstSeen || now;
        const reputation = Math.min(1.5, 1 + Math.log10((now - actor.firstSeen) / 86400000 + 1) * 0.3);
        actor[service] = consumeBucket(actor[service], share, share * 2, policy.costMultiplier / reputation, now);
        actor.at = now;
        await save(client, key, actor);
        return true;
    }).then(allowed => { if (!allowed) throw problem(denialReason); });
    if (ctx) ctx.admitted = true;
}
function estimate(body, profile = {}) {
    let input = Buffer.byteLength(JSON.stringify({
        ...(body?.tools ? { tools: body.tools } : {}),
        ...(body?.response_format ? { response_format: body.response_format } : {})
    }), 'utf8') - 2;
    let images = 0;
    for (const msg of body?.messages || []) {
        for (const part of Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }]) {
            if (part.type === 'image_url') images++;
            else input += Buffer.byteLength(String(part.text || ''), 'utf8'); // Conservative text upper bound, not chars/4.
        }
        input += 32;
    }
    if (images && !(profile.imageTokens > 0)) throw problem('This model has no approved image token estimate.', 503);
    input += images * (profile.imageTokens || 0);
    const output = Number(body?.max_completion_tokens || body?.max_tokens || 4096);
    if (!Number.isFinite(output) || output < 0) throw problem('Invalid model output allowance.', 400);
    return { input, output, tokens: input + output, images };
}
async function reserve(body = {}, service = 'text', options = {}) {
    await admission(service);
    const cfg = configuration();
    const profile = cfg.models?.[body.model] || {};
    const amount = options.tokens !== undefined ? { tokens: options.tokens, output: 0 } :
        service === 'brave' ? { tokens: 0, input: 0, output: 0, images: 0 } : estimate(body, profile);
    const { principal, tenant, ctx } = identity();
    if (!options.reserveOnly && ctx?.audit && (ctx.calls >= 3 || ctx.tokens + amount.tokens > 24000 ||
        ctx.outputs + amount.output > 4000 || Date.now() > ctx.deadline))
        throw problem('Audit budget reached. Narrow the date range or select fewer attachments.');
    const servicePrice = cfg.services?.[service]?.usdPerCall;
    const priced = options.cost !== undefined || servicePrice >= 0 ||
        (profile.inputUsdPerMillion >= 0 && profile.outputUsdPerMillion >= 0);
    if (options.cost === undefined && options.funded !== false && (cfg.global?.usd || cfg.tenant?.usd) &&
        !(profile.inputUsdPerMillion >= 0 && profile.outputUsdPerMillion >= 0) && !(servicePrice >= 0))
        throw problem('This provider/model has no approved price in the shared budget policy.', 503);
    const cost = options.cost ?? servicePrice ?? (((amount.input || 0) * (profile.inputUsdPerMillion || 0) +
        amount.output * (profile.outputUsdPerMillion || 0)) / 1e6);
    if (ctx?.requestMaxUsd && (options.reserveOnly ? cost : (ctx.envelopeCost || 0) + cost) > ctx.requestMaxUsd)
        throw problem('The approved spend ceiling for this test has been reached.');
    const parent = !options.reserveOnly ? ctx?.envelope : null;
    const scopes = parent ? [] : ['global', `tenant:${tenant}`, `principal:${hash(principal)}`,
        ...(options.provider ? [`provider:${options.provider}`] : [])];
    const id = randomUUID();
    await transaction(async client => {
        const now = Date.now();
        const policy = POLICY[service] || POLICY.text;
        const key = `pool:${service}`;
        if (!options.reserveOnly) {
            const global = await state(client, key, {});
            await save(client, key, consumeBucket(global, policy.poolPerHour, policy.poolPerHour, policy.costMultiplier, now));
        }
        const active = await client.query(`SELECT COUNT(*)::int AS n FROM core.ai_reservations
            WHERE settled=FALSE AND expires_at>NOW()`);
        if (active.rows[0].n >= (cfg.maxConcurrency || 4)) throw problem('AI capacity is busy. Please try shortly.');
        const day = new Date().toISOString().slice(0, 10);
        for (const scope of scopes) {
            const cap = scope === 'global' ? cfg.global : scope.startsWith('tenant:') ? cfg.tenant :
                scope.startsWith('provider:') ? cfg.providers?.[scope.slice(9)] : cfg.principal;
            const usageKey = `spend:${day}:${scope}`;
            const usage = await state(client, usageKey, { tokens: 0, cost: 0 });
            if ((cap?.tokens && usage.tokens + amount.tokens > cap.tokens) ||
                (cap?.usd && usage.cost + cost > cap.usd)) throw problem('Shared daily AI budget exhausted.');
            await save(client, usageKey, { tokens: usage.tokens + amount.tokens, cost: usage.cost + cost });
        }
        await client.query(`INSERT INTO core.ai_reservations(id,principal,scopes,tokens,cost,expires_at)
            VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '120 seconds')`,
        [id, principal, { keys: scopes.map(s => `spend:${day}:${s}`) }, amount.tokens, cost]);
        if (!options.reserveOnly) {
            const metricKey = `metrics:${day}`;
            const metrics = await state(client, metricKey, {});
            metrics.calls = (metrics.calls || 0) + 1;
            metrics.estimatedTokens = (metrics.estimatedTokens || 0) + amount.tokens;
            metrics.estimatedUsd = (metrics.estimatedUsd || 0) + cost;
            metrics.unpricedCalls = (metrics.unpricedCalls || 0) + (priced ? 0 : 1);
            await save(client, metricKey, metrics);
        }
    });
    if (ctx && !options.reserveOnly) {
        ctx.calls++; ctx.tokens += amount.tokens; ctx.outputs += amount.output;
        if (parent) { ctx.envelopeTokens += amount.tokens; ctx.envelopeCost += cost; }
    }
    return { id, ...amount, cost, profile, parent, priced, funded: options.funded };
}
async function settle(reservation, usage) {
    if (reservation.funded === false) usage = undefined;
    // Ambiguous errors/absent usage retain the whole charge; no automatic refund.
    const reported = Number(usage?.total_tokens);
    const actual = usage && Number.isFinite(reported) && reported >= 0 ? reported : reservation.tokens;
    const actualCost = usage && Number.isFinite(usage.cost) ? usage.cost : usage && reservation.profile?.inputUsdPerMillion >= 0
        ? ((Number(usage.prompt_tokens || 0) * reservation.profile.inputUsdPerMillion +
            Number(usage.completion_tokens || 0) * reservation.profile.outputUsdPerMillion) / 1e6)
        : reservation.cost;
    await transaction(async client => {
        const row = await client.query('SELECT * FROM core.ai_reservations WHERE id=$1 FOR UPDATE', [reservation.id]);
        if (!row.rows[0] || row.rows[0].settled) return;
        const extra = actual - reservation.tokens;
        const extraCost = actualCost - reservation.cost;
        for (const key of row.rows[0].scopes.keys) {
            const value = await state(client, key, { tokens: 0, cost: 0 });
            await save(client, key, { tokens: Math.max(0, value.tokens + extra), cost: Math.max(0, value.cost + extraCost) });
        }
        await client.query('UPDATE core.ai_reservations SET settled=TRUE WHERE id=$1', [reservation.id]);
        if (context.getStore()?.envelope?.id !== reservation.id) {
            const key = `metrics:${new Date().toISOString().slice(0, 10)}`;
            const metrics = await state(client, key, {});
            metrics.chargedTokens = (metrics.chargedTokens || 0) + actual;
            metrics.chargedUsd = (metrics.chargedUsd || 0) + actualCost;
            metrics.reportedUsageCalls = (metrics.reportedUsageCalls || 0) + (usage ? 1 : 0);
            await save(client, key, metrics);
        }
    });
    const ctx = context.getStore();
    if (ctx && usage) {
        if (reservation.parent) {
            ctx.envelopeTokens += actual - reservation.tokens;
            ctx.envelopeCost += actualCost - reservation.cost;
        }
        if (ctx.envelope?.id !== reservation.id) {
            ctx.tokens += actual - reservation.tokens;
            ctx.outputs += Number(usage.completion_tokens ?? reservation.output) - reservation.output;
        }
    }
}
async function reserveAuditEnvelope(profile) {
    const ctx = context.getStore();
    if (!ctx) throw problem('Audit request context is unavailable.', 503);
    ctx.envelope = await reserve({}, 'vision', { tokens: 24000, reserveOnly: true, provider: 'openrouter.ai',
        cost: 24000 * Math.max(profile.inputUsdPerMillion, profile.outputUsdPerMillion) / 1e6 });
    ctx.envelopeTokens = 0;
    ctx.envelopeCost = 0;
}
async function finishAuditEnvelope() {
    const ctx = context.getStore();
    if (ctx?.envelope) await settle(ctx.envelope, { total_tokens: ctx.envelopeTokens, cost: ctx.envelopeCost });
}
async function recordAudit({ inspected = 0, rejected = false }) {
    await transaction(async client => {
        const key = `metrics:${new Date().toISOString().slice(0, 10)}`;
        const metrics = await state(client, key, {});
        metrics.auditRequests = (metrics.auditRequests || 0) + 1;
        metrics.inspectedPages = (metrics.inspectedPages || 0) + inspected;
        metrics.rejectedAudits = (metrics.rejectedAudits || 0) + (rejected ? 1 : 0);
        await save(client, key, metrics);
    });
}
async function status() {
    const cfg = configuration();
    const day = new Date().toISOString().slice(0, 10);
    return transaction(async client => ({
        policy: POLICY, visionEnabled: !!cfg.bookVision?.enabled,
        global: { limit: cfg.global || null, charged: await state(client, `spend:${day}:global`, { tokens: 0, cost: 0 }) },
        metrics: await state(client, `metrics:${day}`, {})
    }));
}
async function auditKey(key, result) {
    return transaction(async client => {
        if (result) {
            await client.query(`UPDATE core.ai_audit_requests SET state='complete',result=$2 WHERE key=$1`, [key, result]);
            return;
        }
        await client.query('DELETE FROM core.ai_audit_requests WHERE expires_at<NOW()');
        const row = await client.query('SELECT state,result FROM core.ai_audit_requests WHERE key=$1', [key]);
        if (row.rows[0]?.result) return row.rows[0].result;
        if (row.rows.length) throw problem('This audit is already processing or recently failed. Please wait.', 409);
        const principal = hash(identity().principal);
        const active = await client.query(`SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER(WHERE principal=$1)::int AS own FROM core.ai_audit_requests
            WHERE state='pending' AND expires_at>NOW()`, [principal]);
        if (active.rows[0].own >= 1 || active.rows[0].n >= (configuration().maxAuditConcurrency || 2))
            throw problem('Another audit is running. Please try shortly.');
        await client.query(`INSERT INTO core.ai_audit_requests(key,principal,state,expires_at)
            VALUES($1,$2,'pending',NOW()+INTERVAL '2 minutes')`, [key, principal]);
        return null;
    });
}
async function auditFailed(key) {
    if (!key) return;
    // Keep short-lived idempotency tombstone without holding a processing slot.
    await transaction(client => client.query("UPDATE core.ai_audit_requests SET state='failed' WHERE key=$1 AND state='pending'", [key]));
}
function classify(raw, method) {
    let url;
    try { url = new URL(raw); } catch { return null; }
    const host = url.hostname;
    const integrationBase = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    if (integrationBase && method !== 'GET' && url.origin === new URL(integrationBase).origin) return 'text';
    if (['api.groq.com', 'openrouter.ai', 'api.deepseek.com', 'api.openai.com'].includes(host) &&
        method !== 'GET') return /audio|image/.test(url.pathname) ? 'vision' : 'text';
    if (['api.search.brave.com', 'api.search.tinyfish.ai', 'api.exa.ai', 'api.firecrawl.dev'].includes(host)) return 'brave';
    return null;
}
function install(app, db) {
    pool = db;
    if (app) app.use(middleware);
    if (installed) return;
    installed = true;
    const axios = require('axios');
    axios.interceptors.request.use(async config => {
        let service = classify(config.url, String(config.method || 'GET').toUpperCase());
        if (service === 'text' && config.data?.messages?.some(m => Array.isArray(m.content) &&
            m.content.some(p => ['image_url', 'input_audio'].includes(p.type)))) service = 'vision';
        if (service) {
            if (config.data?.stream) throw problem('Unbounded AI streaming transport is not supported.', 503);
            const ctx = context.getStore();
            const byok = ctx?.req?.aiByokToken;
            const auth = config.headers?.Authorization || config.headers?.authorization;
            const operatorKeys = ['PLAYGROUND_AI_KEY', 'PLAYGROUND_GROQ_VISION_TOKEN', 'NYANBOOK_AI_KEY',
                'OPENROUTER_API_KEY', 'DEEPSEEK_API', 'AI_INTEGRATIONS_OPENAI_API_KEY'].map(k => process.env[k]).filter(Boolean);
            const ownInference = byok && auth === `Bearer ${byok}` && !operatorKeys.includes(byok);
            config.aiReservation = await reserve(config.data, service, { provider: new URL(config.url).hostname,
                ...(ownInference ? { tokens: 0, cost: 0, funded: false } : {}) });
            if (ctx?.deadline) {
                config.timeout = Math.max(1, Math.min(config.timeout || 30000, ctx.deadline - Date.now()));
                config.signal = ctx.signal;
            }
        }
        return config;
    });
    axios.interceptors.response.use(async response => {
        if (response.config.aiReservation) await settle(response.config.aiReservation, response.data?.usage);
        return response;
    }, async error => {
        // Unknown network outcomes keep both the spend hold and concurrency lease.
        if (error.config?.aiReservation && error.response)
            await settle(error.config.aiReservation).catch(() => {});
        throw error;
    });
    const original = global.fetch;
    global.fetch = async function(input, init) {
        const service = classify(typeof input === 'string' || input instanceof URL ? String(input) : input.url,
            String(init?.method || input?.method || 'GET').toUpperCase());
        if (!service) return original(input, init);
        let body = {};
        if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch {} }
        const reservation = await reserve(body, service, { provider: new URL(String(input?.url || input)).hostname });
        try {
            const response = await original(input, init);
            await settle(reservation);
            return response;
        } catch (err) { await settle(reservation).catch(() => {}); throw err; }
    };
}
module.exports = { POLICY, context, identity, middleware, withContext, admission, reserve, settle, reserveAuditEnvelope, finishAuditEnvelope, recordAudit, status,
    auditKey, auditFailed, install, configuration, estimate, hash, problem, setDbPool: db => { pool = db; } };

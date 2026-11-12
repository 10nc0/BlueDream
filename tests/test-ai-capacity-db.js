'use strict';
// Explicit integration check. Uses only an isolated generated schema and removes it.
// Not in the offline unit command; needs the configured development database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Pool } = require('pg');
const { resolveDatabase } = require('../lib/db-resolver');
const resolved = resolveDatabase({ skipHandshake: true });
const db = new Pool(resolved.source === 'DATABASE_URL'
    ? { connectionString: resolved.connectionString, ssl: resolved.ssl, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 5000 }
    : { ...resolved.pgConfig, ssl: resolved.ssl, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
const schema = `ai_fixture_${process.pid}`;
const replace = sql => sql.replaceAll('core.ai_', `${schema}.ai_`);
const shared = { connect: async () => {
    const client = await db.connect();
    return { query: (sql, params) => {
        if (process.argv.includes('--trace-fixture')) console.log('Fixture SQL:', sql.trim().split('\n')[0].slice(0, 100));
        return client.query(replace(sql), params);
    }, release: destroy => client.release(destroy) };
} };
async function run() {
    console.log('Capacity fixtures: isolated schema', schema);
    await db.query(`CREATE SCHEMA ${schema}`);
    try {
        await db.query(replace(fs.readFileSync('migrations/core/013_ai_capacity.sql', 'utf8')));
        const one = require('../utils/ai-capacity');
        delete require.cache[require.resolve('../utils/ai-capacity')];
        const two = require('../utils/ai-capacity');
        one.setDbPool(shared); two.setDbPool(shared);
        console.log('Capacity fixtures: admission and identity');
        const req = { userId: 'stable-user', tenantSchema: 'tenant_fixture', ip: '192.0.2.1', body: {} };
        const inContext = (service, fn, override = {}) => service.withContext({
            req: { ...req, ...override }, id: 'fixture', calls: 0, tokens: 0, outputs: 0
        }, fn);
        let reservation;
        await inContext(one, async () => {
            await one.admission('text'); await one.admission('vision');
            reservation = await one.reserve({ messages: [{ content: 'hello' }], max_tokens: 10 });
        });
        const actors = await db.query(`SELECT state FROM ${schema}.ai_capacity WHERE key LIKE 'actor:%'`);
        assert.equal(actors.rows.length, 1);
        assert(actors.rows[0].state.text.tokens > 470, 'Nested admission must not charge twice');
        await inContext(two, async () => {
            const next = await two.reserve({ messages: [{ content: 'hello' }], max_tokens: 10 });
            await two.settle(next, { total_tokens: 12, prompt_tokens: 10, completion_tokens: 2 });
        }, { ip: '192.0.2.2' });
        assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${schema}.ai_capacity WHERE key LIKE 'actor:%'`)).rows[0].n, 1,
            'New session/IP/app route must not reset authenticated principal');
        const hold = (await db.query(`SELECT * FROM ${schema}.ai_reservations WHERE id=$1`, [reservation.id])).rows[0];
        assert.equal(hold.settled, false, 'Uncertain request retains its hold/lease');
        await inContext(one, async () => {
            const ctx = one.context.getStore(); Object.assign(ctx, { audit: true, calls: 3, deadline: Date.now() + 60000 });
            await assert.rejects(one.reserve({ messages: [] }), /Audit budget reached/);
        });
        await inContext(one, () => one.auditKey('same-audit'));
        await inContext(two, () => assert.rejects(two.auditKey('same-audit'), /already processing/));
        await inContext(one, () => one.auditKey('same-audit', { success: true }));
        const cached = await inContext(two, () => two.auditKey('same-audit'));
        assert.equal(cached.success, true);
        // The shared global lease cap applies across independently loaded instances.
        const concurrent = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
            inContext(i % 2 ? one : two, () => (i % 2 ? one : two).reserve({ messages: [], max_tokens: 1 }),
                { userId: `other-${i}` })));
        assert(concurrent.filter(r => r.status === 'fulfilled').length <= 3);
        assert(concurrent.some(r => r.status === 'rejected'));
        console.log('Capacity fixtures: concurrency passed; checking envelopes');
        await db.query(`TRUNCATE ${schema}.ai_capacity,${schema}.ai_reservations,${schema}.ai_audit_requests`);
        const originalExists = fs.existsSync, originalRead = fs.readFileSync;
        const policyPath = require('node:path').resolve('config/ai-budget.json');
        const cfg = { global: { tokens: 100000, usd: 1 }, tenant: { tokens: 100000, usd: 1 },
            models: { fixture: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, imageTokens: 2490 } } };
        fs.existsSync = path => String(path) === policyPath || originalExists(path);
        fs.readFileSync = (path, ...args) => String(path) === policyPath ? JSON.stringify(cfg) : originalRead(path, ...args);
        try {
            await one.withContext({
                req: { aiApplication: 'smoke-budget-fixture', body: {} },
                id: 'request-spend-ceiling',
                calls: 0,
                tokens: 0,
                outputs: 0,
                requestMaxUsd: 0.00003
            }, async () => {
                await one.reserve({ model: 'fixture', messages: [], max_tokens: 10 });
                await assert.rejects(
                    one.reserve({ model: 'fixture', messages: [], max_tokens: 10 }),
                    /approved spend ceiling/
                );
            });
            await one.withContext({
                req: { aiApplication: 'smoke-call-limit-fixture', body: {} },
                id: 'request-call-ceiling',
                calls: 0,
                tokens: 0,
                outputs: 0,
                requestMaxCalls: 1
            }, async () => {
                await one.reserve({ model: 'fixture', messages: [], max_tokens: 10 });
                await assert.rejects(
                    one.reserve({ model: 'fixture', messages: [], max_tokens: 10 }),
                    /approved call limit/
                );
            });
            await db.query(`TRUNCATE ${schema}.ai_capacity,${schema}.ai_reservations,${schema}.ai_audit_requests`);
            await inContext(one, async () => {
                Object.assign(one.context.getStore(), { audit: true, deadline: Date.now() + 60000 });
                await one.reserveAuditEnvelope(cfg.models.fixture);
                console.log('Capacity fixtures: envelope reserved');
                const call = await one.reserve({ model: 'fixture', messages: [{ content: 'abc' }], max_tokens: 20 }, 'vision');
                await one.settle(call, { total_tokens: 21, prompt_tokens: 11, completion_tokens: 10 });
                await one.finishAuditEnvelope();
                console.log('Capacity fixtures: envelope settled');
            });
            let charged = await db.query(`SELECT state FROM ${schema}.ai_capacity WHERE key LIKE 'spend:%:global'`);
            assert.equal(charged.rows[0].state.tokens, 21, 'Envelope and nested calls must not double charge');
            assert(Math.abs(charged.rows[0].state.cost - 0.000031) < 0.00000001);
            cfg.global.usd = 0.000001;
            await inContext(two, () => assert.rejects(two.reserve({ model: 'fixture', messages: [], max_tokens: 10 }), /daily AI budget/),
                { userId: 'new-key-same-global' });
            // Hard ceilings cannot be bypassed by reputation/dev/application identity.
            await inContext(one, () => assert.rejects(one.reserveAuditEnvelope(cfg.models.fixture), /daily AI budget/),
                { userId: 'dev', userRole: 'dev', aiReputationMultiplier: 100 });
            charged = await db.query(`SELECT count(*)::int AS n FROM ${schema}.ai_reservations`);
            assert.equal(charged.rows[0].n, 2, 'Rejected work cannot reserve or start a paid call');
            cfg.global.usd = 1;
            const duplicate = { userId: 'duplicate', body: { query: 'same harmless fixture' } };
            await inContext(one, () => one.admission(), duplicate);
            await inContext(two, () => assert.rejects(two.admission(), /recently submitted/), duplicate);
        } finally { fs.existsSync = originalExists; fs.readFileSync = originalRead; }
        two.setDbPool(null);
        await inContext(two, () => assert.rejects(two.reserve({}), /unavailable/));
        console.log('Shared capacity DB: atomic cross-instance leases, stable identity, nested admission, token/call caps, idempotency and fail-closed checks passed.');
    } finally {
        await db.query(`DROP SCHEMA ${schema} CASCADE`);
        await db.end();
    }
}
run().then(() => process.exit(0)).catch(err => { console.error({ message: err.message, code: err.code }); process.exit(1); });

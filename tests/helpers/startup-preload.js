'use strict';
// Non-production fresh-process benchmark (NOT a cold-container benchmark): real imports and read-only schema
// metadata, simulated existing-table DDL/repair RTT, no Discord login or writes.
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const fs = require('node:fs');
const pg = require('pg');
const RealPool = pg.Pool;
const originalLoad = Module._load;
let heartbeatSource;
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
const start = performance.timeOrigin;
const elapsed = () => Math.round(Date.now() - start);
const phases = {};
const startupPhasesMs = {};
const imports = [];
let observedFirstBreath = false;
let queries = 0, reads = 0, rtt = 150;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class ReadOnlyPool extends RealPool {
    connect(callback) {
        const guard = client => {
            if (client._benchmarkGuard) return client;
            client._benchmarkGuard = true;
            const query = client.query.bind(client);
            client.query = (sql, ...args) => {
                const text = typeof sql === 'string' ? sql : sql.text;
                if (!/^\s*SELECT\b/i.test(text) || /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i.test(text))
                    throw new Error('Benchmark blocked a transaction-client write.');
                return query(sql, ...args);
            };
            return client;
        };
        if (callback) return super.connect((error, client, release) => callback(error, client ? guard(client) : client, release));
        return super.connect().then(guard);
    }
    async query(sql, params) {
        const text = typeof sql === 'string' ? sql : sql.text;
        if (process.env.STARTUP_BENCH_SCHEMA_FAILURE && /to_regclass|CREATE SCHEMA/i.test(text))
            throw Object.assign(new Error('Synthetic schema unavailable.'), { code: 'TEST_DB_FAILURE' });
        queries++;
        if (/^\s*SELECT/i.test(text)) {
            // Heal recovery metadata is deliberately synthetic.
            if (/FROM core\.book_registry/.test(text)) {
                await sleep(Number(process.env.STARTUP_BENCH_HEAL_DELAY || rtt));
                return { rows: /COUNT/.test(text) ? [{ count: '0' }] : [], rowCount: 0 };
            }
            const before = Date.now();
            const result = await super.query(sql, params);
            // Model the newly introduced migration as already applied for the
            // steady-state comparison, without modifying live schema/tracking.
            if (Array.isArray(result.rows[0]?.applied) && !result.rows[0].applied.includes('014_heartbeat_lease.sql'))
                result.rows[0].applied.push('014_heartbeat_lease.sql');
            reads++;
            rtt = Math.max(10, Date.now() - before);
            return result;
        }
        if (/^\s*(CREATE (SCHEMA|TABLE)|UPDATE core\.book_registry)/i.test(text)) {
            await sleep(rtt);
            return { rows: [], rowCount: 0 };
        }
        throw new Error('Benchmark blocked non-read-only database operation.');
    }
}
class FakeBot {
    constructor() { this.client = new EventEmitter(); this.client.isReady = () => this.ready; }
    async initialize() { await sleep(Number(process.env.STARTUP_BENCH_BOT_DELAY || 1200)); this.ready = true; this.client.emit('ready'); }
    isReady() { return !!this.ready; }
}
Module._load = function(request, parent, isMain) {
    if (/bots\/(?:hermes|thoth|idris|horus)-bot$/.test(request) && !process.env.STARTUP_BENCH_REAL_BOT_IMPORTS) return FakeBot;
    if (request === 'pg') return { ...pg, Pool: ReadOnlyPool };
    if (process.env.STARTUP_BENCH_ASSERT_DEFERRED && !observedFirstBreath &&
        (/^\.\/routes\/(?:books|pipe|nyan-ai|account)$/.test(request) || ['discord.js', 'twilio', 'exa-js'].includes(request)))
        throw new Error(`Optional import before first breath: ${request}`);
    const importStart = elapsed();
    const nestedStart = imports.length;
    const beforeLoad = performance.now();
    const loaded = originalLoad.call(this, request, parent, isMain);
    const duration = Math.round(performance.now() - beforeLoad);
    if (duration > 40 || /routes\/|bots\/|discord\.js|twilio|exa-js/.test(request)) imports.push({ request, parent: parent?.filename?.replace(process.cwd() + '/', ''),
        ms: duration, startedAtMs: importStart,
        // Inclusive timings overlap: never sum a parent's time with its children.
        nestedSlowImports: imports.length - nestedStart });
    if (/bots\/(?:hermes|thoth|idris|horus)-bot$/.test(request)) {
        loaded.prototype.initialize = async function() {
            // Profile the actual SDK cost at connection time, but never log in.
            require('discord.js');
            this.client = new EventEmitter();
            this.client.isReady = () => !!this.ready;
            return FakeBot.prototype.initialize.call(this);
        };
    }
    if (/\/playground-capacity$/.test(request)) {
        const initialize = loaded.initReputationTable;
        loaded.initReputationTable = async () => {
            if (process.env.STARTUP_BENCH_BUDGET_FAILURE) throw new Error('Synthetic budget unavailable.');
            return initialize();
        };
    }
    if (/\/phi-breathe$/.test(request)) {
        heartbeatSource = loaded;
        for (const name of ['_purgeOldMedia', '_revokeDormantContributors', '_expireStaleShareInvites',
            '_expirePendingBooks', '_expireUnactivatedBooks']) loaded[name] = async () => {};
    }
    if (/\/heal-queue$/.test(request)) loaded.healQueue.start = () => {};
    if (/\/outpipes\/worker$/.test(request)) loaded.worker.start = () => {};
    if (/\/genesis-counter$/.test(request)) loaded.start = () => {};
    if (/\/backfill-agent-tokens$/.test(request)) loaded.backfillAgentTokens = async () => {};
    if (/\/normalize-output-credentials$/.test(request)) loaded.normalizeOutputCredentials = async () => {};
    return loaded;
};
const write = process.stdout.write.bind(process.stdout);
let finished = false;
let firstBreathProcessMs;
let importsAtFirstBreath;
process.stdout.write = function(chunk, ...rest) {
    const text = String(chunk);
    for (const mark of text.matchAll(/Startup \+(\d+)ms: ([\w-]+)/g))
        startupPhasesMs[mark[2]] = Number(mark[1]);
    const firstMark = /Startup \+(\d+)ms: first-breath/.exec(text);
    if (firstMark) {
        observedFirstBreath = true;
        firstBreathProcessMs = Number(firstMark[1]);
        importsAtFirstBreath = imports.length;
    }
    if (/Database: using/.test(text)) phases.resolver = elapsed();
    if (/Dashboard listening/.test(text)) phases.listener = elapsed();
    if (/Database initialized via/.test(text)) phases.schema = elapsed();
    if (/Server ready — accepting/.test(text)) phases.api = elapsed();
    if (/phi breathe #1 inhale/.test(text)) {
        phases.firstBreath = elapsed();
        const blockMs = Number(process.env.STARTUP_BENCH_BLOCK_AFTER_FIRST_MS || 0);
        if (blockMs > 0) setImmediate(() => {
            const until = Date.now() + blockMs;
            while (Date.now() < until) {}
        });
    }
    if (/phi breathe #2 exhale/.test(text) && !finished) {
        finished = true;
        phases.secondBreath = elapsed();
        const result = { ...phases, startupPhasesMs, firstBreathProcessMs,
            firstBreathDeliveryMs: phases.firstBreath - firstBreathProcessMs,
            measurement: 'fresh Node process; shared host filesystem cache uncontrolled; not a cold container',
            realBotImports: !!process.env.STARTUP_BENCH_REAL_BOT_IMPORTS,
            logicalDbQueries: queries, realReadOnlyQueries: reads,
            eventLoopMaxMs: Math.round(histogram.max / 1e6),
            heartbeatSpacingMs: Math.round(heartbeatSource.heartbeatTiming.spacingMs),
            heartbeatLatenessMs: Math.round(heartbeatSource.heartbeatTiming.latenessMs),
            heartbeatDeliveryMs: Math.round(heartbeatSource.heartbeatTiming.deliveryMs),
            mainThreadBlockMs: Number(process.env.STARTUP_BENCH_BLOCK_AFTER_FIRST_MS || 0),
            network: 'real schema reads; repair/DDL RTT and Discord latency simulated' };
        if (process.env.STARTUP_BENCH_PROFILE) {
            result.importsBeforeFirstBreath = imports.slice(0, importsAtFirstBreath);
            result.slowestImports = [...imports].sort((a,b) => b.ms-a.ms).slice(0,30);
        }
        fs.writeFileSync(process.env.STARTUP_BENCH_OUTPUT, JSON.stringify(result));
        setTimeout(() => process.exit(0), Number(process.env.STARTUP_BENCH_EXIT_DELAY_MS || 10));
    }
    return write(chunk, ...rest);
};
setTimeout(() => { console.error('Startup benchmark timed out.'); process.exit(1); }, 45000).unref();

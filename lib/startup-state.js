'use strict';
const { monitorEventLoopDelay } = require('node:perf_hooks');

class StartupState {
    constructor(log = console.log) {
        this.log = log;
        this.phases = {};
        this.services = {};
        this.stopping = false;
        this.queries = 0;
        this.breaths = 0;
        this.delay = monitorEventLoopDelay({ resolution: 20 });
        this.delay.enable();
        this.summaryTimer = setTimeout(() => this.summary(true), 30000);
        this.summaryTimer.unref?.();
    }
    mark(name, atMs = Math.round(process.uptime() * 1000)) {
        if (this.phases[name] !== undefined) return;
        this.phases[name] = atMs;
        this.log(`Startup +${this.phases[name]}ms: ${name}`);
        this.summary();
    }
    observeBreath(timing) {
        if (this.stopping) return;
        this.heartbeatTiming = timing;
        const sourceAt = timing?.emittedAt
            ? Math.round(process.uptime() * 1000 - (Date.now() - timing.emittedAt)) : undefined;
        this.mark('counter-ready');
        this.mark(++this.breaths === 1 ? 'first-breath' : this.breaths === 2 ? 'second-breath' : 'counter-ready', sourceAt);
    }
    processTiming() {
        const duration = (start, end) => this.phases[end] === undefined || this.phases[start] === undefined
            ? undefined : this.phases[end] - this.phases[start];
        return {
            basis: 'Node process uptime; container provisioning and filesystem cache state not measured',
            coreImportMs: duration('imports-start', 'imports-ready'),
            optionalImportMs: duration('optional-work-start', 'route-imports-ready'),
            processToFirstBreathMs: this.phases['first-breath'],
            // Worker publication timestamps, not the spacing between delivered logs.
            firstToSecondBreathMs: duration('first-breath', 'second-breath')
        };
    }
    instrumentPool(pool) {
        pool.on('acquire', client => {
            if (client._startupCounted) return;
            client._startupCounted = true;
            const query = client.query.bind(client);
            client.query = (...args) => { this.queries++; return query(...args); };
        });
    }
    summary(force = false) {
        if (this.reported || (!force && (this.phases['api-ready'] === undefined || this.phases['second-breath'] === undefined ||
            this.phases['maintenance-ready'] === undefined))) return;
        this.reported = true;
        clearTimeout(this.summaryTimer);
        const result = { phasesMs: this.phases, breathsEmitted: this.breaths, dbRoundtrips: this.queries,
            eventLoopMaxMs: Math.round(this.delay.max / 1e6), services: this.services,
            heartbeatTiming: this.heartbeatTiming, processTiming: this.processTiming() };
        this.log(`Startup summary: ${JSON.stringify(result)}`);
        this.delay.disable();
    }
    close() { this.stopping = true; clearTimeout(this.summaryTimer); this.delay.disable(); }
}

function dependencyFor(req) {
    const path = req.path;
    if (req.method === 'POST' && /^\/books\/[^/]+\/(?:activate|create-thread|relink)\/?$/.test(path)) return 'hermes';
    if (req.method === 'GET' && /^\/books\/[^/]+\/messages\/?$/.test(path)) return 'thoth';
    if (['GET', 'POST'].includes(req.method) && /^\/books\/[^/]+\/export(?:\/csv)?\/?$/.test(path)) return 'thoth';
    if (req.method === 'GET' && /^\/books\/[^/]+\/closings\/?$/.test(path)) return 'horus';
    if (path === '/nyan-ai/discord-history') return 'horus';
    if (req.method === 'POST' && path === '/nyan-ai/audit' && req.body?.bookIds?.length) return 'thoth';
    return null;
}
function featureGate(bots) {
    return (req, res, next) => {
        const name = dependencyFor(req);
        const bot = name && bots[name];
        const ready = bot?.client?.isReady ? bot.client.isReady() : bot?.isReady?.();
        if (name && !ready) return res.set('Retry-After', '5').status(503).json({
            code: 'warming_up', service: name, message: 'This feature is waiting for its source service. Please retry shortly.', retryAfter: 5
        });
        next();
    };
}
module.exports = { StartupState, featureGate, dependencyFor };

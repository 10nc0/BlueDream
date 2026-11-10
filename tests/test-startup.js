'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { MaintenanceQueue } = require('../lib/maintenance-queue');
const { featureGate, dependencyFor, StartupState } = require('../lib/startup-state');
const { MigrationRunner } = require('../lib/migration-runner');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function phiFixture(production = true, options = {}) {
    const timeouts = new Map(), intervals = new Map();
    const workers = [];
    let id = 0;
    class FakeWorker extends EventEmitter {
        constructor() {
            super();
            workers.push(this);
            if (!options.pending) queueMicrotask(() => this.emit('message', {
                kind: 'observation', count: production ? 17 : 1,
                owned: !options.follower, fresh: true,
                observedAt: (options.Date || Date).now(), emittedAt: (options.Date || Date).now(),
                durationMs: 6472, dbMs: 0, latenessMs: 0, spacingMs: null
            }));
        }
        postMessage(message) { if (message.kind === 'stop') queueMicrotask(() => this.emit('exit', 0)); }
        terminate() { this.emit('exit', 1); return Promise.resolve(); }
    }
    const box = {
        module: { exports: {} }, process: { env: { NODE_ENV: production ? 'production' : 'development' } },
        Date: options.Date || Date, Map, Set, Promise, console,
        setTimeout: (fn, ms) => { timeouts.set(++id, { fn, ms }); return id; },
        clearTimeout: key => timeouts.delete(key),
        setInterval: (fn, ms) => { intervals.set(++id, { fn, ms }); return id; },
        clearInterval: key => intervals.delete(key),
        require: name => {
            if (name === 'node:worker_threads') return { Worker: FakeWorker };
            if (name === './db-resolver') return { getActiveResolution: () => ({ source: 'fixture' }) };
            if (name === './logger') return new Proxy({}, { get: () => () => {} });
            if (name === './nyan-bus') return new EventEmitter();
            if (name === './heartbeat-lease') return { HeartbeatLease: class {} };
            if (name === './monthly-closing') return { runMonthlyClosing: async (_pool, _bots, config) => {
                options.monthlyCalls?.push({ kind: 'closing', month: config.overrideMonth }); return { success: true };
            } };
            if (name === './monthly-email') return { runMonthlyEmail: async (_pool, config) => {
                options.monthlyCalls?.push({ kind: 'email', month: config.overrideMonth }); return { success: true };
            } };
            return require(name.startsWith('../') ? name : '../lib/' + name.slice(2));
        }
    };
    box.require.resolve = name => name;
    vm.runInNewContext(fs.readFileSync(require.resolve('../lib/phi-breathe'), 'utf8'), box);
    return { phi: box.module.exports, timeouts, intervals, workers };
}
async function main() {
    const keepAlive = setInterval(() => {}, 100);
    try {
        const timeline = new StartupState(() => {});
        timeline.mark('schema-ready');
        assert(timeline.phases['schema-ready'] >= 0);
        timeline.mark('imports-start', 100);
        timeline.mark('imports-ready', 350);
        timeline.mark('first-breath', 600);
        timeline.mark('second-breath', 7072);
        assert.equal(timeline.processTiming().coreImportMs, 250);
        assert.equal(timeline.processTiming().processToFirstBreathMs, 600);
        assert.equal(timeline.processTiming().firstToSecondBreathMs, 6472);
        assert.equal(timeline.processTiming().optionalImportMs, undefined);
        timeline.close();
        assert.equal(dependencyFor({ method: 'POST', path: '/auth/login' }), null);
        assert.equal(dependencyFor({ method: 'POST', path: '/books' }), null);
        assert.equal(dependencyFor({ method: 'GET', path: '/books/abc/export/csv' }), 'thoth');
        assert.equal(dependencyFor({ method: 'GET', path: '/books/abc/closings' }), 'horus');
        const response = { set() { return this; }, status(code) { this.code=code; return this; },
            json(body) { this.body=body; return this; } };
        let continued = false;
        featureGate({ thoth: { client: { isReady: () => false } } })(
            { method: 'GET', path: '/books/abc/messages' }, response, () => { continued=true; });
        assert.equal(response.code, 503);
        assert.equal(response.body.code, 'warming_up');
        assert(!continued);
        featureGate({})({ method: 'POST', path: '/auth/login' }, response, () => { continued=true; });
        assert(continued);

        const queue = new MaintenanceQueue({ concurrency: 2 });
        let active=0, peak=0, ran=0;
        const jobs = Array.from({ length: 8 }, (_, i) => queue.enqueue(`job-${i}`, async () => {
            peak=Math.max(peak, ++active); await sleep(15); active--; ran++;
        }));
        assert.equal(queue.enqueue('job-0', () => { throw new Error('duplicate'); }), jobs[0]);
        await Promise.all(jobs);
        assert.equal(ran, 8); assert(peak <= 2);
        const pool = { options: { max: 20 }, waitingCount: 1 };
        const deferred = new MaintenanceQueue({ pool });
        let didRun=false;
        const work=deferred.enqueue('reserved', () => { didRun=true; });
        await sleep(50); assert(!didRun);
        pool.waitingCount=0; await work; assert(didRun);
        const pending=queue.enqueue('never', () => { throw new Error('closed queue ran work'); }, { delayMs: 10000 });
        await queue.stop(); assert.equal((await pending).skipped, 'shutdown');
        await deferred.stop();

        const dev = phiFixture(false);
        let observed=0;
        dev.phi.setStartupObserver(() => observed++);
        await dev.phi.startPhiBreathe();
        assert.equal(observed, 1); assert(dev.phi.isCounterReady());
        assert.equal(dev.phi.heartbeatTiming.durationMs, 6472);
        await dev.phi.startPhiBreathe(); assert.equal(observed, 1);
        await dev.phi.shutdown(); assert.equal(dev.timeouts.size, 0);
        assert(!dev.phi.isCounterReady());

        const prod = phiFixture();
        prod.phi.setPool({});
        let ticks=0;
        prod.phi.setStartupObserver(() => ticks++);
        await prod.phi.startPhiBreathe();
        assert.equal(ticks, 1); assert(prod.phi.isLeader()); assert.equal(prod.phi.phiBreatheCount, 17);
        prod.workers[0].emit('message', { kind: 'observation', owned: false, fresh: false, code: 'DB_UNAVAILABLE' });
        assert.equal(ticks, 1); assert(!prod.phi.isCounterReady());
        await prod.phi.shutdown();

        const follower = phiFixture(true, { follower: true });
        follower.phi.setPool({});
        follower.phi.setStartupObserver(() => { throw new Error('follower fabricated breath'); });
        await follower.phi.startPhiBreathe();
        assert(follower.phi.isCounterReady()); assert(!follower.phi.isLeader());
        assert.equal(follower.workers.length, 1);
        await follower.phi.shutdown(); assert.equal(follower.timeouts.size, 0);

        const closing = phiFixture(true, { pending: true });
        closing.phi.setPool({});
        const starting = closing.phi.startPhiBreathe();
        await closing.phi.shutdown();
        await starting;
        assert.equal(closing.timeouts.size, 0);
        assert(!closing.phi.isCounterReady());

        const recovery = phiFixture();
        await recovery.phi.startPhiBreathe();
        const originalWorker = recovery.workers[0];
        originalWorker.emit('exit', 1);
        assert(!recovery.phi.isCounterReady());
        assert.equal(recovery.timeouts.size, 1);
        const recoveryTimer = [...recovery.timeouts.entries()][0];
        recovery.timeouts.delete(recoveryTimer[0]);
        recoveryTimer[1].fn();
        await Promise.resolve();
        assert.equal(recovery.workers.length, 2);
        assert(recovery.phi.isCounterReady());
        const stale = { kind: 'observation', count: 20, owned: true, fresh: true,
            observedAt: Date.now() - 25000, emittedAt: Date.now() - 25000, durationMs: 4000 };
        originalWorker.emit('message', stale); // obsolete worker cannot mutate state
        assert.equal(recovery.phi.phiBreatheCount, 17);
        recovery.workers[1].emit('message', stale);
        assert(!recovery.phi.isCounterReady()); assert(!recovery.phi.isLeader());
        recovery.phi.setStartupObserver(() => { throw new Error('observer'); });
        recovery.workers[1].emit('message', { ...stale, observedAt: Date.now(), emittedAt: Date.now() });
        assert(recovery.phi.isCounterReady()); // callback failures do not invalidate the publisher
        recovery.phi.setStartupObserver(async () => { throw new Error('async observer'); });
        recovery.workers[1].emit('message', { ...stale, observedAt: Date.now(), emittedAt: Date.now() });
        await Promise.resolve();
        assert(recovery.phi.isCounterReady());
        await recovery.phi.shutdown();
        assert.equal(recovery.timeouts.size, 0);

        class DayOne extends Date {
            constructor(...args) { super(...(args.length ? args : ['2026-11-01T12:00:00Z'])); }
            static now() { return Date.parse('2026-11-01T12:00:00Z'); }
        }
        const monthlyCalls=[];
        const monthly=phiFixture(true,{Date:DayOne,monthlyCalls});
        const monthlyQueue=new MaintenanceQueue({concurrency:1});
        monthly.phi.setMaintenanceQueue(monthlyQueue);
        monthly.phi.setPool({});
        monthly.phi.setBots({idris:{client:{isReady:()=>true}}});
        monthly.phi.isProduction=true;
        monthly.phi._owned=true;
        monthly.phi._observedAt=DayOne.now();
        assert(monthly.phi.isLeader());
        await monthly.phi.orchestrateStartup();
        let deadline;
        try {
            const completed=monthlyQueue.enqueue('monthly-trigger',monthly.phi.subscribers.get('monthly-trigger').callback)
                .then(()=>monthlyQueue.enqueue('following-maintenance',()=>monthlyCalls.push({kind:'following'})));
            await Promise.race([completed,new Promise((_,reject)=>{
                deadline=setTimeout(()=>reject(new Error('Day-one monthly maintenance deadlocked its single worker.')),2000);
            })]);
            assert.deepEqual(monthlyCalls,[
                {kind:'closing',month:'2026-10'},{kind:'email',month:'2026-10'},{kind:'following'}
            ]);
        } finally {
            clearTimeout(deadline);
            await monthlyQueue.stop();
            await monthly.phi.shutdown();
        }

        let roundtrips=0;
        const warm = new MigrationRunner({ query: async () => ++roundtrips === 1
            ? { rows: [{ core: 'core.migrations', tenant:'core.tenant_migrations', catalog:'core.tenant_catalog' }] }
            : { rows: [{ applied:['001_baseline.sql','002.sql'], tenants_current:true }] } });
        warm._readSqlFiles = () => [{name:'001_baseline.sql'},{name:'002.sql'}];
        await warm.run(); assert.equal(roundtrips, 2);
        roundtrips=0;
        warm.pool.query = async () => ++roundtrips === 1
            ? { rows: [{ core:'x',tenant:'y',catalog:'z' }] } : { rows:[{applied:['002.sql'],tenants_current:true}] };
        assert.equal(await warm._isCurrent(), false); // latest exists; earlier missing
        roundtrips=0;
        warm.pool.query = async () => ++roundtrips === 1
            ? { rows: [{ core:'x',tenant:'y',catalog:'z' }] }
            : { rows:[{applied:['001_baseline.sql','002.sql'],tenants_current:false}] };
        assert.equal(await warm._isCurrent(), false); // tenant history incomplete
        const restored = new MigrationRunner({ query: async sql => ({rows: sql.includes('SELECT EXISTS')
            ? [{exists:true}] : [{tenant_schema:'tenant_123',schema_exists:false,previously_migrated:true}]}) });
        restored._readSqlFiles=()=>[{name:'001_baseline.sql',sql:''}];
        await assert.rejects(()=>restored._runAllTenantMigrations(),error=>error.code==='MIGRATION_SCHEMA_MISSING');
        const signup = new MigrationRunner({ query: async () => { throw new Error('escaped signup transaction'); } });
        const queries=[];
        const client={ query: async (sql) => {
            queries.push(sql);
            return { rows: /SELECT EXISTS/.test(sql) ? [{exists:false}] : [], rowCount:0 };
        } };
        await signup._applyTenantMigrations('tenant_123', client, [{name:'001_baseline.sql',sql:'CREATE TABLE ${SCHEMA}.test(id INT)'}]);
        assert(queries.some(q => q.includes('pg_advisory_xact_lock')));
        assert(queries.some(q => q.includes('CREATE TABLE tenant_123.test')));
        console.log('Startup: readiness, bounded/single-flight maintenance, foreground reservation, exact cadence, DB failure, follower, shutdown and complete migration-history guards passed.');
    } finally { clearInterval(keepAlive); }
}
main().catch(error => { console.error(error); process.exitCode=1; });

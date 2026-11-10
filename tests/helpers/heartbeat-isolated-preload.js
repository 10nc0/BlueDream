'use strict';
// Test-only isolation: exercise the real production worker/pg/lease, but fence
// every SQL operation into a disposable fixture schema and advisory-lock key.
const { workerData } = require('node:worker_threads');
const pg = require('pg');
const RealPool = pg.Pool;
if (!/^startup_fixture_\d+$/.test(workerData.fixtureSchema) || !Number.isSafeInteger(workerData.fixtureKey))
    throw new Error('Missing isolated heartbeat test namespace.');
class IsolatedPool extends RealPool {
    constructor(options) {
        if (options.max !== 1 || options.statement_timeout !== 5000)
            throw new Error('Heartbeat must keep bounded, independent database capacity.');
        super(options);
    }
    query(sql, ...args) {
        if (typeof sql !== 'string' || !sql.includes('core.system_counters'))
            throw new Error('Unexpected heartbeat SQL in isolated worker.');
        return super.query(sql.replaceAll('core.system_counters', `${workerData.fixtureSchema}.system_counters`)
            .replaceAll('1314212174', String(workerData.fixtureKey)), ...args);
    }
}
pg.Pool = IsolatedPool;

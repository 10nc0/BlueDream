'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { HeartbeatClock } = require('./heartbeat-clock');
const { HeartbeatLease } = require('./heartbeat-lease');

let pool, clock, stopping = false;
async function stop() {
    if (stopping) return;
    stopping = true;
    try { await clock?.stop(); }
    catch (error) { parentPort.postMessage({ kind: 'release-error', code: error.code || 'HEARTBEAT_RELEASE_ERROR' }); }
    finally { await pool?.end(); parentPort.close(); }
}
parentPort.on('message', message => { if (message.kind === 'stop') void stop(); });

try {
    if (workerData.production) {
        // Reuse the kernel's verified source/SSL/fallback choice, not another
        // synchronous resolver handshake. Connection details never leave IPC.
        const resolver = require('./db-resolver');
        resolver.setActiveResolution(workerData.resolution);
        pool = resolver.createPool({ max: 1, min: 0, connectionTimeoutMillis: 4500,
            statement_timeout: 5000, query_timeout: 5500, application_name: 'nyan-heartbeat' });
        pool.on('error', error => parentPort.postMessage({
            kind: 'observation', owned: false, fresh: false, code: error.code || 'HEARTBEAT_POOL_ERROR'
        }));
    }
    clock = new HeartbeatClock({ lease: pool ? new HeartbeatLease(pool) : null,
        initialCount: workerData.production ? 0 : workerData.initialCount || 0,
        publish: message => parentPort.postMessage(message) });
    void clock.start();
} catch (error) {
    parentPort.postMessage({ kind: 'fatal', code: error.code || 'HEARTBEAT_WORKER_ERROR' });
    void stop();
}

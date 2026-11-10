'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture(env, fail = []) {
    const pools=[];
    class Pool {
        constructor(config) { this.config=config; this.release=[]; pools.push(this); }
        async connect() {
            const owner=this;
            return { query: async query => {
                owner.probe=query;
                if (fail.includes(pools.indexOf(owner))) throw Object.assign(new Error('Private connection details must not escape.'), {code:'28P01'});
            }, release: destroy => owner.release.push(!!destroy) };
        }
        async end() { this.closed=true; }
    }
    const box={module:{exports:{}},process:{env},__dirname:require('node:path').dirname(require.resolve('../lib/db-resolver')),
        URL,Date,console,require:name=>name==='pg'?{Pool}:require(name)};
    vm.runInNewContext(fs.readFileSync(require.resolve('../lib/db-resolver'),'utf8'),box);
    return { api:box.module.exports,pools };
}
async function main() {
    const first=fixture({DATABASE_URL:'postgres://test:dummy@db.example.test/app',DATABASE_CA_CERT:'test-ca'});
    const accepted=await first.api.resolveRuntimePool({max:20,statement_timeout:30000});
    assert.equal(first.pools.length,1);
    assert.equal(accepted.pool,first.pools[0]);
    assert.equal(accepted.pool.config.ssl.rejectUnauthorized,true);
    assert.equal(accepted.pool.config.ssl.ca,'test-ca');
    assert.equal(accepted.pool.config.max,20);
    assert.equal(accepted.pool.config.statement_timeout,30000);
    assert.deepEqual(accepted.pool.release,[false]);
    assert(accepted.pool.probe.query_timeout>0 && accepted.pool.probe.query_timeout<=4500);
    assert.equal(first.api.getActiveResolution(),accepted.resolution);
    const fallback=fixture({DATABASE_URL:'postgres://test:dummy@aws.pooler.example.test/app',
        PGHOST:'127.0.0.1',PGUSER:'test',PGDATABASE:'app'},[0]);
    const resolved=await fallback.api.resolveRuntimePool();
    assert.equal(resolved.resolution.source,'PG_VARS');
    assert(fallback.pools[0].config.connectionString.includes('pool_mode=transaction'));
    assert.equal(fallback.pools[0].closed,true);
    assert.deepEqual(fallback.pools[0].release,[true]);
    assert.equal(fallback.pools[1].config.ssl,false);
    const rejected=fixture({DATABASE_URL:'postgres://test:dummy@db.example.test/app',PGHOST:'localhost',PGUSER:'test',PGDATABASE:'app'},[0,1]);
    await assert.rejects(()=>rejected.api.resolveRuntimePool(),error=>{
        assert.equal(error.attempts.length,2); assert(!error.message.includes('Private')); return true;
    });
    await assert.rejects(()=>fixture({}).api.resolveRuntimePool());
    console.log('Async DB bootstrap: retained exact verified pool, TLS/CA parity, source fallback, failed-client disposal and fail-closed behavior passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
const assert = require('node:assert/strict');
const { createPool, getActiveResolution } = require('../lib/db-resolver');
const { Worker } = require('node:worker_threads');
const { HeartbeatLease } = require('../lib/heartbeat-lease');
const { LIVE_SHARE_SQL, LIVE_PHONE_SQL } = require('../lib/access-expiry');
async function main() {
    const pool = createPool({ max: 4, connectionTimeoutMillis: 5000, statement_timeout:5000 });
    const schema = `startup_fixture_${process.pid}`;
    const key = 1987000000 + process.pid % 1000000;
    try {
        await pool.query(`CREATE SCHEMA ${schema}`);
        await pool.query(`CREATE TABLE ${schema}.system_counters(key TEXT PRIMARY KEY,value BIGINT NOT NULL,meta JSONB,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        const isolated = { query: (sql, params) => pool.query(sql.replaceAll('core.system_counters', `${schema}.system_counters`)
            .replaceAll('1314212174', String(key)), params) };
        const a=new HeartbeatLease(isolated), b=new HeartbeatLease(isolated);
        const results=await Promise.all([a.tick(),b.tick()]);
        assert.equal(results.filter(r=>r.owned).length,1);
        const winner=results[0].owned?a:b, loser=winner===a?b:a;
        assert.equal(Number((await winner.tick()).value),2);
        const followed=await loser.tick();
        assert.equal(followed.owned,false); assert.equal(Number(followed.value),2); assert(followed.fresh);
        assert(Number(followed.age_ms) >= 0);
        await winner.release();
        assert.equal((await loser.tick()).owned,true);
        assert.equal((await winner.tick()).owned,false);
        const blocker=await pool.connect();
        try {
            await blocker.query('BEGIN');
            await blocker.query('SELECT pg_advisory_xact_lock($1)', [key]);
            assert.equal((await loser.tick()).owned,false); // respect legacy leader
            assert.equal(Number((await pool.query(`SELECT value FROM ${schema}.system_counters WHERE key='phi_breathe_count'`)).rows[0].value),3);
        } finally { await blocker.query('ROLLBACK'); blocker.release(); }
        await pool.query(`ALTER TABLE ${schema}.system_counters ADD CONSTRAINT test_counter_failure CHECK(key!='phi_breathe_count' OR value<4)`);
        await assert.rejects(()=>loser.tick());
        assert.equal(Number((await pool.query(`SELECT value FROM ${schema}.system_counters WHERE key='phi_breathe_count'`)).rows[0].value),3);
        await pool.query(`ALTER TABLE ${schema}.system_counters DROP CONSTRAINT test_counter_failure`);
        await pool.query(`UPDATE ${schema}.system_counters SET meta=jsonb_set(meta,'{lease_until}',to_jsonb(clock_timestamp()-INTERVAL '1 second')) WHERE key='phi_breathe_leader'`);
        assert.equal((await winner.tick()).owned,true);
        assert.equal((await loser.tick()).owned,false); // old owner is fenced
        assert.equal(Number((await pool.query(`SELECT value FROM ${schema}.system_counters WHERE key='phi_breathe_count'`)).rows[0].value),4);
        await winner.release();
        const worker = new Worker(require.resolve('../lib/heartbeat-worker'), {
            workerData: { production: true, resolution: getActiveResolution(), fixtureSchema: schema, fixtureKey: key },
            env: {}, execArgv: ['-r', require.resolve('./helpers/heartbeat-isolated-preload')]
        });
        let timer;
        try {
            const observation = await new Promise((resolve,reject) => {
                timer = setTimeout(() => reject(new Error('Production worker did not publish')), 10000);
                worker.once('error', reject);
                worker.on('message', message => {
                    if (message.kind === 'observation') resolve(message);
                    if (message.kind === 'fatal') reject(new Error(message.code));
                });
            });
            assert(observation.owned && observation.fresh);
            assert.equal(observation.count, 5);
            assert(observation.dbMs >= 0);
            assert(observation.observedAt <= observation.emittedAt);
            assert.equal((await loser.tick()).owned, false);
        } finally {
            clearTimeout(timer);
            const exited = new Promise(resolve => worker.once('exit',resolve));
            const kill = setTimeout(() => { void worker.terminate(); }, 6500);
            worker.postMessage({ kind: 'stop' });
            await exited;
            clearTimeout(kill);
        }
        assert.equal((await loser.tick()).owned, true, 'worker shutdown must release the fenced lease');
        await pool.query(`CREATE TABLE ${schema}.user_email_to_tenant(email TEXT,created_at TIMESTAMPTZ);
            INSERT INTO ${schema}.user_email_to_tenant VALUES('early',NOW()-INTERVAL '30 days'),('late',NOW()-INTERVAL '1 day');
            CREATE TABLE ${schema}.book_engaged_phones(phone TEXT,is_creator BOOLEAN);
            INSERT INTO ${schema}.book_engaged_phones VALUES('registered',true)`);
        const shares=await pool.query(`SELECT label FROM (VALUES
            ('accepted','early',NOW()-INTERVAL '20 days'),
            ('expired','late',NOW()-INTERVAL '20 days'),
            ('pending','absent',NOW()-INTERVAL '1 day'),
            ('expired-pending','absent',NOW()-INTERVAL '20 days')
            ) bs(label,shared_with_email,invited_at) WHERE ${LIVE_SHARE_SQL.replaceAll('core.',`${schema}.`)} ORDER BY label`);
        assert.deepEqual(shares.rows.map(row=>row.label),['accepted','pending']);
        const phones=await pool.query(`SELECT phone FROM (VALUES
            ('recent',false,NOW()-INTERVAL '1 day'),
            ('dormant',false,NOW()-INTERVAL '61 days'),
            ('revoked',false,NULL),('owner',true,NULL),('registered',false,NULL)
            ) ep(phone,is_creator,last_engaged_at) WHERE ${LIVE_PHONE_SQL.replaceAll('core.',`${schema}.`)} ORDER BY phone`);
        assert.deepEqual(phones.rows.map(row=>row.phone),['owner','recent','registered']);
        console.log('Heartbeat DB: atomic single leader, follower age, takeover, stale-owner fencing, legacy-lock guard, rollback, independent production worker and graceful lease release passed (disposable schema only).');
        console.log('Authorization DB: late/expired shares and dormant/null contributors denied before cleanup; accepted shares and creators preserved.');
    } finally {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await pool.end();
    }
}
main().catch(error=>{console.error('Heartbeat fixture failed:',error.code||error.message);process.exitCode=1;});

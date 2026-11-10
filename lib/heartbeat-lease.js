'use strict';
const { randomUUID } = require('node:crypto');

// Session advisory locks cannot safely be held through a transaction-mode
// pooler, even on a pinned pg client. Lease ownership and the counter increment
// are one atomic statement, fenced by the conflicting lease row itself.
class HeartbeatLease {
    constructor(pool) { this.pool = pool; this.owner = randomUUID(); }
    async tick() {
        const result = await this.pool.query(`
            WITH gate AS (
                SELECT pg_try_advisory_xact_lock(1314212174) AS held
            ), leader AS (
                INSERT INTO core.system_counters(key,value,meta,updated_at)
                SELECT 'phi_breathe_leader',0,
                    jsonb_build_object('owner',$1::text,'lease_until',clock_timestamp()+INTERVAL '30 seconds'),NOW()
                FROM gate WHERE held
                ON CONFLICT(key) DO UPDATE SET meta=EXCLUDED.meta, updated_at=NOW()
                WHERE core.system_counters.meta->>'owner'=$1
                   OR (core.system_counters.meta->>'lease_until')::timestamptz < clock_timestamp()
                RETURNING 1
            ), tick AS (
                INSERT INTO core.system_counters(key,value,updated_at)
                SELECT 'phi_breathe_count',1,NOW() FROM leader
                ON CONFLICT(key) DO UPDATE
                SET value=core.system_counters.value+1,updated_at=NOW()
                RETURNING value,updated_at
            )
            SELECT value,TRUE AS owned,TRUE AS fresh,
                   EXTRACT(EPOCH FROM (clock_timestamp()-updated_at))*1000 AS age_ms FROM tick
            UNION ALL
            SELECT value,FALSE AS owned,
                   updated_at > clock_timestamp()-INTERVAL '20 seconds' AS fresh,
                   EXTRACT(EPOCH FROM (clock_timestamp()-updated_at))*1000 AS age_ms
            FROM core.system_counters WHERE key='phi_breathe_count'
              AND NOT EXISTS(SELECT 1 FROM leader)`, [this.owner]);
        return result.rows[0] || { owned: false, fresh: false };
    }
    async release() {
        await this.pool.query(`UPDATE core.system_counters
            SET meta=jsonb_set(meta,'{lease_until}',to_jsonb(clock_timestamp())),updated_at=NOW()
            WHERE key='phi_breathe_leader' AND meta->>'owner'=$1`, [this.owner]);
    }
}
module.exports = { HeartbeatLease };

'use strict';

// Deterministic isolated ledger. No network, credentials or customer records.
module.exports = function capacityPool() {
    const ledger = new Map(), reservations = new Map();
    let snapshot;
    const fixture = {
        ledger, reservations, connects: 0, queries: [],
        async connect() {
            fixture.connects++;
            if (fixture.poolError) throw fixture.poolError;
            return {
                release() {},
                async query(sql, params = []) {
                    fixture.queries.push(sql);
                    fixture.beforeQuery?.(sql, params);
                    if (sql === 'BEGIN') {
                        snapshot = structuredClone({ ledger, reservations });
                        return { rows: [] };
                    }
                    if (sql === 'ROLLBACK') {
                        ledger.clear(); reservations.clear();
                        for (const entry of snapshot.ledger) ledger.set(...entry);
                        for (const entry of snapshot.reservations) reservations.set(...entry);
                        return { rows: [] };
                    }
                    if (sql === 'COMMIT' || sql.startsWith('SET LOCAL') || sql.includes('pg_advisory_xact_lock'))
                        return { rows: [] };
                    if (sql.startsWith('SELECT state FROM core.ai_capacity'))
                        return { rows: ledger.has(params[0]) ? [{ state: structuredClone(ledger.get(params[0])) }] : [] };
                    if (sql.startsWith('SELECT key,state FROM core.ai_capacity'))
                        return { rows: params[0].filter(key => ledger.has(key)).map(key => ({ key, state: structuredClone(ledger.get(key)) })) };
                    if (sql.startsWith('INSERT INTO core.ai_capacity')) {
                        if (sql.includes('jsonb_to_recordset')) {
                            for (const row of JSON.parse(params[0])) ledger.set(row.key, structuredClone(row.state));
                            return { rows: [] };
                        }
                        ledger.set(params[0], structuredClone(params[1]));
                        return { rows: [] };
                    }
                    if (sql.includes('COUNT(*)::int AS n FROM core.ai_capacity')) return { rows: [{ n: 0 }] };
                    if (sql.includes('COUNT(*)::int AS n FROM core.ai_reservations'))
                        return { rows: [{ n: [...reservations.values()].filter(row => !row.settled).length }] };
                    if (sql.startsWith('INSERT INTO core.ai_reservations')) {
                        const [id, principal, scopes, tokens, cost] = params;
                        reservations.set(id, { id, principal, scopes, tokens, cost, settled: false });
                        return { rows: [] };
                    }
                    if (sql.startsWith('SELECT * FROM core.ai_reservations'))
                        return { rows: reservations.has(params[0]) ? [structuredClone(reservations.get(params[0]))] : [] };
                    if (sql.startsWith('UPDATE core.ai_reservations SET settled=TRUE')) {
                        reservations.get(params[0]).settled = true;
                        return { rows: [] };
                    }
                    throw new Error('Unexpected offline fixture operation');
                }
            };
        }
    };
    return fixture;
};

'use strict';

const { randomUUID } = require('node:crypto');

// Disk-backed backlog, not active media buffers. Sized for concurrent sender
// bursts; transport concurrency remains independently bounded by the coordinator.
const MAX_QUEUE_SIZE = 10000;
const BATCH_SIZE = 128;
const MAX_WAITING = 2048;
const MAX_WAIT_MS = 5000;
const admissions = new WeakMap();
const busy = code => Object.assign(new Error(
    code === 'INPIPE_QUEUE_FULL' ? 'Queue is full; retry required' : 'Message not accepted; retry required'
), { code, status: 503 });

// The global capacity/order gate is retained across replicas, but one short
// transaction now admits a batch, not eight roundtrips per individual webhook.
// The second statement gets a fresh snapshot AFTER acquiring the gate.
const insertBatch = `
WITH inputs AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS i(n int, conversation text, provider text, sid text, priority text, payload jsonb)
), known AS MATERIALIZED (
    SELECT i.*, q.id AS known_id, (q.id IS NOT NULL OR s.sid IS NOT NULL) AS duplicate
    FROM inputs i LEFT JOIN LATERAL (
        SELECT id FROM core.message_queue q WHERE i.provider IS NOT NULL AND q.provider_key=i.provider
        UNION ALL
        SELECT id FROM core.message_queue q WHERE i.provider IS NOT NULL AND q.provider_key IS NULL AND
            q.payload->>'channel'=i.payload->>'channel' AND
            COALESCE(q.payload->>'messageSid',q.payload->'msg'->>'messageId')=
                COALESCE(i.payload->>'messageSid',i.payload->'msg'->>'messageId')
        LIMIT 1
    ) q ON true
    LEFT JOIN core.processed_sids s ON i.sid IS NOT NULL AND s.sid=i.sid
), candidates AS (
    SELECT *, row_number() OVER(ORDER BY n) AS position FROM known WHERE NOT duplicate
), capacity AS (
    SELECT GREATEST(0,$2::int-COUNT(*)) AS available FROM core.message_queue
        WHERE status IN ('pending','processing')
), inserted AS (
    INSERT INTO core.message_queue(priority,payload,status,conversation_key,provider_key)
    SELECT priority,payload,'pending',conversation,provider FROM candidates,capacity
        WHERE position<=available ORDER BY n
    RETURNING id,payload,provider_key
), seen AS (
    INSERT INTO core.processed_sids(sid,processed_at)
    SELECT COALESCE(payload->>'messageSid',payload->'msg'->>'messageId'),NOW() FROM inserted
        WHERE payload->>'channel'='twilio' AND
            COALESCE(payload->>'messageSid',payload->'msg'->>'messageId') IS NOT NULL
    ON CONFLICT(sid) DO NOTHING
)
SELECT k.n, COALESCE(i.id,k.known_id) AS id, k.duplicate,
    (i.id IS NOT NULL OR k.duplicate) AS accepted
FROM known k LEFT JOIN inserted i ON
    i.payload->'acceptance'->>'id'=k.payload->'acceptance'->>'id' ORDER BY k.n`;

class AdmissionBatcher {
    constructor(coordinator) {
        this.coordinator = coordinator;
        this.waiting = [];
        this.running = false;
        this.timer = null;
    }
    enqueue(item, key, maxDepth) {
        if (!Number.isInteger(maxDepth) || maxDepth < 0) return Promise.reject(busy('INPIPE_CAPACITY_INVALID'));
        if (this.waiting.length >= MAX_WAITING) return Promise.reject(busy('INPIPE_ADMISSION_BUSY'));
        return new Promise((resolve, reject) => {
            const entry = { item, key, maxDepth, resolve, reject, at: Date.now() };
            entry.timer = setTimeout(() => {
                const index = this.waiting.indexOf(entry);
                if (index !== -1) {
                    this.waiting.splice(index, 1);
                    reject(busy('INPIPE_ADMISSION_BUSY'));
                }
            }, MAX_WAIT_MS);
            this.waiting.push(entry);
            if (!this.running && !this.timer) this.timer = setTimeout(() => {
                this.timer = null;
                void this.flush();
            }, 5);
        });
    }
    async flush() {
        this.running = true;
        try {
            while (this.waiting.length) {
                const maxDepth = this.waiting[0].maxDepth;
                const batch = [];
                while (batch.length < BATCH_SIZE && this.waiting[0]?.maxDepth === maxDepth) {
                    const entry = this.waiting.shift();
                    clearTimeout(entry.timer);
                    if (Date.now() - entry.at > MAX_WAIT_MS) entry.reject(busy('INPIPE_ADMISSION_BUSY'));
                    else batch.push(entry);
                }
                if (!batch.length) continue;
                // Coalesce provider redelivery inside the same batch. Null IDs
                // remain distinct; content is NEVER an idempotency key.
                const unique = [], byProvider = new Map();
                for (const entry of batch) {
                    if (entry.key.provider && byProvider.has(entry.key.provider)) {
                        entry.n = byProvider.get(entry.key.provider);
                        entry.redelivery = true;
                        continue;
                    }
                    entry.n = unique.length;
                    if (entry.key.provider) byProvider.set(entry.key.provider, entry.n);
                    unique.push({
                        n: entry.n, conversation: entry.key.conversation, provider: entry.key.provider,
                        sid: entry.item.channel === 'twilio' ? entry.item.messageSid || entry.item.msg?.messageId : null,
                        priority: entry.item.msg?.hasMedia ? 'media' : 'text',
                        payload: { ...entry.item, acceptance: { id: randomUUID(), at: new Date().toISOString() } }
                    });
                }
                try {
                    const results = await this.coordinator.transaction(async client => {
                        await client.query('SELECT pg_advisory_xact_lock(708283)');
                        return client.query(insertBatch, [JSON.stringify(unique), maxDepth]);
                    });
                    // Resolve only AFTER commit. A crash before acknowledgment
                    // is safe: provider retries consult durable identities.
                    for (const entry of batch) {
                        const result = results.rows[entry.n];
                        if (!result?.accepted) entry.reject(busy('INPIPE_QUEUE_FULL'));
                        else entry.resolve({ id: result.id, duplicate: result.duplicate || !!entry.redelivery });
                    }
                } catch (error) {
                    for (const entry of batch) entry.reject(error);
                }
            }
        } finally { this.running = false; }
    }
}

function admit(coordinator, item, key, maxDepth = MAX_QUEUE_SIZE) {
    let batcher = admissions.get(coordinator.pool);
    if (!batcher) {
        batcher = new AdmissionBatcher(coordinator);
        admissions.set(coordinator.pool, batcher);
    }
    return batcher.enqueue(item, key, maxDepth);
}

module.exports = { admit, MAX_QUEUE_SIZE };

'use strict';

const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { admit, MAX_QUEUE_SIZE } = require('./queue-admission');
const deliveryContext = new AsyncLocalStorage();
const LEASE_MS = 120000;
const MAX_ACTIVE = 4;
const MAX_ATTEMPTS = 3;
const uncertainSendSql = `EXISTS(SELECT 1 FROM jsonb_each(
    COALESCE(delivery_state->'deliveries','{}'::jsonb)) d WHERE d.value->>'state'='started')`;
// Legacy packets use the same conservative sender scope. It intentionally spans
// books: a sender's book switch must finish before that sender's next attachment.
const conversationSql = alias => `COALESCE(${alias}.conversation_key,
    COALESCE(${alias}.payload->>'channel','unknown') || ':' ||
    COALESCE(${alias}.payload->'msg'->>'phone', ${alias}.payload->'msg'->>'fractalId','unknown'))`;

function identity(item) {
    const channel = item.channel || 'unknown';
    const sender = item.msg?.phone || item.msg?.fractalId || 'unknown';
    const sid = item.messageSid || item.msg?.messageId;
    const scope = channel === 'webhook'
        ? `${item.msg?.tenantSchema}:${item.msg?.fractalId}`
        : channel === 'outbox'
            ? `${item.msg?.tenantSchema}:${item.msg?.fractalId}:${sender}` : sender;
    return {
        conversation: `${channel}:${scope}`,
        provider: sid ? `${channel}:${sid}` : null
    };
}
function fenceError() {
    return Object.assign(new Error('Queue lease lost; publication stopped'), { code: 'INPIPE_FENCED' });
}

class DeliveryCoordinator {
    constructor(pool) { this.pool = pool; }
    async transaction(fn) {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s'");
            const value = await fn(client);
            await client.query('COMMIT');
            return value;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally { client.release(); }
    }
    enqueue(item, maxDepth = MAX_QUEUE_SIZE) {
        return admit(this, item, identity(item), maxDepth);
    }
    async quarantineLegacyOutbox() {
        // Old fast-path sends can have succeeded before their status was saved.
        // No receipt exists to prove non-delivery, even when attempts = 0.
        return this.pool.query(`UPDATE core.outbox_jobs SET status='failed',
            last_error='HELD: legacy publication outcome unknown; reconcile before shared-queue admission',
            updated_at=NOW() WHERE id IN (
                SELECT id FROM core.outbox_jobs WHERE status='pending'
                ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING id`);
    }
    async recover(client = this.pool) {
        // An expired sender that might have posted must NEVER be auto-replayed.
        // A legacy worker has no checkpoints, so its outcome is also unknown.
        return client.query(`UPDATE core.message_queue SET
            status=CASE WHEN lease_token IS NULL OR ${uncertainSendSql} THEN 'failed' ELSE 'pending' END,
            last_error=CASE WHEN lease_token IS NULL OR ${uncertainSendSql}
                THEN 'HELD: expired publication outcome unknown; operator reconciliation required'
                ELSE 'Recovered expired preparation lease' END,
            lease_token=NULL,lease_until=NULL,updated_at=NOW()
            WHERE status='processing' AND (lease_until IS NULL OR lease_until<NOW()) RETURNING id,status`);
    }
    async claim() {
        return this.transaction(async client => {
            // Separate statement gives a fresh READ COMMITTED snapshot AFTER the
            // global claim lock, so competing app instances cannot exceed the cap.
            await client.query('SELECT pg_advisory_xact_lock(708284)');
            await this.recover(client);
            const result = await client.query(`UPDATE core.message_queue q SET
                status='processing',lease_token=$1,lease_until=NOW()+INTERVAL '120 seconds',updated_at=NOW()
                WHERE q.id=(SELECT h.id FROM core.message_queue h
                    WHERE h.status='pending' AND h.retry_count<$2 AND h.next_attempt_at<=NOW()
                    AND (SELECT COUNT(*) FROM core.message_queue WHERE status='processing' AND lease_until>NOW())<$3
                    AND NOT EXISTS(SELECT 1 FROM core.message_queue older
                        WHERE ${conversationSql('older')}=${conversationSql('h')}
                        AND older.id<h.id AND older.status<>'done')
                    ORDER BY h.id LIMIT 1 FOR UPDATE OF h SKIP LOCKED)
                RETURNING q.*`, [randomUUID(), MAX_ATTEMPTS, MAX_ACTIVE]);
            return result.rows[0] || null;
        });
    }
    async renew(row) {
        const result = await this.pool.query(`UPDATE core.message_queue
            SET lease_until=NOW()+INTERVAL '120 seconds',updated_at=NOW()
            WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>NOW() RETURNING id`,
        [row.id, row.lease_token]);
        if (!result.rows.length) throw fenceError();
    }
    async checkpoint(row, value) {
        const result = await this.pool.query(`UPDATE core.message_queue SET delivery_state=$3,updated_at=NOW()
            WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>NOW() RETURNING id`,
        [row.id, row.lease_token, value]);
        if (!result.rows.length) throw fenceError();
        row.delivery_state = value;
    }
    async finish(row) {
        if (Object.values(row.delivery_state?.deliveries || {}).some(value => value.state === 'started'))
            throw Object.assign(new Error('Unresolved publication cannot be completed'), { code: 'INPIPE_HELD' });
        const result = await this.pool.query(`UPDATE core.message_queue SET status='done',lease_token=NULL,
            lease_until=NULL,updated_at=NOW() WHERE id=$1 AND lease_token=$2
            AND status='processing' AND lease_until>NOW() RETURNING id`, [row.id, row.lease_token]);
        if (!result.rows.length) throw fenceError();
    }
    async retry(row, error) {
        const uncertain = Object.values(row.delivery_state?.deliveries || {}).some(value => value.state === 'started');
        const held = uncertain || error.code === 'INPIPE_HELD' || error.code === 'INPIPE_FENCED';
        const result = await this.pool.query(`UPDATE core.message_queue SET retry_count=retry_count+1,
            status=CASE WHEN $3 OR retry_count+1>=$4 THEN 'failed' ELSE 'pending' END,
            next_attempt_at=NOW()+INTERVAL '1 millisecond'*$6,
            last_error=$5,lease_token=NULL,lease_until=NULL,updated_at=NOW()
            WHERE id=$1 AND lease_token=$2 AND status='processing' RETURNING status`,
        [row.id, row.lease_token, held, MAX_ATTEMPTS,
            `${held ? 'HELD: reconciliation required; ' : ''}${error.code || 'PROCESSING_FAILED'}`,
            Math.max(5000 * ((row.retry_count || 0) + 1), Number(error.retryAfterMs) || 0)]);
        return result.rows[0]?.status || 'fenced';
    }
    context(row) {
        const queue = this;
        return {
            row, lost: false,
            async memo(key, create) {
                if (this.lost) throw fenceError();
                if (row.delivery_state[key] !== undefined) return row.delivery_state[key];
                const value = await create();
                try { await queue.checkpoint(row, { ...row.delivery_state, [key]: value }); }
                catch (error) { this.lastError = error; throw error; }
                return value;
            },
            async deliver(stage, send, { singleMessage = true, requireReceipt = false } = {}) {
                if (this.lost) throw fenceError();
                const previous = row.delivery_state.deliveries?.[stage];
                if (previous?.state === 'done') return previous.receipt;
                if (previous?.state === 'started') throw Object.assign(new Error('Publication outcome unknown'), { code: 'INPIPE_HELD' });
                const deliveries = { ...row.delivery_state.deliveries, [stage]: { state: 'started' } };
                try { await queue.checkpoint(row, { ...row.delivery_state, deliveries }); }
                catch (error) { this.lastError = error; throw error; }
                try {
                    const response = await send();
                    if (requireReceipt && !response?.data?.id) {
                        throw Object.assign(new Error('Publication receipt missing'), { code: 'INPIPE_HELD' });
                    }
                    // Only retain Discord receipt fields, never credentials or
                    // an axios request/config object.
                    const receipt = response?.data || response?.status ? { status: response.status, data: {
                        id: response.data?.id, attachments: response.data?.attachments || []
                    } } : null;
                    await queue.checkpoint(row, { ...row.delivery_state,
                        deliveries: { ...row.delivery_state.deliveries, [stage]: { state: 'done', receipt } } });
                    return receipt;
                } catch (error) {
                    this.lastError = error;
                    // Only explicit rejections prove this attempt didn't send.
                    // Network errors, 5xx and partial multi-chunk delivery HOLD.
                    const status = error.response?.status;
                    if (singleMessage && [429, 403, 400, 401, 404].includes(status)) {
                        const current = { ...row.delivery_state.deliveries };
                        delete current[stage];
                        await queue.checkpoint(row, { ...row.delivery_state, deliveries: current });
                    }
                    throw error;
                }
            }
        };
    }
    async run(row, work) {
        row.delivery_state ||= {};
        const context = this.context(row);
        let renewing = false;
        const timer = setInterval(async () => {
            if (renewing || context.lost) return;
            renewing = true;
            try { await this.renew(row); } catch { context.lost = true; }
            finally { renewing = false; }
        }, 20000);
        timer.unref();
        try {
            const value = await deliveryContext.run(context, work);
            if (context.lost) throw fenceError();
            if (context.lastError) throw context.lastError;
            return value;
        }
        finally { clearInterval(timer); }
    }
}

// Publication helpers use the context only for durable queued messages.
async function orderedDelivery(stage, send, options) {
    const context = deliveryContext.getStore();
    return context ? context.deliver(stage, send, options) : send();
}
// Compatibility name only; both schedulers use this same implementation/table.
module.exports = { DeliveryCoordinator, OrderedInpipe: DeliveryCoordinator, orderedDelivery, deliveryContext, identity, LEASE_MS, MAX_ACTIVE, MAX_ATTEMPTS };

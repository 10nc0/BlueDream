const logger = require('./logger');

class HealQueue {
    constructor() {
        this.pool = null;
        this.hermesBot = null;
        this.healIntervalId = null;
    }

    setDependencies(pool, hermesBot) {
        this.pool = pool;
        this.hermesBot = hermesBot;
    }

    async initialize() {
        if (!this.pool) {
            logger.warn('HealQueue: No pool configured, skipping initialization');
            return;
        }

        await this.pool.query(`
            UPDATE core.book_registry
            SET heal_status = 'healthy',
                next_heal_at = NOW() + INTERVAL '7 days'
            WHERE heal_status IS NULL
        `);
        
        const staleLeases = await this.pool.query(`
            UPDATE core.book_registry
            SET heal_status = 'pending',
                heal_lease_until = NULL
            WHERE heal_status = 'healing' 
              AND heal_lease_until < NOW()
            RETURNING id
        `);
        if (staleLeases.rowCount > 0) {
            console.log(`🔧 Reset ${staleLeases.rowCount} stale heal leases`);
        }
        
        const brokenBooks = await this.pool.query(`
            SELECT br.id, br.fractal_id, br.tenant_schema, br.book_name
            FROM core.book_registry br
            WHERE br.status = 'active'
              AND br.heal_status = 'healthy'
              AND NOT EXISTS (
                  SELECT 1 FROM information_schema.tables 
                  WHERE table_schema = br.tenant_schema 
                  AND table_name = 'books'
              )
        `);
        
        if (brokenBooks.rows.length > 0) {
            const brokenIds = brokenBooks.rows.map(b => b.id);
            await this.pool.query(`
                UPDATE core.book_registry
                SET heal_status = 'pending', next_heal_at = NOW()
                WHERE id = ANY($1::uuid[])
            `, [brokenIds]);
            console.log(`🔧 Queued ${brokenIds.length} orphaned books for healing`);
        }
        
        const pending = await this.pool.query(`
            SELECT COUNT(*) as count FROM core.book_registry WHERE heal_status = 'pending'
        `);
        console.log(`🏥 Heal queue initialized: ${pending.rows[0].count} books pending`);
    }

    async runCycle() {
        if (!this.hermesBot || !this.hermesBot.isReady()) return;
        
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET LOCAL statement_timeout = 10000');
            
            const res = await client.query(`
                SELECT id, fractal_id, tenant_schema, book_name,
                       outpipe_ledger, outpipes_user, heal_attempts
                FROM core.book_registry
                WHERE heal_status = 'pending'
                  AND next_heal_at <= NOW()
                  AND (heal_lease_until IS NULL OR heal_lease_until < NOW())
                ORDER BY next_heal_at ASC
                LIMIT 20
                FOR UPDATE SKIP LOCKED
            `);

            if (res.rows.length === 0) {
                await client.query('COMMIT');
                return;
            }

            const books = res.rows;
            console.log(`🏥 Heal cycle: Processing ${books.length} books`);

            const leaseUntil = new Date(Date.now() + 60000);
            await client.query(`
                UPDATE core.book_registry
                SET heal_status = 'healing',
                    heal_lease_until = $1
                WHERE id = ANY($2::uuid[])
            `, [leaseUntil, books.map(b => b.id)]);

            await client.query('COMMIT');

            const healPromises = books.map(book => 
                this.healSingleBook(book).catch(err => 
                    console.error(`❌ Heal failed for ${book.fractal_id}:`, err.message)
                )
            );
            
            await Promise.allSettled(healPromises);

        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            console.error('❌ Heal cycle error:', err.message);
        } finally {
            client.release();
        }
    }

    async healSingleBook(book) {
        try {
            const tenantId = parseInt(book.tenant_schema.replace('tenant_', ''));
            
            const tableCheck = await this.pool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_schema = $1 AND table_name = 'books'
                ) as exists
            `, [book.tenant_schema]);
            
            if (!tableCheck.rows[0].exists) {
                throw new Error(`Tenant schema ${book.tenant_schema} has no books table`);
            }
            
            const bookDetails = await this.pool.query(`
                SELECT id, name, output_01_url, output_0n_url, output_credentials
                FROM ${book.tenant_schema}.books
                WHERE id = (
                    SELECT fractal_id::uuid FROM core.book_registry WHERE id = $1
                ) OR name = $2
                LIMIT 1
            `, [book.id, book.book_name]);
            
            if (bookDetails.rows.length === 0) {
                const altLookup = await this.pool.query(`
                    SELECT id, name, output_01_url, output_0n_url, output_credentials
                    FROM ${book.tenant_schema}.books
                    WHERE id::text = $1
                    LIMIT 1
                `, [book.fractal_id]);
                
                if (altLookup.rows.length === 0) {
                    throw new Error(`Book ${book.fractal_id} not found in ${book.tenant_schema}`);
                }
                bookDetails.rows = altLookup.rows;
            }
            
            const tenantBook = bookDetails.rows[0];
            const outputCreds = tenantBook.output_credentials || {};
            
            if (outputCreds.output_01?.thread_id) {
                await this.pool.query(`
                    UPDATE core.book_registry
                    SET heal_status = 'healthy',
                        heal_attempts = 0,
                        last_healed_at = NOW(),
                        next_heal_at = NOW() + INTERVAL '7 days',
                        heal_lease_until = NULL,
                        heal_error = NULL
                    WHERE id = $1
                `, [book.id]);
                console.log(`✅ ${book.fractal_id} already healthy (thread exists)`);
                return;
            }
            
            const dualThreads = await this.hermesBot.createDualThreadsForBook(
                tenantBook.output_01_url,
                tenantBook.output_0n_url,
                tenantBook.name,
                tenantId,
                tenantBook.id,
                true,
                outputCreds
            );

            if (dualThreads.output_01?.thread_id) {
                const outputDestinations = {};
                if (dualThreads.output_01) outputDestinations.output_01 = dualThreads.output_01;
                if (dualThreads.output_0n) outputDestinations.output_0n = dualThreads.output_0n;
                
                await this.pool.query(`
                    UPDATE ${book.tenant_schema}.books 
                    SET output_credentials = output_credentials || $1::jsonb
                    WHERE id = $2
                `, [JSON.stringify(outputDestinations), tenantBook.id]);
                
                if (dualThreads.output_01?.type === 'thread') {
                    try {
                        await this.hermesBot.sendInitialMessage(
                            dualThreads.output_01.thread_id, 
                            tenantBook.name, 
                            tenantBook.output_01_url
                        );
                    } catch (msgError) {
                        console.warn(`  ⚠️ Initial message failed: ${msgError.message}`);
                    }
                }
                
                await this.pool.query(`
                    UPDATE core.book_registry
                    SET heal_status = 'healthy',
                        heal_attempts = 0,
                        last_healed_at = NOW(),
                        next_heal_at = NOW() + INTERVAL '7 days',
                        heal_lease_until = NULL,
                        heal_error = NULL
                    WHERE id = $1
                `, [book.id]);
                
                console.log(`✅ Healed ${book.fractal_id} → thread ${dualThreads.output_01.thread_id}`);
            } else {
                throw new Error('Thread creation returned no thread_id');
            }
            
        } catch (err) {
            const attempts = (book.heal_attempts || 0) + 1;
            const backoffMinutes = Math.min(Math.pow(2, attempts) * 5, 1440);

            await this.pool.query(`
                UPDATE core.book_registry
                SET heal_status = 'pending',
                    heal_attempts = $1,
                    next_heal_at = NOW() + $2 * INTERVAL '1 minute',
                    heal_lease_until = NULL,
                    heal_error = $3
                WHERE id = $4
            `, [attempts, backoffMinutes, err.message, book.id]);

            console.warn(`⚠️ Heal failed ${book.fractal_id} (attempt ${attempts}), retry in ${backoffMinutes}min`);
        }
    }

    async queueForHealing(fractalId, reason = 'webhook failure') {
        try {
            await this.pool.query(`
                UPDATE core.book_registry
                SET heal_status = 'pending',
                    next_heal_at = NOW(),
                    heal_error = $2
                WHERE fractal_id = $1 AND heal_status = 'healthy'
            `, [fractalId, reason]);
        } catch (err) {
            console.error(`Failed to queue ${fractalId} for healing:`, err.message);
        }
    }

    start(intervalMs = 20000) {
        if (this.healIntervalId) {
            clearInterval(this.healIntervalId);
        }
        this.healIntervalId = setInterval(() => this.runCycle(), intervalMs);
        console.log(`✅ Heal immune system active (${intervalMs/1000}s cycle, batch=20, lease=60s)`);
    }

    stop() {
        if (this.healIntervalId) {
            clearInterval(this.healIntervalId);
            this.healIntervalId = null;
        }
    }
}

const healQueue = new HealQueue();

module.exports = { healQueue, HealQueue };

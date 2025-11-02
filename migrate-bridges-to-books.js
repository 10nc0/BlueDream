const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

const DRY_RUN = process.argv.includes('--dry-run');

async function migrateBridgesToBooks() {
    console.log('🔄 Starting bridges → books table migration\n');
    console.log(`Mode: ${DRY_RUN ? '🔍 DRY RUN (preview only)' : '⚡ LIVE EXECUTION'}\n`);
    
    let totalMigrated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    const results = [];

    try {
        console.log('🔍 Discovering tenant schemas...\n');
        
        const schemasResult = await pool.query(`
            SELECT schema_name 
            FROM information_schema.schemata 
            WHERE schema_name LIKE 'tenant_%'
            ORDER BY schema_name
        `);
        
        const tenantSchemas = schemasResult.rows.map(row => row.schema_name);
        console.log(`📊 Found ${tenantSchemas.length} tenant schema(s): ${tenantSchemas.join(', ')}\n`);
        
        if (tenantSchemas.length === 0) {
            console.log('⚠️  No tenant schemas found. Nothing to migrate.\n');
            return;
        }

        for (const schema of tenantSchemas) {
            try {
                const hasBridges = await pool.query(`
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables 
                        WHERE table_schema = $1 
                        AND table_name = 'bridges'
                    ) as exists
                `, [schema]);

                const hasBooks = await pool.query(`
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables 
                        WHERE table_schema = $1 
                        AND table_name = 'books'
                    ) as exists
                `, [schema]);

                const bridgesExists = hasBridges.rows[0].exists;
                const booksExists = hasBooks.rows[0].exists;

                if (booksExists) {
                    console.log(`⏭️  ${schema}: Already migrated (books table exists)`);
                    results.push({ schema, status: 'skipped', reason: 'books table already exists' });
                    totalSkipped++;
                    continue;
                }

                if (!bridgesExists) {
                    console.log(`⏭️  ${schema}: No bridges table found (fresh schema)`);
                    results.push({ schema, status: 'skipped', reason: 'no bridges table' });
                    totalSkipped++;
                    continue;
                }

                const countResult = await pool.query(`SELECT COUNT(*) as count FROM ${schema}.bridges`);
                const bridgeCount = parseInt(countResult.rows[0].count);

                if (DRY_RUN) {
                    console.log(`🔍 ${schema}: Would rename bridges → books (${bridgeCount} records)`);
                    results.push({ schema, status: 'preview', count: bridgeCount });
                    totalMigrated++;
                } else {
                    await pool.query(`ALTER TABLE ${schema}.bridges RENAME TO books`);
                    console.log(`✅ ${schema}: Renamed bridges → books (${bridgeCount} records)`);
                    results.push({ schema, status: 'migrated', count: bridgeCount });
                    totalMigrated++;
                }

            } catch (error) {
                console.error(`❌ ${schema}: Migration failed - ${error.message}`);
                results.push({ schema, status: 'error', error: error.message });
                totalErrors++;
            }
        }

        console.log('\n' + '='.repeat(60));
        console.log('📊 MIGRATION SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total schemas found:    ${tenantSchemas.length}`);
        console.log(`${DRY_RUN ? 'Would migrate' : 'Migrated'}:          ${totalMigrated}`);
        console.log(`Skipped:                ${totalSkipped}`);
        console.log(`Errors:                 ${totalErrors}`);
        console.log('='.repeat(60) + '\n');

        if (DRY_RUN && totalMigrated > 0) {
            console.log('💡 Run without --dry-run flag to execute the migration:\n');
            console.log('   node migrate-bridges-to-books.js\n');
        }

        if (totalErrors > 0) {
            console.log('⚠️  Some schemas had errors. Review the output above.\n');
            process.exit(1);
        }

        if (!DRY_RUN && totalMigrated > 0) {
            console.log('✅ Migration complete! Your books should now load in production.\n');
        }

    } catch (error) {
        console.error('❌ Fatal error during migration:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

migrateBridgesToBooks().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
});

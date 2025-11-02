const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

const DRY_RUN = process.argv.includes('--dry-run');

async function addGroupMessagesColumn() {
    console.log('🔄 Adding include_group_messages column to books tables\n');
    console.log(`Mode: ${DRY_RUN ? '🔍 DRY RUN (preview only)' : '⚡ LIVE EXECUTION'}\n');
    
    let totalAdded = 0;
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
                // Check if books table exists
                const hasBooksTable = await pool.query(`
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables 
                        WHERE table_schema = $1 
                        AND table_name = 'books'
                    ) as exists
                `, [schema]);

                if (!hasBooksTable.rows[0].exists) {
                    console.log(`⏭️  ${schema}: No books table found (skipping)`);
                    results.push({ schema, status: 'skipped', reason: 'no books table' });
                    totalSkipped++;
                    continue;
                }

                // Check if include_group_messages column already exists
                const hasColumn = await pool.query(`
                    SELECT EXISTS (
                        SELECT FROM information_schema.columns 
                        WHERE table_schema = $1 
                        AND table_name = 'books'
                        AND column_name = 'include_group_messages'
                    ) as exists
                `, [schema]);

                if (hasColumn.rows[0].exists) {
                    console.log(`⏭️  ${schema}: Column already exists (skipping)`);
                    results.push({ schema, status: 'skipped', reason: 'column exists' });
                    totalSkipped++;
                    continue;
                }

                // Get count of books in this schema
                const countResult = await pool.query(`SELECT COUNT(*) as count FROM ${schema}.books`);
                const bookCount = parseInt(countResult.rows[0].count);

                if (DRY_RUN) {
                    console.log(`🔍 ${schema}: Would add include_group_messages column (${bookCount} books)`);
                    results.push({ schema, status: 'preview', count: bookCount });
                    totalAdded++;
                } else {
                    // Add the column with default value false
                    await pool.query(`
                        ALTER TABLE ${schema}.books 
                        ADD COLUMN include_group_messages BOOLEAN DEFAULT false
                    `);
                    console.log(`✅ ${schema}: Added include_group_messages column (${bookCount} books)`);
                    results.push({ schema, status: 'added', count: bookCount });
                    totalAdded++;
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
        console.log(`${DRY_RUN ? 'Would add column' : 'Added column'}:       ${totalAdded}`);
        console.log(`Skipped:                ${totalSkipped}`);
        console.log(`Errors:                 ${totalErrors}`);
        console.log('='.repeat(60) + '\n');

        if (DRY_RUN && totalAdded > 0) {
            console.log('💡 Run without --dry-run flag to execute the migration:\n');
            console.log('   node add-group-messages-column.js\n');
        }

        if (totalErrors > 0) {
            console.log('⚠️  Some schemas had errors. Review the output above.\n');
            process.exit(1);
        }

        if (!DRY_RUN && totalAdded > 0) {
            console.log('✅ Migration complete! You can now create books with group message settings.\n');
        }

    } catch (error) {
        console.error('❌ Fatal error during migration:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

addGroupMessagesColumn().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
});

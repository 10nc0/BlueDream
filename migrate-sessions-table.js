const { Pool } = require('pg');

async function migrateSessionsTable() {
    const pool = new Pool({ 
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 10000
    });
    
    try {
        console.log('🔄 Migrating sessions tables from "expire" to "expires"...\n');
        
        // Find all tenant schemas
        const schemasResult = await pool.query(`
            SELECT tenant_schema 
            FROM core.tenant_catalog 
            ORDER BY id
        `);
        
        console.log(`📋 Found ${schemasResult.rows.length} tenant schemas\n`);
        
        let migratedCount = 0;
        let skippedCount = 0;
        
        for (const row of schemasResult.rows) {
            const schema = row.tenant_schema;
            
            // Check if sessions table exists
            const tableCheck = await pool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_schema = $1 AND table_name = 'sessions'
                )
            `, [schema]);
            
            if (!tableCheck.rows[0].exists) {
                console.log(`  ⏭️  ${schema}: No sessions table, skipping`);
                skippedCount++;
                continue;
            }
            
            // Check if 'expire' column exists
            const columnCheck = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_schema = $1 AND table_name = 'sessions'
                AND column_name = 'expire'
            `, [schema]);
            
            if (columnCheck.rows.length === 0) {
                console.log(`  ✅ ${schema}: Already using 'expires', skipping`);
                skippedCount++;
                continue;
            }
            
            // Migrate: rename column and index
            console.log(`  🔧 ${schema}: Migrating 'expire' → 'expires'...`);
            
            await pool.query(`
                ALTER TABLE ${schema}.sessions 
                RENAME COLUMN expire TO expires
            `);
            
            // Note: Index name stays the same (sessions_expire_idx) for backward compatibility
            console.log(`  ✅ ${schema}: Migration complete`);
            migratedCount++;
        }
        
        console.log(`\n✅ Migration complete!`);
        console.log(`   Migrated: ${migratedCount} schemas`);
        console.log(`   Skipped: ${skippedCount} schemas`);
        
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        throw error;
    } finally {
        await pool.end();
    }
}

// Run migration
migrateSessionsTable().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

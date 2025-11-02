/**
 * Migration: Add tenant_id column to users tables in production
 * 
 * This script safely adds the tenant_id column to all tenant users tables
 * that are missing it. It's idempotent and safe to run multiple times.
 * 
 * Usage:
 *   node migrate-users-tenant-id.js
 */

const { Pool } = require('pg');

async function migrateUsersTenantId() {
    const connectionString = process.env.DATABASE_URL;
    
    if (!connectionString) {
        throw new Error('DATABASE_URL environment variable is required');
    }

    const pool = new Pool({
        connectionString,
        ssl: { 
            rejectUnauthorized: false,
            checkServerIdentity: () => undefined
        },
        connectionTimeoutMillis: 60000,
        keepAlive: true
    });

    let client;
    
    try {
        client = await pool.connect();
        
        console.log('🔍 Connected to database');
        console.log(`📊 Database: ${connectionString.match(/@([^/]+)/)?.[1] || 'unknown'}\n`);

        // Discover all tenant schemas
        const schemasResult = await client.query(`
            SELECT schema_name 
            FROM information_schema.schemata 
            WHERE schema_name LIKE 'tenant_%'
            ORDER BY schema_name
        `);

        const tenantSchemas = schemasResult.rows.map(r => r.schema_name);
        console.log(`📁 Found ${tenantSchemas.length} tenant schemas: ${tenantSchemas.join(', ')}\n`);

        let migrated = 0;
        let skipped = 0;
        let errors = 0;

        for (const schema of tenantSchemas) {
            try {
                // Extract tenant number from schema name (e.g., tenant_1 -> 1)
                const tenantNumber = parseInt(schema.replace('tenant_', ''));
                
                if (isNaN(tenantNumber)) {
                    console.log(`⚠️  ${schema}: Invalid schema name format, skipping`);
                    skipped++;
                    continue;
                }

                // Check if users table exists
                const tableExists = await client.query(`
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables 
                        WHERE table_schema = $1 
                        AND table_name = 'users'
                    )
                `, [schema]);

                if (!tableExists.rows[0].exists) {
                    console.log(`⏭️  ${schema}: No users table, skipping`);
                    skipped++;
                    continue;
                }

                // Check if tenant_id column exists
                const columnExists = await client.query(`
                    SELECT EXISTS (
                        SELECT FROM information_schema.columns 
                        WHERE table_schema = $1 
                        AND table_name = 'users' 
                        AND column_name = 'tenant_id'
                    )
                `, [schema]);

                if (columnExists.rows[0].exists) {
                    console.log(`✅ ${schema}: tenant_id column already exists, skipping`);
                    skipped++;
                    continue;
                }

                // Add tenant_id column with default value matching the tenant number
                console.log(`🔧 ${schema}: Adding tenant_id column (default: ${tenantNumber})...`);
                
                await client.query(`
                    ALTER TABLE ${schema}.users 
                    ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT ${tenantNumber}
                `);

                // Verify the column was added
                const verifyResult = await client.query(`
                    SELECT COUNT(*) as count 
                    FROM information_schema.columns 
                    WHERE table_schema = $1 
                    AND table_name = 'users' 
                    AND column_name = 'tenant_id'
                `, [schema]);

                if (parseInt(verifyResult.rows[0].count) > 0) {
                    console.log(`✅ ${schema}: Migration successful\n`);
                    migrated++;
                } else {
                    console.log(`❌ ${schema}: Verification failed\n`);
                    errors++;
                }

            } catch (error) {
                console.error(`❌ ${schema}: Migration failed:`, error.message);
                errors++;
            }
        }

        console.log('\n' + '='.repeat(60));
        console.log('📊 MIGRATION SUMMARY');
        console.log('='.repeat(60));
        console.log(`✅ Migrated:  ${migrated} schemas`);
        console.log(`⏭️  Skipped:   ${skipped} schemas`);
        console.log(`❌ Errors:    ${errors} schemas`);
        console.log(`📁 Total:     ${tenantSchemas.length} schemas`);
        console.log('='.repeat(60) + '\n');

        if (errors > 0) {
            console.log('⚠️  Some schemas failed to migrate. Review errors above.');
            process.exit(1);
        } else {
            console.log('✅ Migration completed successfully!');
        }

    } catch (error) {
        console.error('\n❌ FATAL ERROR:', error);
        process.exit(1);
    } finally {
        if (client) {
            client.release();
        }
        await pool.end();
    }
}

// Run migration
migrateUsersTenantId().catch(error => {
    console.error('💥 Unhandled error:', error);
    process.exit(1);
});

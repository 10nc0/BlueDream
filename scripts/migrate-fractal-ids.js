/**
 * One-time migration script to generate fractalized IDs for existing bridges
 * 
 * This script:
 * 1. Finds all bridges without fractal_id
 * 2. Generates opaque, tenant-scoped fractalized IDs
 * 3. Updates bridges with their new fractalized IDs
 */

const { Pool } = require('pg');
const fractalId = require('./utils/fractal-id');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function migrateFractalIds() {
    console.log('🔄 Starting fractalized ID migration for existing bridges...\n');
    
    try {
        // Get all tenant schemas
        const tenantResult = await pool.query(`
            SELECT DISTINCT table_schema 
            FROM information_schema.tables 
            WHERE table_schema LIKE 'tenant_%' 
            AND table_name = 'bridges'
            ORDER BY table_schema
        `);
        
        let totalMigrated = 0;
        
        for (const tenant of tenantResult.rows) {
            const tenantSchema = tenant.table_schema;
            const tenantId = parseInt(tenantSchema.replace('tenant_', ''));
            
            console.log(`📊 Processing ${tenantSchema}...`);
            
            // Find bridges without fractal_id
            const bridgesResult = await pool.query(`
                SELECT id, created_by_admin_id 
                FROM ${tenantSchema}.bridges 
                WHERE fractal_id IS NULL
            `);
            
            if (bridgesResult.rows.length === 0) {
                console.log(`   ✅ No bridges need migration in ${tenantSchema}\n`);
                continue;
            }
            
            console.log(`   Found ${bridgesResult.rows.length} bridges without fractal_id`);
            
            // Generate and update fractal IDs (with dev prefix if admin_id='01')
            for (const bridge of bridgesResult.rows) {
                const generatedId = fractalId.generate('bridge', tenantId, bridge.id, bridge.created_by_admin_id);
                
                await pool.query(
                    `UPDATE ${tenantSchema}.bridges 
                     SET fractal_id = $1 
                     WHERE id = $2`,
                    [generatedId, bridge.id]
                );
                
                const prefix = bridge.created_by_admin_id === '01' ? '[DEV] ' : '';
                console.log(`   ✅ ${prefix}Bridge ${bridge.id} → ${generatedId}`);
                totalMigrated++;
            }
            
            console.log('');
        }
        
        console.log(`\n🎉 Migration complete! Generated ${totalMigrated} fractalized IDs across all tenants.`);
        console.log(`\n✅ All bridges now have opaque, tenant-scoped fractalized IDs.`);
        console.log(`   Format: bridge_t{tenantId}_{hash}`);
        console.log(`   Example: bridge_t6_a1b2c3d4e5f6\n`);
        
    } catch (error) {
        console.error('❌ Migration failed:', error);
        throw error;
    } finally {
        await pool.end();
    }
}

// Run migration
migrateFractalIds()
    .then(() => {
        console.log('✨ Migration script completed successfully');
        process.exit(0);
    })
    .catch((error) => {
        console.error('💥 Migration script failed:', error);
        process.exit(1);
    });

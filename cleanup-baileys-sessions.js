const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('neon.tech') ? {
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined
    } : false,
    connectionTimeoutMillis: 60000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000
});

async function cleanupBaileysSessions() {
    console.log('🧹 Starting Baileys session cleanup...\n');
    
    let totalCleaned = 0;
    const persistentPath = process.env.BAILEYS_DATA_PATH || '/home/runner/workspace/.baileys_auth_persistent';
    
    try {
        // Get all tenant schemas
        const schemasResult = await pool.query(`
            SELECT schema_name 
            FROM information_schema.schemata 
            WHERE schema_name LIKE 'tenant_%'
            ORDER BY schema_name
        `);
        
        console.log(`📊 Found ${schemasResult.rows.length} tenant schemas\n`);
        
        for (const row of schemasResult.rows) {
            const tenantSchema = row.schema_name;
            
            try {
                // Get all books in this tenant schema
                const booksResult = await pool.query(`
                    SELECT id, name 
                    FROM ${tenantSchema}.books 
                    WHERE archived = false
                    ORDER BY id
                `);
                
                if (booksResult.rows.length === 0) {
                    console.log(`⏭️  ${tenantSchema}: No active books, skipping`);
                    continue;
                }
                
                console.log(`🔍 ${tenantSchema}: Found ${booksResult.rows.length} active books`);
                
                for (const book of booksResult.rows) {
                    const sessionClientId = `${tenantSchema}_book_${book.id}`;
                    const sessionPath = path.join(persistentPath, `session-${sessionClientId}`);
                    
                    if (fs.existsSync(sessionPath)) {
                        // Delete the session folder
                        fs.rmSync(sessionPath, { recursive: true, force: true });
                        console.log(`   ✅ Cleared session for ${tenantSchema}:${book.id} (${book.name})`);
                        totalCleaned++;
                    } else {
                        console.log(`   ⏭️  No session found for ${tenantSchema}:${book.id} (${book.name})`);
                    }
                }
                
                console.log(''); // Empty line between schemas
                
            } catch (schemaError) {
                console.error(`❌ Error processing ${tenantSchema}:`, schemaError.message);
            }
        }
        
        console.log(`\n✅ Cleanup complete: ${totalCleaned} sessions cleared`);
        console.log('📱 All books will need to scan fresh QR codes on next startup\n');
        
    } catch (error) {
        console.error('❌ Cleanup failed:', error);
        throw error;
    } finally {
        await pool.end();
    }
}

// Run cleanup
cleanupBaileysSessions()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('Fatal error:', err);
        process.exit(1);
    });

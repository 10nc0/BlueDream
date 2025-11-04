#!/usr/bin/env node
// Fix books with missing Discord threads by ensuring they have output_01_url set

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') 
        ? false 
        : { rejectUnauthorized: false },
    max: 5,
    min: 1
});

async function fixBrokenBooks() {
    const NYANBOOK_WEBHOOK_URL = process.env.NYANBOOK_WEBHOOK_URL;
    
    if (!NYANBOOK_WEBHOOK_URL) {
        console.error('❌ NYANBOOK_WEBHOOK_URL not set!');
        process.exit(1);
    }
    
    console.log('🔧 Fixing books with missing output_01_url...\n');
    
    try {
        // Get all tenant schemas
        const schemas = await pool.query(`
            SELECT schema_name 
            FROM information_schema.schemata 
            WHERE schema_name LIKE 'tenant_%'
            ORDER BY schema_name
        `);
        
        let totalFixed = 0;
        let totalBroken = 0;
        
        for (const { schema_name } of schemas.rows) {
            // Check if books table exists
            const tableCheck = await pool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_schema = $1 AND table_name = 'books'
                ) as exists
            `, [schema_name]);
            
            if (!tableCheck.rows[0].exists) {
                continue;
            }
            
            // Find books missing output_01_url or thread_id
            const brokenBooks = await pool.query(`
                SELECT 
                    id, 
                    name, 
                    fractal_id,
                    output_01_url, 
                    output_credentials
                FROM ${schema_name}.books 
                WHERE archived = false
                  AND (output_01_url IS NULL OR output_01_url = '')
            `);
            
            for (const book of brokenBooks.rows) {
                totalBroken++;
                console.log(`📚 ${schema_name}: "${book.name}" (${book.fractal_id})`);
                console.log(`   Current output_01_url: ${book.output_01_url || 'NULL'}`);
                
                // Set output_01_url to global Ledger webhook
                await pool.query(`
                    UPDATE ${schema_name}.books 
                    SET output_01_url = $1
                    WHERE id = $2
                `, [NYANBOOK_WEBHOOK_URL, book.id]);
                
                totalFixed++;
                console.log(`   ✅ Fixed: Set output_01_url to Nyanbook Ledger\n`);
            }
        }
        
        console.log(`\n✅ Fixed ${totalFixed}/${totalBroken} broken books`);
        console.log(`🔄 Restart the server to trigger auto-heal and create Discord threads`);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

fixBrokenBooks();

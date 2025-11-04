#!/usr/bin/env node
// Check which books have undefined/null Discord thread IDs

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') 
        ? false 
        : { rejectUnauthorized: false },
    max: 5,
    min: 1
});

async function checkBrokenThreads() {
    console.log('🔍 Checking for books with broken Discord threads...\n');
    
    try {
        // Check core.book_registry first
        const registryCheck = await pool.query(`
            SELECT 
                book_name, 
                join_code,
                fractal_id,
                tenant_schema,
                outpipe_ledger,
                status
            FROM core.book_registry
            WHERE status = 'active' OR status = 'pending'
            ORDER BY updated_at DESC
            LIMIT 20
        `);
        
        console.log('📋 Recent books in registry:');
        for (const book of registryCheck.rows) {
            const ledgerStatus = book.outpipe_ledger ? `✅ ${book.outpipe_ledger.substring(0, 30)}...` : '❌ NULL';
            console.log(`  ${book.fractal_id} (${book.tenant_schema}) [${book.status}]: ledger=${ledgerStatus}`);
        }
        console.log('');
        
        // Get all tenant schemas
        const schemas = await pool.query(`
            SELECT schema_name 
            FROM information_schema.schemata 
            WHERE schema_name LIKE 'tenant_%'
            ORDER BY schema_name
        `);
        
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
            
            // Check books with missing thread IDs
            const books = await pool.query(`
                SELECT 
                    id, 
                    name, 
                    fractal_id,
                    output_01_url, 
                    output_credentials
                FROM ${schema_name}.books 
                WHERE archived = false
            `);
            
            for (const book of books.rows) {
                const creds = book.output_credentials || {};
                const threadId = creds.output_01?.thread_id;
                
                if (!threadId) {
                    totalBroken++;
                    console.log(`❌ ${schema_name}: "${book.name}" (${book.fractal_id})`);
                    console.log(`   output_01_url: ${book.output_01_url || 'NULL'}`);
                    console.log(`   output_credentials: ${JSON.stringify(creds, null, 2)}`);
                    console.log('');
                }
            }
        }
        
        console.log(`\n📊 Total broken books: ${totalBroken}`);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

checkBrokenThreads();

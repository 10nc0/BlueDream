#!/usr/bin/env node
// Check for duplicate fractal_id values across all tenant schemas

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') 
        ? false 
        : { rejectUnauthorized: false },
    max: 10,
    min: 1
});

async function checkDuplicateFractalIds() {
    console.log('🔍 Checking for duplicate fractal_id values...\n');
    
    try {
        const schemasResult = await pool.query(`
            SELECT tenant_schema 
            FROM core.user_email_to_tenant 
            ORDER BY tenant_schema
        `);
        
        const allBooks = [];
        
        for (const { tenant_schema } of schemasResult.rows) {
            try {
                const booksResult = await pool.query(`
                    SELECT 
                        '${tenant_schema}'::text as tenant,
                        id,
                        name,
                        fractal_id,
                        archived,
                        status
                    FROM ${tenant_schema}.books
                    WHERE archived = false
                    ORDER BY fractal_id
                `);
                
                allBooks.push(...booksResult.rows);
            } catch (error) {
                // Silent skip
            }
        }
        
        console.log(`📊 Total active books across all schemas: ${allBooks.length}\n`);
        
        // Group by fractal_id
        const fractalIdMap = new Map();
        allBooks.forEach(book => {
            if (!fractalIdMap.has(book.fractal_id)) {
                fractalIdMap.set(book.fractal_id, []);
            }
            fractalIdMap.get(book.fractal_id).push(book);
        });
        
        console.log(`🎯 Unique fractal_id values: ${fractalIdMap.size}\n`);
        
        // Find duplicates
        const duplicates = Array.from(fractalIdMap.entries()).filter(([_, books]) => books.length > 1);
        
        if (duplicates.length > 0) {
            console.log(`⚠️  Found ${duplicates.length} duplicate fractal_id values:\n`);
            duplicates.forEach(([fractalId, books]) => {
                console.log(`   fractal_id: ${fractalId} (${books.length} copies)`);
                books.forEach(book => {
                    console.log(`     - tenant: ${book.tenant}, id: ${book.id}, name: "${book.name}", status: ${book.status}`);
                });
                console.log('');
            });
        } else {
            console.log('✅ No duplicate fractal_id values found!\n');
        }
        
        console.log('📋 All active books:');
        allBooks.forEach((book, idx) => {
            console.log(`   ${(idx + 1).toString().padStart(2)}. ${book.name.padEnd(30)} | ${book.fractal_id} | ${book.tenant}`);
        });
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await pool.end();
    }
}

checkDuplicateFractalIds();

#!/usr/bin/env node
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function resetDevPassword() {
    const newPassword = process.argv[2] || 'dev_secure_2024';
    
    try {
        console.log('🔧 Resetting dev user password...');
        
        // Hash the new password
        const passwordHash = await bcrypt.hash(newPassword, 10);
        
        // Update the dev user password
        const result = await pool.query(`
            UPDATE users 
            SET password_hash = $1, updated_at = NOW()
            WHERE email = 'phi_dao@pm.me'
            RETURNING id, email, role
        `, [passwordHash]);
        
        if (result.rows.length === 0) {
            console.error('❌ Dev user not found!');
            process.exit(1);
        }
        
        console.log('✅ Dev password reset successfully!');
        console.log(`📧 Email: ${result.rows[0].email}`);
        console.log(`👤 Role: ${result.rows[0].role}`);
        
    } catch (error) {
        console.error('❌ Password reset failed:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

resetDevPassword();

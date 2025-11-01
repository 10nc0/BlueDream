const axios = require('axios');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function healthCheckWebhooks() {
    console.log('🏥 Starting webhook health check...\n');
    
    const client = await pool.connect();
    try {
        const result = await client.query(`
            SELECT 
                id, 
                name, 
                output_credentials, 
                output_01_url, 
                output_0n_url 
            FROM tenant_1.bridges 
            WHERE status = 'connected'
        `);
        
        for (const bridge of result.rows) {
            console.log(`\n🔍 Testing bridge: ${bridge.name}`);
            console.log(`   Bridge ID: ${bridge.id}`);
            
            const output01 = bridge.output_credentials?.output_01;
            const webhook0n = bridge.output_0n_url;
            
            if (output01) {
                console.log(`\n   📤 Testing webhook01 (Ledger)...`);
                const threadId = output01.thread_id;
                const url01 = bridge.output_01_url || `https://discord.com/api/webhooks/${output01.webhook_id}/${output01.webhook_token}`;
                
                const testUrl01 = threadId ? `${url01}?thread_id=${threadId}` : url01;
                
                try {
                    const response = await axios.post(testUrl01, {
                        content: `🏥 **Health Check** from bridge: ${bridge.name}\nTimestamp: ${new Date().toISOString()}\nWebhook: Output #01 (Ledger)`
                    });
                    console.log(`   ✅ webhook01 OK - Status: ${response.status}`);
                } catch (error) {
                    console.log(`   ❌ webhook01 FAILED - ${error.response?.status || error.message}`);
                    if (error.response?.data) {
                        console.log(`      Error: ${JSON.stringify(error.response.data)}`);
                    }
                }
            }
            
            if (webhook0n) {
                console.log(`\n   📤 Testing webhook0n (User)...`);
                
                try {
                    const response = await axios.post(webhook0n, {
                        content: `🏥 **Health Check** from bridge: ${bridge.name}\nTimestamp: ${new Date().toISOString()}\nWebhook: Output #0n (User)`
                    });
                    console.log(`   ✅ webhook0n OK - Status: ${response.status}`);
                } catch (error) {
                    console.log(`   ❌ webhook0n FAILED - ${error.response?.status || error.message}`);
                    if (error.response?.data) {
                        console.log(`      Error: ${JSON.stringify(error.response.data)}`);
                    }
                }
            }
        }
        
        console.log('\n\n✅ Health check complete!\n');
    } catch (error) {
        console.error('❌ Health check error:', error.message);
    } finally {
        client.release();
        await pool.end();
    }
}

healthCheckWebhooks();

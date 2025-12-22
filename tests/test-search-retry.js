#!/usr/bin/env node
const http = require('http');

const TEST_QUERIES = [
    "What is the current stock price of NVIDIA today?",
    "What did Elon Musk tweet yesterday?",
    "Who won the NBA game last night?"
];

console.log('🧪 Testing Search Retry + 2-Pass Audit Flow');
console.log('=' .repeat(50));

async function testQuery(query) {
    return new Promise((resolve, reject) => {
        console.log(`\n📝 Query: "${query}"`);
        console.log('-'.repeat(40));
        
        const postData = JSON.stringify({
            message: query,
            history: []
        });

        const options = {
            hostname: 'localhost',
            port: 5000,
            path: '/api/playground/stream',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = http.request(options, (res) => {
            let fullResponse = '';
            let auditData = null;
            let thinkingStages = [];
            
            res.on('data', (chunk) => {
                const lines = chunk.toString().split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.type === 'thinking') {
                                thinkingStages.push(data.stage);
                            } else if (data.type === 'audit') {
                                auditData = data.audit;
                            } else if (data.type === 'done') {
                                fullResponse = data.fullContent;
                            }
                        } catch (e) {}
                    }
                }
            });

            res.on('end', () => {
                const searchRetryTriggered = thinkingStages.includes('Searching for better data...');
                const reVerifyTriggered = thinkingStages.includes('Re-verifying...');
                
                console.log(`  Stages: ${thinkingStages.join(' → ')}`);
                console.log(`  Search Retry: ${searchRetryTriggered ? '✅' : '❌'} | Re-Verify: ${reVerifyTriggered ? '✅' : '❌'}`);
                console.log(`  Verdict: ${auditData?.verdict} (${auditData?.confidence}%) | didSearchRetry: ${auditData?.didSearchRetry || false}`);
                
                resolve({ 
                    query,
                    auditData, 
                    thinkingStages, 
                    searchRetryTriggered, 
                    reVerifyTriggered,
                    response: fullResponse?.substring(0, 150)
                });
            });
        });

        req.on('error', (e) => {
            console.error(`❌ Request error: ${e.message}`);
            reject(e);
        });

        req.setTimeout(45000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });

        req.write(postData);
        req.end();
    });
}

async function runTests() {
    const results = [];
    
    for (const query of TEST_QUERIES) {
        try {
            const result = await testQuery(query);
            results.push(result);
        } catch (e) {
            console.error(`Failed: ${e.message}`);
        }
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('📊 Summary:');
    console.log('-'.repeat(40));
    
    const retryTriggered = results.filter(r => r.searchRetryTriggered);
    const reVerifyTriggered = results.filter(r => r.reVerifyTriggered);
    
    console.log(`  Queries tested: ${results.length}`);
    console.log(`  Search Retry triggered: ${retryTriggered.length}`);
    console.log(`  Re-Verify triggered: ${reVerifyTriggered.length}`);
    
    if (retryTriggered.length > 0) {
        console.log('\n✅ TEST PASSED: Search retry + re-audit flow verified!');
        retryTriggered.forEach(r => console.log(`   - "${r.query}" triggered retry`));
    } else {
        console.log('\n⚠️ No queries triggered retry. Check server logs for audit details.');
    }
}

runTests()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));

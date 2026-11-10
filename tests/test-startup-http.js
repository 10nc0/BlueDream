'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
function request(port, path) {
    return new Promise((resolve,reject) => {
        http.get({hostname:'127.0.0.1',port,path},res=>{
            let data=''; res.on('data',chunk=>data+=chunk);
            res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data}));
        }).on('error',reject);
    });
}
async function scenario(slowBots) {
    fs.mkdirSync('generated-artifacts', { recursive: true });
    const port=slowBots?5512:5513;
    const resultPath = `${process.cwd()}/generated-artifacts/startup-http-${slowBots?'bots':'heal'}.json`;
    const child=spawn(process.execPath,['-r','./tests/helpers/startup-preload.js','vegapunk.js'],{
        env:{...process.env,NODE_ENV:'development',REPLIT_DEPLOYMENT:'0',PORT:String(port),
            STARTUP_BENCH_BOT_DELAY:slowBots?'15000':'1200',STARTUP_BENCH_HEAL_DELAY:'10000',
            STARTUP_BENCH_BLOCK_AFTER_FIRST_MS:slowBots?'7000':'0',
            STARTUP_BENCH_REAL_BOT_IMPORTS:'1',STARTUP_BENCH_ASSERT_DEFERRED:'1',
            STARTUP_BENCH_PROFILE:'1',
            STARTUP_BENCH_EXIT_DELAY_MS:'1500',
            STARTUP_BENCH_OUTPUT:resultPath},
        stdio:['ignore','pipe','pipe']
    });
    let output='',ready=false,checking;
    const done=new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Startup fixture timed out'));},35000);
        const collect=chunk=>{
            output+=chunk;
            if(ready || !output.includes('api-ready')) return;
            ready=true;
            checking=(async () => { try {
                const health=await request(port,'/health/ready');
                assert.equal(health.status,200);
                const state=JSON.parse(health.data);
                assert(state.schema); assert(state.counterReady);
                assert(state.phasesMs['schema-ready'] <= state.phasesMs['budget-ready']);
                assert(state.phasesMs['budget-ready'] <= state.phasesMs['first-breath']);
                assert(state.phasesMs['first-breath'] <= state.phasesMs['optional-work-start']);
                assert(state.phasesMs['route-imports-ready'] <= state.phasesMs['api-ready']);
                const book=await request(port,slowBots?'/api/books/fixture/messages':'/api/books');
                assert.equal(book.status,slowBots?503:401);
                if(slowBots) { assert.equal(JSON.parse(book.data).code,'warming_up'); assert.equal(book.headers['retry-after'],'5'); }
                const login=await request(port,'/api/auth/status');
                assert.notEqual(login.status,503);
                const budget=await request(port,'/api/nyan-ai/ai-budget');
                assert.equal(budget.status,401);
            } catch(error) { child.kill('SIGTERM'); reject(error); }
            })();
        };
        child.stdout.on('data',collect);
        child.stderr.on('data',chunk=>{ output+=chunk; });
        child.on('error',error=>{clearTimeout(timeout);reject(error);});
        child.on('exit',async code=>{
            clearTimeout(timeout);
            try {
                await checking;
                assert.equal(code,0,output.slice(-1500)); assert(ready);
                assert(output.includes('phi breathe #2'));
                assert(!output.includes('heal-ready')); // heal deliberately still pending
                const timings = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
                assert(timings.firstBreathProcessMs > 0);
                assert(timings.importsBeforeFirstBreath.every(row =>
                    !['discord.js','twilio','exa-js','./routes/books','./routes/pipe','./routes/nyan-ai','./routes/account'].includes(row.request)));
                assert(timings.slowestImports.some(row => row.request === 'discord.js'));
                assert(Math.abs(timings.heartbeatSpacingMs - 6472) < 150,
                    `Breath spacing drifted: ${JSON.stringify(timings)}`);
                if (slowBots) assert.equal(timings.mainThreadBlockMs, 7000);
                console.log(`Kernel cadence: ${timings.heartbeatSpacingMs}ms (target 6472ms), timer late ${timings.heartbeatLatenessMs}ms, IPC delivery ${timings.heartbeatDeliveryMs}ms, main blocked ${timings.mainThreadBlockMs}ms.`);
                resolve();
            } catch(error) { reject(error); }
        });
    });
    await done;
}
async function failureScenario(kind) {
    const child=spawn(process.execPath,['-r','./tests/helpers/startup-preload.js','vegapunk.js'],{
        env:{...process.env,NODE_ENV:'development',REPLIT_DEPLOYMENT:'0',PORT:'5514',
            [kind === 'schema' ? 'STARTUP_BENCH_SCHEMA_FAILURE' : 'STARTUP_BENCH_BUDGET_FAILURE']:'1'},
        stdio:['ignore','pipe','pipe']
    });
    let output='';
    child.stdout.on('data',chunk=>{output+=chunk;});
    child.stderr.on('data',chunk=>{output+=chunk;});
    await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`${kind} failure did not shut down`));},15000);
        child.on('error',error=>{clearTimeout(timer);reject(error);});
        child.on('exit',code=>{
            clearTimeout(timer);
            try {
                assert.equal(code,1,output.slice(-1500));
                assert(!output.includes('api-ready'));
                assert(!output.includes('first-breath'));
                assert(!output.includes('optional-work-start'));
                resolve();
            } catch(error) {reject(error);}
        });
    });
}
async function main() {
    await scenario(true);
    await scenario(false);
    await failureScenario('schema');
    await failureScenario('budget');
    console.log('Kernel HTTP: schema/budget failures stop startup; optional imports follow first breath; login/core independent of 15s bots; dependency routes return retryable 503; healthy routes require auth; second-breath cadence independent of 10s heal and 7s main-thread block.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});

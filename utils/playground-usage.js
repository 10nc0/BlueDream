const DAILY_LIMITS = {
    text: {
        requests: 14400,
        tokens: 6000
    },
    vision: {
        requests: 14400,
        tokens: 6000
    }
};

const dailyUsage = new Map();
let dbPool = null;

function setDbPool(pool) {
    dbPool = pool;
}

function getTodayKey() {
    return new Date().toISOString().slice(0, 10);
}

function getUsageBucket(serviceType) {
    const todayKey = getTodayKey();
    const key = `${todayKey}:${serviceType}`;
    
    if (!dailyUsage.has(key)) {
        dailyUsage.set(key, {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            lastUpdated: Date.now()
        });
    }
    return dailyUsage.get(key);
}

function recordUsage(serviceType, usage) {
    if (!usage) return;
    
    const bucket = getUsageBucket(serviceType);
    bucket.requests += 1;
    bucket.promptTokens += usage.prompt_tokens || 0;
    bucket.completionTokens += usage.completion_tokens || 0;
    bucket.totalTokens += usage.total_tokens || 0;
    bucket.lastUpdated = Date.now();
    
    persistUsageAsync(serviceType, bucket);
}

async function persistUsageAsync(serviceType, bucket) {
    if (!dbPool) return;
    
    const todayKey = getTodayKey();
    
    try {
        await dbPool.query(`
            INSERT INTO core.playground_usage (date, service_type, requests, prompt_tokens, completion_tokens, total_tokens)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (date, service_type) 
            DO UPDATE SET 
                requests = $3,
                prompt_tokens = $4,
                completion_tokens = $5,
                total_tokens = $6,
                updated_at = NOW()
        `, [todayKey, serviceType, bucket.requests, bucket.promptTokens, bucket.completionTokens, bucket.totalTokens]);
    } catch (error) {
        console.log(`⚠️ Usage persistence failed: ${error.message}`);
    }
}

function getUsageStats(serviceType) {
    const bucket = getUsageBucket(serviceType);
    const limits = DAILY_LIMITS[serviceType] || DAILY_LIMITS.text;
    
    return {
        date: getTodayKey(),
        serviceType,
        used: {
            requests: bucket.requests,
            promptTokens: bucket.promptTokens,
            completionTokens: bucket.completionTokens,
            totalTokens: bucket.totalTokens
        },
        limits: {
            requests: limits.requests,
            tokens: limits.tokens
        },
        remaining: {
            requests: Math.max(0, limits.requests - bucket.requests),
            tokensPerMinute: limits.tokens
        },
        percentUsed: {
            requests: Math.round((bucket.requests / limits.requests) * 100)
        },
        lastUpdated: bucket.lastUpdated
    };
}

function getAllUsageStats() {
    return {
        text: getUsageStats('text'),
        vision: getUsageStats('vision'),
        summary: {
            date: getTodayKey(),
            textRequests: getUsageBucket('text').requests,
            visionRequests: getUsageBucket('vision').requests,
            totalRequests: getUsageBucket('text').requests + getUsageBucket('vision').requests,
            textTokens: getUsageBucket('text').totalTokens,
            visionTokens: getUsageBucket('vision').totalTokens,
            totalTokens: getUsageBucket('text').totalTokens + getUsageBucket('vision').totalTokens
        }
    };
}

async function loadTodayUsageFromDb() {
    if (!dbPool) return;
    
    const todayKey = getTodayKey();
    
    try {
        const result = await dbPool.query(
            `SELECT service_type, requests, prompt_tokens, completion_tokens, total_tokens
             FROM core.playground_usage WHERE date = $1`,
            [todayKey]
        );
        
        for (const row of result.rows) {
            const key = `${todayKey}:${row.service_type}`;
            dailyUsage.set(key, {
                requests: row.requests,
                promptTokens: row.prompt_tokens,
                completionTokens: row.completion_tokens,
                totalTokens: row.total_tokens,
                lastUpdated: Date.now()
            });
        }
        
        console.log(`📊 Loaded today's usage from DB: text=${getUsageBucket('text').requests} req, vision=${getUsageBucket('vision').requests} req`);
    } catch (error) {
        console.log(`⚠️ Failed to load usage from DB: ${error.message}`);
    }
}

function cleanupOldBuckets() {
    const todayKey = getTodayKey();
    let cleaned = 0;
    for (const key of dailyUsage.keys()) {
        if (!key.startsWith(todayKey)) {
            dailyUsage.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 Usage cleanup: removed ${cleaned} stale bucket(s)`);
    }
}

function registerWithHeartbeat(heartbeat) {
    heartbeat.subscribe('usage-cleanup', 60 * 60 * 1000, cleanupOldBuckets);
}

module.exports = {
    setDbPool,
    recordUsage,
    getUsageStats,
    getAllUsageStats,
    loadTodayUsageFromDb,
    cleanupOldBuckets,
    registerWithHeartbeat,
    DAILY_LIMITS
};

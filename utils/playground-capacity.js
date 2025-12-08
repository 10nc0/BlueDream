const ACTIVITY_WINDOW_MS = 180 * 60 * 1000; // 180 minutes (3 hours)
const REFILL_INTERVAL_MS = 60 * 1000; // Minimum interval between refill checks

const SERVICE_CONFIGS = {
    text: { poolPerHour: 240, costMultiplier: 1 },
    vision: { poolPerHour: 120, costMultiplier: 3 },
    brave: { poolPerHour: 360, costMultiplier: 1 }
};

const activeIPs = new Map();
const ipBuckets = new Map();
const promptHistory = new Map();
const burstTrackers = new Map();
const ipReputation = new Map(); // In-memory cache for reputation data

let exemptIPs = new Set(['127.0.0.1', '::1']);
let dbPool = null; // Database pool reference for reputation persistence

function setExemptIPs(ips) {
    exemptIPs = new Set(ips);
}

function setDbPool(pool) {
    dbPool = pool;
}

function isExempt(ip) {
    return exemptIPs.has(ip);
}

function recordActivity(ip) {
    if (isExempt(ip)) return;
    activeIPs.set(ip, Date.now());
}

function getActiveIPCount() {
    const now = Date.now();
    let count = 0;
    for (const [ip, lastSeen] of activeIPs.entries()) {
        if (now - lastSeen <= ACTIVITY_WINDOW_MS) {
            count++;
        } else {
            activeIPs.delete(ip);
            ipBuckets.delete(ip);
            promptHistory.delete(ip);
            burstTrackers.delete(ip);
        }
    }
    return Math.max(1, count);
}

async function getReputationMultiplier(ip) {
    if (isExempt(ip)) return 1.5; // Exempt IPs get max bonus
    
    const cached = ipReputation.get(ip);
    const now = Date.now();
    
    if (cached && (now - cached.cachedAt) < 300000) {
        return cached.multiplier;
    }
    
    if (!dbPool) {
        return 1.0;
    }
    
    try {
        const result = await dbPool.query(
            `SELECT first_seen FROM core.playground_reputation WHERE ip_hash = $1`,
            [hashIP(ip)]
        );
        
        let firstSeen;
        if (result.rows.length === 0) {
            await dbPool.query(
                `INSERT INTO core.playground_reputation (ip_hash, first_seen) VALUES ($1, NOW())
                 ON CONFLICT (ip_hash) DO NOTHING`,
                [hashIP(ip)]
            );
            firstSeen = new Date();
        } else {
            firstSeen = result.rows[0].first_seen;
        }
        
        const daysSinceStart = (now - new Date(firstSeen).getTime()) / (24 * 60 * 60 * 1000);
        const multiplier = Math.min(1.5, 1.0 + daysSinceStart * 0.01);
        
        ipReputation.set(ip, { multiplier, cachedAt: now });
        
        return multiplier;
    } catch (error) {
        console.log(`⚠️ Reputation lookup failed: ${error.message}`);
        return 1.0;
    }
}

function hashIP(ip) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(ip + '_nyan_salt_v1').digest('hex').substring(0, 32);
}

function calculateShare(poolPerHour, activeCount) {
    const evenShare = poolPerHour / activeCount;
    if (activeCount <= 10) {
        return Math.max(evenShare, poolPerHour * 0.1);
    }
    return evenShare;
}

function getIPBucket(ip, serviceType) {
    const key = `${ip}:${serviceType}`;
    if (!ipBuckets.has(key)) {
        const config = SERVICE_CONFIGS[serviceType];
        const activeCount = getActiveIPCount();
        const tokensPerIP = calculateShare(config.poolPerHour, activeCount);
        ipBuckets.set(key, {
            tokens: tokensPerIP,
            maxTokens: tokensPerIP * 2,
            lastRefill: Date.now(),
            serviceType
        });
    }
    return ipBuckets.get(key);
}

function refillBuckets() {
    const now = Date.now();
    const activeCount = getActiveIPCount();
    
    for (const [key, bucket] of ipBuckets.entries()) {
        const elapsedMs = now - bucket.lastRefill;
        const minutesElapsed = elapsedMs / REFILL_INTERVAL_MS;
        
        if (minutesElapsed >= 0.1) {
            const config = SERVICE_CONFIGS[bucket.serviceType];
            const sharePerHour = calculateShare(config.poolPerHour, activeCount);
            const refillAmount = (sharePerHour / 60) * minutesElapsed;
            const maxForUser = sharePerHour * 2;
            
            bucket.tokens = Math.min(bucket.tokens + refillAmount, maxForUser);
            bucket.maxTokens = maxForUser;
            bucket.lastRefill = now;
        }
    }
}

async function consumeToken(ip, serviceType) {
    if (isExempt(ip)) {
        return { allowed: true, exempt: true };
    }
    
    recordActivity(ip);
    refillBuckets();
    
    const bucket = getIPBucket(ip, serviceType);
    const config = SERVICE_CONFIGS[serviceType];
    
    const reputationMultiplier = await getReputationMultiplier(ip);
    const effectiveCost = config.costMultiplier / reputationMultiplier;
    
    if (bucket.tokens >= effectiveCost) {
        bucket.tokens -= effectiveCost;
        const activeCount = getActiveIPCount();
        return { 
            allowed: true, 
            remaining: Math.floor(bucket.tokens),
            activeUsers: activeCount,
            reputationBonus: reputationMultiplier > 1.0 ? `${Math.round((reputationMultiplier - 1) * 100)}%` : null
        };
    }
    
    const activeCount = getActiveIPCount();
    return { 
        allowed: false, 
        remaining: 0,
        activeUsers: activeCount,
        reason: `${serviceType} capacity exhausted. ${activeCount} active users sharing pool.`
    };
}

function calculateEntropy(text) {
    if (!text || text.length < 3) return 0;
    const freq = {};
    for (const char of text.toLowerCase()) {
        freq[char] = (freq[char] || 0) + 1;
    }
    let entropy = 0;
    const len = text.length;
    for (const count of Object.values(freq)) {
        const p = count / len;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

function normalizePrompt(text) {
    return (text || '').toLowerCase().replace(/\s+/g, ' ').trim().substring(0, 200);
}

function checkAbuse(ip, prompt) {
    if (isExempt(ip)) {
        return { abusive: false, exempt: true };
    }
    
    const now = Date.now();
    
    const burstKey = ip;
    if (!burstTrackers.has(burstKey)) {
        burstTrackers.set(burstKey, []);
    }
    const bursts = burstTrackers.get(burstKey);
    bursts.push(now);
    const recentBursts = bursts.filter(t => now - t < 15000);
    burstTrackers.set(burstKey, recentBursts);
    
    if (recentBursts.length > 5) {
        return { 
            abusive: true, 
            reason: 'burst',
            message: 'Too many requests. Please wait 15 seconds.'
        };
    }
    
    const normalized = normalizePrompt(prompt);
    if (!promptHistory.has(ip)) {
        promptHistory.set(ip, []);
    }
    const history = promptHistory.get(ip);
    
    const recentDuplicate = history.find(h => 
        h.prompt === normalized && (now - h.time) < 60000
    );
    if (recentDuplicate) {
        return { 
            abusive: true, 
            reason: 'duplicate',
            message: 'Identical query sent recently. Please wait or try a different question.'
        };
    }
    
    history.push({ prompt: normalized, time: now });
    if (history.length > 10) {
        history.shift();
    }
    
    if (prompt && prompt.length > 10) {
        const entropy = calculateEntropy(prompt);
        if (entropy < 2.0) {
            return { 
                abusive: true, 
                reason: 'gibberish',
                message: 'Query appears to be invalid. Please enter a meaningful question.'
            };
        }
    }
    
    return { abusive: false };
}

function getCapacityStatus() {
    const activeCount = getActiveIPCount();
    const status = {};
    
    for (const [type, config] of Object.entries(SERVICE_CONFIGS)) {
        const tokensPerUser = calculateShare(config.poolPerHour, activeCount);
        status[type] = {
            poolPerHour: config.poolPerHour,
            activeUsers: activeCount,
            tokensPerUser: Math.floor(tokensPerUser)
        };
    }
    
    return status;
}

async function initReputationTable() {
    if (!dbPool) {
        console.log('⚠️ No database pool for reputation table');
        return false;
    }
    
    try {
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS core.playground_reputation (
                ip_hash VARCHAR(32) PRIMARY KEY,
                first_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                total_queries INTEGER DEFAULT 0,
                last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);
        console.log('✅ Playground reputation table initialized');
        return true;
    } catch (error) {
        console.log(`⚠️ Failed to init reputation table: ${error.message}`);
        return false;
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, lastSeen] of activeIPs.entries()) {
        if (now - lastSeen > ACTIVITY_WINDOW_MS) {
            activeIPs.delete(ip);
            ipBuckets.delete(ip);
            promptHistory.delete(ip);
            burstTrackers.delete(ip);
        }
    }
}, 5 * 60 * 1000);

module.exports = {
    consumeToken,
    checkAbuse,
    recordActivity,
    getActiveIPCount,
    getCapacityStatus,
    setExemptIPs,
    setDbPool,
    isExempt,
    initReputationTable,
    getReputationMultiplier,
    SERVICE_CONFIGS,
    ACTIVITY_WINDOW_MS
};

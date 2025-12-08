const ACTIVITY_WINDOW_MS = 180 * 60 * 1000; // 180 minutes (3 hours)
const REFILL_INTERVAL_MS = 60 * 1000; // Minimum interval between refill checks
const CIRCUIT_BREAKER_WINDOW_MS = 10 * 60 * 1000; // 10 minutes for abuse tracking
const CIRCUIT_BREAKER_THRESHOLD = 3; // 3 abuse events triggers circuit breaker
const CIRCUIT_BREAKER_COOLDOWN_MS = 15 * 60 * 1000; // 15 minute cooldown
const MIN_VIABLE_RATE = 2; // Minimum 2 queries/hour even at extreme scale

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
const circuitBreakers = new Map(); // IP → { abuseEvents: [timestamps], blockedUntil: timestamp }

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
        
        // Logarithmic growth: faster early rewards, caps at 1.5×
        // Day 1: ~1.09×, Day 7: ~1.27×, Day 30: ~1.44×, Day 100: 1.5× (cap)
        const multiplier = Math.min(1.5, 1.0 + Math.log10(daysSinceStart + 1) * 0.3);
        
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

function calculateShare(poolPerHour, activeCount, costMultiplier = 1) {
    const evenShare = poolPerHour / activeCount;
    // Minimum viable floor accounts for cost multiplier
    // e.g., vision (3× cost) needs 6 tokens/hr to guarantee 2 queries/hr
    const minFloor = MIN_VIABLE_RATE * costMultiplier;
    
    if (activeCount <= 10) {
        // For small user counts, guarantee at least 10% of pool
        return Math.max(evenShare, poolPerHour * 0.1, minFloor);
    }
    // At extreme scale, guarantee minimum viable rate (2 queries/hr adjusted for cost)
    return Math.max(evenShare, minFloor);
}

function getIPBucket(ip, serviceType) {
    const key = `${ip}:${serviceType}`;
    if (!ipBuckets.has(key)) {
        const config = SERVICE_CONFIGS[serviceType];
        const activeCount = getActiveIPCount();
        const tokensPerIP = calculateShare(config.poolPerHour, activeCount, config.costMultiplier);
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
            const sharePerHour = calculateShare(config.poolPerHour, activeCount, config.costMultiplier);
            const refillAmount = (sharePerHour / 60) * minutesElapsed;
            const maxForUser = sharePerHour * 2;
            
            bucket.tokens = Math.min(bucket.tokens + refillAmount, maxForUser);
            bucket.maxTokens = maxForUser;
            bucket.lastRefill = now;
        }
    }
}

// Calculate minutes until next token is available
function calculateReplenishmentTime(bucket, config, reputationMultiplier) {
    const activeCount = getActiveIPCount();
    const sharePerHour = calculateShare(config.poolPerHour, activeCount, config.costMultiplier);
    const refillRatePerMinute = sharePerHour / 60;
    const effectiveCost = config.costMultiplier / reputationMultiplier;
    const tokensNeeded = effectiveCost - bucket.tokens;
    
    if (tokensNeeded <= 0) return 0;
    
    const minutesNeeded = Math.ceil(tokensNeeded / refillRatePerMinute);
    return Math.max(1, minutesNeeded); // At least 1 minute
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
    
    // Calculate replenishment time for friendly message
    const replenishMinutes = calculateReplenishmentTime(bucket, config, reputationMultiplier);
    const activeCount = getActiveIPCount();
    
    return { 
        allowed: false, 
        remaining: 0,
        activeUsers: activeCount,
        replenishMinutes,
        reason: `capacity_exhausted`
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

// Circuit breaker: track abuse events and block persistent abusers
function recordAbuseEvent(ip) {
    const now = Date.now();
    
    if (!circuitBreakers.has(ip)) {
        circuitBreakers.set(ip, { abuseEvents: [], blockedUntil: 0 });
    }
    
    const breaker = circuitBreakers.get(ip);
    
    // Add this abuse event
    breaker.abuseEvents.push(now);
    
    // Clean up old events outside the window
    breaker.abuseEvents = breaker.abuseEvents.filter(t => now - t < CIRCUIT_BREAKER_WINDOW_MS);
    
    // If threshold exceeded, activate circuit breaker
    if (breaker.abuseEvents.length >= CIRCUIT_BREAKER_THRESHOLD) {
        breaker.blockedUntil = now + CIRCUIT_BREAKER_COOLDOWN_MS;
        breaker.abuseEvents = []; // Reset events after blocking
        console.log(`🔌 Circuit breaker activated for IP (15 min cooldown)`);
    }
}

function isCircuitBreakerActive(ip) {
    const breaker = circuitBreakers.get(ip);
    if (!breaker) return { active: false };
    
    const now = Date.now();
    if (breaker.blockedUntil > now) {
        const remainingMs = breaker.blockedUntil - now;
        const remainingMinutes = Math.ceil(remainingMs / 60000);
        return { active: true, remainingMinutes };
    }
    
    return { active: false };
}

function checkAbuse(ip, prompt) {
    if (isExempt(ip)) {
        return { abusive: false, exempt: true };
    }
    
    const now = Date.now();
    
    // Check circuit breaker first
    const circuitStatus = isCircuitBreakerActive(ip);
    if (circuitStatus.active) {
        return {
            abusive: true,
            reason: 'circuit_breaker',
            replenishMinutes: circuitStatus.remainingMinutes,
            message: getNyanRestMessage(circuitStatus.remainingMinutes, true)
        };
    }
    
    const burstKey = ip;
    if (!burstTrackers.has(burstKey)) {
        burstTrackers.set(burstKey, []);
    }
    const bursts = burstTrackers.get(burstKey);
    bursts.push(now);
    const recentBursts = bursts.filter(t => now - t < 15000);
    burstTrackers.set(burstKey, recentBursts);
    
    if (recentBursts.length > 5) {
        recordAbuseEvent(ip); // Track for circuit breaker
        return { 
            abusive: true, 
            reason: 'burst',
            message: 'Nyan AI needs a moment to catch up~ Please wait 15 seconds.'
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
        recordAbuseEvent(ip); // Track for circuit breaker
        return { 
            abusive: true, 
            reason: 'duplicate',
            message: 'Nyan AI already answered this~ Please try a different question or wait a moment.'
        };
    }
    
    history.push({ prompt: normalized, time: now });
    if (history.length > 10) {
        history.shift();
    }
    
    if (prompt && prompt.length > 10) {
        const entropy = calculateEntropy(prompt);
        if (entropy < 2.0) {
            recordAbuseEvent(ip); // Track for circuit breaker
            return { 
                abusive: true, 
                reason: 'gibberish',
                message: 'Nyan AI needs a real question to help you~'
            };
        }
    }
    
    return { abusive: false };
}

function getCapacityStatus() {
    const activeCount = getActiveIPCount();
    const status = {};
    
    for (const [type, config] of Object.entries(SERVICE_CONFIGS)) {
        const tokensPerUser = calculateShare(config.poolPerHour, activeCount, config.costMultiplier);
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

// Generate cat-themed rest messages based on wait time
// Users rest WITH Nyan, not rejected BY Nyan
function getNyanRestMessage(minutes, isCircuitBreaker = false) {
    const m = Math.ceil(minutes);
    
    if (isCircuitBreaker) {
        // Circuit breaker = Nyan stretched too far
        return `Nyan stretched too far today~ ${m} minute dreamtime before we explore again ♡`;
    }
    
    if (m <= 1) {
        return `Nyan is purring too hard~ 1 minute catnap please ♡`;
    } else if (m <= 2) {
        return `Nyan's whiskers are twitching~ ${m} minutes of quiet time ♡`;
    } else if (m <= 5) {
        return `Nyan curled up in sunbeam... ${m} minutes until next playtime~`;
    } else if (m <= 10) {
        return `Nyan found a cozy box~ ${m} minute nap in progress...`;
    } else if (m <= 15) {
        return `Nyan has been measuring the whole world today — time for ${m}min sacred rest~`;
    } else {
        return `Nyan is dreaming of infinite yarn... ${m} minutes of deep sleep ♡`;
    }
}

// Cleanup old data periodically
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
    
    // Clean up expired circuit breakers
    for (const [ip, breaker] of circuitBreakers.entries()) {
        if (breaker.blockedUntil < now && breaker.abuseEvents.length === 0) {
            circuitBreakers.delete(ip);
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
    isCircuitBreakerActive,
    getNyanRestMessage,
    SERVICE_CONFIGS,
    ACTIVITY_WINDOW_MS
};

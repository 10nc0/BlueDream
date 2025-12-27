/**
 * DataPackage - Sovereign Data Container for NYAN Protocol Pipeline
 * 
 * Architecture: "Data enters → transmutes → never hallucinates"
 * 
 * Each message in the φ-8 window carries its own DataPackage as metadata.
 * Stages READ previous package, WRITE new outputs - 2 pass per run.
 * 
 * Fractal Storage:
 *   Tenant (IP) → 8 message window → message metadata → DataPackage
 * 
 * Immutable Facts Rule: Data fields are NEVER altered by personality layer.
 * Only fluff (intros, verbose explanations) is stripped.
 */

const crypto = require('crypto');

const STAGE_IDS = {
  CONTEXT_EXTRACT: 'S-1',
  PREFLIGHT: 'S0', 
  CONTEXT_BUILD: 'S1',
  REASONING: 'S2',
  AUDIT: 'S3',
  RETRY: 'S4',
  PERSONALITY: 'S5',
  OUTPUT: 'S6'
};

/**
 * FILE_TYPES - Shared constants for document classification
 * Harmonized from attachment-cascade.js for unified interface
 */
const FILE_TYPES = {
  PDF: 'pdf',
  EXCEL: 'excel',
  WORD: 'word',
  PRESENTATION: 'presentation',
  IMAGE: 'image',
  TEXT: 'text',
  CODE: 'code',
  AUDIO: 'audio',
  UNKNOWN: 'unknown'
};

/**
 * DocumentExtractionCache - Shared cache for extracted document content
 * Harmonizes attachment-cascade's extractionCache with DataPackage storage
 */
class DocumentExtractionCache {
  constructor() {
    this.cache = new Map();
    this.maxSize = 100;
    this.ttl = 24 * 60 * 60 * 1000; // 24 hours
    this.lastCleanup = Date.now();
    this.cleanupInterval = 5 * 60 * 1000; // 5 minutes
    
    // Proactive interval-based cleanup (runs even if no get/set calls)
    this._cleanupTimer = setInterval(() => {
      this._forceCleanup();
    }, this.cleanupInterval);
    
    // Allow GC to clean up timer if cache is dereferenced
    if (this._cleanupTimer.unref) {
      this._cleanupTimer.unref();
    }
  }
  
  /**
   * Force cleanup regardless of time since last cleanup
   * Called by interval timer for proactive maintenance
   */
  _forceCleanup() {
    const now = Date.now();
    this.lastCleanup = now;
    let expired = 0;
    
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
        expired++;
      }
    }
    
    if (expired > 0) {
      console.log(`🧹 DocCache: Proactive cleanup removed ${expired} expired entries`);
    }
  }

  /**
   * Generate cache key from content hash + tenant
   * @param {string} contentHash - SHA-256 hash of document content
   * @param {string} tenantId - Tenant identifier (IP hash)
   * @returns {string} Cache key
   */
  getKey(contentHash, tenantId = 'global') {
    return `${tenantId}:${contentHash}`;
  }

  /**
   * Get cached extraction result
   * @param {string} contentHash - Document content hash
   * @param {string} tenantId - Tenant identifier
   * @returns {Object|null} Cached result or null
   */
  get(contentHash, tenantId = 'global') {
    this._maybeCleanup();
    const key = this.getKey(contentHash, tenantId);
    const entry = this.cache.get(key);
    
    if (entry && Date.now() - entry.timestamp < this.ttl) {
      console.log(`📦 DocCache HIT: ${contentHash.slice(0, 8)}...`);
      return entry.result;
    }
    
    if (entry) {
      this.cache.delete(key); // Expired
    }
    return null;
  }

  /**
   * Store extraction result
   * @param {string} contentHash - Document content hash
   * @param {Object} result - Extraction result {text, fileName, fileType, toolsUsed}
   * @param {string} tenantId - Tenant identifier
   */
  set(contentHash, result, tenantId = 'global') {
    this._maybeCleanup();
    const key = this.getKey(contentHash, tenantId);
    
    this.cache.set(key, {
      result,
      timestamp: Date.now()
    });
    
    // Prune if over capacity
    if (this.cache.size > this.maxSize) {
      const deleteCount = Math.floor(this.maxSize * 0.2);
      const keys = Array.from(this.cache.keys()).slice(0, deleteCount);
      keys.forEach(k => this.cache.delete(k));
      console.log(`📦 DocCache: Pruned ${deleteCount} entries`);
    }
    
    console.log(`📦 DocCache SET: ${contentHash.slice(0, 8)}... (${this.cache.size}/${this.maxSize})`);
  }

  /**
   * Periodic cleanup of expired entries
   */
  _maybeCleanup() {
    const now = Date.now();
    if (now - this.lastCleanup < this.cleanupInterval) return;
    
    this.lastCleanup = now;
    let expired = 0;
    
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
        expired++;
      }
    }
    
    if (expired > 0) {
      console.log(`🧹 DocCache: Cleaned ${expired} expired entries`);
    }
  }

  /**
   * Get cache stats for monitoring
   * @returns {Object} {size, maxSize, ttlHours}
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttlHours: this.ttl / (60 * 60 * 1000)
    };
  }

  /**
   * Clear all cached extractions
   */
  clear() {
    const count = this.cache.size;
    this.cache.clear();
    console.log(`🧹 DocCache: Cleared ${count} entries`);
    return count;
  }
}

class DataPackage {
  constructor(tenantId = null) {
    this.id = crypto.randomUUID();
    this.tenantId = tenantId;
    this.createdAt = new Date().toISOString();
    this.stages = {};
    this.currentStage = null;
    this.finalized = false;
  }
  
  /**
   * Write stage output - immutable once written
   * @param {string} stageId - Stage identifier (S-1, S0, S1, etc.)
   * @param {Object} data - Stage output data
   */
  writeStage(stageId, data) {
    if (this.finalized) {
      throw new Error(`DataPackage ${this.id} is finalized - cannot write`);
    }
    
    if (this.stages[stageId]) {
      console.warn(`⚠️ DataPackage: Overwriting stage ${stageId}`);
    }
    
    this.stages[stageId] = {
      stageId,
      timestamp: new Date().toISOString(),
      data: JSON.parse(JSON.stringify(data))
    };
    
    this.currentStage = stageId;
    console.log(`📦 DataPackage [${this.id.slice(0,8)}]: WRITE ${stageId}`);
  }
  
  /**
   * Read stage output - returns deep copy to prevent mutation
   * @param {string} stageId - Stage identifier to read
   * @returns {Object|null} Stage data or null if not found
   */
  readStage(stageId) {
    const stage = this.stages[stageId];
    if (!stage) return null;
    
    console.log(`📦 DataPackage [${this.id.slice(0,8)}]: READ ${stageId}`);
    return JSON.parse(JSON.stringify(stage.data));
  }
  
  /**
   * Get all stage outputs for audit/debugging
   * @returns {Object} All stages with data
   */
  getAllStages() {
    return JSON.parse(JSON.stringify(this.stages));
  }
  
  /**
   * Check if a stage has been written
   * @param {string} stageId - Stage identifier
   * @returns {boolean}
   */
  hasStage(stageId) {
    return !!this.stages[stageId];
  }
  
  /**
   * Finalize package - no more writes allowed
   * Called after personality pass
   */
  finalize() {
    this.finalized = true;
    this.finalizedAt = new Date().toISOString();
    console.log(`📦 DataPackage [${this.id.slice(0,8)}]: FINALIZED`);
  }
  
  /**
   * Get stockContext data specifically (commonly needed)
   * @returns {Object|null} Stock context from preflight stage
   */
  getStockContext() {
    const preflight = this.readStage(STAGE_IDS.PREFLIGHT);
    return preflight?.stockContext || null;
  }
  
  /**
   * Serialize for storage (message metadata)
   * @returns {Object} Serializable representation
   */
  toJSON() {
    return {
      id: this.id,
      tenantId: this.tenantId,
      createdAt: this.createdAt,
      finalizedAt: this.finalizedAt || null,
      currentStage: this.currentStage,
      finalized: this.finalized,
      stages: this.stages
    };
  }
  
  /**
   * Restore from serialized form
   * @param {Object} json - Serialized DataPackage
   * @returns {DataPackage}
   */
  static fromJSON(json) {
    const pkg = new DataPackage(json.tenantId);
    pkg.id = json.id;
    pkg.createdAt = json.createdAt;
    pkg.finalizedAt = json.finalizedAt;
    pkg.currentStage = json.currentStage;
    pkg.finalized = json.finalized;
    pkg.stages = json.stages;
    return pkg;
  }
  
  /**
   * Create summary for φ-window compression
   * Only key facts, no verbose data
   * @returns {Object} Compressed summary
   */
  toCompressedSummary() {
    const summary = {
      id: this.id.slice(0, 8),
      stage: this.currentStage,
      ts: this.createdAt.slice(11, 19)
    };
    
    if (this.hasStage(STAGE_IDS.PREFLIGHT)) {
      const preflight = this.readStage(STAGE_IDS.PREFLIGHT);
      if (preflight.ticker) summary.ticker = preflight.ticker;
      if (preflight.mode) summary.mode = preflight.mode;
    }
    
    if (this.hasStage(STAGE_IDS.AUDIT)) {
      const audit = this.readStage(STAGE_IDS.AUDIT);
      summary.auditPass = audit.passed || false;
    }
    
    return summary;
  }
}

/**
 * Hash tenant identifier for privacy (IP+UserAgent → SHA256 truncated)
 * @param {string} ip - IP address
 * @param {string} userAgent - User agent string (optional)
 * @returns {string} Hashed tenant key
 */
function hashTenantKey(ip, userAgent = '') {
  const data = `${ip}:${userAgent}:nyanbook-salt`;
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/**
 * TenantPackageStore - IP-scoped DataPackage storage
 * Fractal: Tenant → 8 messages → each message's DataPackage
 * Security: Uses hashed keys, auto-expires stale sessions
 */
class TenantPackageStore {
  constructor() {
    this.tenants = new Map();
    this.maxPackagesPerTenant = 8;
    this.sessionTTL = 60 * 60 * 1000; // 1 hour TTL
    this.lastCleanup = Date.now();
    this.cleanupInterval = 5 * 60 * 1000; // Cleanup every 5 minutes
  }
  
  /**
   * Generate secure tenant key from IP and optional User-Agent
   * @param {string} ip - IP address
   * @param {string} userAgent - User agent (optional)
   * @returns {string} Secure hashed key
   */
  getSecureTenantKey(ip, userAgent = '') {
    return hashTenantKey(ip, userAgent);
  }
  
  /**
   * Get or create tenant storage
   * @param {string} tenantId - Hashed tenant key or raw IP (backward compat)
   * @returns {Object} Tenant's storage with packages and metadata
   */
  getTenant(tenantId) {
    this._maybeCleanup();
    
    if (!this.tenants.has(tenantId)) {
      this.tenants.set(tenantId, {
        packages: [],
        createdAt: Date.now(),
        lastActivity: Date.now()
      });
    }
    
    const tenant = this.tenants.get(tenantId);
    tenant.lastActivity = Date.now();
    return tenant.packages;
  }
  
  /**
   * Periodic cleanup of expired sessions
   */
  _maybeCleanup() {
    const now = Date.now();
    if (now - this.lastCleanup < this.cleanupInterval) return;
    
    this.lastCleanup = now;
    let expired = 0;
    
    for (const [key, tenant] of this.tenants) {
      if (now - tenant.lastActivity > this.sessionTTL) {
        this.tenants.delete(key);
        expired++;
      }
    }
    
    if (expired > 0) {
      console.log(`🧹 DataPackage: Cleaned ${expired} expired tenant sessions`);
    }
  }
  
  /**
   * Store DataPackage for tenant (φ-8 window)
   * @param {string} tenantId - Hashed tenant key
   * @param {DataPackage} pkg - Package to store
   */
  storePackage(tenantId, pkg) {
    const packages = this.getTenant(tenantId);
    packages.push(pkg.toJSON());
    
    while (packages.length > this.maxPackagesPerTenant) {
      packages.shift();
    }
    
    const safeId = tenantId.slice(0, 8);
    console.log(`📦 TenantStore [${safeId}...]: Stored package ${pkg.id.slice(0,8)} (${packages.length}/${this.maxPackagesPerTenant})`);
  }
  
  /**
   * Get last N packages for tenant
   * @param {string} tenantId - IP or session ID
   * @param {number} n - Number of packages to retrieve
   * @returns {Array<DataPackage>}
   */
  getRecentPackages(tenantId, n = 8) {
    const packages = this.getTenant(tenantId);
    return packages.slice(-n).map(json => DataPackage.fromJSON(json));
  }
  
  /**
   * Get compressed summaries for context injection
   * @param {string} tenantId - IP or session ID
   * @returns {Array<Object>} Compressed summaries
   */
  getCompressedHistory(tenantId) {
    return this.getRecentPackages(tenantId)
      .map(pkg => pkg.toCompressedSummary());
  }
  
  /**
   * Clear tenant data (for privacy/reset)
   * @param {string} tenantId - IP or session ID
   */
  clearTenant(tenantId) {
    this.tenants.delete(tenantId);
    console.log(`📦 TenantStore: Cleared tenant ${tenantId}`);
  }
  
  /**
   * Get tenant count (monitoring)
   * @returns {number}
   */
  getTenantCount() {
    return this.tenants.size;
  }
  
  /**
   * NUKE: Clear all tenant data for fresh session
   * Called by 🗑️ button - full privacy, full local
   * @param {string} tenantId - IP or session ID
   */
  nukeTenant(tenantId) {
    this.tenants.delete(tenantId);
    console.log(`🗑️ NUKE: Tenant ${tenantId} data cleared - fresh session`);
    return { cleared: true, tenantId };
  }
  
  /**
   * NUKE ALL: Clear entire store (admin use only)
   */
  nukeAll() {
    const count = this.tenants.size;
    this.tenants.clear();
    console.log(`🗑️ NUKE ALL: ${count} tenants cleared`);
    return { cleared: count };
  }
}

const globalPackageStore = new TenantPackageStore();
const globalDocCache = new DocumentExtractionCache();

/**
 * Compute SHA-256 hash of buffer for document caching
 * @param {Buffer} buffer - Document content
 * @returns {string} Hex hash
 */
function computeDocHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = {
  DataPackage,
  TenantPackageStore,
  DocumentExtractionCache,
  globalPackageStore,
  globalDocCache,
  hashTenantKey,
  computeDocHash,
  STAGE_IDS,
  FILE_TYPES
};

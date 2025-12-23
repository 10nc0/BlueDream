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
 * TenantPackageStore - IP-scoped DataPackage storage
 * Fractal: Tenant → 8 messages → each message's DataPackage
 */
class TenantPackageStore {
  constructor() {
    this.tenants = new Map();
    this.maxPackagesPerTenant = 8;
  }
  
  /**
   * Get or create tenant storage
   * @param {string} tenantId - IP or session ID
   * @returns {Array} Tenant's package history
   */
  getTenant(tenantId) {
    if (!this.tenants.has(tenantId)) {
      this.tenants.set(tenantId, []);
    }
    return this.tenants.get(tenantId);
  }
  
  /**
   * Store DataPackage for tenant (φ-8 window)
   * @param {string} tenantId - IP or session ID
   * @param {DataPackage} pkg - Package to store
   */
  storePackage(tenantId, pkg) {
    const packages = this.getTenant(tenantId);
    packages.push(pkg.toJSON());
    
    while (packages.length > this.maxPackagesPerTenant) {
      packages.shift();
    }
    
    console.log(`📦 TenantStore [${tenantId}]: Stored package ${pkg.id.slice(0,8)} (${packages.length}/${this.maxPackagesPerTenant})`);
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
}

const globalPackageStore = new TenantPackageStore();

module.exports = {
  DataPackage,
  TenantPackageStore,
  globalPackageStore,
  STAGE_IDS
};

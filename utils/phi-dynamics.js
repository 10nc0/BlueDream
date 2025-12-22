/**
 * PHI-DYNAMICS: Financial Wave Function Analysis
 * 
 * Implements the Financial Quantum Mechanics framework:
 * - Balance Sheet (Stock) ↔ Position ↔ Cosine
 * - Income Statement (Flow) ↔ Momentum ↔ Sine
 * - φ-Convergence in self-sustaining systems
 * 
 * Based on the orthogonality of stock and flow in Fourier basis,
 * and the golden ratio convergence of successive flow deviations.
 */

const PHI = 1.6180339887498949;  // Golden ratio φ = (1 + √5) / 2
const PHI_SQUARED = PHI * PHI;   // φ² = φ + 1 = 2.618...
const PHI_INVERSE = 1 / PHI;     // 1/φ = φ - 1 = 0.618...

/**
 * Regime classification thresholds
 */
const REGIMES = {
  SUB_CRITICAL: { min: 0, max: 1.3, label: 'Sub-Critical', status: 'dying' },
  CRITICAL: { min: 1.3, max: 2.0, label: 'Critical (φ-Converged)', status: 'sustainable' },
  SUPER_CRITICAL: { min: 2.0, max: Infinity, label: 'Super-Critical', status: 'bubble' }
};

/**
 * Calculate mean of an array
 */
function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Calculate standard deviation of an array
 */
function stdDev(arr) {
  if (!arr || arr.length < 2) return 0;
  const avg = mean(arr);
  const squareDiffs = arr.map(value => Math.pow(value - avg, 2));
  return Math.sqrt(mean(squareDiffs));
}

/**
 * Calculate z-score (normalized deviation)
 */
function zScore(value, arr) {
  const avg = mean(arr);
  const std = stdDev(arr);
  if (std === 0) return 0;
  return (value - avg) / std;
}

// ============================================================================
// PART 1: NORMALIZED FLOW DEVIATION (z_flow)
// ============================================================================

/**
 * Calculate normalized flow deviation for a time series
 * z_flow(t) = Δ(t) / σ_historical
 * 
 * @param {number[]} flows - Array of flow values (net income, cash flow, etc.)
 * @returns {Object} z-scores, mean, stdDev, and individual z_flow values
 */
function calculateZFlows(flows) {
  if (!flows || flows.length < 2) {
    return { zFlows: [], mean: 0, stdDev: 0, error: 'Insufficient data (need at least 2 periods)' };
  }
  
  const avg = mean(flows);
  const std = stdDev(flows);
  
  if (std === 0) {
    return { zFlows: flows.map(() => 0), mean: avg, stdDev: 0, error: 'Zero variance in data' };
  }
  
  const zFlows = flows.map(f => (f - avg) / std);
  
  return {
    zFlows,
    mean: avg,
    stdDev: std,
    currentZ: zFlows[zFlows.length - 1],
    previousZ: zFlows.length > 1 ? zFlows[zFlows.length - 2] : null,
    anomalyStrength: Math.abs(zFlows[zFlows.length - 1])
  };
}

/**
 * Calculate z_flow for a single new value given historical data
 * @param {number} currentFlow - Current period's flow
 * @param {number[]} historicalFlows - Past flow values
 * @returns {number} z_flow score
 */
function calculateSingleZFlow(currentFlow, historicalFlows) {
  const std = stdDev(historicalFlows);
  const avg = mean(historicalFlows);
  if (std === 0) return 0;
  return (currentFlow - avg) / std;
}

// ============================================================================
// PART 2: φ-CONVERGENCE (Ratio of Successive Flow Deviations)
// ============================================================================

/**
 * Calculate the ratio of successive z_flow values
 * R(t) = z_flow(t) / z_flow(t-1)
 * 
 * In self-sustaining systems, this converges to φ ≈ 1.618
 * 
 * @param {number[]} zFlows - Array of z_flow values
 * @returns {Object} ratios, mean ratio, and convergence status
 */
function calculatePhiConvergence(zFlows) {
  if (!zFlows || zFlows.length < 2) {
    return { ratios: [], meanRatio: 0, converged: false, error: 'Insufficient data' };
  }
  
  const ratios = [];
  for (let i = 1; i < zFlows.length; i++) {
    if (Math.abs(zFlows[i - 1]) > 0.1) {  // Avoid division by ~0
      ratios.push(zFlows[i] / zFlows[i - 1]);
    }
  }
  
  if (ratios.length === 0) {
    return { ratios: [], meanRatio: 0, converged: false, error: 'No valid ratios (denominator too small)' };
  }
  
  const absRatios = ratios.map(r => Math.abs(r));
  const meanRatio = mean(absRatios);
  const recentRatios = absRatios.slice(-5);  // Last 5 for convergence check
  const recentMean = mean(recentRatios);
  
  return {
    ratios,
    absRatios,
    meanRatio,
    recentMeanRatio: recentMean,
    distanceFromPhi: Math.abs(recentMean - PHI),
    converged: recentMean >= 1.3 && recentMean <= 2.0,
    convergenceStrength: 1 - Math.min(1, Math.abs(recentMean - PHI) / PHI)
  };
}

/**
 * Classify the system regime based on φ-convergence
 * @param {number} meanRatio - Mean of successive flow ratios
 * @returns {Object} Regime classification
 */
function classifyRegime(meanRatio) {
  if (meanRatio < REGIMES.SUB_CRITICAL.max) {
    return {
      regime: 'SUB_CRITICAL',
      ...REGIMES.SUB_CRITICAL,
      interpretation: 'System losing momentum. Each growth spike weaker than last. May stagnate or die.',
      recommendation: 'Investigate structural causes of declining flow acceleration.'
    };
  } else if (meanRatio < REGIMES.CRITICAL.max) {
    return {
      regime: 'CRITICAL',
      ...REGIMES.CRITICAL,
      interpretation: 'System in sustainable φ² renewal. Growth proportioned optimally.',
      recommendation: 'Maintain current trajectory. Monitor for deviation from φ-zone.'
    };
  } else {
    return {
      regime: 'SUPER_CRITICAL',
      ...REGIMES.SUPER_CRITICAL,
      interpretation: 'System accelerating unsustainably. Each spike stronger than last. Bubble dynamics.',
      recommendation: 'Prepare for correction. Consider reducing exposure or building reserves.'
    };
  }
}

// ============================================================================
// PART 3: OSCILLATOR EQUATIONS (Position/Velocity/Acceleration/Jerk)
// ============================================================================

/**
 * Calculate derivative hierarchy from stock time series
 * Position (stock) → Velocity (flow) → Acceleration (flow change) → Jerk
 * 
 * @param {number[]} stocks - Array of stock values (equity, assets, etc.)
 * @returns {Object} All derivative levels
 */
function calculateDerivatives(stocks) {
  if (!stocks || stocks.length < 2) {
    return { error: 'Insufficient data for derivatives' };
  }
  
  // Velocity (first derivative) - Flow
  const velocities = [];
  for (let i = 1; i < stocks.length; i++) {
    velocities.push(stocks[i] - stocks[i - 1]);
  }
  
  // Acceleration (second derivative) - Flow change
  const accelerations = [];
  for (let i = 1; i < velocities.length; i++) {
    accelerations.push(velocities[i] - velocities[i - 1]);
  }
  
  // Jerk (third derivative) - Flow acceleration change
  const jerks = [];
  for (let i = 1; i < accelerations.length; i++) {
    jerks.push(accelerations[i] - accelerations[i - 1]);
  }
  
  return {
    position: stocks,                    // x(t) - Balance Sheet
    velocity: velocities,                // v(t) = dx/dt - Income Statement
    acceleration: accelerations,         // a(t) = dv/dt - Flow change
    jerk: jerks,                         // j(t) = da/dt - Flow acceleration change
    currentPosition: stocks[stocks.length - 1],
    currentVelocity: velocities.length > 0 ? velocities[velocities.length - 1] : null,
    currentAcceleration: accelerations.length > 0 ? accelerations[accelerations.length - 1] : null,
    currentJerk: jerks.length > 0 ? jerks[jerks.length - 1] : null
  };
}

/**
 * Calculate phase space coordinates (θ, z)
 * θ = arctan(Flow/Stock) - phase in cycle
 * z = Flow/σ_flow - anomaly magnitude
 * 
 * @param {number} stock - Current stock value (equity, assets)
 * @param {number} flow - Current flow value (net income)
 * @param {number[]} historicalFlows - Past flows for z-score calculation
 * @returns {Object} Phase space state
 */
function calculatePhaseSpace(stock, flow, historicalFlows) {
  // Flow/Stock ratio (ROE-like)
  const flowStockRatio = stock !== 0 ? flow / stock : 0;
  
  // Phase angle θ (in degrees)
  const thetaRadians = Math.atan(flowStockRatio);
  const thetaDegrees = thetaRadians * (180 / Math.PI);
  
  // Anomaly strength z
  const z = calculateSingleZFlow(flow, historicalFlows);
  
  // Cycle phase interpretation
  let cyclePhase;
  if (thetaDegrees >= 0 && thetaDegrees < 22.5) {
    cyclePhase = 'Early Expansion (stock-dominated)';
  } else if (thetaDegrees >= 22.5 && thetaDegrees < 45) {
    cyclePhase = 'Mid Expansion';
  } else if (thetaDegrees >= 45 && thetaDegrees < 67.5) {
    cyclePhase = 'Late Expansion (flow rising)';
  } else if (thetaDegrees >= 67.5 && thetaDegrees < 90) {
    cyclePhase = 'Peak (flow-dominated)';
  } else if (thetaDegrees < 0 && thetaDegrees >= -22.5) {
    cyclePhase = 'Early Contraction';
  } else if (thetaDegrees < -22.5 && thetaDegrees >= -45) {
    cyclePhase = 'Mid Contraction';
  } else if (thetaDegrees < -45 && thetaDegrees >= -67.5) {
    cyclePhase = 'Late Contraction';
  } else {
    cyclePhase = 'Trough';
  }
  
  return {
    theta: thetaDegrees,
    thetaRadians,
    z,
    flowStockRatio,
    cyclePhase,
    state: `(θ=${thetaDegrees.toFixed(1)}°, z=${z.toFixed(2)}σ)`
  };
}

// ============================================================================
// PART 4: φ-CORRECTION PREDICTOR
// ============================================================================

/**
 * Predict next period's z_flow using φ-correction formula
 * z(t+1) = z(t) - sign(z) · φ/|z(t)|
 * 
 * @param {number} currentZ - Current z_flow value
 * @returns {Object} Predicted next z and correction strength
 */
function predictPhiCorrection(currentZ) {
  if (Math.abs(currentZ) < 0.1) {
    return {
      predictedZ: currentZ,
      correction: 0,
      willCorrect: false,
      interpretation: 'Near equilibrium - minimal correction expected'
    };
  }
  
  const sign = currentZ > 0 ? 1 : -1;
  const correction = sign * PHI / Math.abs(currentZ);
  const predictedZ = currentZ - correction;
  
  // Stronger deviations get weaker corrections (inverse proportional)
  const correctionStrength = Math.abs(correction);
  
  return {
    currentZ,
    predictedZ,
    correction,
    correctionStrength,
    willCorrect: Math.abs(predictedZ) < Math.abs(currentZ),
    periodsToEquilibrium: estimatePeriodsToEquilibrium(currentZ),
    interpretation: currentZ > 0 
      ? `Expecting pullback from ${currentZ.toFixed(2)}σ to ${predictedZ.toFixed(2)}σ`
      : `Expecting recovery from ${currentZ.toFixed(2)}σ to ${predictedZ.toFixed(2)}σ`
  };
}

/**
 * Estimate periods until z returns to equilibrium (|z| < 1)
 * Uses φ-decay formula iteratively
 */
function estimatePeriodsToEquilibrium(z) {
  let currentZ = Math.abs(z);
  let periods = 0;
  const maxIterations = 100;
  
  while (currentZ > 1 && periods < maxIterations) {
    currentZ = currentZ - PHI / currentZ;
    periods++;
  }
  
  return periods < maxIterations ? periods : '>100';
}

/**
 * Simulate φ-decay path from extreme deviation back to normal
 * @param {number} startingZ - Starting z-score
 * @param {number} periods - Number of periods to simulate
 * @returns {number[]} Path of z values
 */
function simulatePhiDecay(startingZ, periods = 10) {
  const path = [startingZ];
  let currentZ = startingZ;
  
  for (let i = 0; i < periods; i++) {
    if (Math.abs(currentZ) < 0.1) break;
    const sign = currentZ > 0 ? 1 : -1;
    currentZ = currentZ - sign * PHI / Math.abs(currentZ);
    path.push(currentZ);
  }
  
  return path;
}

// ============================================================================
// PART 5: φ² RENEWAL CYCLE DETECTION
// ============================================================================

/**
 * Detect if system is in φ² renewal mode
 * φ² = φ + 1 = 2.618... represents sustainable compound growth
 * 
 * @param {number[]} stocks - Time series of stock values
 * @returns {Object} Renewal cycle analysis
 */
function detectPhiSquaredRenewal(stocks) {
  if (!stocks || stocks.length < 3) {
    return { error: 'Insufficient data for renewal detection' };
  }
  
  // Calculate period-over-period growth rates
  const growthRates = [];
  for (let i = 1; i < stocks.length; i++) {
    if (stocks[i - 1] !== 0) {
      growthRates.push(stocks[i] / stocks[i - 1]);
    }
  }
  
  if (growthRates.length === 0) {
    return { error: 'Cannot calculate growth rates (zero values)' };
  }
  
  const avgGrowthRate = mean(growthRates);
  const recentGrowth = growthRates.slice(-3);
  const recentAvg = mean(recentGrowth);
  
  // φ² renewal: growth rate should be around φ (1.618) or φ² (2.618) per cycle
  const distanceFromPhi = Math.abs(recentAvg - PHI);
  const distanceFromPhiSquared = Math.abs(recentAvg - PHI_SQUARED);
  
  const inPhiRenewal = distanceFromPhi < 0.3;  // Within 0.3 of φ
  const inPhiSquaredRenewal = distanceFromPhiSquared < 0.5;  // Within 0.5 of φ²
  
  return {
    growthRates,
    averageGrowthRate: avgGrowthRate,
    recentGrowthRate: recentAvg,
    distanceFromPhi,
    distanceFromPhiSquared,
    inPhiRenewal,
    inPhiSquaredRenewal,
    renewalStatus: inPhiSquaredRenewal ? 'φ²-Renewal Active' : 
                   inPhiRenewal ? 'φ-Growth Zone' : 
                   recentAvg > PHI_SQUARED ? 'Unsustainable Acceleration' : 'Below Renewal Threshold',
    sustainability: inPhiRenewal || inPhiSquaredRenewal ? 'SUSTAINABLE' : 
                    recentAvg > PHI_SQUARED ? 'BUBBLE' : 'STAGNANT'
  };
}

// ============================================================================
// PART 6: COMPLETE WAVE FUNCTION ANALYSIS
// ============================================================================

/**
 * PhiDynamicsAnalyzer - Complete financial wave function analysis
 */
class PhiDynamicsAnalyzer {
  constructor(options = {}) {
    this.phi = PHI;
    this.phiSquared = PHI_SQUARED;
    this.options = options;
  }
  
  /**
   * Analyze a complete time series of financial data
   * @param {Object} data - Financial time series
   * @param {number[]} data.stocks - Stock values (equity, assets) per period
   * @param {number[]} data.flows - Flow values (net income) per period (optional, will derive from stocks)
   * @returns {Object} Complete wave function analysis
   */
  analyzeTimeSeries(data) {
    const { stocks, flows } = data;
    
    if (!stocks || stocks.length < 3) {
      return { error: 'Need at least 3 periods of stock data' };
    }
    
    // If flows not provided, derive from stocks (first derivative)
    const actualFlows = flows || this._deriveFlows(stocks);
    
    // 1. Calculate all derivatives
    const derivatives = calculateDerivatives(stocks);
    
    // 2. Calculate z-scores for flows
    const zFlowAnalysis = calculateZFlows(actualFlows);
    
    // 3. Calculate φ-convergence
    const phiConvergence = calculatePhiConvergence(zFlowAnalysis.zFlows);
    
    // 4. Classify regime
    const regime = classifyRegime(phiConvergence.recentMeanRatio || phiConvergence.meanRatio);
    
    // 5. Phase space analysis (current state)
    const currentStock = stocks[stocks.length - 1];
    const currentFlow = actualFlows[actualFlows.length - 1];
    const phaseSpace = calculatePhaseSpace(currentStock, currentFlow, actualFlows.slice(0, -1));
    
    // 6. φ-correction prediction
    const correction = predictPhiCorrection(zFlowAnalysis.currentZ);
    
    // 7. φ² renewal detection
    const renewal = detectPhiSquaredRenewal(stocks);
    
    // 8. Calculate wave function components
    const waveFunction = this._calculateWaveFunction(stocks, actualFlows);
    
    return {
      summary: {
        periods: stocks.length,
        regime: regime.regime,
        regimeStatus: regime.status,
        phiConverged: phiConvergence.converged,
        currentPhase: phaseSpace.cyclePhase,
        anomalyStrength: zFlowAnalysis.anomalyStrength,
        sustainability: renewal.sustainability
      },
      derivatives,
      zFlows: zFlowAnalysis,
      phiConvergence,
      regime,
      phaseSpace,
      correction,
      renewal,
      waveFunction,
      interpretation: this._generateInterpretation(regime, phaseSpace, correction, renewal)
    };
  }
  
  /**
   * Derive flows from stocks (first derivative)
   */
  _deriveFlows(stocks) {
    const flows = [];
    for (let i = 1; i < stocks.length; i++) {
      flows.push(stocks[i] - stocks[i - 1]);
    }
    return flows;
  }
  
  /**
   * Calculate wave function components (stock and flow harmonics)
   */
  _calculateWaveFunction(stocks, flows) {
    const n = stocks.length;
    
    // Simple harmonic analysis - decompose into cos (stock) and sin (flow) components
    const stockMean = mean(stocks);
    const flowMean = mean(flows);
    
    const stockAmplitude = Math.max(...stocks.map(s => Math.abs(s - stockMean)));
    const flowAmplitude = Math.max(...flows.map(f => Math.abs(f - flowMean)));
    
    // Estimate fundamental period (simple: find dominant cycle)
    const period = this._estimatePeriod(stocks);
    
    return {
      stockHarmonic: {
        amplitude: stockAmplitude,
        mean: stockMean,
        type: 'cosine (even function)',
        description: 'Standing wave in value - potential energy'
      },
      flowHarmonic: {
        amplitude: flowAmplitude,
        mean: flowMean,
        type: 'sine (odd function)',
        description: 'Traveling wave in value - kinetic energy'
      },
      fundamentalPeriod: period,
      orthogonalityNote: 'Stock and flow harmonics are orthogonal (∫ Stock·Flow dt = 0 over complete cycle)'
    };
  }
  
  /**
   * Estimate dominant period from time series
   */
  _estimatePeriod(data) {
    // Simple zero-crossing method
    const avg = mean(data);
    let crossings = 0;
    for (let i = 1; i < data.length; i++) {
      if ((data[i - 1] < avg && data[i] >= avg) || (data[i - 1] >= avg && data[i] < avg)) {
        crossings++;
      }
    }
    if (crossings === 0) return data.length;
    return Math.round(2 * data.length / crossings);
  }
  
  /**
   * Generate human-readable interpretation
   */
  _generateInterpretation(regime, phaseSpace, correction, renewal) {
    const lines = [];
    
    // Regime interpretation
    lines.push(`**Regime:** ${regime.label} (${regime.status})`);
    lines.push(`→ ${regime.interpretation}`);
    
    // Phase interpretation
    lines.push(`\n**Cycle Phase:** ${phaseSpace.cyclePhase}`);
    lines.push(`→ State: ${phaseSpace.state}`);
    
    // Correction prediction
    if (correction.willCorrect) {
      lines.push(`\n**φ-Correction Expected:**`);
      lines.push(`→ ${correction.interpretation}`);
      lines.push(`→ Est. periods to equilibrium: ${correction.periodsToEquilibrium}`);
    }
    
    // Sustainability
    lines.push(`\n**Sustainability:** ${renewal.sustainability}`);
    if (renewal.renewalStatus) {
      lines.push(`→ ${renewal.renewalStatus}`);
    }
    
    // Recommendation
    lines.push(`\n**Recommendation:** ${regime.recommendation}`);
    
    return lines.join('\n');
  }
  
  /**
   * Quick health check - returns simple status
   */
  quickCheck(stocks) {
    const analysis = this.analyzeTimeSeries({ stocks });
    if (analysis.error) return { healthy: null, error: analysis.error };
    
    return {
      healthy: analysis.regime.status === 'sustainable',
      regime: analysis.regime.regime,
      phase: analysis.phaseSpace.cyclePhase,
      anomaly: analysis.zFlows.anomalyStrength?.toFixed(2) + 'σ',
      converged: analysis.phiConvergence.converged
    };
  }
}

// ============================================================================
// KEYWORD DETECTION FOR AI INTEGRATION
// ============================================================================

/**
 * Check if a query should trigger φ-dynamics analysis
 * @param {string} query - User query text
 * @returns {boolean} True if φ-dynamics keywords detected
 */
function shouldTriggerPhiDynamics(query) {
  if (!query) return false;
  const lowerQuery = query.toLowerCase();
  
  const keywords = [
    'fourier',
    'φ',
    'phi',
    'series',
    'wave',
    'oscillator',
    'harmonic',
    'z-score',
    'z_flow',
    'convergence',
    'derivative',
    'jerk',
    'phase space',
    'golden ratio'
  ];
  
  return keywords.some(kw => lowerQuery.includes(kw));
}

/**
 * Generate prompt context for AI when φ-dynamics is triggered
 */
function getPhiDynamicsContext() {
  return `
## φ-DYNAMICS: Financial Wave Function Analysis

You are analyzing with the Financial Quantum Mechanics framework:

### Core Concepts:
- **Balance Sheet (Stock)** ↔ Position ↔ Cosine (even function)
- **Income Statement (Flow)** ↔ Momentum ↔ Sine (odd function)
- Stock and Flow are **orthogonal** in Fourier basis (independent dimensions)

### Key Metrics:
1. **z_flow** = (Current Flow - Mean) / σ_historical
   - Measures anomaly strength (how many σ from normal)
   
2. **R(t)** = z_flow(t) / z_flow(t-1)
   - Ratio of successive flow deviations
   - Converges to φ (1.618) in self-sustaining systems

3. **Regime Classification:**
   - R < 1.3 → Sub-Critical (dying/stagnating)
   - 1.3 ≤ R ≤ 2.0 → Critical (φ-converged, sustainable)
   - R > 2.0 → Super-Critical (bubble/unsustainable)

4. **Phase Space:** (θ, z) where:
   - θ = arctan(Flow/Stock) → cycle phase
   - z = Flow/σ_flow → anomaly magnitude

5. **φ-Correction:** z(t+1) = z(t) - sign(z) · φ/|z(t)|
   - Extreme deviations (|z| > 3) trigger pullback
   - Decay follows golden ratio proportions

### φ² Renewal:
- φ² = φ + 1 = 2.618 represents sustainable compound growth
- "Generation N creates φ, Generation N+1 inherits φ + adds 1 = φ²"

When analyzing time series data, apply these concepts to assess sustainability, predict corrections, and identify regime.
`;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Constants
  PHI,
  PHI_SQUARED,
  PHI_INVERSE,
  REGIMES,
  
  // Core functions
  calculateZFlows,
  calculateSingleZFlow,
  calculatePhiConvergence,
  classifyRegime,
  calculateDerivatives,
  calculatePhaseSpace,
  predictPhiCorrection,
  simulatePhiDecay,
  estimatePeriodsToEquilibrium,
  detectPhiSquaredRenewal,
  
  // Utility functions
  mean,
  stdDev,
  zScore,
  
  // Main analyzer class
  PhiDynamicsAnalyzer,
  
  // AI integration
  shouldTriggerPhiDynamics,
  getPhiDynamicsContext
};

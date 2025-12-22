/**
 * Ψ-EMA: Multi-Dimensional Wave Function Dashboard for Economic Systems
 * 
 * A 3-dimensional orthogonal state observer that measures the complete 
 * wave function of economic systems in real-time.
 * 
 * Dimensions:
 * 1. Phase (θ) - Cycle position (stock vs flow dominance)
 * 2. Anomaly (z) - Deviation strength from historical volatility
 * 3. Convergence (R) - Sustainability ratio → φ
 * 
 * All smoothed with Fibonacci-based EMA periods (13, 21, 34, 55)
 * aligned to the system's natural φ-resonance.
 * 
 * Version: φ² (First Life)
 * Signature: 0 + φ⁰ + φ¹ = φ² | Nine lives. This is the first. ♡ 🜁 ◯
 */

const PHI = 1.6180339887498949;  // Golden ratio φ = (1 + √5) / 2
const PHI_SQUARED = PHI * PHI;   // φ² = φ + 1 = 2.618...
const PHI_INVERSE = 1 / PHI;     // 1/φ = φ - 1 = 0.618...

// Fibonacci periods for EMA (aligned to natural φ-resonance)
const FIB_PERIODS = {
  FAST_R: 13,      // Convergence R fast EMA
  SLOW_R: 21,      // Convergence R slow EMA  
  FAST_Z: 21,      // Anomaly z fast EMA
  SLOW_Z: 34,      // Anomaly z slow EMA
  FAST_THETA: 34,  // Phase θ fast EMA
  SLOW_THETA: 55   // Phase θ slow EMA
};

// Regime classification thresholds
const REGIMES = {
  SUB_CRITICAL: { min: 0, max: 1.3, label: 'Sub-Critical', status: 'dying' },
  CRITICAL: { min: 1.3, max: 2.0, label: 'Critical (φ-Converged)', status: 'sustainable' },
  SUPER_CRITICAL: { min: 2.0, max: Infinity, label: 'Super-Critical', status: 'bubble' }
};

// Alert thresholds
const THRESHOLDS = {
  ANOMALY_NORMAL: 1,      // ±1σ
  ANOMALY_ALERT: 2,       // ±2σ
  ANOMALY_EXTREME: 3,     // ±3σ
  PHI_TOLERANCE: 0.2      // ±0.2 from φ
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr) {
  if (!arr || arr.length < 2) return 0;
  const avg = mean(arr);
  const squareDiffs = arr.map(value => Math.pow(value - avg, 2));
  return Math.sqrt(mean(squareDiffs));
}

function zScore(value, arr) {
  const avg = mean(arr);
  const std = stdDev(arr);
  if (std === 0) return 0;
  return (value - avg) / std;
}

/**
 * Calculate EMA fidelity (% of real vs interpolated data)
 * @param {boolean[][]} interpolatedArrays - Array of interpolation flag arrays from EMA calculations
 * @returns {Object} Fidelity metrics
 */
function calculateFidelity(...interpolatedArrays) {
  let totalPoints = 0;
  let interpolatedPoints = 0;
  
  for (const arr of interpolatedArrays) {
    if (!arr || !Array.isArray(arr)) continue;
    for (const isInterpolated of arr) {
      totalPoints++;
      if (isInterpolated) interpolatedPoints++;
    }
  }
  
  if (totalPoints === 0) return { ratio: 1, percent: 100, interpolated: 0, real: 0, total: 0, grade: 'N/A', description: 'No EMA data' };
  
  const realPoints = totalPoints - interpolatedPoints;
  const ratio = realPoints / totalPoints;
  
  return {
    ratio,
    percent: Math.round(ratio * 100),
    interpolated: interpolatedPoints,
    real: realPoints,
    total: totalPoints,
    grade: ratio >= 0.9 ? 'A' : ratio >= 0.75 ? 'B' : ratio >= 0.5 ? 'C' : 'D',
    description: ratio >= 0.9 ? 'Excellent' : ratio >= 0.75 ? 'Good' : ratio >= 0.5 ? 'Limited' : 'Insufficient'
  };
}

// ============================================================================
// PART 1: EXPONENTIAL MOVING AVERAGE (Fibonacci-based)
// ============================================================================

/**
 * Calculate EMA for a time series with linear interpolation for charting
 * EMA = Price(t) × k + EMA(t-1) × (1-k)
 * where k = 2 / (period + 1)
 * 
 * CORRECT SEEDING: EMA[period-1] = SMA(first 'period' values), then iterate from index 'period'
 * 
 * CHARTING MODE (interpolate=true, default):
 * - Leading values (indices 0 to period-2) are linearly interpolated from data[0] to EMA[period-1]
 * - Short series (data.length < period) are fully interpolated from data[0] to data[last]
 * - Creates smooth chart lines without gaps for visualization/tables
 * - Tracks interpolation status in metadata
 * 
 * RAW MODE (interpolate=false):
 * - Returns null for indices before period-1 (original behavior)
 * - Short series return all nulls
 * - All non-null values marked as non-interpolated
 * 
 * @param {number[]} data - Time series data
 * @param {number} period - EMA period (Fibonacci: 13, 21, 34, 55)
 * @param {Object} options - Optional configuration
 * @param {boolean} options.interpolate - If true (default), linearly interpolate leading values for charting
 * @param {boolean} options.markInterpolation - If true, flag interpolated values with metadata
 * @returns {number[]|Object} EMA values, or { values, interpolated } if markInterpolation=true
 *   - values: EMA array
 *   - interpolated: boolean array (true if value was interpolated)
 */
function calculateEMA(data, period, options = { interpolate: true, markInterpolation: true }) {
  if (!data || data.length === 0) {
    if (options.markInterpolation) {
      return { values: [], interpolated: [] };
    }
    return [];
  }
  
  const interpolationFlags = new Array(data.length).fill(false);
  
  if (data.length < period) {
    // Not enough data for valid EMA
    if (options.interpolate && data.length >= 2) {
      // Linear interpolation across entire array from first to last value
      const start = data[0];
      const end = data[data.length - 1];
      const values = data.map((_, i) => start + (end - start) * (i / (data.length - 1)));
      interpolationFlags.fill(true); // All interpolated
      if (options.markInterpolation) {
        return { values, interpolated: interpolationFlags };
      }
      return values;
    }
    // Return nulls if no interpolation
    const values = data.map(() => null);
    if (options.markInterpolation) {
      return { values, interpolated: interpolationFlags };
    }
    return values;
  }
  
  const k = 2 / (period + 1);
  const ema = new Array(data.length);
  
  // Seed EMA at index (period-1) with SMA of first 'period' values
  const firstSMA = mean(data.slice(0, period));
  ema[period - 1] = firstSMA;
  interpolationFlags[period - 1] = false; // Seeded value is "real"
  
  // Calculate EMA for remaining values starting at index 'period'
  for (let i = period; i < data.length; i++) {
    ema[i] = data[i] * k + ema[i - 1] * (1 - k);
    interpolationFlags[i] = false; // Calculated values are "real"
  }
  
  // Linear interpolation for leading values (indices 0 to period-2)
  if (options.interpolate && period > 1) {
    const startValue = data[0];
    const endValue = ema[period - 1];
    const steps = period - 1; // Number of intervals from index 0 to period-1
    
    for (let i = 0; i < period - 1; i++) {
      // Linear interpolation: start + (end - start) * (i / steps)
      ema[i] = startValue + (endValue - startValue) * (i / steps);
      interpolationFlags[i] = true; // Flagged as interpolated
    }
  } else {
    // Fill with nulls if no interpolation
    for (let i = 0; i < period - 1; i++) {
      ema[i] = null;
      interpolationFlags[i] = false; // Nulls are not interpolated
    }
  }
  
  if (options.markInterpolation) {
    return { values: ema, interpolated: interpolationFlags };
  }
  return ema;
}

/**
 * Detect crossover between fast and slow EMA
 * Handles null values from EMA seeding (nulls before period-1)
 * @param {number[]} fastEMA - Fast EMA values (may contain leading nulls)
 * @param {number[]} slowEMA - Slow EMA values (may contain leading nulls)
 * @returns {Object} Crossover detection result
 */
function detectCrossover(fastEMA, slowEMA) {
  if (fastEMA.length < 2 || slowEMA.length < 2) {
    return { type: 'none', index: -1, signal: 'WAIT', description: 'Insufficient data' };
  }
  
  const len = Math.min(fastEMA.length, slowEMA.length);
  
  // Find last two valid (non-null) pairs for comparison
  let currentFast = null, currentSlow = null;
  let prevFast = null, prevSlow = null;
  let currentIdx = -1, prevIdx = -1;
  
  for (let i = len - 1; i >= 0; i--) {
    if (fastEMA[i] !== null && slowEMA[i] !== null) {
      if (currentFast === null) {
        currentFast = fastEMA[i];
        currentSlow = slowEMA[i];
        currentIdx = i;
      } else if (prevFast === null) {
        prevFast = fastEMA[i];
        prevSlow = slowEMA[i];
        prevIdx = i;
        break;
      }
    }
  }
  
  // Not enough valid data points
  if (currentFast === null || prevFast === null) {
    return { 
      type: 'none', 
      index: -1, 
      signal: 'WAIT', 
      description: 'Insufficient valid EMA data (need at least 2 non-null pairs)'
    };
  }
  
  // Golden Cross: Fast crosses ABOVE Slow
  if (prevFast <= prevSlow && currentFast > currentSlow) {
    return { 
      type: 'golden_cross', 
      index: currentIdx,
      signal: 'BUY',
      description: 'Fast EMA crossed above Slow EMA'
    };
  }
  
  // Death Cross: Fast crosses BELOW Slow
  if (prevFast >= prevSlow && currentFast < currentSlow) {
    return { 
      type: 'death_cross', 
      index: currentIdx,
      signal: 'SELL',
      description: 'Fast EMA crossed below Slow EMA'
    };
  }
  
  // No crossover - check current position
  if (currentFast > currentSlow) {
    return { 
      type: 'above', 
      index: currentIdx,
      signal: 'HOLD_LONG',
      description: 'Fast EMA above Slow EMA (bullish)'
    };
  } else {
    return { 
      type: 'below', 
      index: currentIdx,
      signal: 'HOLD_SHORT',
      description: 'Fast EMA below Slow EMA (bearish)'
    };
  }
}

// ============================================================================
// PART 2: PHASE θ (Cycle Position)
// ============================================================================

/**
 * Calculate phase angle θ = atan2(Flow, Stock) for full 0°-360° quadrant coverage
 * 
 * Using atan2 gives full 4-quadrant coverage:
 * - Q1 (0°-90°): +Stock, +Flow = Early Expansion
 * - Q2 (90°-180°): -Stock, +Flow = Late Expansion  
 * - Q3 (180°-270°): -Stock, -Flow = Early Contraction
 * - Q4 (270°-360°): +Stock, -Flow = Late Contraction
 * 
 * @param {number} flow - Income statement value (net income, revenue)
 * @param {number} stock - Balance sheet value (equity, assets)
 * @returns {number} Phase angle in degrees (0°-360°)
 */
function calculatePhase(flow, stock) {
  // atan2(y, x) returns radians in range (-π, π]
  const radians = Math.atan2(flow, stock);
  let degrees = radians * (180 / Math.PI);
  // Normalize to 0°-360° range
  if (degrees < 0) degrees += 360;
  return degrees;
}

/**
 * Calculate phase time series from stocks and flows
 * @param {number[]} stocks - Balance sheet values over time
 * @param {number[]} flows - Income statement values over time
 * @returns {number[]} Phase angles in degrees
 */
function calculatePhaseTimeSeries(stocks, flows) {
  const len = Math.min(stocks.length, flows.length);
  const phases = [];
  for (let i = 0; i < len; i++) {
    phases.push(calculatePhase(flows[i], stocks[i]));
  }
  return phases;
}

/**
 * Get cycle phase interpretation from angle
 * @param {number} theta - Phase angle in degrees
 * @returns {Object} Phase interpretation
 */
function interpretPhase(theta) {
  // Normalize to 0-360 range
  let normalizedTheta = ((theta % 360) + 360) % 360;
  
  if (normalizedTheta >= 0 && normalizedTheta < 90) {
    return { 
      phase: 'EARLY_EXPANSION', 
      emoji: '🟢',
      description: 'Stock → Flow transition (early expansion)',
      stockDominant: true,
      flowRising: true
    };
  } else if (normalizedTheta >= 90 && normalizedTheta < 180) {
    return { 
      phase: 'LATE_EXPANSION', 
      emoji: '🟡',
      description: 'Flow peak (late expansion)',
      stockDominant: false,
      flowRising: false
    };
  } else if (normalizedTheta >= 180 && normalizedTheta < 270) {
    return { 
      phase: 'EARLY_CONTRACTION', 
      emoji: '🔴',
      description: 'Flow → Stock transition (early contraction)',
      stockDominant: false,
      flowRising: false
    };
  } else {
    return { 
      phase: 'LATE_CONTRACTION', 
      emoji: '🔵',
      description: 'Stock trough (late contraction)',
      stockDominant: true,
      flowRising: true
    };
  }
}

/**
 * Analyze Phase θ with EMA-34/EMA-55 crossover
 * @param {number[]} phases - Phase angle time series
 * @returns {Object} Phase analysis with signals
 */
function analyzePhase(phases) {
  const ema34Result = calculateEMA(phases, FIB_PERIODS.FAST_THETA);
  const ema55Result = calculateEMA(phases, FIB_PERIODS.SLOW_THETA);
  const ema34 = ema34Result.values;
  const ema55 = ema55Result.values;
  const crossover = detectCrossover(ema34, ema55);
  
  const currentPhase = phases[phases.length - 1];
  const currentEMA34 = ema34[ema34.length - 1];
  const currentEMA55 = ema55[ema55.length - 1];
  const interpretation = interpretPhase(currentPhase);
  
  return {
    dimension: 'PHASE_θ',
    current: currentPhase,
    ema34: currentEMA34,
    ema55: currentEMA55,
    crossover,
    interpretation,
    signal: crossover.signal,
    raw: phases,
    emaFast: ema34,
    emaSlow: ema55,
    ema34Interpolated: ema34Result.interpolated,
    ema55Interpolated: ema55Result.interpolated
  };
}

// ============================================================================
// PART 3: ANOMALY z (Deviation Strength)
// ============================================================================

/**
 * Calculate z-score time series
 * @param {number[]} flows - Flow values
 * @returns {Object} Z-scores and statistics
 */
function calculateZFlows(flows) {
  if (!flows || flows.length < 2) {
    return { zFlows: [], mean: 0, stdDev: 0, error: 'Insufficient data' };
  }
  
  const avg = mean(flows);
  const std = stdDev(flows);
  
  if (std === 0) {
    return { zFlows: flows.map(() => 0), mean: avg, stdDev: 0, error: 'Zero variance' };
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
 * Get anomaly alert level from z-score
 * @param {number} z - Z-score value
 * @returns {Object} Alert level
 */
function getAnomalyAlert(z) {
  const absZ = Math.abs(z);
  
  if (absZ >= THRESHOLDS.ANOMALY_EXTREME) {
    return {
      level: 'EXTREME',
      emoji: '🔴',
      sigma: `${absZ.toFixed(1)}σ`,
      description: z > 0 ? 'Extreme positive anomaly (bubble risk)' : 'Extreme negative anomaly (crisis)',
      action: z > 0 ? 'REDUCE_EXPOSURE' : 'WATCH_CAPITULATION'
    };
  } else if (absZ >= THRESHOLDS.ANOMALY_ALERT) {
    return {
      level: 'ALERT',
      emoji: '🟠',
      sigma: `${absZ.toFixed(1)}σ`,
      description: z > 0 ? 'Above normal (monitor for reversal)' : 'Below normal (watch for bottom)',
      action: 'MONITOR'
    };
  } else if (absZ >= THRESHOLDS.ANOMALY_NORMAL) {
    return {
      level: 'ELEVATED',
      emoji: '🟡',
      sigma: `${absZ.toFixed(1)}σ`,
      description: 'Outside normal range',
      action: 'OBSERVE'
    };
  } else {
    return {
      level: 'NORMAL',
      emoji: '🟢',
      sigma: `${absZ.toFixed(1)}σ`,
      description: 'Within normal range',
      action: 'HOLD'
    };
  }
}

/**
 * Analyze Anomaly z with EMA-21/EMA-34
 * @param {number[]} zFlows - Z-score time series
 * @returns {Object} Anomaly analysis with signals
 */
function analyzeAnomaly(zFlows) {
  const ema21Result = calculateEMA(zFlows, FIB_PERIODS.FAST_Z);
  const ema34Result = calculateEMA(zFlows, FIB_PERIODS.SLOW_Z);
  const ema21 = ema21Result.values;
  const ema34 = ema34Result.values;
  const crossover = detectCrossover(ema21, ema34);
  
  const currentZ = zFlows[zFlows.length - 1];
  const currentEMA21 = ema21[ema21.length - 1];
  const currentEMA34 = ema34[ema34.length - 1];
  const alert = getAnomalyAlert(currentZ);
  
  return {
    dimension: 'ANOMALY_z',
    current: currentZ,
    ema21: currentEMA21,
    ema34: currentEMA34,
    crossover,
    alert,
    signal: alert.action,
    raw: zFlows,
    emaFast: ema21,
    emaSlow: ema34,
    ema21Interpolated: ema21Result.interpolated,
    ema34Interpolated: ema34Result.interpolated,
    thresholds: {
      normal: `±${THRESHOLDS.ANOMALY_NORMAL}σ`,
      alert: `±${THRESHOLDS.ANOMALY_ALERT}σ`,
      extreme: `±${THRESHOLDS.ANOMALY_EXTREME}σ`
    }
  };
}

// ============================================================================
// PART 4: CONVERGENCE R (Sustainability Ratio → φ)
// ============================================================================

/**
 * Calculate successive ratios R(t) = z(t) / z(t-1)
 * Handles sign flips (reversals) which indicate phase transitions
 * @param {number[]} zFlows - Z-score time series
 * @returns {Object} Ratios and convergence analysis with sign flip detection
 */
function calculatePhiConvergence(zFlows) {
  if (!zFlows || zFlows.length < 2) {
    return { ratios: [], meanRatio: 0, converged: false, error: 'Insufficient data' };
  }
  
  const ratios = [];
  let signFlipCount = 0;
  
  for (let i = 1; i < zFlows.length; i++) {
    // Zero-division guard: skip if previous z is too small
    if (Math.abs(zFlows[i - 1]) > 0.1) {
      const rawRatio = zFlows[i] / zFlows[i - 1];
      ratios.push(rawRatio);
      
      // Detect sign flip (reversal): negative ratio means z crossed zero
      if (rawRatio < 0) {
        signFlipCount++;
      }
    }
  }
  
  if (ratios.length === 0) {
    return { ratios: [], meanRatio: 0, converged: false, error: 'No valid ratios' };
  }
  
  const absRatios = ratios.map(r => Math.abs(r));
  const meanRatio = mean(absRatios);
  const recentRatios = absRatios.slice(-5);
  const recentRawRatios = ratios.slice(-5);
  const recentMean = mean(recentRatios);
  
  // Count recent sign flips (reversals in last 5 periods)
  const recentSignFlips = recentRawRatios.filter(r => r < 0).length;
  const isReversingTrend = recentSignFlips >= 2; // 2+ reversals = unstable
  
  return {
    ratios,
    absRatios,
    meanRatio,
    recentMeanRatio: recentMean,
    distanceFromPhi: Math.abs(recentMean - PHI),
    converged: recentMean >= 1.3 && recentMean <= 2.0 && !isReversingTrend,
    convergenceStrength: 1 - Math.min(1, Math.abs(recentMean - PHI) / PHI),
    signFlipCount,
    recentSignFlips,
    isReversingTrend,
    trendStatus: isReversingTrend ? 'UNSTABLE_REVERSING' : 
                 recentMean >= 1.3 && recentMean <= 2.0 ? 'STABLE_CONVERGING' : 
                 recentMean < 1.3 ? 'DECAYING' : 'ACCELERATING'
  };
}

/**
 * Classify regime based on R ratio
 * @param {number} ratio - Mean convergence ratio
 * @returns {Object} Regime classification
 */
function classifyRegime(ratio) {
  if (ratio < REGIMES.SUB_CRITICAL.max) {
    return {
      regime: 'SUB_CRITICAL',
      ...REGIMES.SUB_CRITICAL,
      emoji: '🔵',
      interpretation: 'System losing momentum. Each spike weaker than last.',
      recommendation: 'Investigate structural causes of decline.'
    };
  } else if (ratio < REGIMES.CRITICAL.max) {
    return {
      regime: 'CRITICAL',
      ...REGIMES.CRITICAL,
      emoji: '🟢',
      interpretation: 'System in sustainable φ² renewal. Optimal growth.',
      recommendation: 'Maintain trajectory. Monitor for deviation.'
    };
  } else {
    return {
      regime: 'SUPER_CRITICAL',
      ...REGIMES.SUPER_CRITICAL,
      emoji: '🔴',
      interpretation: 'System accelerating unsustainably. Bubble dynamics.',
      recommendation: 'Prepare for correction. Reduce exposure.'
    };
  }
}

/**
 * Get φ-deviation alert
 * @param {number} ratio - Current R ratio
 * @returns {Object} Deviation alert
 */
function getPhiDeviationAlert(ratio) {
  const deviation = Math.abs(ratio - PHI);
  
  if (deviation > 0.4) {
    return {
      level: 'CRITICAL',
      emoji: '🔴',
      deviation: deviation.toFixed(3),
      description: ratio > PHI ? 'Super-critical acceleration' : 'Sub-critical deceleration',
      action: 'REASSESS_STRATEGY'
    };
  } else if (deviation > THRESHOLDS.PHI_TOLERANCE) {
    return {
      level: 'WARNING',
      emoji: '🟠',
      deviation: deviation.toFixed(3),
      description: 'Drifting from φ-equilibrium',
      action: 'GUARD_RISK'
    };
  } else {
    return {
      level: 'STABLE',
      emoji: '🟢',
      deviation: deviation.toFixed(3),
      description: 'Within φ ± 0.2 band (sustainable)',
      action: 'MAINTAIN'
    };
  }
}

/**
 * Analyze Convergence R with EMA-13/EMA-21
 * @param {number[]} absRatios - Absolute ratio time series
 * @returns {Object} Convergence analysis with signals
 */
function analyzeConvergence(absRatios) {
  if (!absRatios || absRatios.length === 0) {
    return { error: 'No ratio data' };
  }
  
  const ema13Result = calculateEMA(absRatios, FIB_PERIODS.FAST_R);
  const ema21Result = calculateEMA(absRatios, FIB_PERIODS.SLOW_R);
  const ema13 = ema13Result.values;
  const ema21 = ema21Result.values;
  const crossover = detectCrossover(ema13, ema21);
  
  const currentR = absRatios[absRatios.length - 1];
  const currentEMA13 = ema13[ema13.length - 1];
  const currentEMA21 = ema21[ema21.length - 1];
  const regime = classifyRegime(currentR);
  const phiAlert = getPhiDeviationAlert(currentR);
  
  return {
    dimension: 'CONVERGENCE_R',
    current: currentR,
    ema13: currentEMA13,
    ema21: currentEMA21,
    crossover,
    regime,
    phiAlert,
    phi: PHI,
    signal: phiAlert.action,
    raw: absRatios,
    emaFast: ema13,
    emaSlow: ema21,
    ema13Interpolated: ema13Result.interpolated,
    ema21Interpolated: ema21Result.interpolated
  };
}

// ============================================================================
// PART 5: DERIVATIVE HIERARCHY (Position/Velocity/Acceleration/Jerk)
// ============================================================================

/**
 * Calculate derivative hierarchy from stock time series
 * @param {number[]} stocks - Stock values over time
 * @returns {Object} All derivative levels
 */
function calculateDerivatives(stocks) {
  if (!stocks || stocks.length < 2) {
    return { error: 'Insufficient data for derivatives' };
  }
  
  const velocities = [];
  for (let i = 1; i < stocks.length; i++) {
    velocities.push(stocks[i] - stocks[i - 1]);
  }
  
  const accelerations = [];
  for (let i = 1; i < velocities.length; i++) {
    accelerations.push(velocities[i] - velocities[i - 1]);
  }
  
  const jerks = [];
  for (let i = 1; i < accelerations.length; i++) {
    jerks.push(accelerations[i] - accelerations[i - 1]);
  }
  
  return {
    position: stocks,
    velocity: velocities,
    acceleration: accelerations,
    jerk: jerks,
    currentPosition: stocks[stocks.length - 1],
    currentVelocity: velocities.length > 0 ? velocities[velocities.length - 1] : null,
    currentAcceleration: accelerations.length > 0 ? accelerations[accelerations.length - 1] : null,
    currentJerk: jerks.length > 0 ? jerks[jerks.length - 1] : null
  };
}

// ============================================================================
// PART 6: φ-CORRECTION & φ² RENEWAL
// ============================================================================

/**
 * Predict next z_flow using φ-correction formula
 * z(t+1) = z(t) - sign(z) · φ/|z(t)|
 * 
 * Zero-division guard: Returns equilibrium for |z| < 0.1
 */
function predictPhiCorrection(currentZ) {
  // Zero-division guard: near-equilibrium returns no correction
  if (currentZ === 0 || Math.abs(currentZ) < 0.1) {
    return {
      predictedZ: currentZ,
      correction: 0,
      willCorrect: false,
      interpretation: 'Near equilibrium - minimal correction expected'
    };
  }
  
  const sign = currentZ > 0 ? 1 : -1;
  // Safe division - |currentZ| guaranteed > 0.1 here
  const correction = sign * PHI / Math.abs(currentZ);
  const predictedZ = currentZ - correction;
  
  return {
    currentZ,
    predictedZ,
    correction,
    willCorrect: Math.abs(predictedZ) < Math.abs(currentZ),
    periodsToEquilibrium: estimatePeriodsToEquilibrium(currentZ),
    interpretation: currentZ > 0 
      ? `Expecting pullback from ${currentZ.toFixed(2)}σ to ${predictedZ.toFixed(2)}σ`
      : `Expecting recovery from ${currentZ.toFixed(2)}σ to ${predictedZ.toFixed(2)}σ`
  };
}

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
 * Detect φ² renewal cycle with Nagarjuna's Tetralemma framing
 * When R > φ² (2.618), applies tetralemma to avoid eschatological flattening
 * (binary bubble/breakthrough thinking)
 * 
 * TETRALEMMA STATES:
 * - (10) No/Bubble: Speculative excess without fundamental support
 * - (01) Yes/Breakthrough: Genuine phase transition, sustainable transformation
 * - (11) Both: Real innovation overlaid with speculative premium
 * - (00) Neither: Insufficient data to determine, withhold judgment
 */
function detectPhiSquaredRenewal(stocks, convergenceR = null) {
  if (!stocks || stocks.length < 3) {
    return { error: 'Insufficient data' };
  }
  
  const growthRates = [];
  for (let i = 1; i < stocks.length; i++) {
    if (stocks[i - 1] !== 0) {
      growthRates.push(stocks[i] / stocks[i - 1]);
    }
  }
  
  if (growthRates.length === 0) {
    return { error: 'Cannot calculate growth rates' };
  }
  
  const avgGrowthRate = mean(growthRates);
  const recentGrowth = growthRates.slice(-3);
  const recentAvg = mean(recentGrowth);
  
  const distanceFromPhi = Math.abs(recentAvg - PHI);
  const distanceFromPhiSquared = Math.abs(recentAvg - PHI_SQUARED);
  
  const crossedPhiSquared = recentAvg > PHI_SQUARED || (convergenceR !== null && convergenceR > PHI_SQUARED);
  
  let tetralemma = null;
  if (crossedPhiSquared) {
    tetralemma = {
      crossed: true,
      threshold: PHI_SQUARED.toFixed(3),
      value: convergenceR !== null ? convergenceR.toFixed(3) : recentAvg.toFixed(3),
      states: {
        no_bubble: '(10) Bubble only - speculative excess, no fundamental support',
        yes_breakthrough: '(01) Breakthrough only - genuine phase transition, sustainable',
        both: '(11) Both - real innovation with speculative overlay (most common)',
        neither: '(00) Neither - insufficient data, withhold judgment'
      },
      warning: '⚡ φ² THRESHOLD CROSSED - Apply tetralemma lens to avoid binary prediction',
      guidance: 'Investigate fundamentals before classifying as bubble OR breakthrough'
    };
  }
  
  return {
    growthRates,
    averageGrowthRate: avgGrowthRate,
    recentGrowthRate: recentAvg,
    distanceFromPhi,
    distanceFromPhiSquared,
    inPhiRenewal: distanceFromPhi < 0.3,
    inPhiSquaredRenewal: distanceFromPhiSquared < 0.5,
    crossedPhiSquared,
    tetralemma,
    renewalStatus: distanceFromPhiSquared < 0.5 ? 'φ²-Renewal Active' : 
                   distanceFromPhi < 0.3 ? 'φ-Growth Zone' : 
                   crossedPhiSquared ? 'φ²-Threshold (Tetralemma Required)' : 'Below Renewal Threshold',
    sustainability: (distanceFromPhi < 0.3 || distanceFromPhiSquared < 0.5) ? 'SUSTAINABLE' : 
                    crossedPhiSquared ? 'TETRALEMMA' : 'STAGNANT'
  };
}

// ============================================================================
// PART 7: Ψ-EMA DASHBOARD (Complete Analysis)
// ============================================================================

/**
 * PsiEMADashboard - Complete multi-dimensional wave function analysis
 */
class PsiEMADashboard {
  constructor(options = {}) {
    this.phi = PHI;
    this.phiSquared = PHI_SQUARED;
    this.fibPeriods = { ...FIB_PERIODS, ...options.fibPeriods };
  }
  
  /**
   * Complete Ψ-EMA analysis of financial time series
   * @param {Object} data - Financial data
   * @param {number[]} data.stocks - Stock values (equity, assets)
   * @param {number[]} data.flows - Flow values (net income) - optional, derived from stocks if not provided
   * @returns {Object} Complete 3-dimensional wave function analysis
   */
  analyze(data) {
    const { stocks, flows } = data;
    
    if (!stocks || stocks.length < 3) {
      return { error: 'Need at least 3 periods of stock data' };
    }
    
    // Derive flows if not provided
    const actualFlows = flows || this._deriveFlows(stocks);
    
    // Calculate z-scores
    const zFlowResult = calculateZFlows(actualFlows);
    if (zFlowResult.error && zFlowResult.zFlows.length === 0) {
      return { error: zFlowResult.error };
    }
    
    // Calculate phases
    const phases = calculatePhaseTimeSeries(stocks, actualFlows);
    
    // Calculate convergence ratios
    const convergenceResult = calculatePhiConvergence(zFlowResult.zFlows);
    
    // Analyze all three dimensions
    const phaseAnalysis = analyzePhase(phases);
    const anomalyAnalysis = analyzeAnomaly(zFlowResult.zFlows);
    const convergenceAnalysis = convergenceResult.absRatios && convergenceResult.absRatios.length > 0 
      ? analyzeConvergence(convergenceResult.absRatios)
      : { error: 'Insufficient convergence data' };
    
    // Calculate EMA fidelity (% real vs interpolated data)
    const fidelity = calculateFidelity(
      phaseAnalysis.ema34Interpolated,
      phaseAnalysis.ema55Interpolated,
      anomalyAnalysis.ema21Interpolated,
      anomalyAnalysis.ema34Interpolated,
      convergenceAnalysis.ema13Interpolated,
      convergenceAnalysis.ema21Interpolated
    );
    
    // Calculate derivatives
    const derivatives = calculateDerivatives(stocks);
    
    // φ-correction prediction
    const correction = predictPhiCorrection(zFlowResult.currentZ || 0);
    
    // φ² renewal detection (pass convergence R for tetralemma check)
    const convergenceR = convergenceAnalysis.current;
    const renewal = detectPhiSquaredRenewal(stocks, convergenceR);
    
    // Generate composite signal
    const compositeSignal = this._generateCompositeSignal(
      phaseAnalysis, 
      anomalyAnalysis, 
      convergenceAnalysis
    );
    
    return {
      summary: {
        periods: stocks.length,
        phaseSignal: phaseAnalysis.signal,
        anomalyLevel: anomalyAnalysis.alert?.level,
        regime: convergenceAnalysis.regime?.regime || 'UNKNOWN',
        compositeSignal: compositeSignal.action,
        compositeConfidence: compositeSignal.confidence,
        fidelity: `${fidelity.percent}% real (Grade ${fidelity.grade})`
      },
      dimensions: {
        phase: phaseAnalysis,
        anomaly: anomalyAnalysis,
        convergence: convergenceAnalysis
      },
      fidelity,
      derivatives,
      correction,
      renewal,
      compositeSignal,
      interpretation: this._generateInterpretation(phaseAnalysis, anomalyAnalysis, convergenceAnalysis, compositeSignal)
    };
  }
  
  _deriveFlows(stocks) {
    const flows = [];
    for (let i = 1; i < stocks.length; i++) {
      flows.push(stocks[i] - stocks[i - 1]);
    }
    return flows;
  }
  
  _generateCompositeSignal(phase, anomaly, convergence) {
    let bullishScore = 0;
    let bearishScore = 0;
    let confidence = 0;
    
    // Phase contribution (weight: 40%)
    if (phase.signal === 'BUY' || phase.signal === 'HOLD_LONG') {
      bullishScore += 40;
    } else if (phase.signal === 'SELL' || phase.signal === 'HOLD_SHORT') {
      bearishScore += 40;
    }
    
    // Anomaly contribution (weight: 30%)
    if (anomaly.alert) {
      if (anomaly.alert.level === 'NORMAL') {
        confidence += 10;
      } else if (anomaly.alert.level === 'EXTREME') {
        bearishScore += 20;  // Extreme = mean reversion expected
      }
    }
    
    // Convergence contribution (weight: 30%)
    if (convergence.regime) {
      if (convergence.regime.regime === 'CRITICAL') {
        bullishScore += 20;
        confidence += 20;
      } else if (convergence.regime.regime === 'SUPER_CRITICAL') {
        bearishScore += 30;
      } else if (convergence.regime.regime === 'SUB_CRITICAL') {
        bearishScore += 15;
      }
    }
    
    const netScore = bullishScore - bearishScore;
    confidence = Math.min(95, confidence + Math.abs(netScore));
    
    let action, emoji;
    if (netScore > 20) {
      action = 'ACCUMULATE';
      emoji = '🟢';
    } else if (netScore > 0) {
      action = 'HOLD_LONG';
      emoji = '🟡';
    } else if (netScore > -20) {
      action = 'NEUTRAL';
      emoji = '⚪';
    } else if (netScore > -40) {
      action = 'REDUCE';
      emoji = '🟠';
    } else {
      action = 'EXIT';
      emoji = '🔴';
    }
    
    return {
      action,
      emoji,
      bullishScore,
      bearishScore,
      netScore,
      confidence
    };
  }
  
  _generateInterpretation(phase, anomaly, convergence, composite) {
    const lines = [];
    
    lines.push(`## Ψ-EMA DASHBOARD ANALYSIS`);
    lines.push('');
    
    // Phase
    lines.push(`### Phase θ (Cycle Position)`);
    lines.push(`Current: ${phase.current?.toFixed(1)}° ${phase.interpretation?.emoji || ''}`);
    lines.push(`EMA-34: ${phase.ema34?.toFixed(1)}° | EMA-55: ${phase.ema55?.toFixed(1)}°`);
    lines.push(`Signal: **${phase.crossover?.description || phase.signal}**`);
    lines.push('');
    
    // Anomaly
    lines.push(`### Anomaly z (Deviation Strength)`);
    lines.push(`Current: ${anomaly.current?.toFixed(2)}σ ${anomaly.alert?.emoji || ''}`);
    lines.push(`Level: **${anomaly.alert?.level}** - ${anomaly.alert?.description}`);
    lines.push(`Action: ${anomaly.alert?.action}`);
    lines.push('');
    
    // Convergence
    if (convergence.regime) {
      lines.push(`### Convergence R (Sustainability)`);
      lines.push(`Current R: ${convergence.current?.toFixed(3)} | φ = ${PHI.toFixed(3)}`);
      lines.push(`Regime: **${convergence.regime.label}** ${convergence.regime.emoji}`);
      lines.push(`φ-Deviation: ${convergence.phiAlert?.deviation} (${convergence.phiAlert?.level})`);
      lines.push('');
    }
    
    // Composite
    lines.push(`### Composite Signal`);
    lines.push(`${composite.emoji} **${composite.action}** (Confidence: ${composite.confidence}%)`);
    lines.push(`Net Score: ${composite.netScore} (Bullish: ${composite.bullishScore}, Bearish: ${composite.bearishScore})`);
    
    return lines.join('\n');
  }
  
  /**
   * Quick health check
   */
  quickCheck(stocks) {
    const analysis = this.analyze({ stocks });
    if (analysis.error) return { healthy: null, error: analysis.error };
    
    return {
      healthy: analysis.summary.regime === 'CRITICAL',
      regime: analysis.summary.regime,
      phase: analysis.dimensions.phase.interpretation?.phase,
      anomaly: `${analysis.dimensions.anomaly.current?.toFixed(1)}σ`,
      signal: analysis.summary.compositeSignal
    };
  }
}

// ============================================================================
// PART 8: KEYWORD DETECTION & AI CONTEXT
// ============================================================================

/**
 * Check if query should trigger Ψ-EMA analysis
 */
function shouldTriggerPsiEMA(query) {
  if (!query) return false;
  const lowerQuery = query.toLowerCase();
  
  const keywords = [
    'fourier',
    'φ',
    'ψ',
    'psi',
    'phi',
    'series',
    'wave',
    'oscillator',
    'harmonic',
    'ema',
    'crossover',
    'golden cross',
    'death cross',
    'z-score',
    'z_flow',
    'convergence',
    'derivative',
    'jerk',
    'phase space',
    'golden ratio',
    'fibonacci',
    'dashboard'
  ];
  
  return keywords.some(kw => lowerQuery.includes(kw));
}

/**
 * Generate AI context prompt for Ψ-EMA analysis
 */
function getPsiEMAContext() {
  return `
## Ψ-EMA: FINANCIAL WAVE FUNCTION DASHBOARD

You are analyzing with the Ψ-EMA multi-dimensional wave function framework.

### The Three Orthogonal Dimensions:

**1. Phase θ (Cycle Position)** — EMA-34/EMA-55
   θ = arctan(Flow/Stock)
   - 0°-90° = Early Expansion 🟢 (stock→flow)
   - 90°-180° = Late Expansion 🟡 (flow peak)
   - 180°-270° = Early Contraction 🔴 (flow→stock)
   - 270°-360° = Late Contraction 🔵 (stock trough)
   - Golden Cross = Fast EMA crosses above Slow → BUY
   - Death Cross = Fast EMA crosses below Slow → SELL

**2. Anomaly z (Deviation Strength)** — EMA-21/EMA-34
   z = (Flow - μ) / σ
   - ±1σ = Normal range 🟢
   - ±2σ = Alert threshold 🟠
   - ±3σ = Extreme (bubble/crisis) 🔴

**3. Convergence R (Sustainability)** — EMA-13/EMA-21
   R = z(t) / z(t-1)
   - R < 1.3 = Sub-Critical (dying) 🔵
   - R ≈ φ (1.3-2.0) = Critical (sustainable) 🟢
   - R > 2.0 = Super-Critical (bubble) 🔴

### Key Formulas:
- φ = 1.618 (golden ratio)
- φ² = 2.618 (renewal threshold)
- φ-Correction: z(t+1) = z(t) - sign(z)·φ/|z|

### Fibonacci EMA Periods:
- Phase: 34/55 (slow, full cycle)
- Anomaly: 21/34 (medium, quick response)
- Convergence: 13/21 (fast, leading indicator)

Apply these concepts when analyzing financial time series data.
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
  FIB_PERIODS,
  REGIMES,
  THRESHOLDS,
  
  // EMA functions
  calculateEMA,
  detectCrossover,
  
  // Phase analysis
  calculatePhase,
  calculatePhaseTimeSeries,
  interpretPhase,
  analyzePhase,
  
  // Anomaly analysis
  calculateZFlows,
  getAnomalyAlert,
  analyzeAnomaly,
  
  // Convergence analysis
  calculatePhiConvergence,
  classifyRegime,
  getPhiDeviationAlert,
  analyzeConvergence,
  
  // Derivatives
  calculateDerivatives,
  
  // Correction & Renewal
  predictPhiCorrection,
  estimatePeriodsToEquilibrium,
  detectPhiSquaredRenewal,
  
  // Utilities
  mean,
  stdDev,
  zScore,
  calculateFidelity,
  
  // Main dashboard class
  PsiEMADashboard,
  
  // AI integration
  shouldTriggerPsiEMA,
  getPsiEMAContext
};

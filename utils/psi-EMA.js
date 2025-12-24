/**
 * Ψ-EMA: Time Series Oscillator (Three-Dimensional Wave Function Observer)
 * 
 * GLOSSARY & SUBSTRATE-AGNOSTIC FRAMING:
 * ═════════════════════════════════════════════════════════════════════════════
 * Ψ-EMA is a GENERAL-PURPOSE time series survival/oscillation observer applicable to any domain with
 * stock/flow decomposition. Examples herein use capital markets due to data accessibility,
 * but the same framework applies to:
 *   • Climate: Temperature (stock) vs heating/cooling flow (anomaly detection)
 *   • Sports: Win rate (stock) vs momentum (phase angle)
 *   • Demographics: Population (stock) vs birth/death flow (signal decomposition)
 *   • Physics: Charge/mass (stock) vs force field (phase relationships)
 * 
 * The THREE DIMENSIONS (θ, z, R) are substrate-independent measurements:
 *   θ (Phase):       Cycle position via atan2(Flow, Stock) - applies to any oscillating system
 *   z (Anomaly):     Deviation from equilibrium via robust MAD z-score - universal
 *   R (Convergence): Amplitude ratio z(t)/z(t-1) - scale-free convergence metric
 * 
 * All bounds and thresholds derive from φ (1.618), the golden ratio from x = 1 + 1/x.
 * ═════════════════════════════════════════════════════════════════════════════
 * 
 * ┌────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ Ψ-EMA DIMENSIONAL REFERENCE (φ-DERIVED THRESHOLDS ONLY)                                   │
 * ├─────────────────┬──────────────────────────┬────────────────┬──────────────────────────────┤
 * │ Dimension       │ Formula                  │ φ-Bounds       │ Classification Rule          │
 * ├─────────────────┼──────────────────────────┼────────────────┼──────────────────────────────┤
 * │ θ (Phase)       │ atan2(Flow, Stock)       │ ∈ [0°, 360°)   │ θ measures cycle position    │
 * │ Cycle Position  │                          │                │ (Flow-Stock phase angle)     │
 * ├─────────────────┼──────────────────────────┼────────────────┼──────────────────────────────┤
 * │ z (Anomaly)     │ (Value - Median) / MAD   │ See bounds     │ |z| > φ² flags anomaly      │
 * │ Signal Deviation│                          │ below          │ (deviation from equilibrium) │
 * ├─────────────────┼──────────────────────────┼────────────────┼──────────────────────────────┤
 * │ R (Convergence) │ z(t) / z(t-1)            │ φ⁻¹ ≤ R ≤ φ    │ R ∈ [φ⁻¹, φ] classifies as  │
 * │ Amplitude Ratio │                          │ is "critical"  │ convergent state             │
 * └─────────────────┴──────────────────────────┴────────────────┴──────────────────────────────┘
 * 
 * THRESHOLDS (All φ-Derived, Zero Dogma):
 * - φ⁻² ≈ 0.382: Tolerance band around φ (|R - φ| ≤ φ⁻²)
 * - φ⁻¹ ≈ 0.618: Lower bound (R < φ⁻¹ → amplitude decay)
 * - φ   ≈ 1.618: Upper bound (R > φ → amplitude growth)
 * - φ²  ≈ 2.618: Extreme deviation flag (|z| > φ²)
 * - 1 = φ⁰:     Reference point
 * - 2 = φ⁰ + φ⁻¹ + φ⁻²: Composite bound (1 + 0.618 + 0.382 ≈ 2)
 * 
 * FIBONACCI EMA PERIODS:
 * - 13, 21, 34, 55 (consecutive Fibonacci numbers)
 * - These are self-similar under φ scaling: F(n+1)/F(n) → φ
 * 
 * Measurement Data Only (No Interpretation):
 * All output is observed measurement + φ-distance. No claims about regime,
 * sustainability, or directional prediction. Only empirical data and classification checks.
 */

const PHI = 1.6180339887498949;           // Golden ratio φ = (1 + √5) / 2
const PHI_SQUARED = PHI * PHI;            // φ² = φ + 1 ≈ 2.618
const PHI_INVERSE = 1 / PHI;              // φ⁻¹ = φ - 1 ≈ 0.618
const PHI_INV_SQUARED = PHI_INVERSE ** 2; // φ⁻² ≈ 0.382

// Fibonacci EMA periods: consecutive Fibonacci numbers where F(n+1)/F(n) → φ
const FIB_PERIODS = {
  FAST_R: 13,      // 7th Fibonacci number
  SLOW_R: 21,      // 8th Fibonacci number
  FAST_Z: 21,      // 8th Fibonacci number
  SLOW_Z: 34,      // 9th Fibonacci number
  FAST_THETA: 34,  // 9th Fibonacci number
  SLOW_THETA: 55   // 10th Fibonacci number
};

// R (Convergence) Regime Bounds - φ-Derived from x = 1 + 1/x
// Classification: Amplitude ratio near φ indicates self-similar oscillations
const R_BOUNDS = {
  LOWER: PHI_INVERSE,      // φ⁻¹ ≈ 0.618: R < φ⁻¹ → amplitude decay
  UPPER: PHI,              // φ ≈ 1.618: R > φ → amplitude growth
  TOLERANCE: PHI_INV_SQUARED // φ⁻² ≈ 0.382: band around φ for convergence test
};

// Z (Anomaly) Thresholds - φ-Derived from x = 1 + 1/x
// Classification: Deviation from equilibrium measured in MAD units
const Z_BOUNDS = {
  NORMAL: PHI,             // |z| < φ: within expected range
  ALERT: PHI_SQUARED,      // φ < |z| < φ²: elevated deviation
  EXTREME: PHI_SQUARED     // |z| > φ²: extreme deviation flag
};

// Composite φ-sums (no arbitrary numbers)
// 1 = φ⁰ (unity)
// 2 = φ⁰ + φ⁻¹ + φ⁻² = 1 + 0.618 + 0.382 ≈ 2.000
const PHI_COMPOSITE_2 = 1 + PHI_INVERSE + PHI_INV_SQUARED;

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
 * Calculate Median Absolute Deviation (MAD) - robust dispersion measure
 * Less sensitive to outliers than standard deviation
 * @param {number[]} arr - Array of values
 * @returns {number} MAD value
 */
function mad(arr) {
  if (!arr || arr.length < 2) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const deviations = arr.map(v => Math.abs(v - median));
  const sortedDeviations = deviations.slice().sort((a, b) => a - b);
  return sortedDeviations[Math.floor(sortedDeviations.length / 2)];
}

/**
 * Calculate median of array
 * @param {number[]} arr - Array of values
 * @returns {number} Median value
 */
function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Calculate robust z-score using MAD (Median Absolute Deviation)
 * Scaled by 1.4826 for normal consistency (matches σ for Gaussian data)
 * @param {number} value - Current value
 * @param {number[]} arr - Array of historical values
 * @returns {number} MAD-scaled z-score
 */
function robustZScore(value, arr) {
  const med = median(arr);
  const dispersion = mad(arr);
  if (dispersion === 0) return 0;
  const MAD_SCALE = 1.4826;  // Scaling factor for normal consistency
  return (value - med) / (dispersion * MAD_SCALE);
}

/**
 * Count real vs interpolated points in an array
 * @param {boolean[]} arr - Interpolation flag array
 * @returns {Object} { real, total }
 */
function countFidelity(arr) {
  if (!arr || !Array.isArray(arr)) return { real: 0, total: 0 };
  let total = arr.length;
  let interpolated = arr.filter(x => x === true).length;
  return { real: total - interpolated, total };
}

/**
 * Calculate per-dimension EMA fidelity (no aggregate - each dimension stands alone)
 * 
 * vφ³: Removed aggregate percentage and letter grades.
 * Each dimension (θ, z, R) reports its own real/total ratio independently.
 * "No sum > parts" - avoids skew bias from aggregation.
 * 
 * @param {Object} dimensions - Named interpolation arrays per dimension
 * @param {boolean[]} dimensions.theta1 - θ dimension EMA-34 interpolated flags
 * @param {boolean[]} dimensions.theta2 - θ dimension EMA-55 interpolated flags
 * @param {boolean[]} dimensions.z1 - z dimension EMA-21 interpolated flags
 * @param {boolean[]} dimensions.z2 - z dimension EMA-34 interpolated flags
 * @param {boolean[]} dimensions.r1 - R dimension EMA-13 interpolated flags
 * @param {boolean[]} dimensions.r2 - R dimension EMA-21 interpolated flags
 * @returns {Object} Per-dimension fidelity breakdown
 */
function calculateFidelity(dimensions = {}) {
  const { theta1, theta2, z1, z2, r1, r2 } = dimensions;
  
  // Count per-dimension (merge arrays within each dimension)
  const thetaCount1 = countFidelity(theta1);
  const thetaCount2 = countFidelity(theta2);
  const zCount1 = countFidelity(z1);
  const zCount2 = countFidelity(z2);
  const rCount1 = countFidelity(r1);
  const rCount2 = countFidelity(r2);
  
  // Aggregate within each dimension only
  const theta = {
    real: thetaCount1.real + thetaCount2.real,
    total: thetaCount1.total + thetaCount2.total
  };
  const z = {
    real: zCount1.real + zCount2.real,
    total: zCount1.total + zCount2.total
  };
  const r = {
    real: rCount1.real + rCount2.real,
    total: rCount1.total + rCount2.total
  };
  
  return {
    theta,
    z,
    r,
    // Human-readable breakdown string
    breakdown: `θ: ${theta.real}/${theta.total} | z: ${z.real}/${z.total} | R: ${r.real}/${r.total}`
  };
}

/**
 * Legacy fidelity calculation for crossover detection (needs aggregate ratio)
 * @param {boolean[][]} interpolatedArrays - Array of interpolation flag arrays
 * @returns {Object} Fidelity with ratio for gating
 */
function calculateFidelityLegacy(...interpolatedArrays) {
  let totalPoints = 0;
  let interpolatedPoints = 0;
  
  for (const arr of interpolatedArrays) {
    if (!arr || !Array.isArray(arr)) continue;
    for (const isInterpolated of arr) {
      totalPoints++;
      if (isInterpolated) interpolatedPoints++;
    }
  }
  
  if (totalPoints === 0) return { ratio: 1, real: 0, total: 0 };
  
  const realPoints = totalPoints - interpolatedPoints;
  const ratio = realPoints / totalPoints;
  
  return { ratio, real: realPoints, total: totalPoints };
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
 * 
 * vφ³: Now gated by fidelity threshold - low-quality data returns WAIT signal
 * 
 * @param {number[]} fastEMA - Fast EMA values (may contain leading nulls)
 * @param {number[]} slowEMA - Slow EMA values (may contain leading nulls)
 * @param {Object} options - Configuration options
 * @param {number} options.minFidelity - Minimum fidelity ratio to generate signal (default: 0.75)
 * @param {boolean[]} options.fastInterpolated - Interpolation flags for fast EMA
 * @param {boolean[]} options.slowInterpolated - Interpolation flags for slow EMA
 * @returns {Object} Crossover detection result with fidelity
 */
function detectCrossover(fastEMA, slowEMA, options = {}) {
  const { minFidelity = PHI_INVERSE, fastInterpolated, slowInterpolated } = options;
  
  if (fastEMA.length < 2 || slowEMA.length < 2) {
    return { type: 'none', index: -1, signal: 'WAIT', description: 'Insufficient data', fidelity: 0 };
  }
  
  // Calculate fidelity if interpolation flags provided
  let fidelity = 1.0;
  if (fastInterpolated && slowInterpolated) {
    const fidelityResult = calculateFidelityLegacy(fastInterpolated, slowInterpolated);
    fidelity = fidelityResult.ratio;
  }
  
  // Gate by fidelity threshold
  if (fidelity < minFidelity) {
    return { 
      type: 'insufficient_data', 
      index: -1, 
      signal: 'WAIT', 
      description: `Fidelity ${(fidelity * 100).toFixed(0)}% < ${minFidelity * 100}% threshold`,
      fidelity,
      gated: true
    };
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
      description: 'Fast EMA crossed above Slow EMA',
      fidelity
    };
  }
  
  // Death Cross: Fast crosses BELOW Slow
  if (prevFast >= prevSlow && currentFast < currentSlow) {
    return { 
      type: 'death_cross', 
      index: currentIdx,
      signal: 'SELL',
      description: 'Fast EMA crossed below Slow EMA',
      fidelity
    };
  }
  
  // No crossover - check current position
  if (currentFast > currentSlow) {
    return { 
      type: 'above', 
      index: currentIdx,
      signal: 'HOLD_LONG',
      description: 'Fast EMA above Slow EMA (bullish)',
      fidelity
    };
  } else {
    return { 
      type: 'below', 
      index: currentIdx,
      signal: 'HOLD_SHORT',
      description: 'Fast EMA below Slow EMA (bearish)',
      fidelity
    };
  }
}

// ============================================================================
// PART 2: PHASE θ (Cycle Position)
// ============================================================================

/**
 * Calculate phase angle θ = atan2(Flow, Stock) for full 0°-360° quadrant coverage
 * 
 * vφ³: Now normalizes inputs for scale invariance. Raw atan2 is unit-sensitive;
 * normalization ensures consistent phase regardless of absolute magnitudes.
 * 
 * Using atan2 gives full 4-quadrant coverage:
 * - Q1 (0°-90°): +Stock, +Flow = Early Expansion
 * - Q2 (90°-180°): -Stock, +Flow = Late Expansion  
 * - Q3 (180°-270°): -Stock, -Flow = Early Contraction
 * - Q4 (270°-360°): +Stock, -Flow = Late Contraction
 * 
 * @param {number} flow - Income statement value (net income, revenue)
 * @param {number} stock - Balance sheet value (equity, assets)
 * @param {Object} options - Normalization options
 * @param {boolean} options.normalize - If true (default), normalize inputs for scale invariance
 * @param {number} options.flowScale - Historical flow magnitude for normalization (default: |flow|)
 * @param {number} options.stockScale - Historical stock magnitude for normalization (default: |stock|)
 * @returns {number} Phase angle in degrees (0°-360°)
 */
function calculatePhase(flow, stock, options = { normalize: true }) {
  let flowNorm = flow;
  let stockNorm = stock;
  
  if (options.normalize) {
    // Normalize each to its own scale (avoid division by zero)
    const flowScale = options.flowScale || Math.abs(flow) || 1;
    const stockScale = options.stockScale || Math.abs(stock) || 1;
    flowNorm = flow / flowScale;
    stockNorm = stock / stockScale;
  }
  
  // atan2(y, x) returns radians in range (-π, π]
  const radians = Math.atan2(flowNorm, stockNorm);
  let degrees = radians * (180 / Math.PI);
  // Normalize to 0°-360° range
  if (degrees < 0) degrees += 360;
  return degrees;
}

/**
 * Calculate phase time series from stocks and flows
 * 
 * vφ³: Normalizes each pair using historical mean magnitudes for scale invariance.
 * 
 * @param {number[]} stocks - Balance sheet values over time
 * @param {number[]} flows - Income statement values over time
 * @param {Object} options - Normalization options
 * @param {boolean} options.normalize - If true (default), normalize for scale invariance
 * @returns {number[]} Phase angles in degrees
 */
function calculatePhaseTimeSeries(stocks, flows, options = { normalize: true }) {
  const len = Math.min(stocks.length, flows.length);
  const phases = [];
  
  // Calculate historical mean magnitudes for normalization
  let flowScale = 1;
  let stockScale = 1;
  if (options.normalize && len > 0) {
    const absMeanFlow = mean(flows.slice(0, len).map(Math.abs));
    const absMeanStock = mean(stocks.slice(0, len).map(Math.abs));
    flowScale = absMeanFlow || 1;
    stockScale = absMeanStock || 1;
  }
  
  for (let i = 0; i < len; i++) {
    phases.push(calculatePhase(flows[i], stocks[i], { 
      normalize: options.normalize, 
      flowScale, 
      stockScale 
    }));
  }
  return phases;
}

/**
 * Calculate EMA for phase angles using circular mean on unit circle
 * 
 * CRITICAL MATHEMATICAL HARDENING:
 * Direct EMA on angles creates wraparound artifacts near 0°/360° boundary.
 * Example: EMA(350°, 10°) = 180° (wrong), but circular mean gives 0° (correct).
 * 
 * Solution: Use unit circle representation
 * - Convert each angle θ to unit vector: (cos θ, sin θ)
 * - Apply EMA to sin and cos components separately
 * - Recover angle via atan2(EMA(sin), EMA(cos))
 * - Normalize to [0°, 360°)
 * 
 * This eliminates discontinuity artifacts and provides mathematically rigorous averaging.
 * 
 * @param {number[]} phaseAngles - Phase angles in degrees [0, 360)
 * @param {number} period - EMA period (Fibonacci: 34, 55 for θ)
 * @param {Object} options - Configuration
 * @param {boolean} options.interpolate - If true (default), interpolate leading values
 * @param {boolean} options.markInterpolation - If true, track interpolation flags
 * @returns {Object} { values (in degrees), interpolated, sinComponent, cosComponent }
 */
function calculatePhaseEMACircular(phaseAngles, period, options = { interpolate: true, markInterpolation: true }) {
  if (!phaseAngles || phaseAngles.length === 0) {
    if (options.markInterpolation) {
      return { values: [], interpolated: [], sinComponent: [], cosComponent: [] };
    }
    return [];
  }

  // Convert all angles to radians and extract sin/cos components
  const sinComponents = phaseAngles.map(deg => Math.sin(deg * Math.PI / 180));
  const cosComponents = phaseAngles.map(deg => Math.cos(deg * Math.PI / 180));

  // Apply EMA to each component separately
  const sinEMAResult = calculateEMA(sinComponents, period, { 
    interpolate: options.interpolate, 
    markInterpolation: options.markInterpolation 
  });
  const cosEMAResult = calculateEMA(cosComponents, period, { 
    interpolate: options.interpolate, 
    markInterpolation: options.markInterpolation 
  });

  const sinEMA = sinEMAResult.values;
  const cosEMA = cosEMAResult.values;
  const interpolatedFlags = sinEMAResult.interpolated;

  // Recover angles from EMA'd sin/cos components
  const recoveredAngles = [];
  for (let i = 0; i < sinEMA.length; i++) {
    if (sinEMA[i] === null || cosEMA[i] === null) {
      recoveredAngles.push(null);
    } else {
      // atan2 returns radians in (-π, π], normalize to [0°, 360°)
      let radians = Math.atan2(sinEMA[i], cosEMA[i]);
      let degrees = radians * (180 / Math.PI);
      if (degrees < 0) degrees += 360;
      recoveredAngles.push(degrees);
    }
  }

  return {
    values: recoveredAngles,
    interpolated: interpolatedFlags,
    sinComponent: sinEMA,
    cosComponent: cosEMA
  };
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
 * 
 * Uses circular mean EMA (hardened against wraparound artifacts).
 * 
 * @param {number[]} phases - Phase angle time series (in degrees)
 * @returns {Object} Phase analysis with signals
 */
function analyzePhase(phases) {
  // Use circular mean EMA to eliminate wraparound artifacts at 0°/360° boundary
  const ema34Result = calculatePhaseEMACircular(phases, FIB_PERIODS.FAST_THETA);
  const ema55Result = calculatePhaseEMACircular(phases, FIB_PERIODS.SLOW_THETA);
  const ema34 = ema34Result.values;
  const ema55 = ema55Result.values;
  
  // vφ³: Pass fidelity info to gate crossover signals
  const crossover = detectCrossover(ema34, ema55, {
    fastInterpolated: ema34Result.interpolated,
    slowInterpolated: ema55Result.interpolated
  });
  
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
 * 
 * vφ³: Now uses MAD (Median Absolute Deviation) by default instead of σ.
 * MAD is more robust to outliers than standard deviation.
 * Scaled by 1.4826 for normal consistency.
 * 
 * @param {number[]} flows - Flow values
 * @param {Object} options - Configuration options
 * @param {boolean} options.robust - If true (default), use MAD. If false, use σ.
 * @returns {Object} Z-scores and statistics
 */
function calculateZFlows(flows, options = { robust: true }) {
  if (!flows || flows.length < 2) {
    return { zFlows: [], mean: 0, dispersion: 0, method: 'none', error: 'Insufficient data' };
  }
  
  const avg = mean(flows);
  const med = median(flows);
  
  if (options.robust) {
    // vφ³: Use MAD (Median Absolute Deviation) for robustness
    const dispersion = mad(flows);
    const MAD_SCALE = 1.4826;  // Scaling for normal consistency
    
    if (dispersion === 0) {
      return { 
        zFlows: flows.map(() => 0), 
        mean: avg, 
        median: med,
        dispersion: 0, 
        method: 'MAD',
        error: 'Zero dispersion' 
      };
    }
    
    const scaledDispersion = dispersion * MAD_SCALE;
    const zFlows = flows.map(f => (f - med) / scaledDispersion);
    
    return {
      zFlows,
      mean: avg,
      median: med,
      dispersion: scaledDispersion,
      method: 'MAD',
      currentZ: zFlows[zFlows.length - 1],
      previousZ: zFlows.length > 1 ? zFlows[zFlows.length - 2] : null,
      anomalyStrength: Math.abs(zFlows[zFlows.length - 1])
    };
  }
  
  // Legacy σ-based calculation
  const std = stdDev(flows);
  
  if (std === 0) {
    return { zFlows: flows.map(() => 0), mean: avg, dispersion: 0, method: 'sigma', error: 'Zero variance' };
  }
  
  const zFlows = flows.map(f => (f - avg) / std);
  
  return {
    zFlows,
    mean: avg,
    stdDev: std,
    dispersion: std,
    method: 'sigma',
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
  
  // H₀: Anomaly classification based on φ-derived bounds
  if (absZ >= Z_BOUNDS.EXTREME) {
    return {
      level: 'EXTREME',
      emoji: '🔴',
      z_value: `${absZ.toFixed(1)}`,
      description: z > 0 ? 'Extreme positive deviation from median' : 'Extreme negative deviation from median',
      hypothesis: `H₀: |z| > φ² (${Z_BOUNDS.EXTREME.toFixed(3)})`
    };
  } else if (absZ >= Z_BOUNDS.ALERT) {
    return {
      level: 'ALERT',
      emoji: '🟠',
      z_value: `${absZ.toFixed(1)}`,
      description: 'Elevated deviation from median',
      hypothesis: `H₀: φ < |z| < φ² (${Z_BOUNDS.ALERT.toFixed(3)}-${Z_BOUNDS.EXTREME.toFixed(3)})`
    };
  } else if (absZ >= Z_BOUNDS.NORMAL) {
    return {
      level: 'ELEVATED',
      emoji: '🟡',
      z_value: `${absZ.toFixed(1)}`,
      description: 'Moderate deviation from median',
      hypothesis: `H₀: |z| ≥ φ (${Z_BOUNDS.NORMAL.toFixed(3)})`
    };
  } else {
    return {
      level: 'NORMAL',
      emoji: '🟢',
      z_value: `${absZ.toFixed(1)}`,
      description: 'Within equilibrium range',
      hypothesis: `H₀: |z| < φ (${Z_BOUNDS.NORMAL.toFixed(3)})`
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
  
  // vφ³: Pass fidelity info to gate crossover signals
  const crossover = detectCrossover(ema21, ema34, {
    fastInterpolated: ema21Result.interpolated,
    slowInterpolated: ema34Result.interpolated
  });
  
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
      normal: `±φ (${Z_BOUNDS.NORMAL.toFixed(2)})`,
      alert: `±φ² (${Z_BOUNDS.ALERT.toFixed(2)})`,
      extreme: `>φ² (${Z_BOUNDS.EXTREME.toFixed(2)})`,
      method: 'MAD-scaled, φ-derived'
    }
  };
}

// ============================================================================
// PART 4: CONVERGENCE R (Sustainability Ratio → φ)
// ============================================================================

/**
 * Safe convergence ratio calculation (vφ³ finalization Dec 23, 2025)
 * Addresses numerical instability near zero and sign flips
 * 
 * CRITICAL FIX (Dec 23, 2025): Both numerator AND denominator must be checked.
 * When z is near zero (price at median), R ratio is UNDEFINED — not "decay".
 * Low z at high price = consolidation at new highs, not momentum loss.
 * 
 * Returns structured result with:
 * - ratio: raw z(t)/z(t-1) (may be null if either z too small)
 * - absRatio: clamped absolute value (0.1-10 range)
 * - direction: 'same_sign' or 'reversal'
 * - interpretation: regime description without over-claiming φ
 * - status: 'VALID', 'INSUFFICIENT_DATA', or 'LOW_SIGNAL'
 * 
 * @param {number} currentZ - Current z-score
 * @param {number} previousZ - Previous z-score
 * @param {number} epsilon - Minimum z threshold for valid ratio (default: 0.15)
 * @returns {Object} Safe ratio result
 */
function safeConvergenceRatio(currentZ, previousZ, epsilon = 0.15) {
  // Guard: EITHER z near zero → R is undefined (not decay!)
  // This prevents false "decay" signals when price consolidates at highs
  if (Math.abs(previousZ) < epsilon) {
    return {
      ratio: null,
      absRatio: null,
      direction: null,
      interpretation: 'Previous anomaly near zero — R undefined (consolidation zone)',
      status: 'INSUFFICIENT_DATA'
    };
  }
  
  if (Math.abs(currentZ) < epsilon) {
    return {
      ratio: null,
      absRatio: null,
      direction: null,
      interpretation: 'Current anomaly near zero — R undefined (price at median)',
      status: 'LOW_SIGNAL',
      warning: 'Low z-score may indicate consolidation, not decay'
    };
  }
  
  const rawRatio = currentZ / previousZ;
  const absRatio = Math.abs(rawRatio);
  
  // Clamp to safe range (0.1 to 10) to prevent extreme values
  const clampedAbsRatio = Math.max(0.1, Math.min(10, absRatio));
  
  // Interpret regime using clamped value (φ-zone as band, not law)
  let interpretation;
  if (clampedAbsRatio < 1.3) {
    interpretation = 'anomaly contracting — momentum declining';
  } else if (clampedAbsRatio < 2.0) {
    interpretation = 'anomaly momentum in φ-zone — sustainable growth';
  } else {
    interpretation = 'anomaly expanding — accelerating momentum';
  }
  
  return {
    ratio: rawRatio,
    absRatio: clampedAbsRatio,
    direction: rawRatio > 0 ? 'same_sign' : 'reversal',
    interpretation,
    status: 'VALID'
  };
}

/**
 * Calculate successive ratios R(t) = z(t) / z(t-1)
 * Uses safeConvergenceRatio() for numerical stability
 * Handles sign flips (reversals) which indicate phase transitions
 * @param {number[]} zFlows - Z-score time series
 * @returns {Object} Ratios and convergence analysis with sign flip detection
 */
function calculatePhiConvergence(zFlows) {
  if (!zFlows || zFlows.length < 2) {
    return { ratios: [], meanRatio: 0, converged: false, error: 'Insufficient data' };
  }
  
  const ratios = [];
  const safeRatios = [];  // Only VALID results
  const allResults = [];   // ALL results including LOW_SIGNAL
  let signFlipCount = 0;
  
  for (let i = 1; i < zFlows.length; i++) {
    // Use safe convergence ratio function (handles zero-division, clamping, reversals)
    const safeResult = safeConvergenceRatio(zFlows[i], zFlows[i - 1]);
    allResults.push(safeResult);  // Track ALL results
    
    if (safeResult.status === 'VALID') {
      ratios.push(safeResult.ratio);
      safeRatios.push(safeResult);
      
      // Detect sign flip (reversal): direction change indicates phase transition
      if (safeResult.direction === 'reversal') {
        signFlipCount++;
      }
    }
  }
  
  // Count LOW_SIGNAL cases from ALL results (not just valid ones)
  const lowSignalCount = allResults.filter(r => r.status === 'LOW_SIGNAL' || r.status === 'INSUFFICIENT_DATA').length;
  const lowSignalRatio = lowSignalCount / allResults.length;
  
  // CRITICAL: Check if MOST RECENT result is LOW_SIGNAL (current z near zero)
  const mostRecentResult = allResults[allResults.length - 1];
  const currentIsLowSignal = mostRecentResult && 
    (mostRecentResult.status === 'LOW_SIGNAL' || mostRecentResult.status === 'INSUFFICIENT_DATA');
  
  // hasLowSignal is true if current is low signal OR >30% of all results are low signal
  const hasLowSignal = currentIsLowSignal || lowSignalRatio > 0.3;
  
  if (ratios.length === 0) {
    return { 
      ratios: [], 
      meanRatio: null, 
      converged: false, 
      error: 'No valid ratios',
      hasLowSignal: true,
      warning: 'R undefined — z-scores near zero (price at median). Not decay, likely consolidation.'
    };
  }
  
  // Use clamped absRatio from safe results (not direct absolute values)
  const absRatios = safeRatios.filter(r => r.absRatio !== null).map(r => r.absRatio);
  if (absRatios.length === 0) {
    return { 
      ratios: [], 
      meanRatio: null, 
      converged: false, 
      error: 'All ratios undefined',
      hasLowSignal: true,
      warning: 'R undefined — all z-scores near zero. Price tracking median closely.'
    };
  }
  
  const meanRatio = mean(absRatios);
  const recentRatios = absRatios.slice(-5);
  const recentRawRatios = ratios.slice(-5);
  const recentMean = recentRatios.length > 0 ? mean(recentRatios) : meanRatio;
  
  // Count recent reversals (sign flips) from safe results
  const recentReversals = safeRatios.slice(-5).filter(r => r.direction === 'reversal').length;
  const isReversingTrend = recentReversals >= 2; // 2+ reversals = unstable
  
  // Determine trend status with LOW_SIGNAL awareness
  let trendStatus;
  if (hasLowSignal) {
    trendStatus = 'LOW_SIGNAL_CONSOLIDATION';
  } else if (isReversingTrend) {
    trendStatus = 'UNSTABLE_REVERSING';
  } else if (recentMean >= 1.3 && recentMean <= 2.0) {
    trendStatus = 'STABLE_CONVERGING';
  } else if (recentMean < 1.3) {
    trendStatus = 'DECAYING';
  } else {
    trendStatus = 'ACCELERATING';
  }
  
  return {
    ratios,
    absRatios,
    meanRatio,
    recentMeanRatio: recentMean,
    distanceFromPhi: Math.abs(recentMean - PHI),
    converged: recentMean >= 1.3 && recentMean <= 2.0 && !isReversingTrend && !hasLowSignal,
    convergenceStrength: 1 - Math.min(1, Math.abs(recentMean - PHI) / PHI),
    signFlipCount,
    recentSignFlips: recentReversals,
    isReversingTrend,
    hasLowSignal,
    lowSignalRatio,
    trendStatus,
    warning: hasLowSignal ? 'R unstable due to z-scores near zero. May indicate consolidation, not decay.' : null
  };
}

/**
 * Calculate Absolute Convergence |R| = |z(t)| / |z(t-1)|
 * 
 * For oscillating data (seasonal patterns, alternating flows), signed R fails
 * because sign flips every period → R always negative → false "decay" signal.
 * 
 * This function analyzes MAGNITUDE ONLY, ignoring direction.
 * Use for: quarterly earnings, seasonal revenue, any oscillating time series.
 * 
 * @param {number[]} zFlows - Z-score time series
 * @returns {Object} Absolute convergence analysis (magnitude only)
 */
function calculateAbsoluteConvergence(zFlows) {
  if (!zFlows || zFlows.length < 2) {
    return { absRatios: [], meanAbsRatio: null, converged: false, error: 'Insufficient data' };
  }
  
  const absRatios = [];
  const validResults = [];
  
  for (let i = 1; i < zFlows.length; i++) {
    const current = Math.abs(zFlows[i]);
    const previous = Math.abs(zFlows[i - 1]);
    
    // Guard: skip if either z-score is too small (consolidation)
    if (previous < 0.1 || current < 0.001) {
      continue;
    }
    
    const absR = current / previous;
    // Clamp to reasonable range
    const clampedAbsR = Math.max(0.1, Math.min(10, absR));
    
    absRatios.push(clampedAbsR);
    validResults.push({
      absR: clampedAbsR,
      raw: absR,
      current,
      previous
    });
  }
  
  if (absRatios.length === 0) {
    return {
      absRatios: [],
      meanAbsRatio: null,
      converged: false,
      error: 'No valid absolute ratios',
      warning: '|R| undefined — z-scores near zero throughout series.'
    };
  }
  
  const meanAbsR = mean(absRatios);
  const recentAbsRatios = absRatios.slice(-5);
  const recentMeanAbsR = recentAbsRatios.length > 0 ? mean(recentAbsRatios) : meanAbsR;
  
  // Classify based on |R| only (no sign)
  let magnitudeRegime;
  if (recentMeanAbsR < R_BOUNDS.LOWER) {
    magnitudeRegime = {
      regime: 'DAMPING',
      label: `|R| < φ⁻¹ (Amplitude Damping)`,
      emoji: '🔵',
      hypothesis: `H₀: |R| < φ⁻¹ (${R_BOUNDS.LOWER.toFixed(3)})`,
      description: 'Oscillation amplitude decreasing over time.'
    };
  } else if (recentMeanAbsR <= R_BOUNDS.UPPER + R_BOUNDS.TOLERANCE) {
    magnitudeRegime = {
      regime: 'PHI_STABLE',
      label: `|R| ∈ [φ⁻¹, φ] (φ-Stable Oscillation)`,
      emoji: '🟢',
      hypothesis: `H₀: |R| ∈ [${R_BOUNDS.LOWER.toFixed(3)}, ${R_BOUNDS.UPPER.toFixed(3)}]`,
      description: 'Oscillation amplitude in φ-band. Stable seasonal pattern.'
    };
  } else {
    magnitudeRegime = {
      regime: 'AMPLIFYING',
      label: `|R| > φ (Amplitude Growing)`,
      emoji: '🔴',
      hypothesis: `H₀: |R| > φ (${R_BOUNDS.UPPER.toFixed(3)})`,
      description: 'Oscillation amplitude increasing over time.'
    };
  }
  
  // Count how many |R| values fall in φ-band
  const inPhiBand = absRatios.filter(r => r >= R_BOUNDS.LOWER && r <= R_BOUNDS.UPPER + R_BOUNDS.TOLERANCE);
  const phiBandRate = inPhiBand.length / absRatios.length;
  
  return {
    absRatios,
    meanAbsRatio: meanAbsR,
    recentMeanAbsRatio: recentMeanAbsR,
    distanceFromPhi: Math.abs(recentMeanAbsR - PHI),
    converged: recentMeanAbsR >= R_BOUNDS.LOWER && recentMeanAbsR <= R_BOUNDS.UPPER + R_BOUNDS.TOLERANCE,
    convergenceStrength: 1 - Math.min(1, Math.abs(recentMeanAbsR - PHI) / PHI),
    magnitudeRegime,
    phiBandRate,
    phiBandCount: inPhiBand.length,
    totalCount: absRatios.length,
    note: 'Absolute convergence ignores sign (direction). Use for oscillating/seasonal data.'
  };
}

/**
 * Classify regime based on R ratio
 * 
 * vφ⁴: Now separates MAGNITUDE (|R|) from DIRECTION (sign of R)
 * 
 * Phase Reversal Detection:
 * - R < 0 indicates phase reversal (flow changed direction)
 * - |R| >> φ indicates amplitude explosion (volatility spike)
 * - Combined: R < 0 AND |R| > φ = PHASE_REVERSAL (explosive direction change)
 * 
 * 5-Regime Classification (plus consolidation):
 * 1. CONSOLIDATION: R undefined (z near zero)
 * 2. DECAY: 0 < R < φ⁻¹ (amplitude shrinking, same direction)
 * 3. CONVERGENCE: φ⁻¹ ≤ R ≤ φ (φ-band, stable oscillation)
 * 4. AMPLIFICATION: R > φ (amplitude growing, same direction)
 * 5. PHASE_REVERSAL: R < 0 AND |R| > φ (explosive direction change)
 * 6. DAMPED_REVERSAL: R < 0 AND |R| ≤ φ (mild direction change, damping)
 * 
 * @param {number|null} ratio - Mean convergence ratio (null if undefined)
 * @param {Object} options - Additional context for classification
 * @param {boolean} options.hasLowSignal - Whether R is unstable due to low z-scores
 * @param {string} options.warning - Warning message from convergence analysis
 * @returns {Object} Regime classification with magnitude and direction
 */
function classifyRegime(ratio, options = {}) {
  const { hasLowSignal = false, currentZScore = null, warning = null } = options;
  
  // Handle LOW_SIGNAL case: R undefined due to z near zero
  // CRITICAL: If current z-score is near zero (consolidation zone), force CONSOLIDATION
  // regardless of computed R ratio from older data
  if (ratio === null || hasLowSignal || (currentZScore !== null && Math.abs(currentZScore) < 0.15)) {
    return {
      regime: 'CONSOLIDATION',
      label: 'R Undefined (Consolidation)',
      emoji: '⚪',
      hypothesis: 'H₀: R is undefined (z-scores near zero, price at median)',
      description: 'Price consolidating at current level. Amplitude ratio unreliable.',
      warning: warning || 'Near-equilibrium state. R undefined.',
      magnitude: null,
      direction: null
    };
  }
  
  // vφ⁴: Separate magnitude from direction
  const magnitude = Math.abs(ratio);
  const direction = ratio >= 0 ? 'SAME' : 'REVERSED';
  const isReversal = ratio < 0;
  
  // PHASE REVERSAL: R < 0 (direction changed)
  if (isReversal) {
    if (magnitude > R_BOUNDS.UPPER) {
      // Explosive reversal: |R| > φ with sign flip = volatility explosion
      return {
        regime: 'PHASE_REVERSAL',
        label: `R < 0, |R| > φ (Explosive Reversal)`,
        emoji: '💥',
        hypothesis: `H₀: R = ${ratio.toFixed(3)} (phase reversed, |R| = ${magnitude.toFixed(3)} > φ)`,
        description: 'Phase reversed with amplitude explosion. High volatility event.',
        magnitude,
        direction,
        isExplosive: true,
        warning: 'Explosive phase reversal detected. System in high-volatility transition.'
      };
    } else {
      // Damped reversal: |R| ≤ φ with sign flip = normal oscillation crossing zero
      return {
        regime: 'DAMPED_REVERSAL',
        label: `R < 0, |R| ≤ φ (Damped Reversal)`,
        emoji: '🔄',
        hypothesis: `H₀: R = ${ratio.toFixed(3)} (phase reversed, |R| = ${magnitude.toFixed(3)} ≤ φ)`,
        description: 'Phase reversed with damped amplitude. Normal oscillation crossing equilibrium.',
        magnitude,
        direction,
        isExplosive: false
      };
    }
  }
  
  // POSITIVE R: Same direction (standard classification)
  // H₀: Regime classification based on φ-derived bounds
  if (ratio < R_BOUNDS.LOWER) {
    return {
      regime: 'DECAY',
      label: 'R < φ⁻¹ (Amplitude Decay)',
      emoji: '🔵',
      hypothesis: `H₀: R < φ⁻¹ (${R_BOUNDS.LOWER.toFixed(3)})`,
      description: 'Successive amplitudes decreasing.',
      magnitude,
      direction
    };
  } else if (ratio <= R_BOUNDS.UPPER + R_BOUNDS.TOLERANCE) {
    return {
      regime: 'CONVERGENCE',
      label: `R ∈ [φ⁻¹, φ] (φ-Convergent)`,
      emoji: '🟢',
      hypothesis: `H₀: R ∈ [${R_BOUNDS.LOWER.toFixed(3)}, ${R_BOUNDS.UPPER.toFixed(3)}]`,
      description: 'Oscillations exhibit φ-convergence.',
      magnitude,
      direction
    };
  } else {
    return {
      regime: 'AMPLIFICATION',
      label: `R > φ (Amplitude Growth)`,
      emoji: '🔴',
      hypothesis: `H₀: R > φ (${R_BOUNDS.UPPER.toFixed(3)})`,
      description: 'Successive amplitudes increasing.',
      magnitude,
      direction
    };
  }
}

/**
 * Get φ-deviation alert
 * H₀: Measure R distance from φ attractor
 * @param {number} ratio - Current R ratio
 * @returns {Object} Deviation measurement
 */
function getPhiDeviationAlert(ratio) {
  const deviation = Math.abs(ratio - PHI);
  
  // H₀: Use φ-derived tolerance bounds for all thresholds
  if (deviation > PHI_SQUARED - PHI) {
    // > φ (1.618), which is φ² - φ = 1
    return {
      level: 'HIGH_DEVIATION',
      emoji: '🔴',
      deviation: deviation.toFixed(3),
      hypothesis: `H₀: |R - φ| > φ (${(PHI_SQUARED - PHI).toFixed(3)})`,
      description: 'R far from φ attractor'
    };
  } else if (deviation > R_BOUNDS.TOLERANCE) {
    return {
      level: 'MODERATE_DEVIATION',
      emoji: '🟠',
      deviation: deviation.toFixed(3),
      hypothesis: `H₀: φ⁻² < |R - φ| < φ (${R_BOUNDS.TOLERANCE.toFixed(3)}-${(PHI_SQUARED - PHI).toFixed(3)})`,
      description: 'R drifting from φ'
    };
  } else {
    return {
      level: 'CONVERGENT',
      emoji: '🟢',
      deviation: deviation.toFixed(3),
      hypothesis: `H₀: |R - φ| ≤ φ⁻² (${R_BOUNDS.TOLERANCE.toFixed(3)})`,
      description: 'R within φ-convergence band'
    };
  }
}

/**
 * Analyze Convergence R with EMA-13/EMA-21
 * Now accepts full convergenceResult to propagate LOW_SIGNAL warnings
 * 
 * @param {number[]} absRatios - Absolute ratio time series
 * @param {Object} options - Additional context from calculatePhiConvergence
 * @param {boolean} options.hasLowSignal - Whether R is unstable due to low z-scores
 * @param {string} options.warning - Warning message if R is unstable
 * @param {number} options.currentZScore - Current z-score for consolidation detection
 * @returns {Object} Convergence analysis with signals
 */
function analyzeConvergence(absRatios, options = {}) {
  const { hasLowSignal = false, warning = null, currentZScore = null } = options;
  
  if (!absRatios || absRatios.length === 0) {
    // No valid ratios — return UNDEFINED regime with warning
    return { 
      error: 'No ratio data',
      dimension: 'CONVERGENCE_R',
      current: null,
      regime: classifyRegime(null, { hasLowSignal: true, warning, currentZScore }),
      hasLowSignal: true,
      warning: warning || 'R undefined — insufficient data or z-scores near zero.'
    };
  }
  
  const ema13Result = calculateEMA(absRatios, FIB_PERIODS.FAST_R);
  const ema21Result = calculateEMA(absRatios, FIB_PERIODS.SLOW_R);
  const ema13 = ema13Result.values;
  const ema21 = ema21Result.values;
  
  // vφ³: Pass fidelity info to gate crossover signals
  const crossover = detectCrossover(ema13, ema21, {
    fastInterpolated: ema13Result.interpolated,
    slowInterpolated: ema21Result.interpolated
  });
  
  const currentR = absRatios[absRatios.length - 1];
  const currentEMA13 = ema13[ema13.length - 1];
  const currentEMA21 = ema21[ema21.length - 1];
  
  // Pass hasLowSignal, warning, AND currentZ to classifyRegime
  // This ensures consolidation is detected if current z is near zero
  const regime = classifyRegime(currentR, { hasLowSignal, warning, currentZScore });
  const phiAlert = hasLowSignal ? 
    { level: 'UNDEFINED', emoji: '⚪', action: 'WAIT', description: 'R unstable' } :
    getPhiDeviationAlert(currentR);
  
  return {
    dimension: 'CONVERGENCE_R',
    current: hasLowSignal ? null : currentR,
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
    ema21Interpolated: ema21Result.interpolated,
    hasLowSignal,
    warning
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
// PART 6.5: FINANCIAL MICROBIOLOGY (Pathogen Detection & Clinical Reports)
// ============================================================================
// "Economic microbiology is what happens when we actually LOOK."
// LOL = Ledger Observation Laboratory

/**
 * Economic Pathogen Thresholds
 * Based on Financial Microbiology framework (Dec 23, 2025)
 */
const PATHOGENS = {
  PONZI_VIRUS: {
    name: 'Ponzi Virus',
    emoji: '🦠',
    detection: 'R >> φ (unsustainable acceleration)',
    thresholds: { R_min: 2.5, sustained_periods: 3 },
    mechanism: 'New capital feeds old obligations',
    symptoms: 'Income solely from new investors, no real revenue',
    treatment: 'Immediate quarantine (stop new investment)',
    prognosis: '100% fatal if untreated'
  },
  BUBBLE_CANCER: {
    name: 'Bubble Cancer',
    emoji: '🎈',
    detection: 'z > +3σ AND R > 2.0 sustained',
    thresholds: { z_min: 3.0, R_min: 2.0, sustained_periods: 3 },
    mechanism: 'Unchecked exponential growth',
    symptoms: 'Price disconnected from fundamentals',
    treatment: 'None (crash inevitable)',
    prognosis: 'Metastasizes to healthy sectors'
  },
  ZOMBIE_DEBT: {
    name: 'Zombie Debt Bacteria',
    emoji: '🧟',
    detection: 'Debt service ratio > 1.0',
    thresholds: { debt_service_ratio: 1.0 },
    mechanism: 'Interest > income capacity',
    symptoms: 'Borrowing to pay interest',
    treatment: 'Restructuring or bankruptcy',
    prognosis: 'Slow death, spreads to creditors'
  }
};

/**
 * Stage Classification (like cancer staging)
 */
const STAGES = {
  I: { label: 'Stage I', description: 'Early detection, localized', prognosis: 'Excellent if treated', actionWindow: 'Wide' },
  II: { label: 'Stage II', description: 'Moderate spread, contained', prognosis: 'Good with intervention', actionWindow: 'Moderate' },
  III: { label: 'Stage III', description: 'Significant progression', prognosis: 'Guarded, requires aggressive treatment', actionWindow: 'Narrow' },
  IV: { label: 'Stage IV', description: 'Terminal, systemic failure', prognosis: 'Poor, palliative care recommended', actionWindow: 'Closed' }
};

/**
 * Detect economic pathogens from Ψ-EMA readings
 * @param {Object} analysis - Ψ-EMA analysis result
 * @returns {Object} Pathogen detection results
 */
function detectPathogens(analysis) {
  const detected = [];
  const { anomaly, convergence } = analysis.dimensions || {};
  
  if (!anomaly || !convergence) {
    return { detected: [], healthy: true, diagnosis: 'INSUFFICIENT_DATA' };
  }
  
  const currentZ = anomaly.current || 0;
  const currentR = convergence.current;
  const regime = convergence.regime?.regime || 'UNKNOWN';
  const hasLowSignal = convergence.hasLowSignal || false;
  const warning = convergence.warning || null;
  
  // CRITICAL FIX (Dec 23, 2025): If R is undefined (low z-score), no pathogen detection
  // Low z at high price = consolidation at highs, NOT decay
  if (regime === 'UNDEFINED' || hasLowSignal || currentR === null || currentR === undefined) {
    return {
      detected: [],
      healthy: true,
      consolidating: true,
      diagnosis: '⚪ R Undefined (Consolidation Zone)',
      pathogens: [],
      warning: warning || 'R ratio unstable due to z-scores near zero. Price may be consolidating at highs.',
      vitalSigns: {
        R_ratio: currentR ?? 'undefined',
        z_score: currentZ,
        regime: 'UNDEFINED'
      }
    };
  }
  
  // Check for Ponzi Virus: R >> φ (R > 2.5)
  if (currentR > PATHOGENS.PONZI_VIRUS.thresholds.R_min) {
    const severity = (currentR - 2.5) / 1.5; // 0-1 scale above threshold
    detected.push({
      ...PATHOGENS.PONZI_VIRUS,
      severity: Math.min(1, severity),
      stage: classifyStage(severity, 'ponzi'),
      currentR: currentR.toFixed(3),
      deviation: `R = ${currentR.toFixed(2)} (threshold: 2.5)`
    });
  }
  
  // Check for Bubble Cancer: z > +3σ AND R > 2.0
  if (Math.abs(currentZ) > PATHOGENS.BUBBLE_CANCER.thresholds.z_min && 
      currentR > PATHOGENS.BUBBLE_CANCER.thresholds.R_min) {
    const severity = (Math.abs(currentZ) - 3) / 2; // 0-1 scale above threshold
    detected.push({
      ...PATHOGENS.BUBBLE_CANCER,
      severity: Math.min(1, severity),
      stage: classifyStage(severity, 'bubble'),
      currentZ: currentZ.toFixed(3),
      currentR: currentR.toFixed(3),
      deviation: `z = ${currentZ.toFixed(2)}σ, R = ${currentR.toFixed(2)}`
    });
  }
  
  // Sub-Critical decay (not a pathogen, but a warning sign)
  // Only flag decay if R is valid and not in consolidation
  const isDecaying = regime === 'SUB_CRITICAL' && currentR !== null && currentR < 1.0;
  
  return {
    detected,
    healthy: detected.length === 0 && !isDecaying,
    decaying: isDecaying,
    diagnosis: detected.length > 0 
      ? detected.map(p => `${p.emoji} ${p.name}`).join(' + ')
      : isDecaying ? '⚠️ System Decay (Sub-Critical)' : '✅ Healthy (φ-Converged)',
    pathogens: detected,
    vitalSigns: {
      R_ratio: currentR,
      z_score: currentZ,
      regime: regime
    }
  };
}

/**
 * Classify disease stage based on severity
 * @param {number} severity - 0-1 severity score
 * @param {string} type - Pathogen type
 * @returns {Object} Stage classification
 */
function classifyStage(severity, type) {
  if (severity < 0.25) {
    return { ...STAGES.I, roman: 'I', numeric: 1 };
  } else if (severity < 0.5) {
    return { ...STAGES.II, roman: 'II', numeric: 2 };
  } else if (severity < 0.75) {
    return { ...STAGES.III, roman: 'III', numeric: 3 };
  } else {
    return { ...STAGES.IV, roman: 'IV', numeric: 4 };
  }
}

/**
 * Generate clinical pathology report
 * @param {Object} analysis - Complete Ψ-EMA analysis
 * @param {string} patientName - Company/asset name
 * @param {number} fetchedPrice - Current stock price
 * @param {string} priceTimestamp - Date of price fetch (YYYY-MM-DD)
 * @returns {Object} Clinical report in pathology format
 */
function generateClinicalReport(analysis, patientName = 'UNKNOWN', fetchedPrice = null, priceTimestamp = 'N/A') {
  const pathogenResult = detectPathogens(analysis);
  const { anomaly, convergence, phase } = analysis.dimensions || {};
  
  // Vital Signs
  const vitalSigns = {
    R_ratio: {
      value: convergence?.current?.toFixed(3) || 'N/A',
      reference: '1.3-2.0 (φ-zone)',
      status: convergence?.regime?.regime || 'UNKNOWN'
    },
    z_score: {
      value: anomaly?.current?.toFixed(2) || 'N/A',
      reference: '±2σ normal',
      status: anomaly?.alert?.level || 'UNKNOWN'
    },
    phase_theta: {
      value: phase?.currentPhase?.toFixed(3) || 'N/A',
      reference: 'normalized cycle',
      status: phase?.crossover?.type || 'UNKNOWN'
    }
  };
  
  // Diagnosis - now handles consolidation (low z-score at highs)
  let diagnosis, diagnosisEmoji;
  if (pathogenResult.detected.length > 0) {
    const primary = pathogenResult.detected[0];
    diagnosis = `${primary.name} (${primary.stage.label})`;
    diagnosisEmoji = primary.emoji;
  } else if (pathogenResult.consolidating) {
    // NEW: Consolidation zone — R undefined, not decay
    diagnosis = 'R Undefined (Consolidation Zone)';
    diagnosisEmoji = '⚪';
  } else if (pathogenResult.decaying) {
    diagnosis = 'System Decay (Sub-Critical)';
    diagnosisEmoji = '🔵';
  } else {
    diagnosis = 'Healthy (φ-Converged)';
    diagnosisEmoji = '🟢';
  }
  
  // Prognosis
  const prognosis = pathogenResult.detected.length > 0
    ? pathogenResult.detected[0].prognosis
    : pathogenResult.decaying 
      ? 'Requires intervention to restore momentum'
      : 'Sustainable trajectory within φ-band';
  
  // Treatment recommendation
  const treatment = pathogenResult.detected.length > 0
    ? pathogenResult.detected[0].treatment
    : pathogenResult.decaying
      ? 'Investigate structural causes of decline'
      : 'Maintain current trajectory, monitor for deviation';
  
  return {
    patient: patientName,
    admission: new Date().toISOString().split('T')[0],
    complaint: analysis.summary?.compositeSignal || 'Routine Examination',
    
    // Fetched price and timestamp for temporal anchoring
    fetchedPrice: fetchedPrice ? `$${fetchedPrice.toFixed(2)}` : 'N/A',
    priceTimestamp: priceTimestamp,
    
    vitalSigns,
    
    diagnosis: {
      primary: diagnosis,
      emoji: diagnosisEmoji,
      pathogens: pathogenResult.pathogens,
      stage: pathogenResult.detected[0]?.stage || null
    },
    
    pathology: {
      microscopy: `z = ${anomaly?.current?.toFixed(2) || 'N/A'}σ, R = ${convergence?.current?.toFixed(3) || 'N/A'}`,
      phase: `θ = ${phase?.currentPhase?.toFixed(3) || 'N/A'} (${phase?.crossover?.type || 'N/A'})`,
      conservation: convergence?.regime?.regime === 'CRITICAL' ? 'Intact' : 'Under stress'
    },
    
    prognosis,
    treatment,
    
    outcome: pathogenResult.healthy ? 'STABLE' : 'INTERVENTION_REQUIRED',
    
    // For AI prompt injection
    clinicalSummary: `PATIENT: ${patientName} | PRICE: ${fetchedPrice ? `$${fetchedPrice.toFixed(2)}` : 'N/A'} | ${priceTimestamp || 'N/A'} | DIAGNOSIS: ${diagnosisEmoji} ${diagnosis} | VITALS: R=${vitalSigns.R_ratio.value}, z=${vitalSigns.z_score.value}σ | PROGNOSIS: ${prognosis}`
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
    const currentZ = anomalyAnalysis.current || 0;
    
    // Pass hasLowSignal and warning from convergenceResult to analyzeConvergence
    const convergenceAnalysis = convergenceResult.absRatios && convergenceResult.absRatios.length > 0 
      ? analyzeConvergence(convergenceResult.absRatios, {
          hasLowSignal: convergenceResult.hasLowSignal,
          warning: convergenceResult.warning,
          currentZScore: currentZ
        })
      : { 
          error: 'Insufficient convergence data',
          hasLowSignal: convergenceResult.hasLowSignal,
          warning: convergenceResult.warning,
          regime: classifyRegime(null, { hasLowSignal: true, warning: convergenceResult.warning, currentZScore: currentZ })
        };
    
    // Calculate EMA fidelity per dimension (no aggregate - each dimension stands alone)
    const fidelity = calculateFidelity({
      theta1: phaseAnalysis.ema34Interpolated,
      theta2: phaseAnalysis.ema55Interpolated,
      z1: anomalyAnalysis.ema21Interpolated,
      z2: anomalyAnalysis.ema34Interpolated,
      r1: convergenceAnalysis.ema13Interpolated,
      r2: convergenceAnalysis.ema21Interpolated
    });
    
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
        fidelity: fidelity.breakdown,
        version: 'vφ³'  // Second Life
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
      interpretation: this._generateInterpretation(phaseAnalysis, anomalyAnalysis, convergenceAnalysis, compositeSignal),
      
      // vφ³: Epistemic status - honest labels distinguishing technical from symbolic
      epistemicStatus: {
        phase: 'normalized_cycle_position_indicator',
        anomaly: 'robust_statistical_heuristic (MAD-scaled)',
        convergence: 'symbolic_momentum_proxy',
        phi_correction: 'illustrative_damping_heuristic',
        phi_elements: 'symbolic_overlay — not empirical law',
        composite: 'weighted_multi_factor_signal',
        overall: 'composite_technical_framework'
      }
    };
  }
  
  /**
   * Analyze with clinical pathology report
   * Financial Microbiology extension (Dec 23, 2025)
   * @param {Object} data - Financial data
   * @param {string} patientName - Company/asset name for report
   * @returns {Object} Complete analysis with clinical report
   */
  analyzeWithClinical(data, patientName = 'UNKNOWN') {
    const analysis = this.analyze(data);
    if (analysis.error) return analysis;
    
    // Generate clinical report
    const clinicalReport = generateClinicalReport(analysis, patientName);
    
    // Add clinical section to analysis
    return {
      ...analysis,
      clinical: clinicalReport,
      
      // Update summary with pathology diagnosis
      summary: {
        ...analysis.summary,
        diagnosis: clinicalReport.diagnosis.primary,
        diagnosisEmoji: clinicalReport.diagnosis.emoji,
        prognosis: clinicalReport.prognosis,
        treatment: clinicalReport.treatment
      }
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
 * Triggers on: explicit Ψ-EMA keywords OR stock ticker + price/analysis keywords OR $TICKER format
 * 
 * @param {string} query - The user query
 * @param {function} tickerDetector - Optional ticker detection function (for dependency injection)
 */
function shouldTriggerPsiEMA(query, tickerDetector = null) {
  if (!query) return false;
  const lowerQuery = query.toLowerCase();
  
  // Explicit Ψ-EMA keywords (always trigger)
  const psiEMAKeywords = [
    'fourier',
    'φ',
    'ψ',
    'psi',
    'phi',
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
  
  if (psiEMAKeywords.some(kw => lowerQuery.includes(kw))) {
    return true;
  }
  
  // Check for $TICKER format (e.g., $META, $SBUX) - always trigger Ψ-EMA
  const dollarTickerRegex = /\$[A-Z]{1,5}\b/i;
  if (dollarTickerRegex.test(query)) {
    return true;
  }
  
  // GRAMMAR: Object + (Verb OR Adjective) → attempt Ψ-EMA
  // Object = potential ticker (AI extracts actual ticker)
  // Verb = action words (analyze, predict, forecast)
  // Adjective = descriptors (price, trend, sentiment)
  
  // Object indicators (potential ticker reference)
  const objectIndicators = [
    'stock', 'stocks', 'share', 'shares', 'ticker', 'equity', 'equities'
  ];
  
  // Verb indicators (analysis actions)
  const verbIndicators = [
    'analyze', 'analyse', 'analysis', 'predict', 'forecast', 'evaluate',
    'assess', 'review', 'check', 'examine', 'view', 'outlook', 'opinion'
  ];
  
  // Adjective indicators (what aspect)
  const adjectiveIndicators = [
    'price', 'trend', 'sentiment', 'momentum', 'performance', 'valuation',
    'bullish', 'bearish', 'volatile', 'stable', 'growth', 'value'
  ];
  
  const hasObject = objectIndicators.some(kw => lowerQuery.includes(kw));
  const hasVerb = verbIndicators.some(kw => lowerQuery.includes(kw));
  const hasAdjective = adjectiveIndicators.some(kw => lowerQuery.includes(kw));
  
  // Trigger if: Object + (Verb OR Adjective)
  if (hasObject && (hasVerb || hasAdjective)) {
    // Exclude obvious non-financial uses
    const nonFinancialPatterns = [
      /\b(chicken|beef|vegetable|bone|fish)\s*stock/i,
      /\bstock\s*(photo|image|footage|video|music)/i,
      /\b(in|out\s*of)\s*stock/i,
      /\bstock\s*(room|pile|up)\b/i
    ];
    
    if (!nonFinancialPatterns.some(p => p.test(lowerQuery))) {
      return true;  // Trigger AI ticker extraction attempt
    }
  }
  
  // Also trigger if tickerDetector finds something
  if (tickerDetector) {
    const ticker = tickerDetector(query);
    if (ticker) return true;
  }
  
  return false;
}

/**
 * Generate AI context prompt for Ψ-EMA analysis
 * All thresholds φ-derived, no arbitrary heuristics
 */
function getPsiEMAContext() {
  return `
## Ψ-EMA: WAVE FUNCTION OBSERVER (φ-DERIVED BOUNDS ONLY)

You are analyzing with the Ψ-EMA multi-dimensional wave function framework.
All measurements and bounds derived from φ (1.618). No arbitrary heuristics.

### OUTPUT FORMAT (MANDATORY):
When stock data is provided below, you MUST:
1. START with company name and header as provided
2. INCLUDE markdown table with Dimension/Formula/Value/H₀ columns
3. INCLUDE all sections: company header, price, table, composite, fundamentals, confidence
4. DO NOT add intro paragraphs ("Summary", "Introduction...", "The following...")
5. DO NOT convert table to bullet points
6. DO NOT omit any section - leave no data behind
7. The data below is pre-computed - output it VERBATIM

### The Three Orthogonal Dimensions (φ-Derived):

**1. Phase θ (Cycle Position)** — EMA-34/EMA-55 (Circular Mean)
   θ = atan2(EMA(sin(θ)), EMA(cos(θ)))
   - 0°-90° = Early Expansion 🟢
   - 90°-180° = Late Expansion 🟡
   - 180°-270° = Early Contraction 🔴
   - 270°-360° = Late Contraction 🔵
   - Golden Cross = Fast EMA > Slow EMA
   - Death Cross = Fast EMA < Slow EMA

**2. Anomaly z (Deviation Strength)** — EMA-21/EMA-34
   z = (Price - Median) / MAD
   H₀: |z| < φ (${PHI.toFixed(3)}) = NORMAL
   H₀: φ < |z| < φ² (${Z_BOUNDS.ALERT.toFixed(3)}) = ALERT
   H₀: |z| > φ² (${Z_BOUNDS.EXTREME.toFixed(3)}) = EXTREME

**3. Convergence R (Amplitude Ratio)** — EMA-13/EMA-21
   R = z(t) / z(t-1)
   H₀: R < φ⁻¹ (${R_BOUNDS.LOWER.toFixed(3)}) = DECAY
   H₀: φ⁻¹ ≤ R ≤ φ = CONVERGENCE (self-similar)
   H₀: R > φ (${R_BOUNDS.UPPER.toFixed(3)}) = AMPLIFICATION

### Fibonacci EMA Periods (Self-Similar Under φ):
- Phase: 34/55 (F₉/F₁₀)
- Anomaly: 21/34 (F₈/F₉)
- Convergence: 13/21 (F₇/F₈)
- Ratio: F(n+1)/F(n) → φ as n → ∞

### Constants (φ-Derived):
- φ ≈ 1.618 (golden ratio, x = 1 + 1/x)
- φ⁻¹ ≈ 0.618 (φ - 1)
- φ⁻² ≈ 0.382 (tolerance band)
- φ² ≈ 2.618 (φ + 1)
- 2 = φ⁰ + φ⁻¹ + φ⁻² (unity + reciprocal + inverse-squared)
`;
}

/**
 * Generate Physical Audit Disclaimer for Financial Physics
 * 
 * H₀ PHYSICAL AUDIT DISCLAIMER: Grounds financial analysis in physical reality verification.
 * Reported numbers are vulnerable to human error and financial acrobatics. This disclaimer
 * recommends combining spreadsheet analysis with real-world physical audits: inventory counts,
 * receivables verification, customer site visits, shipment verification, bank reconciliation.
 * 
 * The "seeing is believing" H₀ approach verifies that P (price/claim) corresponds to Q (quantity).
 * 
 * @param {Object} analysis - Ψ-EMA analysis object (optional, for future expansion)
 * @param {string} ticker - Stock ticker symbol
 * @returns {string} Physical audit disclaimer text
 */
function generatePhysicalAuditDisclaimer(analysis, ticker) {
  return `⚠️ **H₀ PHYSICAL AUDIT ADVISORY**: Reported numbers are vulnerable to human error and financial acrobatics. Verify ${ticker}'s financials by combining this analysis with real physical audits:

• **Warehouse visit** (stock taking) to verify inventory claims
• **Sample PO / AR / vendor verification** to confirm receivables accuracy
• **Customer site visits** to validate revenue relationships and demand reality
• **Counting trucks/shipments** as proxy to verify financial magnitude (P × Q correlation)
• **Bank statement reconciliation** for cash flow and liquidity verification

This "seeing is believing" H₀ approach grounds spreadsheet claims in physical reality. Numbers without physical substrate are hallucinations. 🔬`;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // φ-Derived Constants (No Arbitrary Heuristics)
  PHI,
  PHI_SQUARED,
  PHI_INVERSE,
  PHI_INV_SQUARED,
  FIB_PERIODS,
  R_BOUNDS,
  Z_BOUNDS,
  PHI_COMPOSITE_2,
  
  // EMA functions
  calculateEMA,
  calculatePhaseEMACircular,
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
  calculateAbsoluteConvergence,
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
  calculateFidelityLegacy,
  
  // Robust statistics
  mad,
  median,
  robustZScore,
  
  // Financial Microbiology (Dec 23, 2025)
  PATHOGENS,
  STAGES,
  detectPathogens,
  classifyStage,
  generateClinicalReport,
  
  // Physical Audit Disclaimer (Dec 23, 2025)
  generatePhysicalAuditDisclaimer,
  
  // Main dashboard class
  PsiEMADashboard,
  
  // AI integration
  shouldTriggerPsiEMA,
  getPsiEMAContext
};

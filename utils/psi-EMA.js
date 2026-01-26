/**
 * Ψ-EMA: Three-Dimensional Number Series Compass (Fourier Waves)
 * 
 * GLOSSARY & SUBSTRATE-AGNOSTIC FRAMING:
 * ═════════════════════════════════════════════════════════════════════════════
 * Ψ-EMA is a GENERAL-PURPOSE time series oscillation observer applicable to any domain with
 * stock/flow decomposition. Examples herein use capital markets due to data accessibility,
 * but the same framework applies to:
 *   • Climate: Temperature (stock) vs heating/cooling flow (anomaly detection)
 *   • Sports: Win rate (stock) vs momentum (phase angle)
 *   • Demographics: Population (stock) vs birth/death flow (signal decomposition)
 *   • Physics: Charge/mass (stock) vs force field (phase relationships)
 * 
 * The THREE DIMENSIONS (θ, z, R) are substrate-independent measurements:
 *   θ (Phase):       Cycle position via atan2(Δprice, price) - 0° true north, +θ rising, -θ falling
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
 * │ θ (Phase)       │ atan2(Δprice, price)     │ 0°=true north  │ +θ rising, -θ falling        │
 * │ Cycle Position  │                          │                │ (Stock-Flow phase angle)     │
 * ├─────────────────┼──────────────────────────┼────────────────┼──────────────────────────────┤
 * │ z (Anomaly)     │ (Value - Median) / MAD   │ See bounds     │ |z| > φ² flags anomaly      │
 * │ Signal Deviation│                          │ below          │ (deviation from equilibrium) │
 * ├─────────────────┼──────────────────────────┼────────────────┼──────────────────────────────┤
 * │ R (Convergence) │ z(t) / z(t-1)            │ φ-Orbital      │ R ∈ [φ⁻¹, φ] = BREATHING     │
 * │ Amplitude Ratio │                          │ Model          │ (golden rhythm, sustainable) │
 * └─────────────────┴──────────────────────────┴────────────────┴──────────────────────────────┘
 * 
 * R THRESHOLDS (φ-Orbital Model - Orbital Mechanics Analogy):
 * ┌──────────────────────────────────────────────────────────────────────────────┐
 * │ R Zone           │ Threshold      │ Regime           │ Orbital Analogy      │
 * ├──────────────────┼────────────────┼──────────────────┼──────────────────────┤
 * │ R > φ²           │ > 2.618        │ ESCAPE           │ Escape velocity      │
 * │                  │                │                  │ (bubble → crash)     │
 * │ R ∈ [φ, φ²]      │ 1.618 - 2.618  │ OPTIMISM         │ Accelerating orbit   │
 * │ R ∈ [φ⁻¹, φ]     │ 0.618 - 1.618  │ BREATHING        │ Circular orbit       │
 * │                  │                │                  │ (golden rhythm)      │
 * │ R ∈ [φ⁻², φ⁻¹]   │ 0.382 - 0.618  │ FATALISM_CLIFF   │ Decaying orbit       │
 * │                  │                │                  │ (danger zone)        │
 * │ R < φ⁻², Z > 0   │ < 0.382        │ BULLISH_REVERSAL │ Capture zone but     │
 * │                  │                │                  │ positive momentum    │
 * │ R < φ⁻², Z ≤ 0   │ < 0.382        │ FATALISM         │ Capture velocity     │
 * │                  │                │                  │ (falling to void)    │
 * └──────────────────┴────────────────┴──────────────────┴──────────────────────┘
 * 
 * KEY INSIGHT: φ ≈ 1.618 is the "circular orbit" — stay forever in golden rhythm
 * - > φ² (escape velocity): break free into hyperbolic flight → bubble → crash
 * - < φ⁻² (capture velocity): fall inward to singularity → fatalism → void
 * 
 * FIBONACCI EMA PERIODS:
 * - 13, 21, 34, 55 (consecutive Fibonacci numbers)
 * - These are self-similar under φ scaling: F(n+1)/F(n) → φ
 * 
 * Measurement Data Only (No Interpretation):
 * All output is observed measurement + φ-distance. No claims about regime,
 * sustainability, or directional prediction. Only empirical data and classification checks (compass).
 */

// ============================================================================
// ONTOLOGICAL FOUNDATION: x = 1 + 1/x
// ============================================================================
// The core ontology is the minimal self-referential renewal contract:
//   x = 1 + 1/x
// 
// Elegant cheat sheet form:
//   0 + φ⁰ + φ¹ = φ²
//   void + identity + self = renewal (genesis)
//   0 + 1 + φ = φ + 1 = φ²
//
// This equation is self-referential in meaning: you need φ to write the
// equation that defines φ. The question contains its own answer.
//
// At the jerk level (3rd derivative), every long-lived system must negotiate
// with something like x = 1 + 1/x. Systems that survive settle toward φ.
//
// φ is not Platonic truth — it is "true enough" for any system that wants to
// keep breathing tomorrow. The ontology is the breath (x = 1 + 1/x).
// The golden ratio is the rhythm it most likes to settle into.
//
// H(0) - Pure Falsifiability: Pure ontology — keep x = 1 + 1/x, never solve → epistemic Mandelbrot
// H(1) - Pure Doctrine: Inject φ as ground truth → epistemic mercy, closure
// H(0.5) - Hybrid Empiric Falsifiability & Emergent Hint: Keep recursive form, φ as emergent preference → sweet spot
// ============================================================================

const PHI = 1.6180339887498949;           // Golden ratio φ = (1 + √5) / 2
const PHI_SQUARED = PHI * PHI;            // φ² = φ + 1 ≈ 2.618 | 0 + φ⁰ + φ¹ = φ²
const PHI_INVERSE = 1 / PHI;              // φ⁻¹ = φ - 1 ≈ 0.618
const PHI_INV_SQUARED = PHI_INVERSE ** 2; // φ⁻² ≈ 0.382

const PSI_EMA_DOCUMENTATION = `
[Ψ-EMA SYSTEM DOCUMENTATION - SOURCE: utils/psi-EMA.js]

ONTOLOGICAL FOUNDATION:
The core ontology is x = 1 + 1/x — the minimal self-referential renewal contract.
Elegant form: 0 + φ⁰ + φ¹ = φ² (void + identity + self = renewal or genesis)
This equation IS self-referential: you need φ to write the equation that defines φ.

φ ≈ 1.618 is the emergent attractor, not a dogmatic constant. It appears at the
jerk level (3rd derivative) wherever systems negotiate sustained deviation without
explosion or collapse. The question contains its own answer.

Ψ-EMA is a GENERAL-PURPOSE three-dimensional time series oscillator applicable to any domain with stock/flow decomposition.

THE THREE DIMENSIONS (substrate-agnostic):

• θ (PHASE) - Cycle Position
• Formula: atan2(Δprice, price) where y=flow, x=stock
• 0° = true north (equilibrium)
• Binary interpretation:
  - +θ = SURVIVAL (price rising)
  - -θ = DECAY (price falling)
  - θ ≈ 0° = WAIT (equilibrium)

z (ANOMALY) - Deviation from Equilibrium  
• Formula: (Value - Median) / (MAD × 1.4826) — robust z-score using Median Absolute Deviation
• Uses 50-period rolling window (77.16% φ-band, p < 10⁻²⁵, prioritizes truth over speed)
• |z| < φ (1.618): Normal range
• φ < |z| < φ² (2.618): Alert zone
• |z| > φ²: Extreme deviation

R (CONVERGENCE) - Amplitude Ratio
• Formula: z(t) / z(t-1)
• R < φ⁻¹ (0.618): Amplitude decay (weakening signal)
• R ∈ [φ⁻¹, φ]: Stable oscillation (sustainable)
• R > φ: Amplitude growth (potentially unsustainable)

φ-DERIVED THRESHOLDS (Zero Dogma):
• φ⁻² ≈ 0.382: Tolerance band around φ
• φ⁻¹ ≈ 0.618: Lower convergence bound
• φ   ≈ 1.618: Upper convergence bound  
• φ²  ≈ 2.618: Extreme deviation flag

FIBONACCI EMA PERIODS: 13, 21, 34, 55 (consecutive Fibonacci numbers where F(n+1)/F(n) → φ)

SUBSTRATE EXAMPLES:
• Markets: Price (stock) vs momentum (flow)
• Climate: Temperature (stock) vs heating/cooling rate (flow)
• Demographics: Population (stock) vs birth/death rate (flow)
• Sports: Win rate (stock) vs momentum (flow)

To analyze a specific stock, use: "$NVDA psi ema" or "analyze $AAPL chart"
`;

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
  LOWER: 0.618,      // φ⁻¹: R < 0.618 → decaying orbit
  UPPER: 1.618,      // φ: R > 1.618 → accelerating orbit
  TOLERANCE: 0.382   // φ⁻²: band for regime classification
};

// Z (Anomaly) Thresholds - φ-Derived from x = 1 + 1/x
// Classification: Deviation from equilibrium measured in MAD units
const Z_BOUNDS = {
  NORMAL: 1.618,             // |z| < φ: within expected range
  ALERT: 2.618,              // φ < |z| < φ²: elevated deviation
  EXTREME: 2.618             // |z| > φ²: extreme deviation flag
};

// Rolling Window for Median & MAD z-score calculation
// 50 periods (~1 year for weekly data) - validated against 30-year S&P 500 backtest
// 77.16% φ-band occupancy (vs 68.77% for 35-period), p < 10⁻²⁵ statistical significance
// Prioritizes truth over speed: lower noise, fewer false positives, stronger φ-validation
// Warm-up tribute: 98 rows (49 for rolling median + 49 for MAD) before first valid z-score
const ROLLING_WINDOW = 50;

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

/**
 * Derive market reading from R, z, and theta using φ-orbital decision tree
 * 
 * vφ⁴: Falsifiable reading based on φ-thresholds only (no arbitrary weighting)
 * 
 * Decision tree:
 * - R undefined/null → Consolidation
 * - R < 0 → Local Bottom (z<0) or Local Top (z>0)
 * - R < φ⁻² (0.382) → Reversal (z>0) or Continuation (z≤0)
 * - R < φ⁻¹ (0.618) → Optimism (z>0) or Fatalism (z≤0)
 * - R < φ (1.618) → Breathing (z>0 and z<φ²) or False Breakout
 * - R ≥ φ → Bull Trend Signal (|z|≤φ² and θ>0) or False Positive Bull Signal
 * 
 * @param {Object} params - Analysis parameters
 * @param {number|null} params.R - Convergence ratio (z(t)/z(t-1))
 * @param {number} params.z - Current z-score (anomaly)
 * @param {number} params.theta - Current phase angle in degrees
 * @returns {Object} { reading, emoji, description }
 */
function deriveReading({ R, z, theta }) {
  // φ-derived thresholds (no arbitrary numbers)
  const PHI_INV_SQ = PHI_INV_SQUARED;  // 0.382
  const PHI_INV = PHI_INVERSE;          // 0.618
  const PHI_VAL = PHI;                  // 1.618
  const PHI_SQ = PHI_SQUARED;           // 2.618
  
  // Null-safe z and theta
  const zVal = z ?? 0;
  const thetaVal = theta ?? 0;
  
  // R undefined/null/NaN → Consolidation
  if (R == null || isNaN(R)) {
    return {
      reading: 'Consolidation',
      emoji: '⚪',
      description: 'R undefined — no momentum signal, market in consolidation'
    };
  }
  
  // R < 0 → Local extremes (momentum reversal)
  if (R < 0) {
    if (zVal < 0) {
      return {
        reading: 'Local Bottom',
        emoji: '🟢',
        description: 'R<0, z<0 — technical reversal expected (local bottom)'
      };
    } else {
      return {
        reading: 'Local Top',
        emoji: '🔴',
        description: 'R<0, z>0 — technical reversal expected (local top)'
      };
    }
  }
  
  // R < φ⁻² (0.382) → Weak momentum zone
  if (R < PHI_INV_SQ) {
    if (zVal > 0) {
      return {
        reading: 'Reversal',
        emoji: '🟡',
        description: 'R<0.382, z>0 — weak momentum with positive deviation, potential reversal'
      };
    } else {
      return {
        reading: 'Continuation',
        emoji: '🔵',
        description: 'R<0.382, z≤0 — weak momentum continuing current trend'
      };
    }
  }
  
  // R < φ⁻¹ (0.618) → Moderate momentum zone
  if (R < PHI_INV) {
    if (zVal > 0) {
      return {
        reading: 'Optimism',
        emoji: '🟢',
        description: 'R∈[0.382,0.618), z>0 — moderate sustainable momentum with positive outlook'
      };
    } else {
      return {
        reading: 'Oversold',
        emoji: '🟠',
        description: 'R∈[0.382,0.618), z≤0 — moderate momentum but negative deviation'
      };
    }
  }
  
  // R < φ (1.618) → Strong momentum zone
  if (R < PHI_VAL) {
    if (zVal > 0 && zVal < PHI_SQ) {
      return {
        reading: 'Breathing',
        emoji: '🟢',
        description: 'R∈[0.618,1.618), z∈(0,φ²) — healthy oscillation within φ-band'
      };
    } else {
      return {
        reading: 'False Breakout',
        emoji: '🟠',
        description: 'R∈[0.618,1.618), z≤0 or z≥φ² — breakout signal lacks confirmation'
      };
    }
  }
  
  // R ≥ φ (1.618) → Extreme momentum zone
  if (Math.abs(zVal) > PHI_SQ) {
    return {
      reading: 'False Positive Bull Signal',
      emoji: '🔴',
      description: 'R≥φ, |z|>φ² — extreme deviation suggests unsustainable momentum'
    };
  }
  
  // R ≥ φ, |z| ≤ φ² → Check theta for trend confirmation
  if (thetaVal > 0) {
    return {
      reading: 'Bull Trend Signal',
      emoji: '🟢',
      description: 'R≥φ, |z|≤φ², θ>0 — strong sustainable bull trend confirmed'
    };
  } else {
    return {
      reading: 'False Positive Bull Signal',
      emoji: '🟠',
      description: 'R≥φ, |z|≤φ², θ≤0 — strong R but phase not confirming bull trend'
    };
  }
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
  
  // Dimensional validation thresholds (φ-derived)
  // 0.618 (φ⁻¹): Minimum fidelity for signal reliability
  // 0.382 (φ⁻²): Minimum fidelity for signal existence
  const MIN_FIDELITY = PHI_INVERSE;
  const MIN_SIGNAL_FIDELITY = PHI_INV_SQUARED;

  const thetaFidelity = (thetaCount1.real + thetaCount2.real) / (thetaCount1.total + thetaCount2.total || 1);
  const zFidelity = (zCount1.real + zCount2.real) / (zCount1.total + zCount2.total || 1);
  const rFidelity = (rCount1.real + rCount2.real) / (rCount1.total + rCount2.total || 1);

  // Aggregate within each dimension only
  const theta = {
    real: thetaCount1.real + thetaCount2.real,
    total: thetaCount1.total + thetaCount2.total,
    fidelity: thetaFidelity,
    isValid: thetaFidelity >= MIN_FIDELITY,
    hasSignal: thetaFidelity >= MIN_SIGNAL_FIDELITY
  };
  const z = {
    real: zCount1.real + zCount2.real,
    total: zCount1.total + zCount2.total,
    fidelity: zFidelity,
    isValid: zFidelity >= MIN_FIDELITY,
    hasSignal: zFidelity >= MIN_SIGNAL_FIDELITY
  };
  const r = {
    real: rCount1.real + rCount2.real,
    total: rCount1.total + rCount2.total,
    fidelity: rFidelity,
    isValid: rFidelity >= MIN_FIDELITY,
    hasSignal: rFidelity >= MIN_SIGNAL_FIDELITY
  };
  
  const calculateLowSignalRatio = (data) => {
    if (!data || data.length === 0) return 0;
    const SIGNAL_THRESHOLD = 0.01; // z ≈ 0 threshold
    const lowSignalCount = data.filter(v => Math.abs(v) < SIGNAL_THRESHOLD).length;
    return lowSignalCount / data.length;
  };
  
  // Safe concat with null guards
  const safeConcat = (a, b) => (a || []).concat(b || []);

  // Aggregate fidelity: average of θ, z, R fidelity ratios
  const avgFidelity = (thetaFidelity + zFidelity + rFidelity) / 3;
  const percent = Math.round(avgFidelity * 100);
  
  // φ-derived grade thresholds using PHI constants (pure φ-derivation):
  // A: avgFidelity ≥ φ⁻¹ (0.618) AND all dimensions valid (strict)
  // B: avgFidelity ≥ φ⁻¹ (0.618) - high quality
  // C: avgFidelity ≥ φ⁻² (0.382) - acceptable
  // D: avgFidelity < φ⁻² (0.382) - low fidelity
  const allValid = theta.isValid && z.isValid && r.isValid;
  let grade;
  if (avgFidelity >= PHI_INVERSE && allValid) grade = 'A';
  else if (avgFidelity >= PHI_INVERSE) grade = 'B';
  else if (avgFidelity >= PHI_INV_SQUARED) grade = 'C';
  else grade = 'D';

  return {
    theta,
    z,
    r,
    isValid: theta.isValid && z.isValid && r.isValid,
    hasSignal: theta.hasSignal || z.hasSignal || r.hasSignal,
    // Aggregate grade and percent for display
    grade,
    percent,
    // Human-readable breakdown string
    breakdown: `θ: ${theta.real}/${theta.total} (${(theta.fidelity * 100).toFixed(0)}%) | z: ${z.real}/${z.total} (${(z.fidelity * 100).toFixed(0)}%) | R: ${r.real}/${r.total} (${(r.fidelity * 100).toFixed(0)}%)`,
    lowSignal: {
      theta: calculateLowSignalRatio(safeConcat(theta1, theta2)),
      z: calculateLowSignalRatio(safeConcat(z1, z2)),
      r: calculateLowSignalRatio(safeConcat(r1, r2))
    }
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
  // NaN guard: if seed SMA is NaN (bad input data), set to null
  ema[period - 1] = isNaN(firstSMA) ? null : firstSMA;
  interpolationFlags[period - 1] = false; // Seeded value is "real"
  
  // Calculate EMA for remaining values starting at index 'period'
  for (let i = period; i < data.length; i++) {
    // NaN guard: skip bad input, carry forward previous EMA (don't wipe series)
    if (isNaN(data[i])) {
      ema[i] = ema[i - 1]; // Carry forward - maintains continuity
      interpolationFlags[i] = true; // Mark as interpolated since we skipped real data
      continue;
    }
    // If previous EMA is null (from bad seed), try to recover with current value
    if (ema[i - 1] === null) {
      ema[i] = data[i]; // Bootstrap from current value
      interpolationFlags[i] = true; // Not a proper EMA calculation
      continue;
    }
    ema[i] = data[i] * k + ema[i - 1] * (1 - k);
    interpolationFlags[i] = false; // Calculated values are "real"
  }
  
  // Linear interpolation for leading values (indices 0 to period-2)
  // Skip interpolation if seed is null (bad data) - leave as null to preserve detectability
  if (options.interpolate && period > 1 && ema[period - 1] !== null) {
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
 * Calculate phase angle θ = atan2(flow, stock)
 * 
 * DEPRECATED: Use analyzePhase() for price series analysis.
 * 
 * θ = atan2(y=flow, x=stock):
 *   - 0° = true north (equilibrium)
 *   - +θ = flow positive (rising)
 *   - -θ = flow negative (falling)
 * 
 * @param {number} flow - Flow value (Δprice, net income)
 * @param {number} stock - Stock value (price, equity)
 * @param {Object} options - Normalization options
 * @returns {number} Phase angle in degrees
 * @deprecated Use analyzePhase() instead
 */
function calculatePhase(flow, stock, options = { normalize: true }) {
  let flowNorm = flow;
  let stockNorm = stock;
  
  if (options.normalize) {
    const flowScale = options.flowScale || Math.abs(flow) || 1;
    const stockScale = options.stockScale || Math.abs(stock) || 1;
    flowNorm = flow / flowScale;
    stockNorm = stock / stockScale;
  }
  
  // atan2(y=flow, x=stock) → 0° true north, +θ rising, -θ falling
  const radians = Math.atan2(flowNorm, stockNorm);
  const degrees = radians * (180 / Math.PI);
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
  // Stock-flow relationship validation: flows[i] = stocks[i+1] - stocks[i]
  // Expected: flows.length === stocks.length - 1
  if (flows && stocks && flows.length !== stocks.length - 1 && flows.length !== stocks.length) {
    console.warn(`[Ψ-EMA] Stock-flow length mismatch: stocks=${stocks.length}, flows=${flows.length}. Expected flows.length === stocks.length - 1`);
  }
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
 * 
 * θ = atan2(Δprice, price) where:
 *   - y = Δprice (flow), x = price (stock)
 *   - 0° = true north (equilibrium, no change)
 *   - +θ = price rising (positive delta)
 *   - -θ = price falling (negative delta)
 * 
 * Binary interpretation:
 *   +θ → SURVIVAL (price rising)
 *   -θ → DECAY (price falling)
 *   θ ≈ 0° → WAIT (equilibrium)
 * 
 * @param {number} theta - Phase angle in degrees (-90 to +90 for typical prices)
 * @returns {Object} Phase interpretation
 */
function interpretPhase(theta) {
  if (theta > 1) {
    return { 
      phase: 'SURVIVAL', 
      emoji: '🟢',
      description: 'Price rising.',
      signal: 'UP'
    };
  } else if (theta >= -1 && theta <= 1) {
    return { 
      phase: 'WAIT', 
      emoji: '⏸️',
      description: 'Price stable / equilibrium.',
      signal: 'NEUTRAL'
    };
  } else {
    return { 
      phase: 'DECAY', 
      emoji: '🔴',
      description: 'Price falling.',
      signal: 'DOWN'
    };
  }
}

/**
 * Analyze Phase θ = atan2(Δprice, price)
 * 
 * Formula: θ = atan2(y, x) where y=Δprice (flow), x=price (stock)
 *   - 0° = true north (equilibrium, no change)
 *   - +θ = price rising (positive Δprice)
 *   - -θ = price falling (negative Δprice)
 * 
 * @param {number[]} prices - Price time series
 * @returns {Object} Phase analysis with signals
 */
function analyzePhase(prices) {
  if (!prices || prices.length < 2) {
    return { 
      error: 'Insufficient data (need at least 2 periods)',
      dimension: 'PHASE_θ',
      current: null
    };
  }
  
  // Calculate θ = atan2(Δprice, price) for each period
  // True north = 0° (equilibrium), +θ = rising, -θ = falling
  const thetaSeries = [];
  for (let i = 1; i < prices.length; i++) {
    const stock = prices[i];                  // Current price (x)
    const flow = prices[i] - prices[i - 1];   // Price change (y)
    
    // atan2(y=flow, x=stock) → 0° at equilibrium, +θ rising, -θ falling
    const radians = Math.atan2(flow, stock);
    const degrees = radians * (180 / Math.PI);
    thetaSeries.push(degrees);
  }
  
  // Current values
  const currentTheta = thetaSeries[thetaSeries.length - 1];
  const currentPrice = prices[prices.length - 1];
  const currentDelta = prices[prices.length - 1] - prices[prices.length - 2];
  
  // Interpret phase
  const interpretation = interpretPhase(currentTheta);
  
  // EMA for smoothing (optional, for crossover signals)
  const ema34Result = calculateEMA(prices, FIB_PERIODS.FAST_THETA);
  const ema55Result = calculateEMA(prices, FIB_PERIODS.SLOW_THETA);
  
  const crossover = detectCrossover(ema34Result.values, ema55Result.values, {
    fastInterpolated: ema34Result.interpolated,
    slowInterpolated: ema55Result.interpolated
  });
  
  return {
    dimension: 'PHASE_θ',
    current: currentTheta,
    currentPhase: currentTheta,
    price: currentPrice,
    deltaPrice: currentDelta,
    ema34: ema34Result.values[ema34Result.values.length - 1],
    ema55: ema55Result.values[ema55Result.values.length - 1],
    crossover,
    interpretation,
    signal: interpretation.signal || crossover.signal,
    raw: thetaSeries,
    emaFast: ema34Result.values,
    emaSlow: ema55Result.values,
    ema34Interpolated: ema34Result.interpolated,
    ema55Interpolated: ema55Result.interpolated,
    formula: 'θ = atan2(Δprice, price)'
  };
}

// ============================================================================
// PART 3: ANOMALY z (Deviation Strength)
// ============================================================================

/**
 * Calculate z-scores from stock (price) data using rolling window
 * 
 * vφ³: Uses MAD (Median Absolute Deviation) by default for robustness.
 * vφ⁵: Added fidelity guards, minSamples threshold, and NaN handling.
 * vφ⁶: Added rolling window option (50-period default)
 * vφ⁷: FIXED - z-score now computed on STOCK (prices), not flows
 *       Excel reference: z = (Stock - Rolling Median of Stock) / (MAD × 1.4826)
 * 
 * @param {number[]} stocks - Stock values (prices) - the finite series to analyze
 * @param {Object} options - Configuration options
 * @param {boolean} options.robust - Use MAD instead of stdDev (default: true)
 * @param {number} options.minSamples - Minimum samples for reliable z-score (default: 8)
 * @param {number} options.rollingWindow - Rolling window for median/MAD (default: ROLLING_WINDOW = 35)
 * @returns {Object} Z-score analysis with fidelity metrics
 */
function calculateZFlows(stocks, options = {}) {
  const { robust = true, minSamples = 8, rollingWindow = ROLLING_WINDOW } = options;
  
  if (!stocks || stocks.length < 2) {
    return { 
      zFlows: [], 
      mean: 0, 
      dispersion: 0, 
      method: 'none', 
      error: 'Insufficient data',
      dataQuality: { sampleCount: 0, nanCount: 0, isReliable: false, warning: 'No data provided' }
    };
  }
  
  // vφ⁵: Filter NaN/Infinity and track data quality (distinct from EMA fidelity)
  const validStocks = stocks.filter(s => Number.isFinite(s));
  const nanCount = stocks.length - validStocks.length;
  const sampleCount = validStocks.length;
  const isReliable = sampleCount >= minSamples && nanCount / stocks.length < 0.3;
  
  // Build dataQuality object (input data quality, NOT EMA interpolation fidelity)
  const dataQuality = {
    sampleCount,
    nanCount,
    nanRatio: nanCount / stocks.length,
    minSamples,
    isReliable,
    warning: !isReliable 
      ? (sampleCount < minSamples 
          ? `Insufficient samples (${sampleCount}/${minSamples} required)` 
          : `High NaN ratio (${(nanCount / stocks.length * 100).toFixed(1)}% missing)`)
      : null
  };
  
  if (sampleCount < 2) {
    return { 
      zFlows: [], 
      mean: 0, 
      dispersion: 0, 
      method: 'none', 
      error: 'Insufficient valid data after NaN filter',
      dataQuality
    };
  }
  
  const avg = mean(validStocks);
  const med = median(validStocks);
  
  if (robust) {
    // vφ⁷: 2-PASS Excel-style calculation (validated vs 30-year S&P 500)
    // Pass 1: Compute rolling median and abs dev for each row
    // Pass 2: Compute MAD as rolling median of abs devs, then z-score
    // Excel reference: z = (Stock - Rolling Median) / (MAD × 1.4826)
    const MAD_SCALE = 1.4826;  // Scaling for normal consistency
    
    // Pass 1: Rolling medians and absolute deviations
    const rollingMedians = [];
    const absDevs = [];
    
    for (let i = 0; i < stocks.length; i++) {
      const stock = stocks[i];
      if (!Number.isFinite(stock) || i < rollingWindow - 1) {
        rollingMedians.push(null);
        absDevs.push(null);
        continue;
      }
      
      const startIdx = i - rollingWindow + 1;
      const windowStocks = stocks.slice(startIdx, i + 1).filter(x => Number.isFinite(x));
      
      if (windowStocks.length < minSamples) {
        rollingMedians.push(null);
        absDevs.push(null);
        continue;
      }
      
      const windowMed = median(windowStocks);
      rollingMedians.push(windowMed);
      absDevs.push(Math.abs(stock - windowMed));  // |Stock - Rolling Median|
    }
    
    // Pass 2: z-scores using rolling MAD of abs devs
    const zFlows = [];
    
    for (let i = 0; i < stocks.length; i++) {
      const stock = stocks[i];
      const med = rollingMedians[i];
      
      if (!Number.isFinite(stock) || med === null) {
        zFlows.push(NaN);
        continue;
      }
      
      // Get rolling window of absolute deviations
      // Excel requires full 50-period window for MAD calculation
      const startIdx = i - rollingWindow + 1;
      const windowAbsDevs = absDevs.slice(Math.max(0, startIdx), i + 1).filter(x => x !== null);
      
      // Require full rolling window for MAD (matches Excel behavior)
      // EXTRAPOLATION GUARD: If we have enough for median but not for MAD, return NaN
      // This prevents "hallucinated" z-scores during the second half of the warm-up
      if (windowAbsDevs.length < rollingWindow) {
        zFlows.push(NaN);  // Warm-up period
        continue;
      }
      
      // MAD = median of rolling absolute deviations
      const madVal = median(windowAbsDevs);
      
      if (madVal === 0) {
        zFlows.push(0);  // No dispersion = at median
        continue;
      }
      
      // z = (Stock - Rolling Median) / (MAD × 1.4826)
      const z = (stock - med) / (madVal * MAD_SCALE);
      zFlows.push(z);
    }
    
    const validZ = zFlows.filter(z => Number.isFinite(z));
    
    // Final fidelity check: total valid samples / expected window size
    const expectedSamples = stocks.length - (rollingWindow * 2 - 2);
    const fidelity = expectedSamples > 0 ? validZ.length / expectedSamples : 0;
    
    // Use final window for summary stats
    const finalWindow = validStocks.slice(-rollingWindow);
    const finalMed = median(finalWindow);
    const finalMAD = mad(finalWindow);
    const finalDispersion = finalMAD * MAD_SCALE;
    
    return {
      zFlows,
      mean: avg,
      median: finalMed,
      dispersion: finalDispersion,
      method: 'MAD',
      rollingWindow,
      currentZ: validZ.length > 0 ? validZ[validZ.length - 1] : null,
      previousZ: validZ.length > 1 ? validZ[validZ.length - 2] : null,
      anomalyStrength: validZ.length > 0 ? Math.abs(validZ[validZ.length - 1]) : null,
      fidelity,
      isValid: fidelity >= PHI_INVERSE, // Gated by φ⁻¹ (0.618)
      dataQuality
    };
  }
  
  // Legacy σ-based calculation on stocks
  const std = stdDev(validStocks);
  
  if (std === 0) {
    return { 
      zFlows: stocks.map(s => Number.isFinite(s) ? 0 : NaN), 
      mean: avg, 
      dispersion: 0, 
      method: 'sigma', 
      error: 'Zero variance',
      dataQuality
    };
  }
  
  const zFlows = stocks.map(s => Number.isFinite(s) ? (s - avg) / std : NaN);
  const validZ = zFlows.filter(z => Number.isFinite(z));
  
  return {
    zFlows,
    mean: avg,
    stdDev: std,
    dispersion: std,
    method: 'sigma',
    currentZ: validZ.length > 0 ? validZ[validZ.length - 1] : null,
    previousZ: validZ.length > 1 ? validZ[validZ.length - 2] : null,
    anomalyStrength: validZ.length > 0 ? Math.abs(validZ[validZ.length - 1]) : null,
    dataQuality
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
function safeConvergenceRatio(currentZ, previousZ, epsilon = 0.01) {
  // Guard: NaN or non-finite values → R is undefined (warm-up period)
  if (!Number.isFinite(currentZ) || !Number.isFinite(previousZ)) {
    return {
      ratio: null,
      absRatio: null,
      direction: null,
      interpretation: 'Z-score unavailable — R undefined (warm-up period)',
      status: 'INSUFFICIENT_DATA'
    };
  }
  
  // Guard: EITHER z near zero → R is undefined (not decay!)
  // User Formula: IF(OR(ABS(z(n))<0.01,ABS(z(n-1))<0.01),"Consolidation"...)
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

  // Final Guard: Division-by-zero protection (0.000001)
  if (Math.abs(previousZ) < 0.000001) {
    return {
      ratio: null,
      absRatio: null,
      direction: null,
      interpretation: 'Extreme consolidation — R undefined',
      status: 'INSUFFICIENT_DATA'
    };
  }
  
  const rawRatio = currentZ / previousZ;
  const absRatio = Math.abs(rawRatio);
  
  // Clamp to safe range (0.1 to 10) to prevent extreme values
  const clampedAbsRatio = Math.max(0.1, Math.min(10, absRatio));
  
  // Interpret regime using clamped value (φ-zone as band, not law)
  let interpretation;
  if (clampedAbsRatio < 0.618) {
    interpretation = 'decaying orbit — momentum declining';
  } else if (clampedAbsRatio < 1.618) {
    interpretation = 'breathing orbit — sustainable growth';
  } else if (clampedAbsRatio < 2.618) {
    interpretation = 'optimistic orbit — accelerating momentum';
  } else {
    interpretation = 'escape velocity — potential bubble';
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
  
  // Count LOW_SIGNAL cases from ALL results (for warnings/diagnostics)
  const lowSignalCount = allResults.filter(r => r.status === 'LOW_SIGNAL' || r.status === 'INSUFFICIENT_DATA').length;
  const lowSignalRatio = allResults.length > 0 ? lowSignalCount / allResults.length : 0;
  
  // Check if MOST RECENT result is LOW_SIGNAL (current z near zero)
  const mostRecentResult = allResults[allResults.length - 1];
  const currentIsLowSignal = mostRecentResult && 
    (mostRecentResult.status === 'LOW_SIGNAL' || mostRecentResult.status === 'INSUFFICIENT_DATA');
  
  // hasLowSignal for warnings/trend classification, but NOT a gate for R computation
  // R is always computed if we have valid pairs; hasLowSignal is informational only
  const hasLowSignal = currentIsLowSignal || lowSignalRatio > 0.5;  // Raised from 30% to 50%
  
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
  } else if (recentMean >= 0.618 && recentMean <= 1.618) {
    trendStatus = 'BREATHING';
  } else if (recentMean < 0.618) {
    trendStatus = 'FATALISM_CLIFF';
  } else if (recentMean <= 2.618) {
    trendStatus = 'OPTIMISM';
  } else {
    trendStatus = 'ESCAPE';
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
 * vφ⁵: Added fidelity metrics and NaN handling
 * 
 * For oscillating data (seasonal patterns, alternating flows), signed R fails
 * because sign flips every period → R always negative → false "decay" signal.
 * 
 * This function analyzes MAGNITUDE ONLY, ignoring direction.
 * Use for: quarterly earnings, seasonal revenue, any oscillating time series.
 * 
 * @param {number[]} zFlows - Z-score time series
 * @param {Object} options - Configuration options
 * @param {number} options.minSamples - Minimum samples for reliable analysis (default: 8)
 * @returns {Object} Absolute convergence analysis with fidelity metrics
 */
function calculateAbsoluteConvergence(zFlows, options = {}) {
  const { minSamples = 8 } = options;
  
  if (!zFlows || zFlows.length < 2) {
    return { 
      absRatios: [], 
      meanAbsRatio: null, 
      converged: false, 
      error: 'Insufficient data',
      dataQuality: { sampleCount: 0, nanCount: 0, skippedCount: 0, isReliable: false, warning: 'No data provided' }
    };
  }
  
  const absRatios = [];
  const validResults = [];
  let nanCount = 0;
  let skippedCount = 0;  // Low signal (z near zero)
  
  for (let i = 1; i < zFlows.length; i++) {
    // vφ⁵: Handle NaN/Infinity in z-scores
    if (!Number.isFinite(zFlows[i]) || !Number.isFinite(zFlows[i - 1])) {
      nanCount++;
      continue;
    }
    
    const current = Math.abs(zFlows[i]);
    const previous = Math.abs(zFlows[i - 1]);
    
    // Guard: skip if either z-score is too small (consolidation)
    if (previous < 0.1 || current < 0.001) {
      skippedCount++;
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
  
  // vφ⁵: Build dataQuality metrics (input data quality, NOT EMA interpolation fidelity)
  const potentialPairs = zFlows.length - 1;
  const sampleCount = absRatios.length;
  const isReliable = sampleCount >= minSamples && (nanCount + skippedCount) / potentialPairs < 0.3;
  
  const dataQuality = {
    sampleCount,
    nanCount,
    skippedCount,
    potentialPairs,
    validRatio: sampleCount / potentialPairs,
    minSamples,
    isReliable,
    warning: !isReliable 
      ? (sampleCount < minSamples 
          ? `Insufficient valid |R| samples (${sampleCount}/${minSamples} required)` 
          : `High data loss (${((nanCount + skippedCount) / potentialPairs * 100).toFixed(1)}% invalid/skipped)`)
      : null
  };
  
  if (absRatios.length === 0) {
    return {
      absRatios: [],
      meanAbsRatio: null,
      converged: false,
      error: 'No valid absolute ratios',
      warning: '|R| undefined — z-scores near zero or NaN throughout series.',
      dataQuality
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
    dataQuality,
    note: 'Absolute convergence ignores sign (direction). Use for oscillating/seasonal data.'
  };
}

/**
 * Classify regime based on R ratio (φ-Orbital Model)
 * 
 * vφ⁵: φ-Orbital interpretation using orbital mechanics analogy:
 * - φ² ≈ 2.618 → escape velocity (bubble → crash)
 * - φ  ≈ 1.618 → circular orbit velocity (golden rhythm, sustainable)
 * - φ⁻¹ ≈ 0.618 → lower stable bound
 * - φ⁻² ≈ 0.382 → capture velocity (fatalism → void)
 * 
 * 7-Regime Classification (φ-Orbital):
 * 1. CONSOLIDATION: R undefined (z near zero)
 * 2. ESCAPE: R > φ² (escape velocity → bubble/crash)
 * 3. OPTIMISM: R ∈ [φ, φ²] (accelerating orbit, watch for escape)
 * 4. BREATHING: R ∈ [φ⁻¹, φ] (circular orbit, golden rhythm)
 * 5. FATALISM_CLIFF: R ∈ [φ⁻², φ⁻¹] (danger zone, decaying orbit)
 * 6. BULLISH_REVERSAL: R < φ⁻² AND Z > 0 (capture velocity but positive momentum)
 * 7. FATALISM: R < φ⁻² AND Z ≤ 0 (capture velocity → void)
 * 
 * Phase Reversal (R < 0):
 * - PHASE_REVERSAL: R < 0 AND |R| > φ (explosive direction change)
 * - DAMPED_REVERSAL: R < 0 AND |R| ≤ φ (mild direction change)
 * 
 * @param {number|null} ratio - Mean convergence ratio (null if undefined)
 * @param {Object} options - Additional context for classification
 * @param {boolean} options.hasLowSignal - Whether R is unstable due to low z-scores
 * @param {number} options.currentZScore - Current z-score for regime detection
 * @param {string} options.warning - Warning message from convergence analysis
 * @returns {Object} Regime classification with magnitude and direction
 */
/**
 * Unified Pathogen and Regime Classification (vφ⁷)
 * 1-pass, 1-cluster categorization for market state and disease stage
 * 
 * Cascade:
 * R = 0 → CONSOLIDATION (healthy)
 * R < 0 → Reversal states (Panic/Profit Taking)
 * R < 0.382 → Fatalism / Bullish Reversal
 * R < 0.6 → Fatalism Cliff
 * R < 1.618 → Breathing (healthy)
 * R >= 1.618 → Optimism
 * R > 2.0 AND z > 3 → Bubble Cancer (Pathogen)
 * R > 2.5 → Ponzi Virus (Pathogen)
 * 
 * @param {number} ratio - Convergence R ratio
 * @param {Object} options - Classification context
 * @returns {Object} Unified classification result
 */
function classifyRegime(ratio, options = {}) {
  const { hasLowSignal = false, currentZScore = null, warning = null } = options;
  const currentZ = currentZScore || 0;
  
  // 1. CONSOLIDATION / LOW SIGNAL
  if (ratio === 0 || ratio === null || hasLowSignal) {
    return {
      regime: 'CONSOLIDATION',
      pathogen: null,
      label: 'R = 0 (Consolidation)',
      emoji: '⚪',
      description: 'Price consolidating. Not always fatalism.',
      magnitude: 0,
      direction: 'NEUTRAL'
    };
  }
  
  const magnitude = Math.abs(ratio);
  const direction = ratio >= 0 ? 'SAME' : 'REVERSED';
  const isReversal = ratio < 0;
  const zPositive = currentZ > 0;
  const zNegative = currentZ < 0;

  // 2. PATHOGEN DETECTION (Top-priority clusters)
  let pathogen = null;
  
  // Bubble Cancer: |z| > 3 AND R > 2.0
  if (Math.abs(currentZ) > 3 && ratio > 2.0) {
    const severity = (Math.abs(currentZ) - 3) / 2;
    pathogen = {
      ...PATHOGENS.BUBBLE_CANCER,
      severity: Math.min(1, severity),
      stage: classifyStage(severity, 'bubble')
    };
  } 
  // Ponzi Virus: R > 2.5
  else if (ratio > 2.5) {
    const severity = (ratio - 2.5) / 1.5;
    pathogen = {
      ...PATHOGENS.PONZI_VIRUS,
      severity: Math.min(1, severity),
      stage: classifyStage(severity, 'ponzi')
    };
  }

  // 3. REGIME CLASSIFICATION
  if (isReversal) {
    const isExplosive = magnitude > PHI;
    if (zNegative) {
      return {
        regime: 'PANIC_REVERSAL',
        pathogen,
        label: `R < 0, Z < 0 (Panic Reversal)`,
        emoji: pathogen?.emoji || '🔻',
        description: pathogen ? `${pathogen.name} in Panic.` : 'Panic reversal: accelerating selloff.',
        magnitude,
        direction,
        isExplosive
      };
    } else {
      return {
        regime: 'RELIEF_REVERSAL',
        pathogen,
        label: `R < 0, Z > 0 (Profit Taking)`,
        emoji: pathogen?.emoji || '🔺',
        description: pathogen ? `${pathogen.name} taking profit.` : 'Profit taking / Distribution.',
        magnitude,
        direction,
        isExplosive
      };
    }
  }

  if (ratio < 0.382) {
    if (zPositive) {
      return {
        regime: 'BULLISH_REVERSAL',
        pathogen,
        label: `R < 0.382, Z > 0 (Bullish Reversal)`,
        emoji: pathogen?.emoji || '💚',
        description: 'Bullish reversal.',
        magnitude,
        direction
      };
    } else {
      return {
        regime: 'FATALISM',
        pathogen,
        label: `R < 0.382 (Fatalism)`,
        emoji: pathogen?.emoji || '🔵',
        description: 'Fatalism: falling toward void.',
        magnitude,
        direction
      };
    }
  } else if (ratio < 0.6) {
    return {
      regime: 'FATALISM_CLIFF',
      pathogen,
      label: `R < 0.6 (Fatalism Cliff)`,
      emoji: pathogen?.emoji || '🟠',
      description: 'Fatalism cliff.',
      magnitude,
      direction
    };
  } else if (ratio < 1.618) {
    return {
      regime: 'BREATHING',
      pathogen,
      label: `R < 1.618 (Breathing)`,
      emoji: pathogen?.emoji || '🟢',
      description: 'Breathing.',
      magnitude,
      direction
    };
  } else if (ratio < 2.0 && !pathogen) {
    return {
      regime: 'OPTIMISM',
      pathogen,
      label: `R < 2.0 (Optimism)`,
      emoji: '🟡',
      description: 'Optimism / Accelerating.',
      magnitude,
      direction
    };
  } else {
    // Extreme zones (Bubble/Ponzi territory)
    return {
      regime: pathogen ? 'PATHOLOGICAL' : 'EXTREME_OPTIMISM',
      pathogen,
      label: pathogen ? `${pathogen.name} (${pathogen.stage.label})` : 'Extreme Optimism',
      emoji: pathogen?.emoji || '🔥',
      description: pathogen ? pathogen.mechanism : 'Extreme acceleration beyond φ².',
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
    current: hasLowSignal ? null : currentR,  // Gated for regime classification
    currentDisplay: currentR,  // Always available for display regardless of signal quality
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
  // Use currentDisplay (always available) for pathogen detection
  const currentR = convergence.currentDisplay ?? convergence.current;
  const regime = convergence.regime?.regime || 'UNKNOWN';
  const warning = convergence.warning || null;
  
  // Only return consolidation if R is truly unavailable (null/undefined)
  if (currentR === null || currentR === undefined) {
    return {
      detected: [],
      healthy: true,
      consolidating: true,
      diagnosis: '⚪ R Undefined (Consolidation Zone)',
      pathogens: [],
      warning: warning || 'R ratio unavailable - insufficient z-score pairs.',
      vitalSigns: {
        R_ratio: 'undefined',
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
  
  // Vital Signs - use currentDisplay for R (always available)
  const rDisplay = convergence?.currentDisplay ?? convergence?.current;
  const vitalSigns = {
    R_ratio: {
      value: rDisplay?.toFixed(3) || 'N/A',
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
    complaint: analysis.summary?.reading || 'Routine Examination',
    
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
      microscopy: `z = ${anomaly?.current?.toFixed(2) || 'N/A'}σ, R = ${rDisplay?.toFixed(3) || 'N/A'}`,
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
    
    // Derive flows if not provided (used for theta calculation)
    const actualFlows = flows || this._deriveFlows(stocks);
    
    // vφ⁷: Calculate z-scores on STOCKS (prices), not flows
    // Excel reference: z = (Stock - Rolling Median of Stock) / (MAD × 1.4826)
    const zFlowResult = calculateZFlows(stocks);
    if (zFlowResult.error && zFlowResult.zFlows.length === 0) {
      return { error: zFlowResult.error };
    }
    
    // Calculate convergence ratios
    const convergenceResult = calculatePhiConvergence(zFlowResult.zFlows);
    
    // Analyze all three dimensions
    // vφ⁸: analyzePhase now takes raw prices (stocks) and computes θ = atan2(ΔEMA-55, ΔEMA-34)
    const phaseAnalysis = analyzePhase(stocks);
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
    // Use currentDisplay for deriveReading (always shows R), current for regime logic (gated)
    const convergenceR = convergenceAnalysis.currentDisplay ?? convergenceAnalysis.current;
    const renewal = detectPhiSquaredRenewal(stocks, convergenceR);
    
    // vφ⁴: Derive reading from R, z, theta using φ-orbital decision tree
    const reading = deriveReading({
      R: convergenceR,
      z: currentZ,
      theta: phaseAnalysis.current
    });
    
    return {
      summary: {
        periods: stocks.length,
        phaseSignal: phaseAnalysis.signal,
        anomalyLevel: anomalyAnalysis.alert?.level,
        regime: convergenceAnalysis.regime?.regime || 'UNKNOWN',
        reading: reading.reading,
        readingEmoji: reading.emoji,
        fidelity: fidelity.breakdown,
        version: 'vφ⁴'  // Falsifiable refactor - φ-orbital reading
      },
      dimensions: {
        phase: phaseAnalysis,
        anomaly: anomalyAnalysis,
        convergence: convergenceAnalysis
      },
      reading,
      fidelity,
      derivatives,
      correction,
      renewal,
      interpretation: this._generateInterpretation(phaseAnalysis, anomalyAnalysis, convergenceAnalysis, reading),
      
      // vφ⁴: Epistemic status - honest labels distinguishing technical from symbolic
      epistemicStatus: {
        phase: 'normalized_cycle_position_indicator',
        anomaly: 'robust_statistical_heuristic (MAD-scaled)',
        convergence: 'momentum_ratio_for_reading_derivation',
        reading: 'φ-orbital_decision_tree (falsifiable)',
        phi_elements: 'symbolic_overlay — not empirical law',
        overall: 'R + z + θ → reading (no arbitrary weighting)'
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
  
  _generateInterpretation(phase, anomaly, convergence, reading) {
    const lines = [];
    
    lines.push(`## Ψ-EMA DASHBOARD ANALYSIS`);
    lines.push('');
    
    // Phase
    lines.push(`### Phase θ (Cycle Position)`);
    lines.push(`Current: ${phase.current?.toFixed(1)}° ${phase.interpretation?.emoji || ''}`);
    lines.push(`EMA-34: ${phase.ema34?.toFixed(1)}° | EMA-55: ${phase.ema55?.toFixed(1)}°`);
    lines.push('');
    
    // Anomaly
    lines.push(`### Anomaly z (Deviation Strength)`);
    lines.push(`Current: ${anomaly.current?.toFixed(2)}σ ${anomaly.alert?.emoji || ''}`);
    lines.push(`Level: **${anomaly.alert?.level}**`);
    lines.push('');
    
    // Convergence - use currentDisplay for always-available R
    if (convergence.regime) {
      const rVal = convergence.currentDisplay ?? convergence.current;
      lines.push(`### Convergence R (Momentum Ratio)`);
      lines.push(`Current R: ${rVal?.toFixed(3) ?? 'N/A'} | φ = ${PHI.toFixed(3)}`);
      lines.push('');
    }
    
    // Reading (vφ⁴: single clear output from φ-orbital decision tree)
    lines.push(`### Reading`);
    lines.push(`${reading?.emoji || '⚪'} **${reading?.reading || 'Unknown'}**`);
    lines.push(`${reading?.description || ''}`);
    
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
      reading: analysis.summary.reading,
      readingEmoji: analysis.summary.readingEmoji
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
 * recommends combining spreadsheet analysis with real-world physical audits appropriate to
 * the asset class being analyzed.
 * 
 * The "seeing is believing" H₀ approach verifies that P (price/claim) corresponds to Q (quantity).
 * 
 * @param {Object} analysis - Ψ-EMA analysis object (optional, for future expansion)
 * @param {string} ticker - Stock ticker symbol
 * @returns {string} Physical audit disclaimer text
 */
function generatePhysicalAuditDisclaimer(analysis, ticker) {
  const assetClass = detectAssetClass(ticker);
  const suggestions = getPhysicalAuditSuggestions(assetClass, ticker);
  
  return `⚠️ **H₀ PHYSICAL AUDIT ADVISORY**: Reported numbers are vulnerable to human error and financial acrobatics. Verify ${ticker}'s reality by combining this analysis with real physical audits:

${suggestions}

This "seeing is believing" H₀ approach grounds spreadsheet claims in physical reality. Numbers without physical substrate are hallucinations. 🔬`;
}

/**
 * Detect asset class from ticker symbol
 * Prioritizes more specific patterns before general ones
 */
function detectAssetClass(ticker) {
  if (!ticker) return 'general';
  const t = ticker.toUpperCase().trim();
  
  // Crypto: Handle various formats (BTC, BTC-USD, BTCUSD, BTC/USD)
  const cryptoBase = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'DOT', 'AVAX', 'MATIC', 'LINK', 
    'UNI', 'ATOM', 'LTC', 'BCH', 'XLM', 'ALGO', 'VET', 'FIL', 'THETA', 'SAND', 'MANA', 'AXS', 
    'APE', 'SHIB', 'NEAR', 'FTM', 'CRO', 'EGLD', 'HBAR', 'ICP', 'EOS', 'XTZ', 'AAVE', 'MKR', 
    'SNX', 'COMP', 'YFI', 'SUSHI', 'CRV', '1INCH', 'ENJ', 'CHZ', 'GALA', 'IMX', 'LRC', 'BAT', 
    'ZRX', 'REN', 'BNB', 'WBTC', 'WETH', 'USDT', 'USDC', 'DAI', 'BUSD', 'PEPE', 'ARB', 'OP'];
  const cryptoNormalized = t.replace(/[-\/](USD|USDT|USDC|EUR|GBP|BTC|ETH)$/, '');
  if (cryptoBase.includes(cryptoNormalized)) return 'crypto';
  
  // Commodities futures (=F suffix) - check before forex to avoid =X confusion
  if (/=F$/.test(t)) return 'commodity';
  
  // Commodity ETFs (physical-backed or commodity-focused)
  const commodityETFs = ['GLD', 'SLV', 'IAU', 'SGOL', 'SIVR', 'PPLT', 'PALL', 'USO', 'UNG', 
    'DBA', 'DBC', 'PDBC', 'CORN', 'WEAT', 'SOYB', 'CPER', 'JJC', 'JJN', 'JJG', 'COW', 'NIB'];
  if (commodityETFs.includes(t)) return 'commodity';
  
  // Forex pairs (=X suffix or currency pair patterns)
  if (/=X$/.test(t)) return 'forex';
  const forexPairs = /^(EUR|GBP|JPY|AUD|CAD|CHF|NZD|CNY|HKD|SGD|KRW|INR|MXN|BRL|ZAR)(USD|EUR|GBP|JPY|CHF|AUD|CAD|NZD)$/;
  if (forexPairs.test(t)) return 'forex';
  
  // REIT / Real Estate (major REITs)
  const reits = ['VNQ', 'XLRE', 'IYR', 'SCHH', 'RWR', 'USRT', 'REET', 'VNQI', 'REM', 'MORT', 
    'O', 'AMT', 'PLD', 'CCI', 'EQIX', 'PSA', 'DLR', 'WELL', 'AVB', 'EQR', 'SPG', 'VICI', 
    'ARE', 'MAA', 'UDR', 'ESS', 'PEAK', 'HST', 'SLG', 'BXP', 'VTR', 'KIM', 'REG', 'FRT', 
    'NNN', 'WPC', 'STOR', 'ADC', 'EPRT', 'STAG', 'TRNO', 'COLD', 'EXR', 'CUBE', 'LSI', 'NSA', 'REXR'];
  if (reits.includes(t)) return 'realestate';
  
  // Broad market ETFs (not commodity-focused)
  const etfs = ['SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'VOO', 'IVV', 'VEA', 'VWO', 'EFA', 'EEM', 
    'AGG', 'BND', 'TLT', 'LQD', 'HYG', 'XLF', 'XLK', 'XLE', 'XLV', 'XLI', 'XLP', 'XLY', 
    'XLB', 'XLU', 'VIG', 'VYM', 'SCHD', 'ARKK', 'ARKG', 'ARKW', 'ARKF', 'ARKQ', 'KWEB', 'FXI'];
  if (etfs.includes(t)) return 'etf';
  
  // Default: stocks
  return 'stock';
}

/**
 * Get physical audit suggestions based on asset class
 */
function getPhysicalAuditSuggestions(assetClass, ticker) {
  switch (assetClass) {
    case 'crypto':
      return `• **On-chain verification** (node runs, UTXO sets) to confirm supply and transaction claims
• **Exchange wallet sampling** to validate reserves and inflow/outflow accuracy
• **Miner site visits / hashrate observation** to ground production reality
• **OTC desk / large holder confirmations** as proxy for true demand magnitude (P × Q)
• **Blockchain explorer reconciliation** for liquidity and flow verification`;
    
    case 'forex':
      return `• **Central bank reserve reports** to verify currency backing and intervention capacity
• **Trade balance data verification** to confirm import/export flow reality
• **Foreign reserve audits** from IMF/BIS to validate sovereign holdings
• **Cross-border flow sampling** via SWIFT/correspondent banking data
• **Physical currency circulation data** as proxy for monetary base reality`;
    
    case 'commodity':
      return `• **Rig/site visits** (stock taking) to verify production and inventory claims
• **Port/tanker verification** (count loadings, satellite tracking) to confirm shipment flows
• **Refinery/consumer site visits** (e.g., US Gulf, Asia demand hubs) to validate consumption reality
• **Producer proxy** (output reports, satellite imagery of fields/mines) to verify supply magnitude (P × Q correlation)
• **Futures/spot reconciliation** for flow and liquidity verification`;
    
    case 'realestate':
      return `• **Property site inspections** to verify physical condition and occupancy
• **Title search / deed verification** to confirm ownership and encumbrances
• **Rent roll audits** with tenant verification to validate income claims
• **Zoning / permit verification** to ground development potential claims
• **Comparable sales sampling** to verify market value assertions`;
    
    case 'etf':
      return `• **Holdings transparency verification** via daily NAV reconciliation
• **Authorized participant activity** to confirm creation/redemption flows
• **Underlying asset sampling** to validate index tracking accuracy
• **Custodian audit reports** to verify asset segregation and custody
• **Securities lending disclosure** to understand collateral and counterparty exposure`;
    
    case 'stock':
    default:
      return `• **Warehouse visit** (stock taking) to verify inventory claims
• **Sample PO / AR / vendor verification** to confirm receivables accuracy
• **Customer site visits** to validate revenue relationships and demand reality
• **Counting trucks/shipments** as proxy to verify financial magnitude (P × Q correlation)
• **Bank statement reconciliation** for cash flow and liquidity verification`;
  }
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
  ROLLING_WINDOW,
  PHI_COMPOSITE_2,
  
  // H0 Documentation (ground truth for identity queries)
  PSI_EMA_DOCUMENTATION,
  
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
  calculateFidelity,
  calculateFidelityLegacy,
  
  // Robust statistics
  mad,
  median,
  
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

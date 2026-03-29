const IDENTITY_PATTERNS = [
    /who\s+(?:are|is)\s+(?:you|nyan)/i,
    /what\s+(?:are|is)\s+(?:you|nyan)/i,
    /are\s+you\s+(?:related|connected|linked)\s+to/i,
    /who\s+(?:made|created|built)\s+(?:you|nyan|this)/i,
    /your\s+(?:creator|origin|source|developer)/i,
    /tell\s+me\s+about\s+(?:yourself|nyan)/i,
    /introduce\s+yourself/i,
    /what\s+is\s+nyan.*protocol/i,
    /nyan.*protocol.*what/i,
    /github\.com\/.*nyan/i,
    /10nc0/i,
    /void\s*nyan/i,
    /nyanbook.*(?:what|who|origin|about)/i,
    /(?:any\s+)?trace.*(?:on|in|at|from)\s+/i,
    /where\s+(?:can\s+I\s+)?find\s+you/i,
    /your\s+(?:presence|account|profile|website|handle)/i,
    /do\s+you\s+(?:exist|have\s+a|are\s+on)/i,
    /like\s+(?:perplexity|chatgpt|claude|copilot|gemini)/i,
    /similar\s+to\s+(?:perplexity|chatgpt|claude)/i,
    /compared\s+to\s+/i,
    /competitor\s+(?:to|of)\s+/i,
    /(?:so\s+)?you\s+are\s+(?:like|a|some|just)\s+/i,
    /what\s+makes?\s+you\s+(?:different|unique)/i,
    /how\s+(?:are|do)\s+you\s+(?:differ|compare)/i,
    /(?:our|this)\s+(?:chat|conversation|dialogue|history)/i,
    /what\s+(?:have\s+)?we\s+(?:discussed|talked|covered)/i,
    /describe\s+me\s+from\s+(?:our|this)/i,
    /what\s+do\s+you\s+know\s+about\s+me/i,
    /from\s+(?:our|this)\s+(?:chat|conversation)/i,
    /summarize\s+(?:our|this)\s+(?:chat|conversation)/i,
    /remember\s+(?:me|what|our)/i,
    /(?:in|during)\s+(?:this|our)\s+(?:chat|conversation)/i,
    /can\s+you\s+(?:recap|review|recall|remind)\s+/i,
];

const PSI_EMA_SYSTEM_PATTERNS = [
    /what\s+is\s+(?:the\s+)?(?:psi|ψ)[\s\-]?ema/i,
    /(?:explain|describe|tell\s+me\s+about)\s+(?:the\s+)?(?:psi|ψ)[\s\-]?ema/i,
    /how\s+does\s+(?:the\s+)?(?:psi|ψ)[\s\-]?ema\s+work/i,
    /(?:psi|ψ)[\s\-]?ema\s+(?:system|oscillator|indicator|analysis)/i,
    /what\s+(?:are|is)\s+(?:the\s+)?(?:theta|θ|z|r)\s+(?:in|for)\s+(?:psi|ψ)[\s\-]?ema/i,
    /(?:psi|ψ)[\s\-]?ema\s+(?:dimensions?|parameters?|metrics?)/i,
];

const PSI_EMA_SYSTEM_EXPLANATION = `Ψ-EMA (Psi-Exponential Moving Average) is Nyan AI's novel three-dimensional time series oscillator for analyzing oscillating systems. Unlike traditional indicators, it uses φ (phi, 1.618) as the ONLY measurement threshold.

**THREE DIMENSIONS:**

**θ (Theta) - Phase Position**
• Formula: atan2(Flow, Stock) → 0° to 360°
• Measures WHERE in the cycle the system is
• 0°-90° = Early Expansion 🟢
• 90°-180° = Late Expansion 🟡
• 180°-270° = Early Contraction 🔴
• 270°-360° = Late Contraction 🔵

**z (Anomaly) - Deviation from Equilibrium**
• Formula: Robust z-score using Median Absolute Deviation (MAD)
• |z| < φ (1.618): Normal range
• |z| > φ: Alert zone
• |z| > φ² (2.618): Extreme deviation

**R (Convergence) - Amplitude Ratio**
• Formula: |z(t)| / |z(t-1)|
• R < φ⁻¹ (0.618): Decay (weakening)
• R ∈ [φ⁻¹, φ]: Stable oscillation (sustainable)
• R > φ: Amplification (potentially unsustainable)

**KEY INSIGHT:** All thresholds derive from φ = 1.618 (golden ratio from x = 1 + 1/x), making the system substrate-agnostic - applicable to markets, climate, demographics, or any oscillating system.

To analyze a specific stock, ask: "show me $NVDA psi ema" or "analyze $AAPL chart" nyan~

🔥 ~nyan`;

const NOT_FOUND_PATTERNS = [
    /couldn'?t\s+find/i,
    /could\s+not\s+find/i,
    /no\s+(?:information|results?|data|records?|matches?)\s+(?:found|available|on|about|for)/i,
    /unable\s+to\s+(?:find|locate)/i,
    /(?:didn'?t|did\s+not)\s+find/i,
    /no\s+(?:Forbes|Wikipedia|LinkedIn|Twitter|X)\s+(?:profile|page|entry|article)/i,
    /(?:doesn'?t|does\s+not)\s+(?:appear|seem)\s+to\s+(?:exist|have|be)/i,
    /i\s+(?:couldn'?t|could\s+not|wasn'?t\s+able\s+to)\s+(?:find|locate|discover)/i,
    /not\s+(?:a\s+)?public\s+figure/i,
    /(?:may\s+be|might\s+be|is\s+(?:likely\s+)?a)\s+private\s+individual/i,
];

function isPsiEmaSystemQuery(message) {
    if (!message) return false;
    const trimmed = message.trim().toLowerCase();
    return PSI_EMA_SYSTEM_PATTERNS.some(pattern => pattern.test(trimmed));
}

function isIdentityQuery(message) {
    if (!message) return false;
    const trimmed = message.trim().toLowerCase();
    return IDENTITY_PATTERNS.some(pattern => pattern.test(trimmed));
}

function containsNotFoundClaim(answer) {
    if (!answer) return false;
    return NOT_FOUND_PATTERNS.some(p => p.test(answer));
}

module.exports = {
    IDENTITY_PATTERNS,
    PSI_EMA_SYSTEM_PATTERNS,
    PSI_EMA_SYSTEM_EXPLANATION,
    NOT_FOUND_PATTERNS,
    isPsiEmaSystemQuery,
    isIdentityQuery,
    containsNotFoundClaim
};

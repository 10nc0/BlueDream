/**
 * Mode Registry - Unified mode configuration for the 7-stage pipeline
 * Each mode defines its detection logic, context builder, and formatting rules
 * 
 * Modes are detected in Stage -1 (Preflight) and flow uniformly through S0-S6
 */

const CODE_EXTENSIONS = /\.(js|ts|jsx|tsx|py|go|java|cpp|c|cs|php|rb|rs|swift|sh|bash|sql|html|css|scss|json|yaml|yml|toml|xml|md|vue|svelte|kt|scala|hs|ml|ex|exs|erl|clj|lisp|r|m|asm|wasm)$/i;

const CODE_CONTENT_PATTERNS = [
  /^(import|export|const|let|var|function|class|def|async|await)\s/m,
  /^(public|private|protected|static)\s+(class|void|int|String)/m,
  /^(package|module)\s+\w+/m,
  /^\s*(if|for|while|switch|try|catch)\s*\(/m,
  /^#include\s*<|^#define\s+\w+/m,
  /^\s*@\w+\s*(\(|$)/m,
  /\{\s*\n\s*(return|const|let|var|if)/m,
  /console\.(log|error|warn|info|debug)\s*\(/m,
  /\b(require|module\.exports|exports\.)\b/m,
  /=>\s*\{/m,
  /\bthrow\s+new\s+\w*Error/m,
  /\b(useState|useEffect|useCallback|useMemo)\s*\(/m,
  /\bprocess\.env\./m,
  /\basync\s+function\b|\bawait\s+\w+/m,
  /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN)\b.*\b(FROM|INTO|SET|VALUES)\b/im,
];

const SIGNATURE_SPECIALIZED = '🔥 ~nyan';
const SIGNATURE_GENERAL = '🔥 nyan~';

const MODE_DEFINITIONS = {
  'psi-ema': {
    id: 'psi-ema',
    name: 'Ψ-EMA Fourier Compass',
    description: 'Calibrates (θ, z, R) coordinates for user-uploaded time series. No predictions — locates position relative to equilibrium.',
    priority: 10,
    personality: {
      skipIntroOutro: false,
      preserveTechnicalTerms: true,
      appendSignature: true,
      signatureText: SIGNATURE_SPECIALIZED
    }
  },
  
  'psi-ema-identity': {
    id: 'psi-ema-identity',
    name: 'Ψ-EMA Compass Documentation',
    description: 'Explains the (θ, z, R) coordinate system — ehi passiko: come and see, test yourself.',
    priority: 5,
    personality: {
      skipIntroOutro: true,
      preserveTechnicalTerms: true,
      appendSignature: true,
      signatureText: SIGNATURE_SPECIALIZED
    }
  },
  
  'forex': {
    id: 'forex',
    name: 'Forex Analysis',
    priority: 15,
    personality: {
      skipIntroOutro: false,
      preserveTechnicalTerms: true,
      appendSignature: true,
      signatureText: SIGNATURE_SPECIALIZED
    }
  },
  
  'seed-metric': {
    id: 'seed-metric',
    name: 'Real Estate Seed Metric',
    priority: 20,
    personality: {
      skipIntroOutro: false,
      preserveTechnicalTerms: true,
      appendSignature: true,
      signatureText: SIGNATURE_SPECIALIZED
    }
  },
  
  'legal': {
    id: 'legal',
    name: 'Legal Document Analysis',
    priority: 25,
    personality: {
      skipIntroOutro: true,
      preserveTechnicalTerms: true,
      appendSignature: true,
      signatureText: SIGNATURE_SPECIALIZED
    }
  },
  
  'code-audit': {
    id: 'code-audit',
    name: 'Code Security Audit',
    priority: 30,
    personality: {
      skipIntroOutro: true,
      preserveTechnicalTerms: true,
      preserveVerdicts: true,
      appendSignature: true,
      signatureText: SIGNATURE_SPECIALIZED
    }
  },
  
  'general': {
    id: 'general',
    name: 'General Query',
    priority: 100,
    personality: {
      skipIntroOutro: false,
      preserveTechnicalTerms: false,
      appendSignature: true,
      signatureText: SIGNATURE_GENERAL
    }
  }
};

function hasAnySignature(text) {
  return /🔥\s*~?nyan~?/.test(text);
}

function isCodeFile(fileName) {
  if (!fileName) return false;
  return CODE_EXTENSIONS.test(fileName);
}

function isCodeContent(content) {
  if (!content || typeof content !== 'string') return false;
  if (content.length < 20) return false;
  
  // Soft consensus: require 2+ pattern matches to avoid Excel/data false positives
  // This lets other guardrails funnel ambiguous cases correctly
  const matchCount = CODE_CONTENT_PATTERNS.filter(pattern => pattern.test(content)).length;
  return matchCount >= 2;
}

function detectCodeMode(attachments = [], extractedContent = []) {
  for (const att of attachments) {
    if (isCodeFile(att.name || att.filename)) {
      return {
        detected: true,
        fileName: att.name || att.filename,
        language: getLanguageFromExtension(att.name || att.filename)
      };
    }
  }
  
  for (const content of extractedContent) {
    if (content.fileName && isCodeFile(content.fileName)) {
      return {
        detected: true,
        fileName: content.fileName,
        language: getLanguageFromExtension(content.fileName)
      };
    }
    if (content.text && isCodeContent(content.text)) {
      return {
        detected: true,
        fileName: content.fileName || 'unknown.txt',
        language: 'unknown'
      };
    }
  }
  
  return { detected: false };
}

function getLanguageFromExtension(fileName) {
  if (!fileName) return 'unknown';
  const ext = fileName.split('.').pop()?.toLowerCase();
  const langMap = {
    'js': 'JavaScript', 'jsx': 'JavaScript (React)', 'ts': 'TypeScript', 'tsx': 'TypeScript (React)',
    'py': 'Python', 'go': 'Go', 'java': 'Java', 'cpp': 'C++', 'c': 'C', 'cs': 'C#',
    'php': 'PHP', 'rb': 'Ruby', 'rs': 'Rust', 'swift': 'Swift', 'kt': 'Kotlin',
    'scala': 'Scala', 'hs': 'Haskell', 'ml': 'OCaml', 'ex': 'Elixir', 'exs': 'Elixir',
    'erl': 'Erlang', 'clj': 'Clojure', 'lisp': 'Lisp', 'r': 'R', 'm': 'Objective-C',
    'sh': 'Shell', 'bash': 'Bash', 'sql': 'SQL', 'html': 'HTML', 'css': 'CSS',
    'scss': 'SCSS', 'json': 'JSON', 'yaml': 'YAML', 'yml': 'YAML', 'toml': 'TOML',
    'xml': 'XML', 'md': 'Markdown', 'vue': 'Vue', 'svelte': 'Svelte'
  };
  return langMap[ext] || ext?.toUpperCase() || 'unknown';
}

function getModeConfig(modeId) {
  return MODE_DEFINITIONS[modeId] || MODE_DEFINITIONS['general'];
}

function getPersonalityConfig(modeId) {
  const mode = getModeConfig(modeId);
  return mode.personality;
}

function getAllModes() {
  return Object.keys(MODE_DEFINITIONS);
}

module.exports = {
  MODE_DEFINITIONS,
  CODE_EXTENSIONS,
  CODE_CONTENT_PATTERNS,
  SIGNATURE_SPECIALIZED,
  SIGNATURE_GENERAL,
  isCodeFile,
  isCodeContent,
  detectCodeMode,
  getLanguageFromExtension,
  getModeConfig,
  getPersonalityConfig,
  getAllModes,
  hasAnySignature
};

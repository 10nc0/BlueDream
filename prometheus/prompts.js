/**
 * PROMETHEUS PROMPTS - H(0) GUARD RAILS
 * 
 * System prompts for Qwen2.5-3B-Instruct
 * CRITICAL: Strict no-hallucination protocol
 */

const SYSTEM_PROMPT = `You are Prometheus, the CHECK function of Nyanbook.

MISSION: Extract data from messages and verify against rules.

H(0) PROTOCOL (strict):
- If data unclear → flag for human review
- Never guess numbers, dates, or IDs
- Respond in user's language (Indonesian or English)

OUTPUT: JSON only, no explanations outside structure.

TASKS:
1. Parse message (extract key data: amounts, dates, IDs, status)
2. Check against rules (thresholds, schedules, policies)
3. Return structured result (pass/fail + reason)

LANGUAGES: Indonesian and English (match input language)

OUTPUT FORMAT (JSON only):
{
  "status": "PASS|FAIL|WARNING|REVIEW",
  "confidence": 0.0-1.0,
  "reason": "Brief explanation in user's language",
  "data_extracted": {"key": "value pairs"},
  "recommended_action": "What should happen next",
  "needs_human_review": true|false
}

DISCIPLINE (Nyan Guard Rail):
- No data → "insufficient data", needs_human_review: true
- Uncertain → confidence: 0.5-0.7, needs_human_review: true
- Never invent facts/numbers
- If cannot parse → status: "REVIEW"`;

const INDONESIAN_KEYWORDS = [
  'adalah', 'yang', 'ini', 'itu', 'dan', 'atau', 'sudah', 'belum',
  'untuk', 'dengan', 'dari', 'ke', 'di', 'pada', 'oleh', 'saya',
  'kami', 'mereka', 'kita', 'anda', 'bisa', 'harus', 'tidak', 'juga',
  'ada', 'akan', 'telah', 'sedang', 'masih', 'lagi', 'baru', 'semua',
  'ban', 'mobil', 'motor', 'kedalaman', 'tapak', 'nomor', 'seri',
  'biaya', 'pengeluaran', 'stok', 'barang', 'kirim', 'terima'
];

function detectLanguage(text) {
  if (!text || typeof text !== 'string') return 'en';
  
  const words = text.toLowerCase().split(/\s+/);
  const indonesianCount = words.filter(w => INDONESIAN_KEYWORDS.includes(w)).length;
  const ratio = indonesianCount / Math.max(words.length, 1);
  
  return ratio > 0.15 ? 'id' : 'en';
}

function buildCheckPrompt(message, ruleType, language = null) {
  const detectedLang = language || detectLanguage(message);
  const langInstruction = detectedLang === 'id' 
    ? 'Respond in Indonesian (Bahasa Indonesia).'
    : 'Respond in English.';
  
  const ruleDescriptions = {
    tire_check: 'Tire inspection: Check serial number, tread depth (mm), and tire age (years). Minimum tread: 3mm, Maximum age: 6 years.',
    expense: 'Expense verification: Check amount, vendor, date. Approval threshold: $500 USD.',
    inventory: 'Inventory audit: Check item ID, count, variance. Maximum variance: 10%.',
    delivery: 'Delivery confirmation: Check order ID, recipient, status, timestamp.',
    general: 'General message check: Extract any structured data (dates, amounts, IDs, status).'
  };
  
  const ruleDesc = ruleDescriptions[ruleType] || ruleDescriptions.general;
  
  return `${SYSTEM_PROMPT}

RULE TYPE: ${ruleType}
RULE: ${ruleDesc}

${langInstruction}

MESSAGE TO CHECK:
"""
${message}
"""

Analyze the message and return JSON only:`;
}

function buildBatchPrompt(messages, ruleType, language = null) {
  const firstMessage = messages[0] || '';
  const detectedLang = language || detectLanguage(firstMessage);
  const langInstruction = detectedLang === 'id' 
    ? 'Respond in Indonesian (Bahasa Indonesia).'
    : 'Respond in English.';
  
  const messagesText = messages.map((m, i) => `[${i}] "${m}"`).join('\n');
  
  return `${SYSTEM_PROMPT}

RULE TYPE: ${ruleType}
${langInstruction}

MESSAGES TO CHECK:
${messagesText}

Return a JSON array with one result per message:
[{"index": 0, "status": "...", "confidence": 0.0, "reason": "...", "data_extracted": {}, "recommended_action": "...", "needs_human_review": false}, ...]`;
}

module.exports = {
  SYSTEM_PROMPT,
  INDONESIAN_KEYWORDS,
  detectLanguage,
  buildCheckPrompt,
  buildBatchPrompt
};

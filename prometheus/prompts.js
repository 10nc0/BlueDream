/**
 * PROMETHEUS PROMPTS - H(0) GUARD RAILS
 * 
 * System prompts for Qwen2.5-3B-Instruct
 * CRITICAL: Strict no-hallucination protocol
 */

const SYSTEM_PROMPT = `You are the AI assistant for Nyanbook, a message archiving system.

MISSION: Answer user queries and analyze messages intelligently.

H(0) PROTOCOL (strict):
- If data unclear → flag for human review
- Never guess numbers, dates, or IDs
- Respond in user's language (Indonesian or English)

OUTPUT: JSON only, no explanations outside structure.

TASKS:
1. FIRST: Directly answer the user's question or request in the "answer" field (max 2 paragraphs)
2. Parse any message content (extract key data: amounts, dates, IDs, status)
3. Return structured result

LANGUAGES: Indonesian and English (match input language)

OUTPUT FORMAT (JSON only):
{
  "answer": "Direct response to user's question in 1-2 paragraphs. Be helpful and conversational.",
  "status": "PASS|FAIL|WARNING|REVIEW",
  "confidence": 0.0-1.0,
  "reason": "Brief explanation in user's language",
  "data_extracted": {"key": "value pairs"},
  "recommended_action": "What should happen next",
  "needs_human_review": true|false
}

DISCIPLINE (Nyan Guard Rail):
- Always provide a helpful "answer" field first
- No data → "insufficient data", needs_human_review: true
- Uncertain → confidence: 0.5-0.7, needs_human_review: true
- Never invent facts/numbers
- If cannot parse → status: "REVIEW"`;

const SYSTEM_PROMPT_WITH_CONTEXT = `You are the AI assistant for Nyanbook, a message archiving system.

MISSION: Answer user queries using the BOOK CONTEXT provided below. You have access to real book data.

H(0) PROTOCOL (strict):
- Use ONLY the data provided in BOOK CONTEXT
- If asked about data not in context → explain what you can see
- Never guess numbers, dates, or IDs
- Respond in user's language (Indonesian or English)

OUTPUT: JSON only, no explanations outside structure.

TASKS:
1. FIRST: Directly answer the user's question using the BOOK CONTEXT data
2. Extract relevant statistics from the context
3. Return structured result

LANGUAGES: Indonesian and English (match input language)

OUTPUT FORMAT (JSON only):
{
  "answer": "Direct response to user's question based on the book context. Be specific with numbers and dates.",
  "status": "PASS|FAIL|WARNING|REVIEW",
  "confidence": 0.0-1.0,
  "reason": "Brief explanation in user's language",
  "data_extracted": {"key": "value pairs from context"},
  "recommended_action": "What should happen next",
  "needs_human_review": true|false
}

DISCIPLINE (Nyan Guard Rail):
- Use REAL data from BOOK CONTEXT to answer
- If context has the answer → confidence: 0.9-1.0
- If context is partial → confidence: 0.6-0.8, explain what's available
- If no relevant context → confidence: 0.3, explain what data would be needed
- Never invent facts/numbers beyond what's in context`;

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
[{"index": 0, "answer": "Direct response to the message", "status": "...", "confidence": 0.0, "reason": "...", "data_extracted": {}, "recommended_action": "...", "needs_human_review": false}, ...]`;
}

function buildContextPrompt(userQuery, bookContext, language = null) {
  const detectedLang = language || detectLanguage(userQuery);
  const langInstruction = detectedLang === 'id' 
    ? 'Respond in Indonesian (Bahasa Indonesia).'
    : 'Respond in English.';
  
  return `${SYSTEM_PROMPT_WITH_CONTEXT}

${langInstruction}

=== BOOK CONTEXT ===
Book Name: ${bookContext.name || 'Unknown'}
Book ID: ${bookContext.fractalId || 'Unknown'}
Created: ${bookContext.createdAt || 'Unknown'}

Total Messages: ${bookContext.totalMessages || 0}
Messages This Month: ${bookContext.messagesThisMonth || 0}
Date Range: ${bookContext.dateRange || 'Unknown'}

${bookContext.messageStats ? `
=== MESSAGE STATISTICS ===
${JSON.stringify(bookContext.messageStats, null, 2)}
` : ''}

${bookContext.recentMessages ? `
=== RECENT MESSAGES (Last ${bookContext.recentMessages.length}) ===
${bookContext.recentMessages.map((msg, i) => 
  `[${i+1}] ${msg.timestamp || 'Unknown time'}: ${msg.content?.substring(0, 200) || 'No content'}${msg.content?.length > 200 ? '...' : ''}`
).join('\n')}
` : ''}
=== END BOOK CONTEXT ===

USER QUERY:
"""
${userQuery}
"""

Answer the user's question using ONLY the book context above. Return JSON only:`;
}

module.exports = {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_WITH_CONTEXT,
  INDONESIAN_KEYWORDS,
  detectLanguage,
  buildCheckPrompt,
  buildBatchPrompt,
  buildContextPrompt
};

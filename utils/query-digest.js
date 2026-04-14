/**
 * Query Digest Layer — S-1.5
 *
 * Converts a raw user query into a compact DigestResult before preflight routing.
 * Sits between S-1 (context extraction) and S0 (preflight routing).
 *
 * DigestResult schema:
 *   intent       'C' | 'R'           — Create/synthesis vs Read/retrieve
 *   subject      string              — what the query is about / what to produce
 *   context      { geo, language, time }
 *   lens         string | null       — domain if detectable; null = neutral
 *   wordCount    number              — raw query word count
 *   sessionLens  { [domain]: number }— accumulated lens vector for this session
 */

const axios = require('axios');
const logger = require('../lib/logger');
const { getFastLLMBackend } = require('../config/constants');

const _fast = getFastLLMBackend();

// ==================== Create intent patterns (rule-based, zero latency) ====================
// Patterns across English / Indonesian / Malay / Chinese
// Priority: verb must appear at the START of the message or after common filler phrases.
const CREATE_VERB_PATTERNS = [
  // English
  /\b(create|generate|make|produce|draft|write|build|design|prepare|compose|formulate|draw up|come up with|give me a|write me a|make me a)\b/i,
  // Indonesian / Malay
  /\b(buatkan|buat|bikin|buat(?:kan)?|siapkan|buat(?:kan)?\s+(?:saya|aku|gue|kita)|buat\s+(?:laporan|daftar|tabel|rab|rincian|proposal|surat|kontrak|jadwal|rencana)|draft(?:kan)?|tulis(?:kan)?|rancang(?:kan)?|susun(?:kan)?|buat\s+(?:contoh|template|format))\b/i,
  // Chinese simplified
  /^(帮我|请|给我|生成|创建|写|制作|做个|起草|设计|准备)/,
];

// ==================== Safe default when model call fails ====================
function safeDefault(rawQuery, sessionLens) {
  return {
    intent: 'R',
    subject: rawQuery.substring(0, 200),
    context: { geo: null, language: 'en', time: 'any' },
    lens: null,
    wordCount: rawQuery.trim().split(/\s+/).length,
    sessionLens: sessionLens || {}
  };
}

// ==================== Rule-based intent detection ====================
function detectIntent(query) {
  const trimmed = query.trim();
  for (const pattern of CREATE_VERB_PATTERNS) {
    if (pattern.test(trimmed)) return 'C';
  }
  return 'R';
}

// ==================== Session lens: weight factor by word count ====================
// Short queries rely more on session history; long specific queries stand alone.
// sessionWeight = 1 / (1 + wordCount / 5)
function sessionLensWeight(wordCount) {
  return 1 / (1 + wordCount / 5);
}

// ==================== Update session lens accumulator ====================
// Returns a new sessionLens object (immutable update)
function updateSessionLens(sessionLens, perQueryLens) {
  if (!perQueryLens) return sessionLens || {};
  const updated = { ...(sessionLens || {}) };
  const domain = perQueryLens.toLowerCase().trim();
  updated[domain] = (updated[domain] || 0) + 1;
  return updated;
}

// ==================== Fast model: extract subject/context/lens ====================
async function extractStructuredFields(rawQuery, groqToken) {
  const systemPrompt = `You are a compact query classifier. Given a user query in any language, extract:
1. subject: the main topic or artifact (what it's about, or what to produce). Be concise (max 12 words). Never null.
2. geo: country, city, or currency zone if explicitly mentioned or strongly implied. null otherwise.
3. language: ISO 639-1 code of the query language (en, id, ms, zh, ar, fr, es, etc.).
4. time: "current" if the query asks for current/latest/now/recent/terkini/sekarang, "historical" if asking about the past/berapa tahun lalu/history, "any" otherwise.
5. lens: dominant professional domain if strongly detectable (e.g. "construction", "medical", "legal", "finance", "chemistry", "real-estate", "agriculture", "education", "technology"). null if neutral or unclear — null is preferred; only set a lens when the domain is unambiguous.

Respond ONLY with a JSON object, no explanation:
{"subject":"...","geo":null,"language":"en","time":"any","lens":null}`;

  const response = await axios.post(
    _fast.url,
    {
      model: _fast.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: rawQuery.substring(0, 800) }
      ],
      temperature: 0.05,
      max_tokens: 80
    },
    {
      headers: {
        'Authorization': `Bearer ${groqToken}`,
        'Content-Type': 'application/json'
      },
      timeout: _fast.timeouts.extract
    }
  );

  const raw = response.data?.choices?.[0]?.message?.content?.trim() || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in response: ${raw.substring(0, 100)}`);
  return JSON.parse(jsonMatch[0]);
}

// ==================== Main export ====================
/**
 * digestQuery — S-1.5 query classification
 *
 * @param {string}  rawQuery     — the raw user message
 * @param {object}  sessionLens  — accumulated lens vector from prior queries in this session
 * @param {string}  groqToken    — Groq API token (reuses existing playground token)
 * @returns {Promise<DigestResult>}
 */
async function digestQuery(rawQuery, sessionLens = {}, groqToken = null) {
  if (!rawQuery || typeof rawQuery !== 'string' || rawQuery.trim().length === 0) {
    return safeDefault(rawQuery || '', sessionLens);
  }

  const wordCount = rawQuery.trim().split(/\s+/).length;
  const intent = detectIntent(rawQuery);

  try {
    const fields = await extractStructuredFields(rawQuery, groqToken || process.env.PLAYGROUND_GROQ_TOKEN || process.env.GROQ_API_KEY);

    const lens = fields.lens && typeof fields.lens === 'string' && fields.lens.length > 0 ? fields.lens : null;
    const updatedSessionLens = updateSessionLens(sessionLens, lens);

    const result = {
      intent,
      subject: fields.subject || rawQuery.substring(0, 100),
      context: {
        geo: fields.geo || null,
        language: fields.language || 'en',
        time: ['current', 'historical', 'any'].includes(fields.time) ? fields.time : 'any'
      },
      lens,
      wordCount,
      sessionLens: updatedSessionLens
    };

    logger.debug({
      digest: {
        intent: result.intent,
        subject: result.subject,
        geo: result.context.geo,
        language: result.context.language,
        time: result.context.time,
        lens: result.lens,
        wordCount: result.wordCount,
        sessionLens: result.sessionLens
      }
    }, '🔍 S-1.5 DigestResult');

    return result;

  } catch (err) {
    logger.warn({ err: err.message }, '⚠️ S-1.5 digest model call failed — using safe default');
    return {
      ...safeDefault(rawQuery, sessionLens),
      intent
    };
  }
}

module.exports = {
  digestQuery,
  detectIntent,
  updateSessionLens,
  sessionLensWeight
};

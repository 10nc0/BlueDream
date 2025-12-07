/**
 * PROMETHEUS GROQ CLIENT
 * 
 * Llama 3.3-70B via Groq (OpenAI-compatible API)
 * 
 * Features:
 * - H(0) temperature shield (0.1 - minimal creativity)
 * - 3 retry attempts with exponential backoff
 * - 60 second timeout
 * - Error handling with graceful degradation
 * - Indonesian + English bilingual support
 * - Ultra-fast inference (300+ tokens/sec)
 */

const axios = require('axios');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_TOKEN = process.env.GROQ_API_KEY;

const DEFAULT_PARAMS = {
  max_tokens: 500,
  temperature: 0.1,           // H(0) shield - no creativity, only facts
  top_p: 0.95                 // Minimal diversity without hallucination
};

const MAX_RETRIES = 3;
const TIMEOUT_MS = 60000;  // 60 seconds
const RETRY_DELAYS = [1000, 2000, 4000];  // Exponential backoff

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callLLM(prompt, options = {}) {
  if (!GROQ_TOKEN) {
    throw new Error('GROQ_API_KEY not configured. Add it to Replit Secrets.');
  }
  
  const params = { ...DEFAULT_PARAMS, ...options };
  let lastError = null;
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      console.log(`🔮 Prometheus LLM call (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      
      const response = await axios.post(
        GROQ_API_URL,
        {
          model: GROQ_MODEL,
          messages: [
            { role: 'user', content: prompt }
          ],
          max_tokens: params.max_tokens,
          temperature: params.temperature,
          top_p: params.top_p
        },
        {
          headers: {
            'Authorization': `Bearer ${GROQ_TOKEN}`,
            'Content-Type': 'application/json'
          },
          timeout: TIMEOUT_MS
        }
      );
      
      if (response.status === 200 && response.data) {
        const result = response.data.choices?.[0]?.message?.content;
        
        if (result) {
          console.log(`✅ Prometheus LLM response received (${result.length} chars)`);
          return result;
        }
      }
      
      throw new Error(`Unexpected response format: ${JSON.stringify(response.data)}`);
      
    } catch (error) {
      lastError = error;
      
      const isRetryable = 
        error.code === 'ECONNABORTED' ||  // Timeout
        error.code === 'ETIMEDOUT' ||
        error.response?.status === 503 ||  // Service unavailable (model loading)
        error.response?.status === 429;    // Rate limited
      
      if (isRetryable && attempt < MAX_RETRIES - 1) {
        const delay = RETRY_DELAYS[attempt] || 4000;
        console.log(`⏳ Prometheus retry in ${delay}ms (${error.message})`);
        
        if (error.response?.status === 503) {
          console.log('  Model may be loading - waiting for warm-up...');
        }
        
        await sleep(delay);
        continue;
      }
      
      break;
    }
  }
  
  // Extract error message properly (handle object errors)
  let errorMessage = 'Unknown error';
  if (lastError?.response?.data) {
    const errorData = lastError.response.data;
    console.error('🔍 Groq error response:', JSON.stringify(errorData, null, 2));
    if (typeof errorData.error === 'string') {
      errorMessage = errorData.error;
    } else if (typeof errorData.error === 'object' && errorData.error?.message) {
      errorMessage = errorData.error.message;
    } else if (errorData.message) {
      errorMessage = errorData.message;
    } else {
      errorMessage = JSON.stringify(errorData);
    }
  } else if (lastError?.message) {
    errorMessage = lastError.message;
  }
  
  console.error(`❌ Prometheus LLM failed after ${MAX_RETRIES} attempts: ${errorMessage}`);
  throw new Error(`Groq API error: ${errorMessage}`);
}

function extractJSON(text) {
  if (!text) return null;
  
  try {
    return JSON.parse(text);
  } catch (e) {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e2) {
        console.log('⚠️ JSON extraction failed, returning raw text');
      }
    }
    
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]);
      } catch (e2) {
        console.log('⚠️ Array extraction failed');
      }
    }
  }
  
  return null;
}

async function checkWithLLM(prompt) {
  const rawResponse = await callLLM(prompt);
  const parsed = extractJSON(rawResponse);
  
  if (!parsed) {
    return {
      status: 'REVIEW',
      confidence: 0.3,
      reason: 'Could not parse LLM response',
      data_extracted: {},
      recommended_action: 'Manual review required',
      needs_human_review: true,
      raw_response: rawResponse
    };
  }
  
  return parsed;
}

module.exports = {
  callLLM,
  checkWithLLM,
  extractJSON,
  GROQ_API_URL,
  GROQ_MODEL,
  DEFAULT_PARAMS
};

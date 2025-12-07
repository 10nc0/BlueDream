/**
 * PROMETHEUS - THE CHECK FUNCTION
 * 
 * AI-powered message verification system for Nyanbook
 * Uses Qwen2.5-3B-Instruct via HuggingFace with H(0) guard rails
 * 
 * Features:
 * - Single and batch message checking
 * - Language detection (Indonesian/English)
 * - Business rules enforcement
 * - Zero hallucination protocol
 */

const { buildCheckPrompt, buildBatchPrompt, buildContextPrompt, detectLanguage } = require('./prompts');
const { checkWithLLM } = require('./huggingface');
const { applyBusinessRules, getRuleInfo, listRules, RULES } = require('./rules');

class Prometheus {
  /**
   * Check one or more messages against business rules
   * @param {string|string[]} messages - Message(s) to check
   * @param {string} ruleType - Rule type: tire_check, expense, inventory, delivery, general
   * @param {Object} options - Additional options
   * @returns {Promise<Object|Object[]>} Check result(s)
   */
  static async check(messages, ruleType = 'general', options = {}) {
    const isArray = Array.isArray(messages);
    const messageList = isArray ? messages : [messages];
    
    if (messageList.length === 0) {
      return isArray ? [] : {
        status: 'REVIEW',
        confidence: 0,
        reason: 'No message provided',
        data_extracted: {},
        recommended_action: 'Provide a message to check',
        needs_human_review: true
      };
    }
    
    const language = options.language || detectLanguage(messageList[0]);
    
    try {
      if (messageList.length === 1) {
        const result = await Prometheus.checkSingle(messageList[0], ruleType, language);
        return isArray ? [result] : result;
      } else {
        return await Prometheus.checkBatch(messageList, ruleType, language);
      }
    } catch (error) {
      console.error('❌ Prometheus check failed:', error.message);
      
      // Return indexed error results for batch, single result otherwise
      if (isArray) {
        return messageList.map((msg, index) => {
          const msgLang = detectLanguage(msg);
          return {
            status: 'REVIEW',
            confidence: 0,
            reason: msgLang === 'id' 
              ? `Kesalahan sistem: ${error.message}`
              : `System error: ${error.message}`,
            data_extracted: {},
            recommended_action: msgLang === 'id'
              ? 'Coba lagi atau periksa manual'
              : 'Retry or manual review required',
            needs_human_review: true,
            error: error.message,
            message_index: index,
            language: msgLang,
            rule_applied: ruleType
          };
        });
      }
      
      return {
        status: 'REVIEW',
        confidence: 0,
        reason: language === 'id' 
          ? `Kesalahan sistem: ${error.message}`
          : `System error: ${error.message}`,
        data_extracted: {},
        recommended_action: language === 'id'
          ? 'Coba lagi atau periksa manual'
          : 'Retry or manual review required',
        needs_human_review: true,
        error: error.message,
        language: language,
        rule_applied: ruleType
      };
    }
  }
  
  /**
   * Check a single message
   * @param {string} message - Message to check
   * @param {string} ruleType - Rule type
   * @param {string} language - Language code (id/en)
   * @returns {Promise<Object>} Check result
   */
  static async checkSingle(message, ruleType, language = null) {
    const lang = language || detectLanguage(message);
    const prompt = buildCheckPrompt(message, ruleType, lang);
    
    console.log(`🔮 Prometheus checking message (${ruleType}, ${lang})...`);
    
    const llmResult = await checkWithLLM(prompt);
    
    if (llmResult.data_extracted && Object.keys(llmResult.data_extracted).length > 0) {
      const businessResult = applyBusinessRules(llmResult.data_extracted, ruleType, lang);
      
      return {
        ...llmResult,
        status: businessResult.status || llmResult.status,
        reason: businessResult.reason || llmResult.reason,
        recommended_action: businessResult.recommended_action || llmResult.recommended_action,
        needs_human_review: businessResult.needs_human_review || llmResult.needs_human_review || false,
        rule_applied: ruleType,
        language: lang
      };
    }
    
    return {
      ...llmResult,
      rule_applied: ruleType,
      language: lang
    };
  }
  
  /**
   * Check multiple messages in batch
   * @param {string[]} messages - Messages to check
   * @param {string} ruleType - Rule type
   * @param {string} language - Language code
   * @returns {Promise<Object[]>} Array of check results
   */
  static async checkBatch(messages, ruleType, language = null) {
    const lang = language || detectLanguage(messages[0] || '');
    const prompt = buildBatchPrompt(messages, ruleType, lang);
    
    console.log(`🔮 Prometheus batch checking ${messages.length} messages (${ruleType}, ${lang})...`);
    
    const llmResult = await checkWithLLM(prompt);
    
    if (Array.isArray(llmResult)) {
      return llmResult.map((result, index) => {
        const msgLang = detectLanguage(messages[index] || '');
        if (result.data_extracted && Object.keys(result.data_extracted).length > 0) {
          const businessResult = applyBusinessRules(result.data_extracted, ruleType, msgLang);
          return {
            ...result,
            status: businessResult.status || result.status,
            reason: businessResult.reason || result.reason,
            recommended_action: businessResult.recommended_action || result.recommended_action,
            needs_human_review: businessResult.needs_human_review || result.needs_human_review || false,
            rule_applied: ruleType,
            language: msgLang,
            message_index: index
          };
        }
        return {
          ...result,
          rule_applied: ruleType,
          language: msgLang,
          message_index: index
        };
      });
    }
    
    // Fallback: LLM returned single object instead of array - apply to all messages with per-message language
    return messages.map((msg, index) => {
      const msgLang = detectLanguage(msg);
      return {
        ...llmResult,
        rule_applied: ruleType,
        language: msgLang,
        message_index: index
      };
    });
  }
  
  /**
   * List available rule types
   * @returns {Array} Available rules with metadata
   */
  static listRuleTypes() {
    return listRules();
  }
  
  /**
   * Get info about a specific rule type
   * @param {string} ruleType - Rule type to query
   * @returns {Object} Rule information
   */
  static getRuleInfo(ruleType) {
    return getRuleInfo(ruleType);
  }
  
  /**
   * Detect language of text
   * @param {string} text - Text to analyze
   * @returns {string} Language code (id/en)
   */
  static detectLanguage(text) {
    return detectLanguage(text);
  }
  
  /**
   * Check with book context - answers queries about actual book data
   * @param {string} userQuery - User's question about the book
   * @param {Object} bookContext - Book context with messages and stats
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Check result with answer
   */
  static async checkWithContext(userQuery, bookContext, options = {}) {
    const language = options.language || detectLanguage(userQuery);
    
    console.log(`🔮 Prometheus context query (book: ${bookContext.name}, ${bookContext.totalMessages} msgs)...`);
    
    try {
      const prompt = buildContextPrompt(userQuery, bookContext, language);
      const llmResult = await checkWithLLM(prompt);
      
      return {
        ...llmResult,
        hasBookContext: true,
        bookName: bookContext.name,
        totalMessages: bookContext.totalMessages,
        language
      };
    } catch (error) {
      console.error('❌ Prometheus context query failed:', error.message);
      
      return {
        status: 'REVIEW',
        confidence: 0,
        answer: language === 'id'
          ? `Terjadi kesalahan saat mengakses data buku: ${error.message}`
          : `Error accessing book data: ${error.message}`,
        reason: error.message,
        data_extracted: {},
        recommended_action: language === 'id'
          ? 'Coba lagi atau hubungi admin'
          : 'Try again or contact admin',
        needs_human_review: true,
        hasBookContext: false,
        error: error.message,
        language
      };
    }
  }
}

module.exports = Prometheus;

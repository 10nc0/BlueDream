/**
 * Unified Time Formatting - Single source of truth for all datetime operations
 * 
 * All pipeline datetime needs derive from a single captured timestamp.
 * This eliminates code bloat from scattered new Date() calls and ensures
 * consistent temporal awareness across audit, personality, and context layers.
 */

/**
 * Create a query timestamp object - call ONCE at pipeline start
 * @returns {QueryTimestamp} Frozen timestamp with all format accessors
 */
function createQueryTimestamp() {
  const now = new Date();
  const isoUtc = now.toISOString();
  
  const dateOnly = isoUtc.split('T')[0];
  const auditFormat = isoUtc.replace('T', ' ').slice(0, 19) + ' UTC';
  const year = now.getUTCFullYear();
  
  return Object.freeze({
    raw: now,
    isoUtc,
    
    /**
     * Human-readable date in UTC (e.g., "Sunday, January 5, 2026")
     */
    humanDateUtc: now.toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      timeZone: 'UTC'
    }),
    
    /**
     * Human-readable time in UTC (e.g., "08:45 AM")
     */
    humanTimeUtc: now.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      timeZone: 'UTC'
    }),
    
    /**
     * Date only in ISO format (e.g., "2026-01-05")
     */
    dateOnly,
    
    /**
     * Current year (e.g., 2026)
     */
    year,
    
    /**
     * Signature format for personality layer: "HH:MM:SS - YYYY/MM/DD" (UTC)
     */
    signatureFormat: formatSignatureTimestamp(now),
    
    /**
     * Audit datetime format: "YYYY-MM-DD HH:MM:SS UTC"
     */
    auditFormat,
    
    // Aliases for runAuditPass compatibility
    isoDate: dateOnly,
    isoDateTime: auditFormat
  });
}

/**
 * Format timestamp for nyan signature: HH:MM:SS - YYYY/MM/DD (UTC)
 * @param {Date} date 
 * @returns {string}
 */
function formatSignatureTimestamp(date) {
  const HH = String(date.getUTCHours()).padStart(2, '0');
  const MM = String(date.getUTCMinutes()).padStart(2, '0');
  const SS = String(date.getUTCSeconds()).padStart(2, '0');
  const YYYY = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(date.getUTCDate()).padStart(2, '0');
  return `${HH}:${MM}:${SS} - ${YYYY}/${month}/${DD}`;
}

/**
 * Build temporal awareness system message content
 * @param {QueryTimestamp} ts - Query timestamp from createQueryTimestamp()
 * @returns {string} System message content for temporal awareness
 */
function buildTemporalContent(ts) {
  return `[TEMPORAL AWARENESS - CURRENT DATE/TIME]
Today is ${ts.humanDateUtc}. Current time: ${ts.humanTimeUtc} UTC (${ts.isoUtc}).
Use this timestamp to contextualize any time-sensitive queries (schedules, news, events, deadlines).
When discussing future or past events, reference dates relative to today.`;
}

module.exports = {
  createQueryTimestamp,
  formatSignatureTimestamp,
  buildTemporalContent
};

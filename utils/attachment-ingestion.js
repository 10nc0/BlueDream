/**
 * L1: Perception Ingestion Facade
 * Bridge between attachment-cascade (Perception) and data-package (Substrate)
 */
const { executeExtractionCascade } = require('./attachment-cascade');
const { FILE_TYPES } = require('./file-types');
const { TIMEOUTS } = require('../config/constants');

class AttachmentIngestion {
  /**
   * Wrap promise with timeout for extraction protection
   * @param {Promise} promise - The promise to wrap
   * @param {number} ms - Timeout in milliseconds
   * @param {string} operation - Operation name for error message
   * @returns {Promise} Wrapped promise that rejects on timeout
   */
  static _withTimeout(promise, ms, operation = 'operation') {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${operation} timed out after ${ms}ms`));
      }, ms);
    });
    
    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timeoutId);
    });
  }

  /**
   * Ingest attachments and prepare S-1 Perception payload
   * @param {Array} attachments - Array of attachment objects
   * @param {string} tenantId - Tenant identifier for cache scoping
   * @returns {Promise<Object>} Perception payload
   */
  static async ingest(attachments, tenantId) {
    if (!attachments || attachments.length === 0) {
      return {
        hasAttachments: false,
        files: [],
        extractedText: '',
        meta: {
          fileCount: 0,
          timestamp: new Date().toISOString()
        }
      };
    }

    let extractionResult;
    try {
      // Wrap extraction cascade with 30s timeout to prevent hung file parsing
      extractionResult = await this._withTimeout(
        executeExtractionCascade(attachments, { tenantId }),
        TIMEOUTS.EXTRACTION,
        'File extraction'
      );
    } catch (err) {
      console.error(`⚠️ AttachmentIngestion: ${err.message}`);
      // Return partial result on timeout/error
      return {
        hasAttachments: true,
        files: [],
        extractedText: `[Extraction failed: ${err.message}]`,
        meta: {
          fileCount: attachments.length,
          timestamp: new Date().toISOString(),
          tenantId,
          toolsUsed: [],
          error: err.message
        }
      };
    }
    
    return {
      hasAttachments: true,
      files: extractionResult.files || [],
      extractedText: extractionResult.text || '',
      meta: {
        fileCount: attachments.length,
        timestamp: new Date().toISOString(),
        tenantId,
        toolsUsed: extractionResult.toolsUsed || []
      }
    };
  }

  /**
   * Helper to identify primary file type from ingested files
   * @param {Array} files - Extracted files
   * @returns {string} One of FILE_TYPES or 'unknown'
   */
  static getPrimaryFileType(files) {
    if (!files || files.length === 0) return 'none';
    
    // Priority: Code > Spreadsheet > PDF > Text
    if (files.some(f => f.fileType === FILE_TYPES.CODE)) return FILE_TYPES.CODE;
    if (files.some(f => f.fileType === FILE_TYPES.EXCEL || f.fileType === FILE_TYPES.CSV)) return FILE_TYPES.EXCEL;
    if (files.some(f => f.fileType === FILE_TYPES.PDF)) return FILE_TYPES.PDF;
    
    return files[0].fileType || 'text';
  }
}

module.exports = { AttachmentIngestion };

/**
 * L1: Perception Ingestion Facade
 * Bridge between attachment-cascade (Perception) and data-package (Substrate)
 */
const { executeExtractionCascade } = require('./attachment-cascade');
const { FILE_TYPES } = require('./data-package');

class AttachmentIngestion {
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

    const extractionResult = await executeExtractionCascade(attachments, { tenantId });
    
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

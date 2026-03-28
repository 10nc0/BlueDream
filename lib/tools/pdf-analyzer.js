'use strict';

const logger = require('../logger');

module.exports = {
    name: 'pdf-analyzer',
    description: 'Analyze PDF documents: extract text, tables, and structured data. Supports scanned PDFs via OCR fallback.',
    parameters: {
        data: { type: 'string', required: true, description: 'Base64-encoded PDF data or raw buffer' },
        fileName: { type: 'string', required: false, description: 'Original file name (default: document.pdf)' },
        tenantId: { type: 'string', required: false, description: 'Tenant ID for cache scoping' }
    },

    async execute(data, fileName = 'document.pdf', opts = {}) {
        if (!data) {
            return { success: false, error: 'No data provided' };
        }

        const tenantId = opts.tenantId || null;

        try {
            const { processDocumentForAI } = require('../../utils/attachment-cascade');
            const result = await processDocumentForAI(data, fileName, 'application/pdf', { tenantId });

            if (!result.success || !result.text) {
                logger.debug({ fileName }, '📄 pdf-analyzer: no content extracted');
                return { success: false, error: result.error || 'No content extracted', fileName };
            }

            logger.debug({ fileName, chars: result.text.length, tools: result.toolsUsed }, '📄 pdf-analyzer: extraction complete');

            return {
                success: true,
                text: result.text,
                fileName: result.fileName,
                fileType: result.fileType,
                toolsUsed: result.toolsUsed || [],
                charCount: result.text.length
            };
        } catch (err) {
            logger.error({ err, fileName }, '📄 pdf-analyzer: error');
            return { success: false, error: err.message, fileName };
        }
    }
};

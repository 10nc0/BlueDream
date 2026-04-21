'use strict';

function createErrorHandler(options = {}) {
    const isProd = options.isProd ?? (process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production');
    const logger = options.logger ?? console;

    return function errorHandler(err, req, res, next) {
        const requestId = req.requestId || req.headers['x-request-id'] || 'unknown';
        
        const statusCode = err.statusCode || err.status || 500;
        const isOperational = err.isOperational || false;
        
        if (!isOperational || statusCode >= 500) {
            logger.error(`[${requestId}] Unhandled error:`, {
                message: err.message,
                stack: err.stack,
                code: err.code,
                path: req.path,
                method: req.method
            });
        }

        const response = {
            error: isProd && statusCode >= 500 ? 'Internal server error' : err.message,
            code: err.code || 'ERROR',
            requestId
        };

        if (err.details) {
            response.details = err.details;
        }

        if (!isProd && err.stack) {
            response.stack = err.stack.split('\n').slice(0, 5);
        }

        res.status(statusCode).json(response);
    };
}

function notFoundHandler(req, res) {
    res.status(404).json({
        error: 'Endpoint not found',
        code: 'NOT_FOUND',
        path: req.path,
        method: req.method
    });
}

module.exports = {
    createErrorHandler,
    notFoundHandler
};

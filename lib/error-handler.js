'use strict';

class AppError extends Error {
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}

class ValidationError extends AppError {
    constructor(message, details = []) {
        super(message, 400, 'VALIDATION_ERROR');
        this.details = details;
    }
}

class AuthError extends AppError {
    constructor(message = 'Authentication required') {
        super(message, 401, 'AUTH_ERROR');
    }
}

class ForbiddenError extends AppError {
    constructor(message = 'Access denied') {
        super(message, 403, 'FORBIDDEN');
    }
}

class NotFoundError extends AppError {
    constructor(resource = 'Resource') {
        super(`${resource} not found`, 404, 'NOT_FOUND');
    }
}

class RateLimitError extends AppError {
    constructor(message = 'Too many requests') {
        super(message, 429, 'RATE_LIMIT');
    }
}

function createErrorHandler(options = {}) {
    const isProd = options.isProd ?? process.env.NODE_ENV === 'production';
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

function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
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
    AppError,
    ValidationError,
    AuthError,
    ForbiddenError,
    NotFoundError,
    RateLimitError,
    createErrorHandler,
    asyncHandler,
    notFoundHandler
};

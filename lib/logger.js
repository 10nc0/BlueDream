const pino = require('pino');

const isProd = process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production';

const logger = pino({
    level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
    ...(isProd ? {
        formatters: {
            level: (label) => ({ level: label })
        }
    } : {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
                singleLine: true
            }
        }
    })
});

logger.info({ env: isProd ? 'production' : 'development' }, 'Logger initialized');

module.exports = logger;

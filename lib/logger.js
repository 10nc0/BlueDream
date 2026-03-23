const pino = require('pino');

const isProd = process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production';

const logger = pino({
    level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: !isProd,
            translateTime: isProd ? false : 'SYS:yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname',
            messageFormat: '{msg}'
        }
    }
});

logger.info({ env: isProd ? 'production' : 'development' }, 'Logger initialized');

module.exports = logger;

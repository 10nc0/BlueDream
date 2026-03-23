const pino = require('pino');

const isProd = process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production';

const msgStream = {
    write(chunk) {
        try {
            process.stdout.write(JSON.parse(chunk).msg + '\n');
        } catch {
            process.stdout.write(chunk);
        }
    }
};

const logger = pino(
    { level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug') },
    msgStream
);

logger.info({ env: isProd ? 'production' : 'development' }, '🪵 Logger initialized');

module.exports = logger;

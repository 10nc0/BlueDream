'use strict';
const { workerData, parentPort } = require('node:worker_threads');
const media = require('./book-evidence');
(async () => {
    const buffer = Buffer.from(workerData.buffer);
    const result = workerData.kind === 'pdf'
        ? await media.renderLocal(buffer, workerData.page) : await media.decodeImageLocal(buffer);
    parentPort.postMessage(result);
})().catch(error => parentPort.postMessage({ error: 'Original unreadable, unsupported, or outside processing limits.', status: error.status || 415 }));

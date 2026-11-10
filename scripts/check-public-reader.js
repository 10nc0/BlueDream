'use strict';

// Run in the target runtime before rollout. No website is contacted.
const { renderDocument } = require('../lib/public-reader/renderer');
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15000);
renderDocument('<main><p>Static public reader runtime check.</p></main>', { signal: controller.signal })
  .then(text => {
    if (!text.includes('Static public reader runtime check.')) throw new Error('Unexpected extraction');
    console.log('Sandboxed offline Chromium: available. Measure resource headroom before enabling concurrent reads.');
  })
  .catch(error => {
    console.error(`${error.code || 'runtime_check_failed'}: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(timer));

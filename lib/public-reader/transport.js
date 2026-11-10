'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const { ReaderError, validateUrl, isPublicAddress } = require('./policy');

const MAX_BYTES = 2 * 1024 * 1024;

async function resolveAddresses(host, { signal } = {}) {
  signal?.throwIfAborted();
  if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
  const resolver = new dns.Resolver({ timeout: 4000, tries: 1 });
  const cancel = () => resolver.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const answers = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    signal?.throwIfAborted();
    const records = answers.flatMap((answer, i) => answer.status === 'fulfilled'
      ? answer.value.map(address => ({ address, family: i === 0 ? 4 : 6 })) : []);
    if (!records.length) throw new ReaderError('dns_unavailable', 'Public source DNS lookup failed.');
    return records;
  } finally {
    signal?.removeEventListener('abort', cancel);
    resolver.cancel();
  }
}

// Node's socket uses precisely the vetted answer, never an independent DNS
// resolution. TLS still verifies the original hostname. No global fetch/proxy,
// credentials, cookie jar, redirects, decompression or reusable agent.
async function requestDocument(raw, { signal, lookup = resolveAddresses } = {}) {
  const url = validateUrl(raw);
  signal?.throwIfAborted();
  const records = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true, signal });
  signal?.throwIfAborted();
  if (!records.length || records.some(r => !isPublicAddress(r.address))) {
    throw new ReaderError('denied_destination', 'Destination resolved to a private or reserved address.');
  }
  const pinned = records[0];
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', agent: false, signal,
      lookup: (_host, opts, cb) => opts.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family),
      headers: {
        'User-Agent': 'NyanBook-Public-Reader/1.0',
        Accept: 'text/html,application/xhtml+xml,text/plain',
        'Accept-Encoding': 'identity'
      }
    }, res => {
      res.on('error', reject);
      const fail = (code, message) => {
        const error = new ReaderError(code, message);
        res.destroy(error); reject(error);
      };
      if (res.statusCode >= 300 && res.statusCode < 400) {
        const location = res.headers.location;
        res.destroy();
        return resolve({ redirect: location, status: res.statusCode });
      }
      if (res.statusCode !== 200) return fail('inaccessible', `Public page returned HTTP ${res.statusCode}.`);
      if (res.headers['content-disposition'] ||
          (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        return fail('unsupported_document', 'Downloads and compressed documents are not supported.');
      }
      const type = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(type)) {
        return fail('unsupported_document', 'Only HTML and plain-text documents are supported.');
      }
      if (Number(res.headers['content-length']) > MAX_BYTES) return fail('document_limit', 'Document exceeds 2 MiB.');
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) return fail('document_limit', 'Document exceeds 2 MiB.');
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), type, bytes }));
    });
    req.setTimeout(12000, () => req.destroy(new ReaderError('timeout', 'Public page transfer timed out.')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchDocument(raw, opts) {
  let current = validateUrl(raw).href;
  for (let i = 0; i <= 5; i++) {
    const result = await requestDocument(current, opts);
    if (!Object.hasOwn(result, 'redirect')) return { ...result, finalUrl: current };
    if (!result.redirect) throw new ReaderError('inaccessible', 'Redirect has no destination.');
    current = validateUrl(new URL(result.redirect, current).href).href;
  }
  throw new ReaderError('redirect_limit', 'Public page exceeded the redirect limit.');
}

module.exports = { requestDocument, fetchDocument, resolveAddresses, MAX_BYTES };

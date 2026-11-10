'use strict';

const ipaddr = require('ipaddr.js');

class ReaderError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const deny = (message) => { throw new ReaderError('denied_destination', message); };

function isPublicAddress(address) {
  try {
    const ip = ipaddr.process(address);
    if (ip.range() !== 'unicast') return false;
    // IPv6 must be globally allocated unicast, not translation/tunnelling space.
    return ip.kind() === 'ipv4' || ip.match(ipaddr.parse('2000::'), 3);
  } catch { return false; }
}

function validateUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { deny('Invalid public reading URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      url.port || url.search || url.hash || url.href.length > 2048) {
    deny('Only anonymous HTTP(S) reading URLs on standard ports, without query strings or fragments, are supported.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (ipaddr.isValid(host) && !isPublicAddress(host)) deny('Private and reserved addresses are not public reading destinations.');
  const appHosts = ['nyanbook.io', process.env.APP_DOMAIN, process.env.REPLIT_DEV_DOMAIN,
    ...(process.env.REPLIT_DOMAINS || '').split(',')].filter(Boolean);
  if ((!host.includes('.') && !ipaddr.isValid(host)) || appHosts.some(h => host === h || host.endsWith(`.${h}`)) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(host)) {
    deny('Application origins and non-public hosts are not reading destinations.');
  }
  let path;
  try { path = decodeURIComponent(url.pathname).toLowerCase(); } catch { deny('Invalid URL encoding.'); }
  // Encoded separators and nested encoding make route review ambiguous.
  if (/%|\\|[;@]/.test(path) || path.split('/').some(segment => /^[a-f0-9]{32,}$/.test(segment) || /^[a-z0-9_-]{40,}$/.test(segment) && /\d/.test(segment)) ||
      /(?:^|[/_.-])(log(?:in|out)|sign(?:in|out|up)|auth|oauth|account|admin|api|graphql|cart|checkout|buy|purchase|pay|send|message|compose|submit|delete|remove|update|create|edit|save|unsubscribe|subscribe|confirm|activate|callback|token|secret|session|download|upload|export|redirect)(?:$|[/_.-])/.test(path)) {
    deny('Action-like, credential-bearing, or ambiguous URLs are not supported.');
  }
  const readingRoute = path === '/' ||
    /^\/(?:wiki|docs|documentation|articles|article|news|blog|blogs|research|publications|reports|reference|guide|guides|learn|about)(?:\/|$)/.test(path) ||
    (host === 'github.com' && /^\/[^/]+\/[^/]+(?:\/(?:blob|tree)\/[^/]+\/.+)?\/?$/.test(path)) ||
    (host === 'raw.githubusercontent.com' && /^\/[^/]+\/[^/]+\/[^/]+\/.+/.test(path));
  if (!readingRoute) deny('This route has not been approved as public reading content.');
  return url;
}

module.exports = { ReaderError, validateUrl, isPublicAddress };

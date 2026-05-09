'use strict';

// ────────────────────────────────────────────────────────────────────
// BRAND — fork-friendly identity attribution
// ────────────────────────────────────────────────────────────────────
//
// Every field below reads from an env var with the current upstream
// NyanBook value as the documented default. A forker sets BRAND_NAME
// and the related vars to rebrand all user-visible cosmetic strings,
// outbound API attribution headers, JWT claims, and storage prefixes
// without source edits.
//
// EPISTEMIC ANCHOR — INTENTIONALLY EXCLUDED
// The Nyan Protocol identity (`prompts/nyan-protocol.js`,
// `prompts/nyan-identity.js`, the audit-route system prompt) is the
// AI's canonical self-model — `Origin=0. void nyan of nyanbook.
// Progression=genesis=φ²` — and is NOT branding. It is not in this
// module. Forkers who want a different AI identity must fork the
// protocol itself; templating BRAND.name into it would corrupt the
// epistemic anchor. The preflight router and query classifier
// identity regexes that match the literal word `nyanbook` likewise
// stay literal — the running AI still identifies as nyan-of-nyanbook
// regardless of who hosts it.
// ────────────────────────────────────────────────────────────────────

const NAME              = process.env.BRAND_NAME              || 'Nyanbook';
const NAME_LOWER        = process.env.BRAND_NAME_LOWER        || NAME.toLowerCase();
const FROM_EMAIL        = process.env.RESEND_FROM_EMAIL       || 'nyan@nyanbook.io';
const FROM_NAME         = process.env.RESEND_FROM_NAME        || 'NyanBook';
const IPFS_PREFIX       = process.env.BRAND_IPFS_PREFIX       || 'nyanbook-capsule';
const JWT_ISSUER        = process.env.BRAND_JWT_ISSUER        || 'nyanbook';
const JWT_AUDIENCE      = process.env.BRAND_JWT_AUDIENCE      || 'nyanbook-app';
const OPENROUTER_TITLE  = process.env.BRAND_OPENROUTER_TITLE  || 'Nyanbook';
const OPENROUTER_REFERER= process.env.BRAND_OPENROUTER_REFERER|| 'https://nyanbook.io';
const DATA_SALT         = process.env.BRAND_DATA_SALT         || 'nyanbook-salt';
const BACKUP_PREFIX     = process.env.BRAND_BACKUP_PREFIX     || 'nyanbook_backup';
const EXPORT_FORMAT_TAG = process.env.BRAND_EXPORT_FORMAT_TAG || 'nyanbook-export';
const EXPORT_SOURCE_FALLBACK = process.env.BRAND_EXPORT_SOURCE_FALLBACK || 'nyanbook';

const BRAND = {
  name: NAME,
  nameLower: NAME_LOWER,
  fromEmail: FROM_EMAIL,
  fromName: FROM_NAME,
  ipfsPrefix: IPFS_PREFIX,
  jwtIssuer: JWT_ISSUER,
  jwtAudience: JWT_AUDIENCE,
  openrouterTitle: OPENROUTER_TITLE,
  openrouterReferer: OPENROUTER_REFERER,
  dataSalt: DATA_SALT,
  backupPrefix: BACKUP_PREFIX,
  exportFormatTag: EXPORT_FORMAT_TAG,
  exportSourceFallback: EXPORT_SOURCE_FALLBACK,
};

module.exports = { BRAND };

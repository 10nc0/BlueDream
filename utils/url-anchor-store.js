/**
 * URL Anchor Store
 *
 * When a user explicitly pastes a URL in the playground, it is stored here
 * as a session anchor keyed by clientIp. Future turns — even after the φ-8
 * message window rolls the original message out of conversation history —
 * can still retrieve it for pronoun resolution ("is it running?", "what is it?").
 *
 * Decay: each turn increments the anchor age; anchors are dropped once
 * age >= PHI_8 (8), matching the memory manager's sliding window.
 */

const logger = require('../lib/logger');

const PHI_8 = 8;
const MAX_ANCHORS_PER_IP = 10;

const _store = new Map(); // ip → [{url, label, age}]

/**
 * Register a URL anchor for this IP.
 * No-op if the URL is already anchored (deduplicates by exact URL).
 */
function addAnchor(ip, url, label = '') {
    if (!ip || !url || typeof url !== 'string') return;
    if (!_store.has(ip)) _store.set(ip, []);
    const list = _store.get(ip);
    if (list.some(a => a.url === url)) return;
    list.push({ url: url.slice(0, 500), label: (label || '').slice(0, 100), age: 0 });
    if (list.length > MAX_ANCHORS_PER_IP) list.shift();
    logger.debug({ url: url.slice(0, 70) }, '🔗 Anchor: stored');
}

/**
 * Advance all anchors for this IP by one turn.
 * Drops anchors that have exceeded the φ-8 window.
 * Call once per completed pipeline turn.
 */
function tickAnchors(ip) {
    if (!ip || !_store.has(ip)) return;
    const updated = _store.get(ip)
        .map(a => ({ ...a, age: a.age + 1 }))
        .filter(a => a.age < PHI_8);
    if (updated.length === 0) {
        _store.delete(ip);
    } else {
        _store.set(ip, updated);
    }
}

/**
 * Return active anchors (age < PHI_8) for this IP.
 * Returns [] when none exist.
 */
function getAnchors(ip) {
    if (!ip) return [];
    return (_store.get(ip) || []).filter(a => a.age < PHI_8);
}

/**
 * Clear all anchors for this IP (e.g. on session nuke).
 */
function clearAnchors(ip) {
    if (ip) _store.delete(ip);
}

module.exports = { addAnchor, tickAnchors, getAnchors, clearAnchors };

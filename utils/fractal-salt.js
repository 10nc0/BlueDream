'use strict';

const crypto = require('crypto');

let ephemeralSalt = null;

function getFractalSalt() {
  if (process.env.FRACTAL_SALT) return process.env.FRACTAL_SALT;
  if (!ephemeralSalt) {
    ephemeralSalt = crypto.randomBytes(32).toString('hex');
    if (process.env.NODE_ENV !== 'production') {
      console.warn('⚠️  FRACTAL_SALT not set — one ephemeral development salt is active; IDs and capsule proofs will not survive restart.');
    }
  }
  return ephemeralSalt;
}

module.exports = { getFractalSalt };
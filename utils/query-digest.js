/**
 * Compatibility shim — query-digest has been renamed to grammar-bridge.
 * Re-exports `bridgeQuery` as `digestQuery` for one release cycle so external
 * callers that haven't migrated yet keep working. Prefer `./grammar-bridge`.
 */
const { bridgeQuery, detectIntent, updateSessionLens, sessionLensWeight } = require('./grammar-bridge');

module.exports = {
  digestQuery: bridgeQuery,
  detectIntent,
  updateSessionLens,
  sessionLensWeight
};

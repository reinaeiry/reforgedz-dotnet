// Shared cache of our community's BattleMetrics server IDs.
// Populated by server.js as it resolves Pterodactyl -> BM mappings during polling.
// Read by battlemetrics.js to scope console-signin lookups to our servers only.

const cache = new Set();

function rememberBmId(bmId) {
  if (bmId) cache.add(String(bmId));
}

function getBmIds() {
  const envIds = (process.env.REFORGEDZ_BM_SERVER_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (envIds.length) return envIds;
  return Array.from(cache);
}

module.exports = { rememberBmId, getBmIds };

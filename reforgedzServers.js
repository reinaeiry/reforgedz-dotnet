// Our community's BattleMetrics server ids, searched FIRST when a console player
// signs in (battlemetrics.js).
//
// Keyed by the panel's server identifier and kept current by server.js on every
// status poll, never only added to. A gamertag found on one of these records is
// trusted without asking the organisation, so an id that stops being ours (a
// server moved, or a lookup during a BattleMetrics hiccup matched another
// community's "[EU1]" by its tag) must leave the scope at once, not linger until
// the next restart. server.js only puts an id here after BattleMetrics confirms
// the record sits at the server's own address and under our organisation.

const byServer = new Map();

function setBmId(serverKey, bmId) {
  if (serverKey && bmId) byServer.set(String(serverKey), String(bmId));
}

function forgetBmId(serverKey) {
  byServer.delete(String(serverKey));
}

// Drop every server the panel no longer lists.
function retainServers(serverKeys) {
  const keep = new Set((serverKeys || []).map(String));
  for (const key of Array.from(byServer.keys())) {
    if (!keep.has(key)) byServer.delete(key);
  }
}

// Numeric order, so the same set of ids always reads the same (the lookup cache
// is keyed on it).
function sortIds(ids) {
  return Array.from(new Set(ids)).sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
}

let warnedBadEnv = false;

function getBmIds() {
  const verified = sortIds(Array.from(byServer.values()));
  if (verified.length) return verified;
  // Only until the panel has verified a record, for example when the panel is
  // unreachable. These ids are trusted as given.
  const raw = String(process.env.REFORGEDZ_BM_SERVER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  // BattleMetrics ignores a filter it cannot read and searches everyone, so
  // only numbers may reach it.
  const ids = raw.filter((s) => /^\d+$/.test(s));
  if (ids.length !== raw.length && !warnedBadEnv) {
    console.error('[bm] REFORGEDZ_BM_SERVER_IDS has entries that are not numbers; they are ignored');
    warnedBadEnv = true;
  }
  return sortIds(ids);
}

module.exports = {
  setBmId,
  forgetBmId,
  retainServers,
  getBmIds,
  _test: {
    reset() {
      byServer.clear();
      warnedBadEnv = false;
    },
  },
};

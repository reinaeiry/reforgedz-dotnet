const BM_BASE = 'https://api.battlemetrics.com';
const reforgedzServers = require('./reforgedzServers');

// The ReforgedZ organisation on BattleMetrics. Every server we have ever run sits
// under it, including the records from before the June 2026 box move, when the
// servers were on different IPs and so on different BattleMetrics server records.
const DEFAULT_BM_ORG_ID = '112993';
function orgId() {
  return String(process.env.REFORGEDZ_BM_ORG_ID || DEFAULT_BM_ORG_ID).trim();
}

function token() {
  return process.env.BATTLEMETRICS_TOKEN || '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One BattleMetrics GET. Never throws. A 429 is retried, because a rate limit
// must never read as "no such player": that is how a busy minute used to tell a
// real console player they had never played here.
async function bmGet(path, attempt = 0) {
  const tk = token();
  if (!tk) return { ok: false, status: 0, reason: 'BATTLEMETRICS_TOKEN not set' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${BM_BASE}${path}`, { headers: { Authorization: `Bearer ${tk}` }, signal: ctrl.signal });
    if (res.status === 429 && attempt < 3) {
      const ra = parseFloat(res.headers.get('retry-after') || '');
      clearTimeout(timer);
      await sleep(Math.min(isFinite(ra) ? ra * 1000 : 1500 * (attempt + 1), 10000));
      return bmGet(path, attempt + 1);
    }
    if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (e) {
    return { ok: false, status: 0, reason: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Players in a search result matching the gamertag, by name or by any of their
// identifiers, case-insensitively.
function matchingPlayers(data, wanted) {
  const identifiers = new Map();
  for (const inc of (data.included || [])) {
    if (inc.type === 'identifier') identifiers.set(String(inc.id), inc);
  }
  const w = wanted.toLowerCase();
  return (data.data || []).filter((p) => p.type === 'player').filter((p) => {
    const name = (p.attributes && p.attributes.name) || '';
    if (name.toLowerCase() === w) return true;
    const refs = (p.relationships && p.relationships.identifiers && p.relationships.identifiers.data) || [];
    return refs.some((ref) => {
      const ident = identifiers.get(String(ref.id));
      return !!(ident && ident.attributes && String(ident.attributes.identifier || '').toLowerCase() === w);
    });
  });
}

// Resolve a console gamertag to a BattleMetrics player and their Reforger id.
//
//   { bmPlayerId, biUid, displayName, platform, scope }   exactly one player found
//   null                                                  no such player, or the name is ambiguous
//   { unavailable: true, reason }                         BattleMetrics could not be asked
//
// ⛔ Callers MUST check `unavailable` before treating the result as a match: it is
// a truthy object.
//
// Scoping. The search is first limited to the servers we run today, and only if
// that finds nobody is it widened to the whole ReforgedZ organisation. It used to
// stop at today's servers, which locked out every console player whose history
// sits on an older server record. Measured 2026-09-13 across all 110 console
// accounts: 84 could sign in, 24 could not, and the organisation scope found 19
// of those 24 as exactly the right account. The widening only runs on zero
// matches, so nobody who resolves today can resolve differently.
//
// It never searches the whole of BattleMetrics. The old code did when the server
// id cache was still cold, and an unscoped search can match a stranger who shares
// a gamertag and create a ReforgedZ account for them.
async function lookupPlayerByGamertag(gamertag, platform) {
  const trimmed = String(gamertag || '').trim();
  if (!trimmed) return null;
  if (!token()) {
    console.error('[bm] BATTLEMETRICS_TOKEN not set');
    return { unavailable: true, reason: 'BATTLEMETRICS_TOKEN not set' };
  }

  const scopes = [];
  const serverIds = reforgedzServers.getBmIds();
  if (serverIds.length) scopes.push({ name: 'servers', filter: `filter[servers]=${serverIds.join(',')}` });
  scopes.push({ name: 'organization', filter: `filter[organizations]=${orgId()}` });

  let matches = [];
  let scopeUsed = null;
  for (const scope of scopes) {
    const r = await bmGet(`/players?filter[search]=${encodeURIComponent(trimmed)}&${scope.filter}&include=identifier&page[size]=20`);
    if (!r.ok) {
      console.error(`[bm] gamertag search (${scope.name}) failed: ${r.reason}`);
      return { unavailable: true, reason: r.reason };
    }
    matches = matchingPlayers(r.data, trimmed);
    scopeUsed = scope.name;
    // Stop at the first scope that finds anyone. More than one match is
    // ambiguous, and widening the scope could only add candidates.
    if (matches.length) break;
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    console.warn(`[bm] ambiguous gamertag "${trimmed}": ${matches.length} players under the ${scopeUsed} scope, refusing to guess`);
    return null;
  }
  if (scopeUsed === 'organization') {
    console.log(`[bm] "${trimmed}" found under the organisation scope, not on today's servers`);
  }

  const player = matches[0];
  const bmPlayerId = String(player.id);
  const displayName = (player.attributes && player.attributes.name) || trimmed;

  // The search returns only the identifiers that matched the query, so fetch the
  // player for the full list, which includes reforgerUUID (the in-game id).
  let biUid = null;
  const detail = await bmGet(`/players/${bmPlayerId}?include=identifier`);
  if (detail.ok) {
    for (const inc of (detail.data.included || [])) {
      if (inc.type !== 'identifier' || !inc.attributes) continue;
      if (String(inc.attributes.type).toLowerCase() !== 'reforgeruuid') continue;
      const v = String(inc.attributes.identifier || '').toLowerCase();
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) { biUid = v; break; }
    }
  } else {
    console.error(`[bm] player detail for ${bmPlayerId} failed: ${detail.reason}`);
  }

  return { bmPlayerId, biUid, displayName, platform, scope: scopeUsed };
}

// Has BattleMetrics ever seen this Reforger identity? The text search cannot
// answer that (it is a fuzzy name search and returns strangers for any
// string), but the identifier-match endpoint is exact. Used to check an id a
// Steam player typed before the shop starts sending their perks to it.
//   found: true | false | null (null = could not ask; do not block on it)
async function matchReforgerUuid(uuid) {
  const tk = token();
  if (!tk) return { found: null, error: 'BATTLEMETRICS_TOKEN not set' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${BM_BASE}/players/match`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [{ type: 'identifier', attributes: { type: 'reforgerUUID', identifier: String(uuid).toLowerCase() } }] }),
      signal: ctrl.signal
    });
    if (!res.ok) return { found: null, error: `HTTP ${res.status}` };
    const j = await res.json();
    const hit = (j.data || [])[0];
    if (!hit) return { found: false, lastSeen: null, bmPlayerId: null };
    const playerId = hit.relationships && hit.relationships.player && hit.relationships.player.data ? String(hit.relationships.player.data.id) : null;
    return { found: true, lastSeen: (hit.attributes && hit.attributes.lastSeen) || null, bmPlayerId: playerId };
  } catch (e) {
    return { found: null, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { lookupPlayerByGamertag, matchReforgerUuid };

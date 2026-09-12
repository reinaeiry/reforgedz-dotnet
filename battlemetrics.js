const BM_BASE = 'https://api.battlemetrics.com';
const reforgedzServers = require('./reforgedzServers');

function token() {
  return process.env.BATTLEMETRICS_TOKEN || '';
}

async function lookupPlayerByGamertag(gamertag, platform) {
  const tk = token();
  if (!tk) {
    console.error('[bm] BATTLEMETRICS_TOKEN not set');
    return null;
  }

  const trimmed = String(gamertag || '').trim();
  if (!trimmed) return null;

  const ourServerIds = reforgedzServers.getBmIds();
  let url = `${BM_BASE}/players?filter[search]=${encodeURIComponent(trimmed)}&include=identifier&page[size]=20`;
  if (ourServerIds.length) {
    url += `&filter[servers]=${ourServerIds.join(',')}`;
  } else {
    console.warn('[bm] No ReforgedZ BM server IDs cached yet — search will not be scoped to our servers. Set REFORGEDZ_BM_SERVER_IDS in .env or wait for the first Pterodactyl poll cycle.');
  }

  let data;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tk}` } });
    if (!res.ok) {
      console.error('[bm] HTTP', res.status);
      return null;
    }
    data = await res.json();
  } catch (e) {
    console.error('[bm] Fetch failed:', e.message);
    return null;
  }

  const identifiers = new Map();
  for (const inc of (data.included || [])) {
    if (inc.type === 'identifier') identifiers.set(String(inc.id), inc);
  }

  const wanted = trimmed.toLowerCase();
  const players = (data.data || []).filter(p => p.type === 'player');

  const matches = players.filter(p => {
    const name = (p.attributes && p.attributes.name) || '';
    if (name.toLowerCase() === wanted) return true;
    const idRefs = (p.relationships && p.relationships.identifiers && p.relationships.identifiers.data) || [];
    return idRefs.some(ref => {
      const ident = identifiers.get(String(ref.id));
      if (!ident || !ident.attributes) return false;
      const val = String(ident.attributes.identifier || '').toLowerCase();
      return val === wanted;
    });
  });

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    console.warn('[bm] Ambiguous match for', trimmed, '- returning null');
    return null;
  }

  const player = matches[0];
  const bmPlayerId = String(player.id);
  const displayName = (player.attributes && player.attributes.name) || trimmed;

  // The /players search endpoint returns only the identifiers that matched
  // the search query (i.e. the `name` identifier). To get the full identifier
  // list including `reforgerUUID` (the Arma Reforger BI UID), fetch the
  // per-player resource explicitly.
  let biUid = null;
  try {
    const detailUrl = `${BM_BASE}/players/${bmPlayerId}?include=identifier`;
    const detailRes = await fetch(detailUrl, { headers: { Authorization: `Bearer ${tk}` } });
    if (detailRes.ok) {
      const detail = await detailRes.json();
      for (const inc of (detail.included || [])) {
        if (inc.type !== 'identifier' || !inc.attributes) continue;
        if (String(inc.attributes.type).toLowerCase() !== 'reforgeruuid') continue;
        const v = String(inc.attributes.identifier || '').toLowerCase();
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) {
          biUid = v;
          break;
        }
      }
    } else {
      console.error('[bm] player detail HTTP', detailRes.status);
    }
  } catch (e) {
    console.error('[bm] player detail fetch failed:', e.message);
  }

  return { bmPlayerId, biUid, displayName, platform };
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

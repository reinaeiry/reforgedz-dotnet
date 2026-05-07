const BM_BASE = 'https://api.battlemetrics.com';

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

  const url = `${BM_BASE}/players?filter[search]=${encodeURIComponent(trimmed)}&include=identifier&page[size]=20`;

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

  const idRefs = (player.relationships && player.relationships.identifiers && player.relationships.identifiers.data) || [];
  let biUid = null;
  for (const ref of idRefs) {
    const ident = identifiers.get(String(ref.id));
    if (!ident || !ident.attributes) continue;
    const t = String(ident.attributes.type || '').toLowerCase();
    if (t === 'bohemiainteractiveid' || t === 'bohemiauid' || t === 'bohemiaid') {
      const v = String(ident.attributes.identifier || '').toLowerCase();
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) {
        biUid = v;
        break;
      }
    }
  }

  return { bmPlayerId, biUid, displayName, platform };
}

module.exports = { lookupPlayerByGamertag };

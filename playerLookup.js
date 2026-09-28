// Finding a ReforgedZ player by name or in-game ID, from our own player index: the ban
// controller's record of every player the game servers' logs have seen (both boxes, since March
// 2026). It replaced BattleMetrics here on 2026-09-28. The finder shows a signed-in player the
// players their text could mean and they pick themselves (consoleIdentity.js remembers what this
// browser was shown); a pasted in-game ID is checked against the same index.
//
// The index answers with in-game IDs and names only, never an address. Every call is bounded,
// and an index that cannot answer is reported as { unavailable }, never as "no such player".

// Tunables. The tests change them through _test.T; nothing else does.
const T = {
  callTimeoutMs: 8000,   // one call to the index
  cacheTtlMs: 60000,     // a pick follows its search within seconds and must get the same answer
  cacheMax: 500,
  gamertagMax: 32,       // stored console gamertags are 4 to 16 characters
  findMax: 6,            // players the finder offers to pick from
};

const clock = { now: () => Date.now() };

function indexUrl() {
  return String(process.env.PLAYER_INDEX_URL || '').replace(/\/+$/, '');
}

function indexKey() {
  return process.env.PLAYER_INDEX_KEY || '';
}

// Characters no gamertag contains: C0 and C1 controls, zero-width and
// text-direction marks, line and paragraph separators, word joiners, the byte
// order mark, and half of a broken surrogate pair (which would also make
// encodeURIComponent throw). Listed as code points so nothing invisible sits in
// this file.
const BAD_CODE_POINTS = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x2064], [0xfeff, 0xfeff], [0xd800, 0xdfff],
];

// The typed name, trimmed, or null when it cannot be one.
function cleanGamertag(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  let count = 0;
  for (const ch of t) {
    count += 1;
    if (count > T.gamertagMax) return null;
    const cp = ch.codePointAt(0);
    if (BAD_CODE_POINTS.some(([lo, hi]) => cp >= lo && cp <= hi)) return null;
  }
  return t;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// An Identity ID pasted from the game, tidied, or null.
function asReforgerUuid(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.replace(/[{}\s]/g, '').toLowerCase();
  if (!UUID_RE.test(v) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v)) return null;
  return v;
}

// The browser never sees an in-game ID it did not type: a candidate travels as this opaque
// number (13 hex digits of the ID as a decimal, well inside a safe integer), and the ID it
// stands for stays in the session (consoleIdentity.rememberCandidates).
function refFor(uuid) {
  return String(parseInt(String(uuid).replace(/-/g, '').slice(0, 13), 16));
}

// ---- Short result cache and in-flight sharing -------------------------------
// A pick repeats the search it came from; the cache makes it bind the players that search
// showed. Identical searches that arrive together share one call. An outage is never cached.
const findCache = new Map();
const findInflight = new Map();

function cacheGet(key) {
  const entry = findCache.get(key);
  if (!entry) return undefined;
  if (clock.now() - entry.at > T.cacheTtlMs) {
    findCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cachePut(key, value) {
  findCache.delete(key);
  findCache.set(key, { at: clock.now(), value });
  while (findCache.size > T.cacheMax) findCache.delete(findCache.keys().next().value);
}

// ---- HTTP -------------------------------------------------------------------

async function discard(res) {
  try {
    if (res && res.body) await res.body.cancel();
  } catch {
    // nothing left to free
  }
}

// One GET to the player index. Never throws.
//   { ok: true, data }  |  { ok: false, outage, status, reason }
async function indexGet(path) {
  const base = indexUrl();
  const key = indexKey();
  if (!base || !key) return { ok: false, outage: true, status: 0, reason: 'PLAYER_INDEX_URL / PLAYER_INDEX_KEY not set' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), T.callTimeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      await discard(res);
      // 400 is the index refusing the query itself: an answer, not an outage.
      return { ok: false, outage: res.status !== 400, status: res.status, reason: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, data: await res.json() };
  } catch (e) {
    const reason = e && e.name === 'AbortError' ? 'timed out' : String((e && e.message) || e);
    return { ok: false, outage: true, status: 0, reason };
  } finally {
    clearTimeout(timer);
  }
}

// The index's answer for one player, as the finder's candidate.
function toCandidate(p) {
  const uid = asReforgerUuid(p && p.uid);
  if (!uid) return null;
  return {
    bmPlayerId: refFor(uid),   // the opaque ref; the name is historical (consoleIdentity.js keys on it)
    name: String(p.name || ''),
    lastSeen: p.lastSeen || null,
    previousName: p.previousName || null,
    biUid: uid,
    exact: !!p.exact,
  };
}

// Players the typed text could mean, best first, for the player to pick from.
//   { candidates: [{ bmPlayerId, name, lastSeen, previousName, biUid, exact }] }
//   { unavailable: true, reason }
// `wide` skips the recently-played shortcut ("not me, show everyone"). Never throws.
async function findPlayers(query, { wide = false } = {}) {
  const uuid = asReforgerUuid(query);
  const tag = uuid ? null : cleanGamertag(query);
  if (!uuid && !tag) return { candidates: [] };

  const key = `${uuid ? 'uuid' : 'name'}|${wide ? 'wide' : 'narrow'}|${uuid || tag.toLowerCase()}`;
  const copy = (list) => list.map((c) => ({ ...c }));
  const cached = cacheGet(key);
  if (cached !== undefined) return { candidates: copy(cached) };

  let pending = findInflight.get(key);
  if (!pending) {
    pending = (async () => {
      if (uuid) {
        const r = await indexGet(`/api/players/lookup/${encodeURIComponent(uuid)}`);
        if (!r.ok) return r.outage ? { unavailable: true, reason: r.reason } : { candidates: [] };
        const c = r.data && r.data.found ? toCandidate({ ...r.data, exact: true }) : null;
        return { candidates: c ? [c] : [] };
      }
      const r = await indexGet(`/api/players/find?q=${encodeURIComponent(tag)}&limit=${T.findMax}${wide ? '&wide=1' : ''}`);
      if (!r.ok) return r.outage ? { unavailable: true, reason: r.reason } : { candidates: [] };
      const list = (r.data && Array.isArray(r.data.candidates) ? r.data.candidates : []).map(toCandidate).filter(Boolean);
      return { candidates: list.slice(0, T.findMax) };
    })()
      .then((r) => {
        if (!r.unavailable) cachePut(key, r.candidates);
        return r;
      })
      .catch((e) => {
        console.error(`[players] identity finder failed unexpectedly: ${(e && e.message) || e}`);
        return { unavailable: true, reason: 'internal error' };
      })
      .finally(() => findInflight.delete(key));
    findInflight.set(key, pending);
  }
  const r = await pending;
  return r.unavailable ? r : { candidates: copy(r.candidates) };
}

// The in-game ID behind a candidate the finder showed. Candidates from the index always carry
// it; a pick remembered from before 2026-09-28 (a BattleMetrics id) has none to give.
//   { biUid } (null when unknown)
async function reforgerUuidForPlayer() {
  return { biUid: null };
}

// Has this in-game ID played on a ReforgedZ server? Used to check an ID a player pasted before
// the shop starts sending their perks to it.
//   found: true | false | null (null = could not ask; do not block on it)
async function matchReforgerUuid(uuid) {
  const id = asReforgerUuid(uuid);
  if (!id) return { found: false, lastSeen: null };
  const r = await indexGet(`/api/players/lookup/${encodeURIComponent(id)}`);
  if (!r.ok) return { found: null, error: r.reason };
  return r.data && r.data.found
    ? { found: true, lastSeen: r.data.lastSeen || null, name: r.data.name || null }
    : { found: false, lastSeen: null };
}

module.exports = {
  findPlayers,
  reforgerUuidForPlayer,
  matchReforgerUuid,
  cleanGamertag,
  asReforgerUuid,
  _test: {
    T,
    clock,
    refFor,
    toCandidate,
    reset() { findCache.clear(); findInflight.clear(); },
  },
};

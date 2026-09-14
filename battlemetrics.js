const BM_BASE = 'https://api.battlemetrics.com';
const reforgedzServers = require('./reforgedzServers');

// The ReforgedZ organisation on BattleMetrics. Today's public servers sit under
// it, and BattleMetrics keeps the organisation's player history. That history is
// how it still finds console players whose sessions sit on server records from
// before the June 2026 box move: the organisation does not list those old
// records as servers. Measured 2026-09-14, the organisation lists EU1, EU2, NA1,
// NA2 and EU Dev.
const DEFAULT_BM_ORG_ID = '112993';

// Tunables. The tests change them through _test.T; nothing else does.
const T = {
  pageSize: 100,         // BattleMetrics sends no links.next at 100, so this is all it will give
  callTimeoutMs: 10000,  // one HTTP call
  deadlineMs: 25000,     // one whole lookup, retry included; Cloudflare gives up on us at 100 s
  retryMaxWaitMs: 5000,  // the single 429 retry waits at most this long
  cacheTtlMs: 60000,     // /confirm follows /lookup within seconds and must get the same player
  cacheMax: 500,
  budgetPerMin: 120,     // sign-in calls per minute, sustained; the token allows 300/min in total
  budgetBurst: 30,       // and at most this many at once
  gamertagMax: 32,       // stored console gamertags are 4 to 16 characters
};

// Time source for the budget and the cache, replaceable in tests. The lookup
// deadline uses real time because it races real timers.
const clock = { now: () => Date.now() };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function token() {
  return process.env.BATTLEMETRICS_TOKEN || '';
}

let warnedBadOrg = false;

function orgId() {
  const raw = String(process.env.REFORGEDZ_BM_ORG_ID || '').trim();
  if (!raw) return DEFAULT_BM_ORG_ID;
  if (/^\d+$/.test(raw)) return raw;
  // BattleMetrics ignores an empty or non-numeric organisation filter and
  // searches every player it has, so a typo here must never reach it.
  if (!warnedBadOrg) {
    console.error(`[bm] REFORGEDZ_BM_ORG_ID is not a number; using ${DEFAULT_BM_ORG_ID}`);
    warnedBadOrg = true;
  }
  return DEFAULT_BM_ORG_ID;
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

// The typed gamertag, trimmed, or null when it cannot be one. Junk stays away
// from BattleMetrics, where a refused query would otherwise read as an outage.
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

// ---- Shared budget ----------------------------------------------------------
// authLimiter caps each IP, but many IPs together could still spend the token's
// shared BattleMetrics budget and take the homepage player counts down with
// sign-in. A token bucket caps every call sign-in makes, across the process:
// budgetBurst at once, refilled at budgetPerMin, so no window edge doubles it.
const bucket = { tokens: null, at: 0 };

function takeBudget() {
  const now = clock.now();
  if (bucket.tokens === null) {
    bucket.tokens = T.budgetBurst;
    bucket.at = now;
  }
  const refill = (Math.max(0, now - bucket.at) / 60000) * T.budgetPerMin;
  bucket.tokens = Math.min(T.budgetBurst, bucket.tokens + refill);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// ---- Short result cache and in-flight sharing -------------------------------
// /confirm repeats the lookup /lookup just did. Caching the answer for a minute
// saves the calls and makes /confirm bind the player /lookup showed. Identical
// lookups that arrive together share one search. An outage is never cached.
const cache = new Map();
const inflight = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (clock.now() - entry.at > T.cacheTtlMs) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cachePut(key, value) {
  cache.delete(key);
  cache.set(key, { at: clock.now(), value });
  while (cache.size > T.cacheMax) cache.delete(cache.keys().next().value);
}

// ---- HTTP -------------------------------------------------------------------

// BattleMetrics refused the query itself: that is an answer ("no such player"),
// not an outage. Every other failure means it could not answer, and only those
// may tell a player to try again later.
function isRefusal(status) {
  return status === 400 || status === 422;
}

async function discard(res) {
  try {
    if (res && res.body) await res.body.cancel();
  } catch {
    // nothing left to free
  }
}

// One BattleMetrics GET for a sign-in lookup. Never throws. A 429 is retried
// once, and no call runs past the lookup's deadline.
//   { ok: true, data }  |  { ok: false, outage, status, reason }
async function bmGet(path, deadline) {
  const tk = token();
  if (!tk) return { ok: false, outage: true, status: 0, reason: 'BATTLEMETRICS_TOKEN not set' };
  for (let attempt = 0; ; attempt += 1) {
    const left = deadline - Date.now();
    if (left <= 0) return { ok: false, outage: true, status: 0, reason: 'lookup took too long' };
    if (!takeBudget()) return { ok: false, outage: true, status: 0, reason: 'sign-in BattleMetrics budget spent for now' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(T.callTimeoutMs, left));
    try {
      const res = await fetch(`${BM_BASE}${path}`, {
        headers: { Authorization: `Bearer ${tk}` },
        signal: ctrl.signal,
      });
      if (res.status === 429 && attempt === 0) {
        const ra = parseFloat(res.headers.get('retry-after') || '');
        const wait = Math.min(Number.isFinite(ra) && ra >= 0 ? ra * 1000 : 1500, T.retryMaxWaitMs);
        if (Date.now() + wait < deadline) {
          await discard(res);
          clearTimeout(timer);
          await sleep(wait);
          continue;
        }
      }
      if (!res.ok) {
        await discard(res);
        return { ok: false, outage: !isRefusal(res.status), status: res.status, reason: `HTTP ${res.status}` };
      }
      return { ok: true, status: res.status, data: await res.json() };
    } catch (e) {
      const reason = e && e.name === 'AbortError' ? 'timed out' : String((e && e.message) || e);
      return { ok: false, outage: true, status: 0, reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---- Parsing ----------------------------------------------------------------
// The shape BattleMetrics actually sends (measured 2026-09-14): a player row
// carries only relationships.organizations; each included identifier points
// back at its player through relationships.player. Search results include
// identifier types name and reforgerUUID only.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Players in a search result whose CURRENT name is the gamertag,
// case-insensitively. Past names are deliberately not matched: the live lookup
// never matched them (it read a link BattleMetrics does not send), every
// measurement of who can sign in was taken without them, and turning them on
// changes who resolves and who becomes ambiguous, so it needs its own
// 110-account regression run first.
function matchingPlayers(data, wanted) {
  const w = wanted.toLowerCase();
  const rows = (data && Array.isArray(data.data)) ? data.data : [];
  return rows.filter((p) => p && p.type === 'player'
    && String((p.attributes && p.attributes.name) || '').toLowerCase() === w);
}

// player id -> Set of in-game ids, from the identifiers in a response.
function reforgerUuidsByPlayer(data) {
  const byPlayer = new Map();
  for (const inc of (data && data.included) || []) {
    if (!inc || inc.type !== 'identifier' || !inc.attributes) continue;
    if (String(inc.attributes.type).toLowerCase() !== 'reforgeruuid') continue;
    const v = String(inc.attributes.identifier || '').toLowerCase();
    const link = inc.relationships && inc.relationships.player && inc.relationships.player.data;
    if (!link || link.id == null || !UUID_RE.test(v)) continue;
    const pid = String(link.id);
    if (!byPlayer.has(pid)) byPlayer.set(pid, new Set());
    byPlayer.get(pid).add(v);
  }
  return byPlayer;
}

// ---- Lookup -----------------------------------------------------------------

// Resolve a console gamertag to a BattleMetrics player and their Reforger id.
//
//   { bmPlayerId, biUid, displayName, platform, scope }   exactly one player found
//   null                                                  no such player, the name is ambiguous, or not a gamertag
//   { unavailable: true, reason }                         BattleMetrics could not be asked, or did not finish answering
//
// ⛔ Callers MUST check `unavailable` before treating the result as a match: it is
// a truthy object. This function never throws.
//
// Scoping. The search is first limited to the servers we run today, and only if
// that finds nobody is it widened to the whole ReforgedZ organisation. It used to
// stop at today's servers, which locked out every console player whose history
// sits on an older server record. Measured 2026-09-13 across all 110 console
// accounts: sign-in went from 84 to 103 with no regressions. The widening only
// runs on zero matches on today's servers.
//
// It never searches the whole of BattleMetrics. An unscoped search can match a
// stranger who shares a gamertag and create a ReforgedZ account for them.
async function lookupPlayerByGamertag(gamertag, platform) {
  const tag = cleanGamertag(gamertag);
  if (!tag) return null;
  if (!token()) {
    console.error('[bm] BATTLEMETRICS_TOKEN not set');
    return { unavailable: true, reason: 'BATTLEMETRICS_TOKEN not set' };
  }

  const serverIds = reforgedzServers.getBmIds();
  const key = `${tag.toLowerCase()}|${serverIds.join(',')}`;
  const withPlatform = (r) => (r && !r.unavailable ? { ...r, platform } : r);

  const cached = cacheGet(key);
  if (cached !== undefined) return withPlatform(cached);

  let pending = inflight.get(key);
  if (!pending) {
    pending = resolveGamertag(tag, serverIds, key)
      .catch((e) => {
        console.error(`[bm] gamertag lookup failed unexpectedly: ${(e && e.message) || e}`);
        return { unavailable: true, reason: 'internal error' };
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return withPlatform(await pending);
}

async function resolveGamertag(tag, serverIds, key) {
  const deadline = Date.now() + T.deadlineMs;
  const scopes = [];
  if (serverIds.length) scopes.push({ name: 'servers', filter: `filter[servers]=${serverIds.join(',')}` });
  scopes.push({ name: 'organization', filter: `filter[organizations]=${orgId()}` });

  let matches = [];
  let scopeUsed = null;
  let searchData = null;
  for (const scope of scopes) {
    const r = await bmGet(
      `/players?filter[search]=${encodeURIComponent(tag)}&${scope.filter}&include=identifier&page[size]=${T.pageSize}`,
      deadline,
    );
    if (!r.ok) {
      if (r.outage) {
        console.error(`[bm] gamertag search (${scope.name}) failed: ${r.reason}`);
        return { unavailable: true, reason: r.reason };
      }
      console.warn(`[bm] gamertag search (${scope.name}) refused: ${r.reason}`);
      cachePut(key, null);
      return null;
    }
    matches = matchingPlayers(r.data, tag);
    scopeUsed = scope.name;
    searchData = r.data;
    const rows = (r.data && Array.isArray(r.data.data)) ? r.data.data.length : 0;
    if (!matches.length && rows >= T.pageSize) {
      // The one case where a whole page can hide the player: nobody matched on
      // a full page. Common on the organisation scope for short names.
      console.warn(`[bm] gamertag search (${scope.name}) found no exact match on a full page of ${T.pageSize}`);
    }
    // Stop at the first scope that finds anyone. More than one match is
    // ambiguous, and widening the scope could only add candidates.
    if (matches.length) break;
  }

  if (matches.length === 0) {
    cachePut(key, null);
    return null;
  }
  if (matches.length > 1) {
    console.warn(`[bm] ambiguous gamertag "${tag}": ${matches.length} players under the ${scopeUsed} scope, refusing to guess`);
    cachePut(key, null);
    return null;
  }
  if (scopeUsed === 'organization') {
    console.log(`[bm] "${tag}" found under the organisation scope, not on today's servers`);
  }

  const player = matches[0];
  const bmPlayerId = String(player.id);
  const displayName = (player.attributes && player.attributes.name) || tag;

  // The in-game id. The search links exactly one to the player in every case
  // measured; otherwise the player is fetched on their own.
  let biUid = null;
  const fromSearch = reforgerUuidsByPlayer(searchData).get(bmPlayerId);
  if (fromSearch && fromSearch.size === 1) {
    biUid = Array.from(fromSearch)[0];
  } else {
    const detail = await bmGet(`/players/${bmPlayerId}?include=identifier`, deadline);
    if (!detail.ok) {
      // Without the in-game id the account could not receive anything it buys,
      // so this is "try again", not a match.
      console.error(`[bm] player detail for ${bmPlayerId} failed: ${detail.reason}`);
      return { unavailable: true, reason: detail.reason };
    }
    const linked = reforgerUuidsByPlayer(detail.data).get(bmPlayerId);
    if (linked && linked.size) {
      biUid = Array.from(linked)[0];
    } else {
      for (const inc of (detail.data && detail.data.included) || []) {
        if (!inc || inc.type !== 'identifier' || !inc.attributes) continue;
        if (String(inc.attributes.type).toLowerCase() !== 'reforgeruuid') continue;
        const v = String(inc.attributes.identifier || '').toLowerCase();
        if (UUID_RE.test(v)) { biUid = v; break; }
      }
    }
  }

  const result = { bmPlayerId, biUid, displayName, scope: scopeUsed };
  cachePut(key, result);
  return result;
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

module.exports = {
  lookupPlayerByGamertag,
  matchReforgerUuid,
  cleanGamertag,
  orgId,
  _test: {
    T,
    clock,
    reset() {
      cache.clear();
      inflight.clear();
      bucket.tokens = null;
      bucket.at = 0;
      warnedBadOrg = false;
    },
  },
};

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
  findMax: 6,            // players the finder offers to pick from
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
// The finder keeps its own maps: a gamertag may contain "|", so sharing keys
// with the lookup could let one answer stand in for the other.
const findCache = new Map();
const findInflight = new Map();

function cacheGet(key, store = cache) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (clock.now() - entry.at > T.cacheTtlMs) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

function cachePut(key, value, store = cache) {
  store.delete(key);
  store.set(key, { at: clock.now(), value });
  while (store.size > T.cacheMax) store.delete(store.keys().next().value);
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
async function bmGet(path, deadline, init = {}) {
  const tk = token();
  if (!tk) return { ok: false, outage: true, status: 0, reason: 'BATTLEMETRICS_TOKEN not set' };
  for (let attempt = 0; ; attempt += 1) {
    const left = deadline - Date.now();
    if (left <= 0) return { ok: false, outage: true, status: 0, reason: 'lookup took too long' };
    if (!takeBudget()) return { ok: false, outage: true, status: 0, reason: 'sign-in BattleMetrics budget spent for now' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(T.callTimeoutMs, left));
    try {
      const headers = { Authorization: `Bearer ${tk}` };
      if (init.body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(`${BM_BASE}${path}`, {
        method: init.method || 'GET',
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
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

// ---- Identity finder --------------------------------------------------------
// Sign-in and the in-game id box used to demand the player's current name
// exactly as BattleMetrics has it. A typo, a renamed player, a name two players
// share, or an Xbox "#1234" suffix all ended in "No ReforgedZ player found" with
// no way forward. The finder returns the players the text could mean and the
// player picks themselves. Picking from a list is no weaker than typing the
// exact name, which was always enough to choose a player; accounts that have
// purchases stay behind the ownership check in server.js either way.

// An Identity ID pasted from the game, tidied, or null.
function asReforgerUuid(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.replace(/[{}\s]/g, '').toLowerCase();
  if (!UUID_RE.test(v) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v)) return null;
  return v;
}

// A name with case, spacing and punctuation ignored and an Xbox "#1234" suffix dropped.
function looseName(s) {
  return String(s || '').normalize('NFKC').replace(/#\d{3,5}\s*$/, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function editDistance(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

// How close a name is to what was typed: 0 the same name, 1 the same once case,
// spacing, punctuation and a suffix are ignored, 2 one contains the other, 3 or
// 4 a typo or two. null means not close enough to offer.
function closeness(name, typed) {
  if (String(name).toLowerCase() === String(typed).toLowerCase()) return 0;
  const a = looseName(name);
  const b = looseName(typed);
  if (!a || !b) return null;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a))) return 2;
  if (b.length >= 4) {
    const d = editDistance(a, b, 2);
    if (d <= 2) return 2 + d;
  }
  return null;
}

// Per player in a response: current name, past names, the in-game ids linked to
// them, and when BattleMetrics last saw any of their identifiers.
function playerFacts(data) {
  const facts = new Map();
  const rows = data && Array.isArray(data.data) ? data.data : (data && data.data ? [data.data] : []);
  for (const p of rows) {
    if (!p || p.type !== 'player' || p.id == null) continue;
    facts.set(String(p.id), {
      bmPlayerId: String(p.id),
      name: String((p.attributes && p.attributes.name) || ''),
      pastNames: [],
      lastSeen: null,
      uuids: new Set(),
    });
  }
  for (const inc of (data && data.included) || []) {
    if (!inc || inc.type !== 'identifier' || !inc.attributes) continue;
    const link = inc.relationships && inc.relationships.player && inc.relationships.player.data;
    const f = link && link.id != null ? facts.get(String(link.id)) : null;
    if (!f) continue;
    const seen = inc.attributes.lastSeen;
    if (typeof seen === 'string' && (!f.lastSeen || seen > f.lastSeen)) f.lastSeen = seen;
    const type = String(inc.attributes.type).toLowerCase();
    const value = String(inc.attributes.identifier || '');
    if (type === 'name') {
      if (value && value.toLowerCase() !== f.name.toLowerCase() && !f.pastNames.includes(value)) f.pastNames.push(value);
    } else if (type === 'reforgeruuid' && UUID_RE.test(value.toLowerCase())) {
      f.uuids.add(value.toLowerCase());
    }
  }
  return facts;
}

function toCandidate(f, score, via) {
  return {
    bmPlayerId: f.bmPlayerId,
    name: f.name,
    lastSeen: f.lastSeen || null,
    previousName: via || null,
    biUid: f.uuids.size === 1 ? Array.from(f.uuids)[0] : null,
    exact: score === 0 && !via,
  };
}

// Players the typed text could mean, best first, for the player to pick from.
//   { candidates: [{ bmPlayerId, name, lastSeen, previousName, biUid, exact }] }
//   { unavailable: true, reason }
// `wide` skips the today's-servers shortcut ("not me, show everyone").
// Never throws.
async function findPlayers(query, { wide = false } = {}) {
  const uuid = asReforgerUuid(query);
  const tag = uuid ? null : cleanGamertag(query);
  if (!uuid && !tag) return { candidates: [] };
  if (!token()) return { unavailable: true, reason: 'BATTLEMETRICS_TOKEN not set' };

  const serverIds = reforgedzServers.getBmIds();
  const key = `${uuid ? 'uuid' : 'name'}|${wide ? 'wide' : 'narrow'}|${serverIds.join(',')}|${uuid || tag.toLowerCase()}`;
  const copy = (list) => list.map((c) => ({ ...c }));
  const cached = cacheGet(key, findCache);
  if (cached !== undefined) return { candidates: copy(cached) };

  let pending = findInflight.get(key);
  if (!pending) {
    pending = (uuid ? findByUuid(uuid) : findByName(tag, serverIds, wide))
      .then((r) => {
        if (!r.unavailable) cachePut(key, r.candidates, findCache);
        return r;
      })
      .catch((e) => {
        console.error(`[bm] identity finder failed unexpectedly: ${(e && e.message) || e}`);
        return { unavailable: true, reason: 'internal error' };
      })
      .finally(() => findInflight.delete(key));
    findInflight.set(key, pending);
  }
  const r = await pending;
  return r.unavailable ? r : { candidates: copy(r.candidates) };
}

async function findByUuid(uuid) {
  const deadline = Date.now() + T.deadlineMs;
  const m = await bmGet('/players/match', deadline, {
    method: 'POST',
    body: { data: [{ type: 'identifier', attributes: { type: 'reforgerUUID', identifier: uuid } }] },
  });
  if (!m.ok) return m.outage ? { unavailable: true, reason: m.reason } : { candidates: [] };
  const hit = ((m.data && m.data.data) || [])[0];
  const rel = hit && hit.relationships;
  const pid = rel && rel.player && rel.player.data && rel.player.data.id;
  if (pid == null) return { candidates: [] };
  const orgs = ((rel.organizations && rel.organizations.data) || []).map((o) => String(o.id));
  // Seen by BattleMetrics, but never on a ReforgedZ server.
  if (!orgs.includes(orgId())) return { candidates: [] };
  const d = await bmGet(`/players/${encodeURIComponent(String(pid))}?include=identifier`, deadline);
  if (!d.ok) return d.outage ? { unavailable: true, reason: d.reason } : { candidates: [] };
  const f = playerFacts(d.data).get(String(pid));
  if (!f) return { candidates: [] };
  const c = toCandidate(f, 0, null);
  c.biUid = uuid;
  c.lastSeen = c.lastSeen || (hit.attributes && hit.attributes.lastSeen) || null;
  return { candidates: [c] };
}

async function findByName(tag, serverIds, wide) {
  const deadline = Date.now() + T.deadlineMs;
  const facts = new Map();
  const search = (filter) => bmGet(
    `/players?filter[search]=${encodeURIComponent(tag)}&${filter}&include=identifier&page[size]=${T.pageSize}`,
    deadline,
  );
  const absorb = (data) => {
    for (const [id, f] of playerFacts(data)) if (!facts.has(id)) facts.set(id, f);
  };

  // Today's servers first, as the lookup always did: exactly one player with
  // that current name there is the answer.
  if (serverIds.length && !wide) {
    const r = await search(`filter[servers]=${serverIds.join(',')}`);
    if (!r.ok) return r.outage ? { unavailable: true, reason: r.reason } : { candidates: [] };
    absorb(r.data);
    const exact = Array.from(facts.values()).filter((f) => f.name.toLowerCase() === tag.toLowerCase());
    if (exact.length === 1) return { candidates: [toCandidate(exact[0], 0, null)] };
  }

  const r = await search(`filter[organizations]=${orgId()}`);
  if (!r.ok) return r.outage ? { unavailable: true, reason: r.reason } : { candidates: [] };
  absorb(r.data);

  const scored = [];
  for (const f of facts.values()) {
    let best = closeness(f.name, tag);
    let via = null;
    for (const past of f.pastNames) {
      const c = closeness(past, tag);
      if (c !== null && (best === null || c < best)) { best = c; via = past; }
    }
    if (best !== null) scored.push({ f, best, via });
  }
  scored.sort((a, b) => (a.best - b.best) || String(b.f.lastSeen || '').localeCompare(String(a.f.lastSeen || '')));
  return { candidates: scored.slice(0, T.findMax).map(({ f, best, via }) => toCandidate(f, best, via)) };
}

// The in-game id of a player the finder showed, when the search did not carry
// exactly one.  { biUid } (null when BattleMetrics has none)  |  { unavailable, reason }
async function reforgerUuidForPlayer(bmPlayerId) {
  const id = String(bmPlayerId == null ? '' : bmPlayerId);
  if (!/^\d{1,20}$/.test(id)) return { biUid: null };
  if (!token()) return { unavailable: true, reason: 'BATTLEMETRICS_TOKEN not set' };
  try {
    const d = await bmGet(`/players/${id}?include=identifier`, Date.now() + T.deadlineMs);
    if (!d.ok) return { unavailable: true, reason: d.reason };
    const f = playerFacts(d.data).get(id);
    if (f && f.uuids.size) return { biUid: Array.from(f.uuids)[0] };
    for (const inc of (d.data && d.data.included) || []) {
      if (!inc || inc.type !== 'identifier' || !inc.attributes) continue;
      if (String(inc.attributes.type).toLowerCase() !== 'reforgeruuid') continue;
      const v = String(inc.attributes.identifier || '').toLowerCase();
      if (UUID_RE.test(v)) return { biUid: v };
    }
    return { biUid: null };
  } catch (e) {
    return { unavailable: true, reason: String((e && e.message) || e) };
  }
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
  findPlayers,
  reforgerUuidForPlayer,
  asReforgerUuid,
  _test: {
    T,
    clock,
    looseName,
    closeness,
    reset() {
      cache.clear();
      inflight.clear();
      findCache.clear();
      findInflight.clear();
      bucket.tokens = null;
      bucket.at = 0;
      warnedBadOrg = false;
    },
  },
};

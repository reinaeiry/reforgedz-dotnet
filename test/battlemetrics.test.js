// Unit tests for the console gamertag lookup (battlemetrics.js) and the sign-in
// server scope (reforgedzServers.js). No network: fetch is replaced.
//
// Fixtures follow the response shape BattleMetrics actually sends (measured
// 2026-09-14): a player row carries only relationships.organizations, and each
// included identifier points back at its player through relationships.player.
// Special characters are built from code points so nothing invisible sits here.
//
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BATTLEMETRICS_TOKEN = 'test-token';
delete process.env.REFORGEDZ_BM_SERVER_IDS;
delete process.env.REFORGEDZ_BM_ORG_ID;

const servers = require('../reforgedzServers');
const bm = require('../battlemetrics');

const DEFAULTS = { ...bm._test.T };
const calls = [];
let handler = async () => { throw new Error('no handler set'); };
let fakeNow = null;

global.fetch = async (url, opts) => {
  calls.push(String(url));
  return handler(String(url), opts || {});
};
bm._test.clock.now = () => (fakeNow === null ? Date.now() : fakeNow);

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.error = () => {};
console.warn = () => {};
console.log = () => {};
test.after(() => Object.assign(console, quiet));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cp = (...points) => String.fromCodePoint(...points);

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

let nextIdent = 1;
function ident(playerId, type, value) {
  return {
    type: 'identifier',
    id: String(nextIdent++),
    attributes: { type, identifier: value },
    relationships: { player: { data: { type: 'player', id: String(playerId) } }, organizations: { data: [] } },
  };
}

function player(id, name, { uuids = [], pastNames = [], other = [] } = {}) {
  const idents = [ident(id, 'name', name)];
  for (const n of pastNames) idents.push(ident(id, 'name', n));
  for (const u of uuids) idents.push(ident(id, 'reforgerUUID', u));
  for (const [type, value] of other) idents.push(ident(id, type, value));
  return {
    row: {
      type: 'player',
      id: String(id),
      attributes: { name },
      relationships: { organizations: { data: [{ type: 'organization', id: '112993' }] } },
    },
    idents,
  };
}

const page = (...players) => ({ data: players.map((p) => p.row), included: players.flatMap((p) => p.idents), links: {} });
const detail = (p) => ({ data: p.row, included: p.idents });

const U1 = '11111111-2222-3333-4444-555555555555';
const U2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const isSearch = (u) => u.includes('/players?filter[search]=');
const isServers = (u) => isSearch(u) && u.includes('filter[servers]=');
const isOrg = (u) => isSearch(u) && u.includes('filter[organizations]=');
const detailId = (u) => { const m = u.match(/\/players\/(\d+)\?include=identifier/); return m ? m[1] : null; };
const searches = () => calls.filter(isSearch).length;

function reset() {
  calls.length = 0;
  fakeNow = null;
  bm._test.reset();
  servers._test.reset();
  Object.assign(bm._test.T, DEFAULTS);
  delete process.env.REFORGEDZ_BM_SERVER_IDS;
  delete process.env.REFORGEDZ_BM_ORG_ID;
  process.env.BATTLEMETRICS_TOKEN = 'test-token';
}

// ---- Scope ------------------------------------------------------------------

test('finds a player on today\'s servers in one call, in-game id from the search', async () => {
  reset();
  servers.setBmId('eu1', '101');
  handler = async (u) => (isServers(u) ? json(200, page(player(1, 'Alpha', { uuids: [U1] }))) : json(200, page()));
  const r = await bm.lookupPlayerByGamertag('alpha', 'xbox');
  assert.equal(r.bmPlayerId, '1');
  assert.equal(r.biUid, U1);
  assert.equal(r.scope, 'servers');
  assert.equal(r.platform, 'xbox');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('filter[servers]=101'));
  assert.ok(calls[0].includes('page[size]=100'));
});

test('widens to the organisation only when today\'s servers find nobody', async () => {
  reset();
  servers.setBmId('eu1', '101');
  handler = async (u) => {
    if (isServers(u)) return json(200, page(player(9, 'Someone Else', { uuids: [U1] })));
    if (isOrg(u)) return json(200, page(player(2, 'Beta', { uuids: [U2] })));
    return json(503, {});
  };
  const r = await bm.lookupPlayerByGamertag('Beta', 'psn');
  assert.equal(r.bmPlayerId, '2');
  assert.equal(r.biUid, U2);
  assert.equal(r.scope, 'organization');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('filter[organizations]=112993'));
});

test('never searches unscoped, even with no verified server records', async () => {
  reset();
  handler = async () => json(200, page());
  assert.equal(await bm.lookupPlayerByGamertag('Nobody', 'xbox'), null);
  assert.equal(calls.length, 1);
  for (const u of calls) assert.ok(isServers(u) || isOrg(u), `unscoped call: ${u}`);
});

test('a bad REFORGEDZ_BM_ORG_ID falls back to the default, never an empty filter', async () => {
  for (const bad of [' ', 'abc', '112993abc', '-1']) {
    reset();
    process.env.REFORGEDZ_BM_ORG_ID = bad;
    handler = async () => json(200, page());
    await bm.lookupPlayerByGamertag('Nobody', 'xbox');
    assert.equal(calls.length, 1, `value ${JSON.stringify(bad)}`);
    assert.ok(calls[0].includes('filter[organizations]=112993&'), `value ${JSON.stringify(bad)} sent ${calls[0]}`);
  }
  reset();
  process.env.REFORGEDZ_BM_ORG_ID = '555';
  assert.equal(bm.orgId(), '555');
});

test('REFORGEDZ_BM_SERVER_IDS: numbers only, and only until the panel verifies a record', () => {
  reset();
  process.env.REFORGEDZ_BM_SERVER_IDS = '102, abc,101,102';
  assert.deepEqual(servers.getBmIds(), ['101', '102']);
  servers.setBmId('eu1', '7');
  assert.deepEqual(servers.getBmIds(), ['7']);
  servers.forgetBmId('eu1');
  process.env.REFORGEDZ_BM_SERVER_IDS = 'abc';
  assert.deepEqual(servers.getBmIds(), []);
});

test('the sign-in server scope is replaced, not only added to, and reads in a stable order', () => {
  reset();
  servers.setBmId('eu1', '39356767');
  servers.setBmId('eu2', '9');
  assert.deepEqual(servers.getBmIds(), ['9', '39356767']);
  servers.forgetBmId('eu1');
  assert.deepEqual(servers.getBmIds(), ['9']);
  servers.setBmId('eu1', '39356767');
  assert.deepEqual(servers.getBmIds(), ['9', '39356767']);
  servers.setBmId('eu2', '3');
  assert.deepEqual(servers.getBmIds(), ['3', '39356767']);
  servers.retainServers(['na1']);
  assert.deepEqual(servers.getBmIds(), []);
});

// ---- Matching ---------------------------------------------------------------

test('matches the current name only, as the live lookup always has', async () => {
  reset();
  handler = async () => json(200, page(
    player(5, 'Current Name', { pastNames: ['OldTag'], uuids: [U1] }),
    player(6, 'Someone', { other: [['ip', '1.2.3.4'], ['steamID', '76561190000000000']], uuids: [U2] }),
  ));
  assert.equal((await bm.lookupPlayerByGamertag('CURRENT name', 'xbox')).bmPlayerId, '5');
  assert.equal(await bm.lookupPlayerByGamertag('OldTag', 'xbox'), null);
  assert.equal(await bm.lookupPlayerByGamertag('1.2.3.4', 'xbox'), null);
  assert.equal(await bm.lookupPlayerByGamertag('76561190000000000', 'xbox'), null);
});

test('two players with the name are refused, not guessed', async () => {
  reset();
  handler = async () => json(200, page(player(1, 'Dup', { uuids: [U1] }), player(2, 'dup', { uuids: [U2] })));
  assert.equal(await bm.lookupPlayerByGamertag('DUP', 'psn'), null);
});

// ---- In-game id -------------------------------------------------------------

test('never takes another row\'s in-game id: a match without one fetches the player', async () => {
  reset();
  handler = async (u) => {
    if (isSearch(u)) return json(200, page(player(1, 'Alpha'), player(2, 'Bravo', { uuids: [U1] })));
    if (detailId(u) === '1') return json(200, detail(player(1, 'Alpha', { uuids: [U2] })));
    return json(503, {});
  };
  const r = await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  assert.equal(r.biUid, U2);
  assert.equal(calls.length, 2);
});

test('a player linked to two in-game ids is fetched on their own', async () => {
  reset();
  handler = async (u) => {
    if (isSearch(u)) return json(200, page(player(1, 'Alpha', { uuids: [U1, U2] })));
    if (detailId(u) === '1') return json(200, detail(player(1, 'Alpha', { uuids: [U2] })));
    return json(503, {});
  };
  const r = await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  assert.equal(r.biUid, U2);
  assert.equal(calls.length, 2);
});

test('a failed player fetch is "try again", never a match without an in-game id, and is not cached', async () => {
  reset();
  let up = false;
  handler = async (u) => {
    if (isSearch(u)) return json(200, page(player(1, 'Alpha')));
    if (detailId(u) === '1') return up ? json(200, detail(player(1, 'Alpha', { uuids: [U1] }))) : json(503, {});
    return json(503, {});
  };
  const first = await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  assert.equal(first && first.unavailable, true);
  up = true;
  const second = await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  assert.equal(second.biUid, U1);
  assert.equal(searches(), 2);
});

test('a player BattleMetrics has no in-game id for yet still resolves, with none', async () => {
  reset();
  handler = async (u) => (isSearch(u) ? json(200, page(player(1, 'Alpha'))) : json(200, detail(player(1, 'Alpha'))));
  const r = await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  assert.equal(r.bmPlayerId, '1');
  assert.equal(r.biUid, null);
});

// ---- Failures ---------------------------------------------------------------

test('an outage is unavailable, never "no such player"', async () => {
  for (const [label, make] of [
    ['500', async () => json(500, {})],
    ['401', async () => json(401, {})],
    ['403', async () => json(403, {})],
    ['404', async () => json(404, {})],
    ['408', async () => json(408, {})],
    ['410', async () => json(410, {})],
    ['network', async () => { throw new TypeError('fetch failed'); }],
    ['bad json', async () => new Response('not json', { status: 200 })],
  ]) {
    reset();
    handler = make;
    const r = await bm.lookupPlayerByGamertag('Alpha', 'xbox');
    assert.equal(r && r.unavailable, true, label);
  }
  reset();
  process.env.BATTLEMETRICS_TOKEN = '';
  const r = await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  assert.equal(r && r.unavailable, true);
  assert.equal(calls.length, 0);
});

test('a query BattleMetrics refuses (400, 422) is "not found", not an outage', async () => {
  for (const status of [400, 422]) {
    reset();
    handler = async () => json(status, { errors: [] });
    assert.equal(await bm.lookupPlayerByGamertag('Alpha', 'xbox'), null, String(status));
  }
});

test('a 429 is retried once, then reported as unavailable', async () => {
  reset();
  bm._test.T.retryMaxWaitMs = 5;
  handler = async () => json(429, {}, { 'retry-after': '0' });
  const r = await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  assert.equal(r && r.unavailable, true);
  assert.equal(calls.length, 2);
});

test('a 429 followed by an answer succeeds', async () => {
  reset();
  bm._test.T.retryMaxWaitMs = 5;
  let n = 0;
  handler = async () => (n++ === 0 ? json(429, {}) : json(200, page(player(1, 'Alpha', { uuids: [U1] }))));
  const r = await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  assert.equal(r.bmPlayerId, '1');
  assert.equal(calls.length, 2);
});

test('the lookup deadline bounds a BattleMetrics that never answers', async () => {
  reset();
  bm._test.T.deadlineMs = 150;
  handler = (u, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const started = Date.now();
  const r = await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  assert.equal(r && r.unavailable, true);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('a 429 retry never waits past the deadline', async () => {
  reset();
  bm._test.T.deadlineMs = 200;
  bm._test.T.retryMaxWaitMs = 5000;
  handler = async () => json(429, {}, { 'retry-after': '5' });
  const started = Date.now();
  const r = await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  assert.equal(r && r.unavailable, true);
  assert.equal(calls.length, 1);
  assert.ok(Date.now() - started < 1000);
});

// ---- Cache and sharing ------------------------------------------------------

test('/confirm right after /lookup costs nothing, gets the same player, and its own platform', async () => {
  reset();
  handler = async () => json(200, page(player(1, 'Alpha', { uuids: [U1] })));
  const a = await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  a.bmPlayerId = 'tampered';
  const b = await bm.lookupPlayerByGamertag(' alpha ', 'psn');
  assert.equal(b.bmPlayerId, '1');
  assert.equal(b.platform, 'psn');
  assert.equal(calls.length, 1);
});

test('the cache expires', async () => {
  reset();
  fakeNow = 1000000;
  handler = async () => json(200, page(player(1, 'Alpha', { uuids: [U1] })));
  await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  fakeNow += DEFAULTS.cacheTtlMs - 1;
  await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  assert.equal(calls.length, 1);
  fakeNow += 2;
  await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  assert.equal(calls.length, 2);
});

test('the cache holds at most cacheMax entries', async () => {
  reset();
  bm._test.T.cacheMax = 2;
  handler = async () => json(200, page());
  for (const t of ['a1', 'a2', 'a3']) await bm.lookupPlayerByGamertag(t, 'xbox');
  assert.equal(calls.length, 3);
  await bm.lookupPlayerByGamertag('a1', 'xbox');
  assert.equal(calls.length, 4);
});

test('a change in the server scope is a cache miss', async () => {
  reset();
  servers.setBmId('eu1', '101');
  handler = async () => json(200, page(player(1, 'Alpha', { uuids: [U1] })));
  await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  servers.forgetBmId('eu1');
  await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  assert.equal(calls.length, 2);
  assert.ok(isOrg(calls[1]));
});

test('identical lookups arriving together share one search', async () => {
  reset();
  handler = async () => { await sleep(20); return json(200, page(player(1, 'Alpha', { uuids: [U1] }))); };
  const [a, b] = await Promise.all([
    bm.lookupPlayerByGamertag('Alpha', 'xbox'),
    bm.lookupPlayerByGamertag('alpha', 'psn'),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(a.platform, 'xbox');
  assert.equal(b.platform, 'psn');
});

// ---- Budget -----------------------------------------------------------------

test('the budget stops calls before BattleMetrics does, refills, and never exceeds its burst', async () => {
  reset();
  fakeNow = 5000000;
  bm._test.T.budgetBurst = 3;
  bm._test.T.budgetPerMin = 60;
  handler = async () => json(200, page());
  for (const t of ['a1', 'a2', 'a3']) assert.equal(await bm.lookupPlayerByGamertag(t, 'xbox'), null);
  assert.equal((await bm.lookupPlayerByGamertag('a4', 'xbox')).unavailable, true);
  assert.equal(calls.length, 3);
  fakeNow += 2000;
  assert.equal(await bm.lookupPlayerByGamertag('b1', 'xbox'), null);
  assert.equal(await bm.lookupPlayerByGamertag('b2', 'xbox'), null);
  assert.equal((await bm.lookupPlayerByGamertag('b3', 'xbox')).unavailable, true);
  assert.equal(calls.length, 5);
  fakeNow += 10 * 60000;
  let passed = 0;
  for (let i = 0; i < 10; i++) {
    const r = await bm.lookupPlayerByGamertag(`c${i}`, 'xbox');
    if (r === null) passed++;
  }
  assert.equal(passed, 3);
});

// ---- Input ------------------------------------------------------------------

test('cleanGamertag accepts real gamertags and rejects what no gamertag contains', () => {
  reset();
  for (const good of ['Alpha Bravo', 'Jammad-', 'Depraved Ether Addict', 'Kaito#1234', 'Ñandú_Gamer-01',
    cp(0xac13, 0xac9c, 0xb7ec), cp(0x1f600).repeat(20), 'x'.repeat(32)]) {
    assert.equal(bm.cleanGamertag(`  ${good} `), good, JSON.stringify(good));
  }
  for (const bad of ['', '   ', 'x'.repeat(33), cp(0x1f600).repeat(33),
    `a${cp(0x1)}b`, `a${cp(0x7f)}b`, `a${cp(0x85)}b`, `a${cp(0x200b)}b`, `a${cp(0x202e)}b`,
    `a${cp(0x2028)}b`, `ab${cp(0xfeff)}c`, cp(0xd800), `Al${cp(0xdfff)}pha`]) {
    assert.equal(bm.cleanGamertag(bad), null, JSON.stringify(bad));
  }
  assert.equal(bm.cleanGamertag(42), null);
  assert.equal(bm.cleanGamertag(null), null);
});

test('junk never reaches BattleMetrics and never throws', async () => {
  reset();
  handler = async () => json(200, page());
  assert.equal(await bm.lookupPlayerByGamertag('x'.repeat(5000), 'xbox'), null);
  assert.equal(await bm.lookupPlayerByGamertag(cp(0xd800), 'xbox'), null);
  assert.equal(await bm.lookupPlayerByGamertag(`Al${cp(0xdfff)}pha`, 'xbox'), null);
  assert.equal(calls.length, 0);
});

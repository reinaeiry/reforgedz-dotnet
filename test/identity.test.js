// Unit tests for the identity finder (battlemetrics.js findPlayers,
// reforgerUuidForPlayer) and the console sign-in helpers (consoleIdentity.js).
// No network: fetch is replaced. Fixtures follow the response shape
// BattleMetrics actually sends (measured 2026-09-14).
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BATTLEMETRICS_TOKEN = 'test-token';
delete process.env.REFORGEDZ_BM_SERVER_IDS;
delete process.env.REFORGEDZ_BM_ORG_ID;

const servers = require('../reforgedzServers');
const bm = require('../battlemetrics');
const ci = require('../consoleIdentity');

const DEFAULTS = { ...bm._test.T };
const calls = [];
let handler = async () => { throw new Error('no handler set'); };

global.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts: opts || {} });
  return handler(String(url), opts || {});
};

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.error = () => {};
console.warn = () => {};
console.log = () => {};
test.after(() => Object.assign(console, quiet));

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let nextIdent = 1;
function ident(playerId, type, value, lastSeen) {
  return {
    type: 'identifier',
    id: String(nextIdent++),
    attributes: { type, identifier: value, lastSeen: lastSeen || '2026-09-01T00:00:00.000Z', private: false, metadata: null },
    relationships: { player: { data: { type: 'player', id: String(playerId) } } },
  };
}

function player(id, name, { uuids = [], pastNames = [], lastSeen } = {}) {
  const idents = [ident(id, 'name', name, lastSeen)];
  for (const n of pastNames) idents.push(ident(id, 'name', n, '2026-01-01T00:00:00.000Z'));
  for (const u of uuids) idents.push(ident(id, 'reforgerUUID', u, lastSeen));
  return {
    row: { type: 'player', id: String(id), attributes: { name }, relationships: { organizations: { data: [{ type: 'organization', id: '112993' }] } } },
    idents,
  };
}

const page = (...players) => ({ data: players.map((p) => p.row), included: players.flatMap((p) => p.idents), links: {} });
const detail = (p) => ({ data: p.row, included: p.idents });
const isServers = (u) => u.includes('/players?filter[search]=') && u.includes('filter[servers]=');
const isOrg = (u) => u.includes('/players?filter[search]=') && u.includes('filter[organizations]=');

const U1 = '11111111-2222-3333-4444-555555555555';
const U2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function reset() {
  calls.length = 0;
  bm._test.reset();
  servers._test.reset();
  Object.assign(bm._test.T, DEFAULTS);
  delete process.env.REFORGEDZ_BM_SERVER_IDS;
  delete process.env.REFORGEDZ_BM_ORG_ID;
  process.env.BATTLEMETRICS_TOKEN = 'test-token';
}

// ---- By name ----------------------------------------------------------------

test('one exact name on today\'s servers is the answer, in one call', async () => {
  reset();
  servers.setBmId('eu1', '101');
  handler = async (u) => (isServers(u) ? json(200, page(player(1, 'Alpha', { uuids: [U1] }), player(2, 'Alphabet'))) : json(503, {}));
  const r = await bm.findPlayers('alpha');
  assert.equal(r.candidates.length, 1);
  assert.deepEqual(r.candidates[0], { bmPlayerId: '1', name: 'Alpha', lastSeen: '2026-09-01T00:00:00.000Z', previousName: null, biUid: U1, exact: true });
  assert.equal(calls.length, 1);
});

test('no exact name: close names from the organisation, best first, strangers left out', async () => {
  reset();
  servers.setBmId('eu1', '101');
  handler = async (u) => {
    if (isServers(u)) return json(200, page(player(9, 'Bravo')));
    if (isOrg(u)) {
      return json(200, page(
        player(3, 'Jammad123', { lastSeen: '2026-09-10T00:00:00.000Z' }),
        player(2, 'Jam mad', { lastSeen: '2026-09-02T00:00:00.000Z' }),
        player(4, 'Jamnad', { lastSeen: '2026-09-12T00:00:00.000Z' }),
        player(5, 'Totally Different'),
      ));
    }
    return json(503, {});
  };
  const r = await bm.findPlayers('Jammad-');
  assert.deepEqual(r.candidates.map((c) => c.bmPlayerId), ['2', '3', '4']);
  assert.ok(r.candidates.every((c) => c.exact === false));
  assert.equal(calls.length, 2);
});

test('two players with the exact name are both offered, most recently seen first', async () => {
  reset();
  handler = async () => json(200, page(
    player(1, 'MeatChuggins', { lastSeen: '2026-08-01T00:00:00.000Z' }),
    player(2, 'meatchuggins', { lastSeen: '2026-09-13T00:00:00.000Z' }),
  ));
  const r = await bm.findPlayers('MeatChuggins');
  assert.deepEqual(r.candidates.map((c) => c.bmPlayerId), ['2', '1']);
  assert.ok(r.candidates.every((c) => c.exact === true));
});

test('a renamed player is found by their old name and shown under the new one', async () => {
  reset();
  handler = async () => json(200, page(player(7, 'alanwanaf1ght', { pastNames: ['Jagged-tiddler12'], uuids: [U2] })));
  const r = await bm.findPlayers('Jagged-tiddler12');
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].name, 'alanwanaf1ght');
  assert.equal(r.candidates[0].previousName, 'Jagged-tiddler12');
  assert.equal(r.candidates[0].exact, false);
  assert.equal(r.candidates[0].biUid, U2);
});

test('an Xbox #1234 suffix, case and spacing do not matter', async () => {
  reset();
  handler = async () => json(200, page(player(8, 'Kaito#1234')));
  assert.equal((await bm.findPlayers('kaito')).candidates[0].bmPlayerId, '8');
  bm._test.reset();
  handler = async () => json(200, page(player(9, 'Depraved Ether Addict')));
  assert.equal((await bm.findPlayers('depravedetheraddict')).candidates[0].bmPlayerId, '9');
});

test('offers at most findMax players', async () => {
  reset();
  handler = async () => json(200, page(...Array.from({ length: 20 }, (_, i) => player(100 + i, `Ghost${i}`))));
  assert.equal((await bm.findPlayers('ghost')).candidates.length, DEFAULTS.findMax);
});

test('"not me" (wide) skips the today\'s-servers shortcut', async () => {
  reset();
  servers.setBmId('eu1', '101');
  handler = async (u) => (isOrg(u) ? json(200, page(player(1, 'Alpha'), player(2, 'Alpha'))) : json(200, page(player(1, 'Alpha'))));
  const r = await bm.findPlayers('Alpha', { wide: true });
  assert.equal(calls.length, 1);
  assert.ok(isOrg(calls[0].url));
  assert.equal(r.candidates.length, 2);
});

test('an in-game id with no linked uuid in the search stays unset for the pick', async () => {
  reset();
  handler = async () => json(200, page(player(1, 'Alpha'), player(2, 'Bravo', { uuids: [U1] })));
  const r = await bm.findPlayers('Alpha');
  assert.equal(r.candidates[0].biUid, null);
});

// ---- By in-game id ----------------------------------------------------------

function matchHit(pid, orgIds) {
  return {
    data: [{
      type: 'identifier', id: 'm1',
      attributes: { type: 'reforgerUUID', identifier: U1, lastSeen: '2026-09-13T00:00:00.000Z' },
      relationships: {
        player: { data: { type: 'player', id: String(pid) } },
        organizations: { data: orgIds.map((id) => ({ type: 'organization', id })) },
      },
    }],
  };
}

test('a pasted in-game id finds that player exactly, checked against our organisation', async () => {
  reset();
  handler = async (u, opts) => {
    if (u.endsWith('/players/match')) {
      assert.equal(opts.method, 'POST');
      assert.ok(String(opts.body).includes(U1));
      return json(200, matchHit(42, ['5', '112993']));
    }
    if (u.includes('/players/42?include=identifier')) return json(200, detail(player(42, 'Zulu', { uuids: [U1] })));
    return json(503, {});
  };
  const r = await bm.findPlayers(`{ ${U1.toUpperCase()} }`);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].bmPlayerId, '42');
  assert.equal(r.candidates[0].name, 'Zulu');
  assert.equal(r.candidates[0].biUid, U1);
  assert.equal(r.candidates[0].exact, true);
  assert.equal(calls.length, 2);
});

test('an in-game id never seen on a ReforgedZ server finds nobody', async () => {
  reset();
  handler = async (u) => (u.endsWith('/players/match') ? json(200, matchHit(42, ['5'])) : json(200, detail(player(42, 'Zulu'))));
  assert.deepEqual((await bm.findPlayers(U1)).candidates, []);
  assert.equal(calls.length, 1);
  bm._test.reset();
  calls.length = 0;
  handler = async () => json(200, { data: [] });
  assert.deepEqual((await bm.findPlayers(U1)).candidates, []);
});

test('the placeholder id and junk find nobody and make no call', async () => {
  reset();
  handler = async () => json(200, page());
  assert.deepEqual((await bm.findPlayers('00000000-0000-0000-0000-000000000000')).candidates, []);
  assert.deepEqual((await bm.findPlayers('x'.repeat(200))).candidates, []);
  assert.deepEqual((await bm.findPlayers('   ')).candidates, []);
  assert.equal(calls.length, 0);
});

// ---- Failures, cache --------------------------------------------------------

test('an outage is unavailable, by name or by id', async () => {
  reset();
  handler = async () => json(503, {});
  assert.equal((await bm.findPlayers('Alpha')).unavailable, true);
  bm._test.reset();
  assert.equal((await bm.findPlayers(U1)).unavailable, true);
  bm._test.reset();
  process.env.BATTLEMETRICS_TOKEN = '';
  assert.equal((await bm.findPlayers('Alpha')).unavailable, true);
});

test('a repeat search costs nothing, and its answer is a copy', async () => {
  reset();
  handler = async () => json(200, page(player(1, 'Alpha', { uuids: [U1] })));
  const a = await bm.findPlayers('Alpha');
  a.candidates[0].bmPlayerId = 'tampered';
  const b = await bm.findPlayers('alpha');
  assert.equal(b.candidates[0].bmPlayerId, '1');
  assert.equal(calls.length, 1);
});

test('the finder and the exact lookup never answer for each other', async () => {
  reset();
  handler = async () => json(200, page(player(1, 'Alpha', { uuids: [U1] })));
  await bm.findPlayers('Alpha');
  const r = await bm.lookupPlayerByGamertag('Alpha', 'xbox');
  assert.equal(r.bmPlayerId, '1');
  assert.equal(calls.length, 2);
});

test('reforgerUuidForPlayer: linked id, unlinked fallback, none, outage', async () => {
  reset();
  handler = async () => json(200, detail(player(5, 'Echo', { uuids: [U2] })));
  assert.deepEqual(await bm.reforgerUuidForPlayer('5'), { biUid: U2 });
  handler = async () => json(200, { data: { type: 'player', id: '5' }, included: [{ type: 'identifier', id: 'x', attributes: { type: 'reforgerUUID', identifier: U1 } }] });
  assert.deepEqual(await bm.reforgerUuidForPlayer('5'), { biUid: U1 });
  handler = async () => json(200, detail(player(5, 'Echo')));
  assert.deepEqual(await bm.reforgerUuidForPlayer('5'), { biUid: null });
  handler = async () => json(500, {});
  assert.equal((await bm.reforgerUuidForPlayer('5')).unavailable, true);
  const before = calls.length;
  assert.deepEqual(await bm.reforgerUuidForPlayer('5/../x'), { biUid: null });
  assert.equal(calls.length, before);
});

// ---- Pure helpers -----------------------------------------------------------

test('asReforgerUuid, looseName and closeness', () => {
  assert.equal(bm.asReforgerUuid(` {${U1.toUpperCase()}} `), U1);
  assert.equal(bm.asReforgerUuid('00000000-0000-0000-0000-000000000000'), null);
  assert.equal(bm.asReforgerUuid('Alpha'), null);
  assert.equal(bm._test.looseName('Kaito#1234'), 'kaito');
  assert.equal(bm._test.looseName('Jam_mad-'), 'jammad');
  assert.equal(bm._test.closeness('Alpha', 'alpha'), 0);
  assert.equal(bm._test.closeness('Al pha', 'alpha'), 1);
  assert.equal(bm._test.closeness('Alphabet', 'alpha'), 2);
  assert.equal(bm._test.closeness('Alpho', 'alpha'), 3);
  assert.equal(bm._test.closeness('Zulu', 'alpha'), null);
  assert.equal(bm._test.closeness('ab', 'abc'), null);
});

test('remembered picks: only what this browser was shown, merged, capped, expiring', () => {
  const session = {};
  ci.rememberCandidates(session, [
    { bmPlayerId: '1', name: 'Alpha', biUid: U1, lastSeen: 'x', exact: true },
    { bmPlayerId: 'abc', name: 'Bad' },
  ], 1000);
  assert.deepEqual(session.identityFind.list, [{ bmPlayerId: '1', name: 'Alpha', biUid: U1 }]);
  assert.deepEqual(ci.pickCandidate(session, '1', 2000), { bmPlayerId: '1', name: 'Alpha', biUid: U1 });
  assert.equal(ci.pickCandidate(session, 1, 2000).name, 'Alpha');
  assert.equal(ci.pickCandidate(session, '2', 2000), null);
  assert.equal(ci.pickCandidate(session, '1 OR 1=1', 2000), null);
  assert.equal(ci.pickCandidate(session, '1', 1000 + ci.CANDIDATE_TTL_MS + 1), null);
  assert.equal(ci.pickCandidate({}, '1', 2000), null);
  // A crafted JSON body is refused, never thrown: String() on this object throws.
  assert.equal(ci.pickCandidate(session, { toString: 1 }, 2000), null);
  assert.equal(ci.pickCandidate(session, ['1'], 2000), null);
  ci.rememberCandidates(session, [{ bmPlayerId: '2', name: 'Bravo' }], 3000);
  assert.deepEqual(session.identityFind.list.map((c) => c.bmPlayerId), ['1', '2']);
  ci.rememberCandidates(session, Array.from({ length: 30 }, (_, i) => ({ bmPlayerId: String(100 + i), name: 'n' })), 4000);
  assert.equal(session.identityFind.list.length, ci.CANDIDATE_MAX);
  assert.equal(ci.pickCandidate(session, '129', 4000).bmPlayerId, '129');
  ci.rememberCandidates(session, [{ bmPlayerId: '7', name: 'Late' }], 4000 + ci.CANDIDATE_TTL_MS + 1);
  assert.deepEqual(session.identityFind.list.map((c) => c.bmPlayerId), ['7']);
});

test('maskEmail shows enough to recognise, never the address', () => {
  const m = ci.maskEmail('john.doe@gmail.com');
  assert.ok(m.startsWith('j'));
  assert.ok(m.includes('@g'));
  assert.ok(m.endsWith('.com'));
  assert.ok(!m.includes('john'));
  assert.ok(!m.includes('gmail'));
  assert.ok(ci.maskEmail('a@b.co'));
  assert.equal(ci.maskEmail('not-an-email'), null);
  assert.equal(ci.maskEmail(''), null);
  assert.equal(ci.maskEmail('@x.com'), null);
});

test('accountIsProtected and latestPayerEmail read the orders table', () => {
  const seen = [];
  const fakeDb = (row) => ({ prepare: (sql) => ({ get: (...args) => { seen.push([sql, args]); return row; } }) });
  assert.equal(ci.accountIsProtected(fakeDb({ 1: 1 }), 'console:5'), true);
  assert.equal(ci.accountIsProtected(fakeDb(undefined), 'console:5'), false);
  assert.ok(seen[0][0].includes("status = 'completed'"));
  assert.deepEqual(seen[0][1], ['console:5']);
  assert.equal(ci.latestPayerEmail(fakeDb({ payer_email: ' buyer@example.com ' }), 'console:5'), 'buyer@example.com');
  assert.equal(ci.latestPayerEmail(fakeDb(undefined), 'console:5'), null);
});

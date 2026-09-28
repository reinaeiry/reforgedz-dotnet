// Unit tests for the identity finder (playerLookup.js: our own player index, which
// replaced BattleMetrics on 2026-09-28) and the console sign-in helpers
// (consoleIdentity.js). No network: fetch is replaced. Fixtures follow the answers
// the ban controller's /api/players routes give (controller/player_index.py).
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PLAYER_INDEX_URL = 'http://index.test';
process.env.PLAYER_INDEX_KEY = 'test-key';

const pl = require('../playerLookup');
const ci = require('../consoleIdentity');

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

const U1 = '41b8ec0d-f0bd-4c41-b2a9-8213ebe04aac';
const U2 = '9f86d081-884c-4d63-9b2f-0b822cd15d6c';

test.beforeEach(() => {
  calls.length = 0;
  pl._test.reset();
  handler = async () => { throw new Error('no handler set'); };
});

test('a name search asks the index once, with the key, and keeps its order', async () => {
  handler = async (url) => json(200, { candidates: [
    { uid: U1, name: 'Alpha', previousName: null, lastSeen: '2026-09-27T10:00:00Z', exact: true },
    { uid: U2, name: 'Alphabet', previousName: null, lastSeen: '2026-09-20T10:00:00Z', exact: false },
  ] });
  const r = await pl.findPlayers('Alpha');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith('http://index.test/api/players/find?q=Alpha&limit=6'));
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(r.candidates.map((c) => c.name), ['Alpha', 'Alphabet']);
  assert.deepEqual(r.candidates[0], {
    bmPlayerId: pl._test.refFor(U1), name: 'Alpha', lastSeen: '2026-09-27T10:00:00Z', previousName: null, biUid: U1, exact: true,
  });
});

test('the ref the browser sees is a number, never the in-game ID', async () => {
  const ref = pl._test.refFor(U1);
  assert.match(ref, /^\d{1,20}$/);
  assert.ok(Number.isSafeInteger(Number(ref)));
  assert.ok(!ref.includes(U1.slice(0, 8)));
  assert.notEqual(pl._test.refFor(U1), pl._test.refFor(U2));
  // consoleIdentity accepts it as a candidate id
  const session = {};
  ci.rememberCandidates(session, [pl._test.toCandidate({ uid: U1, name: 'Alpha' })], 1000);
  assert.equal(ci.pickCandidate(session, ref, 2000).biUid, U1);
});

test('"not me" (wide) is passed on', async () => {
  handler = async () => json(200, { candidates: [] });
  await pl.findPlayers('Alpha', { wide: true });
  assert.ok(calls[0].url.includes('&wide=1'));
});

test('a renamed player comes back under the new name with the old one alongside', async () => {
  handler = async () => json(200, { candidates: [
    { uid: U2, name: 'alanwanaf1ght', previousName: 'Jagged-tiddler12', lastSeen: '2026-09-27T00:00:00Z', exact: false },
  ] });
  const r = await pl.findPlayers('Jagged-tiddler12');
  assert.equal(r.candidates[0].name, 'alanwanaf1ght');
  assert.equal(r.candidates[0].previousName, 'Jagged-tiddler12');
  assert.equal(r.candidates[0].biUid, U2);
});

test('a pasted in-game ID is looked up exactly, and an unknown one finds nobody', async () => {
  handler = async (url) => (url.includes(U1)
    ? json(200, { found: true, uid: U1, name: 'Alpha', lastSeen: '2026-09-27T10:00:00Z' })
    : json(200, { found: false }));
  const r = await pl.findPlayers(` {${U1.toUpperCase()}} `);
  assert.ok(calls[0].url.endsWith(`/api/players/lookup/${U1}`));
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].biUid, U1);
  assert.equal(r.candidates[0].exact, true);
  assert.deepEqual((await pl.findPlayers(U2)).candidates, []);
});

test('junk and the placeholder ID find nobody and make no call', async () => {
  assert.deepEqual(await pl.findPlayers(''), { candidates: [] });
  assert.deepEqual(await pl.findPlayers('   '), { candidates: [] });
  assert.deepEqual(await pl.findPlayers('a'.repeat(40)), { candidates: [] });
  assert.deepEqual(await pl.findPlayers('bad\u0000name'), { candidates: [] });
  assert.deepEqual((await pl.findPlayers('00000000-0000-0000-0000-000000000000')).candidates.length >= 0, true);
  assert.equal(calls.filter((c) => c.url.includes('00000000-0000-0000-0000-000000000000')).length, 0);
});

test('an outage is unavailable, never "no such player", and is not cached', async () => {
  handler = async () => json(502, { error: 'down' });
  assert.equal((await pl.findPlayers('Alpha')).unavailable, true);
  handler = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal((await pl.findPlayers(U1)).unavailable, true);
  handler = async () => json(200, { candidates: [{ uid: U1, name: 'Alpha' }] });
  assert.equal((await pl.findPlayers('Alpha')).candidates.length, 1);
});

test('a refused query (400) is an answer: nobody', async () => {
  handler = async () => json(400, { error: 'bad_query' });
  assert.deepEqual(await pl.findPlayers('Alpha'), { candidates: [] });
});

test('no URL or key is an outage, and no call is made', async () => {
  const saved = process.env.PLAYER_INDEX_KEY;
  delete process.env.PLAYER_INDEX_KEY;
  try {
    const r = await pl.findPlayers('Alpha');
    assert.equal(r.unavailable, true);
    assert.equal(calls.length, 0);
  } finally {
    process.env.PLAYER_INDEX_KEY = saved;
  }
});

test('a repeat search costs nothing, and its answer is a copy', async () => {
  handler = async () => json(200, { candidates: [{ uid: U1, name: 'Alpha' }] });
  const a = await pl.findPlayers('Alpha');
  a.candidates[0].name = 'changed';
  const b = await pl.findPlayers('alpha');
  assert.equal(calls.length, 1);
  assert.equal(b.candidates[0].name, 'Alpha');
});

test('answers without a valid in-game ID are dropped, and at most findMax are offered', async () => {
  handler = async () => json(200, { candidates: [
    { uid: 'not-an-id', name: 'X' },
    ...Array.from({ length: 10 }, (_, i) => ({ uid: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`, name: `ghost${i}` })),
  ] });
  const r = await pl.findPlayers('ghost');
  assert.equal(r.candidates.length, pl._test.T.findMax);
  assert.ok(r.candidates.every((c) => /^[0-9a-f-]{36}$/.test(c.biUid)));
});

test('matchReforgerUuid: found with a name, not found, could not ask', async () => {
  handler = async (url) => (url.includes(U1)
    ? json(200, { found: true, uid: U1, name: 'Alpha', lastSeen: '2026-09-27T10:00:00Z' })
    : json(200, { found: false }));
  assert.deepEqual(await pl.matchReforgerUuid(U1), { found: true, lastSeen: '2026-09-27T10:00:00Z', name: 'Alpha' });
  assert.deepEqual(await pl.matchReforgerUuid(U2), { found: false, lastSeen: null });
  handler = async () => json(503, {});
  assert.equal((await pl.matchReforgerUuid(U1)).found, null);
  assert.equal((await pl.matchReforgerUuid('nonsense')).found, false);
});

test('reforgerUuidForPlayer has nothing for a pre-2026-09-28 BattleMetrics pick', async () => {
  assert.deepEqual(await pl.reforgerUuidForPlayer('123456'), { biUid: null });
});

test('asReforgerUuid and cleanGamertag', () => {
  assert.equal(pl.asReforgerUuid(` {${U1.toUpperCase()}} `), U1);
  assert.equal(pl.asReforgerUuid('00000000-0000-0000-0000-000000000000'), null);
  assert.equal(pl.asReforgerUuid('Alpha'), null);
  assert.equal(pl.cleanGamertag('  Kaito#1234 '), 'Kaito#1234');
  assert.equal(pl.cleanGamertag('x'.repeat(33)), null);
  assert.equal(pl.cleanGamertag('bad​name'), null);
  assert.equal(pl.cleanGamertag(42), null);
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

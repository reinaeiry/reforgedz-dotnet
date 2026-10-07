// Tests for the in-game cosmetic entitlements (cosmetics.js) and their place in the
// purchase sync, against the REAL schema: db.js is loaded with DATA_DIR pointed at a
// throwaway folder. Nothing connects to a game server.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-cosmetics-'));
process.env.DATA_DIR = dataDir;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
const sync = require('../sync');
Object.assign(console, quiet);
const cosmetics = require('../cosmetics');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 10, 15) / 1000;
let n = 0;
function user(guid) {
  n += 1;
  const steam = `7656119000000${String(n).padStart(4, '0')}`;
  db.prepare('INSERT INTO users (steam_id, persona, bi_uid, platform) VALUES (?, ?, ?, ?)').run(steam, `Player${n}`, guid, 'steam');
  return steam;
}
function product(title, { key = null, pq = 0, type = 'one_time' } = {}) {
  return db.prepare('INSERT INTO products (title, price_cents, type, cosmetic_key, grants_priority_queue) VALUES (?, 500, ?, ?, ?)')
    .run(title, type, key, pq).lastInsertRowid;
}
function order(steam, productId, { status = 'completed', until = null, test = 0, server = null } = {}) {
  db.prepare(`INSERT INTO orders (steam_id, product_id, status, amount_cents, completed_at, effective_until, test_mode, server_id)
              VALUES (?, ?, ?, 500, ?, ?, ?, ?)`).run(steam, productId, status, NOW - 86400, until, test, server);
}

test('keys: lowercase letters, digits, dot, dash, underscore; the form clears with an empty value', () => {
  for (const ok of ['armband.stripes-red', 'flag.wolf', 'a', 'clan_7.armband']) assert.equal(cosmetics.isCosmeticKey(ok), true, ok);
  for (const bad of ['Armband', '.armband', 'arm band', '', 'a'.repeat(65), 'x/../y', null, 7]) assert.equal(cosmetics.isCosmeticKey(bad), false, String(bad));
  assert.deepEqual(cosmetics.normalizeCosmeticKey(' Armband.Red '), { ok: true, value: 'armband.red' });
  assert.deepEqual(cosmetics.normalizeCosmeticKey(''), { ok: true, value: null });
  assert.deepEqual(cosmetics.normalizeCosmeticKey(null), { ok: true, value: null });
  assert.deepEqual(cosmetics.normalizeCosmeticKey('bad key!'), { ok: false, value: null });
});

test('nothing is configured until some product carries a cosmetic key', () => {
  product('Priority Queue', { pq: 1, type: 'subscription' });
  assert.equal(cosmetics.cosmeticsConfigured(db), false);
  assert.deepEqual(cosmetics.buildCosmeticEntries(db, NOW), []);
});

test('entries: live paid orders on accounts with an in-game ID, one per ID and key, oldest first', () => {
  const armband = product('Red stripes armband', { key: 'armband.stripes-red' });
  const flag = product('Wolf flag', { key: 'flag.wolf' });
  const backer = product('Backer', { key: 'armband.backer', type: 'subscription' });
  const plain = product('Supporter');
  assert.equal(cosmetics.cosmeticsConfigured(db), true);

  const a = user('aaaaaaaa-0000-4000-8000-000000000001');
  const b = user('bbbbbbbb-0000-4000-8000-000000000002');
  const c = user('');                                           // no in-game ID: cannot be granted
  const d = user('dddddddd-0000-4000-8000-000000000004');
  const dTwin = user('DDDDDDDD-0000-4000-8000-000000000004');   // the same ID in capitals
  order(a, armband);                                              // one-time: never expires
  order(a, armband);                                              // bought twice: listed once
  order(a, flag, { status: 'refunded' });                         // refunded: out
  order(b, backer, { until: NOW + 86400 });                       // live subscription: in
  order(b, flag, { test: 1 });                                    // sandbox: out
  order(d, backer, { until: NOW - 1 });                           // lapsed: out
  order(c, armband);                                              // no in-game ID: out
  order(d, plain);                                                // not a cosmetic: out
  order(d, flag, { status: 'pending' });                          // never paid: out
  order(dTwin, armband);
  order(d, armband);                                              // same ID as dTwin, different case: once

  const entries = cosmetics.buildCosmeticEntries(db, NOW);
  assert.deepEqual(entries.map(e => [e.guid.toLowerCase(), e.item]), [
    ['aaaaaaaa-0000-4000-8000-000000000001', 'armband.stripes-red'],
    ['bbbbbbbb-0000-4000-8000-000000000002', 'armband.backer'],
    ['dddddddd-0000-4000-8000-000000000004', 'armband.stripes-red']
  ]);
  assert.deepEqual(Object.keys(entries[0]).sort(), ['guid', 'item', 'name']);
});

test('a stored key that breaks the rule is never sent to a server', () => {
  const odd = product('Odd', {});
  db.prepare("UPDATE products SET cosmetic_key = 'Bad Key' WHERE id = ?").run(odd);
  const e = user('eeeeeeee-0000-4000-8000-000000000005');
  order(e, odd);
  assert.ok(!cosmetics.buildCosmeticEntries(db, NOW).some(x => x.item === 'Bad Key'));
});

test('the write command lands the exact list atomically and confirms per server', () => {
  const json = JSON.stringify([{ name: 'P', guid: 'g', item: 'flag.wolf' }], null, 2);
  const cmd = cosmetics.buildWriteCosmeticsCmd({ id: 'eu1', path: '/srv/eu1/profile' }, json);
  const b64 = /echo '([A-Za-z0-9+/=]+)' \| base64 -d > '\/srv\/eu1\/profile\/cosmetics\.json\.tmp'/.exec(cmd);
  assert.ok(b64, 'writes a temp file from base64');
  assert.equal(Buffer.from(b64[1], 'base64').toString(), json);
  assert.ok(cmd.indexOf(".tmp' '/srv/eu1/profile/cosmetics.json'") > cmd.indexOf('base64 -d'), 'renames over the target after writing');
  assert.match(cmd, /echo '\[cosmetics\] eu1 OK'$/);
});

test('purchases.json stays priority queue only: cosmetics never enter it', () => {
  const buckets = sync.buildPerServerPurchaseBuckets(NOW);
  for (const id of Object.keys(buckets)) {
    for (const e of buckets[id]) assert.notEqual(e.item, 'Red stripes armband', `${id} must not list a cosmetic`);
  }
});

test('checkout asks for an in-game ID only for what is delivered in game', () => {
  assert.equal(cosmetics.deliveredInGame({ grants_priority_queue: 1, cosmetic_key: null }), true);
  assert.equal(cosmetics.deliveredInGame({ grants_priority_queue: 0, cosmetic_key: 'armband.stripes-red' }), true);
  assert.equal(cosmetics.deliveredInGame({ grants_priority_queue: 0, cosmetic_key: null }), false, 'Backer and Supporter are Discord only');
  assert.equal(cosmetics.deliveredInGame({ grants_priority_queue: 0, cosmetic_key: 'Bad Key' }), false);
  assert.equal(cosmetics.deliveredInGame(null), false);
});

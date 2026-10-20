// One cosmetic key on two products (decision B6, 2026-10-20): Backer (monthly) and
// Supporter (one-time) both unlock armband_supporter, and the sync lists each
// holder once. Also: a product whose sale window has ended (B7) still lists the
// players who bought it. Against the REAL schema (db.js with DATA_DIR in a
// throwaway folder). Nothing connects to a game server.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-sharedkey-'));
process.env.DATA_DIR = dataDir;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const cosmetics = require('../cosmetics');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 11, 20) / 1000;
const DAY = 86400;
let n = 0;
function user(guid) {
  n += 1;
  const steam = `7656119000000${String(n).padStart(4, '0')}`;
  db.prepare('INSERT INTO users (steam_id, persona, bi_uid, platform) VALUES (?, ?, ?, ?)').run(steam, `Player${n}`, guid, 'steam');
  return steam;
}
function product(title, { key = null, type = 'one_time', until = null } = {}) {
  return Number(db.prepare('INSERT INTO products (title, price_cents, type, cosmetic_key, available_until) VALUES (?, 500, ?, ?, ?)')
    .run(title, type, key, until).lastInsertRowid);
}
function order(steam, productId, { status = 'completed', effectiveUntil = null, test = 0 } = {}) {
  db.prepare(`INSERT INTO orders (steam_id, product_id, status, amount_cents, completed_at, effective_until, test_mode)
              VALUES (?, ?, ?, 500, ?, ?, ?)`).run(steam, productId, status, NOW - 5 * DAY, effectiveUntil, test);
}
const G = (i) => `0000000${i}-0000-4000-8000-00000000000${i}`;

test('two products may carry the same key, and a buyer of either, or both, is listed once', () => {
  const backer = product('Backer', { key: 'armband_supporter', type: 'subscription' });
  const supporter = product('Supporter', { key: 'armband_supporter' });
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM products WHERE cosmetic_key = 'armband_supporter'").get().c, 2, 'no uniqueness on the key');
  assert.equal(cosmetics.cosmeticsConfigured(db), true);

  const both = user(G(1));
  order(both, backer, { effectiveUntil: NOW + 20 * DAY });
  order(both, supporter);
  const lapsedBacker = user(G(2));
  order(lapsedBacker, backer, { effectiveUntil: NOW - DAY });
  const supporterOnly = user(G(3));
  order(supporterOnly, supporter);
  const liveBackerOnly = user(G(4));
  order(liveBackerOnly, backer, { effectiveUntil: NOW + 10 * DAY });
  const refunded = user(G(5));
  order(refunded, supporter, { status: 'refunded' });

  const entries = cosmetics.buildCosmeticEntries(db, NOW);
  assert.deepEqual(entries, [
    { guid: G(1), item: 'armband_supporter' },
    { guid: G(3), item: 'armband_supporter' },
    { guid: G(4), item: 'armband_supporter' }
  ]);
  const lines = cosmetics.serializeCosmeticEntries(entries).split('\n');
  assert.equal(lines.filter((l) => l.includes(G(1))).length, 1, 'the holder of both is written once');
});

test('a product whose sale window has ended still lists everyone who bought it', () => {
  const winter = product('Winter Armband', { key: 'armband_winter_2026', until: NOW - 30 * DAY });
  const holder = user(G(6));
  order(holder, winter);
  const entries = cosmetics.buildCosmeticEntries(db, NOW);
  assert.ok(entries.some((e) => e.guid === G(6) && e.item === 'armband_winter_2026'), 'the window hides the product from the shop, not from its buyers');
});

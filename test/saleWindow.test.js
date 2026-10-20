// Tests for a product's sale window (saleWindow.js, decision B7 of 2026-10-20),
// and its SQL form against the REAL schema (db.js with DATA_DIR in a throwaway
// folder): a product with no dates is never blocked; outside its window it is not
// listed and checkout is refused with a plain sentence.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-salewindow-'));
process.env.DATA_DIR = dataDir;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const sw = require('../saleWindow');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const utc = (...parts) => Date.UTC(...parts) / 1000;
const FROM = utc(2026, 11, 17, 0, 0);        // 2026-12-17 00:00 UTC
const UNTIL = utc(2027, 0, 4, 23, 59);       // 2027-01-04 23:59 UTC

test('on sale: no dates means always; a start in the future or an end in the past means not now; the ends are inclusive', () => {
  assert.equal(sw.onSale({}, 1), true);
  assert.equal(sw.onSale({ available_from: null, available_until: null }, 1), true);
  assert.equal(sw.onSale({ available_from: FROM }, FROM - 1), false);
  assert.equal(sw.onSale({ available_from: FROM }, FROM), true);
  assert.equal(sw.onSale({ available_until: UNTIL }, UNTIL), true);
  assert.equal(sw.onSale({ available_until: UNTIL }, UNTIL + 1), false);
  assert.equal(sw.onSale({ available_from: FROM, available_until: UNTIL }, utc(2026, 11, 25)), true);
  assert.equal(sw.onSale({ available_from: FROM, available_until: UNTIL }, utc(2026, 11, 1)), false);
  assert.equal(sw.onSale({ available_from: FROM, available_until: UNTIL }, utc(2027, 0, 10)), false);
  // Values as SQLite may hand them back, and junk, which counts as no date.
  assert.equal(sw.onSale({ available_from: String(FROM) }, FROM + 5), true);
  assert.equal(sw.onSale({ available_from: 'soon' }, 1), true);
  assert.equal(sw.onSale(null, 1), true);
});

test('the refusal is one plain sentence with the date in UTC, and null while on sale', () => {
  const p = { available_from: FROM, available_until: UNTIL };
  assert.equal(sw.refusal(p, utc(2026, 11, 1)), 'This item goes on sale on 17 December 2026 at 00:00 UTC.');
  assert.equal(sw.refusal(p, utc(2027, 0, 10)), 'This item is no longer on sale.');
  assert.equal(sw.refusal(p, utc(2026, 11, 25)), null);
  assert.equal(sw.refusal({}, 1), null);
  assert.doesNotMatch(sw.refusal(p, utc(2026, 11, 1)), /[^\x20-\x7E]/, 'plain ASCII, no emoji');
});

test('the admin form values: empty clears, whole unix seconds are taken, junk and a backwards window are refused, a missing field is left alone', () => {
  assert.deepEqual(sw.normalizeWindow({}), { ok: true, from: undefined, until: undefined });
  assert.deepEqual(sw.normalizeWindow({ availableFrom: '', availableUntil: null }), { ok: true, from: null, until: null });
  assert.deepEqual(sw.normalizeWindow({ availableFrom: FROM, availableUntil: String(UNTIL) }), { ok: true, from: FROM, until: UNTIL });
  assert.deepEqual(sw.normalizeWindow({ availableFrom: FROM }), { ok: true, from: FROM, until: undefined });
  for (const bad of ['soon', 1.5, -1, '2026-12-17', {}, [], true, 1e12]) {
    assert.equal(sw.normalizeWindow({ availableFrom: bad }).ok, false, JSON.stringify(bad));
  }
  assert.equal(sw.normalizeWindow({ availableFrom: UNTIL, availableUntil: FROM }).ok, false);
  assert.equal(sw.normalizeWindow({ availableFrom: FROM, availableUntil: FROM }).ok, true, 'a one-second window is allowed');
});

test('the SQL form lists the same products as onSale, against the real schema', () => {
  const ins = db.prepare('INSERT INTO products (title, price_cents, type, active, available_from, available_until) VALUES (?, 500, ?, 1, ?, ?)');
  const always = Number(ins.run('Always', 'one_time', null, null).lastInsertRowid);
  const winter = Number(ins.run('Winter Armband', 'one_time', FROM, UNTIL).lastInsertRowid);
  const openEnded = Number(ins.run('From spring', 'one_time', utc(2027, 2, 1), null).lastInsertRowid);
  const ended = Number(ins.run('Last summer', 'one_time', null, utc(2026, 8, 1)).lastInsertRowid);
  const inactive = Number(db.prepare('INSERT INTO products (title, price_cents, type, active) VALUES (?, 500, ?, 0)').run('Retired', 'one_time').lastInsertRowid);

  const listed = (now) => db.prepare(`SELECT id FROM products WHERE active = 1 AND ${sw.onSaleSql('products', '@now')} ORDER BY id`).all({ now }).map((r) => r.id);
  assert.deepEqual(listed(utc(2026, 11, 1)), [always]);
  assert.deepEqual(listed(FROM), [always, winter]);
  assert.deepEqual(listed(utc(2026, 11, 25)), [always, winter]);
  assert.deepEqual(listed(UNTIL), [always, winter]);
  assert.deepEqual(listed(UNTIL + 1), [always]);
  assert.deepEqual(listed(utc(2027, 2, 1)), [always, openEnded]);
  assert.ok(!listed(utc(2026, 11, 25)).includes(ended));
  assert.ok(!listed(utc(2026, 11, 25)).includes(inactive));

  // The JS rule agrees with the SQL rule on every product and moment above.
  const all = db.prepare('SELECT * FROM products WHERE active = 1').all();
  for (const now of [utc(2026, 11, 1), FROM, utc(2026, 11, 25), UNTIL, UNTIL + 1, utc(2027, 2, 1)]) {
    const js = all.filter((p) => sw.onSale(p, now)).map((p) => p.id).sort((a, b) => a - b);
    assert.deepEqual(js, listed(now), `at ${now}`);
  }
});

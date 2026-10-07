// Tests for the public "running costs covered" meter (funding.js) against the REAL
// schema: db.js is loaded with DATA_DIR pointed at a throwaway folder.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-funding-'));
process.env.DATA_DIR = dataDir;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const funding = require('../funding');
const { vatIncludedCents } = require('../vatRates');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const utc = (...parts) => Date.UTC(...parts) / 1000;
db.prepare("INSERT INTO users (steam_id, persona, platform) VALUES ('76561190000000002', 'Buyer', 'steam')").run();
const productId = db.prepare("INSERT INTO products (title, price_cents, type) VALUES ('Priority Queue', 1500, 'subscription')").run().lastInsertRowid;

function order({ status = 'completed', amount = 1500, at, fee = null, payer = null, ip = null, test = 0, revokedKept = false }) {
  db.prepare(`
    INSERT INTO orders (steam_id, product_id, status, amount_cents, created_at, completed_at, fee_cents,
                        payer_country, ip_country, test_mode, revoked_without_refund_at)
    VALUES ('76561190000000002', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(productId, status, amount, at, at, fee, payer, ip, test, revokedKept ? at : null);
}
function expense(label, cents, { tax = 0, kind = 'monthly' } = {}) {
  db.prepare('INSERT INTO monthly_expenses (label, amount_cents, tax_cents, kind) VALUES (?, ?, ?, ?)').run(label, cents, tax, kind);
}

test('the month is the UTC calendar month around now', () => {
  assert.deepEqual(funding.monthOf(utc(2026, 9, 7, 12)), { start: utc(2026, 9, 1), end: utc(2026, 10, 1), label: '2026-10' });
  assert.deepEqual(funding.monthOf(utc(2026, 11, 31, 23, 59)), { start: utc(2026, 11, 1), end: utc(2027, 0, 1), label: '2026-12' });
  assert.equal(funding.estimatedFeeCents(1500), 101);
});

test('no costs entered: no percentage, status unknown', () => {
  const p = funding.publicCoverage(db, { now: utc(2026, 9, 7) });
  assert.deepEqual(p, { month: '2026-10', coveredPct: null, status: 'unknown' });
});

test('kept money: fees (recorded or estimated) and VAT come off; refunds, sandbox and other months stay out', () => {
  expense('OVH', 38000);
  expense('Claude', 40000);
  expense('Server move', 5000, { kind: 'one_off' });               // one-offs are not running costs
  const now = utc(2026, 9, 20);
  order({ at: utc(2026, 9, 2), fee: 124 });                         // US-ish, recorded fee
  order({ at: utc(2026, 9, 3) });                                   // fee estimated: 101
  order({ at: utc(2026, 9, 4), fee: 124, payer: 'GB' });           // UK VAT comes off
  order({ at: utc(2026, 9, 5), fee: 124, ip: 'DE' });              // EU VAT from the checkout country
  order({ at: utc(2026, 9, 6), fee: 124, status: 'refunded' });    // refunded: out
  order({ at: utc(2026, 9, 7), fee: 124, status: 'refunded', revokedKept: true }); // revoked, money kept: in
  order({ at: utc(2026, 9, 8), fee: 124, test: 1 });               // sandbox: out
  order({ at: utc(2026, 8, 30), fee: 124 });                        // last month: out
  order({ at: utc(2026, 9, 9), status: 'pending' });                // never paid: out

  const c = funding.coverage(db, { now });
  assert.equal(c.payments, 5);
  assert.equal(c.costsCents, 78000);
  assert.equal(c.grossCents, 5 * 1500);
  assert.equal(c.feeCents, 124 * 4 + 101);
  assert.equal(c.vatCents, vatIncludedCents(1500, 20) + vatIncludedCents(1500, 19));
  assert.equal(c.keptCents, c.grossCents - c.feeCents - c.vatCents);
  assert.equal(c.coveredPct, Math.floor((c.keptCents * 100) / 78000));
});

test('the public answer is a percentage and a status, never an amount', () => {
  const p = funding.publicCoverage(db, { now: utc(2026, 9, 20) });
  assert.deepEqual(Object.keys(p).sort(), ['coveredPct', 'month', 'status']);
  assert.equal(p.status, 'short');
  assert.ok(p.coveredPct >= 0 && p.coveredPct < 100);
});

test('covered at 100% or more, shown as at most 999%', () => {
  db.prepare('DELETE FROM monthly_expenses').run();
  expense('Tiny', 100);
  const p = funding.publicCoverage(db, { now: utc(2026, 9, 20) });
  assert.equal(p.status, 'covered');
  assert.equal(p.coveredPct, 999);
});

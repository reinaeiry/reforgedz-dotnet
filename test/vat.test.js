// Tests for the VAT evidence and report (vatEvidence.js, vatRates.js) against the
// REAL schema: db.js is loaded with DATA_DIR pointed at a throwaway folder, so the
// migrations that add orders.ip_country and orders.payer_country run as they will
// live. PayPal is a fake that serves Transaction Search pages.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-vat-'));
process.env.DATA_DIR = dataDir;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const vat = require('../vatEvidence');
const rates = require('../vatRates');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const utc = (...parts) => Date.UTC(...parts) / 1000;
const silent = { error: () => {}, log: () => {}, warn: () => {} };

db.prepare("INSERT INTO users (steam_id, persona, platform) VALUES ('76561190000000001', 'Buyer', 'steam')").run();
const productId = db.prepare("INSERT INTO products (title, price_cents, type) VALUES ('Priority Queue', 1500, 'subscription')").run().lastInsertRowid;

function order({ status = 'completed', amount = 1500, at, capture = null, payer = null, ip = null, sub = null, test = 0 }) {
  return db.prepare(`
    INSERT INTO orders (steam_id, product_id, status, amount_cents, created_at, completed_at, paypal_capture_id,
                        payer_country, ip_country, paypal_subscription_id, test_mode)
    VALUES ('76561190000000001', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(productId, status, amount, at, at, capture, payer, ip, sub, test).lastInsertRowid;
}
const countryOf = (id) => db.prepare('SELECT payer_country FROM orders WHERE id = ?').get(id).payer_country;

// ---- Countries -----------------------------------------------------------------

test('a country is two letters; unknown, Tor and malformed codes are not countries', () => {
  assert.equal(vat.normalizeCountry('gb'), 'GB');
  assert.equal(vat.normalizeCountry(' de '), 'DE');
  for (const bad of ['XX', 'T1', 'ZZ', 'EU', '', null, undefined, 'GBR', 'G', '12']) {
    assert.equal(vat.normalizeCountry(bad), null, `${bad} is not a country`);
  }
});

test('the checkout country comes from Cloudflare; the payer country from the PayPal row, code only', () => {
  assert.equal(vat.ipCountryOf({ headers: { 'cf-ipcountry': 'fr' } }), 'FR');
  assert.equal(vat.ipCountryOf({ headers: { 'cf-ipcountry': 'XX' } }), null);
  assert.equal(vat.ipCountryOf({ headers: {} }), null);
  assert.equal(vat.ipCountryOf(null), null);
  assert.equal(vat.payerCountryOf({ payer_info: { country_code: 'IE', email_address: 'a@b.c' } }), 'IE');
  assert.equal(vat.payerCountryOf({ payer_info: { address: { country_code: 'nl' } } }), 'NL');
  assert.equal(vat.payerCountryOf({ transaction_info: {} }), null);
});

test('rates: EU countries file through the One Stop Shop, the UK with HMRC, the rest nowhere', () => {
  assert.deepEqual(rates.vatFor('de'), { scheme: 'EU-OSS', rate: 19 });
  assert.deepEqual(rates.vatFor('FI'), { scheme: 'EU-OSS', rate: 25.5 });
  assert.deepEqual(rates.vatFor('GB'), { scheme: 'UK', rate: 20 });
  assert.deepEqual(rates.vatFor('US'), { scheme: 'none', rate: null });
  assert.deepEqual(rates.vatFor(null), { scheme: 'none', rate: null });
  assert.equal(Object.keys(rates.EU_STANDARD).length, 27);
  assert.equal(rates.vatIncludedCents(1500, 20), 250);
  assert.equal(rates.vatIncludedCents(1500, 25.5), 305);
  assert.equal(rates.vatIncludedCents(1500, null), 0);
});

test('quarters run from the first day of their first month to the first day after, UTC', () => {
  assert.deepEqual(vat.quarterBounds('2026Q4'), { start: utc(2026, 9, 1), end: utc(2027, 0, 1) });
  assert.deepEqual(vat.quarterBounds('2026q1'), { start: utc(2026, 0, 1), end: utc(2026, 3, 1) });
  for (const bad of ['2026Q5', 'Q4', '2026-10', '', null]) assert.equal(vat.quarterBounds(bad), null);
});

test('evidence: two matching sources, a conflict, one source, or none', () => {
  assert.equal(vat.evidenceOf('GB', 'GB'), 'match');
  assert.equal(vat.evidenceOf('GB', 'IE'), 'conflict');
  assert.equal(vat.evidenceOf('GB', null), 'payer-only');
  assert.equal(vat.evidenceOf(null, 'DE'), 'ip-only');
  assert.equal(vat.evidenceOf(null, null), 'none');
});

// ---- Filling payer countries from PayPal ----------------------------------------

function fakePayPal(pages, { failOn = null, configured = true } = {}) {
  const calls = [];
  return {
    calls,
    isConfigured: () => configured,
    async searchTransactions(testMode, args) {
      calls.push({ testMode, ...args });
      if (failOn === args.page) throw new Error('PayPal said 503');
      return { transaction_details: pages[args.page - 1] || [], total_pages: pages.length };
    }
  };
}
const tx = (id, country) => ({ transaction_info: { transaction_id: id }, payer_info: country ? { country_code: country, email_address: 'never@stored.example' } : {} });

test('fill: every page is read, only empty live rows are written, and only the code is kept', async () => {
  const a = order({ at: utc(2026, 9, 2), capture: 'CAP-A' });
  const b = order({ at: utc(2026, 9, 2), capture: 'CAP-B', payer: 'DE' });
  const c = order({ at: utc(2026, 9, 2), capture: 'CAP-C', test: 1 });
  const d = order({ at: utc(2026, 9, 2), capture: 'CAP-D' });
  const pp = fakePayPal([[tx('CAP-A', 'gb'), tx('CAP-B', 'FR'), tx('CAP-X', 'IT')], [tx('CAP-C', 'ES'), tx('CAP-D', null)]]);
  const out = await vat.fillPayerCountries({ db, paypal: pp, start: utc(2026, 9, 1), end: utc(2026, 9, 3), logger: silent });
  assert.equal(out.error, null);
  assert.equal(out.pages, 2);
  assert.equal(out.rows, 5);
  assert.equal(out.withCountry, 4);
  assert.equal(out.filled, 1);
  assert.equal(countryOf(a), 'GB');
  assert.equal(countryOf(b), 'DE', 'an existing country is never overwritten');
  assert.equal(countryOf(c), null, 'sandbox rows are left alone');
  assert.equal(countryOf(d), null);
  assert.equal(pp.calls[0].fields, 'transaction_info,payer_info');
  assert.equal(pp.calls[0].testMode, false);
  const cols = db.prepare('PRAGMA table_info(orders)').all().map(x => x.name);
  assert.ok(!cols.some(n => /payer_(name|mail)/.test(n)), 'no name or email column was added');
});

test('fill: a failed page stops the run, and the rows already filled stay filled', async () => {
  const e = order({ at: utc(2026, 9, 4), capture: 'CAP-E' });
  const f = order({ at: utc(2026, 9, 4), capture: 'CAP-F' });
  const pp = fakePayPal([[tx('CAP-E', 'SE')], [tx('CAP-F', 'PL')]], { failOn: 2 });
  const out = await vat.fillPayerCountries({ db, paypal: pp, start: utc(2026, 9, 3), end: utc(2026, 9, 5), logger: silent });
  assert.match(out.error, /503/);
  assert.equal(countryOf(e), 'SE');
  assert.equal(countryOf(f), null);
});

test('fill: refuses windows PayPal cannot serve and does nothing without live PayPal', async () => {
  const pp = fakePayPal([[]]);
  const long = await vat.fillPayerCountries({ db, paypal: pp, start: utc(2026, 0, 1), end: utc(2026, 2, 1), logger: silent });
  assert.match(long.error, /31 days/);
  const empty = await vat.fillPayerCountries({ db, paypal: pp, start: utc(2026, 0, 2), end: utc(2026, 0, 1), logger: silent });
  assert.match(empty.error, /empty/);
  assert.equal(pp.calls.length, 0);
  const off = await vat.fillPayerCountries({ db, paypal: fakePayPal([[]], { configured: false }), start: utc(2026, 0, 1), end: utc(2026, 0, 2), logger: silent });
  assert.equal(off.skipped, 'live PayPal is not configured');
});

test('the daily run reads the last three days, leaving the newest six hours to the next run', async () => {
  const pp = fakePayPal([[]]);
  const now = utc(2026, 9, 7, 8, 40);
  const out = await vat.runDailyFill({ db, paypal: pp, now, logger: silent });
  assert.equal(out.error, null);
  assert.equal(pp.calls[0].start, (now - 3 * 86400) * 1000);
  assert.equal(pp.calls[0].end, (now - 6 * 3600) * 1000);
  assert.equal(vat.nextRunAt(Date.UTC(2026, 9, 7, 8, 0)), utc(2026, 9, 7, 8, 40));
  assert.equal(vat.nextRunAt(Date.UTC(2026, 9, 7, 9, 0)), utc(2026, 9, 8, 8, 40));
  assert.equal(vat.vatOff({ VAT_EVIDENCE: 'off' }), true);
  assert.equal(vat.vatOff({}), false);
});

// ---- The quarterly report ----------------------------------------------------------

test('report: totals per country from kept live payments, with conflicts and gaps listed for review', () => {
  db.prepare('DELETE FROM orders').run();
  const q = (m, d) => utc(2027, m, d);
  order({ at: q(0, 5), payer: 'GB', ip: 'GB' });                  // match, UK
  order({ at: q(0, 6), payer: 'GB', ip: 'IE' });                  // conflict, filed under PayPal's GB
  order({ at: q(1, 7), ip: 'DE' });                               // checkout only
  order({ at: q(1, 8), payer: 'DE' });                            // PayPal only
  order({ at: q(2, 9), payer: 'US', ip: 'US' });                  // outside both schemes
  order({ at: q(2, 10) });                                        // nothing known
  order({ at: q(0, 11), payer: 'FR', status: 'refunded' });       // refunded: out
  order({ at: q(0, 12), payer: 'FR', test: 1 });                  // sandbox: out
  order({ at: utc(2026, 11, 31, 23, 59), payer: 'FR' });          // previous quarter: out
  order({ at: utc(2027, 3, 1), payer: 'FR' });                    // next quarter: out
  // A renewal row with no checkout of its own takes its subscription's checkout country.
  order({ at: utc(2026, 10, 1), ip: 'NL', sub: 'I-RENEWS' });
  order({ at: q(1, 1), sub: 'I-RENEWS' });

  const r = vat.buildVatReport(db, { quarter: '2027Q1' });
  assert.equal(r.orders, 7);
  assert.equal(r.grossCents, 7 * 1500);
  const by = Object.fromEntries(r.byCountry.map(c => [c.country, c]));
  assert.deepEqual(Object.keys(by).sort(), ['DE', 'GB', 'NL', 'US']);
  assert.equal(by.GB.orders, 2);
  assert.equal(by.GB.vatCents, rates.vatIncludedCents(3000, 20));
  assert.deepEqual(by.GB.evidence, { match: 1, conflict: 1, 'payer-only': 0, 'ip-only': 0 });
  assert.deepEqual(by.DE.evidence, { match: 0, conflict: 0, 'payer-only': 1, 'ip-only': 1 });
  assert.equal(by.DE.vatCents, rates.vatIncludedCents(3000, 19));
  assert.equal(by.NL.evidence['ip-only'], 1);
  assert.equal(by.US.scheme, 'none');
  assert.equal(by.US.vatCents, 0);
  assert.equal(r.totals.UK.vatCents, by.GB.vatCents);
  assert.equal(r.totals['EU-OSS'].vatCents, by.DE.vatCents + by.NL.vatCents);
  assert.equal(r.totals.none.grossCents, 1500);
  assert.deepEqual(r.unknown, { orders: 1, grossCents: 1500 });
  assert.deepEqual(r.review.map(x => x.evidence).sort(), ['conflict', 'none']);
  assert.equal(r.ratesChecked, rates.RATES_CHECKED);
  assert.throws(() => vat.buildVatReport(db, { quarter: '2027-01' }), /2026Q4/);
});

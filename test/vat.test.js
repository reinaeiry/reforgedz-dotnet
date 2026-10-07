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
  assert.deepEqual(rates.vatFor('mc'), { scheme: 'EU-OSS', rate: 20 }, 'Monaco is in French VAT');
  assert.deepEqual(rates.vatFor('IM'), { scheme: 'UK', rate: 20 }, 'the Isle of Man is in UK VAT');
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

function refund(orderId, cents, at, { kind = 'refund', test = 0, id = null } = {}) {
  db.prepare(`INSERT INTO paypal_refunds (refund_id, order_id, payment_id, amount_cents, currency, kind, source, received_at, test_mode)
              VALUES (?, ?, NULL, ?, 'USD', ?, 'webhook', ?, ?)`).run(id || `R-${orderId}-${at}`, orderId, cents, kind, at, test);
}

test('report: sales in the quarter paid, refunds and reversals in the quarter they happened, single sources reviewed', () => {
  db.prepare('DELETE FROM paypal_refunds').run();
  db.prepare('DELETE FROM orders').run();
  const q = (m, d) => utc(2027, m, d);
  const A = order({ at: q(0, 5), payer: 'GB', ip: 'GB' });                 // match
  const B = order({ at: q(0, 6), payer: 'GB', ip: 'IE' });                 // conflict, filed under PayPal's GB
  const C = order({ at: q(1, 7), ip: 'DE' });                              // checkout only
  const D = order({ at: q(1, 8), payer: 'DE' });                           // PayPal only
  const E = order({ at: q(2, 9), payer: 'US', ip: 'US' });                 // outside both schemes
  const F = order({ at: q(2, 10) });                                       // nothing known
  const G = order({ at: q(0, 11), payer: 'FR', status: 'refunded' });     // staff revoke, money kept: a sale
  db.prepare('UPDATE orders SET revoked_without_refund_at = ? WHERE id = ?').run(q(0, 12), G);
  const H = order({ at: q(0, 12), payer: 'FR', status: 'refunded' });     // refunded, no record: netted here
  const I = order({ at: q(0, 13), payer: 'IT' });
  refund(I, 500, q(1, 1));                                                 // partial refund in the quarter
  const J = order({ at: utc(2026, 11, 20), payer: 'ES', status: 'refunded' }); // sold last quarter
  refund(J, 1500, q(0, 20));                                               // refunded this quarter
  const K = order({ at: q(0, 25), payer: 'NL' });
  refund(K, 1500, q(2, 1), { kind: 'reversal' });                          // a lost chargeback
  order({ at: utc(2026, 10, 1), ip: 'NL', sub: 'I-RENEWS' });               // checkout last quarter
  const R = order({ at: q(1, 1), sub: 'I-RENEWS' });                        // its renewal: checkout's country
  const L = order({ at: q(2, 3), payer: 'MC' });                           // Monaco: French VAT
  const M = order({ at: q(2, 4), payer: 'IM' });                           // Isle of Man: UK VAT
  const N = order({ at: q(0, 14), payer: 'FR', test: 1 });                // sandbox: out
  refund(N, 1500, q(0, 15), { test: 1 });
  refund(null, 700, q(1, 2), { id: 'R-ORPHAN' });                          // a refund with no order
  order({ at: utc(2027, 3, 1), payer: 'FR' });                             // next quarter: out
  refund(A, 1500, utc(2027, 3, 2));                                        // refunded next quarter: not here

  const r = vat.buildVatReport(db, { quarter: '2027Q1' });
  assert.equal(r.orders, 13);
  assert.equal(r.salesCents, 13 * 1500);
  assert.equal(r.refunds, 4, 'the partial refund, the late refund, the reversal and the orphan; sandbox and next quarter left out');
  assert.equal(r.undatedRefunds, 1);
  const by = Object.fromEntries(r.byCountry.map(c => [c.country, c]));
  assert.deepEqual(Object.keys(by).sort(), ['DE', 'ES', 'FR', 'GB', 'IM', 'IT', 'MC', 'NL', 'US']);
  assert.deepEqual([by.GB.orders, by.GB.salesCents, by.GB.netCents, by.GB.vatCents], [2, 3000, 3000, rates.vatIncludedCents(3000, 20)]);
  assert.deepEqual(by.GB.evidence, { match: 1, conflict: 1, 'payer-only': 0, 'ip-only': 0 });
  assert.deepEqual(by.DE.evidence, { match: 0, conflict: 0, 'payer-only': 1, 'ip-only': 1 });
  assert.deepEqual([by.FR.orders, by.FR.salesCents, by.FR.refundCents, by.FR.netCents], [2, 3000, 1500, 1500]);
  assert.deepEqual([by.IT.refundCents, by.IT.netCents, by.IT.vatCents], [500, 1000, rates.vatIncludedCents(1000, 22)]);
  assert.deepEqual([by.ES.orders, by.ES.salesCents, by.ES.refundCents, by.ES.netCents], [0, 0, 1500, -1500]);
  assert.ok(by.ES.vatCents < 0, 'a refund of an earlier quarter is a negative correction');
  assert.deepEqual([by.NL.orders, by.NL.salesCents, by.NL.refundCents, by.NL.netCents], [2, 3000, 1500, 1500]);
  assert.equal(by.NL.evidence['ip-only'], 1, 'the renewal takes its checkout country');
  assert.deepEqual([by.MC.scheme, by.MC.rate], ['EU-OSS', 20]);
  assert.deepEqual([by.IM.scheme, by.IM.rate], ['UK', 20]);
  assert.equal(by.US.scheme, 'none');
  assert.equal(by.US.vatCents, 0);
  assert.equal(r.totals.UK.vatCents, by.GB.vatCents + by.IM.vatCents);
  assert.equal(r.totals['EU-OSS'].vatCents, ['DE', 'ES', 'FR', 'IT', 'MC', 'NL'].reduce((s, k) => s + by[k].vatCents, 0));
  assert.deepEqual(r.unknown, { orders: 1, salesCents: 1500, refundCents: 700 });
  const reviewed = new Set(r.review.map(x => x.orderId));
  for (const id of [B, C, D, F, G, H, I, K, R, L, M]) assert.ok(reviewed.has(id), `order ${id} needs review`);
  for (const id of [A, E]) assert.ok(!reviewed.has(id), `order ${id} has two matching sources`);
  assert.ok(r.review.some(x => x.evidence === 'refund-without-order'));
  assert.equal(r.ratesChecked, rates.RATES_CHECKED);
  assert.throws(() => vat.buildVatReport(db, { quarter: '2027-01' }), /2026Q4/);
});

test('report: the value excluding VAT, and each return in its own currency', () => {
  db.prepare('DELETE FROM paypal_refunds').run();
  db.prepare('DELETE FROM orders').run();
  const q = (m, d) => utc(2027, m, d);
  order({ at: q(0, 5), payer: 'DE', ip: 'DE' });
  order({ at: q(1, 5), payer: 'DE', ip: 'DE' });
  order({ at: q(0, 6), payer: 'GB', ip: 'GB' });                 // January
  const feb = order({ at: q(1, 6), payer: 'GB', ip: 'GB' });     // February
  refund(feb, 500, q(2, 2));                                     // refunded in March
  order({ at: q(2, 7), payer: 'US', ip: 'US' });

  const plain = vat.buildVatReport(db, { quarter: '2027Q1' });
  const by = Object.fromEntries(plain.byCountry.map(c => [c.country, c]));
  assert.equal(by.DE.exclusiveCents, by.DE.netCents - by.DE.vatCents);
  assert.equal(by.DE.exclusiveCents, 3000 - rates.vatIncludedCents(3000, 19));
  assert.equal(plain.totals.UK.exclusiveCents, by.GB.exclusiveCents);
  assert.equal(by.DE.returnFigures, null, 'no rate given: no euro figures');
  assert.deepEqual(plain.returnTotals, { 'EU-OSS': null, UK: null });

  const r = vat.buildVatReport(db, {
    quarter: '2027Q1', eurPerUsd: 0.9,
    gbpPerUsdByMonth: { '2027-01': 0.8, '2027-02': 0.75, '2027-03': 0.7 }
  });
  const de = r.byCountry.find(c => c.country === 'DE');
  assert.deepEqual(de.returnFigures, {
    currency: 'EUR',
    exclusiveCents: Math.round(de.exclusiveCents * 0.9),
    vatCents: Math.round(de.vatCents * 0.9)
  });
  // UK: 1500 at 0.80 (Jan) + 1500 at 0.75 (Feb) - a 500 refund at 0.70 (Mar) = 1200 + 1125 - 350 = 1975 pence.
  const gb = r.byCountry.find(c => c.country === 'GB');
  const vatGbp = rates.vatIncludedCents(1975, 20);
  assert.deepEqual(gb.returnFigures, { currency: 'GBP', exclusiveCents: 1975 - vatGbp, vatCents: vatGbp });
  assert.deepEqual(r.returnTotals.UK, { currency: 'GBP', exclusiveCents: 1975 - vatGbp, vatCents: vatGbp });
  assert.deepEqual(r.returnTotals['EU-OSS'], { currency: 'EUR', exclusiveCents: de.returnFigures.exclusiveCents, vatCents: de.returnFigures.vatCents });
  assert.equal(r.byCountry.find(c => c.country === 'US').returnFigures, null, 'outside both schemes');

  assert.throws(() => vat.buildVatReport(db, { quarter: '2027Q1', gbpPerUsdByMonth: { '2027-01': 0.8, '2027-03': 0.7 } }),
    e => e.code === 'BAD_INPUT' && /2027-02/.test(e.message), 'a month without a rate is refused, never counted as 0');
  for (const bad of [0, -1, 12, NaN, '0.9']) {
    assert.throws(() => vat.buildVatReport(db, { quarter: '2027Q1', eurPerUsd: bad }), e => e.code === 'BAD_INPUT', String(bad));
  }
  assert.throws(() => vat.buildVatReport(db, { quarter: '2027Q1', gbpPerUsdByMonth: { 'Jan': 0.8 } }), e => e.code === 'BAD_INPUT');
});

test('report query: rates read from plain text only; anything else is a 400, not a 500', () => {
  assert.deepEqual(vat.parseReportQuery({}), { eurPerUsd: null, gbpPerUsdByMonth: null });
  assert.deepEqual(vat.parseReportQuery({ eurPerUsd: '0.86', gbp: '2027-01:0.79, 2027-02:0.8' }),
    { eurPerUsd: 0.86, gbpPerUsdByMonth: { '2027-01': 0.79, '2027-02': 0.8 } });
  assert.deepEqual(vat.parseReportQuery({ eurPerUsd: '', gbp: '' }), { eurPerUsd: null, gbpPerUsdByMonth: null });
  // What Express makes of ?gbp[toString]=1, ?eurPerUsd=1&eurPerUsd=2 and a malformed list.
  for (const q of [{ gbp: { toString: '1' } }, { eurPerUsd: ['1', '2'] }, { gbp: '2027-01' }, { gbp: '2027-01:0.8:1' }]) {
    assert.throws(() => vat.parseReportQuery(q), e => e.code === 'BAD_INPUT', JSON.stringify(q));
  }
  // Parsed but not a rate: refused by the report itself.
  assert.throws(() => vat.buildVatReport(db, { quarter: '2027Q1', ...vat.parseReportQuery({ eurPerUsd: 'abc' }) }), e => e.code === 'BAD_INPUT');
});

// ---- Backfill -------------------------------------------------------------------------

test('backfill windows are at most 31 days, cover the span exactly, oldest first', () => {
  const start = utc(2026, 4, 1);
  const end = utc(2026, 9, 7);
  const w = vat.windowsBetween(start, end);
  assert.equal(w[0].start, start);
  assert.equal(w.at(-1).end, end);
  for (let i = 0; i < w.length; i++) {
    assert.ok(w[i].end - w[i].start <= 31 * 86400);
    if (i) assert.equal(w[i].start, w[i - 1].end, 'no gap and no overlap');
  }
  assert.deepEqual(vat.windowsBetween(end, end), []);
});

test('a dry run counts the rows a real run would fill and writes nothing', async () => {
  const g = order({ at: utc(2026, 9, 6), capture: 'CAP-G' });
  const pp = fakePayPal([[tx('CAP-G', 'AT')]]);
  const dry = await vat.fillPayerCountries({ db, paypal: pp, start: utc(2026, 9, 5), end: utc(2026, 9, 7), dryRun: true, logger: silent });
  assert.equal(dry.filled, 1);
  assert.equal(dry.dryRun, true);
  assert.equal(countryOf(g), null);
  const real = await vat.fillPayerCountries({ db, paypal: pp, start: utc(2026, 9, 5), end: utc(2026, 9, 7), logger: silent });
  assert.equal(real.filled, 1);
  assert.equal(countryOf(g), 'AT');
});

test('the backfill command needs a start date; --apply is the only way to write', () => {
  const { parseArgs } = require('../tools/vatBackfill');
  assert.deepEqual(parseArgs(['--from', '2026-05-01']), { from: '2026-05-01', apply: false, fromUnix: utc(2026, 4, 1) });
  assert.equal(parseArgs(['--from', '2026-05-01', '--apply']).apply, true);
  assert.equal(parseArgs(['--from', 'May']).fromUnix, null);
  assert.equal(parseArgs([]).fromUnix, null);
});

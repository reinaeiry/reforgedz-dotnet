// Tests for the daily PayPal reconciliation (tools/reconcile.js) and its card
// (paymentCards.unbookedPaymentsCard) against the REAL schema: db.js is loaded with
// DATA_DIR pointed at a throwaway folder, so every migration runs as it will on the
// live database. PayPal and Discord are fakes: nothing is fetched or posted. Needs
// better-sqlite3, so run it where the shop's node_modules are.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-reconcile-'));
process.env.DATA_DIR = dataDir;
delete process.env.PAYMENTS_ALERT_ROLE_ID;
// scheduleDailyReconcile is called below; switched off, it never arms a timer.
process.env.RECONCILE = 'off';

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const reconcile = require('../tools/reconcile');
const cards = require('../paymentCards');
const { buildCard, KIND_COLORS } = require('../tools/lib/discordCard');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const NOW = 1800000000; // 2027-01-15 08:00:00 UTC
const HOUR = 3600;
const DAY = 86400;
const iso = (unix) => new Date(unix * 1000).toISOString().replace(/\.\d+Z$/, '+0000');
const PAYER_RE = /example\.invalid|Patricia|Payerson|note from the payer|payer_info|email/i;

let seq = 0;
const txnId = () => `TX${String(++seq).padStart(15, '0')}`;

// A Transaction Search row. payer_info and the subject are filled in to prove
// nothing reads them.
function txn(id, { code = 'T0002', status = 'S', value = '15.00', currency = 'USD', at = NOW - DAY, ref = null, refType = 'RP', invoice = null, custom = null } = {}) {
  return {
    transaction_info: {
      transaction_id: id,
      transaction_event_code: code,
      transaction_status: status,
      transaction_initiation_date: iso(at),
      transaction_updated_date: iso(at),
      transaction_amount: { currency_code: currency, value },
      transaction_subject: 'A note from the payer',
      ...(ref ? { paypal_reference_id: ref, paypal_reference_id_type: refType } : {}),
      ...(invoice ? { invoice_id: invoice } : {}),
      ...(custom != null ? { custom_field: String(custom) } : {})
    },
    payer_info: {
      email_address: 'payer.person@example.invalid',
      payer_name: { given_name: 'Patricia', surname: 'Payerson' }
    }
  };
}

// A fake PayPal client serving the given pages. Records every call.
function fakePayPal(pages, { configured = true, failOnPage = null, totalPages = null, badPage = null } = {}) {
  const calls = [];
  return {
    calls,
    isConfigured(testMode) { calls.push({ isConfigured: testMode }); return configured; },
    async searchTransactions(testMode, opts) {
      calls.push({ testMode, ...opts });
      if (opts.page === failOnPage) { const e = new Error('paypal 503: Service Unavailable'); e.status = 503; throw e; }
      if (opts.page === badPage) return { total_pages: pages.length };
      return {
        transaction_details: pages[opts.page - 1] || [],
        total_items: pages.flat().length,
        total_pages: totalPages != null ? totalPages : pages.length,
        page: opts.page,
        last_refreshed_datetime: iso(NOW - 2 * HOUR)
      };
    }
  };
}
const searches = (pp) => pp.calls.filter(c => c.page != null);

function poster(result = { ok: true, status: 200, messageId: '1' }) {
  const specs = [];
  const fn = async (spec) => {
    specs.push(spec);
    if (result instanceof Error) throw result;
    return result;
  };
  fn.specs = specs;
  return fn;
}

function logger() {
  const lines = [];
  const push = (...a) => lines.push(a.join(' '));
  return { lines, log: push, warn: push, error: push };
}

const run = (pp, extra = {}) => reconcile.runReconcile({ db, paypal: pp, now: NOW, post: poster(), logger: logger(), ...extra });

const PRODUCT = db.prepare("INSERT INTO products (title, price_cents, type, grants_priority_queue, server_specific) VALUES ('Priority Queue', 1500, 'subscription', 1, 1)").run().lastInsertRowid;
let users = 0;
function order({ capture, sub = null }) {
  users += 1;
  const steam = `7656119${String(users).padStart(10, '0')}`;
  db.prepare('INSERT INTO users (steam_id, persona) VALUES (?, ?)').run(steam, `Player${users}`);
  return db.prepare(`
    INSERT INTO orders (steam_id, product_id, server_id, status, amount_cents, test_mode, paypal_subscription_id, paypal_capture_id, created_at, completed_at)
    VALUES (?, ?, 'eu1', 'completed', 1500, 0, ?, ?, ?, ?)
  `).run(steam, PRODUCT, sub, capture, NOW - 2 * DAY, NOW - 2 * DAY).lastInsertRowid;
}
const seenRows = (ids) => ids.filter(id => db.prepare('SELECT 1 FROM reconcile_seen WHERE transaction_id = ?').get(id)).length;

test('the migration adds reconcile_seen, keyed on the PayPal transaction id', () => {
  const cols = db.prepare('PRAGMA table_info(reconcile_seen)').all();
  assert.deepEqual(cols.map(c => c.name), ['transaction_id', 'reported_at']);
  assert.equal(cols.find(c => c.name === 'transaction_id').pk, 1);
  assert.equal(cols.find(c => c.name === 'reported_at').notnull, 1);
  const manifest = require('../tools/lib/envManifest');
  assert.ok(manifest.byName.has('RECONCILE'));
  assert.match(manifest.renderExample(), /^RECONCILE=$/m);
});

test('asks live PayPal for three days up to six hours ago, 500 successful transactions a page, with no payer details', async () => {
  const pp = fakePayPal([[]]);
  const post = poster();
  const out = await run(pp, { post });
  assert.equal(out.ok, true);
  assert.equal(searches(pp).length, 1);
  const [call] = searches(pp);
  assert.equal(call.testMode, false);
  assert.equal(call.page, 1);
  assert.equal(call.pageSize, 500);
  assert.equal(call.transactionStatus, 'S');
  assert.equal(call.fields, 'transaction_info');
  assert.equal(call.start, (NOW - 3 * DAY) * 1000);
  assert.equal(call.end, (NOW - 6 * HOUR) * 1000);
  assert.ok(call.end - call.start <= 31 * DAY * 1000, 'inside the 31-day Transaction Search limit');
  assert.deepEqual(pp.calls.filter(c => 'isConfigured' in c).map(c => c.isConfigured), [false]);
  assert.equal(post.specs.length, 0, 'nothing to report, so no card');
  assert.equal(out.lastRefreshed, iso(NOW - 2 * HOUR));
});

test('paypal.searchTransactions builds the Transaction Search query and throws when PayPal fails', async (t) => {
  const paypal = require('../paypal');
  const saved = { fetch: globalThis.fetch, id: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_SECRET };
  t.after(() => {
    globalThis.fetch = saved.fetch;
    if (saved.id === undefined) delete process.env.PAYPAL_CLIENT_ID; else process.env.PAYPAL_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.PAYPAL_SECRET; else process.env.PAYPAL_SECRET = saved.secret;
  });
  process.env.PAYPAL_CLIENT_ID = 'fake-client';
  process.env.PAYPAL_SECRET = 'fake-secret';
  const urls = [];
  let searchReply = { ok: true, status: 200, body: { transaction_details: [], total_pages: 1 } };
  const reply = ({ ok, status, body }) => ({ ok, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  // No network: a fake stands in for fetch and refuses anything unexpected.
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.endsWith('/v1/oauth2/token')) return reply({ ok: true, status: 200, body: { access_token: 'fake-token', expires_in: 3600 } });
    if (u.includes('/v1/reporting/transactions?')) return reply(searchReply);
    throw new Error(`unexpected request ${u}`);
  };

  const res = await paypal.searchTransactions(false, { start: (NOW - 3 * DAY) * 1000, end: (NOW - 6 * HOUR) * 1000, page: 2 });
  assert.deepEqual(res, { transaction_details: [], total_pages: 1 });
  const q = new URL(urls.find(u => u.includes('/v1/reporting/transactions?'))).searchParams;
  assert.equal(q.get('start_date'), '2027-01-12T08:00:00-0000');
  assert.equal(q.get('end_date'), '2027-01-15T02:00:00-0000');
  assert.equal(q.get('fields'), 'transaction_info');
  assert.equal(q.get('page_size'), '500');
  assert.equal(q.get('page'), '2');
  assert.equal(q.get('transaction_status'), 'S');

  searchReply = { ok: false, status: 503, body: { message: 'Service Unavailable' } };
  await assert.rejects(paypal.searchTransactions(false, { start: 0, end: 1000 }), /paypal 503/);
});

test('reads every page and reports what nothing in the shop books, in one red card', async () => {
  const booked = txnId();
  order({ capture: booked, sub: 'I-BOOKED1' });
  const a = txnId();
  const b = txnId();
  const c = txnId();
  const pp = fakePayPal([
    [txn(booked, { ref: 'I-BOOKED1', at: NOW - 30 * HOUR }), txn(a, { ref: 'I-UNBOOKEDA1', at: NOW - 20 * HOUR })],
    [txn(b, { code: 'T0006', value: '10.00', at: NOW - 50 * HOUR, custom: 42 })],
    [txn(c, { at: NOW - 10 * HOUR, invoice: 'INV-7' })]
  ]);
  const post = poster();
  const out = await run(pp, { post });
  assert.deepEqual(searches(pp).map(x => x.page), [1, 2, 3]);
  assert.equal(out.ok, true);
  assert.equal(out.pages, 3);
  assert.equal(out.rows, 4);
  assert.equal(out.incoming, 4);
  assert.equal(out.booked.order, 1);
  assert.deepEqual(out.unbooked.map(p => p.transactionId), [b, a, c], 'oldest first');
  assert.equal(post.specs.length, 1);
  assert.equal(post.specs[0].kind, 'action');
  assert.equal(post.specs[0].what, '3 PayPal payments the shop never booked');
  assert.equal(out.posted.ok, true);
  assert.equal(out.reported, 3);
  assert.equal(seenRows([a, b, c]), 3);
  assert.equal(seenRows([booked]), 0);
  assert.equal(db.prepare('SELECT reported_at FROM reconcile_seen WHERE transaction_id = ?').get(a).reported_at, NOW);
});

test('a payment the shop accounts for anywhere is not reported', async () => {
  const sale = txnId();
  const capture = txnId();
  const revoked = txnId();
  const unmatched = txnId();
  const refunded = txnId();
  const disputed = txnId();
  const loose = txnId();
  const subOrder = order({ capture: sale, sub: 'I-ACCOUNTED1' });
  order({ capture });
  db.prepare('INSERT INTO revoked_renewals (sale_id, subscription_id, amount_cents, received_at) VALUES (?, ?, 1500, ?)').run(revoked, 'I-ACCOUNTED2', NOW - DAY);
  db.prepare("INSERT INTO unmatched_sales (sale_id, subscription_id, amount_cents, currency, received_at) VALUES (?, ?, 1500, 'USD', ?)").run(unmatched, 'I-ACCOUNTED3', NOW - DAY);
  db.prepare("INSERT INTO paypal_refunds (refund_id, order_id, payment_id, amount_cents, currency, kind, source, received_at) VALUES (?, NULL, ?, 1500, 'USD', 'refund', 'webhook', ?)").run(`RF-${refunded}`, refunded, NOW - DAY);
  db.prepare("INSERT INTO paypal_disputes (dispute_id, order_id, payment_id, status, created_at, updated_at) VALUES (?, ?, ?, 'OPEN', ?, ?)").run(`PP-D-${disputed}`, subOrder, disputed, NOW - DAY, NOW - DAY);
  const ids = [sale, capture, revoked, unmatched, refunded, disputed, loose];
  const pp = fakePayPal([ids.map((id, i) => txn(id, { code: id === capture ? 'T0006' : 'T0002', at: NOW - (10 + i) * HOUR }))]);
  const post = poster();
  const out = await run(pp, { post });
  assert.deepEqual(out.booked, { order: 2, revoked_renewal: 1, unmatched_sale: 1, refund: 1, dispute: 1 });
  assert.deepEqual(out.unbooked.map(p => p.transactionId), [loose]);
  assert.equal(post.specs.length, 1);
  assert.equal(post.specs[0].what, 'PayPal payment the shop never booked');
  assert.equal(seenRows(ids), 1);
});

test('only successful money received counts: spending, holds, releases, cashback, refunds and pending payments do not', async () => {
  const inGeneral = txnId();
  const inCheckout = txnId();
  const noise = [
    txn(txnId(), { code: 'T0003', value: '-493.36' }),
    txn(txnId(), { code: 'T0000', value: '-70.87' }),
    txn(txnId(), { code: 'T0500', value: '-22.48' }),
    txn(txnId(), { code: 'T1105', value: '23.04' }),
    txn(txnId(), { code: 'T0801', value: '0.32' }),
    txn(txnId(), { code: 'T1111', value: '42.94' }),
    txn(txnId(), { code: 'T1107', value: '-15.00' }),
    txn(txnId(), { code: 'T0200', value: '5.00' }),
    txn(txnId(), { code: 'T0002', status: 'P' }),
    txn(txnId(), { code: 'T0002', status: 'V' }),
    txn(txnId(), { code: 'T0006', value: '0.00' }),
    { transaction_info: { transaction_event_code: 'T0002', transaction_status: 'S', transaction_amount: { value: '15.00', currency_code: 'USD' } } },
    {}
  ];
  const pp = fakePayPal([[...noise, txn(inGeneral, { code: 'T0000', value: '5.00' }), txn(inCheckout, { code: 'T0006', value: '10.00', at: NOW - 2 * DAY })]]);
  const out = await run(pp);
  assert.equal(out.incoming, 2);
  assert.deepEqual(out.unbooked.map(p => p.transactionId), [inCheckout]);
  assert.deepEqual(out.otherIncoming.map(p => p.transactionId), [inGeneral], 'money received that is not a sale is listed apart');
  assert.equal(reconcile.isIncomingPayment(null), false);
  assert.equal(reconcile.isIncomingPayment(txn('X', { code: 'T00022' })), false);
});

test('each payment is reported once: a repeat on another page, the next run, and a new payment later', async () => {
  const a = txnId();
  const d = txnId();
  const pages = [[txn(a)], [txn(a), txn(txnId(), { code: 'T1105', value: '1.00' })]];

  const first = poster();
  const out1 = await run(fakePayPal(pages), { post: first });
  assert.deepEqual(out1.unbooked.map(p => p.transactionId), [a]);
  assert.equal(first.specs.length, 1);
  assert.equal((first.specs[0].description.match(new RegExp(a, 'g')) || []).length, 1, 'listed once');

  const second = poster();
  const out2 = await run(fakePayPal(pages), { post: second, now: NOW + DAY });
  assert.equal(second.specs.length, 0);
  assert.deepEqual(out2.unbooked, []);
  assert.deepEqual(out2.alreadyReported.map(p => [p.transactionId, p.reportedAt]), [[a, NOW]]);

  const third = poster();
  const out3 = await run(fakePayPal([[txn(a), txn(d)]]), { post: third, now: NOW + 2 * DAY });
  assert.deepEqual(out3.unbooked.map(p => p.transactionId), [d]);
  assert.equal(third.specs.length, 1);
  assert.doesNotMatch(third.specs[0].description, new RegExp(a));
});

test('a dry run posts nothing and writes nothing, and a real run still reports afterwards', async () => {
  const a = txnId();
  const b = txnId();
  const pages = [[txn(a), txn(b, { at: NOW - 2 * DAY })]];
  const before = db.prepare('SELECT * FROM reconcile_seen ORDER BY transaction_id').all();
  const post = poster();
  const dry = await run(fakePayPal(pages), { post, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.ok, true);
  assert.deepEqual(dry.unbooked.map(p => p.transactionId), [b, a]);
  assert.equal(post.specs.length, 0);
  assert.equal(dry.posted, null);
  assert.equal(dry.reported, 0);
  assert.deepEqual(db.prepare('SELECT * FROM reconcile_seen ORDER BY transaction_id').all(), before);

  const preview = reconcile.previewOf(dry);
  assert.equal(preview.wouldReport, 2);
  assert.deepEqual(Object.keys(preview).sort(), ['alreadyReported', 'booked', 'error', 'incoming', 'lastRefreshed', 'ok', 'otherIncoming', 'pages', 'skipped', 'unbooked', 'windowEnd', 'windowStart', 'wouldReport']);
  assert.doesNotMatch(JSON.stringify(preview), PAYER_RE);

  const real = poster();
  const out = await run(fakePayPal(pages), { post: real });
  assert.equal(real.specs.length, 1);
  assert.equal(out.reported, 2);
});

test('a card Discord did not take is not recorded, so the next run reports it again', async () => {
  const a = txnId();
  const pages = [[txn(a)]];
  for (const result of [{ ok: false, status: 500 }, { ok: false, status: 0, skipped: 'no webhook' }, new Error('network down')]) {
    const log = logger();
    const out = await run(fakePayPal(pages), { post: poster(result), logger: log });
    assert.equal(out.ok, true);
    assert.equal(out.posted.ok, false);
    assert.equal(out.reported, 0);
    assert.equal(seenRows([a]), 0);
    assert.match(log.lines.join('\n'), /not posted/);
  }
  const ok = poster();
  const out = await run(fakePayPal(pages), { post: ok });
  assert.equal(ok.specs.length, 1);
  assert.equal(out.posted.ok, true);
  assert.equal(seenRows([a]), 1);
});

test('a PayPal failure on any page checks and reports nothing', async () => {
  const a = txnId();
  const cases = [
    { pp: fakePayPal([[txn(a)], [txn(txnId())]], { failOnPage: 2 }), error: /503/ },
    { pp: fakePayPal([[txn(a)], []], { badPage: 2 }), error: /without a transaction list/ },
    { pp: fakePayPal([[txn(a)]], { totalPages: reconcile.MAX_PAGES + 1 }), error: /more than the 20/ }
  ];
  for (const c of cases) {
    const post = poster();
    const log = logger();
    const out = await run(c.pp, { post, logger: log });
    assert.equal(out.ok, false);
    assert.match(out.error, c.error);
    assert.deepEqual(out.unbooked, []);
    assert.equal(post.specs.length, 0);
    assert.equal(seenRows([a]), 0);
    assert.match(log.lines.join('\n'), /no payment was checked or reported/);
  }
  assert.equal(searches(cases[2].pp).length, 1, 'stops before reading past the page limit');
});

test('with no live PayPal credentials nothing is asked, posted or recorded', async () => {
  const pp = fakePayPal([[txn(txnId())]], { configured: false });
  const post = poster();
  const out = await run(pp, { post });
  assert.equal(out.skipped, 'live PayPal is not configured');
  assert.equal(out.ok, false);
  assert.equal(searches(pp).length, 0);
  assert.equal(post.specs.length, 0);
});

test('the card shows amount, time and PayPal references, and never the payer', async () => {
  const sub = txnId();
  const chk = txnId();
  const pp = fakePayPal([[
    txn(sub, { ref: 'I-TEST00000001', at: NOW - 30 * HOUR }),
    txn(chk, { code: 'T0006', value: '12.50', currency: 'EUR', custom: 721, invoice: 'INV-0042', ref: '5TY0000000', refType: 'TXN', at: NOW - 20 * HOUR })
  ]]);
  const post = poster();
  const log = logger();
  await run(pp, { post, logger: log });
  const body = buildCard(post.specs[0]);
  const embed = body.embeds[0];
  assert.equal(embed.color, KIND_COLORS.action);
  assert.equal(embed.title, '2 PayPal payments the shop never booked');
  assert.equal(embed.url, undefined, 'no single order to link');
  assert.equal(body.flags, undefined, 'a red card is not silent');
  assert.ok(embed.description.includes(`\`${sub}\` $15.00, <t:${NOW - 30 * HOUR}:f>, Subscription payment, subscription \`I-TEST00000001\``));
  assert.ok(embed.description.includes(`\`${chk}\` 12.50 EUR, <t:${NOW - 20 * HOUR}:f>, Checkout payment, invoice \`INV-0042\`, order #721 named by PayPal`));
  assert.doesNotMatch(embed.description, /5TY0000000/, 'a reference that is not a subscription is not shown');
  const field = (name) => embed.fields.find(f => f.name === name);
  assert.equal(field('Payments').value, '2');
  assert.equal(field('Total').value, '$15.00 + 12.50 EUR');
  assert.equal(field('Checked').value, `<t:${NOW - 3 * DAY}:f> to <t:${NOW - 6 * HOUR}:f>`);
  assert.doesNotMatch(JSON.stringify(body) + log.lines.join('\n'), PAYER_RE);
  assert.doesNotMatch(JSON.stringify(body), /[–—]|dayz/i);
});

test('a long list stops at 20 lines and says how many more', () => {
  const payments = Array.from({ length: 25 }, (_, i) => ({ transactionId: `TXLONG${i}`, code: 'T0002', amountCents: 1500, currency: 'USD', at: NOW - i * HOUR }));
  const spec = cards.unbookedPaymentsCard({ payments });
  assert.equal(spec.what, '25 PayPal payments the shop never booked');
  assert.equal((spec.description.match(/`TXLONG\d+`/g) || []).length, cards.UNBOOKED_LIST_MAX);
  assert.match(spec.description, /and 5 more/);
  assert.equal(spec.fields.find(f => f.name === 'Total').value, '$375.00');
  const body = buildCard(spec);
  assert.ok(JSON.stringify(body.embeds[0]).length < 6000);

  const bare = cards.unbookedPaymentsCard({ payments: [{ transactionId: 'TXNOAMOUNT', amountCents: null }] });
  assert.equal(bare.what, 'PayPal payment the shop never booked');
  assert.equal(bare.fields.find(f => f.name === 'Total').value, 'Not given by PayPal');
  assert.match(bare.description, /`TXNOAMOUNT` amount not given, time not given/);
});

test('paymentOf keeps only what a staff card may show', () => {
  const p = reconcile.paymentOf(txn('TXPARTS', { value: '15.00', ref: 'I-ABC123', custom: ' 17 ', invoice: 'INV-1', at: NOW }));
  assert.deepEqual(p, { transactionId: 'TXPARTS', code: 'T0002', amountCents: 1500, currency: 'USD', at: NOW, subscriptionId: 'I-ABC123', invoiceId: 'INV-1', orderId: 17 });
  assert.equal(reconcile.paymentOf(txn('X', { custom: 'player@example.invalid' })).orderId, null);
  assert.equal(reconcile.paymentOf(txn('X', { custom: '0' })).orderId, null);
  assert.equal(reconcile.paymentOf(txn('X', { ref: 'PAYID-ABC', refType: 'TXN' })).subscriptionId, null);
  assert.doesNotMatch(JSON.stringify(reconcile.paymentOf(txn('X'))), PAYER_RE);
});

test('RECONCILE=off switches it off, runs are due at 08:30 UTC, and scheduling twice arms one thing', () => {
  for (const v of ['off', 'OFF', ' 0 ', 'false']) assert.equal(reconcile.reconcileOff({ RECONCILE: v }), true, v);
  for (const v of ['', 'on', '1', undefined]) assert.equal(reconcile.reconcileOff({ RECONCILE: v }), false, String(v));
  assert.equal(reconcile.nextRunAt(Date.UTC(2027, 0, 15, 8, 0, 0)), Date.UTC(2027, 0, 15, 8, 30, 0) / 1000);
  assert.equal(reconcile.nextRunAt(Date.UTC(2027, 0, 15, 8, 30, 0)), Date.UTC(2027, 0, 16, 8, 30, 0) / 1000);
  assert.equal(reconcile.nextRunAt(Date.UTC(2027, 0, 31, 23, 59, 0)), Date.UTC(2027, 1, 1, 8, 30, 0) / 1000);

  const lines = [];
  const saved = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    reconcile.scheduleDailyReconcile();
    reconcile.scheduleDailyReconcile();
  } finally {
    console.log = saved;
  }
  assert.deepEqual(lines, ['[reconcile] the daily PayPal check is off (RECONCILE)']);
  assert.equal(reconcile.lastReconcileRun(), null);
});

test('money received that is not shaped like a shop sale is never posted or recorded, and the preview still lists it', async () => {
  const bare = txnId();
  const withSub = txnId();
  const withCustom = txnId();
  const withInvoice = txnId();
  const pages = [[
    txn(bare, { code: 'T0000', value: '50.00', at: NOW - 40 * HOUR }),
    txn(withSub, { code: 'T0000', ref: 'I-TEST00000003', at: NOW - 30 * HOUR }),
    txn(withCustom, { code: 'T0011', custom: 58, at: NOW - 20 * HOUR }),
    txn(withInvoice, { code: 'T0000', invoice: 'INV-9', at: NOW - 10 * HOUR })
  ]];
  const post = poster();
  const out = await run(fakePayPal(pages), { post });
  assert.deepEqual(out.unbooked.map(p => p.transactionId), [withSub, withCustom, withInvoice]);
  assert.deepEqual(out.otherIncoming.map(p => p.transactionId), [bare]);
  assert.equal(post.specs.length, 1);
  assert.doesNotMatch(post.specs[0].description, new RegExp(bare));
  assert.doesNotMatch(post.specs[0].description, /\$50\.00/);
  assert.equal(seenRows([bare]), 0);
  assert.equal(seenRows([withSub, withCustom, withInvoice]), 3);

  const onlyOther = poster();
  const quiet = await run(fakePayPal([[txn(txnId(), { code: 'T0000', value: '20.00' })]]), { post: onlyOther, now: NOW + DAY });
  assert.equal(onlyOther.specs.length, 0);
  assert.equal(quiet.otherIncoming.length, 1);
  assert.equal(reconcile.previewOf(quiet).otherIncoming.length, 1);
  assert.equal(reconcile.isShopPayment({ code: 'T0002' }), true);
  assert.equal(reconcile.isShopPayment({ code: 'T0006' }), true);
  assert.equal(reconcile.isShopPayment({ code: 'T0000' }), false);
  assert.equal(reconcile.isShopPayment(null), false);
});

test('a first payment the shop never attached to its active order is listed apart from money that bought nothing', async () => {
  const firstSale = txnId();
  const stray = txnId();
  const active = order({ capture: null, sub: 'I-TEST00000004' });
  const pp = fakePayPal([[
    txn(firstSale, { ref: 'I-TEST00000004', at: NOW - 40 * HOUR }),
    txn(stray, { ref: 'I-TEST00000005', at: NOW - 20 * HOUR })
  ]]);
  const post = poster();
  const out = await run(pp, { post });
  assert.deepEqual(out.unbooked.map(p => [p.transactionId, p.unattachedOrderId]), [[firstSale, active], [stray, null]]);
  const spec = post.specs[0];
  assert.equal(spec.kind, 'action');
  const [unbookedPart, unattachedPart] = spec.description.split('These paid for an order');
  assert.match(unbookedPart, new RegExp(stray));
  assert.doesNotMatch(unbookedPart, new RegExp(firstSale));
  assert.match(unattachedPart, new RegExp(`\`${firstSale}\`.*order #${active} is active but this payment was never attached to it`));
  assert.match(unattachedPart, /do not set up another order/i);

  const only = cards.unbookedPaymentsCard({ payments: [out.unbooked[0]] });
  assert.equal(only.kind, 'attention');
  assert.doesNotMatch(only.description, /Nothing was granted|set the order up by hand/);

  // A later cycle's payment on that subscription bought a cycle nobody booked.
  const later = txnId();
  const out2 = await run(fakePayPal([[txn(later, { ref: 'I-TEST00000004', at: NOW + 25 * DAY })]]), { post: poster(), now: NOW + 26 * DAY });
  assert.deepEqual(out2.unbooked.map(p => [p.transactionId, p.unattachedOrderId]), [[later, null]]);
});

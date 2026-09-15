// Tests for the daily health card (tools/healthReport.js): warnings staff have
// accepted, the money lines (against the REAL schema: db.js on a throwaway
// DATA_DIR), active entitlements counted per server, the PayPal check's status and
// the manual-run marker. Nothing runs the doctor or posts. Needs better-sqlite3, so
// run it where the shop's node_modules are.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-health-'));
process.env.DATA_DIR = dataDir;
delete process.env.PAYMENTS_ALERT_ROLE_ID;
delete process.env.HEALTH_PARKED_WARNINGS;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const health = require('../tools/healthReport');
const { buildCard, serverLabel, KIND_COLORS, SUPPRESS_NOTIFICATIONS } = require('../tools/lib/discordCard');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const NOW = 1800000000; // 2027-01-15 08:00:00 UTC
const HOUR = 3600;
const DAY = 86400;

// A doctor paypal.live warning that names one other webhook on the app (fake ids).
const STRAY = 'live: webhook 7S000000000000000 bound with all 17 events; other webhooks on this app: https://discord.com/api/webhooks/150000000000000000/…';

const BASE = [
  { id: 'db.file', status: 'ok', detail: 'integrity ok, journal wal, 10 users, 20 orders, 12 live completed orders' },
  { id: 'billing.issues', status: 'ok', detail: 'no open billing issues' },
  { id: 'backup.local', status: 'ok', detail: '5.0 h ago, 1000 bytes, 7 daily kept' }
];
function report(extra = [], base = BASE) {
  const checks = [...base, ...extra];
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status] += 1;
  return { version: 'abc1234def5678', summary, checks, ok: summary.fail === 0 };
}
const fieldOf = (spec, name) => spec.fields.find(f => f.name === name);

// An example HEALTH_PARKED_WARNINGS setting that parks exactly that warning, with
// one other webhook and nothing more.
const PARKED = health.parkedWarningsFrom({
  HEALTH_PARKED_WARNINGS: JSON.stringify([{
    check: 'paypal.live',
    match: 'live: webhook \\S+ bound with all \\d+ events; other webhooks on this app: https://discord[.]com/api/webhooks/[^,]+',
    note: 'An extra webhook the owner has accepted. Delete it in PayPal to clear this line.'
  }])
});

test('a warning the parked-warnings setting accepts is listed as known and parked, and the card stays grey and silent', () => {
  const spec = health.buildHealthCard(report([{ id: 'paypal.live', status: 'warn', detail: STRAY }]), null, { now: NOW, parked: PARKED });
  assert.equal(spec.kind, 'info');
  assert.equal(spec.what, 'Shop health: all clear');
  assert.equal(fieldOf(spec, 'warn paypal.live'), undefined);
  assert.match(fieldOf(spec, 'Known, parked').value, /^paypal\.live: An extra webhook the owner has accepted/);
  assert.match(spec.footerExtra, / 0 warn \(\+1 parked\) \/ 0 fail /);
  const body = buildCard(spec);
  assert.equal(body.flags, SUPPRESS_NOTIFICATIONS);
  assert.equal(body.embeds[0].color, KIND_COLORS.info);
  assert.equal(body.content, undefined);
});

test('anything beyond the accepted warning is a real warning and turns the card amber', () => {
  const env = { id: 'env.vars', status: 'warn', detail: '30 required present; BACKUP_OFFSITE unset: backups stay on this box only' };
  const variants = [
    { id: 'paypal.live', status: 'warn', detail: `${STRAY}, https://discord.com/api/webhooks/160000000000000000/…` },
    { id: 'paypal.live', status: 'warn', detail: STRAY.replace('https://discord.com/api/webhooks/150000000000000000', 'https://hooks.example.test/paypal') },
    { id: 'paypal.sandbox', status: 'warn', detail: STRAY.replace('live:', 'sandbox:') },
    { id: 'paypal.live', status: 'warn', detail: 'live: webhook 7S0 bound with all 17 events' },
    env
  ];
  for (const v of variants) {
    const spec = health.buildHealthCard(report([v]), null, { now: NOW, parked: PARKED });
    assert.equal(spec.kind, 'attention', v.detail);
    assert.equal(spec.what, 'Shop health: OK, 1 warning');
    assert.ok(fieldOf(spec, `warn ${v.id}`), v.detail);
    assert.equal(fieldOf(spec, 'Known, parked'), undefined);
    assert.notEqual(buildCard(spec).flags, SUPPRESS_NOTIFICATIONS);
  }
  const both = health.buildHealthCard(report([{ id: 'paypal.live', status: 'warn', detail: STRAY }, env]), null, { now: NOW, parked: PARKED });
  assert.equal(both.kind, 'attention');
  assert.equal(both.what, 'Shop health: OK, 1 warning');
  assert.ok(fieldOf(both, 'Known, parked'));
  // With nothing configured, the same warning is a real one.
  const unset = health.buildHealthCard(report([{ id: 'paypal.live', status: 'warn', detail: STRAY }]), null, { now: NOW });
  assert.equal(unset.kind, 'attention');
  assert.ok(fieldOf(unset, 'warn paypal.live'));
});

test('a failure is red, names the check, and no email address reaches the card', () => {
  const spec = health.buildHealthCard(report([
    { id: 'smtp', status: 'fail', detail: 'Invalid login for billing@example.invalid' },
    { id: 'paypal.live', status: 'warn', detail: STRAY }
  ]), null, { now: NOW, parked: PARKED });
  assert.equal(spec.kind, 'action');
  assert.equal(spec.what, 'Shop health: 1 problem');
  assert.ok(fieldOf(spec, 'FAIL smtp'));
  const body = buildCard(spec);
  assert.equal(body.embeds[0].color, KIND_COLORS.action);
  assert.doesNotMatch(JSON.stringify(body), /billing@example\.invalid/);
});

test('parked warnings come only from the setting, match whole warning texts, and a bad setting parks nothing and says so', () => {
  assert.deepEqual(health.parkedWarningsFrom({}), { list: [], error: null });
  assert.equal(health.ACCEPTED_WARNINGS, undefined, 'the code carries no accepted warning of its own');
  assert.equal(PARKED.error, null);
  assert.ok(Object.isFrozen(PARKED.list));
  assert.equal(PARKED.list.length, 1);
  for (const a of PARKED.list) {
    assert.ok(Object.isFrozen(a));
    assert.equal(a.check, 'paypal.live');
    assert.equal(a.matches(''), false, 'an empty detail never matches');
    assert.equal(a.matches(STRAY), true);
  }
  const partial = health.parkedWarningsFrom({ HEALTH_PARKED_WARNINGS: JSON.stringify([{ check: 'paypal.live', match: 'other webhooks', note: 'n' }]) });
  assert.equal(partial.list[0].matches(STRAY), false, 'a pattern must match the whole text, not part of it');

  const bad = ['{not json', '{"check":"paypal.live"}', JSON.stringify([{ check: 'paypal.live', match: 'x' }]), JSON.stringify([{ check: 'paypal.live', match: '(', note: 'n' }])];
  for (const raw of bad) {
    const cfg = health.parkedWarningsFrom({ HEALTH_PARKED_WARNINGS: raw });
    assert.deepEqual(cfg.list, [], raw);
    assert.match(cfg.error, /nothing is parked/, raw);
    const spec = health.buildHealthCard(report([{ id: 'paypal.live', status: 'warn', detail: STRAY }]), null, { now: NOW, parked: cfg });
    assert.equal(spec.kind, 'attention', raw);
    assert.ok(fieldOf(spec, 'warn health.parked'), raw);
    assert.ok(fieldOf(spec, 'warn paypal.live'), raw);
  }
});

test('a run started by hand says Manual run; the scheduled run does not', () => {
  const manual = health.buildHealthCard(report(), null, { now: NOW, manual: true });
  assert.equal(manual.what, 'Shop health: all clear · Manual run');
  assert.match(manual.description, /^Manual run · /);
  const scheduled = health.buildHealthCard(report(), null, { now: NOW, manual: false });
  assert.doesNotMatch(JSON.stringify(scheduled), /Manual run/);
});

test('active entitlements are distinct in-game IDs per server, not order rows', () => {
  const buckets = {
    eu1: [
      { guid: 'aaaaaaaa-0000-4000-8000-000000000001', item: 'Priority Queue' },
      { guid: 'AAAAAAAA-0000-4000-8000-000000000001', item: 'Supporter' },
      { guid: 'bbbbbbbb-0000-4000-8000-000000000002', item: 'Priority Queue' }
    ],
    eu2: [{ guid: 'cccccccc-0000-4000-8000-000000000003', item: 'Supporter' }],
    na1: []
  };
  const pq = {
    eu1: new Set(['aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002']),
    eu2: new Set(),
    na1: new Set()
  };
  const list = health.entitlementsByServer(buckets, pq);
  assert.deepEqual(list, [
    { serverId: 'eu1', ids: 2, priorityQueue: 2 },
    { serverId: 'eu2', ids: 1, priorityQueue: 0 },
    { serverId: 'na1', ids: 0, priorityQueue: 0 }
  ]);
  const oldWording = [{ id: 'db.file', status: 'ok', detail: 'integrity ok, journal wal, 10 users, 20 orders, 99 active entitlements' }];
  const spec = health.buildHealthCard(report([], oldWording), null, { now: NOW, entitlements: list });
  assert.equal(fieldOf(spec, 'Active entitlements (distinct in-game IDs per server)').value, [
    `${serverLabel('eu1')}: 2, 2 with priority queue`,
    `${serverLabel('eu2')}: 1, 0 with priority queue`,
    `${serverLabel('na1')}: 0, 0 with priority queue`
  ].join('\n'));
  assert.doesNotMatch(spec.description, /99|entitlements/, 'the order-row count is not relabelled as entitlements');
  assert.doesNotMatch(JSON.stringify(buildCard(spec)), /aaaaaaaa-0000/);
});

let n = 0;
function user() {
  n += 1;
  const id = `7656119${String(n).padStart(10, '0')}`;
  db.prepare('INSERT INTO users (steam_id, persona) VALUES (?, ?)').run(id, `Player${n}`);
  return id;
}
function product(title, currency, type) {
  return db.prepare('INSERT INTO products (title, price_cents, currency, type) VALUES (?, 1500, ?, ?)').run(title, currency, type).lastInsertRowid;
}
function order(productId, { status = 'completed', sub = null, amount = 1500, completedAt = NOW - HOUR, testMode = 0 } = {}) {
  return db.prepare(`
    INSERT INTO orders (steam_id, product_id, status, amount_cents, test_mode, paypal_subscription_id, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user(), productId, status, amount, testMode, sub, completedAt || NOW - 2 * DAY, completedAt).lastInsertRowid;
}

test('money in the last 24 hours comes from the shop records, without sandbox orders, and never changes the colour', () => {
  const PQ = product('Priority Queue', 'usd', 'subscription');
  const PQ30 = product('Priority Queue 30 days', 'usd', 'one_time');
  const SUPPORTER = product('Supporter', 'eur', 'one_time');

  const oneTime = order(PQ30, { amount: 1000, completedAt: NOW - 2 * HOUR });
  order(PQ, { sub: 'I-H1', completedAt: NOW - 40 * DAY });
  order(PQ, { sub: 'I-H1', completedAt: NOW - 3 * HOUR }); // a renewal
  const firstCycle = order(PQ, { sub: 'I-H2', completedAt: NOW - HOUR }); // a new subscription
  order(PQ, { sub: 'I-H3', completedAt: NOW - 60 * DAY });
  const refundedRenewal = order(PQ, { sub: 'I-H3', status: 'refunded', completedAt: NOW - 5 * HOUR }); // came in, went back
  order(SUPPORTER, { amount: 1250, completedAt: NOW - 2 * HOUR });
  const sandbox = order(PQ30, { testMode: 1, completedAt: NOW - HOUR });
  order(PQ30, { status: 'pending', completedAt: null });
  order(PQ30, { status: 'cancelled', completedAt: NOW - HOUR });
  order(PQ30, { completedAt: NOW - DAY }); // exactly a day ago: the previous day's
  order(PQ30, { completedAt: NOW + HOUR }); // after the run

  const refund = db.prepare('INSERT INTO paypal_refunds (refund_id, order_id, payment_id, amount_cents, currency, kind, source, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  refund.run('R1', refundedRenewal, 'SALE-H3', 1500, 'USD', 'refund', 'webhook', NOW - 4 * HOUR);
  refund.run('R2', oneTime, 'CAP-1', 1000, null, 'refund', 'staff', NOW - 2 * HOUR);
  refund.run('R3', null, 'SALE-X', null, null, 'refund', 'webhook', NOW - HOUR);
  refund.run('R4', sandbox, 'CAP-S', 1500, 'USD', 'refund', 'staff', NOW - HOUR);
  refund.run('R5', null, 'SALE-OLD', 1500, 'USD', 'refund', 'webhook', NOW - 30 * HOUR);
  refund.run('V1', firstCycle, 'SALE-H2', 4500, 'USD', 'reversal', 'webhook', NOW - 6 * HOUR);

  const seen = db.prepare('INSERT INTO reconcile_seen (transaction_id, reported_at) VALUES (?, ?)');
  seen.run('T-A', NOW - 30 * 60);
  seen.run('T-B', NOW - 10 * 60);
  seen.run('T-OLD', NOW - 2 * DAY);

  const dispute = db.prepare('INSERT INTO paypal_disputes (dispute_id, order_id, status, amount_cents, currency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  dispute.run('D1', null, 'OPEN', 4500, 'USD', NOW - 5 * DAY, NOW - 5 * DAY);
  dispute.run('D2', firstCycle, 'WAITING_FOR_SELLER_RESPONSE', 1500, 'USD', NOW - DAY, NOW - HOUR);
  dispute.run('D3', null, 'RESOLVED', 1500, 'USD', NOW - 9 * DAY, NOW - 2 * DAY);
  dispute.run('D4', sandbox, 'OPEN', 1500, 'USD', NOW - DAY, NOW - DAY);

  const m = health.moneyLast24h(db, NOW);
  assert.deepEqual(m.paymentsIn, { count: 5, newCount: 3, totals: { USD: 5500, EUR: 1250 } });
  assert.deepEqual(m.renewals, { count: 2, totals: { USD: 3000 } });
  assert.deepEqual(m.refundsOut, { count: 3, noAmount: 1, totals: { USD: 2500 } });
  assert.deepEqual(m.reversals, { count: 1, totals: { USD: 4500 } });
  assert.equal(m.unbookedFound, 2);
  assert.deepEqual(m.openDisputes, { count: 2, waitingForShop: 1, totals: { USD: 6000 } });

  const spec = health.buildHealthCard(report(), null, { now: NOW, money: m });
  assert.equal(spec.kind, 'info');
  assert.equal(fieldOf(spec, 'Money, last 24 hours').value, [
    'Payments in: 5, $55.00 + 12.50 EUR',
    'Renewals booked (part of those): 2, $30.00',
    'Refunds out: 3, $25.00, 1 with no amount given',
    'Payments reversed: 1, $45.00',
    'Unbooked payments found by the PayPal check: 2',
    'Open disputes (any age): 2, $60.00, 1 waiting for the shop'
  ].join('\n'));

  // A quiet day reads as zeros. Open disputes are counted whatever their age.
  const quietDay = health.moneyLast24h(db, NOW + 400 * DAY);
  assert.equal(health.moneyText(quietDay), [
    'Payments in: 0, $0.00',
    'Renewals booked (part of those): 0, $0.00',
    'Refunds out: 0, $0.00',
    'Unbooked payments found by the PayPal check: 0',
    'Open disputes (any age): 2, $60.00, 1 waiting for the shop'
  ].join('\n'));
});

test('the PayPal check shows on the card, and a failed, stopped or unposted check is a real warning', () => {
  const card = (last, off = false) => health.buildHealthCard(report(), null, { now: NOW, reconcile: { off, last } });
  const ranAt = NOW - 30 * 60; // 07:30 UTC

  const good = card({ ranAt, ok: true, skipped: null, error: null, incoming: 12, unbooked: 0, reported: 0, posted: null });
  assert.equal(good.kind, 'info');
  assert.match(good.description, /PayPal check 07:30 UTC: 12 payments, all booked/);

  const reported = card({ ranAt, ok: true, skipped: null, error: null, incoming: 3, unbooked: 1, reported: 1, posted: true });
  assert.equal(reported.kind, 'info');
  assert.match(reported.description, /PayPal check 07:30 UTC: 3 payments, 1 unbooked reported/);

  const failed = card({ ranAt, ok: false, skipped: null, error: 'paypal 503: Service Unavailable', incoming: 0, unbooked: 0, reported: 0, posted: null });
  assert.equal(failed.kind, 'attention');
  assert.match(fieldOf(failed, 'warn paypal.reconcile').value, /07:30 UTC PayPal check could not finish, so no payment was checked: paypal 503/);

  const unposted = card({ ranAt, ok: true, skipped: null, error: null, incoming: 3, unbooked: 2, reported: 0, posted: false });
  assert.equal(unposted.kind, 'attention');
  assert.match(fieldOf(unposted, 'warn paypal.reconcile').value, /found 2 unbooked payments but could not post its card/);

  const stopped = card({ ranAt: NOW - 30 * HOUR, ok: true, skipped: null, error: null, incoming: 1, unbooked: 0, reported: 0, posted: null });
  assert.equal(stopped.kind, 'attention');
  assert.match(fieldOf(stopped, 'warn paypal.reconcile').value, /last ran 30 h ago; its timer is not running/);

  const off = card(null, true);
  assert.equal(off.kind, 'info');
  assert.match(off.description, /PayPal check off \(RECONCILE\)/);

  const notYet = card(null);
  assert.equal(notYet.kind, 'info');
  assert.match(notYet.description, /PayPal check has not run since the shop last started/);

  const unreadable = health.buildHealthCard(report(), null, { now: NOW, errors: [{ id: 'health.money', detail: 'the money lines could not be read: SQLITE_BUSY' }] });
  assert.equal(unreadable.kind, 'attention');
  assert.ok(fieldOf(unreadable, 'warn health.money'));
});

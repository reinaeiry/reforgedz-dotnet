// Tests for the priority queue money guards (pqGuards.js) against the REAL
// schema: db.js is loaded with DATA_DIR pointed at a throwaway folder, so every
// migration runs exactly as it will on the live database, then the tests use it.
// Needs better-sqlite3, so run it where the shop's node_modules are.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-pqguards-'));
process.env.DATA_DIR = dataDir;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const guards = require('../pqGuards');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const NOW = 1800000000;
const DAY = 86400;

let seq = 0;
const next = () => ++seq;
const guidN = (n) => `0000abcd-0000-4000-8000-${String(n).padStart(12, '0')}`;

function user({ biUid = null, platform = 'steam' } = {}) {
  const n = next();
  const id = `7656119${String(n).padStart(10, '0')}`;
  db.prepare('INSERT INTO users (steam_id, persona, bi_uid, platform) VALUES (?, ?, ?, ?)').run(id, `Player${n}`, biUid, platform);
  return id;
}

function product({ pq = 1, serverSpecific = 1, type = 'subscription' } = {}) {
  return db.prepare('INSERT INTO products (title, price_cents, type, grants_priority_queue, server_specific) VALUES (?, 1500, ?, ?, ?)')
    .run(`Product ${next()}`, type, pq, serverSpecific).lastInsertRowid;
}

const PQ_EU = product();
const PQ_GLOBAL = product({ serverSpecific: 0 });
const ROLE_SUB = product({ pq: 0, serverSpecific: 0 });

function order(steamId, productId, {
  status = 'completed', serverId = 'eu1', sub = `I-SUB${next()}`, until = NOW + 10 * DAY,
  testMode = 0, cancelledAt = null, endedReason = null, completedAt = NOW - DAY
} = {}) {
  return db.prepare(`
    INSERT INTO orders (steam_id, product_id, server_id, status, amount_cents, test_mode, paypal_subscription_id,
                        effective_until, subscription_cancelled_at, subscription_ended_reason, created_at, completed_at)
    VALUES (?, ?, ?, ?, 1500, ?, ?, ?, ?, ?, ?, ?)
  `).run(steamId, productId, serverId, status, testMode, sub, until, cancelledAt, endedReason, NOW - DAY, completedAt).lastInsertRowid;
}

// A retired staff grant (removed 0) or block (removed 1): the table is kept, and
// nothing may count its rows.
const addGrant = db.prepare('INSERT INTO priority_queue_grants (guid, server_id, removed, granted_by, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)');

const own = (steamId, extra = {}) => guards.ownLiveSubscription(db, { steamId, serverId: 'eu1', testMode: false, now: NOW, ...extra });

// ---- Schema -----------------------------------------------------------------

test('the migration adds the renewal, counter and reminder tables', () => {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  assert.deepEqual(cols('revoked_renewals'), ['sale_id', 'subscription_id', 'amount_cents', 'received_at']);
  assert.deepEqual(cols('funnel_counts'), ['day', 'step', 'n']);
  assert.deepEqual(cols('reminder_sent'), ['order_id', 'effective_until', 'sent_at']);
  db.prepare("INSERT INTO reminder_sent (order_id, effective_until, sent_at) VALUES (1, 2, 3)").run();
  assert.throws(() => db.prepare("INSERT INTO reminder_sent (order_id, effective_until, sent_at) VALUES (1, 2, 4)").run(), /UNIQUE|PRIMARY KEY/);
  db.prepare("INSERT INTO reminder_sent (order_id, effective_until, sent_at) VALUES (1, 5, 4)").run();
});

// ---- Own live subscription --------------------------------------------------

test('a live auto-renewing subscription on the same server blocks, and reports when it renews', () => {
  const buyer = user({ biUid: guidN(1) });
  const id = order(buyer, PQ_EU, { until: NOW + 5 * DAY });
  const row = own(buyer);
  assert.equal(row.id, id);
  assert.equal(row.effective_until, NOW + 5 * DAY);
  assert.equal(row.server_id, 'eu1');
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'payment_problem'), false, 'a failing renewal ends the subscription, so there is no payment problem to report');
});

test('cancelled, ended, expired, other-mode and other-server subscriptions do not block', () => {
  const cancelled = user();
  order(cancelled, PQ_EU, { cancelledAt: NOW - DAY, endedReason: 'cancelled' });
  assert.equal(own(cancelled), null, 'cancelled but paid up is "Start again"');

  const ended = user();
  order(ended, PQ_EU, { endedReason: 'suspended' });
  assert.equal(own(ended), null, 'an ended reason alone is enough');

  const expired = user();
  order(expired, PQ_EU, { until: NOW });
  order(expired, PQ_EU, { until: NOW - DAY });
  assert.equal(own(expired), null);

  const sandbox = user();
  order(sandbox, PQ_EU, { testMode: 1 });
  assert.equal(own(sandbox), null, 'a sandbox subscription does not block a live purchase');
  assert.ok(own(sandbox, { testMode: true }), 'but does block another sandbox one');

  const elsewhere = user();
  order(elsewhere, PQ_EU, { serverId: 'eu2' });
  assert.equal(own(elsewhere), null);
  assert.ok(own(elsewhere, { serverId: 'eu2' }));
});

test('only completed priority queue orders that belong to a subscription count', () => {
  const oneTime = user();
  order(oneTime, PQ_EU, { sub: null });
  assert.equal(own(oneTime), null);

  const role = user();
  order(role, ROLE_SUB, { serverId: null });
  assert.equal(own(role), null);

  const refunded = user();
  order(refunded, PQ_EU, { status: 'refunded' });
  assert.equal(own(refunded), null);

  const pending = user();
  order(pending, PQ_EU, { status: 'pending', until: null });
  assert.equal(own(pending), null);

  const someoneElse = user();
  const buyer = user();
  order(someoneElse, PQ_EU);
  assert.equal(own(buyer), null);
});

test('a subscription not tied to a server covers every server; just activated (no date yet) counts', () => {
  const global = user();
  order(global, PQ_GLOBAL, { serverId: null });
  for (const s of ['eu1', 'na2']) assert.ok(own(global, { serverId: s }), s);
  assert.ok(own(global, { serverId: null }));

  const serverOnly = user();
  order(serverOnly, PQ_EU);
  assert.equal(own(serverOnly, { serverId: null }), null, 'buying the all-server product is not a second copy of a one-server one');

  const fresh = user();
  order(fresh, PQ_EU, { until: null });
  const row = own(fresh);
  assert.ok(row);
  assert.equal(row.effective_until, null);
});

test('no end date counts only just after activation; an excluded subscription is left out', () => {
  const stale = user();
  order(stale, PQ_EU, { until: null, completedAt: NOW - guards.ACTIVATION_GAP_S - 60 });
  assert.equal(own(stale), null, 'a date lookup that never came back: the account page calls it lapsed and offers Start again');

  const edge = user();
  order(edge, PQ_EU, { until: null, completedAt: NOW - guards.ACTIVATION_GAP_S + 60 });
  assert.ok(own(edge));

  const excluded = user();
  order(excluded, PQ_EU, { sub: 'I-EXCL' });
  assert.equal(own(excluded, { excludeSubscriptionId: 'I-EXCL' }), null);
  assert.ok(own(excluded, { excludeSubscriptionId: 'I-OTHER' }));
});

test('the refusal names the server and the renewal day, and never talks of a staff move or a payment problem', () => {
  const at = Date.UTC(2027, 9, 12, 15, 30) / 1000;
  const body = guards.alreadySubscribedRefusal({ effective_until: at }, 'EU1 (Chernarus)');
  assert.deepEqual(body, {
    code: 'already_subscribed',
    error: 'You already have priority queue on EU1 (Chernarus) that renews on 12 October. Manage it on your account page.',
    renewsAt: at
  });
  const early = guards.alreadySubscribedRefusal({ effective_until: null }, 'NA2 (Faircroft)');
  assert.equal(early.renewsAt, null);
  assert.match(early.error, /on NA2 \(Faircroft\) that renews automatically\./);

  // A staff move now changes the order's server, and a failing renewal ends the
  // subscription, so neither has its own refusal: whatever an old caller passes,
  // the answer is the plain one.
  const old = guards.alreadySubscribedRefusal({ effective_until: at, payment_problem: 1 }, 'EU2 (Faircroft)', { blocked: true });
  assert.deepEqual(old, {
    code: 'already_subscribed',
    error: 'You already have priority queue on EU2 (Faircroft) that renews on 12 October. Manage it on your account page.',
    renewsAt: at
  });

  for (const b of [body, early, old, guards.sharedIdRefusal()]) {
    assert.doesNotMatch(b.error, /—|–|dayz/i);
    assert.doesNotMatch(b.error, /staff|payment problem/i);
  }
  assert.equal(guards.dayMonth(Date.UTC(2026, 0, 1) / 1000), '1 January');
});

// ---- Another account --------------------------------------------------------

test('another account with a live paid order on the same ID is found whatever server is bought, case-insensitively', () => {
  const g = guidN(100);
  const holder = user({ biUid: g.toUpperCase() });
  order(holder, PQ_EU, { sub: null });
  const buyer = user({ biUid: g });
  assert.equal(guards.otherAccountLivePq(db, { steamId: buyer, biUid: `  ${g.toUpperCase()} `, now: NOW }), true);
  assert.equal(guards.otherAccountLivePq(db, { steamId: buyer, biUid: g, serverId: 'na2', now: NOW }), true,
    'the server being bought plays no part, so asking once per server reveals nothing');
  assert.equal(guards.otherAccountLivePq(db, { steamId: holder, biUid: g, now: NOW }), false, 'the buyer\'s own order is not another account');
  assert.equal(guards.otherAccountLivePq(db, { steamId: buyer, biUid: '', now: NOW }), false);
  assert.equal(guards.otherAccountLivePq(db, { steamId: buyer, biUid: null, now: NOW }), false);
});

test('grants, sandbox, expired, undated and refunded orders on another account do not count; a dated all-server order does', () => {
  const g = guidN(200);
  const buyer = user({ biUid: g });
  const ask = () => guards.otherAccountLivePq(db, { steamId: buyer, biUid: g, now: NOW });

  addGrant.run(g, 'eu1', 0, 'staff', NOW, null);
  const other = user({ biUid: g });
  assert.equal(ask(), false, 'a manual grant alone');

  order(other, PQ_EU, { testMode: 1 });
  order(other, PQ_EU, { sub: null, until: NOW - 1 });
  order(other, PQ_EU, { until: NOW - 1, cancelledAt: NOW - DAY, endedReason: 'cancelled' });
  order(other, PQ_EU, { status: 'refunded' });
  order(other, PQ_EU, { status: 'pending' });
  order(other, ROLE_SUB, { serverId: null });
  assert.equal(ask(), false);

  const third = user({ biUid: g });
  order(third, PQ_GLOBAL, { serverId: null, until: null });
  assert.equal(ask(), false, 'an order with no end date is not paid priority queue');
  order(third, PQ_GLOBAL, { serverId: null, sub: null, until: NOW + DAY });
  assert.equal(ask(), true);
  assert.equal(guards.otherAccountLivePq(db, { steamId: buyer, biUid: g, now: NOW + DAY }), false, 'its paid period is over and it is not a subscription');
});

// ---- Duplicate found when a subscription activates ----------------------------

test('a subscription that activates beside another live one for the same server is reported from either side', () => {
  const buyer = user();
  const first = order(buyer, PQ_EU, { sub: 'I-DUP-A' });
  const second = order(buyer, PQ_EU, { sub: 'I-DUP-B', until: null, completedAt: NOW });
  assert.equal(guards.duplicateLiveSubscription(db, { orderId: second, now: NOW }).id, first);
  assert.equal(guards.duplicateLiveSubscription(db, { orderId: first, now: NOW }).id, second);

  const lone = user();
  const only = order(lone, PQ_EU, { sub: 'I-DUP-C' });
  order(lone, PQ_EU, { sub: 'I-DUP-D', serverId: 'eu2' });
  order(lone, ROLE_SUB, { sub: 'I-DUP-E', serverId: null });
  order(lone, PQ_EU, { sub: 'I-DUP-F', cancelledAt: NOW - DAY, endedReason: 'cancelled' });
  assert.equal(guards.duplicateLiveSubscription(db, { orderId: only, now: NOW }), null,
    'another server, a subscription that is not priority queue and a cancelled one are not duplicates');
  const oneTime = order(lone, PQ_EU, { sub: null });
  assert.equal(guards.duplicateLiveSubscription(db, { orderId: oneTime, now: NOW }), null, 'a one-time order is not a subscription');
  assert.equal(guards.duplicateLiveSubscription(db, { orderId: 999999, now: NOW }), null);
});

// ---- Renewals on revoked subscriptions ---------------------------------------

test('a renewal on a subscription whose orders were all revoked is recorded once per sale', () => {
  const buyer = user();
  const sub = 'I-REVOKED1';
  const first = order(buyer, PQ_EU, { sub, status: 'refunded' });
  const second = order(buyer, PQ_EU, { sub, status: 'refunded' });
  const abandoned = order(buyer, PQ_EU, { sub, status: 'cancelled' });

  const got = guards.recordRevokedRenewal(db, { saleId: 'SALE-1', subscriptionId: sub, amountCents: 1500, now: NOW });
  assert.deepEqual(got.orders.map(o => [o.id, o.status]), [[first, 'refunded'], [second, 'refunded'], [abandoned, 'cancelled']]);
  assert.equal(got.orders[0].steam_id, buyer);
  assert.equal(guards.recordRevokedRenewal(db, { saleId: 'SALE-1', subscriptionId: sub, amountCents: 1500, now: NOW + 60 }), false, 'a PayPal retry');
  assert.deepEqual(db.prepare('SELECT * FROM revoked_renewals WHERE subscription_id = ?').all(sub), [
    { sale_id: 'SALE-1', subscription_id: sub, amount_cents: 1500, received_at: NOW }
  ]);
  assert.ok(guards.recordRevokedRenewal(db, { saleId: 'SALE-2', subscriptionId: sub, amountCents: null, now: NOW + 30 * DAY }), 'next month is a new sale');
  assert.equal(db.prepare('SELECT amount_cents FROM revoked_renewals WHERE sale_id = ?').get('SALE-2').amount_cents, null);
});

test('a subscription that still has a live or pending order, or none here at all, is not recorded', () => {
  const buyer = user();
  order(buyer, PQ_EU, { sub: 'I-MIXED', status: 'refunded' });
  order(buyer, PQ_EU, { sub: 'I-MIXED', status: 'completed' });
  order(buyer, PQ_EU, { sub: 'I-WAITING', status: 'pending' });
  assert.equal(guards.recordRevokedRenewal(db, { saleId: 'SALE-M', subscriptionId: 'I-MIXED', amountCents: 1500, now: NOW }), null);
  assert.equal(guards.recordRevokedRenewal(db, { saleId: 'SALE-W', subscriptionId: 'I-WAITING', amountCents: 1500, now: NOW }), null);
  assert.equal(guards.recordRevokedRenewal(db, { saleId: 'SALE-U', subscriptionId: 'I-NOT-OURS', amountCents: 1500, now: NOW }), null);
  assert.equal(guards.recordRevokedRenewal(db, { saleId: null, subscriptionId: 'I-MIXED', now: NOW }), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM revoked_renewals WHERE sale_id IN ('SALE-M', 'SALE-W', 'SALE-U')").get().n, 0);
});

test('a renewal after the newest paid cycle was refunded is flagged, even with an older cycle still completed', () => {
  const buyer = user();
  const sub = 'I-LATEST-REFUNDED';
  order(buyer, PQ_EU, { sub, status: 'completed' });
  const refunded = order(buyer, PQ_EU, { sub, status: 'refunded' });
  order(buyer, PQ_EU, { sub, status: 'cancelled' });
  assert.deepEqual(guards.refundedLatestCycle(db, sub), { id: refunded, noRefund: false }, 'a cancelled (abandoned) row is not a cycle');
  assert.equal(guards.recordRevokedRenewal(db, { saleId: 'SALE-LR', subscriptionId: sub, now: NOW }), null,
    'the older completed cycle keeps it out of the all-revoked case, which is why this check exists');

  const fine = 'I-LATEST-OK';
  order(buyer, PQ_EU, { sub: fine, status: 'refunded' });
  order(buyer, PQ_EU, { sub: fine, status: 'completed' });
  assert.equal(guards.refundedLatestCycle(db, fine), null, 'a refund on an older cycle only');
  assert.equal(guards.refundedLatestCycle(db, 'I-NOT-OURS'), null);
  assert.equal(guards.refundedLatestCycle(db, null), null);

  const revoked = 'I-LATEST-REVOKED';
  order(buyer, PQ_EU, { sub: revoked, status: 'completed' });
  const noMoney = order(buyer, PQ_EU, { sub: revoked, status: 'refunded' });
  db.prepare('UPDATE orders SET revoked_without_refund_at = ? WHERE id = ?').run(NOW, noMoney);
  assert.deepEqual(guards.refundedLatestCycle(db, revoked), { id: noMoney, noRefund: true }, 'revoked with no money back');
  assert.equal(guards.recordRevokedRenewal(db, { saleId: 'SALE-RV-X', subscriptionId: revoked, now: NOW }), null);
});

// ---- Retired machinery -----------------------------------------------------------

test('the grant, block and move helpers are gone from the guards', () => {
  for (const gone of ['blockedOnServer', 'clearLeftoverPqDenies', 'queueMoveForOrder']) {
    assert.equal(Object.prototype.hasOwnProperty.call(guards, gone), false, gone);
  }
});

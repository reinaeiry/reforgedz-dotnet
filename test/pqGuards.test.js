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
const { SERVER_IDS } = require('../gameServers');

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

// A grant (removed 0) or a staff block (removed 1).
const addGrant = db.prepare('INSERT INTO priority_queue_grants (guid, server_id, removed, granted_by, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
const grantRows = (...guids) => db.prepare(
  `SELECT guid, server_id, removed FROM priority_queue_grants WHERE guid IN (${guids.map(() => '?').join(',')}) ORDER BY guid, server_id`
).all(...guids);

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
  assert.equal(row.payment_problem, 0);
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

test('no end date counts only just after activation; an excluded subscription is left out; an open billing issue is marked', () => {
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

  const failing = user();
  order(failing, PQ_EU, { sub: 'I-FAILING', until: NOW + 2 * DAY });
  db.prepare('INSERT INTO subscription_billing_issues (paypal_subscription_id, first_seen_at, last_seen_at) VALUES (?, ?, ?)')
    .run('I-FAILING', NOW - DAY, NOW - DAY);
  assert.equal(own(failing).payment_problem, 1, 'in its grace days');
  db.prepare('UPDATE subscription_billing_issues SET resolved_at = ? WHERE paypal_subscription_id = ?').run(NOW, 'I-FAILING');
  assert.equal(own(failing).payment_problem, 0, 'a resolved issue is over');
});

test('the refusal names the server and the renewal day, a payment problem, or a staff move', () => {
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

  const failing = guards.alreadySubscribedRefusal({ effective_until: at, payment_problem: 1 }, 'EU1 (Chernarus)');
  assert.deepEqual(failing, {
    code: 'already_subscribed',
    error: 'Your priority queue subscription on EU1 (Chernarus) has a payment problem. Update your payment method on PayPal, or cancel it on your account page, then buy again.',
    renewsAt: null
  });

  const moved = guards.alreadySubscribedRefusal({ effective_until: at, payment_problem: 1 }, 'EU2 (Faircroft)', { blocked: true });
  assert.deepEqual(moved, {
    code: 'already_subscribed',
    error: 'Staff changed where your priority queue subscription applies, so it is not active on EU2 (Faircroft). To change it, open a Shop Support ticket.',
    renewsAt: at
  });

  for (const b of [body, early, failing, moved, guards.sharedIdRefusal()]) {
    assert.doesNotMatch(b.error, /—|–|dayz/i);
  }
  assert.doesNotMatch(failing.error, /renews/);
  assert.equal(guards.dayMonth(Date.UTC(2026, 0, 1) / 1000), '1 January');
});

test('a staff block on the server is found for the ID, case-insensitively; a grant, another server or another ID is not', () => {
  const g = guidN(400);
  addGrant.run(g, 'eu2', 1, 'staff', NOW, null);
  addGrant.run(g, 'eu1', 0, 'staff', NOW, NOW + DAY);
  assert.equal(guards.blockedOnServer(db, { biUid: ` ${g.toUpperCase()} `, serverId: 'eu2' }), true);
  assert.equal(guards.blockedOnServer(db, { biUid: g, serverId: 'eu1' }), false, 'a grant');
  assert.equal(guards.blockedOnServer(db, { biUid: g, serverId: 'na1' }), false);
  assert.equal(guards.blockedOnServer(db, { biUid: guidN(401), serverId: 'eu2' }), false);
  assert.equal(guards.blockedOnServer(db, { biUid: null, serverId: 'eu2' }), false);
  assert.equal(guards.blockedOnServer(db, { biUid: g, serverId: null }), false);
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

test('grants, sandbox, expired and refunded orders on another account do not count; an all-server order does', () => {
  const g = guidN(200);
  const buyer = user({ biUid: g });
  const ask = () => guards.otherAccountLivePq(db, { steamId: buyer, biUid: g, now: NOW });

  addGrant.run(g, 'eu1', 0, 'staff', NOW, null);
  const other = user({ biUid: g });
  assert.equal(ask(), false, 'a manual grant alone');

  order(other, PQ_EU, { testMode: 1 });
  order(other, PQ_EU, { until: NOW - 1 });
  order(other, PQ_EU, { status: 'refunded' });
  order(other, PQ_EU, { status: 'pending' });
  order(other, ROLE_SUB, { serverId: null });
  assert.equal(ask(), false);

  const third = user({ biUid: g });
  order(third, PQ_GLOBAL, { serverId: null, until: null });
  assert.equal(ask(), true);
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

// ---- Leftover blocks --------------------------------------------------------

test('a true leftover block is cleared only for that ID on the servers the purchase covers', () => {
  const g = guidN(300);
  const other = guidN(301);
  addGrant.run(g, 'eu1', 1, 'staff-a', NOW - 9 * DAY, null);
  addGrant.run(g, 'eu2', 1, 'staff-b', NOW - 8 * DAY, null);
  addGrant.run(other, 'eu1', 1, 'staff-d', NOW - 6 * DAY, null);
  addGrant.run(other, 'na1', 0, 'staff-e', NOW - 6 * DAY, null);

  const out = guards.clearLeftoverPqDenies(db, { guid: g.toUpperCase(), serverIds: ['eu1', 'na1'], orderId: 1, now: NOW });
  assert.deepEqual(out, { cleared: [{ guid: g, server_id: 'eu1', granted_by: 'staff-a', granted_at: NOW - 9 * DAY }], kept: [] },
    'another ID\'s grant is not a move for this one');
  assert.deepEqual(grantRows(g, other), [
    { guid: g, server_id: 'eu2', removed: 1 },
    { guid: other, server_id: 'eu1', removed: 1 },
    { guid: other, server_id: 'na1', removed: 0 },
  ]);

  const none = { cleared: [], kept: [] };
  assert.deepEqual(guards.clearLeftoverPqDenies(db, { guid: g, serverIds: ['eu1'], now: NOW }), none, 'nothing left there');
  assert.deepEqual(guards.clearLeftoverPqDenies(db, { guid: g, serverIds: [], now: NOW }), none);
  assert.deepEqual(guards.clearLeftoverPqDenies(db, { guid: '', serverIds: SERVER_IDS, now: NOW }), none);
  assert.equal(grantRows(g, other).length, 3);

  const all = guards.clearLeftoverPqDenies(db, { guid: g, serverIds: SERVER_IDS, now: NOW });
  assert.deepEqual(all.cleared.map(r => r.server_id), ['eu2'], 'an order for every server clears every leftover block for that ID');
  assert.deepEqual(grantRows(g, other), [
    { guid: other, server_id: 'eu1', removed: 1 },
    { guid: other, server_id: 'na1', removed: 0 },
  ]);
});

test('a staff move keeps its block when the player buys the old server again, whether its grant is live, lapsed or permanent', () => {
  for (const [n, expires] of [[310, NOW + 20 * DAY], [311, NOW - 20 * DAY], [312, null]]) {
    const g = guidN(n);
    addGrant.run(g, 'eu1', 0, 'staff', NOW - 30 * DAY, expires); // the server they were moved to
    addGrant.run(g, 'eu2', 1, 'staff', NOW - 30 * DAY, null);    // the server they bought first
    const buyer = user({ biUid: g });
    const bought = order(buyer, PQ_EU, { serverId: 'eu2' });

    const out = guards.clearLeftoverPqDenies(db, { guid: g, serverIds: ['eu2'], orderId: bought, now: NOW });
    assert.deepEqual(out.cleared, [], String(expires));
    assert.deepEqual(out.kept.map(r => [r.server_id, r.reason, r.granted_by]), [['eu2', 'moved', 'staff']]);
    const all = guards.clearLeftoverPqDenies(db, { guid: g, serverIds: SERVER_IDS, orderId: bought, now: NOW });
    assert.deepEqual(all.kept.map(r => r.server_id), ['eu2'], 'an order for every server keeps it too');
    assert.deepEqual(grantRows(g), [
      { guid: g, server_id: 'eu1', removed: 0 },
      { guid: g, server_id: 'eu2', removed: 1 },
    ]);
  }
});

test('a block with another live order behind it stays, on any account and in test mode; dead orders and the purchase itself do not count', () => {
  const g = guidN(320);
  addGrant.run(g, 'eu1', 1, 'staff', NOW - 5 * DAY, null);
  const holder = user({ biUid: g });
  const buyer = user({ biUid: g.toUpperCase() });
  const bought = order(buyer, PQ_EU, { sub: null });
  const ask = () => guards.clearLeftoverPqDenies(db, { guid: g, serverIds: ['eu1'], orderId: bought, now: NOW });

  const sandbox = order(holder, PQ_EU, { sub: null, testMode: 1 });
  assert.deepEqual(ask().kept.map(r => [r.server_id, r.reason]), [['eu1', 'other_order']], 'a test-mode order counts, as it does in the sync');
  db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(sandbox);
  order(holder, PQ_GLOBAL, { serverId: null, sub: null, until: null });
  assert.deepEqual(ask().kept.map(r => r.reason), ['other_order'], 'a lifetime order for every server');
  assert.equal(grantRows(g).length, 1);

  const d = guidN(321);
  addGrant.run(d, 'eu1', 1, 'staff', NOW - 5 * DAY, null);
  const dHolder = user({ biUid: d });
  order(dHolder, PQ_EU, { sub: null, until: NOW - DAY });
  order(dHolder, PQ_EU, { status: 'refunded' });
  order(dHolder, PQ_EU, { serverId: 'eu2' });
  order(dHolder, ROLE_SUB, { serverId: null });
  const dBuyer = user({ biUid: d });
  const dBought = order(dBuyer, PQ_EU);
  const out = guards.clearLeftoverPqDenies(db, { guid: d, serverIds: ['eu1'], orderId: dBought, now: NOW });
  assert.deepEqual(out.cleared.map(r => r.server_id), ['eu1'],
    'expired, refunded, other-server and non priority queue orders, and the purchase itself, leave it a leftover');
  assert.deepEqual(out.kept, []);
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
  assert.deepEqual(guards.refundedLatestCycle(db, sub), { id: refunded }, 'a cancelled (abandoned) row is not a cycle');
  assert.equal(guards.recordRevokedRenewal(db, { saleId: 'SALE-LR', subscriptionId: sub, now: NOW }), null,
    'the older completed cycle keeps it out of the all-revoked case, which is why this check exists');

  const fine = 'I-LATEST-OK';
  order(buyer, PQ_EU, { sub: fine, status: 'refunded' });
  order(buyer, PQ_EU, { sub: fine, status: 'completed' });
  assert.equal(guards.refundedLatestCycle(db, fine), null, 'a refund on an older cycle only');
  assert.equal(guards.refundedLatestCycle(db, 'I-NOT-OURS'), null);
  assert.equal(guards.refundedLatestCycle(db, null), null);
});

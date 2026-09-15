// Tests for the billing lifecycle (paymentEvents.js): a renewal that is not paid
// ends the subscription at once, a payment the shop cannot honour is refunded, a
// subscription only starts while its server has a slot, a lost dispute takes the
// order's perks away, and the daily PayPal check ends a failing agreement the same
// way the webhook does. Against the REAL schema: db.js is loaded with DATA_DIR
// pointed at a throwaway folder. PayPal, Discord and email are fakes: nothing is
// sent. Needs better-sqlite3, so run it where the shop's node_modules are.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-billing-'));
process.env.DATA_DIR = dataDir;
delete process.env.PAYMENTS_ALERT_ROLE_ID;
delete process.env.ADMIN_CEILING;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const ev = require('../paymentEvents');
const pqEntitlement = require('../pqEntitlement');
const reconcile = require('../tools/reconcile');
const { subscriptionUnpaidEmail, paymentRefusedEmail } = require('../invoiceMail');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const NOW = 1800000000;
const HOUR = 3600;
const DAY = 86400;
const iso = (unix) => new Date(unix * 1000).toISOString();
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Priority queue capped at 2 per server, so two holders fill a server.
const PQ = db.prepare("INSERT INTO products (title, price_cents, type, grants_priority_queue, server_specific, stock_limit) VALUES ('Priority Queue', 1500, 'subscription', 1, 1, 2)").run().lastInsertRowid;
const SUPPORTER = db.prepare("INSERT INTO products (title, price_cents, type) VALUES ('Supporter', 500, 'subscription')").run().lastInsertRowid;

let seq = 0;
function user() {
  const n = ++seq;
  const steamId = `7656119${String(n).padStart(10, '0')}`;
  const guid = `0000beef-0000-4000-8000-${String(n).padStart(12, '0')}`;
  db.prepare('INSERT INTO users (steam_id, persona, bi_uid, platform) VALUES (?, ?, ?, ?)').run(steamId, `Player${n}`, guid, 'steam');
  return { steamId, guid };
}

// A subscription with one paid cycle ending at `until`, or (status pending) a checkout
// waiting at PayPal.
function subscription({ server = 'eu1', until = NOW + 10 * DAY, status = 'completed', product = PQ, testMode = 0, createdAt = NOW - 20 * DAY, who = null } = {}) {
  const buyer = who || user();
  const sub = `I-BILL${String(++seq).padStart(8, '0')}`;
  const paid = status === 'completed';
  const capture = paid ? `SALE-${sub}-1` : null;
  const order = db.prepare(`
    INSERT INTO orders (steam_id, product_id, server_id, status, amount_cents, test_mode, paypal_subscription_id,
                        paypal_capture_id, payer_email, effective_until, created_at, completed_at)
    VALUES (?, ?, ?, ?, 1500, ?, ?, ?, 'buyer@example.invalid', ?, ?, ?)
  `).run(buyer.steamId, product, server, status, testMode, sub, capture, paid ? until : null, createdAt, paid ? createdAt : null).lastInsertRowid;
  return { sub, order, capture, steamId: buyer.steamId, guid: buyer.guid };
}

const row = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);

function reset() {
  for (const t of ['orders', 'paypal_refunds', 'paypal_disputes', 'subscription_cancels', 'subscription_billing_issues', 'admin_audit', 'config_admin_sync_state']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}

// A fake PayPal client. refund and cancel replace the default answers.
function fakePayPal({ refund = null, cancel = null } = {}) {
  const calls = { refunds: [], cancels: [] };
  return {
    calls,
    async refundCapture(testMode, paymentId, opts) {
      calls.refunds.push({ testMode, paymentId, amountCents: opts.amountCents });
      if (refund) return refund(paymentId, opts);
      return { refundId: `RF-${paymentId}`, refundedCents: opts.amountCents, status: 'COMPLETED' };
    },
    async cancelSubscription(testMode, sub, reason) {
      calls.cancels.push({ testMode, sub, reason });
      if (cancel) return cancel(sub);
      return undefined;
    }
  };
}
const httpError = (status) => Object.assign(new Error(`paypal ${status}`), { status });

// The route's side effects, recorded. Emails keep only whether they had a recipient.
function effectsFor(paypal) {
  const got = { cards: [], emails: [], syncs: 0, lapsed: [], removed: [], logs: [] };
  const log = (...a) => got.logs.push(a.join(' '));
  const effects = {
    paypal,
    getOrderWithContext: (id) => db.prepare(`
      SELECT o.*, u.persona, u.platform, u.gamertag, u.bm_player_id, u.bi_uid, p.title AS product_title, p.currency,
             p.grants_priority_queue, p.server_specific
      FROM orders o JOIN users u ON u.steam_id = o.steam_id JOIN products p ON p.id = o.product_id WHERE o.id = ?
    `).get(id),
    sync: () => { got.syncs += 1; },
    removeLapsedRole: (id) => got.lapsed.push(id),
    removeRole: (id) => got.removed.push(id),
    sendCard: (fn) => got.cards.push(fn()),
    sendEmail: (args) => got.emails.push({ reason: args.reason || 'unpaid', hasRecipient: !!args.to, amountCents: args.amountCents == null ? null : args.amountCents, billingStopped: args.billingStopped }),
    logger: { log, warn: log, error: log }
  };
  return { got, effects };
}

// No card spec carries an email address or a full in-game ID, and no log line does.
function assertClean(got) {
  for (const spec of got.cards) {
    const text = JSON.stringify(spec);
    assert.doesNotMatch(text, EMAIL_RE, `${spec.what}: no email address on a card`);
    assert.doesNotMatch(text, UUID_RE, `${spec.what}: no full in-game ID on a card`);
    assert.doesNotMatch(text, /[–—]|dayz/i, spec.what);
  }
  for (const line of got.logs) {
    assert.doesNotMatch(line, EMAIL_RE, 'no email address in a log line');
    assert.doesNotMatch(line, UUID_RE, 'no full in-game ID in a log line');
  }
}

const saleOf = (id, cents = 1500) => ({ id, amount: { total: (cents / 100).toFixed(2), currency: 'USD' } });

// ---- No payment, no subscription --------------------------------------------------------

test('a failed renewal ends the subscription once: cancelled at PayPal, marked unpaid, one card and one email; retries and the daily check add nothing', async () => {
  reset();
  const s = subscription({ until: NOW - HOUR });
  assert.equal(pqEntitlement.holdsPq(db, { biUid: s.guid, serverId: 'eu1', now: NOW }), true, 'inside its renewal window before the failure');
  const pp = fakePayPal();
  const { got, effects } = effectsFor(pp);
  const billingInfo = {
    failed_payments_count: 1, outstanding_balance: { value: '15.00', currency_code: 'USD' },
    last_payment: { time: iso(NOW - 31 * DAY) }, next_billing_time: iso(NOW + 5 * DAY)
  };
  const input = { subscriptionId: s.sub, billingInfo, paypalStatus: 'ACTIVE', source: 'webhook', now: NOW };

  const plan = await ev.endUnpaidSubscription(db, input, effects);
  assert.equal(plan.action, 'ended');
  assert.equal(plan.cancel.outcome, 'cancelled');
  assert.deepEqual(pp.calls.cancels.map(c => [c.sub, c.reason]), [[s.sub, 'Renewal payment not received']]);
  const o = row(s.order);
  assert.equal(o.subscription_ended_reason, 'unpaid');
  assert.equal(o.subscription_cancelled_at, NOW);
  assert.equal(o.status, 'completed', 'the paid cycle stays in the books');
  assert.equal(pqEntitlement.holdsPq(db, { biUid: s.guid, serverId: 'eu1', now: NOW }), false, 'no renewal window once it has ended');

  const issue = db.prepare('SELECT * FROM subscription_billing_issues WHERE paypal_subscription_id = ?').get(s.sub);
  assert.equal(issue.failed_count, 1);
  assert.equal(issue.outstanding_cents, 1500);
  assert.equal(issue.resolved_at, NOW, 'the failure is kept as history, not left open');
  assert.equal(issue.player_emailed_at, NOW);
  assert.equal(issue.notified_at, NOW);

  assert.deepEqual(got.cards.map(c => [c.what, c.kind]), [['Subscription ended, payment not received', 'ended']]);
  assert.equal(got.emails.length, 1);
  assert.equal(got.emails[0].hasRecipient, true);
  assert.equal(got.emails[0].billingStopped, true, 'PayPal confirmed the cancel');
  assert.equal(got.syncs, 1);
  assert.deepEqual(got.lapsed, [s.order]);

  // The CANCELLED webhook PayPal sends back finds the shop's marker and stays quiet.
  const marker = ev.shopCancelFor(db, s.sub, NOW + 60);
  assert.equal(marker.source, 'unpaid');
  assert.deepEqual(ev.endedNotices({ shopCancel: marker }), { card: false, email: false, claimAccess: false });
  // And its paid-through floor never hands the slot back.
  assert.equal(ev.applyPaidThroughFloor(db, { subscriptionId: s.sub, floor: NOW + 30 * DAY, lastPaymentAt: NOW }).skipped, 'ended_by_shop');
  assert.equal(row(s.order).effective_until, NOW - HOUR);

  for (const again of [
    input,
    { ...input, billingInfo: { ...billingInfo, failed_payments_count: 2 }, now: NOW + DAY },
    { ...input, source: 'reconcile', now: NOW + 2 * DAY }
  ]) {
    assert.equal((await ev.endUnpaidSubscription(db, again, effects)).action, 'already_ended');
  }
  assert.equal(pp.calls.cancels.length, 1);
  assert.equal(got.cards.length, 1);
  assert.equal(got.emails.length, 1);
  assertClean(got);
});

test('only an ACTIVE agreement that paid is ended; a cancel PayPal refuses still ends it here and makes the card red', async () => {
  reset();
  const { got, effects } = effectsFor(fakePayPal());
  const suspended = subscription({ until: NOW - DAY });
  assert.equal((await ev.endUnpaidSubscription(db, { subscriptionId: suspended.sub, billingInfo: { failed_payments_count: 3 }, paypalStatus: 'SUSPENDED', now: NOW }, effects)).action, 'not_active');
  const neverPaid = subscription({ status: 'pending', createdAt: NOW - DAY });
  const noCycles = { failed_payments_count: 1, cycle_executions: [{ tenure_type: 'REGULAR', cycles_completed: 0 }] };
  assert.equal((await ev.endUnpaidSubscription(db, { subscriptionId: neverPaid.sub, billingInfo: noCycles, now: NOW }, effects)).action, 'never_paid');
  assert.equal((await ev.endUnpaidSubscription(db, { subscriptionId: 'I-NOBODY', billingInfo: { failed_payments_count: 1 }, now: NOW }, effects)).action, 'no_orders');
  assert.equal((await ev.endUnpaidSubscription(db, {}, effects)).action, 'ignored');
  assert.equal(row(suspended.order).subscription_ended_reason, null);
  assert.equal(row(neverPaid.order).subscription_ended_reason, null);
  assert.equal(got.cards.length + got.emails.length + effects.paypal.calls.cancels.length, 0);

  const refused = subscription({ until: NOW - HOUR });
  const r = effectsFor(fakePayPal({ cancel: () => { throw httpError(400); } }));
  const plan = await ev.endUnpaidSubscription(db, { subscriptionId: refused.sub, billingInfo: { failed_payments_count: 1 }, now: NOW }, r.effects);
  assert.equal(plan.action, 'ended');
  assert.equal(plan.cancel.outcome, 'failed');
  assert.equal(row(refused.order).subscription_ended_reason, 'unpaid');
  assert.equal(r.got.cards[0].kind, 'action');
  assert.match(r.got.cards[0].description, /refused to cancel the subscription \(HTTP 400\).*cancel it in PayPal/);
  assert.equal(ev.shopCancelFor(db, refused.sub, NOW), null, 'a refused cancel leaves no quiet marker behind');
  assert.deepEqual(r.got.emails.map(e => [e.reason, e.billingStopped]), [['unpaid', false]], 'the player is not told PayPal will not charge again');
  // Staff cancelling it in PayPal afterwards, or PayPal suspending it, sends nothing more.
  assert.deepEqual(ev.endedNotices({ shopCancel: ev.shopCancelFor(db, refused.sub, NOW), shopEnded: ev.shopEndedReason(db, refused.sub) }), { card: false, email: false, claimAccess: false });
  assertClean(r.got);
});

test('a failed payment on a subscription that is not priority queue is recorded and left to PayPal', async () => {
  reset();
  const backer = subscription({ product: SUPPORTER, server: null, until: NOW + 5 * DAY });
  const pp = fakePayPal();
  const { got, effects } = effectsFor(pp);
  const billingInfo = { failed_payments_count: 1, outstanding_balance: { value: '10.00', currency_code: 'USD' } };
  const plan = await ev.endUnpaidSubscription(db, { subscriptionId: backer.sub, billingInfo, now: NOW }, effects);
  assert.equal(plan.action, 'not_priority_queue');
  assert.equal(row(backer.order).subscription_cancelled_at, null, 'not ended');
  assert.equal(row(backer.order).subscription_ended_reason, null);
  const issue = db.prepare('SELECT * FROM subscription_billing_issues WHERE paypal_subscription_id = ?').get(backer.sub);
  assert.equal(issue.failed_count, 1);
  assert.equal(issue.resolved_at, null, 'left open for the Billing Issues tab while PayPal retries');
  assert.equal(pp.calls.cancels.length + got.cards.length + got.emails.length + got.syncs + got.lapsed.length, 0);
  assert.equal((await ev.endUnpaidSubscription(db, { subscriptionId: backer.sub, billingInfo, source: 'reconcile', now: NOW + DAY }, effects)).action, 'not_priority_queue', 'the daily check leaves it alone too');
  assert.equal(pp.calls.cancels.length, 0);
});

test('the daily check cancels a subscription the shop ended when PayPal still has it, and asks only about recent ones', async () => {
  reset();
  const stuck = subscription({ until: NOW - HOUR });
  const refusing = effectsFor(fakePayPal({ cancel: () => { throw httpError(400); } }));
  await ev.endUnpaidSubscription(db, { subscriptionId: stuck.sub, billingInfo: { failed_payments_count: 1 }, now: NOW }, refusing.effects);
  const done = subscription({ server: 'eu2', until: NOW - HOUR });
  await ev.endUnpaidSubscription(db, { subscriptionId: done.sub, billingInfo: { failed_payments_count: 1 }, now: NOW }, effectsFor(fakePayPal()).effects);
  const old = subscription({ server: 'na1', until: NOW - 60 * DAY });
  await ev.endUnpaidSubscription(db, { subscriptionId: old.sub, billingInfo: { failed_payments_count: 1 }, now: NOW - 50 * DAY }, effectsFor(fakePayPal({ cancel: () => { throw httpError(400); } })).effects);
  const live = subscription({ server: 'na2' });

  const pp = fakePayPal();
  pp.isConfigured = () => true;
  const asked = [];
  pp.getSubscription = async (testMode, id) => { asked.push(id); return { status: id === done.sub ? 'CANCELLED' : 'ACTIVE' }; };
  const logs = [];
  const logger = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
  const out = await reconcile.recheckShopEndedCancels({ db, paypal: pp, now: NOW + DAY, pauseMs: 0, logger });
  assert.deepEqual(asked.sort(), [stuck.sub, done.sub].sort(), 'not a live subscription, and not one ended more than 45 days ago');
  assert.deepEqual(out.cancelled, [stuck.sub]);
  assert.deepEqual(pp.calls.cancels.map(c => [c.sub, c.reason]), [[stuck.sub, 'Renewal payment not received']]);
  assert.equal(ev.shopCancelFor(db, stuck.sub, NOW + DAY).source, 'unpaid', 'its CANCELLED webhook stays quiet');
  assert.equal(row(live.order).subscription_cancelled_at, null);

  const still = fakePayPal({ cancel: () => { throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }); } });
  still.isConfigured = () => true;
  still.getSubscription = async () => ({ status: 'SUSPENDED' });
  const again = await reconcile.recheckShopEndedCancels({ db, paypal: still, now: NOW + DAY, pauseMs: 0, logger });
  assert.deepEqual(again.stillOpen.map(x => x.outcome), ['unknown', 'unknown']);
  assert.ok(logs.some(l => /still SUSPENDED at PayPal.*got no answer.*cancel it in PayPal/.test(l)));
  for (const line of logs) {
    assert.doesNotMatch(line, EMAIL_RE);
    assert.doesNotMatch(line, UUID_RE);
  }
});

// ---- A payment the shop cannot honour ------------------------------------------------------

test('a renewal inside its window books on a full server; a late one on a full server is refunded and cancelled once; a free server books it', async () => {
  reset();
  // EU1 is full: two holders against a cap of 2, one of them renewing now.
  const renewer = subscription({ server: 'eu1', until: NOW - HOUR });
  subscription({ server: 'eu1', until: NOW + 10 * DAY });
  assert.equal(pqEntitlement.pqSlotFree(db, { serverId: 'eu1', now: NOW, productId: PQ }).free, false);
  assert.deepEqual(ev.saleBookingDecision(db, { subscriptionId: renewer.sub, resource: { id: 'SALE-ONTIME', create_time: iso(NOW) }, now: NOW }), { book: true, reason: 'slot' });

  // Seven hours after the due time the window has closed, and a new buyer took the slot.
  const late = NOW + 6 * HOUR;
  subscription({ server: 'eu1', until: NOW + 30 * DAY });
  const decision = ev.saleBookingDecision(db, { subscriptionId: renewer.sub, resource: { id: 'SALE-LATE', create_time: iso(late) }, now: late });
  assert.deepEqual(decision, { book: false, reason: 'no_slot', firstPayment: false, serverId: 'eu1', slot: { limit: 2, used: 2, reserved: 0 } });

  const pp = fakePayPal();
  const { got, effects } = effectsFor(pp);
  const resource = { ...saleOf('SALE-LATE'), billing_agreement_id: renewer.sub, create_time: iso(late) };
  const plan = await ev.refuseSale(db, { subscriptionId: renewer.sub, resource, decision, now: late }, effects);
  assert.equal(plan.action, 'refused');
  assert.deepEqual(pp.calls.refunds, [{ testMode: false, paymentId: 'SALE-LATE', amountCents: 1500 }]);
  assert.deepEqual(pp.calls.cancels.map(c => [c.sub, c.reason]), [[renewer.sub, 'Payment refunded: no priority queue slot free']]);
  const refunds = db.prepare('SELECT * FROM paypal_refunds WHERE payment_id = ?').all('SALE-LATE');
  assert.equal(refunds.length, 1);
  assert.deepEqual([refunds[0].refund_id, refunds[0].source, refunds[0].order_id, refunds[0].amount_cents, refunds[0].kind], ['RF-SALE-LATE', 'shop', null, 1500, 'refund']);
  assert.equal(row(renewer.order).subscription_ended_reason, 'no_slot');
  assert.equal(ev.shopCancelFor(db, renewer.sub, late).source, 'no_slot');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE paypal_capture_id = ?').get('SALE-LATE').n, 0, 'no cycle was booked');
  assert.deepEqual(got.cards.map(c => [c.what, c.kind]), [['Payment refunded, server full', 'refund_out']]);
  assert.deepEqual(got.emails.map(e => [e.reason, e.amountCents]), [['no_slot', 1500]]);

  // A retry of the sale refunds nothing twice.
  assert.equal((await ev.refuseSale(db, { subscriptionId: renewer.sub, resource, decision, now: late + 60 }, effects)).action, 'duplicate');
  assert.equal(pp.calls.refunds.length, 1);
  assert.equal(got.cards.length, 1);
  assert.equal(got.emails.length, 1);

  // A later payment on it is refused as ended, and the refund webhook is an echo,
  // whether it arrives with the refund's id or before that id was stored.
  assert.deepEqual(ev.saleBookingDecision(db, { subscriptionId: renewer.sub, resource: { id: 'SALE-AGAIN' }, now: late }), { book: false, reason: 'ended_no_slot' });
  for (const refundId of ['RF-SALE-LATE', 'RF-ARRIVED-EARLY']) {
    const echo = ev.applyRefundEvent(db, { eventType: 'PAYMENT.SALE.REFUNDED', resource: { id: refundId, sale_id: 'SALE-LATE', amount: { total: '-15.00', currency: 'USD' } }, now: late + 120 });
    assert.equal(echo.action, 'duplicate', refundId);
  }
  // PayPal's CANCELLED webhook is quiet, and the refunded payment never extends access.
  assert.deepEqual(ev.endedNotices({ shopCancel: ev.shopCancelFor(db, renewer.sub, late + 60) }), { card: false, email: false, claimAccess: false });
  assert.equal(ev.applyPaidThroughFloor(db, { subscriptionId: renewer.sub, floor: late + 30 * DAY, lastPaymentAt: late }).skipped, 'ended_by_shop');
  assert.equal(row(renewer.order).effective_until, NOW - HOUR);

  // The same late payment on a server with a free slot books.
  const eu2 = subscription({ server: 'eu2', until: NOW - HOUR });
  assert.deepEqual(ev.saleBookingDecision(db, { subscriptionId: eu2.sub, resource: { id: 'SALE-EU2' }, now: late }), { book: true, reason: 'slot' });
  assertClean(got);
});

test("a first cycle's own payment books, another product never needs a slot, and a subscription with no order is not decided here", () => {
  reset();
  subscription({ server: 'eu1' });
  const first = subscription({ server: 'eu1', until: NOW + 29 * DAY, createdAt: NOW - HOUR });
  db.prepare('UPDATE orders SET paypal_capture_id = NULL WHERE id = ?').run(first.order);
  subscription({ server: 'eu1' });
  assert.deepEqual(ev.saleBookingDecision(db, { subscriptionId: first.sub, resource: { id: 'SALE-1ST', create_time: iso(NOW) }, now: NOW }), { book: true, reason: 'first_cycle' });
  const supporter = subscription({ product: SUPPORTER, server: null, until: NOW - 3 * DAY });
  assert.deepEqual(ev.saleBookingDecision(db, { subscriptionId: supporter.sub, resource: { id: 'SALE-SUP' }, now: NOW }), { book: true, reason: 'no_slot_needed' });
  const sandbox = subscription({ server: 'eu1', until: NOW - 3 * DAY, testMode: 1 });
  assert.deepEqual(ev.saleBookingDecision(db, { subscriptionId: sandbox.sub, resource: { id: 'SALE-SBX' }, now: NOW }), { book: true, reason: 'no_slot_needed' });
  assert.deepEqual(ev.saleBookingDecision(db, { subscriptionId: 'I-NONE', resource: { id: 'SALE-NONE' }, now: NOW }), { book: null, reason: 'no_order' });
});

test('a payment on a subscription the shop took back and ended is refunded; one it never ended is left to staff', async () => {
  reset();
  const revoked = subscription({ server: 'eu1' });
  db.prepare("UPDATE orders SET status = 'refunded', subscription_cancelled_at = ?, subscription_ended_reason = 'cancelled' WHERE id = ?").run(NOW - DAY, revoked.order);
  const decision = ev.saleBookingDecision(db, { subscriptionId: revoked.sub, resource: { id: 'SALE-REVOKED' }, now: NOW });
  assert.deepEqual(decision, { book: false, reason: 'revoked' });

  const pp = fakePayPal();
  const { got, effects } = effectsFor(pp);
  const plan = await ev.refuseSale(db, { subscriptionId: revoked.sub, resource: saleOf('SALE-REVOKED'), decision, now: NOW }, effects);
  assert.equal(plan.refund.outcome, 'refunded');
  assert.deepEqual(pp.calls.refunds.map(r => r.paymentId), ['SALE-REVOKED']);
  assert.deepEqual(pp.calls.cancels.map(c => [c.sub, c.reason]), [[revoked.sub, 'Payment refunded: the subscription had ended']]);
  assert.equal(ev.shopCancelFor(db, revoked.sub, NOW).source, 'revoked');
  assert.deepEqual(ev.endedNotices({ shopCancel: ev.shopCancelFor(db, revoked.sub, NOW) }), { card: false, email: false, claimAccess: false });
  assert.equal(row(revoked.order).subscription_ended_reason, 'cancelled', 'the reason it already had is kept');
  assert.equal(row(revoked.order).status, 'refunded');
  assert.deepEqual(got.cards.map(c => [c.what, c.kind]), [['Payment refunded, subscription had ended', 'refund_out']]);
  assert.deepEqual(got.emails.map(e => [e.reason, e.billingStopped]), [['revoked', true]]);
  assert.equal((await ev.refuseSale(db, { subscriptionId: revoked.sub, resource: saleOf('SALE-REVOKED'), decision, now: NOW + 60 }, effects)).action, 'duplicate');
  assert.deepEqual(ev.saleBookingDecision(db, { subscriptionId: revoked.sub, resource: { id: 'SALE-REVOKED-2' }, now: NOW + 30 * DAY }), { book: false, reason: 'revoked' }, 'every later payment too');
  assertClean(got);

  // Lost in a dispute and never marked ended: the money went back, so a payment is refunded.
  const disputed = subscription({ server: 'eu2' });
  db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(disputed.order);
  const addDispute = db.prepare("INSERT INTO paypal_disputes (dispute_id, order_id, payment_id, status, outcome, created_at, updated_at) VALUES (?, ?, ?, 'RESOLVED', ?, ?, ?)");
  addDispute.run('PP-D-GONE', disputed.order, disputed.capture, 'RESOLVED_BUYER_FAVOUR', NOW, NOW);
  assert.deepEqual(ev.saleBookingDecision(db, { subscriptionId: disputed.sub, resource: { id: 'SALE-DISPUTED' }, now: NOW }), { book: false, reason: 'revoked' });

  // Taken back but never ended by the shop, even with a dispute it won: staff decide.
  const leftBilling = subscription({ server: 'na1' });
  db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(leftBilling.order);
  addDispute.run('PP-D-KEPT', leftBilling.order, leftBilling.capture, 'RESOLVED_SELLER_FAVOUR', NOW, NOW);
  assert.deepEqual(ev.saleBookingDecision(db, { subscriptionId: leftBilling.sub, resource: { id: 'SALE-LEFT' }, now: NOW }), { book: null, reason: 'no_order' });
  assert.equal(ev.subscriptionStoppedByShop(db, leftBilling.sub), false);
  assert.equal(ev.subscriptionStoppedByShop(db, 'I-NONE'), false);
});

test("a holder's in-game ID typed into another account gives no pass at activation or on a late payment", () => {
  reset();
  const holder = subscription({ server: 'eu1' });
  subscription({ server: 'eu1' });
  const borrower = user();
  db.prepare('UPDATE users SET bi_uid = ? WHERE steam_id = ?').run(holder.guid, borrower.steamId);
  const attempt = subscription({ server: 'eu1', status: 'pending', createdAt: NOW - 60, who: { steamId: borrower.steamId, guid: holder.guid } });
  const verdict = ev.claimActivation(db, { orderId: attempt.order, now: NOW });
  assert.deepEqual([verdict.refuse, verdict.reason], [true, 'no_slot']);

  const lapsed = subscription({ server: 'eu1', until: NOW - 7 * HOUR });
  db.prepare('UPDATE users SET bi_uid = ? WHERE steam_id = ?').run(holder.guid, lapsed.steamId);
  const late = ev.saleBookingDecision(db, { subscriptionId: lapsed.sub, resource: { id: 'SALE-BORROWED', create_time: iso(NOW) }, now: NOW });
  assert.deepEqual([late.book, late.reason], [false, 'no_slot']);
});

test('a payment on a subscription ended for non-payment is refunded; a refund PayPal refuses or does not answer is reported and never tried twice', async () => {
  reset();
  const s = subscription({ until: NOW - 2 * DAY });
  await ev.endUnpaidSubscription(db, { subscriptionId: s.sub, billingInfo: { failed_payments_count: 1 }, now: NOW }, effectsFor(fakePayPal()).effects);
  const decision = ev.saleBookingDecision(db, { subscriptionId: s.sub, resource: { id: 'SALE-RETRY' }, now: NOW + 5 * DAY });
  assert.deepEqual(decision, { book: false, reason: 'ended_unpaid' });

  const ok = effectsFor(fakePayPal());
  const plan = await ev.refuseSale(db, { subscriptionId: s.sub, resource: saleOf('SALE-RETRY', 3000), decision, now: NOW + 5 * DAY }, ok.effects);
  assert.equal(plan.refund.outcome, 'refunded');
  assert.deepEqual(ok.got.emails.map(e => [e.reason, e.amountCents]), [['ended_unpaid', 3000]]);
  assert.deepEqual(ok.got.cards.map(c => [c.what, c.kind]), [['Payment refunded, subscription had ended', 'refund_out']]);
  assert.equal(row(s.order).subscription_ended_reason, 'unpaid', 'the first reason is kept');
  assert.equal(ev.shopCancelFor(db, s.sub, NOW + 5 * DAY).source, 'unpaid');

  // PayPal refuses the refund: the claim goes, so the daily check lists the payment as unbooked.
  const refused = effectsFor(fakePayPal({ refund: () => { throw httpError(422); } }));
  const p2 = await ev.refuseSale(db, { subscriptionId: s.sub, resource: saleOf('SALE-REFUSED'), decision, now: NOW + 6 * DAY }, refused.effects);
  assert.equal(p2.refund.outcome, 'failed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paypal_refunds WHERE payment_id = ?').get('SALE-REFUSED').n, 0);
  assert.deepEqual(refused.got.cards.map(c => [c.what, c.kind]), [['Refund failed, subscription had ended', 'action']]);
  assert.match(refused.got.cards[0].description, /refused the automatic refund \(HTTP 422\).*refund it in PayPal/);
  assert.equal(refused.got.emails.length, 0, 'nobody is told money went back when it did not');

  // No answer: the claim stays, so a retry never refunds a second time.
  const silent = effectsFor(fakePayPal({ refund: () => { throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }); } }));
  const p3 = await ev.refuseSale(db, { subscriptionId: s.sub, resource: saleOf('SALE-SILENT'), decision, now: NOW + 7 * DAY }, silent.effects);
  assert.equal(p3.refund.outcome, 'unknown');
  assert.deepEqual(silent.got.cards.map(c => [c.what, c.kind]), [['Refund state unknown, subscription had ended', 'attention']]);
  assert.equal(silent.got.emails.length, 0);
  assert.equal((await ev.refuseSale(db, { subscriptionId: s.sub, resource: saleOf('SALE-SILENT'), decision, now: NOW + 7 * DAY + 60 }, silent.effects)).action, 'duplicate');
  assert.equal(silent.effects.paypal.calls.refunds.length, 1);
  assertClean(ok.got);
  assertClean(refused.got);
  assertClean(silent.got);
});

// ---- A subscription activating on a full server ----------------------------------------------

test('a subscription that activates on a full server is not started, and its first payment is refunded with no second email', async () => {
  reset();
  const holder = subscription({ server: 'eu1' });
  subscription({ server: 'eu1' });
  const buyer = subscription({ server: 'eu1', status: 'pending', createdAt: NOW - 60 });
  const verdict = ev.claimActivation(db, { orderId: buyer.order, now: NOW });
  assert.equal(verdict.refuse, true);
  assert.equal(verdict.claimed, true);
  assert.equal(verdict.reason, 'no_slot');
  assert.equal(verdict.serverId, 'eu1');
  assert.deepEqual(verdict.slot, { limit: 2, used: 2, reserved: 0 });
  assert.equal(row(buyer.order).status, 'cancelled', 'not fulfilled, and its reservation is released');
  assert.equal(row(buyer.order).subscription_ended_reason, 'no_slot');
  const again = ev.claimActivation(db, { orderId: buyer.order, now: NOW + 5 });
  assert.deepEqual([again.refuse, again.claimed, again.reason], [true, false, 'ended_no_slot'], 'the return page and the webhook both arriving');

  const pp = fakePayPal();
  const { got, effects } = effectsFor(pp);
  const report = await ev.reportRefusedActivation(db, { verdict, payerEmail: 'payer@example.invalid', now: NOW }, effects);
  assert.equal(report.cancel.outcome, 'cancelled');
  assert.deepEqual(pp.calls.cancels.map(c => c.sub), [buyer.sub]);
  assert.equal(ev.shopCancelFor(db, buyer.sub, NOW).source, 'no_slot');
  assert.deepEqual(got.cards.map(c => [c.what, c.kind]), [['Subscription not started, server full', 'ended']]);
  assert.deepEqual(got.emails.map(e => e.reason), ['activation']);

  const decision = ev.saleBookingDecision(db, { subscriptionId: buyer.sub, resource: { id: 'SALE-FIRST' }, now: NOW + 30 });
  assert.deepEqual(decision, { book: false, reason: 'ended_no_slot' });
  const plan = await ev.refuseSale(db, { subscriptionId: buyer.sub, resource: saleOf('SALE-FIRST'), decision, now: NOW + 30 }, effects);
  assert.equal(plan.refund.outcome, 'refunded');
  assert.equal(got.emails.length, 1, 'the player was told when it was not started');
  assert.equal(got.cards.length, 2);
  assert.deepEqual(ev.claimActivation(db, { orderId: holder.order, now: NOW }), { refuse: false, reason: 'already_done' });

  // A first payment that lands before activation on a full server is refunded as one.
  const early = subscription({ server: 'eu1', status: 'pending', createdAt: NOW - 60 });
  const earlyDecision = ev.saleBookingDecision(db, { subscriptionId: early.sub, resource: { id: 'SALE-EARLY' }, now: NOW });
  assert.deepEqual([earlyDecision.book, earlyDecision.reason, earlyDecision.firstPayment], [false, 'no_slot', true]);
  const earlyFx = effectsFor(fakePayPal());
  await ev.refuseSale(db, { subscriptionId: early.sub, resource: saleOf('SALE-EARLY'), decision: earlyDecision, now: NOW }, earlyFx.effects);
  assert.deepEqual(earlyFx.got.emails.map(e => e.reason), ['first_payment']);
  assert.equal(row(early.order).status, 'cancelled');
  assert.equal(ev.claimActivation(db, { orderId: early.order, now: NOW + 10 }).claimed, false, 'the ACTIVATED webhook that follows reports nothing again');
  assertClean(got);
  assertClean(earlyFx.got);
});

test("activation counts other buyers' waiting checkouts but never the buyer's own, and passes sandbox and a player who already holds the slot", () => {
  reset();
  // One slot left on EU2: the buyer's own waiting checkout does not count against itself.
  subscription({ server: 'eu2' });
  const own = subscription({ server: 'eu2', status: 'pending', createdAt: NOW - 60 });
  assert.deepEqual(ev.claimActivation(db, { orderId: own.order, now: NOW }), { refuse: false, reason: 'ok' });

  // One slot left on NA1, held by another buyer still at PayPal.
  subscription({ server: 'na1' });
  subscription({ server: 'na1', status: 'pending', createdAt: NOW - 120 });
  const second = subscription({ server: 'na1', status: 'pending', createdAt: NOW - 60 });
  const held = ev.claimActivation(db, { orderId: second.order, now: NOW });
  assert.equal(held.refuse, true);
  assert.deepEqual(held.slot, { limit: 2, used: 1, reserved: 1 });

  // A reservation older than CHECKOUT_RESERVATION_S holds nothing.
  subscription({ server: 'na2' });
  subscription({ server: 'na2', status: 'pending', createdAt: NOW - pqEntitlement.CHECKOUT_RESERVATION_S - 60 });
  const afterAbandoned = subscription({ server: 'na2', status: 'pending', createdAt: NOW - 60 });
  assert.equal(ev.claimActivation(db, { orderId: afterAbandoned.order, now: NOW }).refuse, false);

  // EU1 full: sandbox and a holder buying again still activate.
  const a = subscription({ server: 'eu1' });
  subscription({ server: 'eu1' });
  const sandbox = subscription({ server: 'eu1', status: 'pending', createdAt: NOW - 60, testMode: 1 });
  assert.equal(ev.claimActivation(db, { orderId: sandbox.order, now: NOW }).refuse, false);
  const again = subscription({ server: 'eu1', status: 'pending', createdAt: NOW - 60, who: { steamId: a.steamId, guid: a.guid } });
  assert.equal(ev.claimActivation(db, { orderId: again.order, now: NOW }).refuse, false, 'buying again takes no new slot');
  assert.deepEqual(ev.claimActivation(db, { orderId: 999999, now: NOW }), { refuse: false, reason: 'no_order' });
});

test('of two checkouts for the last slot the earlier activates even while the later is still at PayPal', () => {
  reset();
  subscription({ server: 'eu2' });
  const earlier = subscription({ server: 'eu2', status: 'pending', createdAt: NOW - 120 });
  const later = subscription({ server: 'eu2', status: 'pending', createdAt: NOW - 60 });
  assert.deepEqual(ev.claimActivation(db, { orderId: earlier.order, now: NOW }), { refuse: false, reason: 'ok' }, 'the later checkout does not push out the earlier');
  const second = ev.claimActivation(db, { orderId: later.order, now: NOW });
  assert.deepEqual([second.refuse, second.reason], [true, 'no_slot'], 'the earlier one still holds its slot at PayPal');
});

// ---- A dispute the shop lost ----------------------------------------------------------------

test('a lost dispute revokes the order and removes its perks once; an open or won dispute changes nothing', async () => {
  reset();
  const s = subscription({ server: 'eu1' });
  const other = subscription({ server: 'eu2' });
  const { got, effects } = effectsFor(fakePayPal());
  const dispute = (id, saleId, extra = {}) => ({
    dispute_id: id, reason: 'UNAUTHORISED', status: 'OPEN', dispute_amount: { currency_code: 'USD', value: '15.00' },
    disputed_transactions: [{ seller_transaction_id: saleId }], ...extra
  });
  const send = (eventType, resource, now = NOW) => ev.handleDisputeEvent(db, { eventType, resource, now }, effects);
  const lostOutcome = { status: 'RESOLVED', dispute_outcome: { outcome_code: 'RESOLVED_BUYER_FAVOUR', amount_refunded: { currency_code: 'USD', value: '15.00' } } };

  await send('CUSTOMER.DISPUTE.CREATED', dispute('PP-D-LOST', s.capture));
  await send('CUSTOMER.DISPUTE.UPDATED', dispute('PP-D-LOST', s.capture, { status: 'UNDER_REVIEW' }));
  assert.equal(row(s.order).status, 'completed', 'an open dispute changes nothing');
  assert.equal(got.removed.length + got.syncs, 0);

  const lost = await send('CUSTOMER.DISPUTE.RESOLVED', dispute('PP-D-LOST', s.capture, lostOutcome), NOW + DAY);
  assert.equal(lost.result, 'lost');
  assert.deepEqual(lost.revoke, { revoked: true, reason: 'dispute_lost', status: 'refunded' });
  assert.equal(row(s.order).status, 'refunded');
  assert.equal(row(s.order).revoked_without_refund_at, null, 'the money did go back');
  assert.equal(pqEntitlement.holdsPq(db, { biUid: s.guid, serverId: 'eu1', now: NOW + DAY }), false);
  const audit = db.prepare("SELECT * FROM admin_audit WHERE action = 'order.revoke'").all();
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].actor, audit[0].reason, audit[0].target, audit[0].ts], ['paypal', 'dispute_lost', s.steamId, NOW + DAY]);
  assert.deepEqual(JSON.parse(audit[0].after_json), { order_id: s.order, status: 'refunded', dispute_id: 'PP-D-LOST' });
  assert.deepEqual(got.removed, [s.order]);
  assert.equal(got.syncs, 1);
  const card = got.cards[got.cards.length - 1];
  assert.deepEqual([card.what, card.kind], ['Dispute lost', 'refund_out']);
  assert.match(card.description, /perks were removed automatically.*cancel it in PayPal/);

  const repeat = await send('CUSTOMER.DISPUTE.RESOLVED', dispute('PP-D-LOST', s.capture, lostOutcome), NOW + 2 * DAY);
  assert.ok(!repeat.revoke, 'a repeat of the resolution revokes nothing again');
  assert.equal(got.removed.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'order.revoke'").get().n, 1);

  await send('CUSTOMER.DISPUTE.CREATED', dispute('PP-D-WON', other.capture));
  const won = await send('CUSTOMER.DISPUTE.RESOLVED', dispute('PP-D-WON', other.capture, { status: 'RESOLVED', dispute_outcome: { outcome_code: 'RESOLVED_SELLER_FAVOUR' } }));
  assert.equal(won.result, 'won');
  assert.equal(won.revoke, null);
  assert.equal(row(other.order).status, 'completed');

  // Lost on an order staff had already refunded: nothing more changes.
  const refunded = subscription({ server: 'na1' });
  db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(refunded.order);
  const already = await send('CUSTOMER.DISPUTE.RESOLVED', dispute('PP-D-LATE', refunded.capture, { status: 'RESOLVED', dispute_outcome: { outcome_code: 'ACCEPTED' } }));
  assert.deepEqual(already.revoke, { revoked: false, reason: 'not_completed', status: 'refunded' });
  assert.equal(got.removed.length, 1);
  assert.match(got.cards[got.cards.length - 1].description, /already refunded, so nothing on it changed/);
  assertClean(got);
});

// ---- The daily PayPal check -----------------------------------------------------------------

test('the daily PayPal check ends a failing agreement through the same path, once', async () => {
  reset();
  const failing = subscription({ until: NOW - 3 * HOUR });
  const healthy = subscription({ server: 'eu2' });
  const pp = fakePayPal();
  pp.isConfigured = () => true;
  pp.getSubscription = async (testMode, id) => (id === failing.sub
    ? { status: 'ACTIVE', billing_info: { failed_payments_count: 1 } }
    : { status: 'ACTIVE', billing_info: { failed_payments_count: 0 } });
  const { got, effects } = effectsFor(pp);
  const end = (input) => ev.endUnpaidSubscription(db, input, effects);

  const out = await reconcile.endFailingSubscriptions({ db, paypal: pp, end, now: NOW, pauseMs: 0, logger: effects.logger });
  assert.equal(out.ok, true);
  assert.deepEqual(out.ended, [failing.sub]);
  assert.equal(row(failing.order).subscription_ended_reason, 'unpaid');
  assert.equal(row(healthy.order).subscription_ended_reason, null);
  assert.match(got.cards[0].description, /daily PayPal check/);

  const second = await reconcile.endFailingSubscriptions({ db, paypal: pp, end, now: NOW + DAY, pauseMs: 0, logger: effects.logger });
  assert.deepEqual(second.ended, []);
  assert.ok(!second.failing.some(f => f.subscriptionId === failing.sub), 'an ended subscription is no longer asked about');
  assert.equal(pp.calls.cancels.length, 1);
  assert.equal(got.emails.length, 1);
  assertClean(got);
});

// ---- The player's emails ----------------------------------------------------------------------

test('the ended and refund emails say what happened in plain English, with no dashes', () => {
  const mails = [];
  const unpaid = subscriptionUnpaidEmail({ displayName: 'Nightfall', productTitle: 'Priority Queue', serverLabel: 'EU1', priorityQueue: true, accessEndsAt: NOW - HOUR, now: NOW * 1000 });
  assert.equal(unpaid.subject, 'Your ReforgedZ Priority Queue has ended');
  assert.match(unpaid.text, /did not go through, so your Priority Queue has ended\. PayPal will not charge you for it again\./);
  assert.match(unpaid.text, /It ended on /);
  assert.match(unpaid.text, /if a slot is free on your server/);
  assert.match(unpaid.html, /<strong>/);
  const paidUp = subscriptionUnpaidEmail({ productTitle: 'Supporter', accessEndsAt: NOW + 5 * DAY, now: NOW * 1000 });
  assert.match(paidUp.text, /^Hi there,/);
  assert.match(paidUp.text, /You keep it until .*, the end of the period you already paid for\./);
  assert.doesNotMatch(paidUp.text, /slot/);
  mails.push(unpaid, paidUp, subscriptionUnpaidEmail({}));

  for (const reason of ['no_slot', 'first_payment', 'ended_unpaid', 'revoked', 'activation']) {
    const m = paymentRefusedEmail({ displayName: 'Nightfall', productTitle: 'Priority Queue', serverLabel: 'EU1', amountCents: 1500, currency: 'USD', reason });
    assert.match(m.subject, reason === 'activation' ? /^Your ReforgedZ Priority Queue could not start$/ : /^We refunded your ReforgedZ Priority Queue payment$/);
    assert.match(m.text, /PayPal will not charge you for it again/);
    assert.match(m.text, /when a slot is free/);
    if (reason !== 'activation') assert.match(m.text, /15\.00 USD/);
    mails.push(m);
    // When PayPal did not confirm the cancel, nobody is promised billing has stopped.
    const open = paymentRefusedEmail({ productTitle: 'Priority Queue', serverLabel: 'EU1', amountCents: 1500, currency: 'USD', reason, billingStopped: false });
    assert.doesNotMatch(open.text, /will not charge/, reason);
    assert.match(open.text, /we refund it (in full )?automatically/, reason);
    mails.push(open);
  }
  assert.throws(() => paymentRefusedEmail({ reason: 'nope' }), /unknown refused payment reason/);
  const unpaidOpen = subscriptionUnpaidEmail({ productTitle: 'Priority Queue', priorityQueue: true, billingStopped: false });
  assert.doesNotMatch(unpaidOpen.text, /will not charge/);
  assert.match(unpaidOpen.text, /has ended\. If PayPal takes another payment for it, we refund it automatically\./);
  // A product whose title already carries the name is not named twice.
  assert.equal(subscriptionUnpaidEmail({ productTitle: 'ReforgedZ Backer' }).subject, 'Your ReforgedZ Backer has ended');
  assert.equal(paymentRefusedEmail({ productTitle: 'ReforgedZ Backer', priorityQueue: false, reason: 'revoked' }).subject, 'We refunded your ReforgedZ Backer payment');
  mails.push(unpaidOpen);
  for (const m of mails) {
    for (const body of [m.subject, m.text, m.html]) {
      assert.doesNotMatch(body, /[–—]/, 'no en or em dashes');
      assert.doesNotMatch(body, /dayz/i);
    }
  }
});

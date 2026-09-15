// Tests for a staff revoke (staffRevoke.js) against the REAL schema: db.js is loaded
// with DATA_DIR pointed at a throwaway folder, so every migration runs as it will on
// the live database. PayPal, Discord and email are fakes: nothing is sent. The refund
// and cancel webhooks that follow a revoke run through paymentEvents.js as the shop
// wires them. Needs better-sqlite3, so run it where the shop's node_modules are.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-revoke-'));
process.env.DATA_DIR = dataDir;
delete process.env.PAYMENTS_ALERT_ROLE_ID;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const ev = require('../paymentEvents');
const pqGuards = require('../pqGuards');
const staffRevoke = require('../staffRevoke');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const NOW = 1800000000;
const DAY = 86400;

let seq = 0;
const next = () => ++seq;

function user() {
  const n = next();
  const id = `7656119${String(n).padStart(10, '0')}`;
  db.prepare('INSERT INTO users (steam_id, persona, bi_uid, platform) VALUES (?, ?, ?, ?)')
    .run(id, `Player${n}`, `0000abcd-0000-4000-8000-${String(n).padStart(12, '0')}`, 'steam');
  return id;
}

const PQ = db.prepare("INSERT INTO products (title, price_cents, type, grants_priority_queue, server_specific) VALUES ('Priority Queue', 1500, 'subscription', 1, 1)").run().lastInsertRowid;
const SUPPORTER = db.prepare("INSERT INTO products (title, price_cents, type) VALUES ('Supporter', 1500, 'one_time')").run().lastInsertRowid;

function order({ product = PQ, sub = null, capture = null, amount = 1500 } = {}) {
  return db.prepare(`
    INSERT INTO orders (steam_id, product_id, server_id, status, amount_cents, test_mode, paypal_subscription_id,
                        paypal_capture_id, payer_email, effective_until, created_at, completed_at)
    VALUES (?, ?, 'eu1', 'completed', ?, 0, ?, ?, 'buyer@example.invalid', ?, ?, ?)
  `).run(user(), product, amount, sub, capture, NOW + 20 * DAY, NOW - 10 * DAY, NOW - 10 * DAY).lastInsertRowid;
}

// The revoke route's own query.
const revokeRow = (id) => db.prepare(`
  SELECT o.*, u.persona, u.bi_uid, u.platform, u.gamertag, u.bm_player_id,
         p.title as product_title, p.type, p.currency
  FROM orders o JOIN users u ON o.steam_id = u.steam_id JOIN products p ON o.product_id = p.id
  WHERE o.id = ? AND o.status = 'completed'
`).get(id);
const row = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const refundCount = (orderId) => db.prepare('SELECT COUNT(*) AS n FROM paypal_refunds WHERE order_id = ?').get(orderId).n;
const fieldValue = (spec, name) => (spec.fields.find(f => f.name === name) || {}).value;

// A fake PayPal client. refund and cancel replace the default answers.
function fakePayPal({ refund = null, cancel = null } = {}) {
  const calls = { refunds: [], cancels: [] };
  return {
    calls,
    getOrder: async () => { throw new Error('not expected in these tests'); },
    normalizeCapture: () => ({ captureId: null }),
    refundCapture: async (testMode, captureId, opts) => {
      calls.refunds.push({ captureId, amountCents: opts.amountCents });
      if (refund) return refund(captureId, opts);
      return { refundId: `RF-${captureId}`, refundedCents: opts.amountCents, status: 'COMPLETED' };
    },
    cancelSubscription: async (testMode, sub, reason) => {
      calls.cancels.push({ sub, reason });
      if (cancel) return cancel(sub);
      return undefined;
    }
  };
}

// The route's side effects, recorded.
function harness(paypal, tracker = staffRevoke.createRevokeTracker()) {
  const got = { cards: [], emails: [], marked: [], after: [], logs: [] };
  const log = (...a) => got.logs.push(a.join(' '));
  const deps = {
    paypal, tracker, now: NOW,
    markCancelledLocally: (sub) => got.marked.push(sub),
    sendCard: (fn) => got.cards.push(fn()),
    sendRefundEmail: ({ order: o, amountCents }) => got.emails.push({ orderId: o.id, amountCents }),
    afterRevoke: (id) => got.after.push(id),
    logger: { log, warn: log, error: log }
  };
  return { got, deps, tracker };
}

// The webhook side, as routes/shop.js wires paymentEvents.
function webhookEffects() {
  const calls = { cards: [], emails: [] };
  const effects = {
    getOrderWithContext: (id) => db.prepare('SELECT o.*, p.title AS product_title, p.currency FROM orders o JOIN products p ON p.id = o.product_id WHERE o.id = ?').get(id),
    removeRole: () => {},
    sync: () => {},
    sendCard: (fn) => calls.cards.push(fn()),
    sendRefundEmail: ({ order: o }) => calls.emails.push(o.id),
    logger: { log() {}, warn() {}, error() {} }
  };
  return { calls, effects };
}

const v2Refund = (id, captureId, cents, extra = {}) => ({
  id, status: 'COMPLETED',
  amount: { value: (cents / 100).toFixed(2), currency_code: 'USD' },
  links: [{ rel: 'up', method: 'GET', href: `https://api-m.paypal.com/v2/payments/captures/${captureId}` }],
  ...extra
});
const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

test('a revoke with a refund: one card, one email, the refund recorded, and the webhooks that follow stay quiet', async () => {
  const n = next();
  const sub = `I-TEST-RV${n}`;
  const sale = `SALE-RV${n}`;
  const id = order({ sub, capture: sale });
  const pp = fakePayPal();
  const { got, deps, tracker } = harness(pp);
  const res = await staffRevoke.revokeOrder(db, { order: revokeRow(id), refund: true }, deps);
  assert.deepEqual(res, { status: 200, body: { ok: true, refundedCents: 1500, subscriptionCancelled: true, subscriptionCancelError: null } });
  assert.deepEqual(pp.calls.refunds, [{ captureId: sale, amountCents: 1500 }]);
  assert.deepEqual(pp.calls.cancels, [{ sub, reason: 'Revoked with refund by admin' }]);
  assert.equal(row(id).status, 'refunded');
  assert.equal(row(id).revoked_without_refund_at, null);
  const stored = db.prepare('SELECT refund_id, source, amount_cents FROM paypal_refunds WHERE order_id = ?').all(id);
  assert.deepEqual(stored, [{ refund_id: `RF-${sale}`, source: 'staff', amount_cents: 1500 }]);
  assert.deepEqual(got.cards.map(c => [c.what, c.kind]), [['Refunded $15.00', 'refund_out']]);
  assert.deepEqual(got.emails, [{ orderId: id, amountCents: 1500 }]);
  assert.deepEqual(got.marked, [sub]);
  assert.deepEqual(got.after, [id]);
  assert.equal(tracker.has(id), false);

  const { calls, effects } = webhookEffects();
  const plan = await ev.handleRefundEvent(db, { eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: v2Refund(`RF-${sale}`, sale, 1500), now: NOW + 11, inFlight: tracker.has }, effects);
  assert.equal(plan.action, 'duplicate');
  assert.equal(calls.cards.length + calls.emails.length, 0);
  assert.deepEqual(ev.endedNotices({ shopCancel: ev.shopCancelFor(db, sub, NOW + 16) }), { card: false, email: false, claimAccess: false },
    'the refund confirmation was the player\'s one email');
  assert.ok(!got.logs.some(l => /@/.test(l)), 'no email address in a log line');
});

test('a second revoke of an order being revoked is refused, and the refund webhook meanwhile is left for PayPal to deliver again', async () => {
  const n = next();
  const cap = `CAP-DBL${n}`;
  const id = order({ product: SUPPORTER, capture: cap });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = fakePayPal({ refund: async (captureId, opts) => { await gate; return { refundId: `RF-DBL${n}`, refundedCents: opts.amountCents, status: 'COMPLETED' }; } });
  const tracker = staffRevoke.createRevokeTracker();
  const first = harness(slow, tracker);
  const pending = staffRevoke.revokeOrder(db, { order: revokeRow(id), refund: true }, first.deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tracker.has(id), true);

  const failing = fakePayPal({ refund: async () => { throw Object.assign(new Error('paypal 422: refund refused'), { status: 422 }); } });
  const second = harness(failing, tracker);
  const refused = await staffRevoke.revokeOrder(db, { order: revokeRow(id), refund: true }, second.deps);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /already being revoked/);
  assert.equal(failing.calls.refunds.length, 0);
  assert.equal(second.got.cards.length, 0);
  assert.equal(tracker.has(id), true, "the refused request did not clear the first one's entry");

  const { calls, effects } = webhookEffects();
  const input = { eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: v2Refund(`RF-DBL${n}`, cap, 1500), now: NOW, inFlight: tracker.has };
  await assert.rejects(ev.handleRefundEvent(db, input, effects), (e) => e.retryLater === true);
  assert.equal(refundCount(id), 0, 'nothing recorded while the revoke runs');
  assert.equal(calls.cards.length, 0);

  release();
  const done = await pending;
  assert.equal(done.status, 200);
  assert.equal(tracker.has(id), false);
  assert.equal(first.got.cards.length, 1);
  assert.equal((await ev.handleRefundEvent(db, { ...input, now: NOW + 600 }, effects)).action, 'duplicate', "PayPal's redelivery");
  assert.equal(calls.cards.length + calls.emails.length, 0);
});

test('a refund PayPal does not answer changes nothing and posts one red card; PayPal then reports the refund once', async () => {
  const n = next();
  const sub = `I-TEST-TO${n}`;
  const sale = `SALE-TO${n}`;
  const id = order({ sub, capture: sale });
  const tracker = staffRevoke.createRevokeTracker();
  const { calls, effects } = webhookEffects();
  const webhook = {
    eventType: 'PAYMENT.SALE.REFUNDED',
    resource: { id: `RF-TO${n}`, sale_id: sale, amount: { total: '-15.00', currency: 'USD' } },
    now: NOW,
    inFlight: tracker.has
  };
  let whileWaiting = null;
  const pp = fakePayPal({
    refund: async () => {
      // PayPal made the refund and sent its webhook, but its answer to the shop is lost.
      whileWaiting = await ev.handleRefundEvent(db, webhook, effects).then(() => 'handled', (e) => (e.retryLater ? 'retry later' : e.message));
      throw abortError();
    }
  });
  const { got, deps } = harness(pp, tracker);
  const res = await staffRevoke.revokeOrder(db, { order: revokeRow(id), refund: true }, deps);
  assert.equal(whileWaiting, 'retry later');
  assert.equal(res.status, 502);
  assert.match(res.body.error, /^Refund failed: PayPal did not answer/);
  assert.equal(row(id).status, 'completed');
  assert.equal(row(id).revoked_without_refund_at, null);
  assert.equal(refundCount(id), 0);
  assert.equal(pp.calls.cancels.length, 0, 'the subscription is left alone on a guess');
  assert.deepEqual(got.cards.map(c => [c.what, c.kind]), [['Refund state unknown', 'action']]);
  assert.match(got.cards[0].description, /Nothing was changed/);
  assert.equal(got.emails.length + got.after.length, 0);
  assert.equal(tracker.has(id), false);

  const plan = await ev.handleRefundEvent(db, { ...webhook, now: NOW + 900 }, effects);
  assert.equal(plan.action, 'refunded');
  assert.equal(row(id).status, 'refunded');
  assert.deepEqual(calls.cards.map(c => c.what), ['Order refunded']);
  assert.deepEqual(calls.emails, [id]);
  assert.equal((await ev.handleRefundEvent(db, { ...webhook, now: NOW + 1800 }, effects)).action, 'duplicate');
  assert.equal(calls.cards.length, 1);
});

test('a refund PayPal refused is a plain failure, and only a refund PayPal was asked for can be unknown', async () => {
  const n = next();
  const id = order({ product: SUPPORTER, capture: `CAP-NO${n}` });
  const pp = fakePayPal({ refund: async () => { throw Object.assign(new Error('paypal 422: CAPTURE_FULLY_REFUNDED'), { status: 422 }); } });
  const { got, deps } = harness(pp);
  const res = await staffRevoke.revokeOrder(db, { order: revokeRow(id), refund: true }, deps);
  assert.deepEqual(res, { status: 502, body: { error: 'Refund failed: paypal 422: CAPTURE_FULLY_REFUNDED' } });
  assert.equal(got.cards.length, 0);
  assert.equal(row(id).status, 'completed');

  const asked = (e) => Object.assign(e, { refundAsked: true });
  assert.equal(staffRevoke.refundErrorOutcome(new Error('Order has no PayPal capture to refund')).outcome, 'failed');
  assert.equal(staffRevoke.refundErrorOutcome(asked(abortError())).outcome, 'unknown');
  assert.equal(staffRevoke.refundErrorOutcome(asked(Object.assign(new Error('paypal 503'), { status: 503 }))).outcome, 'unknown');
  assert.equal(staffRevoke.refundErrorOutcome(asked(Object.assign(new Error('paypal 429'), { status: 429 }))).outcome, 'failed');

  const legacy = order({ product: SUPPORTER, capture: null });
  const h = harness(fakePayPal());
  assert.equal((await staffRevoke.revokeOrder(db, { order: revokeRow(legacy), refund: true }, h.deps)).status, 400);
  assert.equal(h.tracker.has(legacy), false);
  assert.equal(row(legacy).status, 'completed');
});

test('a revoke without a refund is marked as no money back, the player gets exactly one email, and a later PayPal refund counts', async () => {
  const n = next();
  const sub = `I-TEST-NR${n}`;
  const sale = `SALE-NR${n}`;
  const id = order({ sub, capture: sale });
  const pp = fakePayPal();
  const { got, deps } = harness(pp);
  const res = await staffRevoke.revokeOrder(db, { order: revokeRow(id), refund: false }, deps);
  assert.deepEqual(res, { status: 200, body: { ok: true, refundedCents: 0, subscriptionCancelled: true, subscriptionCancelError: null } });
  assert.equal(pp.calls.refunds.length, 0);
  assert.deepEqual(pp.calls.cancels, [{ sub, reason: 'Revoked by admin' }]);
  assert.equal(row(id).status, 'refunded', 'entitlement readers see no perks');
  assert.equal(row(id).revoked_without_refund_at, NOW);
  assert.deepEqual(got.cards.map(c => [c.what, c.kind]), [['Access removed, not refunded', 'info']]);

  // No refund confirmation goes out, so the CANCELLED webhook's email is the player's
  // one notice, and it promises no access.
  assert.equal(got.emails.length, 0);
  const marker = ev.shopCancelFor(db, sub, NOW + 16);
  assert.equal(marker.source, 'staff_revoke_no_refund');
  assert.deepEqual(ev.endedNotices({ shopCancel: marker }), { card: false, email: true, claimAccess: false });
  assert.deepEqual(pqGuards.refundedLatestCycle(db, sub), { id, noRefund: true });

  const { calls, effects } = webhookEffects();
  const plan = await ev.handleRefundEvent(db, { eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: v2Refund(`RF-NR${n}`, sale, 1500), now: NOW + DAY }, effects);
  assert.equal(plan.action, 'recorded');
  assert.equal(plan.revokedWithoutRefund, true);
  assert.equal(row(id).revoked_without_refund_at, null, 'money went back, so it counts as refunded now');
  assert.deepEqual(pqGuards.refundedLatestCycle(db, sub), { id, noRefund: false });
  assert.equal(calls.cards.length, 1);
  assert.match(calls.cards[0].description, /revoked without a refund/);
  assert.doesNotMatch(calls.cards[0].description, /already refunded/);
  assert.equal(calls.emails.length, 0);
});

test('a partly refunded order is refunded only for what is left, and one already covered is not refunded again', async () => {
  const n = next();
  const cap = `CAP-PART${n}`;
  const id = order({ product: SUPPORTER, capture: cap });
  ev.recordRefund(db, { refundId: `RF-EARLY${n}`, orderId: id, paymentId: cap, amountCents: 500, currency: 'USD', now: NOW - DAY });
  const pp = fakePayPal();
  const { got, deps } = harness(pp);
  const res = await staffRevoke.revokeOrder(db, { order: revokeRow(id), refund: true }, deps);
  assert.equal(res.status, 200);
  assert.deepEqual(pp.calls.refunds, [{ captureId: cap, amountCents: 1000 }]);
  assert.equal(res.body.refundedCents, 1000);
  assert.equal(got.cards[0].what, 'Refunded $10.00');
  assert.equal(fieldValue(got.cards[0], 'Refunded earlier in PayPal'), '$5.00');
  assert.deepEqual(got.emails, [{ orderId: id, amountCents: 1000 }]);
  assert.equal(ev.refundedSoFar(db, id).cents, 1500);

  const coveredCap = `CAP-COV${n}`;
  const covered = order({ product: SUPPORTER, capture: coveredCap });
  ev.recordRefund(db, { refundId: `RF-COV${n}`, orderId: covered, paymentId: coveredCap, amountCents: 1500, currency: 'USD', now: NOW - DAY });
  const again = harness(fakePayPal());
  const res2 = await staffRevoke.revokeOrder(db, { order: revokeRow(covered), refund: true }, again.deps);
  assert.equal(res2.status, 200);
  assert.equal(again.deps.paypal.calls.refunds.length, 0, 'nothing is left to refund');
  assert.equal(row(covered).status, 'refunded');
  assert.equal(row(covered).revoked_without_refund_at, null, 'money did go back, earlier');
  assert.equal(again.got.cards[0].what, 'Access removed, not refunded');
  assert.match(again.got.cards[0].description, /already covered the order/);
  assert.equal(again.got.emails.length, 0);
});

test('a cancel PayPal does not answer keeps the marker and says to check PayPal; a pending refund that later fails gets a red card', async () => {
  const n = next();
  const sub = `I-TEST-CU${n}`;
  const sale = `SALE-CU${n}`;
  const id = order({ sub, capture: sale });
  const pp = fakePayPal({
    refund: async (captureId, opts) => ({ refundId: `RF-CU${n}`, refundedCents: opts.amountCents, status: 'PENDING' }),
    cancel: async () => { throw abortError(); }
  });
  const { got, deps } = harness(pp);
  const res = await staffRevoke.revokeOrder(db, { order: revokeRow(id), refund: true }, deps);
  assert.equal(res.status, 200);
  assert.equal(res.body.subscriptionCancelled, false);
  assert.match(res.body.subscriptionCancelError, /did not answer/);
  assert.deepEqual(got.marked, [], 'not marked ended on a guess');
  assert.equal(ev.shopCancelFor(db, sub, NOW + 16).source, 'staff_revoke', 'the cancel may have happened, so its webhook stays quiet');
  const card = got.cards[0];
  assert.equal(card.kind, 'attention');
  assert.equal(card.what, 'Refund pending $15.00');
  assert.equal(fieldValue(card, 'PayPal subscription'), 'No answer from PayPal: check it there');
  assert.equal(fieldValue(card, 'Refund at PayPal'), 'Pending');
  assert.match(card.description, /has not finished the refund/);
  assert.match(card.description, /may still be active/);

  const { calls, effects } = webhookEffects();
  const failed = await ev.handleRefundFailure(db, { resource: v2Refund(`RF-CU${n}`, sale, 1500, { status: 'FAILED' }), now: NOW + 2 * DAY }, effects);
  assert.equal(failed.action, 'failed');
  assert.equal(failed.source, 'staff');
  assert.deepEqual(calls.cards.map(c => [c.what, c.kind, c.orderId]), [['Refund failed', 'action', id]]);
  assert.equal(ev.refundedSoFar(db, id).cents, 0, 'a failed refund is not money back');
});

// Tests for the PayPal money events (paymentEvents.js) against the REAL schema:
// db.js is loaded with DATA_DIR pointed at a throwaway folder, so every migration
// runs as it will on the live database. PayPal and Discord are fakes; nothing is
// posted or sent. Needs better-sqlite3, so run it where the shop's node_modules are.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-payevents-'));
process.env.DATA_DIR = dataDir;
delete process.env.PAYMENTS_ALERT_ROLE_ID;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const ev = require('../paymentEvents');

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

const PRODUCT = db.prepare("INSERT INTO products (title, price_cents, type, grants_priority_queue, server_specific) VALUES ('Priority Queue', 1500, 'subscription', 1, 1)").run().lastInsertRowid;

function order(steamId, {
  status = 'completed', sub = null, capture = null, amount = 1500, until = NOW + 10 * DAY,
  createdAt = NOW - DAY, completedAt = NOW - DAY, cancelledAt = null
} = {}) {
  return db.prepare(`
    INSERT INTO orders (steam_id, product_id, server_id, status, amount_cents, test_mode, paypal_subscription_id,
                        paypal_capture_id, payer_email, effective_until, subscription_cancelled_at, created_at, completed_at)
    VALUES (?, ?, 'eu1', ?, ?, 0, ?, ?, 'buyer@example.invalid', ?, ?, ?, ?)
  `).run(steamId, PRODUCT, status, amount, sub, capture, until, cancelledAt, createdAt, completedAt).lastInsertRowid;
}

const row = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const refundRows = (id) => db.prepare('SELECT * FROM paypal_refunds WHERE refund_id = ?').all(id);

// A subscription with a first cycle and a booked renewal: custom_id names the first.
function subscriptionWithRenewal() {
  const n = next();
  const sub = `I-SUB${n}`;
  const steam = user();
  const first = order(steam, { sub, capture: `SALE-${n}-1`, until: NOW - 20 * DAY, completedAt: NOW - 50 * DAY, createdAt: NOW - 50 * DAY });
  const renewal = order(steam, { sub, capture: `SALE-${n}-2`, until: NOW + 10 * DAY, completedAt: NOW - 20 * DAY, createdAt: NOW - 20 * DAY });
  return { sub, steam, first, renewal, firstSale: `SALE-${n}-1`, renewalSale: `SALE-${n}-2` };
}

// PayPal payload shapes: an Orders v2 refund links "up" to its capture; a refund of
// a v1 subscription sale carries sale_id and a negative total.
const v2Refund = (id, captureId, cents, extra = {}) => ({
  id, status: 'COMPLETED',
  amount: { value: (cents / 100).toFixed(2), currency_code: 'USD' },
  links: [
    { rel: 'self', method: 'GET', href: `https://api-m.paypal.com/v2/payments/refunds/${id}` },
    { rel: 'up', method: 'GET', href: `https://api-m.paypal.com/v2/payments/captures/${captureId}` }
  ],
  ...extra
});
const v1SaleRefund = (id, saleId, cents, extra = {}) => ({
  id, state: 'completed', sale_id: saleId, parent_payment: 'PAY-1',
  amount: { total: `-${(cents / 100).toFixed(2)}`, currency: 'USD' },
  links: [{ rel: 'sale', href: `https://api-m.paypal.com/v1/payments/sale/${saleId}` }],
  ...extra
});

function fakeEffects() {
  const calls = { cards: [], emails: [], removed: [], syncs: 0, logs: [] };
  const effects = {
    getOrderWithContext: (id) => db.prepare(`
      SELECT o.*, u.persona, u.platform, u.gamertag, u.bm_player_id, u.bi_uid, p.title AS product_title, p.currency
      FROM orders o JOIN users u ON u.steam_id = o.steam_id JOIN products p ON p.id = o.product_id WHERE o.id = ?
    `).get(id),
    removeRole: (id) => calls.removed.push(id),
    sync: () => { calls.syncs++; },
    sendCard: (fn) => calls.cards.push(fn()),
    sendRefundEmail: ({ order: o, amountCents }) => calls.emails.push({ orderId: o.id, amountCents }),
    logger: { log: (s) => calls.logs.push(s), warn: (s) => calls.logs.push(s), error: (s) => calls.logs.push(s) }
  };
  return { calls, effects };
}

// ---- Schema ---------------------------------------------------------------------------

test('the migration adds the refund, dispute, cancel-marker and unmatched-sale tables', () => {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  assert.deepEqual(cols('paypal_refunds'), ['refund_id', 'order_id', 'payment_id', 'amount_cents', 'currency', 'kind', 'source', 'received_at']);
  assert.deepEqual(cols('paypal_disputes'), ['dispute_id', 'order_id', 'payment_id', 'status', 'outcome', 'reason', 'stage', 'amount_cents', 'currency', 'respond_by', 'created_at', 'updated_at']);
  assert.deepEqual(cols('subscription_cancels'), ['subscription_id', 'source', 'requested_at']);
  assert.deepEqual(cols('unmatched_sales'), ['sale_id', 'subscription_id', 'amount_cents', 'currency', 'custom_id', 'received_at']);
});

// ---- Reading payloads ----------------------------------------------------------------------

test('payment ids come from sale_id, capture links and sale links, with the resource id last and optional', () => {
  assert.deepEqual(ev.paymentIdsOf(v2Refund('RF1', 'CAP1', 1500)), ['CAP1', 'RF1']);
  assert.deepEqual(ev.paymentIdsOf(v2Refund('RF1', 'CAP1', 1500), { includeOwnId: false }), ['CAP1']);
  assert.deepEqual(ev.paymentIdsOf(v1SaleRefund('RF2', 'SALE9', 1500)), ['SALE9', 'RF2']);
  assert.deepEqual(ev.paymentIdsOf({ id: 'X', links: [{ rel: 'up', href: 'https://api-m.paypal.com/v2/checkout/orders/ORD1' }] }), ['X']);
  assert.equal(ev.paymentIdFromHref('https://api-m.paypal.com/v2/payments/captures/CAP7/refund'), 'CAP7');
  assert.deepEqual(ev.moneyOf({ total: '-15.00', currency: 'usd' }), { cents: 1500, currency: 'USD' });
  assert.deepEqual(ev.moneyOf({ value: '4.5', currency_code: 'EUR' }), { cents: 450, currency: 'EUR' });
  assert.equal(ev.moneyOf({ value: 'abc' }), null);
});

// ---- Matching an order ---------------------------------------------------------------------

test("a renewal's refund finds the renewal by its sale id, never the first order custom_id names", () => {
  const s = subscriptionWithRenewal();
  const m = ev.findOrderForPayment(db, { paymentIds: [s.renewalSale], customId: s.first });
  assert.equal(m.order.id, s.renewal);
  assert.equal(m.matchedBy, 'payment_id');
});

test('custom_id is trusted only for a subscription with exactly one order and no payment booked on it', () => {
  const steam = user();
  const lone = order(steam, { sub: 'I-LONE1', capture: null });
  assert.equal(ev.findOrderForPayment(db, { paymentIds: ['UNKNOWN'], customId: lone }).order.id, lone);
  const placeholder = order(steam, { sub: 'I-LONE2', capture: 'I-LONE2' });
  assert.equal(ev.findOrderForPayment(db, { paymentIds: [], customId: placeholder }).matchedBy, 'custom_id');
  const booked = order(steam, { sub: 'I-LONE3', capture: 'SALE-BOOKED' });
  assert.equal(ev.findOrderForPayment(db, { paymentIds: ['SALE-OTHER'], customId: booked }).order, null, 'its own sale is booked, so the refund is of another payment');
  const s = subscriptionWithRenewal();
  assert.equal(ev.findOrderForPayment(db, { paymentIds: ['SALE-NOT-BOOKED'], customId: s.first }).order, null, 'two cycles: custom_id is ambiguous');
  const oneTime = order(steam, { sub: null, capture: null });
  assert.equal(ev.findOrderForPayment(db, { paymentIds: [], customId: oneTime }).order, null, 'no custom_id fallback outside subscriptions');
  assert.equal(ev.findOrderForPayment(db, { paymentIds: [], subscriptionId: 'I-LONE1' }).matchedBy, 'subscription');
  assert.equal(ev.findOrderForPayment(db, { paymentIds: [], subscriptionId: s.sub }).order, null);
});

// ---- Refunds -------------------------------------------------------------------------------

test('a PayPal refund of a renewal marks only the renewal refunded; a retry does nothing', () => {
  const s = subscriptionWithRenewal();
  const input = { eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: v2Refund(`RF-R${s.renewal}`, s.renewalSale, 1500), customId: s.first, now: NOW };
  const plan = ev.applyRefundEvent(db, input);
  assert.equal(plan.action, 'refunded');
  assert.equal(plan.order.id, s.renewal);
  assert.equal(row(s.renewal).status, 'refunded');
  assert.equal(row(s.first).status, 'completed', 'the first order is untouched');
  assert.equal(ev.applyRefundEvent(db, input).action, 'duplicate');
  assert.equal(refundRows(`RF-R${s.renewal}`).length, 1);
});

test('a v1 sale refund (PAYMENT.SALE.REFUNDED) matches by sale_id the same way', () => {
  const s = subscriptionWithRenewal();
  const plan = ev.applyRefundEvent(db, { eventType: 'PAYMENT.SALE.REFUNDED', resource: v1SaleRefund(`RF-V1-${s.renewal}`, s.renewalSale, 1500), customId: s.first, now: NOW });
  assert.equal(plan.action, 'refunded');
  assert.equal(plan.order.id, s.renewal);
  assert.equal(plan.paymentId, s.renewalSale);
  assert.equal(row(s.first).status, 'completed');
});

test('partial refunds leave the order completed until they add up to what it charged', () => {
  const s = subscriptionWithRenewal();
  const first = ev.applyRefundEvent(db, { eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: v2Refund(`RF-P1-${s.renewal}`, s.renewalSale, 500), now: NOW });
  assert.equal(first.action, 'partial');
  assert.equal(first.refundedSoFarCents, 500);
  assert.equal(row(s.renewal).status, 'completed');
  const second = ev.applyRefundEvent(db, { eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: v2Refund(`RF-P2-${s.renewal}`, s.renewalSale, 1000), now: NOW });
  assert.equal(second.action, 'refunded');
  assert.equal(row(s.renewal).status, 'refunded');
});

test("PayPal's own running total can complete a refund, and a refund with no amount counts as whole", () => {
  const a = subscriptionWithRenewal();
  const byTotal = ev.applyRefundEvent(db, {
    eventType: 'PAYMENT.CAPTURE.REFUNDED', now: NOW,
    resource: v2Refund(`RF-T-${a.renewal}`, a.renewalSale, 500, { seller_payable_breakdown: { total_refunded_amount: { value: '15.00', currency_code: 'USD' } } })
  });
  assert.equal(byTotal.action, 'refunded');
  const b = subscriptionWithRenewal();
  const noAmount = v2Refund(`RF-N-${b.renewal}`, b.renewalSale, 0);
  delete noAmount.amount;
  assert.equal(ev.applyRefundEvent(db, { eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: noAmount, now: NOW }).action, 'refunded');
  assert.equal(ev.isWholeRefund({ orderAmountCents: 1500, refundedCents: 1499 }), false);
  assert.equal(ev.isWholeRefund({ orderAmountCents: 0, refundedCents: 1 }), true);
});

test('the webhook for a refund staff made is recognised by id, or by a recent staff refund of that order', () => {
  const s = subscriptionWithRenewal();
  ev.recordRefund(db, { refundId: `RF-STAFF-${s.renewal}`, orderId: s.renewal, paymentId: s.renewalSale, amountCents: 1500, source: 'staff', now: NOW });
  db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(s.renewal);
  const same = ev.applyRefundEvent(db, { eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: v2Refund(`RF-STAFF-${s.renewal}`, s.renewalSale, 1500), now: NOW });
  assert.equal(same.action, 'duplicate');
  const otherId = ev.applyRefundEvent(db, { eventType: 'PAYMENT.SALE.REFUNDED', resource: v1SaleRefund(`RF-ECHO-${s.renewal}`, s.renewalSale, 1500), now: NOW + 60 });
  assert.equal(otherId.action, 'duplicate');
  assert.equal(refundRows(`RF-ECHO-${s.renewal}`).length, 0);
  const muchLater = ev.applyRefundEvent(db, { eventType: 'PAYMENT.SALE.REFUNDED', resource: v1SaleRefund(`RF-LATE-${s.renewal}`, s.renewalSale, 1500), now: NOW + ev.STAFF_REFUND_WINDOW_S + DAY });
  assert.equal(muchLater.action, 'recorded');
  assert.equal(row(s.first).status, 'completed');
});

test('while staff are refunding an order the webhook records nothing and leaves it to the revoke', () => {
  const s = subscriptionWithRenewal();
  const plan = ev.applyRefundEvent(db, { eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: v2Refund(`RF-FLY-${s.renewal}`, s.renewalSale, 1500), now: NOW, inFlight: (id) => id === s.renewal });
  assert.equal(plan.action, 'in_flight');
  assert.equal(refundRows(`RF-FLY-${s.renewal}`).length, 0);
  assert.equal(row(s.renewal).status, 'completed');
});

test('a refund webhook that lands during a revoke is never answered as handled: PayPal delivers it again and it counts once', async () => {
  const s = subscriptionWithRenewal();
  const { calls, effects } = fakeEffects();
  let revoking = true;
  const input = {
    eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: v2Refund(`RF-RETRY-${s.renewal}`, s.renewalSale, 1500), now: NOW,
    inFlight: (id) => revoking && id === s.renewal
  };
  await assert.rejects(ev.handleRefundEvent(db, input, effects), (e) => e.retryLater === true && /deliver again/.test(e.message));
  assert.equal(refundRows(`RF-RETRY-${s.renewal}`).length, 0);
  assert.equal(calls.cards.length + calls.emails.length + calls.removed.length, 0);
  // The revoke then failed without PayPal answering; the redelivery is a refund made in PayPal.
  revoking = false;
  const plan = await ev.handleRefundEvent(db, { ...input, now: NOW + 600 }, effects);
  assert.equal(plan.action, 'refunded');
  assert.equal(row(s.renewal).status, 'refunded');
  assert.deepEqual(calls.cards.map(c => c.what), ['Order refunded']);
  assert.equal(calls.emails.length, 1);
});

test('a refund PayPal could not complete is reported once and stops counting as money back', async () => {
  const s = subscriptionWithRenewal();
  ev.recordRefund(db, { refundId: `RF-FAIL-${s.renewal}`, orderId: s.renewal, paymentId: s.renewalSale, amountCents: 1500, source: 'staff', now: NOW });
  assert.equal(ev.refundedSoFar(db, s.renewal).cents, 1500);
  const { calls, effects } = fakeEffects();
  const input = { resource: v2Refund(`RF-FAIL-${s.renewal}`, s.renewalSale, 1500, { status: 'FAILED' }), now: NOW + DAY };
  const plan = await ev.handleRefundFailure(db, input, effects);
  assert.equal(plan.action, 'failed');
  assert.equal(plan.order.id, s.renewal);
  assert.equal(plan.source, 'staff');
  assert.equal(refundRows(`RF-FAIL-${s.renewal}`)[0].kind, 'refund_failed');
  assert.equal(ev.refundedSoFar(db, s.renewal).cents, 0);
  assert.equal((await ev.handleRefundFailure(db, input, effects)).action, 'duplicate', 'a retry');
  assert.deepEqual(calls.cards.map(c => [c.what, c.kind, c.orderId]), [['Refund failed', 'action', s.renewal]]);
  assert.equal(calls.emails.length + calls.removed.length + calls.syncs, 0);
  assert.equal(row(s.renewal).status, 'completed', 'the order is not changed');

  const other = subscriptionWithRenewal();
  const stray = ev.applyRefundFailure(db, { resource: v2Refund('RF-FAIL-NEW', other.firstSale, 700, { status: 'FAILED' }), now: NOW });
  assert.equal(stray.action, 'failed');
  assert.equal(stray.order.id, other.first);
  assert.equal(refundRows('RF-FAIL-NEW')[0].kind, 'refund_failed');
  assert.equal(ev.applyRefundFailure(db, { resource: {}, now: NOW }).action, 'ignored');
});

test('a reversal is recorded and never changes the order; an unknown payment is recorded with no order', () => {
  const s = subscriptionWithRenewal();
  const reversed = ev.applyRefundEvent(db, { eventType: 'PAYMENT.SALE.REVERSED', resource: v1SaleRefund(`RV-${s.renewal}`, s.renewalSale, 1500), now: NOW });
  assert.equal(reversed.action, 'reversed');
  assert.equal(row(s.renewal).status, 'completed');
  assert.equal(refundRows(`RV-${s.renewal}`)[0].kind, 'reversal');
  const capReversal = ev.applyRefundEvent(db, { eventType: 'PAYMENT.CAPTURE.REVERSED', resource: v2Refund(`RV2-${s.first}`, s.firstSale, 1500), now: NOW });
  assert.equal(capReversal.action, 'reversed');
  assert.equal(row(s.first).status, 'completed');
  const unmatched = ev.applyRefundEvent(db, { eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: v2Refund('RF-NOBODY', 'CAP-NOBODY', 1500), now: NOW });
  assert.equal(unmatched.action, 'unmatched');
  assert.equal(refundRows('RF-NOBODY')[0].order_id, null);
  assert.equal(ev.applyRefundEvent(db, { eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: {}, now: NOW }).action, 'ignored');
  assert.equal(ev.applyRefundEvent(db, { eventType: 'PAYMENT.CAPTURE.REFUNDED', event: { id: 'WH-9' }, resource: { amount: { value: '1.00' } }, now: NOW }).refundId, 'event:WH-9');
});

test('a refund on an order that is not completed is recorded only', () => {
  const steam = user();
  const cancelled = order(steam, { status: 'cancelled', capture: 'CAP-CANCELLED' });
  const plan = ev.applyRefundEvent(db, { eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: v2Refund('RF-CANC', 'CAP-CANCELLED', 1500), now: NOW });
  assert.equal(plan.action, 'recorded');
  assert.equal(row(cancelled).status, 'cancelled');
});

// ---- One refund, one card ------------------------------------------------------------------

test('one staff refund: the refund webhook that follows posts no card and sends no email', async () => {
  const s = subscriptionWithRenewal();
  // What the revoke route does.
  ev.recordRefund(db, { refundId: `RF-ONE-${s.renewal}`, orderId: s.renewal, paymentId: s.renewalSale, amountCents: 1500, source: 'staff', now: NOW });
  db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(s.renewal);
  const { calls, effects } = fakeEffects();
  for (const eventType of ['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.SALE.REFUNDED']) {
    await ev.handleRefundEvent(db, { eventType, resource: v2Refund(`RF-ONE-${s.renewal}`, s.renewalSale, 1500), customId: s.first, now: NOW + 10 }, effects);
  }
  assert.equal(calls.cards.length, 0);
  assert.equal(calls.emails.length, 0);
  assert.equal(calls.removed.length, 0);
  assert.equal(row(s.first).status, 'completed');
});

test('a refund made in PayPal: one card for the refunded cycle, one email, the role and sync once; retries add nothing', async () => {
  const s = subscriptionWithRenewal();
  const { calls, effects } = fakeEffects();
  const input = { eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: v2Refund(`RF-DASH-${s.renewal}`, s.renewalSale, 1500), customId: s.first, now: NOW };
  await ev.handleRefundEvent(db, input, effects);
  await ev.handleRefundEvent(db, input, effects);
  assert.equal(calls.cards.length, 1);
  assert.equal(calls.cards[0].what, 'Order refunded');
  assert.equal(calls.cards[0].orderId, s.renewal);
  assert.equal(calls.cards[0].amountCents, 1500);
  assert.deepEqual(calls.emails, [{ orderId: s.renewal, amountCents: 1500 }]);
  assert.deepEqual(calls.removed, [s.renewal]);
  assert.equal(calls.syncs, 1);
  assert.ok(!calls.logs.some(l => /@/.test(l)), 'no email in a log line');
});

test('a partial refund and a reversal each post one card, with no email and no perks removed', async () => {
  const s = subscriptionWithRenewal();
  const { calls, effects } = fakeEffects();
  await ev.handleRefundEvent(db, { eventType: 'PAYMENT.CAPTURE.REFUNDED', resource: v2Refund(`RF-PART-${s.renewal}`, s.renewalSale, 300), now: NOW }, effects);
  await ev.handleRefundEvent(db, { eventType: 'PAYMENT.SALE.REVERSED', resource: v1SaleRefund(`RV-PART-${s.renewal}`, s.renewalSale, 1500), now: NOW }, effects);
  assert.deepEqual(calls.cards.map(c => [c.what, c.kind]), [['Partial refund', 'refund_out'], ['Payment reversed', 'action']]);
  assert.equal(calls.emails.length, 0);
  assert.equal(calls.removed.length, 0);
  assert.equal(calls.syncs, 0);
  assert.equal(row(s.renewal).status, 'completed');
});

// ---- Disputes ------------------------------------------------------------------------------

const disputeResource = (id, saleId, { status = 'OPEN', outcome = null, refunded = null, amount = '15.00', custom = null } = {}) => ({
  dispute_id: id, reason: 'UNAUTHORISED', status, dispute_life_cycle_stage: 'CHARGEBACK',
  dispute_amount: { currency_code: 'USD', value: amount },
  disputed_transactions: [{ seller_transaction_id: saleId, ...(custom != null ? { custom: String(custom) } : {}) }],
  seller_response_due_date: '2027-01-20T10:00:00Z',
  ...(outcome ? { dispute_outcome: { outcome_code: outcome, ...(refunded ? { amount_refunded: { currency_code: 'USD', value: refunded } } : {}) } } : {})
});

test('a dispute opens once, moves on a status change only, and closes once; the order never changes', async () => {
  const s = subscriptionWithRenewal();
  const before = row(s.renewal);
  const { calls, effects } = fakeEffects();
  const id = `PP-D-${s.renewal}`;
  const send = (eventType, over) => ev.handleDisputeEvent(db, { eventType, resource: disputeResource(id, s.renewalSale, over), now: NOW }, effects);
  await send('CUSTOMER.DISPUTE.CREATED', {});
  await send('CUSTOMER.DISPUTE.CREATED', {});
  await send('CUSTOMER.DISPUTE.UPDATED', {});
  await send('CUSTOMER.DISPUTE.UPDATED', { status: 'WAITING_FOR_SELLER_RESPONSE' });
  await send('CUSTOMER.DISPUTE.RESOLVED', { status: 'RESOLVED', outcome: 'RESOLVED_SELLER_FAVOUR' });
  await send('CUSTOMER.DISPUTE.RESOLVED', { status: 'RESOLVED', outcome: 'RESOLVED_SELLER_FAVOUR' });
  await send('CUSTOMER.DISPUTE.UPDATED', { status: 'RESOLVED' });
  assert.deepEqual(calls.cards.map(c => c.what), ['Dispute opened', 'Dispute updated', 'Dispute won']);
  assert.ok(calls.cards.every(c => c.orderId === s.renewal));
  const stored = db.prepare('SELECT * FROM paypal_disputes WHERE dispute_id = ?').get(id);
  assert.equal(stored.order_id, s.renewal);
  assert.equal(stored.payment_id, s.renewalSale);
  assert.equal(stored.status, 'RESOLVED');
  assert.equal(stored.outcome, 'RESOLVED_SELLER_FAVOUR');
  assert.equal(stored.amount_cents, 1500);
  assert.equal(stored.respond_by, Math.floor(Date.parse('2027-01-20T10:00:00Z') / 1000));
  const after = row(s.renewal);
  assert.equal(after.status, before.status);
  assert.equal(after.effective_until, before.effective_until);
  assert.equal(calls.emails.length + calls.removed.length + calls.syncs, 0);
});

test('a lost dispute is lost by outcome or by a refund in the outcome; the first sighting of an update opens it', () => {
  const s = subscriptionWithRenewal();
  const lost = ev.applyDisputeEvent(db, { eventType: 'CUSTOMER.DISPUTE.RESOLVED', resource: disputeResource(`PP-L-${s.renewal}`, s.renewalSale, { status: 'RESOLVED', outcome: 'RESOLVED_BUYER_FAVOUR', refunded: '15.00' }), now: NOW });
  assert.equal(lost.card, 'resolved');
  assert.equal(lost.result, 'lost');
  assert.equal(lost.shown.amountRefundedCents, 1500);
  const firstSeen = ev.applyDisputeEvent(db, { eventType: 'CUSTOMER.DISPUTE.UPDATED', resource: disputeResource(`PP-U-${s.renewal}`, s.renewalSale, { status: 'UNDER_REVIEW' }), now: NOW });
  assert.equal(firstSeen.card, 'opened');
  assert.equal(ev.disputeMoneyResult({ outcome: 'ACCEPTED' }), 'lost');
  assert.equal(ev.disputeMoneyResult({ outcome: 'RESOLVED_SELLER_FAVOUR', amountRefundedCents: 0 }), 'won');
  assert.equal(ev.disputeMoneyResult({ outcome: 'CANCELED_BY_BUYER' }), 'won');
  assert.equal(ev.disputeMoneyResult({ outcome: 'DENIED' }), 'won');
  assert.equal(ev.disputeMoneyResult({ outcome: 'RESOLVED_WITH_PAYOUT' }), 'unclear');
  assert.equal(ev.disputeMoneyResult({ outcome: null }), 'unclear');
  assert.equal(ev.disputeMoneyResult({ outcome: 'RESOLVED_SELLER_FAVOUR', amountRefundedCents: 500 }), 'lost');
});

test("a dispute on an unknown payment still opens a card; the subscription's custom id is not trusted for a renewal", () => {
  const s = subscriptionWithRenewal();
  const unknown = ev.applyDisputeEvent(db, { eventType: 'CUSTOMER.DISPUTE.CREATED', resource: disputeResource(`PP-X-${s.renewal}`, 'SALE-NOT-OURS', { custom: s.first }), now: NOW });
  assert.equal(unknown.card, 'opened');
  assert.equal(unknown.order, null);
  assert.equal(db.prepare('SELECT order_id FROM paypal_disputes WHERE dispute_id = ?').get(`PP-X-${s.renewal}`).order_id, null);
  assert.equal(ev.applyDisputeEvent(db, { eventType: 'CUSTOMER.DISPUTE.CREATED', resource: {}, now: NOW }).card, null);
});

// ---- A payment with no order rows ----------------------------------------------------------

test('a payment on a subscription with no order rows is recorded once; one with rows is not this case', () => {
  assert.equal(ev.recordUnmatchedSale(db, { saleId: 'SALE-U1', subscriptionId: 'I-NOROWS', amountCents: 1500, currency: 'USD', customId: 612, now: NOW }), true);
  assert.equal(ev.recordUnmatchedSale(db, { saleId: 'SALE-U1', subscriptionId: 'I-NOROWS', amountCents: 1500, now: NOW }), false);
  const stored = db.prepare('SELECT * FROM unmatched_sales WHERE sale_id = ?').get('SALE-U1');
  assert.equal(stored.custom_id, '612');
  const s = subscriptionWithRenewal();
  assert.equal(ev.recordUnmatchedSale(db, { saleId: 'SALE-U2', subscriptionId: s.sub, now: NOW }), null);
  assert.equal(ev.recordUnmatchedSale(db, { saleId: null, subscriptionId: 'I-NOROWS', now: NOW }), null);
});

// ---- The shop's own cancels ----------------------------------------------------------------

test('a shop cancel marker is found inside its window, replaced on a second cancel, and cleared', () => {
  ev.markShopCancel(db, { subscriptionId: 'I-MARK1', source: 'staff_revoke', now: NOW });
  assert.equal(ev.shopCancelFor(db, 'I-MARK1', NOW + DAY).source, 'staff_revoke');
  assert.equal(ev.shopCancelFor(db, 'I-MARK1', NOW + ev.SHOP_CANCEL_WINDOW_S + 1), null);
  ev.markShopCancel(db, { subscriptionId: 'I-MARK1', source: 'auto_close_suspended', now: NOW + 5 });
  assert.equal(ev.shopCancelFor(db, 'I-MARK1', NOW + 10).source, 'auto_close_suspended');
  assert.equal(ev.clearShopCancel(db, 'I-MARK1'), true);
  assert.equal(ev.shopCancelFor(db, 'I-MARK1', NOW + 10), null);
  assert.equal(ev.shopCancelFor(db, 'I-PLAYER-CANCELLED', NOW), null, "a player's own cancel writes no marker");
  assert.throws(() => ev.markShopCancel(db, { subscriptionId: 'I-MARK2', source: 'player' }), /unknown cancel source/);
});

const thrower = (err) => ({ cancelSubscription: async () => { throw err; } });
const endedError = () => Object.assign(new Error('paypal 422: invalid'), { status: 422, body: { details: [{ issue: 'SUBSCRIPTION_STATUS_INVALID' }] } });

test('cancelAtPayPal keeps the marker when PayPal cancels or does not answer, and removes it when PayPal refuses', async () => {
  const asked = [];
  const ok = { cancelSubscription: async (testMode, sub, reason) => { asked.push([testMode, sub, reason]); } };
  const done = await ev.cancelAtPayPal({ db, paypal: ok, testMode: false, subscriptionId: 'I-CAN1', reason: 'Revoked by admin', source: 'staff_revoke', now: NOW });
  assert.deepEqual(done, { outcome: 'cancelled', status: null, error: null });
  assert.deepEqual(asked, [[false, 'I-CAN1', 'Revoked by admin']]);
  assert.equal(ev.shopCancelFor(db, 'I-CAN1', NOW).source, 'staff_revoke');

  const failed = await ev.cancelAtPayPal({ db, paypal: thrower(Object.assign(new Error('paypal 404: not found'), { status: 404 })), subscriptionId: 'I-CAN2', reason: 'x', source: 'hard_delete', now: NOW });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.status, 404);
  assert.equal(ev.shopCancelFor(db, 'I-CAN2', NOW), null);

  const already = await ev.cancelAtPayPal({ db, paypal: thrower(endedError()), subscriptionId: 'I-CAN3', reason: 'x', source: 'close_suspended_tool', now: NOW });
  assert.equal(already.outcome, 'already_ended');
  assert.equal(ev.shopCancelFor(db, 'I-CAN3', NOW), null);

  // No answer: the cancel may have gone through, so the CANCELLED webhook it causes
  // must find the marker and post no card and send no email.
  const aborted = await ev.cancelAtPayPal({ db, paypal: thrower(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), subscriptionId: 'I-CAN4', reason: 'x', source: 'auto_close_suspended', now: NOW });
  assert.deepEqual([aborted.outcome, aborted.status], ['unknown', 0]);
  const marker = ev.shopCancelFor(db, 'I-CAN4', NOW + 20);
  assert.equal(marker.source, 'auto_close_suspended');
  assert.deepEqual(ev.endedNotices({ shopCancel: marker }), { card: false, email: false, claimAccess: false });
  const down = await ev.cancelAtPayPal({ db, paypal: thrower(Object.assign(new Error('paypal 503'), { status: 503 })), subscriptionId: 'I-CAN5', reason: 'x', source: 'staff_revoke', now: NOW });
  assert.equal(down.outcome, 'unknown');
  assert.equal(ev.shopCancelFor(db, 'I-CAN5', NOW).source, 'staff_revoke');

  assert.equal(ev.cancelErrorOutcome(Object.assign(new Error('paypal 422'), { status: 422, body: { details: [{ issue: 'SOMETHING_ELSE' }] } })).outcome, 'failed');
  assert.equal(ev.cancelErrorOutcome(Object.assign(new Error('paypal 429'), { status: 429 })).outcome, 'failed', 'a 429 is refused, not processed');
  assert.deepEqual(await ev.cancelAtPayPal({ db, paypal: ok, subscriptionId: null, source: 'staff_revoke' }), { outcome: 'none', status: null, error: null });
  assert.equal(asked.length, 1);
});

test("a cancel PayPal refuses never removes an earlier shop cancel's marker", async () => {
  // Staff revoke one cycle (PayPal cancels), then an older cycle of the same
  // subscription seconds later: PayPal answers 422, and the first cancel's webhook
  // is still on its way.
  ev.markShopCancel(db, { subscriptionId: 'I-TWICE1', source: 'staff_revoke', now: NOW });
  const r = await ev.cancelAtPayPal({ db, paypal: thrower(endedError()), subscriptionId: 'I-TWICE1', reason: 'Revoked by admin', source: 'staff_revoke_no_refund', now: NOW + 5 });
  assert.equal(r.outcome, 'already_ended');
  assert.deepEqual(ev.shopCancelFor(db, 'I-TWICE1', NOW + 16), { source: 'staff_revoke', requested_at: NOW });

  // A redelivered SUSPENDED event runs the automatic close again.
  ev.markShopCancel(db, { subscriptionId: 'I-TWICE2', source: 'auto_close_suspended', now: NOW });
  await ev.cancelAtPayPal({ db, paypal: thrower(endedError()), subscriptionId: 'I-TWICE2', reason: 'x', source: 'auto_close_suspended', now: NOW + 60 });
  assert.deepEqual(ev.shopCancelFor(db, 'I-TWICE2', NOW + 61), { source: 'auto_close_suspended', requested_at: NOW });

  ev.markShopCancel(db, { subscriptionId: 'I-TWICE3', source: 'hard_delete', now: NOW });
  await ev.cancelAtPayPal({ db, paypal: thrower(Object.assign(new Error('paypal 404'), { status: 404 })), subscriptionId: 'I-TWICE3', reason: 'x', source: 'close_suspended_tool', now: NOW + 60 });
  assert.deepEqual(ev.shopCancelFor(db, 'I-TWICE3', NOW + 61), { source: 'hard_delete', requested_at: NOW });
});

test('after a shop cancel only a no-refund staff revoke still emails the player, and no ended card goes out', () => {
  assert.deepEqual(ev.endedNotices({ shopCancel: null }), { card: true, email: true, claimAccess: true });
  assert.deepEqual(ev.endedNotices(), { card: true, email: true, claimAccess: true });
  for (const source of ['staff_revoke', 'auto_close_suspended', 'hard_delete', 'close_suspended_tool']) {
    assert.deepEqual(ev.endedNotices({ shopCancel: { source } }), { card: false, email: false, claimAccess: false }, source);
  }
  assert.deepEqual(ev.endedNotices({ shopCancel: { source: 'staff_revoke_no_refund' } }), { card: false, email: true, claimAccess: false });
  assert.ok(ev.SHOP_CANCEL_SOURCES.includes('staff_revoke_no_refund'));
});

// ---- Access when a subscription ends ------------------------------------------------------

test('billing intervals add calendar months, clamp to the month end, and handle weeks, days and years', () => {
  const at = (iso) => Math.floor(Date.parse(iso) / 1000);
  const iso = (u) => new Date(u * 1000).toISOString();
  assert.equal(iso(ev.addBillingInterval(at('2026-01-31T10:00:00Z'))), '2026-02-28T10:00:00.000Z');
  assert.equal(iso(ev.addBillingInterval(at('2028-01-31T10:00:00Z'))), '2028-02-29T10:00:00.000Z');
  assert.equal(iso(ev.addBillingInterval(at('2026-12-15T08:30:00Z'))), '2027-01-15T08:30:00.000Z');
  assert.equal(iso(ev.addBillingInterval(at('2028-02-29T00:00:00Z'), { unit: 'YEAR', count: 1 })), '2029-02-28T00:00:00.000Z');
  assert.equal(ev.addBillingInterval(NOW, { unit: 'WEEK', count: 2 }), NOW + 14 * DAY);
  assert.equal(ev.addBillingInterval(NOW, { unit: 'DAY', count: 3 }), NOW + 3 * DAY);
  assert.deepEqual(ev.intervalOfPlan({ billing_cycles: [{ tenure_type: 'TRIAL', frequency: { interval_unit: 'DAY', interval_count: 7 } }, { tenure_type: 'REGULAR', frequency: { interval_unit: 'MONTH', interval_count: 3 } }] }), { unit: 'MONTH', count: 3 });
  assert.equal(ev.intervalOfPlan({}), null);
  assert.equal(ev.paidThroughOf({ last_payment: { time: '2026-01-31T10:00:00Z' } }), at('2026-02-28T10:00:00Z'));
  assert.equal(ev.paidThroughOf({}), null);
});

test('the plan interval is looked up once per plan, and a failed lookup falls back to monthly without caching', async () => {
  let calls = 0;
  const cache = new Map();
  const pp = { getPlan: async () => { calls++; return { billing_cycles: [{ tenure_type: 'REGULAR', frequency: { interval_unit: 'YEAR', interval_count: 1 } }] }; } };
  assert.deepEqual(await ev.planInterval(pp, { planId: 'P-1', cache }), { unit: 'YEAR', count: 1 });
  assert.deepEqual(await ev.planInterval(pp, { planId: 'P-1', cache }), { unit: 'YEAR', count: 1 });
  assert.equal(calls, 1);
  const down = { getPlan: async () => { throw new Error('paypal 503'); } };
  assert.deepEqual(await ev.planInterval(down, { planId: 'P-2', cache }), ev.MONTHLY);
  assert.equal(cache.has('live:P-2'), false);
  assert.deepEqual(await ev.planInterval(pp, { planId: null, cache }), ev.MONTHLY);
});

test('a paid-through floor raises the newest cycle and never moves any date earlier', () => {
  const steam = user();
  // One row standing for two payments: the second cycle was paid but its end date was never moved.
  const lone = order(steam, { sub: 'I-FLOOR1', capture: 'SALE-F1', completedAt: NOW - 40 * DAY, until: NOW - 9 * DAY });
  const raised = ev.applyPaidThroughFloor(db, { subscriptionId: 'I-FLOOR1', floor: NOW + 20 * DAY, lastPaymentAt: NOW - 10 * DAY });
  assert.deepEqual(raised.raised, { id: lone, from: NOW - 9 * DAY, to: NOW + 20 * DAY });
  assert.equal(row(lone).effective_until, NOW + 20 * DAY);
  assert.equal(raised.accessUntil, NOW + 20 * DAY);

  const later = order(steam, { sub: 'I-FLOOR2', capture: 'SALE-F2', until: NOW + 30 * DAY });
  const kept = ev.applyPaidThroughFloor(db, { subscriptionId: 'I-FLOOR2', floor: NOW + 5 * DAY });
  assert.equal(kept.raised, null);
  assert.equal(row(later).effective_until, NOW + 30 * DAY);
  const none = ev.applyPaidThroughFloor(db, { subscriptionId: 'I-FLOOR2', floor: null });
  assert.equal(none.raised, null);
  assert.equal(row(later).effective_until, NOW + 30 * DAY);
  assert.equal(none.accessUntil, NOW + 30 * DAY);
});

test('an undated completed row gets a date, and a refunded newest cycle blocks the floor', () => {
  const steam = user();
  const undated = order(steam, { sub: 'I-FLOOR3', capture: 'SALE-F3', until: null, completedAt: NOW - 10 * DAY });
  const r1 = ev.applyPaidThroughFloor(db, { subscriptionId: 'I-FLOOR3', floor: NOW + 40 * DAY });
  assert.deepEqual(r1.filled, [undated]);
  assert.equal(row(undated).effective_until, NOW + 40 * DAY);
  const undated2 = order(steam, { sub: 'I-FLOOR4', capture: 'SALE-F4', until: null, completedAt: NOW - 10 * DAY });
  ev.applyPaidThroughFloor(db, { subscriptionId: 'I-FLOOR4', floor: null });
  assert.equal(row(undated2).effective_until, NOW + 21 * DAY);

  const older = order(steam, { sub: 'I-FLOOR5', capture: 'SALE-F5A', until: NOW - 5 * DAY });
  order(steam, { sub: 'I-FLOOR5', capture: 'SALE-F5B', status: 'refunded', until: NOW + 25 * DAY });
  const blocked = ev.applyPaidThroughFloor(db, { subscriptionId: 'I-FLOOR5', floor: NOW + 25 * DAY });
  assert.equal(blocked.skipped, 'latest_cycle_refunded');
  assert.equal(blocked.raised, null);
  assert.equal(row(older).effective_until, NOW - 5 * DAY, 'staff took that period back');
});

// ---- The first cycle's row ---------------------------------------------------------------

test("a sale fills the first cycle's row only inside the first billing cycle", () => {
  const first = { paypal_subscription_id: 'I-FC', paypal_capture_id: null, created_at: NOW - DAY, completed_at: NOW - DAY, effective_until: NOW + 29 * DAY };
  assert.equal(ev.isFirstCycleSale(first, NOW), true);
  assert.equal(ev.isFirstCycleSale({ ...first, paypal_capture_id: 'I-FC' }, NOW), true, 'the old subscription-id placeholder');
  assert.equal(ev.isFirstCycleSale(first, NOW + 29 * DAY), false, 'the next month');
  assert.equal(ev.isFirstCycleSale({ ...first, effective_until: null }, NOW - DAY + ev.FIRST_CYCLE_DAYS * DAY + 1), false);
  assert.equal(ev.isFirstCycleSale({ ...first, effective_until: NOW + 5 * DAY }, NOW + 4.5 * DAY), false, 'at the first billing date');
  assert.equal(ev.isFirstCycleSale({ ...first, paypal_capture_id: 'SALE-BOOKED' }, NOW), false);
  assert.equal(ev.isFirstCycleSale(null, NOW), false);
  assert.equal(ev.saleTimeOf({ create_time: '2027-01-15T12:00:00Z' }, NOW), Math.floor(Date.parse('2027-01-15T12:00:00Z') / 1000));
  assert.equal(ev.saleTimeOf({}, NOW), NOW);

  const steam = user();
  const placeholder = order(steam, { sub: 'I-FC2', capture: null });
  order(steam, { sub: 'I-FC2', capture: 'SALE-FC2' });
  assert.equal(ev.unpaidFirstCycleRow(db, 'I-FC2').id, placeholder);
  assert.equal(ev.unpaidFirstCycleRow(db, 'I-NONE'), null);
});

// ---- Never paid ----------------------------------------------------------------------------

test("PayPal's last payment or completed cycles decide 'ever paid' when the order rows cannot", () => {
  assert.equal(ev.paypalEverPaid({ last_payment: { amount: { value: '15.00' }, time: '2026-07-29T10:00:00Z' } }), true);
  assert.equal(ev.paypalEverPaid({ cycle_executions: [{ tenure_type: 'REGULAR', cycles_completed: 2 }] }), true);
  assert.equal(ev.paypalEverPaid({ cycle_executions: [{ tenure_type: 'REGULAR', cycles_completed: 0 }], failed_payments_count: 1 }), false);
  assert.equal(ev.paypalEverPaid({ failed_payments_count: 1 }), null);
  assert.equal(ev.paypalEverPaid(null), null);
  assert.deepEqual(ev.everPaid({ localPaid: false, billingInfo: { last_payment: { time: '2026-07-29T10:00:00Z' } } }), { paid: true, basis: 'paypal' });
  assert.deepEqual(ev.everPaid({ localPaid: false, billingInfo: { cycle_executions: [{ cycles_completed: 0 }] } }), { paid: false, basis: 'paypal' });
  assert.deepEqual(ev.everPaid({ localPaid: false, billingInfo: {} }), { paid: false, basis: 'orders' });
  assert.deepEqual(ev.everPaid({ localPaid: true, billingInfo: { cycle_executions: [{ cycles_completed: 0 }] } }), { paid: true, basis: 'orders' });
});

test('a billing rescan asks about live subscriptions and ones with a billing issue that are not marked ended', () => {
  const steam = user();
  order(steam, { sub: 'I-RS-LIVE', capture: 'SALE-RS1' });
  order(steam, { sub: 'I-RS-LOST', status: 'cancelled' });
  order(steam, { sub: 'I-RS-ENDED', status: 'cancelled', cancelledAt: NOW - DAY });
  order(steam, { sub: 'I-RS-NOISSUE', status: 'cancelled' });
  order(steam, { sub: 'I-RS-OVER', capture: 'SALE-RS5', cancelledAt: NOW - DAY });
  const issue = db.prepare('INSERT INTO subscription_billing_issues (paypal_subscription_id, first_seen_at, last_seen_at, resolved_at) VALUES (?, ?, ?, ?)');
  issue.run('I-RS-LOST', NOW - 30 * DAY, NOW - 30 * DAY, NOW - 3 * DAY);
  issue.run('I-RS-ENDED', NOW - 30 * DAY, NOW - 30 * DAY, null);
  const subs = ev.billingRescanTargets(db).map(t => t.sub_id).filter(s => s.startsWith('I-RS-'));
  assert.deepEqual(subs, ['I-RS-LIVE', 'I-RS-LOST']);
});

test('the floor never undoes a date staff shortened when the last payment is the newest cycle', () => {
  const steam = user();
  const paidAt = NOW - 10 * DAY;
  // Booked a minute after the payment, then cut short by staff.
  const cut = order(steam, { sub: 'I-FLOOR6', capture: 'SALE-F6', createdAt: paidAt + 60, completedAt: paidAt + 60, until: NOW - DAY });
  const r = ev.applyPaidThroughFloor(db, { subscriptionId: 'I-FLOOR6', floor: NOW + 21 * DAY, lastPaymentAt: paidAt });
  assert.equal(r.raised, null);
  assert.equal(row(cut).effective_until, NOW - DAY);
  assert.equal(r.accessUntil, NOW - DAY);
  // A sale event PayPal delivered two days late is still that same cycle.
  const late = order(steam, { sub: 'I-FLOOR7', capture: 'SALE-F7', createdAt: paidAt + 2 * DAY, completedAt: paidAt + 2 * DAY, until: NOW - DAY });
  assert.equal(ev.applyPaidThroughFloor(db, { subscriptionId: 'I-FLOOR7', floor: NOW + 21 * DAY, lastPaymentAt: paidAt }).raised, null);
  assert.equal(row(late).effective_until, NOW - DAY);
  // Without the last payment's time nothing proves a payment went unbooked.
  assert.equal(ev.applyPaidThroughFloor(db, { subscriptionId: 'I-FLOOR6', floor: NOW + 21 * DAY }).raised, null);
  assert.equal(row(cut).effective_until, NOW - DAY);
});

test("a booked sale's access ends at PayPal's next billing time, or the sale time plus one billing period when PayPal gives none", async () => {
  const at = (iso) => Math.floor(Date.parse(iso) / 1000);
  const sale = { id: 'SALE-CE1', create_time: '2027-01-15T08:00:00Z' };
  const lines = [];
  const logger = { warn: (s) => lines.push(s), log() {}, error() {} };
  const live = {
    getSubscription: async () => ({ plan_id: 'P-CE1', billing_info: { next_billing_time: '2027-02-15T10:00:00Z' } }),
    getPlan: async () => { throw new Error('not needed'); }
  };
  assert.deepEqual(await ev.renewalCycleEnd({ paypal: live, subscriptionId: 'I-CE1', resource: sale, logger }),
    { effectiveUntil: at('2027-02-15T10:00:00Z'), nextBillingAt: at('2027-02-15T10:00:00Z'), estimated: false });
  assert.equal(lines.length, 0);

  const down = { getSubscription: async () => { throw new Error('paypal 503'); }, getPlan: async () => { throw new Error('no plan id to ask about'); } };
  assert.deepEqual(await ev.renewalCycleEnd({ paypal: down, subscriptionId: 'I-CE2', resource: sale, logger }),
    { effectiveUntil: at('2027-02-15T08:00:00Z'), nextBillingAt: null, estimated: true });
  assert.match(lines[0], /lookup failed.*sale time plus one billing period/);

  // A sale delivered after the agreement ended: PayPal has no next billing time.
  const ended = {
    getSubscription: async () => ({ status: 'CANCELLED', plan_id: 'P-CE-YEARLY', billing_info: { last_payment: { time: '2027-01-15T08:00:00Z' } } }),
    getPlan: async () => ({ billing_cycles: [{ tenure_type: 'REGULAR', frequency: { interval_unit: 'YEAR', interval_count: 1 } }] })
  };
  const r = await ev.renewalCycleEnd({ paypal: ended, subscriptionId: 'I-CE3', resource: sale, logger });
  assert.deepEqual(r, { effectiveUntil: at('2028-01-15T08:00:00Z'), nextBillingAt: null, estimated: true });
  assert.match(lines[1], /PayPal gave no next billing time/);
  assert.ok(!lines.some(l => /@/.test(l)));
});

test('a billing failure is news for staff only when the failure count moves above zero', () => {
  assert.equal(ev.billingIssueEscalates({ prev: null, failedCount: 0 }), false);
  assert.equal(ev.billingIssueEscalates({ prev: null, failedCount: 1 }), true);
  assert.equal(ev.billingIssueEscalates({ prev: { failed_count: 0, resolved_at: null }, failedCount: 1 }), true);
  assert.equal(ev.billingIssueEscalates({ prev: { failed_count: 1, resolved_at: null }, failedCount: 1 }), false);
  assert.equal(ev.billingIssueEscalates({ prev: { failed_count: 2, resolved_at: NOW }, failedCount: 1 }), true, 'a resolved issue failing again');
  assert.equal(ev.billingIssueEscalates({ prev: { failed_count: 2, resolved_at: NOW }, failedCount: 0 }), false);
});

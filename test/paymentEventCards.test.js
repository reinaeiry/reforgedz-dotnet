// Tests for the cards about staff revokes, refunds, reversals, disputes, payments
// with no order and ended subscriptions (paymentCards.js), built into webhook
// bodies with tools/lib/discordCard.js. Pure: no database, nothing posted.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.PAYMENTS_ALERT_ROLE_ID;
delete process.env.BASE_URL;
delete process.env.DISCORD_WEBHOOK_URL;

const dc = require('../tools/lib/discordCard');
const cards = require('../paymentCards');

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const HEX32_RE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;
const UNTIL = 1800000000;
const EU1 = dc.serverLabel('eu1');

// Shaped like getOrderWithContext: an order with its user and product.
const ROW = Object.freeze({
  id: 721, steam_id: '76561190000000001', persona: 'Nightfall', platform: 'steam', gamertag: null, bm_player_id: null,
  bi_uid: '0123abcd-4567-4890-9abc-def012345678', payer_email: 'buyer@example.com', product_title: 'Priority Queue',
  server_id: 'eu1', amount_cents: 1500, currency: 'usd', test_mode: 0, status: 'completed',
  paypal_subscription_id: 'I-ABCDEF123456', paypal_capture_id: '5AB12345CD678901E'
});
const ONE_TIME = Object.freeze({ ...ROW, id: 722, paypal_subscription_id: null, product_title: 'Supporter', server_id: null });

const embedOf = (body) => body.embeds[0];
const field = (embed, name) => (embed.fields.find(f => f.name === name) || {}).value;
const built = (spec) => dc.buildCard(spec);

function assertClean(body) {
  const text = JSON.stringify(body);
  assert.ok(!EMAIL_RE.test(text), 'no email address on a card');
  assert.ok(!HEX32_RE.test(text), 'no full in-game ID on a card');
}

// ---- Staff revoke ----------------------------------------------------------------

test('a staff refund reads "Refunded $X", is purple and silent, and shows the refund and the PayPal cancel', () => {
  const body = built(cards.staffRevokeCard({ order: ROW, refunded: true, refundedCents: 1500, refundId: 'RF123', refundStatus: 'COMPLETED', cancel: { outcome: 'cancelled' } }));
  const e = embedOf(body);
  assert.equal(e.title, `Refunded $15.00 · Priority Queue · ${EU1}`);
  assert.equal(e.color, dc.KIND_COLORS.refund_out);
  assert.equal(body.flags, dc.SUPPRESS_NOTIFICATIONS);
  assert.equal(field(e, 'Amount'), '$15.00');
  assert.equal(field(e, 'Status'), 'Refunded');
  assert.equal(field(e, 'PayPal subscription'), 'Cancelled at PayPal');
  assert.equal(field(e, 'Refund id'), '`RF123`');
  assert.equal(field(e, 'Refund at PayPal'), undefined);
  assert.match(e.description, /refunded \$15\.00/);
  assert.equal(e.footer.text, 'Order #721');
  assertClean(body);
});

test('a revoke without a refund reads "Access removed, not refunded" and carries no Amount', () => {
  const body = built(cards.staffRevokeCard({ order: ROW, refunded: false, cancel: { outcome: 'cancelled' } }));
  const e = embedOf(body);
  assert.equal(e.title, `Access removed, not refunded · Priority Queue · ${EU1}`);
  assert.equal(e.color, dc.KIND_COLORS.info);
  assert.equal(field(e, 'Amount'), undefined);
  assert.equal(field(e, 'Status'), 'Revoked');
  assert.equal(field(e, 'Refund'), 'None (the order was $15.00)');
  assert.match(e.description, /No money was returned/);
  assertClean(body);
});

test('a failed PayPal cancel makes the revoke card red and says what to do', () => {
  for (const refunded of [true, false]) {
    const body = built(cards.staffRevokeCard({ order: ROW, refunded, refundedCents: 1500, cancel: { outcome: 'failed', status: 500 } }));
    const e = embedOf(body);
    assert.equal(e.color, dc.KIND_COLORS.action);
    assert.equal(body.flags, undefined, 'staff are notified');
    assert.equal(field(e, 'PayPal subscription'), 'Cancel failed (HTTP 500)');
    assert.match(e.description, /did not cancel the subscription \(HTTP 500\).*cancel it in PayPal/);
  }
});

test('an agreement already ended at PayPal is not a failure; a one-time order has no subscription fields', () => {
  const ended = embedOf(built(cards.staffRevokeCard({ order: ROW, refunded: true, refundedCents: 1500, cancel: { outcome: 'already_ended', status: 422 } })));
  assert.equal(field(ended, 'PayPal subscription'), 'Already ended at PayPal');
  assert.equal(ended.color, dc.KIND_COLORS.refund_out);
  const oneTime = embedOf(built(cards.staffRevokeCard({ order: ONE_TIME, refunded: true, refundedCents: 1500, cancel: { outcome: 'none' } })));
  assert.equal(field(oneTime, 'PayPal subscription'), undefined);
  assert.equal(field(oneTime, 'Subscription'), undefined);
});

test('a refund PayPal has not finished reads "Refund pending", is amber and notifies; a missing refunded amount falls back to the price', () => {
  const body = built(cards.staffRevokeCard({ order: ROW, refunded: true, refundedCents: 0, refundStatus: 'PENDING', cancel: { outcome: 'cancelled' } }));
  const e = embedOf(body);
  assert.equal(e.title, `Refund pending $15.00 · Priority Queue · ${EU1}`);
  assert.equal(e.color, dc.KIND_COLORS.attention);
  assert.equal(body.flags, undefined, 'staff are notified');
  assert.equal(field(e, 'Refund at PayPal'), 'Pending');
  assert.equal(field(e, 'Status'), 'Refund pending');
  assert.equal(field(e, 'Amount'), '$15.00');
  assert.match(e.description, /has not finished the refund/);
});

// ---- Refunds and reversals from PayPal ----------------------------------------------

const plan = (over) => ({ kind: 'refund', action: 'refunded', refundId: 'RF9', paymentId: 'SALE-2', amountCents: 1500, currency: 'USD', subscriptionId: null, refundedSoFarCents: 1500, ...over });

test('a refund made in PayPal that covers the order: "Order refunded", purple, and staff are notified', () => {
  const body = built(cards.refundEventCard({ plan: plan(), order: ROW }));
  const e = embedOf(body);
  assert.equal(e.title, `Order refunded · Priority Queue · ${EU1}`);
  assert.equal(e.color, dc.KIND_COLORS.refund_out);
  assert.equal(body.flags, undefined);
  assert.equal(field(e, 'Amount'), '$15.00');
  assert.equal(field(e, 'Payment'), '`SALE-2`');
  assert.equal(field(e, 'Refund id'), '`RF9`');
  assert.match(e.description, /outside the shop.*perks are removed/);
  assert.ok(e.url.endsWith('%23721'));
  assertClean(body);
});

test('a partial refund says the order keeps its perks and shows the total so far', () => {
  const e = embedOf(built(cards.refundEventCard({ plan: plan({ action: 'partial', amountCents: 500, refundedSoFarCents: 500 }), order: ROW })));
  assert.equal(e.title, `Partial refund · Priority Queue · ${EU1}`);
  assert.equal(field(e, 'Amount'), '$5.00');
  assert.equal(field(e, 'Refunded so far'), '$5.00');
  assert.equal(field(e, 'Status'), 'Completed, partly refunded');
  assert.match(e.description, /\$5\.00 of this \$15\.00 order.*keeps its perks/);
});

test('a refund on an order that was already refunded is recorded, not repeated as a revoke', () => {
  const e = embedOf(built(cards.refundEventCard({ plan: plan({ action: 'recorded' }), order: { ...ROW, status: 'refunded' } })));
  assert.equal(e.title, `Refund recorded · Priority Queue · ${EU1}`);
  assert.match(e.description, /already refunded\. Nothing else changed/);
});

test('a reversal is red, changes nothing and sends no refund wording to staff as if staff refunded', () => {
  const body = built(cards.refundEventCard({ plan: plan({ kind: 'reversal', action: 'reversed' }), order: ROW }));
  const e = embedOf(body);
  assert.equal(e.title, `Payment reversed · Priority Queue · ${EU1}`);
  assert.equal(e.color, dc.KIND_COLORS.action);
  assert.equal(field(e, 'Reversal'), '`RF9`');
  assert.match(e.description, /were not changed/);
});

test('a refund or reversal with no matching order has no order link and says nothing changed', () => {
  const refund = embedOf(built(cards.refundEventCard({ plan: plan({ action: 'unmatched', subscriptionId: 'I-GONE' }), order: null })));
  assert.equal(refund.title, 'Refund with no matching order');
  assert.equal(refund.color, dc.KIND_COLORS.attention);
  assert.equal(refund.url, undefined);
  assert.equal(field(refund, 'Subscription'), '`I-GONE`');
  const reversal = embedOf(built(cards.refundEventCard({ plan: plan({ kind: 'reversal', action: 'unmatched' }), order: null, testMode: true })));
  assert.equal(reversal.title, '[TEST] Payment reversed, no matching order');
  assert.equal(reversal.color, dc.KIND_COLORS.action);
});

test('an event id stands in for a missing refund id but is never shown; an unknown action throws', () => {
  const e = embedOf(built(cards.refundEventCard({ plan: plan({ refundId: 'event:WH-1' }), order: ROW })));
  assert.equal(field(e, 'Refund id'), undefined);
  assert.throws(() => cards.refundEventCard({ plan: plan({ action: 'duplicate' }), order: ROW }), /no card/);
});

// ---- Disputes -----------------------------------------------------------------------------

const dispute = (over) => ({
  disputeId: 'PP-D-100', status: 'OPEN', reason: 'UNAUTHORISED', stage: 'CHARGEBACK', outcome: null,
  amountCents: 4500, currency: 'USD', respondBy: UNTIL, paymentId: 'SALE-2', amountRefundedCents: null, ...over
});

test('a dispute opening is red, names the reason and the deadline, and says the order was not changed', () => {
  const body = built(cards.disputeCard({ card: 'opened', dispute: dispute(), order: ROW }));
  const e = embedOf(body);
  assert.equal(e.title, `Dispute opened · Priority Queue · ${EU1}`);
  assert.equal(e.color, dc.KIND_COLORS.action);
  assert.equal(field(e, 'Amount'), '$45.00');
  assert.equal(field(e, 'Reason'), 'Not authorised by the account holder');
  assert.equal(field(e, 'Stage'), 'Chargeback');
  assert.equal(field(e, 'Respond by'), `<t:${UNTIL}:D>`);
  assert.equal(field(e, 'Dispute'), '`PP-D-100`');
  assert.match(e.description, /Nothing was changed on the order or its perks/);
  assertClean(body);
});

test('a status change is amber, or red when PayPal waits for the shop', () => {
  const moved = embedOf(built(cards.disputeCard({ card: 'status_changed', dispute: dispute({ status: 'UNDER_REVIEW' }), previous: { status: 'OPEN' }, order: ROW })));
  assert.equal(moved.title, `Dispute updated · Priority Queue · ${EU1}`);
  assert.equal(moved.color, dc.KIND_COLORS.attention);
  assert.match(moved.description, /from open to under review/);
  const ours = embedOf(built(cards.disputeCard({ card: 'status_changed', dispute: dispute({ status: 'WAITING_FOR_SELLER_RESPONSE' }), previous: { status: 'OPEN' }, order: ROW })));
  assert.equal(ours.color, dc.KIND_COLORS.action);
  assert.match(ours.description, /waiting for the shop/);
});

test('a closed dispute is red when lost, green when won, amber when PayPal does not say', () => {
  const lost = embedOf(built(cards.disputeCard({ card: 'resolved', result: 'lost', dispute: dispute({ status: 'RESOLVED', outcome: 'RESOLVED_BUYER_FAVOUR', amountRefundedCents: 4500 }), order: ROW })));
  assert.equal(lost.title, `Dispute lost · Priority Queue · ${EU1}`);
  assert.equal(lost.color, dc.KIND_COLORS.action);
  assert.equal(field(lost, 'Outcome'), 'Resolved buyer favour');
  assert.match(lost.description, /lost \$45\.00/);
  const won = embedOf(built(cards.disputeCard({ card: 'resolved', result: 'won', dispute: dispute({ status: 'RESOLVED', outcome: 'RESOLVED_SELLER_FAVOUR' }), order: ROW })));
  assert.equal(won.title, `Dispute won · Priority Queue · ${EU1}`);
  assert.equal(won.color, dc.KIND_COLORS.money_in);
  const unclear = embedOf(built(cards.disputeCard({ card: 'resolved', result: 'unclear', dispute: dispute({ status: 'RESOLVED', outcome: 'RESOLVED_WITH_PAYOUT' }), order: ROW })));
  assert.equal(unclear.title, `Dispute closed · Priority Queue · ${EU1}`);
  assert.equal(unclear.color, dc.KIND_COLORS.attention);
});

test('a dispute with no matching order still carries the dispute and says no order matched', () => {
  const e = embedOf(built(cards.disputeCard({ card: 'opened', dispute: dispute({ reason: 'SOMETHING_NEW' }), order: null })));
  assert.equal(e.title, 'Dispute opened');
  assert.equal(e.url, undefined);
  assert.equal(field(e, 'Order'), 'No order matches the disputed payment');
  assert.equal(field(e, 'Reason'), 'Something new');
  assert.throws(() => cards.disputeCard({ card: 'nope', dispute: dispute(), order: ROW }), /no dispute card/);
});

// ---- A payment with no order -----------------------------------------------------------

test('a payment on a subscription with no orders is red and names the subscription, sale and checkout order', () => {
  const body = built(cards.unmatchedSaleCard({ subId: 'I-NOORDERS1', saleId: 'SALE-77', amountCents: 1500, currency: 'USD', customId: 612 }));
  const e = embedOf(body);
  assert.equal(e.title, 'Payment on a subscription with no orders');
  assert.equal(e.color, dc.KIND_COLORS.action);
  assert.equal(e.url, undefined);
  assert.equal(field(e, 'Amount'), '$15.00');
  assert.equal(field(e, 'Subscription'), '`I-NOORDERS1`');
  assert.equal(field(e, 'Sale'), '`SALE-77`');
  assert.equal(field(e, 'Checkout order named by PayPal'), '#612');
  const noAmount = embedOf(built(cards.unmatchedSaleCard({ subId: 'I-X', saleId: 'S', amountCents: null })));
  assert.equal(field(noAmount, 'Amount'), 'Not given by PayPal');
});

// ---- Ended subscriptions ------------------------------------------------------------------

test('cancelled, suspended and expired cards are never red and never show an Amount', () => {
  for (const reason of ['cancelled', 'suspended', 'expired']) {
    const body = built(cards.subscriptionEndedCard(reason, ROW, { accessUntil: UNTIL, note: 'Cancelled by customer', failedCount: 3, outstandingCents: 1500 }));
    const e = embedOf(body);
    assert.notEqual(e.color, dc.KIND_COLORS.action, reason);
    assert.equal(e.color, dc.KIND_COLORS.ended, reason);
    assert.equal(field(e, 'Amount'), undefined, reason);
    assert.equal(field(e, 'Access until'), `<t:${UNTIL}:D>`, reason);
    assert.match(e.description, /keeps access until the date shown/);
    assertClean(body);
  }
});

test('ended cards say who cancelled, why PayPal suspended, and when no paid access is left', () => {
  const cancelled = embedOf(built(cards.subscriptionEndedCard('cancelled', ROW, { accessUntil: UNTIL })));
  assert.equal(cancelled.title, `Subscription cancelled · Priority Queue · ${EU1}`);
  assert.equal(field(cancelled, 'Cancelled via'), 'PayPal, by the buyer (no note)');
  const suspended = embedOf(built(cards.subscriptionEndedCard('suspended', ROW, { accessUntil: null, failedCount: 3, outstandingCents: 4500 })));
  assert.equal(field(suspended, 'Why'), 'PayPal stopped retrying after 3 failed payments');
  assert.equal(field(suspended, 'Outstanding'), '$45.00');
  assert.equal(field(suspended, 'Access until'), 'No paid access left');
  assert.match(suspended.description, /No paid access is left/);
  assert.throws(() => cards.subscriptionEndedCard('paused', ROW), /unknown ended reason/);
});

test('an ended card whose paid access is already over says so instead of "keeps access"', () => {
  const e = embedOf(built(cards.subscriptionEndedCard('cancelled', ROW, { accessUntil: UNTIL, now: UNTIL + 86400 })));
  assert.equal(field(e, 'Access until'), `<t:${UNTIL}:D>`);
  assert.match(e.description, /paid access already ended on the date shown/);
  assert.doesNotMatch(e.description, /keeps access/);
  const future = embedOf(built(cards.subscriptionEndedCard('expired', ROW, { accessUntil: UNTIL, now: UNTIL - 86400 })));
  assert.match(future.description, /keeps access until the date shown/);
});

// ---- Staff moves, the admin list limit, unknown and pending states, failed refunds, rescans

const EU2 = dc.serverLabel('eu2');

test("cards name the order's own server: a staff move changes it, so there is no second server to show", () => {
  const moved = Object.freeze({ ...ROW, server_id: 'eu2', pq_queue: Object.freeze({ boughtFor: 'eu1', queueOn: 'na1' }) });
  const specs = [
    cards.orderEventCard('subscription_renewed', moved, { nextCharge: UNTIL }),
    cards.subscriptionEndedCard('cancelled', moved, { accessUntil: UNTIL }),
    cards.unpaidEndedCard({ ctx: { ...moved, id: undefined, order_id: 721 }, subscriptionId: 'I-X', cancel: { outcome: 'cancelled' }, failedCount: 1 }),
    cards.refusedPaymentCard({ ctx: moved, saleId: 'S', amountCents: 1500, reason: 'no_slot', refund: { outcome: 'refunded' }, cancel: { outcome: 'cancelled' } }),
    cards.refusedActivationCard({ order: moved, cancel: { outcome: 'cancelled' } }),
    cards.staffRevokeCard({ order: moved, refunded: true, refundedCents: 1500, cancel: { outcome: 'cancelled' } }),
    cards.refundEventCard({ plan: plan(), order: moved }),
    cards.disputeCard({ card: 'opened', dispute: dispute(), order: moved }),
    cards.renewalAfterRefundCard({ subId: 'I-X', saleId: 'S', refundedOrderId: 700, newOrderId: 721, original: moved, amountCents: 1500 }),
    cards.revokedRenewalCard({ subId: 'I-X', saleId: 'S', orders: [{ id: 721, status: 'refunded' }], context: moved }),
    cards.refundUnknownCard({ order: moved, amountCents: 1500 })
  ];
  for (const spec of specs) {
    const body = built(spec);
    const e = embedOf(body);
    assert.ok(e.title.endsWith(` · ${EU2}`), e.title);
    assert.equal(field(e, 'Queue on'), undefined, e.title);
    assertClean(body);
  }
});

test('a staff move card is grey and silent, and names both servers, every changed order and the reason', () => {
  const after = { ...ROW, server_id: 'eu2', effective_until: UNTIL };
  const body = built(cards.staffQueueMoveCard({ order: after, from: 'eu1', to: 'eu2', orderIds: [640, 700, 721], reason: 'Wants to play with friends' }));
  const e = embedOf(body);
  assert.equal(e.title, `Priority queue moved by staff · Priority Queue · ${EU2}`);
  assert.equal(e.color, dc.KIND_COLORS.info);
  assert.equal(body.flags, dc.SUPPRESS_NOTIFICATIONS);
  assert.equal(field(e, 'Moved'), `${EU1} to ${EU2}`);
  assert.equal(field(e, 'Orders changed'), '#640, #700, #721');
  assert.equal(field(e, 'Subscription'), '`I-ABCDEF123456`');
  assert.equal(field(e, 'Reason'), 'Wants to play with friends');
  assert.equal(field(e, 'Access until'), `<t:${UNTIL}:D>`);
  assert.match(e.description, /renewals pay for EU2/);
  assert.equal(e.footer.text, "Order #721 · Takes effect at each server's next restart");
  assertClean(body);

  const oneTime = embedOf(built(cards.staffQueueMoveCard({ order: { ...ONE_TIME, product_title: 'Priority Queue', server_id: 'na1' }, from: 'na2', to: 'na1', orderIds: [722] })));
  assert.equal(field(oneTime, 'Order changed'), '#722');
  assert.equal(field(oneTime, 'Subscription'), undefined);
  assert.equal(field(oneTime, 'Reason'), undefined);
  assert.doesNotMatch(oneTime.description, /renewals/);
  for (const text of [e.description, oneTime.description]) assert.doesNotMatch(text, /[—–]|dayz/i);
});

test('an admin list over the limit is a red card with counts only', () => {
  const body = built(cards.adminCeilingCard({ serverId: 'eu1', planned: 51, ceiling: 50, current: 50, shopOwned: 40, others: 11 }));
  const e = embedOf(body);
  assert.equal(e.title, `Admin list over the limit · ${EU1}`);
  assert.equal(e.color, dc.KIND_COLORS.action);
  assert.equal(body.flags, undefined, 'someone has to act, so it notifies');
  assert.equal(field(e, 'Entries after this sync'), '51');
  assert.equal(field(e, 'Limit'), '50');
  assert.equal(field(e, 'Entries before'), '50');
  assert.equal(field(e, 'Priority queue, from the shop'), '40');
  assert.equal(field(e, 'Game masters and others'), '11');
  assert.match(e.description, /Nothing was removed/);
  assert.doesNotMatch(e.description, /[—–]|dayz/i);
  assertClean(body);
});

test('a cancel PayPal did not answer makes the revoke card amber and says to check PayPal', () => {
  const body = built(cards.staffRevokeCard({ order: ROW, refunded: false, cancel: { outcome: 'unknown', status: 0 } }));
  const e = embedOf(body);
  assert.equal(e.color, dc.KIND_COLORS.attention);
  assert.equal(body.flags, undefined);
  assert.equal(field(e, 'PayPal subscription'), 'No answer from PayPal: check it there');
  assert.match(e.description, /did not answer the request to cancel.*check it in PayPal/);
});

test('refunds made earlier in PayPal are shown on the revoke card, and a covered order is not called refunded', () => {
  const part = embedOf(built(cards.staffRevokeCard({ order: ROW, refunded: true, refundedCents: 1000, earlierRefundedCents: 500, cancel: { outcome: 'cancelled' } })));
  assert.equal(part.title, `Refunded $10.00 · Priority Queue · ${EU1}`);
  assert.equal(field(part, 'Refunded earlier in PayPal'), '$5.00');
  assert.match(part.description, /\$5\.00 had already been refunded in PayPal/);
  const covered = embedOf(built(cards.staffRevokeCard({ order: ROW, refunded: false, earlierRefundedCents: 1500, coveredEarlier: true, cancel: { outcome: 'cancelled' } })));
  assert.equal(covered.title, `Access removed, not refunded · Priority Queue · ${EU1}`);
  assert.equal(field(covered, 'Refund'), 'None now (earlier refunds covered the $15.00 order)');
  assert.match(covered.description, /already covered the order/);
});

test('a refund whose PayPal call got no answer is red, notifies, and says nothing changed', () => {
  const body = built(cards.refundUnknownCard({ order: ROW, amountCents: 1500 }));
  const e = embedOf(body);
  assert.equal(e.title, `Refund state unknown · Priority Queue · ${EU1}`);
  assert.equal(e.color, dc.KIND_COLORS.action);
  assert.equal(body.flags, undefined);
  assert.match(e.description, /did not answer in time.*Nothing was changed.*Check the payment in PayPal/);
  assert.equal(field(e, 'Payment'), '`5AB12345CD678901E`');
  assertClean(body);
});

test('a refund PayPal could not complete is red and says the money did not reach the buyer', () => {
  const p = { kind: 'refund_failed', action: 'failed', refundId: 'RF7', paymentId: 'SALE-2', amountCents: 1500, currency: 'USD', source: 'staff' };
  const body = built(cards.refundFailedCard({ plan: p, order: { ...ROW, status: 'refunded' } }));
  const e = embedOf(body);
  assert.equal(e.title, `Refund failed · Priority Queue · ${EU1}`);
  assert.equal(e.color, dc.KIND_COLORS.action);
  assert.match(e.description, /could not complete \$15\.00 back to the buyer.*Staff made this refund through the shop/);
  assert.equal(field(e, 'Refund id'), '`RF7`');
  assertClean(body);
  const orphan = embedOf(built(cards.refundFailedCard({ plan: { ...p, source: 'webhook' }, order: null, testMode: true })));
  assert.equal(orphan.title, '[TEST] Refund failed');
  assert.equal(field(orphan, 'Order'), 'No order matches the refunded payment');
  assert.doesNotMatch(orphan.description, /Staff made/);
});

test('a staff revoke with no money back is never called a refund on later cards', () => {
  const recorded = embedOf(built(cards.refundEventCard({ plan: plan({ action: 'recorded', revokedWithoutRefund: true }), order: { ...ROW, status: 'refunded' } })));
  assert.match(recorded.description, /staff had revoked without a refund/);
  assert.doesNotMatch(recorded.description, /already refunded/);
  const renewal = embedOf(built(cards.revokedRenewalCard({
    subId: 'I-X', saleId: 'S', context: ROW,
    orders: [{ id: 1, status: 'refunded', revoked_without_refund_at: UNTIL }, { id: 2, status: 'refunded', revoked_without_refund_at: null }]
  })));
  assert.equal(field(renewal, 'Orders'), '#1 revoked, no refund, #2 refunded');
  const a = embedOf(built(cards.renewalAfterRefundCard({ subId: 'I-X', saleId: 'S', refundedOrderId: 700, newOrderId: 721, original: ROW, amountCents: 1500, noRefund: true, nextCharge: UNTIL })));
  assert.equal(a.title, `Renewal after a revoke · Priority Queue · ${EU1}`);
  assert.equal(field(a, 'Revoked cycle (no refund)'), '#700');
  assert.equal(field(a, 'Refunded cycle'), undefined);
  assert.equal(field(a, 'Next charge'), `<t:${UNTIL}:D>`, 'the one card for the sale carries the renewal facts');
  const b = embedOf(built(cards.renewalAfterRefundCard({ subId: 'I-X', saleId: 'S', refundedOrderId: 700, newOrderId: 721, original: ROW, amountCents: 1500 })));
  assert.equal(b.title, `Renewal after a refund · Priority Queue · ${EU1}`);
  assert.equal(field(b, 'Refunded cycle'), '#700');
});

test('a suspended card says the shop is closing the agreement, and a close that did not happen gets its own card', () => {
  const suspended = embedOf(built(cards.subscriptionEndedCard('suspended', ROW, { accessUntil: null, failedCount: 3 })));
  assert.match(suspended.description, /The shop is closing the agreement at PayPal/);
  const refused = built(cards.closeSuspendedFailedCard({ subId: 'I-ABCDEF123456', ctx: ROW, cancel: { outcome: 'failed', status: 404 } }));
  assert.equal(embedOf(refused).title, `Could not close a suspended agreement · Priority Queue · ${EU1}`);
  assert.equal(embedOf(refused).color, dc.KIND_COLORS.action);
  assert.match(embedOf(refused).description, /refused to close it \(HTTP 404\).*Cancel it in PayPal/);
  assertClean(refused);
  const noAnswer = embedOf(built(cards.closeSuspendedFailedCard({ subId: 'I-ABCDEF123456', ctx: null, cancel: { outcome: 'unknown', status: 0 } })));
  assert.equal(noAnswer.color, dc.KIND_COLORS.attention);
  assert.equal(noAnswer.title, 'Could not close a suspended agreement');
  assert.match(noAnswer.description, /did not answer/);
});

test('a subscription ended for non-payment is blue and silent, red when PayPal refused the cancel, amber when it did not answer', () => {
  const body = built(cards.unpaidEndedCard({ ctx: { ...ROW, id: undefined, order_id: 721 }, cancel: { outcome: 'cancelled' }, failedCount: 1, outstandingCents: 1500, currency: 'USD', accessUntil: UNTIL, now: UNTIL + 3600 }));
  const e = embedOf(body);
  assert.equal(e.title, `Subscription ended, payment not received · Priority Queue · ${EU1}`);
  assert.equal(e.color, dc.KIND_COLORS.ended);
  assert.equal(body.flags, dc.SUPPRESS_NOTIFICATIONS);
  assert.equal(e.footer.text, 'Order #721');
  assert.equal(field(e, 'Status'), 'Ended, payment not received');
  assert.equal(field(e, 'Failed payments'), '1');
  assert.equal(field(e, 'Outstanding'), '$15.00');
  assert.equal(field(e, 'PayPal subscription'), 'Cancelled at PayPal');
  assert.equal(field(e, 'Amount'), undefined, 'nothing was paid or returned');
  assert.match(e.description, /ended the subscription at once.*paid access ended on the date shown/);
  assertClean(body);
  const pqCard = embedOf(built(cards.unpaidEndedCard({ ctx: { ...ROW, grants_priority_queue: 1 }, cancel: { outcome: 'cancelled' } })));
  assert.match(pqCard.description, /No payment, no priority queue/);
  const backerCard = embedOf(built(cards.unpaidEndedCard({ ctx: { ...ROW, product_title: 'ReforgedZ Backer', grants_priority_queue: 0 }, cancel: { outcome: 'cancelled' } })));
  assert.doesNotMatch(backerCard.description, /priority queue/i, 'a product that is not priority queue says nothing about slots');
  const refused = built(cards.unpaidEndedCard({ ctx: ROW, cancel: { outcome: 'failed', status: 422 }, source: 'reconcile' }));
  assert.equal(embedOf(refused).color, dc.KIND_COLORS.action);
  assert.equal(refused.flags, undefined);
  assert.equal(field(embedOf(refused), 'Access until'), 'No paid access left');
  assert.match(embedOf(refused).description, /daily PayPal check.*refused to cancel the subscription \(HTTP 422\)/);
  assert.equal(embedOf(built(cards.unpaidEndedCard({ ctx: ROW, cancel: { outcome: 'unknown' } }))).color, dc.KIND_COLORS.attention);
  assert.doesNotMatch(e.description + embedOf(refused).description, /[—–]|dayz/i);
});

test('a refused payment says why and what happened to the money: purple when refunded, red when PayPal refused, amber with no answer', () => {
  const slot = { limit: 24, used: 24, reserved: 1 };
  const ok = built(cards.refusedPaymentCard({ ctx: ROW, saleId: 'SALE-9', amountCents: 1500, currency: 'USD', reason: 'no_slot', serverId: 'eu1', slot, refund: { outcome: 'refunded', refundId: 'RF-9', refundStatus: 'COMPLETED' }, cancel: { outcome: 'cancelled' } }));
  const e = embedOf(ok);
  assert.equal(e.title, `Payment refunded, server full · Priority Queue · ${EU1}`);
  assert.equal(e.color, dc.KIND_COLORS.refund_out);
  assert.equal(field(e, 'Amount'), '$15.00');
  assert.equal(field(e, 'Sale'), '`SALE-9`');
  assert.equal(field(e, 'Refund id'), '`RF-9`');
  assert.equal(field(e, 'Priority queue slots'), '24 of 24 taken, 1 more waiting at PayPal');
  assert.match(e.description, /after this subscription's paid period and renewal window had ended.*refunded in full automatically/);
  assertClean(ok);
  const first = embedOf(built(cards.refusedPaymentCard({ ctx: ROW, amountCents: 1500, reason: 'no_slot', firstPayment: true, refund: { outcome: 'refunded' }, cancel: { outcome: 'cancelled' } })));
  assert.match(first.description, /the first payment of this subscription, after EU1.*had filled up/);
  const failed = built(cards.refusedPaymentCard({ ctx: ROW, amountCents: 1500, reason: 'ended_unpaid', refund: { outcome: 'failed', status: 422 }, cancel: { outcome: 'already_ended' } }));
  assert.equal(embedOf(failed).title, `Refund failed, subscription had ended · Priority Queue · ${EU1}`);
  assert.equal(embedOf(failed).color, dc.KIND_COLORS.action);
  assert.match(embedOf(failed).description, /already ended because a renewal payment failed.*refused the automatic refund \(HTTP 422\).*refund it in PayPal/);
  const unknown = embedOf(built(cards.refusedPaymentCard({ ctx: null, subscriptionId: 'I-X', saleId: 'S', amountCents: null, reason: 'ended_no_slot', refund: { outcome: 'unknown' }, cancel: { outcome: 'cancelled' }, testMode: true })));
  assert.equal(unknown.title, '[TEST] Refund state unknown, subscription had ended');
  assert.equal(unknown.color, dc.KIND_COLORS.attention);
  assert.match(unknown.description, /PayPal took a payment on a subscription/);
  const cancelFailed = embedOf(built(cards.refusedPaymentCard({ ctx: ROW, amountCents: 1500, reason: 'no_slot', refund: { outcome: 'refunded' }, cancel: { outcome: 'failed', status: 500 } })));
  assert.equal(cancelFailed.color, dc.KIND_COLORS.action);
  const revoked = embedOf(built(cards.refusedPaymentCard({ ctx: ROW, amountCents: 1500, reason: 'revoked', refund: { outcome: 'refunded' }, cancel: { outcome: 'cancelled' } })));
  assert.equal(revoked.title, `Payment refunded, subscription had ended · Priority Queue · ${EU1}`);
  assert.match(revoked.description, /orders had all been revoked or refunded and which the shop had already ended.*refunded in full automatically/);
  for (const text of [e.description, first.description, embedOf(failed).description, unknown.description, revoked.description]) assert.doesNotMatch(text, /[—–]|dayz/i);
});

test('a subscription not started for want of a slot is blue and silent, and names the server and the slots', () => {
  const body = built(cards.refusedActivationCard({ order: { ...ROW, status: 'cancelled' }, serverId: 'eu1', slot: { limit: 24, used: 23, reserved: 1 }, cancel: { outcome: 'cancelled' } }));
  const e = embedOf(body);
  assert.equal(e.title, `Subscription not started, server full · Priority Queue · ${EU1}`);
  assert.equal(e.color, dc.KIND_COLORS.ended);
  assert.equal(body.flags, dc.SUPPRESS_NOTIFICATIONS);
  assert.equal(field(e, 'Status'), 'Not started');
  assert.equal(field(e, 'Priority queue slots'), '23 of 24 taken, 1 more waiting at PayPal');
  assert.match(e.description, /EU1.*had no free priority queue slot.*refunded automatically/);
  assertClean(body);
  assert.equal(embedOf(built(cards.refusedActivationCard({ order: ROW, cancel: { outcome: 'unknown' } }))).color, dc.KIND_COLORS.attention);
});

test('a lost dispute that revoked the order is purple and says the perks were removed; one on an order already refunded says nothing changed', () => {
  const revoked = embedOf(built(cards.disputeCard({ card: 'resolved', result: 'lost', revoke: { revoked: true, reason: 'dispute_lost' }, dispute: dispute({ status: 'RESOLVED', outcome: 'RESOLVED_BUYER_FAVOUR', amountRefundedCents: 1500 }), order: { ...ROW, status: 'refunded' } })));
  assert.equal(revoked.title, `Dispute lost · Priority Queue · ${EU1}`);
  assert.equal(revoked.color, dc.KIND_COLORS.refund_out);
  assert.equal(field(revoked, 'Status'), 'Refunded');
  assert.match(revoked.description, /lost \$15\.00\. The order is now refunded and its perks were removed automatically\. Its subscription was not cancelled/);
  const already = embedOf(built(cards.disputeCard({ card: 'resolved', result: 'lost', revoke: { revoked: false, reason: 'not_completed', status: 'refunded' }, dispute: dispute({ status: 'RESOLVED', outcome: 'ACCEPTED' }), order: ROW })));
  assert.equal(already.color, dc.KIND_COLORS.action);
  assert.match(already.description, /already refunded, so nothing on it changed/);
});

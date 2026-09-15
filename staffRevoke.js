// A staff revoke (POST /api/shop/admin/revoke, from the admin page or the ticket
// bot's /refund): take an order's perks away, refund it at PayPal when asked, and
// cancel its subscription so PayPal stops billing.
//
// One staff action, one card. The refund made here is recorded by its PayPal id,
// so the refund webhook that follows finds it and stays quiet; the cancel is
// marked as the shop's own (paymentEvents.cancelAtPayPal), so the CANCELLED
// webhook does too.
//
// Nothing runs on require. routes/shop.js passes the database, the PayPal client
// and its side effects in, so test/staffRevoke.test.js drives every path with fakes.

const paymentEvents = require('./paymentEvents');
const cards = require('./paymentCards');

const nowUnix = () => Math.floor(Date.now() / 1000);

// The orders a revoke is running for right now. The refund webhook for an order
// in here is left for PayPal to deliver again (paymentEvents.handleRefundEvent),
// and a second revoke of the same order is refused. begin() refuses an order that
// is already running, so only the request that began a revoke can end it: a
// double click can never clear the first request's entry while it still waits on
// PayPal.
function createRevokeTracker() {
  const running = new Set();
  return {
    has: (orderId) => running.has(Number(orderId)),
    begin(orderId) {
      const id = Number(orderId);
      if (running.has(id)) return false;
      running.add(id);
      return true;
    },
    end(orderId) { running.delete(Number(orderId)); }
  };
}

// Refunds a PayPal capture (or a subscription cycle's sale) for an order. Returns
// PayPal's answer: { refundId, refundedCents, status, captureId }. An error thrown
// by the refund call itself carries refundAsked, so the caller can tell a refund
// PayPal may have made from one that was never asked for.
async function refundCaptureForOrder(paypal, order, amountCents) {
  const useTest = !!order.test_mode;
  let captureId = order.paypal_capture_id;
  // Backfill the capture id from PayPal if only the order id was stored.
  if (!captureId && order.paypal_order_id) {
    const pp = await paypal.getOrder(useTest, order.paypal_order_id);
    captureId = paypal.normalizeCapture(pp).captureId;
  }
  if (!captureId) throw new Error('Order has no PayPal capture to refund');
  try {
    const result = await paypal.refundCapture(useTest, captureId, {
      amountCents,
      currency: order.currency || 'USD'
    });
    return { ...result, captureId };
  } catch (e) {
    if (e && typeof e === 'object') e.refundAsked = true;
    throw e;
  }
}

// What a refund call that threw means (failed or unknown). The shop's own refunds
// of payments it cannot honour read it the same way, so it lives in paymentEvents.js.
const { refundErrorOutcome } = paymentEvents;

function attempt(log, what, fn) {
  try {
    return fn();
  } catch (e) {
    log.error(`[revoke] ${what} failed: ${e.message}`);
    return null;
  }
}

// Runs one revoke. order is the completed order with its user and product (the
// route's query). Resolves to { status, body } for the route to send; never throws
// for anything PayPal does. deps:
//   paypal                 getOrder, normalizeCapture, refundCapture, cancelSubscription
//   tracker                createRevokeTracker()
//   markCancelledLocally   (subscriptionId) marks the agreement ended on every row
//   sendCard               (specFn) posts a card
//   sendRefundEmail        ({ order, amountCents }) the buyer's refund confirmation
//   afterRevoke            (orderId) re-sync the game servers and remove the role
//   logger, now
//
// The refund amount is what the order charged less any refund already made in
// PayPal, so a partly refunded order can still be refunded in full here. When
// earlier refunds already cover it, nothing more is asked for.
async function revokeOrder(db, { order, refund = false }, deps = {}) {
  const {
    paypal, tracker, markCancelledLocally = () => {}, sendCard = () => {}, sendRefundEmail = () => {},
    afterRevoke = () => {}, logger = console, now = nowUnix()
  } = deps;
  const log = logger;

  if (refund && !order.paypal_capture_id && !order.paypal_order_id) {
    return { status: 400, body: { error: 'This is a legacy (Stripe) order — refund it from the PayPal/Stripe dashboard manually.' } };
  }
  if (!tracker.begin(order.id)) {
    return { status: 409, body: { error: 'This order is already being revoked. Wait a moment, then reload to see the result.' } };
  }

  try {
    const earlierCents = paymentEvents.refundedSoFar(db, order.id).cents;
    const priceCents = Number(order.amount_cents) || 0;
    const coveredEarlier = earlierCents > 0 && priceCents - earlierCents <= 0;

    let refundResult = null;
    let askedCents = null;
    if (refund && !coveredEarlier) {
      askedCents = earlierCents > 0 ? Math.max(1, priceCents - earlierCents) : order.amount_cents;
      try {
        refundResult = await refundCaptureForOrder(paypal, order, askedCents);
      } catch (e) {
        const msg = String((e && e.message) || e || '');
        if (refundErrorOutcome(e).outcome === 'unknown') {
          // Nothing is changed on a guess. If PayPal did make the refund, its
          // webhook records it once this revoke has ended.
          log.error(`[revoke] order #${order.id}: PayPal did not answer the refund request (${msg.slice(0, 200)}); nothing changed, staff told`);
          sendCard(() => cards.refundUnknownCard({ order, amountCents: askedCents }));
          return {
            status: 502,
            body: { error: 'Refund failed: PayPal did not answer in time, so the refund may or may not have gone through. Check the payment in PayPal before trying again.' }
          };
        }
        log.error(`Refund failed: ${msg}`);
        return { status: 502, body: { error: 'Refund failed: ' + msg } };
      }
    }
    const refundedCents = refundResult ? refundResult.refundedCents : 0;
    const shownCents = refundedCents || askedCents || order.amount_cents;

    if (refundResult) {
      // Recorded before anything else awaits, so the refund webhook finds it. A
      // response without an id still gets a row, which the webhook recognises.
      attempt(log, `order #${order.id}: recording the refund`, () => paymentEvents.recordRefund(db, {
        refundId: refundResult.refundId || `staff:${order.id}:${now}`,
        orderId: order.id,
        paymentId: refundResult.captureId || order.paypal_capture_id || null,
        amountCents: shownCents,
        currency: order.currency,
        kind: 'refund',
        source: 'staff',
        now
      }));
    }
    // Status 'refunded' either way: every entitlement reader takes it as no perks.
    // revoked_without_refund_at tells the money readers when nothing went back.
    const noMoneyBack = !refundResult && !coveredEarlier;
    db.prepare("UPDATE orders SET status = 'refunded', revoked_without_refund_at = ? WHERE id = ?")
      .run(noMoneyBack ? now : null, order.id);

    // A recurring PayPal subscription is cancelled too, or PayPal keeps billing the
    // buyer every cycle after their access was pulled. Without a refund there is no
    // refund confirmation, so the marker lets the CANCELLED webhook email the player.
    let cancel = { outcome: 'none', status: null, error: null };
    if (order.paypal_subscription_id) {
      cancel = await paymentEvents.cancelAtPayPal({
        db, paypal,
        testMode: !!order.test_mode,
        subscriptionId: order.paypal_subscription_id,
        reason: refund ? 'Revoked with refund by admin' : 'Revoked by admin',
        source: refundResult ? 'staff_revoke' : 'staff_revoke_no_refund',
        now
      });
      if (cancel.outcome === 'cancelled' || cancel.outcome === 'already_ended') {
        attempt(log, 'marking the subscription ended', () => markCancelledLocally(order.paypal_subscription_id));
      } else if (cancel.outcome === 'unknown') {
        log.error(`[revoke] PayPal did not answer the cancel of subscription ${order.paypal_subscription_id}: ${cancel.error}`);
      } else {
        log.error(`[revoke] Failed to cancel PayPal subscription ${order.paypal_subscription_id}: ${cancel.error}`);
      }
    }

    sendCard(() => cards.staffRevokeCard({
      order,
      refunded: !!refundResult,
      refundedCents: shownCents,
      refundId: refundResult ? refundResult.refundId : null,
      refundStatus: refundResult ? refundResult.status : null,
      cancel,
      earlierRefundedCents: earlierCents,
      coveredEarlier: refund && coveredEarlier
    }));

    // The refund confirmation is sent here and only here: the refund webhook that
    // follows finds this refund already recorded and sends nothing.
    if (refundResult && order.payer_email) {
      attempt(log, 'refund email', () => sendRefundEmail({ order, amountCents: shownCents }));
    }

    attempt(log, 'sync and role removal', () => afterRevoke(order.id));

    const subscriptionCancelled = cancel.outcome === 'cancelled' || cancel.outcome === 'already_ended';
    const subscriptionCancelError = cancel.outcome === 'failed'
      ? (cancel.error || `HTTP ${cancel.status}`)
      : cancel.outcome === 'unknown'
        ? `PayPal did not answer the cancel, so the subscription may still be active: check it in PayPal (${cancel.error || 'no response'})`
        : null;
    return { status: 200, body: { ok: true, refundedCents, subscriptionCancelled, subscriptionCancelError } };
  } finally {
    tracker.end(order.id);
  }
}

module.exports = { createRevokeTracker, refundCaptureForOrder, refundErrorOutcome, revokeOrder };

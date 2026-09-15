// PayPal money events the shop has to get exactly right: refunds, reversals,
// disputes, payments with no order behind them, how long access lasts when a
// subscription ends, and the cancellations the shop makes itself. Also the
// owner's billing rules (2026-09-15): a renewal that is not paid ends the
// subscription at once, a payment the shop cannot honour is refunded, a
// subscription only starts while its server has a slot, and a lost dispute takes
// the order's perks away.
//
// Every function takes the database handle (and any PayPal or Discord side
// effect) as a parameter and nothing runs on require. routes/shop.js starts
// timers and writes on load, so logic kept there cannot be tested; kept here, the
// tests drive it against a throwaway copy of the real schema
// (test/paymentEvents.test.js, test/billingLifecycle.test.js). routes/shop.js,
// tools/reconcile.js and tools/closeSuspendedSubscriptions.js wire it in.

const pqGuards = require('./pqGuards');
const pqEntitlement = require('./pqEntitlement');
const cards = require('./paymentCards');

const DAY = 86400;
const nowUnix = () => Math.floor(Date.now() / 1000);

// ---- Reading PayPal's payloads ----------------------------------------------------

// A money object in either PayPal shape: v2 {value, currency_code} or v1 {total,
// currency}. Refunds and reversals of v1 sales can carry negative totals, so the
// size is what counts. Returns { cents, currency } or null.
function moneyOf(m) {
  if (!m || typeof m !== 'object') return null;
  const raw = m.value != null ? m.value : m.total;
  const n = parseFloat(raw);
  if (raw == null || !Number.isFinite(n)) return null;
  return { cents: Math.round(Math.abs(n) * 100), currency: String(m.currency_code || m.currency || 'USD').toUpperCase() };
}

function unixOf(t) {
  if (!t) return null;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

function positiveInt(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The id at the end of a PayPal link to a capture or a sale.
const PAYMENT_LINK_RE = /\/(?:captures|capture|sales|sale)\/([A-Za-z0-9-]+)(?:[/?#]|$)/;
function paymentIdFromHref(href) {
  const m = PAYMENT_LINK_RE.exec(String(href || ''));
  return m ? m[1] : null;
}

// Which payment a refund or reversal is about, most specific first. PayPal puts it
// in different places: an Orders v2 refund links "up" to its capture, a refund of
// a subscription sale carries sale_id or a "sale" link. With includeOwnId the
// resource's own id comes last: for a refund that is the refund, which never
// equals a stored payment id, and a reversal can be sent as the payment itself.
function paymentIdsOf(resource, { includeOwnId = true } = {}) {
  const r = resource || {};
  const ids = [];
  const add = (v) => { if (typeof v === 'string' && v && !ids.includes(v)) ids.push(v); };
  add(r.sale_id);
  add(r.capture_id);
  const related = r.supplementary_data && r.supplementary_data.related_ids;
  if (related) add(related.capture_id);
  for (const l of Array.isArray(r.links) ? r.links : []) {
    if (l && (l.rel === 'up' || l.rel === 'sale' || l.rel === 'capture')) add(paymentIdFromHref(l.href));
  }
  if (includeOwnId) add(r.id);
  return ids;
}

// ---- Which order a payment belongs to ------------------------------------------------
// By the payment's own id first. orders.paypal_capture_id holds the capture id of
// a one-time purchase and the sale id of each subscription cycle.
//
// custom_id is NOT the order a subscription payment belongs to. A subscription is
// created with custom_id set to its FIRST order and PayPal repeats that on every
// cycle, so matching by it put a later cycle's refund on the first order. It is
// trusted only where it cannot be wrong: the subscription has exactly one order
// row and that row has no other payment booked on it. The subscription id some
// sale payloads carry (billing_agreement_id) gets the same rule.
function soleUnbookedCycle(db, subscriptionId) {
  if (!subscriptionId) return null;
  const rows = db.prepare('SELECT * FROM orders WHERE paypal_subscription_id = ? ORDER BY id ASC LIMIT 2').all(String(subscriptionId));
  if (rows.length !== 1) return null;
  const o = rows[0];
  return !o.paypal_capture_id || o.paypal_capture_id === o.paypal_subscription_id ? o : null;
}

function findOrderForPayment(db, { paymentIds = [], customId = null, subscriptionId = null } = {}) {
  const byPayment = db.prepare('SELECT * FROM orders WHERE paypal_capture_id = ? ORDER BY id ASC LIMIT 1');
  for (const id of paymentIds) {
    const order = byPayment.get(String(id));
    if (order) return { order, matchedBy: 'payment_id', paymentId: String(id) };
  }
  const cid = positiveInt(customId);
  if (cid) {
    const named = db.prepare('SELECT paypal_subscription_id FROM orders WHERE id = ?').get(cid);
    const order = named && named.paypal_subscription_id ? soleUnbookedCycle(db, named.paypal_subscription_id) : null;
    if (order && order.id === cid) return { order, matchedBy: 'custom_id', paymentId: null };
  }
  const order = soleUnbookedCycle(db, subscriptionId);
  if (order) return { order, matchedBy: 'subscription', paymentId: null };
  return { order: null, matchedBy: null, paymentId: null };
}

// ---- Refunds and reversals --------------------------------------------------------------
// Each PayPal refund is recorded once, by its own id, in paypal_refunds. A retry of
// the webhook, or the webhook for a refund staff made through the revoke route
// (which records the id PayPal hands back), then finds it and does nothing: one
// refund is one card and at most one email.
//
// The partial refund rule: an order becomes 'refunded' only once the refunds
// recorded against it add up to what that order charged, or PayPal's own running
// total for the payment does. A smaller refund is recorded and carded, and the
// order keeps its status and its perks: taking away a whole paid period because
// part of it went back is a staff decision, and revoke is there for it. A refund
// PayPal gives no amount for counts as whole, which is how the shop always read one.
//
// Reversals (a chargeback, or a bank taking the money back) never change the order
// by themselves. Staff answer them in PayPal and decide what happens to the perks.
const STAFF_REFUND_WINDOW_S = 7 * DAY;

// testMode matters only for a row with no order (a payment the shop refused): a row
// with an order takes its mode from the order.
function recordRefund(db, { refundId, orderId = null, paymentId = null, amountCents = null, currency = null, kind = 'refund', source = 'webhook', testMode = false, now = nowUnix() }) {
  if (!refundId) return false;
  return db.prepare(`
    INSERT OR IGNORE INTO paypal_refunds (refund_id, order_id, payment_id, amount_cents, currency, kind, source, received_at, test_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(String(refundId), orderId == null ? null : orderId, paymentId == null ? null : String(paymentId),
    Number.isFinite(amountCents) ? amountCents : null, currency || null, kind, source, now, testMode ? 1 : 0).changes > 0;
}

function refundedSoFar(db, orderId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS n, COALESCE(SUM(amount_cents IS NULL), 0) AS unknown
    FROM paypal_refunds WHERE order_id = ? AND kind = 'refund'
  `).get(orderId);
  return { cents: r.cents, count: r.n, unknownAmount: r.unknown > 0 };
}

function isWholeRefund({ orderAmountCents, refundedCents = 0, paypalTotalCents = null, unknownAmount = false }) {
  if (unknownAmount) return true;
  const charged = Number(orderAmountCents);
  if (!Number.isFinite(charged) || charged <= 0) return true;
  return Math.max(Number(refundedCents) || 0, Number(paypalTotalCents) || 0) >= charged;
}

// A staff refund of this order, recorded recently, that this webhook refund is the
// echo of. Refund ids normally match exactly; this covers a PayPal response that
// came back without one.
function staffRefundCovers(db, { orderId, amountCents = null, now = nowUnix() }) {
  return !!db.prepare(`
    SELECT 1 FROM paypal_refunds
    WHERE order_id = ? AND kind = 'refund' AND source = 'staff' AND received_at >= ?
      AND (? IS NULL OR amount_cents IS NULL OR amount_cents = ?)
    LIMIT 1
  `).get(orderId, now - STAFF_REFUND_WINDOW_S, Number.isFinite(amountCents) ? amountCents : null, Number.isFinite(amountCents) ? amountCents : null);
}

function refundKindOf(eventType) {
  return /\.REVERSED$/.test(String(eventType || '')) ? 'reversal' : 'refund';
}

// ---- Refunds the shop makes itself ------------------------------------------------------
// A payment the shop cannot honour is refunded at once (refuseSale). Its row in
// paypal_refunds (source 'shop', no order, the refused payment's id) is written
// before PayPal is asked, so a retry of the sale event refunds nothing twice and the
// refund webhook that follows is a duplicate: the refusal already reported it.

// What a refund call that threw means:
//   failed   PayPal was never asked, or answered with a 4xx and refused
//   unknown  PayPal was asked and gave no HTTP answer (the client timed out, the
//            network failed) or a 5xx, so the refund may have gone through
function refundErrorOutcome(err) {
  const status = Number(err && err.status) || 0;
  if (!err || !err.refundAsked) return { outcome: 'failed', status };
  if (status >= 400 && status < 500) return { outcome: 'failed', status };
  return { outcome: 'unknown', status };
}

// The shop's own refund of a payment, if it made one.
function shopRefundOfPayment(db, paymentId) {
  if (!paymentId) return null;
  return db.prepare("SELECT * FROM paypal_refunds WHERE payment_id = ? AND source = 'shop' AND kind = 'refund' LIMIT 1").get(String(paymentId)) || null;
}

// Refunds one PayPal payment (a subscription sale or a capture) in full, or by
// amountCents. Never throws. outcome: refunded | failed | unknown (refundErrorOutcome).
async function refundPayment({ paypal, testMode = false, paymentId, amountCents = null, currency = 'USD' }) {
  try {
    const r = await paypal.refundCapture(!!testMode, paymentId, {
      amountCents: Number.isFinite(amountCents) ? amountCents : undefined,
      currency: currency || 'USD'
    });
    return {
      outcome: 'refunded', status: null,
      refundId: r && r.refundId ? String(r.refundId) : null,
      refundedCents: r && Number.isFinite(r.refundedCents) && r.refundedCents > 0 ? r.refundedCents : amountCents,
      refundStatus: r && r.status ? String(r.status) : null,
      error: null
    };
  } catch (e) {
    const err = e && typeof e === 'object' ? e : new Error(String(e));
    err.refundAsked = true;
    const { outcome, status } = refundErrorOutcome(err);
    return { outcome, status, refundId: null, refundedCents: null, refundStatus: null, error: String(err.message || err).slice(0, 200) };
  }
}

// Records one refund or reversal event and makes the order change the rules above
// allow. Returns a plan for the caller's side effects; action is one of
//   ignored      no refund id and no event id: nothing to record it by
//   duplicate    already recorded (a retry, or a refund staff made here)
//   in_flight    staff are revoking this order right now; nothing recorded yet
//                (handleRefundEvent throws, so PayPal delivers the event again)
//   unmatched    no order owns the payment; recorded, nothing changed
//   reversed     a reversal on a known order; recorded, nothing changed
//   recorded     a refund on an order that was not 'completed'; recorded only
//                (revokedWithoutRefund: staff had revoked it with no money back,
//                and that mark is cleared now money has gone back)
//   partial      a refund that does not yet cover the order; order unchanged
//   refunded     the refunds now cover the order; order marked 'refunded'
// inFlight(orderId) says whether a staff revoke of that order is running.
function applyRefundEvent(db, { eventType, event = null, resource = {}, customId = null, now = nowUnix(), inFlight = null }) {
  const r = resource || {};
  const kind = refundKindOf(eventType);
  const amount = moneyOf(r.amount) || moneyOf(r.seller_payable_breakdown && r.seller_payable_breakdown.gross_amount);
  const total = moneyOf((r.seller_payable_breakdown && r.seller_payable_breakdown.total_refunded_amount) || r.total_refunded_amount);
  const plan = {
    kind,
    action: null,
    refundId: r.id ? String(r.id) : (event && event.id ? `event:${event.id}` : null),
    paymentId: paymentIdsOf(r, { includeOwnId: false })[0] || null,
    subscriptionId: r.billing_agreement_id || null,
    order: null,
    matchedBy: null,
    amountCents: amount ? amount.cents : null,
    currency: amount ? amount.currency : null,
    refundedSoFarCents: null,
    revokedWithoutRefund: false
  };
  if (!plan.refundId) { plan.action = 'ignored'; return plan; }
  if (db.prepare('SELECT 1 FROM paypal_refunds WHERE refund_id = ?').get(plan.refundId)) { plan.action = 'duplicate'; return plan; }
  // The echo of a refund the shop made when it refused a payment (refuseSale), which
  // can land before the refund's own id is stored against the payment.
  if (kind === 'refund' && shopRefundOfPayment(db, plan.paymentId)) { plan.action = 'duplicate'; return plan; }

  const match = findOrderForPayment(db, { paymentIds: paymentIdsOf(r), customId, subscriptionId: r.billing_agreement_id });
  plan.order = match.order;
  plan.matchedBy = match.matchedBy;
  if (match.matchedBy === 'payment_id') plan.paymentId = match.paymentId;
  const order = match.order;
  if (order && typeof inFlight === 'function' && inFlight(order.id)) { plan.action = 'in_flight'; return plan; }
  plan.revokedWithoutRefund = !!(order && order.revoked_without_refund_at);

  db.transaction(() => {
    if (order && kind === 'refund' && order.status === 'refunded' && staffRefundCovers(db, { orderId: order.id, amountCents: plan.amountCents, now })) {
      plan.action = 'duplicate';
      return;
    }
    const inserted = recordRefund(db, {
      refundId: plan.refundId, orderId: order ? order.id : null, paymentId: plan.paymentId,
      amountCents: plan.amountCents, currency: plan.currency, kind, source: 'webhook', now
    });
    if (!inserted) { plan.action = 'duplicate'; return; }
    if (!order) { plan.action = 'unmatched'; return; }
    if (kind === 'reversal') { plan.action = 'reversed'; return; }
    // Money has now gone back on an order staff revoked without a refund, so the
    // money readers must count it as refunded from here on.
    if (plan.revokedWithoutRefund) db.prepare('UPDATE orders SET revoked_without_refund_at = NULL WHERE id = ?').run(order.id);
    if (order.status !== 'completed') { plan.action = 'recorded'; return; }
    const so = refundedSoFar(db, order.id);
    plan.refundedSoFarCents = so.cents;
    const whole = isWholeRefund({
      orderAmountCents: order.amount_cents, refundedCents: so.cents,
      paypalTotalCents: total ? total.cents : null, unknownAmount: so.unknownAmount
    });
    if (!whole) { plan.action = 'partial'; return; }
    const upd = db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ? AND status = 'completed'").run(order.id);
    plan.action = upd.changes ? 'refunded' : 'recorded';
  })();
  return plan;
}

function attempt(log, what, fn) {
  try {
    return fn();
  } catch (e) {
    log.error(`[payments] ${what} failed: ${e.message}`);
    return null;
  }
}

// applyRefundEvent plus what follows it. effects (all optional):
//   getOrderWithContext(id), removeRole(orderId), sync(), sendCard(specFn),
//   sendRefundEmail({ order, amountCents, resource }), logger
// Only a refund that ends the order removes the role, re-syncs and emails the
// buyer; PayPal emails buyers about every refund itself, and a partial refund or a
// reversal must not tell anyone their perks are gone when they are not.
async function handleRefundEvent(db, input, effects = {}) {
  const log = effects.logger || console;
  const plan = applyRefundEvent(db, input);
  const what = plan.kind === 'reversal' ? 'reversal' : 'refund';
  if (plan.action === 'ignored') { log.warn(`[refund] ${what} event with no id ignored`); return plan; }
  if (plan.action === 'duplicate') { log.log(`[refund] ${what} ${plan.refundId} already recorded; nothing to do`); return plan; }
  if (plan.action === 'in_flight') {
    // Never answered 200 with nothing recorded: if the staff refund call then
    // times out after PayPal made the refund, this event is the only record of it.
    // The webhook answers 500 and PayPal delivers it again later, when the revoke
    // has either recorded this refund (a duplicate then) or failed (a refund made
    // in PayPal then).
    const e = new Error(`${what} ${plan.refundId} is for order #${plan.order.id}, which staff are revoking right now; left for PayPal to deliver again`);
    e.retryLater = true;
    throw e;
  }

  const context = plan.order && effects.getOrderWithContext
    ? attempt(log, 'order lookup', () => effects.getOrderWithContext(plan.order.id)) : null;
  const amount = Number.isFinite(plan.amountCents) ? `${plan.amountCents} cents` : 'no amount given';
  const on = plan.order ? `order #${plan.order.id}` : `payment ${plan.paymentId || 'unknown'}`;
  const lines = {
    refunded: ['log', `[refund] ${plan.refundId} (${amount}) covers ${on}; order marked refunded`],
    partial: ['log', `[refund] ${plan.refundId} (${amount}) is part of ${on}; order left as it is`],
    recorded: ['log', `[refund] ${plan.refundId} (${amount}) on ${on}, which was ${plan.order && plan.order.status}; recorded only`],
    reversed: ['error', `[refund] reversal ${plan.refundId} (${amount}) on ${on}; order not changed, staff told`],
    unmatched: ['error', `[refund] ${what} ${plan.refundId} (${amount}) matches no order (payment ${plan.paymentId || 'unknown'}); recorded, staff told`]
  }[plan.action];
  if (lines) log[lines[0]](lines[1]);

  if (plan.action === 'refunded') {
    attempt(log, 'role removal', () => effects.removeRole && effects.removeRole(plan.order.id));
    attempt(log, 'sync', () => effects.sync && effects.sync());
  }
  if (effects.sendCard) {
    const shown = context || plan.order || null;
    effects.sendCard(() => cards.refundEventCard({ plan, order: shown, testMode: !!input.testMode }));
  }
  if (plan.action === 'refunded' && plan.kind === 'refund' && context && effects.sendRefundEmail) {
    attempt(log, 'refund email', () => effects.sendRefundEmail({
      order: context,
      amountCents: Number.isFinite(plan.amountCents) ? plan.amountCents : context.amount_cents,
      resource: input.resource
    }));
  }
  return plan;
}

// ---- A refund PayPal could not complete -------------------------------------------------
// PAYMENT.REFUND.FAILED: PayPal accepted a refund and could not complete it later
// (a bank settlement that failed, for example), so the money never reached the
// buyer. The refund's row stays, with kind refund_failed, so it no longer counts
// toward what an order had back (refundedSoFar) and a retry of the event finds it.
// Nothing on the order changes: staff already decided what access it keeps, and
// whether to refund again is theirs to decide. Returns a plan; action is one of
//   ignored    no refund id
//   duplicate  already reported as failed
//   failed     reported now (order is the order the refund was for, or null)
function applyRefundFailure(db, { resource = {}, now = nowUnix() }) {
  const r = resource || {};
  const amount = moneyOf(r.amount);
  const plan = {
    kind: 'refund_failed',
    action: null,
    refundId: r.id ? String(r.id) : null,
    paymentId: paymentIdsOf(r, { includeOwnId: false })[0] || null,
    order: null,
    source: null,
    amountCents: amount ? amount.cents : null,
    currency: amount ? amount.currency : null
  };
  if (!plan.refundId) { plan.action = 'ignored'; return plan; }
  db.transaction(() => {
    const row = db.prepare('SELECT * FROM paypal_refunds WHERE refund_id = ?').get(plan.refundId);
    if (row && row.kind === 'refund_failed') { plan.action = 'duplicate'; return; }
    if (row) {
      db.prepare("UPDATE paypal_refunds SET kind = 'refund_failed' WHERE refund_id = ?").run(plan.refundId);
      plan.source = row.source;
      plan.paymentId = plan.paymentId || row.payment_id || null;
      if (plan.amountCents == null && row.amount_cents != null) {
        plan.amountCents = row.amount_cents;
        plan.currency = plan.currency || row.currency || null;
      }
      plan.order = row.order_id != null ? db.prepare('SELECT * FROM orders WHERE id = ?').get(row.order_id) || null : null;
    } else {
      plan.order = findOrderForPayment(db, { paymentIds: paymentIdsOf(r, { includeOwnId: false }) }).order;
      recordRefund(db, {
        refundId: plan.refundId, orderId: plan.order ? plan.order.id : null, paymentId: plan.paymentId,
        amountCents: plan.amountCents, currency: plan.currency, kind: 'refund_failed', source: 'webhook', now
      });
    }
    plan.action = 'failed';
  })();
  return plan;
}

// applyRefundFailure plus its card. effects: getOrderWithContext(id), sendCard(specFn), logger.
async function handleRefundFailure(db, input, effects = {}) {
  const log = effects.logger || console;
  const plan = applyRefundFailure(db, input);
  if (plan.action === 'ignored') { log.warn('[refund] failed-refund event with no refund id ignored'); return plan; }
  if (plan.action === 'duplicate') { log.log(`[refund] failed refund ${plan.refundId} already reported; nothing to do`); return plan; }
  log.error(`[refund] PayPal could not complete refund ${plan.refundId} on ${plan.order ? `order #${plan.order.id}` : `payment ${plan.paymentId || 'unknown'}`}; order not changed, staff told`);
  if (effects.sendCard) {
    const context = plan.order && effects.getOrderWithContext
      ? attempt(log, 'order lookup', () => effects.getOrderWithContext(plan.order.id)) : null;
    effects.sendCard(() => cards.refundFailedCard({ plan, order: context || plan.order, testMode: !!input.testMode }));
  }
  return plan;
}

// ---- Disputes ------------------------------------------------------------------------------
// CUSTOMER.DISPUTE.* events are recorded in paypal_disputes, one row per dispute,
// and staff get a card when one opens, when its status moves and when it closes.
// Only a dispute the shop lost changes the order: the owner's rule is that money
// back with the buyer takes the order's perks away (revokeForLostDispute). An open
// dispute, or a reversal hold, changes nothing.
function disputeOf(resource) {
  const r = resource || {};
  const txs = Array.isArray(r.disputed_transactions) ? r.disputed_transactions : [];
  const paymentIds = [];
  for (const t of txs) {
    const id = t && t.seller_transaction_id;
    if (typeof id === 'string' && id && !paymentIds.includes(id)) paymentIds.push(id);
  }
  const withCustom = txs.find(t => t && t.custom);
  const amount = moneyOf(r.dispute_amount);
  const outcome = r.dispute_outcome || {};
  const refunded = moneyOf(outcome.amount_refunded);
  return {
    disputeId: r.dispute_id || r.id || null,
    status: r.status ? String(r.status).toUpperCase() : null,
    reason: r.reason ? String(r.reason).toUpperCase() : null,
    stage: r.dispute_life_cycle_stage ? String(r.dispute_life_cycle_stage).toUpperCase() : null,
    outcome: outcome.outcome_code ? String(outcome.outcome_code).toUpperCase() : null,
    amountCents: amount ? amount.cents : null,
    currency: amount ? amount.currency : null,
    amountRefundedCents: refunded ? refunded.cents : null,
    paymentIds,
    customId: withCustom ? withCustom.custom : null,
    respondBy: unixOf(r.seller_response_due_date)
  };
}

// Whether the shop lost the money. RESOLVED_BUYER_FAVOUR and ACCEPTED (the shop
// accepted the claim) send it to the buyer, as does any refund the outcome names.
// RESOLVED_SELLER_FAVOUR, CANCELED_BY_BUYER and DENIED leave it with the shop.
// Anything else (RESOLVED_WITH_PAYOUT, NONE, nothing) is 'unclear', for staff to
// read in PayPal rather than be told something that may be wrong.
function disputeMoneyResult({ outcome, amountRefundedCents = null }) {
  if (Number(amountRefundedCents) > 0) return 'lost';
  const o = String(outcome || '').toUpperCase();
  if (o === 'RESOLVED_BUYER_FAVOUR' || o === 'ACCEPTED') return 'lost';
  if (o === 'RESOLVED_SELLER_FAVOUR' || o === 'CANCELED_BY_BUYER' || o === 'DENIED') return 'won';
  return 'unclear';
}

// Records one dispute event. card says which card is due, if any:
//   opened          the first event seen for this dispute
//   status_changed  PayPal moved its status (retries and repeats are silent)
//   resolved        it closed; result is lost, won or unclear
function applyDisputeEvent(db, { eventType, resource, now = nowUnix() }) {
  const d = disputeOf(resource);
  const out = { dispute: d, shown: null, previous: null, order: null, card: null, result: null };
  if (!d.disputeId) return out;
  const match = findOrderForPayment(db, { paymentIds: d.paymentIds, customId: d.customId });
  const status = d.status || (eventType === 'CUSTOMER.DISPUTE.RESOLVED' ? 'RESOLVED' : null);
  const paymentId = match.matchedBy === 'payment_id' ? match.paymentId : (d.paymentIds[0] || null);

  db.transaction(() => {
    const prev = db.prepare('SELECT * FROM paypal_disputes WHERE dispute_id = ?').get(String(d.disputeId)) || null;
    out.previous = prev;
    if (!prev) {
      db.prepare(`
        INSERT INTO paypal_disputes (dispute_id, order_id, payment_id, status, outcome, reason, stage,
                                     amount_cents, currency, respond_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(String(d.disputeId), match.order ? match.order.id : null, paymentId, status, d.outcome, d.reason, d.stage,
        d.amountCents, d.currency, d.respondBy, now, now);
    } else {
      db.prepare(`
        UPDATE paypal_disputes SET
          order_id = COALESCE(order_id, ?), payment_id = COALESCE(payment_id, ?),
          status = COALESCE(?, status), outcome = COALESCE(?, outcome), reason = COALESCE(?, reason),
          stage = COALESCE(?, stage), amount_cents = COALESCE(?, amount_cents), currency = COALESCE(?, currency),
          respond_by = COALESCE(?, respond_by), updated_at = ?
        WHERE dispute_id = ?
      `).run(match.order ? match.order.id : null, paymentId, status, d.outcome, d.reason, d.stage,
        d.amountCents, d.currency, d.respondBy, now, String(d.disputeId));
    }
    if (status === 'RESOLVED' && (!prev || prev.status !== 'RESOLVED')) out.card = 'resolved';
    else if (!prev) out.card = 'opened';
    else if (status && status !== prev.status) out.card = 'status_changed';
  })();

  const row = db.prepare('SELECT * FROM paypal_disputes WHERE dispute_id = ?').get(String(d.disputeId));
  out.order = match.order || (row.order_id ? db.prepare('SELECT * FROM orders WHERE id = ?').get(row.order_id) || null : null);
  out.shown = {
    disputeId: row.dispute_id, status: row.status, reason: row.reason, stage: row.stage, outcome: row.outcome,
    amountCents: row.amount_cents, currency: row.currency, respondBy: row.respond_by, paymentId: row.payment_id,
    amountRefundedCents: d.amountRefundedCents
  };
  if (out.card === 'resolved') out.result = disputeMoneyResult({ outcome: row.outcome, amountRefundedCents: d.amountRefundedCents });
  return out;
}

// applyDisputeEvent plus what follows it. A dispute that closed with the money back
// with the buyer takes the order's perks away (revokeForLostDispute), and the Discord
// role and the game servers follow; every other dispute event only posts its card.
// Once per dispute: applyDisputeEvent reports a resolution only the first time.
// effects: getOrderWithContext(id), removeRole(orderId), sync(), sendCard(specFn), logger.
async function handleDisputeEvent(db, input, effects = {}) {
  const log = effects.logger || console;
  const out = applyDisputeEvent(db, input);
  const d = out.shown;
  if (!d) { log.warn('[dispute] event with no dispute id ignored'); return out; }
  const on = out.order ? `order #${out.order.id}` : `payment ${d.paymentId || 'unknown'} (no matching order)`;
  if (!out.card) {
    log.log(`[dispute] ${d.disputeId} ${input.eventType}: status ${d.status || 'not given'} on ${on}; nothing new to report`);
    return out;
  }
  out.revoke = null;
  if (out.card === 'resolved' && out.result === 'lost' && out.order) {
    out.revoke = revokeForLostDispute(db, { order: out.order, disputeId: d.disputeId, now: input.now });
    if (out.revoke.revoked) {
      attempt(log, 'role removal', () => effects.removeRole && effects.removeRole(out.order.id));
      attempt(log, 'sync', () => effects.sync && effects.sync());
    }
  }
  const loud = out.card === 'opened' || out.result === 'lost';
  const change = out.revoke && out.revoke.revoked ? 'order revoked and its perks removed' : 'order not changed';
  log[loud ? 'error' : 'log'](`[dispute] ${d.disputeId} ${out.card}${out.result ? ` (${out.result})` : ''} on ${on}; ${change}`);
  if (effects.sendCard) {
    const context = out.order && effects.getOrderWithContext
      ? attempt(log, 'order lookup', () => effects.getOrderWithContext(out.order.id)) : null;
    effects.sendCard(() => cards.disputeCard({
      card: out.card, dispute: d, previous: out.previous, order: context || out.order, result: out.result, revoke: out.revoke, testMode: !!input.testMode
    }));
  }
  return out;
}

// ---- A payment on a subscription with no orders at all ------------------------------------
// PAYMENT.SALE.COMPLETED for a subscription the shop holds no order row for (a
// deleted product's orders, or a checkout whose row was lost) used to return 200
// with nothing written. Recorded once per sale id so a retry does not alert again.
// Returns null when the subscription has order rows (not this case), false when the
// sale was recorded before, true when recorded now.
function recordUnmatchedSale(db, { saleId, subscriptionId, amountCents = null, currency = null, customId = null, now = nowUnix() }) {
  if (!saleId || !subscriptionId) return null;
  if (db.prepare('SELECT 1 FROM orders WHERE paypal_subscription_id = ? LIMIT 1').get(String(subscriptionId))) return null;
  return db.prepare(`
    INSERT OR IGNORE INTO unmatched_sales (sale_id, subscription_id, amount_cents, currency, custom_id, received_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(String(saleId), String(subscriptionId), Number.isFinite(amountCents) ? amountCents : null,
    currency || null, customId == null ? null : String(customId), now).changes > 0;
}

// ---- Cancellations the shop makes itself -------------------------------------------------
// When the shop cancels an agreement at PayPal (a staff revoke, closing a suspended
// agreement, deleting a product), PayPal answers with BILLING.SUBSCRIPTION.CANCELLED,
// which used to post a second card and email the player again about something the
// first action already reported. The shop writes a marker the moment IT asks PayPal
// to cancel, and the CANCELLED handler stays quiet for a marked subscription.
//
// Deliberately not keyed on orders.subscription_ended_reason: the player's own
// cancel on the website writes that first too, and that webhook is what sends the
// player's cancellation email. A player's cancel writes no marker, and clears one
// left behind (see cancelAtPayPal's unknown outcome).
//
// staff_revoke_no_refund is a staff revoke that returned no money: its CANCELLED
// webhook still emails the player (endedNotices), because no refund confirmation
// told them billing stopped.
// unpaid and no_slot are the shop's billing rules ending a subscription
// (endUnpaidSubscription, refuseSale, reportRefusedActivation), and revoked is a
// payment refused on a subscription the shop had already taken back (refuseSale).
// Each of those posts its own card and email, so PayPal's CANCELLED webhook adds nothing.
const SHOP_CANCEL_SOURCES = Object.freeze(['staff_revoke', 'staff_revoke_no_refund', 'auto_close_suspended', 'hard_delete', 'close_suspended_tool', 'unpaid', 'no_slot', 'revoked']);
// PayPal retries a webhook for up to three days; a marker older than this is not
// about the CANCELLED event arriving now.
const SHOP_CANCEL_WINDOW_S = 14 * DAY;

function markShopCancel(db, { subscriptionId, source, now = nowUnix() }) {
  if (!subscriptionId) return false;
  if (!SHOP_CANCEL_SOURCES.includes(source)) throw new TypeError(`unknown cancel source "${source}"`);
  db.prepare(`
    INSERT INTO subscription_cancels (subscription_id, source, requested_at) VALUES (?, ?, ?)
    ON CONFLICT(subscription_id) DO UPDATE SET source = excluded.source, requested_at = excluded.requested_at
  `).run(String(subscriptionId), source, now);
  return true;
}

function clearShopCancel(db, subscriptionId) {
  if (!subscriptionId) return false;
  return db.prepare('DELETE FROM subscription_cancels WHERE subscription_id = ?').run(String(subscriptionId)).changes > 0;
}

function shopCancelFor(db, subscriptionId, now = nowUnix()) {
  if (!subscriptionId) return null;
  const row = db.prepare('SELECT source, requested_at FROM subscription_cancels WHERE subscription_id = ?').get(String(subscriptionId));
  return row && row.requested_at >= now - SHOP_CANCEL_WINDOW_S ? row : null;
}

// Puts the marker back the way it was before a cancel that did not happen: an
// earlier cancel's marker is kept exactly, one written only for this attempt goes.
function restoreShopCancel(db, subscriptionId, prior) {
  if (!subscriptionId) return false;
  if (!prior) return clearShopCancel(db, subscriptionId);
  db.prepare(`
    INSERT INTO subscription_cancels (subscription_id, source, requested_at) VALUES (?, ?, ?)
    ON CONFLICT(subscription_id) DO UPDATE SET source = excluded.source, requested_at = excluded.requested_at
  `).run(String(subscriptionId), prior.source, prior.requested_at);
  return true;
}

// What a cancel call that threw means:
//   already_ended  422 SUBSCRIPTION_STATUS_INVALID: the agreement had already
//                  ended, so nothing can bill again. Not a failure.
//   failed         any other 4xx: PayPal answered and refused (a 429 is refused
//                  too), so nothing was cancelled.
//   unknown        no HTTP answer (the client timed out or the network failed), or
//                  a 5xx: the cancel may have gone through, and nothing here can
//                  tell. A timeout proves nothing about what PayPal did.
function cancelErrorOutcome(err) {
  const status = Number(err && err.status) || 0;
  const details = err && err.body && Array.isArray(err.body.details) ? err.body.details : [];
  if (status === 422 && details.some(x => x && x.issue === 'SUBSCRIPTION_STATUS_INVALID')) return { outcome: 'already_ended', status };
  if (status >= 400 && status < 500) return { outcome: 'failed', status };
  return { outcome: 'unknown', status };
}

// Cancels at PayPal with the marker written first (the webhook can beat the
// response back). Never throws.
// outcome: none (no subscription) | cancelled | already_ended | failed | unknown.
//
// When PayPal refused, or said the agreement had already ended, the marker goes
// back to what it was before this call. An earlier shop cancel keeps its marker:
// its CANCELLED webhook can still be on the way, and must stay quiet. When PayPal
// did not answer, the marker stays, because the cancel may have happened and its
// webhook must not post a second card or email the player.
async function cancelAtPayPal({ db, paypal, testMode, subscriptionId, reason, source, now = nowUnix() }) {
  if (!subscriptionId) return { outcome: 'none', status: null, error: null };
  let prior = null;
  try {
    prior = db.prepare('SELECT source, requested_at FROM subscription_cancels WHERE subscription_id = ?').get(String(subscriptionId)) || null;
    markShopCancel(db, { subscriptionId, source, now });
  } catch (e) {
    return { outcome: 'failed', status: 0, error: `cancel not attempted, marker not written: ${e.message}` };
  }
  try {
    await paypal.cancelSubscription(!!testMode, subscriptionId, reason);
    return { outcome: 'cancelled', status: null, error: null };
  } catch (e) {
    const { outcome, status } = cancelErrorOutcome(e);
    if (outcome !== 'unknown') {
      try { restoreShopCancel(db, subscriptionId, prior); } catch { /* the window ages it out */ }
    }
    return { outcome, status, error: String((e && e.message) || e).slice(0, 200) };
  }
}

// Whether a cancelAtPayPal result means PayPal cannot bill the subscription again, which
// is the only case a player may be told "PayPal will not charge you for it again".
function billingStopped(cancel) {
  return !!cancel && (cancel.outcome === 'cancelled' || cancel.outcome === 'already_ended');
}

// Which notices a BILLING.SUBSCRIPTION.* ended event sends, given the shop's own
// cancel marker (shopCancelFor, read for a cancel only):
//   card         the ended card for staff
//   email        the player's cancellation or suspension email
//   claimAccess  whether that email may promise access up to a date
// A cancel the shop made was reported by the action that made it, so no card and
// no email, with one exception. After a staff revoke that returned no money there
// is no refund confirmation, and the cancellation email is the only word the
// player gets that billing stopped. That revoke took the paid period away, so the
// email makes no promise about access the player no longer has.
//
// shopEnded is shopEndedReason for the subscription. A subscription the shop's billing
// rules ended ('unpaid', 'no_slot') was reported when it ended, whatever came of the
// cancel at PayPal, so a later CANCELLED or SUSPENDED event sends nothing either. The
// cancel marker alone cannot say that: it is taken back when PayPal refuses the cancel,
// and staff cancelling by hand afterwards would otherwise email the player a second,
// different story. Only the shop ever writes those two reasons, so a player's own
// cancel is never silenced by this.
function endedNotices({ shopCancel = null, shopEnded = null } = {}) {
  if (shopEnded === 'unpaid' || shopEnded === 'no_slot') return { card: false, email: false, claimAccess: false };
  if (!shopCancel) return { card: true, email: true, claimAccess: true };
  if (shopCancel.source === 'staff_revoke_no_refund') return { card: false, email: true, claimAccess: false };
  return { card: false, email: false, claimAccess: false };
}

// ---- How long access lasts when a subscription ends -----------------------------------
// A cancel, suspension or expiry must never cut a period the buyer paid for. The
// handler used to set effective_until DOWN to a guess (the newest cycle's
// completed_at plus 31 days), which took a month from a buyer whose second payment
// had been booked on the first cycle's row. Now the date only ever moves later:
// when PayPal shows the last payment, access runs at least to that payment plus one
// billing interval of the plan (monthly when the plan cannot be read).
const MONTHLY = Object.freeze({ unit: 'MONTH', count: 1 });

function addMonthsUtc(unix, months) {
  const d = new Date(unix * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Math.floor(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000);
}

function addBillingInterval(unix, interval = MONTHLY) {
  const n = Math.max(1, parseInt(interval && interval.count, 10) || 1);
  switch (String((interval && interval.unit) || 'MONTH').toUpperCase()) {
    case 'DAY': return unix + n * DAY;
    case 'WEEK': return unix + n * 7 * DAY;
    case 'YEAR': return addMonthsUtc(unix, 12 * n);
    default: return addMonthsUtc(unix, n);
  }
}

function intervalOfPlan(plan) {
  const cycles = plan && Array.isArray(plan.billing_cycles) ? plan.billing_cycles : [];
  const c = cycles.find(x => String((x && x.tenure_type) || '').toUpperCase() === 'REGULAR') || cycles[0];
  const f = c && c.frequency;
  if (!f || !f.interval_unit) return null;
  return { unit: String(f.interval_unit).toUpperCase(), count: Math.max(1, parseInt(f.interval_count, 10) || 1) };
}

// Plans never change interval once created, so one lookup per plan is enough. A
// failed lookup is not cached and falls back to monthly.
const planIntervalCache = new Map();
async function planInterval(paypal, { testMode = false, planId = null, cache = planIntervalCache } = {}) {
  if (!planId || !paypal || typeof paypal.getPlan !== 'function') return MONTHLY;
  const key = `${testMode ? 'sandbox' : 'live'}:${planId}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const iv = intervalOfPlan(await paypal.getPlan(!!testMode, planId)) || MONTHLY;
    cache.set(key, iv);
    return iv;
  } catch {
    return MONTHLY;
  }
}

function paidThroughOf(billingInfo, interval = MONTHLY) {
  const t = unixOf(billingInfo && billingInfo.last_payment && billingInfo.last_payment.time);
  return t ? addBillingInterval(t, interval) : null;
}

// A cycle row starts within this of the payment that booked it (PayPal can deliver
// the sale event late, but not days before the payment). PayPal's last payment
// falling later than this after the newest cycle started means that payment was
// never booked as a cycle of its own.
const UNBOOKED_PAYMENT_GAP_S = 3 * DAY;

// Applies the floor to one subscription's completed rows:
//  - the newest completed cycle is raised to floor when it ends earlier, but only
//    when PayPal's last payment (lastPaymentAt, unix seconds) came more than
//    UNBOOKED_PAYMENT_GAP_S after that cycle started: a later payment was never
//    booked, so the cycle's date never moved. When the last payment IS the newest
//    cycle, its stored date already covers it, and an earlier date is one staff
//    set on purpose (the extend route can shorten access), so it is kept;
//  - a completed row with no date gets floor or its own completed_at + 31 days,
//    whichever is later (an undated subscription row would otherwise count as a
//    lifetime purchase for good);
//  - nothing is ever moved earlier.
// When the subscription's newest paid or refunded cycle was revoked (with or
// without a refund), the floor is not applied: PayPal's last payment is then most
// likely that cycle's, and raising an older cycle would hand back what staff took away.
// Returns { raised, filled, skipped, accessUntil } where accessUntil is the latest
// date a completed row of the subscription now runs to.
function applyPaidThroughFloor(db, { subscriptionId, floor = null, lastPaymentAt = null }) {
  const out = { raised: null, filled: [], skipped: null, accessUntil: null };
  if (!subscriptionId) return out;
  const sub = String(subscriptionId);
  const hasFloor = Number.isFinite(floor) && floor > 0;
  // A subscription the shop ended (payment not received, or no slot for a payment)
  // keeps exactly what it had: PayPal's last payment may be one the shop refused and
  // refunded, and raising a cycle to it would give that slot back for free.
  const shopEnded = hasFloor ? shopEndedReason(db, sub) : null;
  const latestRefunded = hasFloor && !shopEnded ? pqGuards.refundedLatestCycle(db, sub) : null;
  if (shopEnded) out.skipped = 'ended_by_shop';
  else if (latestRefunded) out.skipped = 'latest_cycle_refunded';
  const usable = hasFloor && !shopEnded && !latestRefunded ? floor : null;

  db.transaction(() => {
    const undated = db.prepare(`
      SELECT id, completed_at, created_at FROM orders
      WHERE paypal_subscription_id = ? AND status = 'completed' AND effective_until IS NULL
    `).all(sub);
    const fill = db.prepare('UPDATE orders SET effective_until = ? WHERE id = ? AND effective_until IS NULL');
    for (const r of undated) {
      const start = r.completed_at || r.created_at;
      const until = Math.max(usable || 0, start ? start + 31 * DAY : 0);
      if (until > 0) { fill.run(until, r.id); out.filled.push(r.id); }
    }
    if (usable) {
      const newest = db.prepare(`
        SELECT id, effective_until, completed_at, created_at FROM orders
        WHERE paypal_subscription_id = ? AND status = 'completed'
        ORDER BY id DESC LIMIT 1
      `).get(sub);
      const start = newest ? (newest.completed_at || newest.created_at) : null;
      const paidLater = Number.isFinite(lastPaymentAt) && !!start && lastPaymentAt > start + UNBOOKED_PAYMENT_GAP_S;
      if (newest && paidLater && newest.effective_until != null && newest.effective_until < usable) {
        db.prepare('UPDATE orders SET effective_until = ? WHERE id = ? AND effective_until < ?').run(usable, newest.id, usable);
        out.raised = { id: newest.id, from: newest.effective_until, to: usable };
      }
    }
    const u = db.prepare("SELECT MAX(effective_until) AS u FROM orders WHERE paypal_subscription_id = ? AND status = 'completed'").get(sub);
    out.accessUntil = u && u.u ? u.u : null;
  })();
  return out;
}

// ---- Filling the first cycle's row ------------------------------------------------------
// ACTIVATED completes the checkout row with no payment id, and the first
// PAYMENT.SALE.COMPLETED fills it in instead of adding a second row. If that first
// sale never arrived, the NEXT month's sale used to fill the row silently: no
// renewal card, no invoice, and one row standing for two payments. So the row is
// filled only while it has no payment booked AND the sale belongs to the first
// billing cycle: within FIRST_CYCLE_DAYS of the checkout, and not at or after the
// first billing date PayPal gave (effective_until, less a day). Any other sale is
// booked as a renewal with its own row and card.
const FIRST_CYCLE_DAYS = 20;
const NEXT_CYCLE_MARGIN_S = DAY;

function saleTimeOf(resource, now = nowUnix()) {
  return unixOf(resource && (resource.create_time || resource.update_time)) || now;
}

function unpaidFirstCycleRow(db, subscriptionId) {
  if (!subscriptionId) return null;
  return db.prepare(`
    SELECT * FROM orders
    WHERE paypal_subscription_id = ? AND status = 'completed'
      AND (paypal_capture_id IS NULL OR paypal_capture_id = paypal_subscription_id)
    ORDER BY id ASC LIMIT 1
  `).get(String(subscriptionId)) || null;
}

function isFirstCycleSale(row, saleTime) {
  if (!row || !Number.isFinite(saleTime)) return false;
  if (row.paypal_capture_id && row.paypal_capture_id !== row.paypal_subscription_id) return false;
  const start = row.created_at || row.completed_at;
  if (!start || saleTime > start + FIRST_CYCLE_DAYS * DAY) return false;
  if (row.effective_until && saleTime >= row.effective_until - NEXT_CYCLE_MARGIN_S) return false;
  return true;
}

// ---- How long a booked sale gives access --------------------------------------------
// A sale's cycle runs to PayPal's next billing time. PayPal gives none when the
// lookup fails or the agreement has already ended (a sale delivered late, after a
// cancel), and a completed row with no end date counts as never expiring in the
// sync. So the sale time plus one billing interval of the plan stands in, and a
// warning is logged. Returns { effectiveUntil, nextBillingAt, estimated }:
// nextBillingAt is PayPal's own date or null, for the card's Next charge.
async function renewalCycleEnd({ paypal, testMode = false, subscriptionId, resource = null, now = nowUnix(), logger = console }) {
  let nextBillingAt = null;
  let planId = null;
  let lookupError = null;
  try {
    const sub = await paypal.getSubscription(!!testMode, subscriptionId);
    nextBillingAt = unixOf(sub && sub.billing_info && sub.billing_info.next_billing_time);
    planId = (sub && sub.plan_id) || null;
  } catch (e) {
    lookupError = (e && e.message) || String(e);
  }
  if (nextBillingAt) return { effectiveUntil: nextBillingAt, nextBillingAt, estimated: false };
  const interval = await planInterval(paypal, { testMode, planId });
  const saleTime = saleTimeOf(resource, now);
  const effectiveUntil = addBillingInterval(saleTime, interval);
  const saleId = resource && resource.id ? resource.id : 'unknown';
  logger.warn(`[paypal] sale ${saleId} on ${subscriptionId}: ${lookupError ? `subscription lookup failed (${lookupError})` : 'PayPal gave no next billing time'}; access set to the sale time plus one billing period, ${new Date(effectiveUntil * 1000).toISOString()}`);
  return { effectiveUntil, nextBillingAt: null, estimated: true };
}

// ---- Whether a failing subscription ever paid ------------------------------------------
// The billing issue code skips agreements that never took a payment (nobody to warn,
// nothing for staff to do). Local rows alone got that wrong for buyers whose paid
// order rows were lost, so PayPal's own record wins when it is there:
// billing_info.last_payment, or any cycle_executions entry with cycles_completed.
// Returns true or false from PayPal's data, or null when it says nothing either way.
function paypalEverPaid(billingInfo) {
  const bi = billingInfo && typeof billingInfo === 'object' ? billingInfo : null;
  if (!bi) return null;
  const lp = bi.last_payment;
  if (lp && (lp.time || (lp.amount && parseFloat(lp.amount.value) > 0))) return true;
  const cycles = Array.isArray(bi.cycle_executions) ? bi.cycle_executions : null;
  if (cycles && cycles.some(c => Number(c && c.cycles_completed) > 0)) return true;
  if (cycles && cycles.length) return false;
  return null;
}

// localPaid: the subscription has a completed or refunded order row.
// basis: 'orders' when local rows decided (or PayPal gave nothing), 'paypal' otherwise.
function everPaid({ localPaid = false, billingInfo = null } = {}) {
  if (localPaid) return { paid: true, basis: 'orders' };
  const pp = paypalEverPaid(billingInfo);
  if (pp === null) return { paid: false, basis: 'orders' };
  return { paid: pp, basis: 'paypal' };
}

// ---- Billing issue records ----------------------------------------------------------------
// subscription_billing_issues keeps one row per subscription whose renewal failed:
// when it was seen, how many payments had failed and what was owed. A failure ends
// the subscription at once (endUnpaidSubscription), so a row is written and resolved
// in the same step and stays as the history staff read on the Billing Issues tab.
function recordBillingIssue(db, { subscriptionId, orderId = null, steamId = null, paypalStatus = null, failedCount = 0, outstandingCents = 0, currency = 'usd', lastPaymentAt = null, nextBillingAt = null, source = 'webhook', now = nowUnix() }) {
  db.prepare(`
    INSERT INTO subscription_billing_issues
      (paypal_subscription_id, order_id, steam_id, paypal_status, failed_count, outstanding_cents, currency,
       last_payment_at, next_billing_at, first_seen_at, last_seen_at, source)
    VALUES (@sub, @orderId, @steamId, @status, @failed, @owed, @currency, @lastPaid, @nextBill, @now, @now, @source)
    ON CONFLICT(paypal_subscription_id) DO UPDATE SET
      order_id = COALESCE(excluded.order_id, order_id),
      steam_id = COALESCE(excluded.steam_id, steam_id),
      paypal_status = excluded.paypal_status, failed_count = excluded.failed_count,
      outstanding_cents = excluded.outstanding_cents, currency = excluded.currency,
      last_payment_at = excluded.last_payment_at, next_billing_at = excluded.next_billing_at,
      last_seen_at = excluded.last_seen_at, resolved_at = NULL, source = excluded.source
  `).run({
    sub: String(subscriptionId), orderId, steamId, status: paypalStatus, failed: Number(failedCount) || 0,
    owed: Number(outstandingCents) || 0, currency: String(currency || 'usd'), lastPaid: lastPaymentAt,
    nextBill: nextBillingAt, now, source: String(source || 'webhook')
  });
}

// Closes an open record. True when one was open.
function resolveBillingIssue(db, subscriptionId, now = nowUnix()) {
  if (!subscriptionId) return false;
  return db.prepare('UPDATE subscription_billing_issues SET resolved_at = ? WHERE paypal_subscription_id = ? AND resolved_at IS NULL')
    .run(now, String(subscriptionId)).changes > 0;
}

// ---- A subscription marked ended -------------------------------------------------------------
// Every order row of a subscription (one per billing cycle) carries the end, or an
// older cycle would surface as "the latest cancellable order". The earliest time and
// the first reason are kept, so a repeat, or PayPal's CANCELLED webhook after the
// shop's own cancel, never overwrites why it ended. Reasons:
//   cancelled | suspended | expired   PayPal ended it, or the player cancelled
//   unpaid                            the shop ended it: a renewal payment failed
//   no_slot                           the shop ended it: its server had no slot for a payment
function markSubscriptionEnded(db, subscriptionId, reason = 'cancelled', now = nowUnix()) {
  if (!subscriptionId) return 0;
  return db.prepare(`
    UPDATE orders SET
      subscription_cancelled_at = COALESCE(subscription_cancelled_at, @now),
      subscription_ended_reason = COALESCE(subscription_ended_reason, @reason)
    WHERE paypal_subscription_id = @sub
  `).run({ now, reason: String(reason || 'cancelled'), sub: String(subscriptionId) }).changes;
}

// 'unpaid' or 'no_slot' when the shop itself ended the subscription, else null.
function shopEndedReason(db, subscriptionId) {
  if (!subscriptionId) return null;
  const row = db.prepare(`
    SELECT subscription_ended_reason AS reason FROM orders
    WHERE paypal_subscription_id = ? AND subscription_ended_reason IN ('unpaid', 'no_slot')
    ORDER BY id DESC LIMIT 1
  `).get(String(subscriptionId));
  return row ? row.reason : null;
}

// The subscription's newest order with its user and product, which is what a card
// and an email about the subscription need. undefined when the shop has no order for it.
function subscriptionContext(db, subscriptionId) {
  if (!subscriptionId) return undefined;
  return db.prepare(`
    SELECT o.id AS order_id, o.steam_id, o.server_id, o.amount_cents, o.test_mode, o.status,
           o.payer_email, o.effective_until, o.paypal_subscription_id,
           u.persona, u.platform, u.gamertag, u.bm_player_id, u.bi_uid, u.discord_id,
           p.title AS product_title, p.currency, p.discord_role_id, p.grants_priority_queue, p.server_specific
    FROM orders o
    JOIN users u    ON o.steam_id = u.steam_id
    JOIN products p ON o.product_id = p.id
    WHERE o.paypal_subscription_id = ?
    ORDER BY o.id DESC LIMIT 1
  `).get(String(subscriptionId));
}

function subscriptionAccessUntil(db, subscriptionId) {
  const r = db.prepare("SELECT MAX(effective_until) AS u FROM orders WHERE paypal_subscription_id = ? AND status = 'completed'").get(String(subscriptionId));
  return r && r.u ? r.u : null;
}

// ---- No payment, no subscription -------------------------------------------------------------
// The owner's rule (2026-09-15): "If we haven't received funds on time they should
// not have priority queue preventing a new person from getting it." When PayPal
// cannot take a renewal (BILLING.SUBSCRIPTION.PAYMENT.FAILED, or the daily PayPal
// check finding an ACTIVE agreement with failed payments), the shop ends the
// subscription at once: no grace days, and PayPal is not left retrying, since a
// retry weeks later would charge the player, owed amount and all, for a slot that
// may have been sold since.
//
// Only priority queue works this way, because only priority queue holds a slot
// someone else could buy. Backer and Supporter give a Discord role and nothing else
// (the owner's rule), so a failed payment on one is recorded as an open billing issue
// and left to PayPal's own retries; its role goes when its paid period runs out, and
// PayPal's suspension, if it comes, is reported as before.
//
// Only an ACTIVE agreement that took a payment at some point is ended. A failure on
// an agreement PayPal already ended is history, and one that never paid has nothing
// behind it.
//
// The decision and the local end are one synchronous step, so a PayPal retry of the
// event, or the daily check meeting the same agreement, finds it ended and does
// nothing: one cancel, one card, one email per subscription. Returns { action, ... }:
//   ignored        no subscription id
//   not_active     PayPal's agreement is not ACTIVE (any open record resolved)
//   no_orders      the shop holds no order for it (any open record resolved)
//   never_paid     it never took a payment (any open record resolved)
//   already_ended  the shop already marks it ended
//   not_priority_queue  not a priority queue product: recorded as an open issue only
//   ended          recorded, marked ended 'unpaid' and resolved just now
function claimUnpaidEnd(db, { subscriptionId, billingInfo = null, paypalStatus = 'ACTIVE', source = 'webhook', now = nowUnix() } = {}) {
  const out = { action: null, subscriptionId: subscriptionId ? String(subscriptionId) : null, ctx: null, failedCount: 0, outstandingCents: 0, currency: 'usd' };
  if (!out.subscriptionId) { out.action = 'ignored'; return out; }
  const sub = out.subscriptionId;
  const bi = billingInfo && typeof billingInfo === 'object' ? billingInfo : {};
  const owed = moneyOf(bi.outstanding_balance);
  out.failedCount = Number(bi.failed_payments_count) || 0;
  out.outstandingCents = owed ? owed.cents : 0;
  db.transaction(() => {
    const status = String(paypalStatus || 'ACTIVE').toUpperCase();
    if (status !== 'ACTIVE') { resolveBillingIssue(db, sub, now); out.action = 'not_active'; return; }
    const ctx = subscriptionContext(db, sub);
    if (!ctx) { resolveBillingIssue(db, sub, now); out.action = 'no_orders'; return; }
    out.ctx = ctx;
    out.currency = (owed && owed.currency) || ctx.currency || 'usd';
    const localPaid = !!db.prepare("SELECT 1 FROM orders WHERE paypal_subscription_id = ? AND status IN ('completed', 'refunded') LIMIT 1").get(sub);
    if (!everPaid({ localPaid, billingInfo: bi }).paid) { resolveBillingIssue(db, sub, now); out.action = 'never_paid'; return; }
    if (db.prepare('SELECT 1 FROM orders WHERE paypal_subscription_id = ? AND subscription_cancelled_at IS NOT NULL LIMIT 1').get(sub)) {
      resolveBillingIssue(db, sub, now);
      out.action = 'already_ended';
      return;
    }
    recordBillingIssue(db, {
      subscriptionId: sub, orderId: ctx.order_id, steamId: ctx.steam_id, paypalStatus: status,
      failedCount: out.failedCount, outstandingCents: out.outstandingCents, currency: out.currency,
      lastPaymentAt: unixOf(bi.last_payment && bi.last_payment.time), nextBillingAt: unixOf(bi.next_billing_time), source, now
    });
    if (!ctx.grants_priority_queue) { out.action = 'not_priority_queue'; return; }
    markSubscriptionEnded(db, sub, 'unpaid', now);
    resolveBillingIssue(db, sub, now);
    out.action = 'ended';
  })();
  return out;
}

const UNPAID_CANCEL_REASON = 'Renewal payment not received';

// claimUnpaidEnd plus what follows an end: the cancel at PayPal (marked 'unpaid', so
// its CANCELLED webhook stays quiet), the game servers and the Discord role, one card
// and one email. effects (all optional except paypal):
//   paypal                  cancelSubscription
//   sync()                  re-sync the game servers
//   removeLapsedRole(id)    remove the order's role unless something still gives it
//   sendCard(specFn)        post a card
//   sendEmail({ to, ctx, accessUntil })   the player's "your subscription has ended" email
//   logger
async function endUnpaidSubscription(db, input = {}, effects = {}) {
  const log = effects.logger || console;
  const now = Number.isFinite(input.now) ? input.now : nowUnix();
  const source = input.source || 'webhook';
  const plan = claimUnpaidEnd(db, { ...input, source, now });
  const sub = plan.subscriptionId;
  if (plan.action !== 'ended') {
    if (plan.action === 'not_priority_queue') {
      log.log(`[billing] payment failure on ${sub} (${source}): not priority queue, recorded and left to PayPal's retries`);
    } else if (plan.action !== 'ignored' && plan.action !== 'already_ended') {
      log.log(`[billing] payment failure on ${sub} (${source}): ${plan.action.replace(/_/g, ' ')}, nothing to end`);
    }
    return plan;
  }
  const ctx = plan.ctx;
  plan.cancel = await cancelAtPayPal({ db, paypal: effects.paypal, testMode: !!ctx.test_mode, subscriptionId: sub, reason: UNPAID_CANCEL_REASON, source: 'unpaid', now });
  plan.accessUntil = subscriptionAccessUntil(db, sub);
  const bad = plan.cancel.outcome === 'failed' || plan.cancel.outcome === 'unknown';
  log[bad ? 'error' : 'log'](`[billing] ${sub} ended for non-payment (order #${ctx.order_id}, ${source}); cancel at PayPal: ${plan.cancel.outcome}${plan.cancel.error ? ` (${plan.cancel.error})` : ''}`);
  attempt(log, 'sync', () => effects.sync && effects.sync());
  attempt(log, 'role removal', () => effects.removeLapsedRole && effects.removeLapsedRole(ctx.order_id));
  if (effects.sendCard) {
    effects.sendCard(() => cards.unpaidEndedCard({
      ctx, subscriptionId: sub, cancel: plan.cancel, failedCount: plan.failedCount, outstandingCents: plan.outstandingCents,
      currency: plan.currency, accessUntil: plan.accessUntil, source, now
    }));
  }
  let emailed = false;
  if (effects.sendEmail && ctx.payer_email) {
    emailed = attempt(log, 'player email', () => { effects.sendEmail({ to: ctx.payer_email, ctx, accessUntil: plan.accessUntil, billingStopped: billingStopped(plan.cancel) }); return true; }) === true;
  }
  attempt(log, 'recording the notices', () => db.prepare('UPDATE subscription_billing_issues SET notified_at = ?, player_emailed_at = COALESCE(?, player_emailed_at) WHERE paypal_subscription_id = ?')
    .run(now, emailed ? now : null, sub));
  plan.emailed = emailed;
  return plan;
}

// ---- A slot for a priority queue payment -------------------------------------------------------
// A priority queue payment is honoured only when it takes no slot from anyone: the
// player still holds priority queue on the order's server (a renewal inside its
// window, pqEntitlement.RENEWAL_WINDOW_S), or the server has a free slot. Sandbox
// orders and other products never hold a slot, so they always pass.
//
// row: an order with its product's grants_priority_queue and server_specific. "Still
// holds priority queue" is asked of the order's ACCOUNT, as checkout asks it: anyone
// can set their in-game ID to a holder's, pass as a renewal, and change it back. The
// buyer's own checkouts waiting at PayPal are left out of the reservations, since they
// are this payment; before ({ createdAt, id }) counts only checkouts started earlier
// than it (pqEntitlement.pqSlotsPerServer). Returns null when every server the order
// covers is fine, else { serverId, slot } for the first full one.
function missingSlot(db, { row, now = nowUnix(), before = null }) {
  if (!row || !row.grants_priority_queue || row.test_mode) return null;
  for (const serverId of pqEntitlement.coveredServers(row)) {
    if (pqEntitlement.accountHoldsPq(db, { steamId: row.steam_id, serverId, now })) continue;
    const slot = pqEntitlement.pqSlotFree(db, { serverId, now, productId: row.product_id, excludeSteamId: row.steam_id, excludeOrderId: row.id, reservedBefore: before });
    if (!slot.free) return { serverId, slot: { limit: slot.limit, used: slot.used, reserved: slot.reserved } };
  }
  return null;
}

const ORDER_FOR_SLOT_SQL = `
  SELECT o.*, p.grants_priority_queue, p.server_specific, u.bi_uid
  FROM orders o JOIN products p ON p.id = o.product_id LEFT JOIN users u ON u.steam_id = o.steam_id`;

// ---- A subscription activating on a full server ---------------------------------------------
// Two buyers can approve the last slot at PayPal within the same minutes. Checkout
// holds a slot for each waiting checkout (pqEntitlement.CHECKOUT_RESERVATION_S), and
// activation checks again: a priority queue subscription that activates when its
// server has no slot for it is not fulfilled. It is marked ended 'no_slot' and its
// checkout row cancelled right here, in the same synchronous step the caller then
// fulfils in, so nothing can take the slot between the check and the fulfilment.
// The caller cancels it at PayPal and reports it (reportRefusedActivation); the first
// payment, when PayPal sends it, is refunded (refuseSale).
//
// Returns { refuse: false, reason } to go ahead (no_order, already_done, ok), or
// { refuse: true, claimed, reason, order, serverId, slot }. claimed is true only for
// the call that refused it: a retry, or the return page and the webhook both
// arriving, finds it already ended and reports nothing again.
function claimActivation(db, { orderId, now = nowUnix() } = {}) {
  return db.transaction(() => {
    const order = db.prepare(`${ORDER_FOR_SLOT_SQL} WHERE o.id = ?`).get(Number(orderId));
    if (!order) return { refuse: false, reason: 'no_order' };
    if (order.status === 'completed' || order.status === 'refunded') return { refuse: false, reason: 'already_done' };
    if (!order.paypal_subscription_id) return { refuse: false, reason: 'ok' };
    const ended = shopEndedReason(db, order.paypal_subscription_id);
    if (ended) return { refuse: true, claimed: false, reason: `ended_${ended}`, order };
    // Only checkouts started before this one count against it: of two buyers racing
    // for the last slot the earlier gets it, whichever approves first.
    const missing = missingSlot(db, { row: order, now, before: { createdAt: order.created_at, id: order.id } });
    if (!missing) return { refuse: false, reason: 'ok' };
    markSubscriptionEnded(db, order.paypal_subscription_id, 'no_slot', now);
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE paypal_subscription_id = ? AND status = 'pending'").run(order.paypal_subscription_id);
    return { refuse: true, claimed: true, reason: 'no_slot', order, serverId: missing.serverId, slot: missing.slot };
  })();
}

const NO_SLOT_CANCEL_REASON = 'No priority queue slot free on the server';

// After claimActivation refused and claimed an activation: the cancel at PayPal
// (marked 'no_slot', so its CANCELLED webhook stays quiet), one card, one email. Never
// throws for anything PayPal does. effects: paypal, getOrderWithContext(id),
// sendCard(specFn), sendEmail({ to, ctx, reason }), logger.
async function reportRefusedActivation(db, { verdict, payerEmail = null, now = nowUnix() } = {}, effects = {}) {
  const log = effects.logger || console;
  const o = verdict.order;
  const sub = o.paypal_subscription_id;
  const cancel = await cancelAtPayPal({ db, paypal: effects.paypal, testMode: !!o.test_mode, subscriptionId: sub, reason: NO_SLOT_CANCEL_REASON, source: 'no_slot', now });
  const bad = cancel.outcome === 'failed' || cancel.outcome === 'unknown';
  log[bad ? 'error' : 'log'](`[pq-slot] order #${o.id}: no free slot on ${verdict.serverId} when subscription ${sub} activated, so it was not started; cancel at PayPal: ${cancel.outcome}`);
  const ctx = (effects.getOrderWithContext && attempt(log, 'order lookup', () => effects.getOrderWithContext(o.id))) || o;
  if (effects.sendCard) effects.sendCard(() => cards.refusedActivationCard({ order: ctx, serverId: verdict.serverId, slot: verdict.slot, cancel }));
  const to = payerEmail || ctx.payer_email || null;
  let emailed = false;
  if (effects.sendEmail && to) emailed = attempt(log, 'player email', () => { effects.sendEmail({ to, ctx, reason: 'activation', billingStopped: billingStopped(cancel) }); return true; }) === true;
  return { cancel, emailed };
}

// ---- A payment the shop cannot honour -------------------------------------------------------
// PAYMENT.SALE.COMPLETED books a cycle only while the subscription is still the
// shop's to bill and its payment takes no priority queue slot from anyone
// (missingSlot): a renewal inside its window, or a server with a free slot.
// Otherwise the payment is refunded and the subscription cancelled (refuseSale), so
// nobody pays for priority queue they cannot have:
//   no_slot        paid after the paid period and window ended, and the server is
//                  full now; or a first payment that landed after the server filled
//   ended_unpaid   paid on a subscription the shop ended for non-payment
//   ended_no_slot  paid on a subscription the shop ended for want of a slot
//   revoked        paid on a subscription whose every order the shop had taken back
//                  and that the shop had ended (subscriptionStoppedByShop)
// The first cycle's own payment is booked when its order was activated, because
// activation already held the slot for it (claimActivation). A first payment that
// arrives before activation counts only checkouts started before its own.
//
// Returns { book: true, reason }, { book: false, reason, firstPayment?, serverId?,
// slot? }, or { book: null, reason: 'no_order' } when no order stands for the
// subscription and the shop never ended it (reported to staff, not refunded).
function saleBookingDecision(db, { subscriptionId, resource = null, now = nowUnix() } = {}) {
  const sub = String(subscriptionId || '');
  const ended = shopEndedReason(db, sub);
  if (ended) return { book: false, reason: `ended_${ended}` };
  const row = db.prepare(`${ORDER_FOR_SLOT_SQL} WHERE o.paypal_subscription_id = ? AND o.status IN ('completed', 'pending') ORDER BY o.id ASC LIMIT 1`).get(sub);
  if (!row) return subscriptionStoppedByShop(db, sub) ? { book: false, reason: 'revoked' } : { book: null, reason: 'no_order' };
  const first = unpaidFirstCycleRow(db, sub);
  if (first && isFirstCycleSale(first, saleTimeOf(resource, now))) return { book: true, reason: 'first_cycle' };
  const completed = !!db.prepare("SELECT 1 FROM orders WHERE paypal_subscription_id = ? AND status = 'completed' LIMIT 1").get(sub);
  const missing = missingSlot(db, { row, now, before: completed ? null : { createdAt: row.created_at, id: row.id } });
  if (missing) {
    return { book: false, reason: 'no_slot', firstPayment: !completed, serverId: missing.serverId, slot: missing.slot };
  }
  return { book: true, reason: row.grants_priority_queue && !row.test_mode ? 'slot' : 'no_slot_needed' };
}

// Whether a subscription with no completed or pending order is one the shop itself
// stopped: every order was revoked, refunded or cancelled, and the shop marked the
// subscription ended (a staff revoke, PayPal's cancel notice) or lost a dispute on it.
// A payment on such a subscription gives nothing, so it is refunded. An agreement the
// shop never ended stays a staff decision (card only): staff may have left it billing
// on purpose, and nothing in the shop's records says otherwise.
function subscriptionStoppedByShop(db, subscriptionId) {
  if (!subscriptionId) return false;
  const rows = db.prepare('SELECT id, status, subscription_cancelled_at FROM orders WHERE paypal_subscription_id = ?').all(String(subscriptionId));
  if (!rows.length || rows.some(r => r.status === 'completed' || r.status === 'pending')) return false;
  if (rows.some(r => r.subscription_cancelled_at != null)) return true;
  const ids = rows.map(r => r.id);
  return !!db.prepare(`
    SELECT 1 FROM paypal_disputes
    WHERE order_id IN (${ids.map(() => '?').join(',')}) AND status = 'RESOLVED'
      AND outcome IN ('RESOLVED_BUYER_FAVOUR', 'ACCEPTED')
    LIMIT 1
  `).get(...ids);
}

const REFUSED_CANCEL_REASONS = Object.freeze({
  no_slot: 'Payment refunded: no priority queue slot free',
  ended_unpaid: 'Payment refunded: the subscription had ended for non-payment',
  ended_no_slot: 'Payment refunded: no priority queue slot free',
  revoked: 'Payment refunded: the subscription had ended'
});
// How refuseSale marks the subscription and names its cancel, per refusal reason. A
// revoked subscription keeps the reason it already has ('cancelled' only fills a gap).
const REFUSED_END_REASON = Object.freeze({ ended_unpaid: 'unpaid', revoked: 'cancelled' });
const REFUSED_CANCEL_SOURCE = Object.freeze({ ended_unpaid: 'unpaid', revoked: 'revoked' });

// Refunds one sale saleBookingDecision refused, and cancels its subscription. The
// claim comes first and is synchronous: a row in paypal_refunds for the sale (source
// 'shop'), the subscription marked ended, any checkout row of it cancelled. A retry
// of the sale event finds that row and does nothing. Then PayPal is asked:
//   refunded  the row takes the refund's own id, so the refund webhook is a duplicate
//   failed    PayPal refused, so the row goes: the daily PayPal check then lists the
//             payment as unbooked until staff refund it by hand
//   unknown   no answer: the row stays, so a second refund is never tried
// One card for staff. The player gets one email, and only when the money went back:
// a subscription already ended for want of a slot was explained when it ended.
// effects: paypal (refundCapture, cancelSubscription), sendCard(specFn),
// sendEmail({ to, ctx, reason, amountCents, currency }), logger.
async function refuseSale(db, { subscriptionId, resource = {}, decision = {}, testMode = false, now = nowUnix() } = {}, effects = {}) {
  const log = effects.logger || console;
  const r = resource || {};
  const sub = String(subscriptionId);
  const amount = moneyOf(r.amount);
  const plan = {
    action: null, reason: decision.reason || 'no_slot', subscriptionId: sub, saleId: r.id ? String(r.id) : null,
    amountCents: amount ? amount.cents : null, currency: amount ? amount.currency : 'USD', refund: null, cancel: null, ctx: null, emailed: false
  };
  if (!plan.saleId) {
    plan.action = 'ignored';
    log.error(`[billing] a payment the shop cannot honour on ${sub} carries no sale id, so nothing was refunded: check it in PayPal`);
    return plan;
  }
  const claimId = `shop:${plan.saleId}`;
  const ctxBefore = subscriptionContext(db, sub) || null;
  const sandbox = ctxBefore ? !!ctxBefore.test_mode : !!testMode;
  const claimed = db.transaction(() => {
    if (shopRefundOfPayment(db, plan.saleId)) return false;
    recordRefund(db, { refundId: claimId, orderId: null, paymentId: plan.saleId, amountCents: plan.amountCents, currency: plan.currency, kind: 'refund', source: 'shop', testMode: sandbox, now });
    markSubscriptionEnded(db, sub, REFUSED_END_REASON[plan.reason] || 'no_slot', now);
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE paypal_subscription_id = ? AND status = 'pending'").run(sub);
    resolveBillingIssue(db, sub, now);
    return true;
  })();
  if (!claimed) {
    plan.action = 'duplicate';
    log.log(`[billing] sale ${plan.saleId} on ${sub} was already refused and refunded; nothing to do`);
    return plan;
  }
  plan.action = 'refused';
  plan.ctx = subscriptionContext(db, sub) || null;
  plan.refund = await refundPayment({ paypal: effects.paypal, testMode: sandbox, paymentId: plan.saleId, amountCents: plan.amountCents, currency: plan.currency });
  attempt(log, `sale ${plan.saleId}: recording the refund`, () => {
    if (plan.refund.outcome === 'refunded' && plan.refund.refundId && !db.prepare('SELECT 1 FROM paypal_refunds WHERE refund_id = ?').get(plan.refund.refundId)) {
      db.prepare('UPDATE paypal_refunds SET refund_id = ?, amount_cents = COALESCE(?, amount_cents) WHERE refund_id = ?')
        .run(plan.refund.refundId, Number.isFinite(plan.refund.refundedCents) ? plan.refund.refundedCents : null, claimId);
    } else if (plan.refund.outcome === 'failed') {
      db.prepare('DELETE FROM paypal_refunds WHERE refund_id = ?').run(claimId);
    }
  });
  plan.cancel = await cancelAtPayPal({
    db, paypal: effects.paypal, testMode: sandbox, subscriptionId: sub,
    reason: REFUSED_CANCEL_REASONS[plan.reason] || REFUSED_CANCEL_REASONS.no_slot,
    source: REFUSED_CANCEL_SOURCE[plan.reason] || 'no_slot', now
  });
  const money = Number.isFinite(plan.amountCents) ? `${(plan.amountCents / 100).toFixed(2)} ${plan.currency}` : 'amount not given';
  const bad = plan.refund.outcome !== 'refunded' || plan.cancel.outcome === 'failed' || plan.cancel.outcome === 'unknown';
  log[bad ? 'error' : 'log'](`[billing] sale ${plan.saleId} (${money}${sandbox ? ', sandbox' : ''}) on ${sub} cannot be honoured (${plan.reason}); refund: ${plan.refund.outcome}${plan.refund.error ? ` (${plan.refund.error})` : ''}; cancel at PayPal: ${plan.cancel.outcome}`);
  if (effects.sendCard) {
    effects.sendCard(() => cards.refusedPaymentCard({
      ctx: plan.ctx, subscriptionId: sub, saleId: plan.saleId, amountCents: plan.amountCents, currency: plan.currency,
      reason: plan.reason, firstPayment: !!decision.firstPayment, serverId: decision.serverId || null, slot: decision.slot || null,
      refund: plan.refund, cancel: plan.cancel, testMode: sandbox
    }));
  }
  const to = plan.ctx ? plan.ctx.payer_email : null;
  if (effects.sendEmail && to && plan.refund.outcome === 'refunded' && plan.reason !== 'ended_no_slot') {
    const reason = plan.reason === 'no_slot' && decision.firstPayment ? 'first_payment' : plan.reason;
    plan.emailed = attempt(log, 'player email', () => {
      effects.sendEmail({ to, ctx: plan.ctx, reason, amountCents: plan.amountCents, currency: plan.currency, billingStopped: billingStopped(plan.cancel) });
      return true;
    }) === true;
  }
  return plan;
}

// ---- A dispute the shop lost -----------------------------------------------------------------
// The money went back to the buyer, so the order stops giving its perks, the same as
// a refund: status 'refunded' (every entitlement reader takes that as no perks). No
// staff member made the change, so admin_audit records it with actor 'paypal' and
// reason 'dispute_lost'. An order that is no longer completed (already refunded or
// revoked) is left as it is. The subscription is not cancelled here: a dispute is
// about one payment, and the card tells staff to cancel it if PayPal bills it again.
function revokeForLostDispute(db, { order, disputeId = null, now = nowUnix() }) {
  if (!order) return { revoked: false, reason: 'no_order', status: null };
  return db.transaction(() => {
    const upd = db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ? AND status = 'completed'").run(order.id);
    if (!upd.changes) {
      const current = db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id);
      return { revoked: false, reason: 'not_completed', status: current ? current.status : null };
    }
    require('./adminAudit').recordAdminAudit(db, {
      actor: 'paypal', action: 'order.revoke', target: order.steam_id,
      before: { order_id: order.id, status: 'completed' },
      after: { order_id: order.id, status: 'refunded', dispute_id: disputeId },
      reason: 'dispute_lost', now
    });
    return { revoked: true, reason: 'dispute_lost', status: 'refunded' };
  })();
}

// The subscriptions a billing rescan asks PayPal about: every one the shop believes
// is live, plus every one with a billing issue on record that is not marked ended,
// so an issue closed on local rows alone can be looked at again with PayPal's data.
function billingRescanTargets(db) {
  return db.prepare(`
    SELECT o.paypal_subscription_id AS sub_id, MAX(o.test_mode) AS test_mode
    FROM orders o
    WHERE o.paypal_subscription_id IS NOT NULL
    GROUP BY o.paypal_subscription_id
    HAVING SUM(o.status = 'completed' AND o.subscription_cancelled_at IS NULL) > 0
        OR (SUM(o.subscription_cancelled_at IS NOT NULL) = 0
            AND o.paypal_subscription_id IN (SELECT paypal_subscription_id FROM subscription_billing_issues))
    ORDER BY o.paypal_subscription_id
  `).all();
}

// Subscriptions the shop ended for non-payment or for want of a slot in the last
// SHOP_END_RECHECK_S, which the daily PayPal check looks up again: when the cancel at
// PayPal did not go through at the time, the agreement is still ACTIVE and can bill,
// and the check cancels it then (tools/reconcile.js recheckShopEndedCancels). Past
// that window any payment PayPal still takes is refunded when it arrives (refuseSale),
// which cancels once more. reason is 'unpaid' or 'no_slot'.
const SHOP_END_RECHECK_S = 45 * DAY;
function shopEndedRecheckTargets(db, now = nowUnix()) {
  return db.prepare(`
    SELECT paypal_subscription_id AS sub_id, MAX(test_mode) AS test_mode, MAX(subscription_ended_reason) AS reason
    FROM orders
    WHERE paypal_subscription_id IS NOT NULL
      AND subscription_ended_reason IN ('unpaid', 'no_slot')
      AND subscription_cancelled_at > ?
    GROUP BY paypal_subscription_id
    ORDER BY paypal_subscription_id
  `).all(now - SHOP_END_RECHECK_S);
}

module.exports = {
  // payloads
  moneyOf, unixOf, paymentIdFromHref, paymentIdsOf, disputeOf,
  // orders
  findOrderForPayment,
  // refunds
  recordRefund, refundedSoFar, isWholeRefund, staffRefundCovers, applyRefundEvent, handleRefundEvent, STAFF_REFUND_WINDOW_S,
  applyRefundFailure, handleRefundFailure, refundErrorOutcome, shopRefundOfPayment, refundPayment,
  // disputes
  disputeMoneyResult, applyDisputeEvent, handleDisputeEvent, revokeForLostDispute,
  // unmatched payments
  recordUnmatchedSale,
  // shop cancels
  SHOP_CANCEL_SOURCES, SHOP_CANCEL_WINDOW_S, markShopCancel, clearShopCancel, restoreShopCancel, shopCancelFor,
  cancelErrorOutcome, cancelAtPayPal, billingStopped, endedNotices,
  // access floor
  MONTHLY, UNBOOKED_PAYMENT_GAP_S, addBillingInterval, intervalOfPlan, planInterval, paidThroughOf, applyPaidThroughFloor,
  // first cycle and cycle end
  FIRST_CYCLE_DAYS, saleTimeOf, unpaidFirstCycleRow, isFirstCycleSale, renewalCycleEnd,
  // billing failures and how a subscription ends
  paypalEverPaid, everPaid, billingRescanTargets, recordBillingIssue, resolveBillingIssue,
  markSubscriptionEnded, shopEndedReason, subscriptionContext, claimUnpaidEnd, endUnpaidSubscription,
  SHOP_END_RECHECK_S, shopEndedRecheckTargets, UNPAID_CANCEL_REASON, NO_SLOT_CANCEL_REASON,
  // a slot for a priority queue payment
  missingSlot, claimActivation, reportRefusedActivation, saleBookingDecision, subscriptionStoppedByShop, refuseSale
};

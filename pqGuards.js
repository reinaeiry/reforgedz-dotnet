// Money guards around priority queue purchases and subscription renewals.
//
// Every function takes the database handle as a parameter and nothing runs on
// require. routes/shop.js starts timers and writes to the database the moment it
// is loaded, so logic kept there cannot be tested; kept here, the tests run it
// against a throwaway copy of the real schema (test/pqGuards.test.js).
//
// Who holds priority queue is not decided here: pqEntitlement.js has the one rule.

const { livePqOrderSql } = require('./pqEntitlement');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// "12 October" (UTC). Built by hand rather than with toLocaleDateString so the
// text never depends on which ICU data the Node build carries.
function dayMonth(unix) {
  const d = new Date(Number(unix) * 1000);
  if (!Number.isFinite(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const lowerId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

// ---- A second subscription on the same account (plan J1) -------------------
// One account can open two auto-renewing priority queue subscriptions for the
// same server and pay twice for one slot. Neither older check catches it:
// hasLivePendingOrder only sees checkouts under 5 minutes old, and the sold-out
// check deliberately lets the buyer's own live order through as a renewal.
//
// The buyer's own completed priority queue order that belongs to a PayPal
// subscription still billing, covering this server, in the same mode (sandbox or
// live). A subscription that was cancelled or ended but is still paid up does NOT
// count: buying again is how a player turns auto-renew back on ("Start again").
//
// A NULL effective_until counts only for ACTIVATION_GAP_S after the order
// completed: that is the moment between activation and the first billing date
// being stored. An older row with no date is a lookup that never came back. The
// account page calls that subscription lapsed and offers "Start again", so a
// refusal here would send the player round in a circle.
//
// serverId null (a product not tied to a server) only matches a subscription
// that is not tied to a server either. excludeSubscriptionId leaves one
// subscription out, for the check made when a new one activates.
const ACTIVATION_GAP_S = 2 * 86400;

function ownLiveSubscription(db, { steamId, serverId, testMode, now, excludeSubscriptionId = null }) {
  if (!steamId) return null;
  const exclude = excludeSubscriptionId == null ? null : String(excludeSubscriptionId);
  return db.prepare(`
    SELECT o.id, o.server_id, o.effective_until, o.paypal_subscription_id, p.server_specific
    FROM orders o JOIN products p ON p.id = o.product_id
    WHERE o.steam_id = ?
      AND o.status = 'completed'
      AND p.grants_priority_queue = 1
      AND o.paypal_subscription_id IS NOT NULL
      AND (? IS NULL OR o.paypal_subscription_id != ?)
      AND o.subscription_cancelled_at IS NULL
      AND o.subscription_ended_reason IS NULL
      AND (o.effective_until > ?
           OR (o.effective_until IS NULL AND COALESCE(o.completed_at, o.created_at) > ?))
      AND o.test_mode = ?
      AND (COALESCE(p.server_specific, 0) = 0 OR o.server_id = ?)
    ORDER BY o.effective_until IS NULL, o.effective_until DESC, o.id DESC
    LIMIT 1
  `).get(steamId, exclude, exclude, now, now - ACTIVATION_GAP_S, testMode ? 1 : 0,
    serverId == null ? null : serverId) || null;
}

// The 409 body for ownLiveSubscription. renewsAt is unix seconds, or null when
// the first billing date has not been stored yet. A staff move changes the order's
// server, so the server named here is always where the subscription applies.
function alreadySubscribedRefusal(row, serverLabel) {
  const where = serverLabel ? ` on ${serverLabel}` : '';
  const dated = row && row.effective_until != null ? row.effective_until : null;
  const when = dated != null ? `renews on ${dayMonth(dated)}` : 'renews automatically';
  return {
    code: 'already_subscribed',
    error: `You already have priority queue${where} that ${when}. Manage it on your account page.`,
    renewsAt: dated
  };
}

// ---- The same in-game ID on another account (plan J1) ----------------------
// users.bi_uid is neither unique nor proven. A player with a Steam and a console
// account can carry one ID on both, and the ID is typed by the player. So this
// never blocks a purchase on its own, it only asks the buyer to confirm, and the
// text names no server, date or account.
//
// True when a DIFFERENT account with this in-game ID holds priority queue on ANY
// server, by the one rule (pqEntitlement.js: a paid, live-mode order whose paid
// period has not ended). Deliberately not narrowed to the server being bought: the
// buyer picks that server, so a per-server answer would tell anyone which server
// another player's priority queue is on, one checkout per server.
function otherAccountLivePq(db, { steamId, biUid, now = Math.floor(Date.now() / 1000) }) {
  const guid = lowerId(biUid);
  if (!guid) return false;
  return !!db.prepare(`
    SELECT 1
    FROM orders o
    JOIN users u    ON u.steam_id = o.steam_id
    JOIN products p ON p.id = o.product_id
    WHERE lower(u.bi_uid) = @guid
      AND u.steam_id != @steamId
      AND ${livePqOrderSql('o', 'p')}
    LIMIT 1
  `).get({ guid, steamId: String(steamId || ''), now });
}

function sharedIdRefusal() {
  return {
    code: 'id_has_priority_elsewhere',
    needsConfirm: true,
    error: 'This in-game ID already has priority queue on another ReforgedZ account. If this in-game ID is not yours, change it on your account page before buying. If that other account is yours, sign in to it instead (use "Forgot password" with the email you paid with), or open a Shop Support ticket.'
  };
}

// ---- A second subscription that got past the checkout check (plan J1) -------
// Two PayPal approvals made close together both pass the checkout check, since
// neither is completed yet, and an older approval link stays usable after a
// newer checkout opens. So when a subscription activates, look again. Staff are
// told; nothing is refused or cancelled, because the payment has already been
// taken. Returns the other live subscription's order row, or null.
function duplicateLiveSubscription(db, { orderId, now }) {
  const o = db.prepare(`
    SELECT o.steam_id, o.server_id, o.test_mode, o.paypal_subscription_id,
           p.grants_priority_queue, p.server_specific
    FROM orders o JOIN products p ON p.id = o.product_id
    WHERE o.id = ?
  `).get(orderId);
  if (!o || !o.grants_priority_queue || !o.paypal_subscription_id) return null;
  return ownLiveSubscription(db, {
    steamId: o.steam_id,
    serverId: o.server_specific ? o.server_id : null,
    testMode: !!o.test_mode,
    now,
    excludeSubscriptionId: o.paypal_subscription_id
  });
}

// ---- A renewal on a revoked subscription (plan J2) --------------------------
// Revoke marks an order 'refunded' and then asks PayPal to cancel, and that
// cancel can fail, so PayPal can go on billing. The renewal webhook looked for a
// completed or pending order, found none when every order was refunded, wrote
// nothing and answered 200, so PayPal never retried and nobody knew the money
// had arrived. Nothing is granted: staff decide whether the player should have
// been charged.
//
// Returns null when this is not that case (the subscription has no orders here,
// or one of them is still completed or pending), false when this sale was
// already recorded (PayPal retrying the same event), or { orders } when it was
// recorded just now and staff need telling.
function recordRevokedRenewal(db, { saleId, subscriptionId, amountCents = null, now = Math.floor(Date.now() / 1000) }) {
  if (!saleId || !subscriptionId) return null;
  const orders = db.prepare(`
    SELECT id, status, steam_id, test_mode, revoked_without_refund_at FROM orders
    WHERE paypal_subscription_id = ? ORDER BY id ASC
  `).all(String(subscriptionId));
  if (!orders.length || orders.some(o => o.status === 'completed' || o.status === 'pending')) return null;
  const ins = db.prepare(`
    INSERT OR IGNORE INTO revoked_renewals (sale_id, subscription_id, amount_cents, received_at)
    VALUES (?, ?, ?, ?)
  `).run(String(saleId), String(subscriptionId), Number.isFinite(amountCents) ? amountCents : null, now);
  return ins.changes ? { orders } : false;
}

// The same thing when an older cycle is still completed: revoke refunds only the
// cycle staff picked, so the renewal webhook still finds a completed row and
// books the new cycle. Its newest paid or refunded cycle being 'refunded' is the
// sign. That is also what a single cycle refunded from PayPal's side looks like
// on a subscription meant to carry on, and the shop cannot tell the two apart,
// so the renewal is still booked (a player never pays for nothing on a guess)
// and staff are told. Call it BEFORE the new cycle's row is inserted, which would
// otherwise be the newest. Returns { id, noRefund } of that revoked cycle, or null.
// noRefund: staff revoked it without returning money (the status is 'refunded'
// either way, so entitlement readers see no perks), which the cards must not call
// a refund.
function refundedLatestCycle(db, subscriptionId) {
  if (!subscriptionId) return null;
  const row = db.prepare(`
    SELECT id, status, revoked_without_refund_at FROM orders
    WHERE paypal_subscription_id = ? AND status IN ('completed', 'refunded')
    ORDER BY id DESC LIMIT 1
  `).get(String(subscriptionId));
  return row && row.status === 'refunded' ? { id: row.id, noRefund: row.revoked_without_refund_at != null } : null;
}

module.exports = {
  ownLiveSubscription, alreadySubscribedRefusal, otherAccountLivePq, sharedIdRefusal,
  duplicateLiveSubscription, recordRevokedRenewal, refundedLatestCycle,
  dayMonth, ACTIVATION_GAP_S
};

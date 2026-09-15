// The staff cards the shop posts about orders, subscriptions and billing, as
// specs for tools/lib/discordCard.js (buildCard / sendCard). Each builder takes
// the rows the call site already holds and returns a spec, so the wording can be
// tested without the database or Discord. routes/shop.js posts them.
//
// Staff identify a player by name, account and the order link. No builder reads
// payer_email or a payer name, and in-game IDs are shortened: the full details
// stay on the admin page, behind staff sign-in.
//
// No work on require.

const { shortId, money, discordDate, serverLabel } = require('./tools/lib/discordCard');
const { DEFAULT_PERSONA } = require('./webAuth');

const PLATFORM_LABELS = { steam: 'Steam', xbox: 'Xbox', psn: 'PlayStation', web: 'Website' };

// The name to call a player by, or null. A website account is "Player" until its
// in-game ID is found, which is no name at all.
function playerName(row) {
  if (!row) return null;
  const persona = row.persona && row.persona !== DEFAULT_PERSONA ? row.persona : null;
  if (row.platform === 'xbox' || row.platform === 'psn') return row.gamertag || persona || null;
  return persona || row.gamertag || null;
}

// getOrderWithContext rows carry id; getBillingIssueContext rows carry order_id.
function orderIdOf(row) {
  if (!row) return null;
  return row.id != null ? row.id : (row.order_id != null ? row.order_id : null);
}

const code = (s) => '`' + String(s) + '`';

// The server a card's title names: the order's own. A staff move changes the
// order's server on every row of its subscription, so the order always names the
// server its priority queue is on.
function cardServer(row) {
  return row ? row.server_id : null;
}

// Who the order belongs to: the same four fields on every order card.
function playerFields(row) {
  const r = row || {};
  const platform = r.platform || 'steam';
  let account = r.steam_id || 'Unknown';
  if ((platform === 'xbox' || platform === 'psn') && r.bm_player_id && !String(account).includes(String(r.bm_player_id))) {
    account = `${account} (BattleMetrics ${r.bm_player_id})`;
  }
  return [
    { name: 'Player', value: playerName(r) || (platform === 'web' ? 'In-game name not known yet' : 'Unknown'), inline: true },
    { name: 'Account', value: account, inline: true },
    { name: 'Platform', value: PLATFORM_LABELS[platform] || platform, inline: true },
    { name: 'In-game ID', value: r.bi_uid ? shortId(r.bi_uid) : 'Not set yet', inline: true }
  ];
}

// One entry per thing that can happen to an order. kind picks the colour and
// whether staff are notified (see discordCard.js); status is the state the order
// is in afterwards, in words.
const ORDER_EVENTS = Object.freeze({
  payment_completed: { what: 'Payment completed', kind: 'money_in', status: 'Completed' },
  subscription_started: { what: 'Subscription started', kind: 'money_in', status: 'Completed' },
  payment_declined: { what: 'Payment declined', kind: 'attention', status: 'Failed' },
  subscription_renewed: { what: 'Subscription renewed', kind: 'money_in', status: 'Completed' },
  subscription_cancelled: { what: 'Subscription cancelled', kind: 'ended', status: 'Cancelled' },
  subscription_suspended: { what: 'Subscription suspended', kind: 'ended', status: 'Suspended' },
  subscription_expired: { what: 'Subscription expired', kind: 'ended', status: 'Expired' },
  subscription_reactivated: { what: 'Subscription reactivated', kind: 'info', status: 'Active' },
  order_refunded: { what: 'Order refunded', kind: 'refund_out', status: 'Refunded' },
  order_revoked: { what: 'Order revoked, no refund', kind: 'info', status: 'Revoked' },
  payment_reversed: { what: 'Payment reversed', kind: 'action', status: 'Refunded' }
});

// A card about one order. row is an order joined with its user and product
// (getOrderWithContext, or getBillingIssueContext). amountCents defaults to the
// row's amount; pass null to leave the Amount field out.
function orderEventCard(event, row, opts = {}) {
  const ev = ORDER_EVENTS[event];
  if (!ev) throw new TypeError(`unknown order event "${event}"`);
  const r = row || {};
  const { accessUntil = null, nextCharge = null, subscriptionId = null, byStaff = false, fields = [], description = null } = opts;
  const sub = subscriptionId || r.paypal_subscription_id || null;
  return {
    kind: ev.kind,
    what: ev.what,
    product: r.product_title,
    server: cardServer(r),
    orderId: orderIdOf(r),
    testMode: !!r.test_mode,
    byStaff,
    description,
    amountCents: Object.prototype.hasOwnProperty.call(opts, 'amountCents') ? opts.amountCents : r.amount_cents,
    currency: r.currency,
    accessUntil,
    nextCharge,
    fields: [
      ...playerFields(r),
      { name: 'Status', value: ev.status, inline: true },
      ...(sub ? [{ name: 'Subscription', value: code(sub), inline: true }] : []),
      ...fields
    ]
  };
}

// ---- Subscriptions the shop ended, and payments it refused (paymentEvents.js) --------

// What cancelAtPayPal's result reads as on a card, and the sentence a card adds
// when the cancel did not go through.
function cancelWords(cancel) {
  const c = cancel || { outcome: 'none' };
  if (c.outcome === 'failed') return `Cancel failed${c.status ? ` (HTTP ${c.status})` : ''}`;
  if (c.outcome === 'unknown') return 'No answer from PayPal: check it there';
  return { cancelled: 'Cancelled at PayPal', already_ended: 'Already ended at PayPal' }[c.outcome] || 'Not cancelled';
}
function cancelSentence(cancel) {
  const c = cancel || {};
  if (c.outcome === 'failed') return ` PayPal refused to cancel the subscription${c.status ? ` (HTTP ${c.status})` : ''}, so it can still bill: cancel it in PayPal.`;
  if (c.outcome === 'unknown') return ' PayPal did not answer the request to cancel the subscription, so it may still be active: check it in PayPal.';
  return '';
}
function slotWords(slot) {
  if (!slot || !Number.isFinite(slot.limit)) return null;
  return `${slot.used} of ${slot.limit} taken${slot.reserved ? `, ${slot.reserved} more waiting at PayPal` : ''}`;
}

// The shop ended a subscription because PayPal could not take a renewal
// (paymentEvents.endUnpaidSubscription). ctx is paymentEvents.subscriptionContext's
// row (it carries order_id); cancel is cancelAtPayPal's result; source is webhook,
// reconcile (the daily PayPal check) or rescan. Blue and silent when the cancel went
// through, since nothing is left to do; red when PayPal refused it, amber when PayPal
// did not answer.
function unpaidEndedCard({ ctx, subscriptionId = null, cancel = null, failedCount = 0, outstandingCents = 0, currency = null, accessUntil = null, source = 'webhook', now = Math.floor(Date.now() / 1000) }) {
  const c = ctx || {};
  const sub = subscriptionId || c.paypal_subscription_id || null;
  const outcome = cancel ? cancel.outcome : 'none';
  const dated = !!discordDate(accessUntil);
  let description = 'PayPal could not take the renewal payment, so the shop ended the subscription at once.';
  if (c.grants_priority_queue) description += ' No payment, no priority queue: nobody keeps a slot they have not paid for.';
  description += !dated ? ' No paid access is left.'
    : Number(accessUntil) > now ? ' The player keeps access until the date shown, the end of what they already paid for.'
      : ' Their paid access ended on the date shown.';
  if (source === 'reconcile') description += ' Found by the daily PayPal check: PayPal\'s own notice of the failure never arrived.';
  else if (source === 'rescan') description += ' Found by a billing rescan.';
  description += cancelSentence(cancel);
  const fields = [
    ...playerFields(c),
    { name: 'Status', value: 'Ended, payment not received', inline: true },
    ...(sub ? [{ name: 'Subscription', value: code(sub), inline: true }, { name: 'PayPal subscription', value: cancelWords(cancel), inline: true }] : []),
    ...(Number(failedCount) > 0 ? [{ name: 'Failed payments', value: String(failedCount), inline: true }] : []),
    ...(Number(outstandingCents) > 0 ? [{ name: 'Outstanding', value: money(outstandingCents, currency || c.currency), inline: true }] : []),
    ...(!dated ? [{ name: 'Access until', value: 'No paid access left', inline: true }] : [])
  ];
  return {
    kind: outcome === 'failed' ? 'action' : outcome === 'unknown' ? 'attention' : 'ended',
    what: 'Subscription ended, payment not received',
    product: c.product_title,
    server: cardServer(c),
    orderId: orderIdOf(c),
    testMode: !!c.test_mode,
    description,
    accessUntil: dated ? accessUntil : null,
    fields
  };
}

// A payment the shop could not honour, refunded and its subscription cancelled
// (paymentEvents.refuseSale). reason: no_slot, ended_unpaid, ended_no_slot or revoked;
// firstPayment: a no_slot payment that would have started the subscription. refund
// is paymentEvents.refundPayment's result, cancel is cancelAtPayPal's, slot is
// { limit, used, reserved } for no_slot. ctx is the subscription's newest order, or
// null. Purple when the money went back and the subscription is cancelled; red when
// PayPal refused the refund or the cancel; amber when PayPal did not answer one.
function refusedPaymentCard({ ctx = null, subscriptionId = null, saleId = null, amountCents = null, currency = null, reason = 'no_slot', firstPayment = false, serverId = null, slot = null, refund = null, cancel = null, testMode = false }) {
  const c = ctx || {};
  const sub = subscriptionId || c.paypal_subscription_id || null;
  const got = money(amountCents, currency || c.currency);
  const paid = got ? `PayPal took ${got}` : 'PayPal took a payment';
  const where = serverLabel(serverId || c.server_id) || 'its server';
  const why = {
    no_slot: firstPayment
      ? `${paid}, the first payment of this subscription, after ${where} had filled up, so the shop could not start it.`
      : `${paid} after this subscription's paid period and renewal window had ended, and ${where} has no free priority queue slot now, so the shop could not honour it.`,
    ended_unpaid: `${paid} on a subscription the shop had already ended because a renewal payment failed.`,
    ended_no_slot: `${paid} on a subscription the shop had already ended because ${where} had no free slot for it.`,
    revoked: `${paid} on a subscription whose orders had all been revoked or refunded and which the shop had already ended, so it gave nothing.`
  }[reason] || `${paid} that the shop could not honour.`;
  const r = refund || { outcome: 'failed' };
  let refundText;
  if (r.outcome === 'refunded') {
    const pending = r.refundStatus && String(r.refundStatus).toUpperCase() !== 'COMPLETED';
    refundText = pending
      ? ' The shop asked PayPal to refund it in full and PayPal has not finished the refund yet. Nothing was granted.'
      : ' It was refunded in full automatically and nothing was granted.';
  } else if (r.outcome === 'unknown') {
    refundText = ' PayPal did not answer the refund request, so the money may or may not have gone back: check the payment in PayPal before refunding it by hand. Nothing was granted.';
  } else {
    refundText = ` PayPal refused the automatic refund${r.status ? ` (HTTP ${r.status})` : ''}, so the buyer still has not had the money back: refund it in PayPal. Nothing was granted.`;
  }
  const bad = r.outcome === 'failed' || (cancel && cancel.outcome === 'failed');
  const unsure = r.outcome === 'unknown' || (cancel && cancel.outcome === 'unknown');
  const tail = reason === 'no_slot' ? 'server full' : 'subscription had ended';
  const what = r.outcome === 'refunded' ? `Payment refunded, ${tail}` : r.outcome === 'unknown' ? `Refund state unknown, ${tail}` : `Refund failed, ${tail}`;
  const fields = [
    ...(ctx ? playerFields(c) : []),
    ...(saleId ? [{ name: 'Sale', value: code(saleId), inline: true }] : []),
    ...(sub ? [{ name: 'Subscription', value: code(sub), inline: true }, { name: 'PayPal subscription', value: cancelWords(cancel), inline: true }] : []),
    ...(r.refundId ? [{ name: 'Refund id', value: code(r.refundId), inline: true }] : []),
    ...(r.outcome === 'refunded' && r.refundStatus && String(r.refundStatus).toUpperCase() !== 'COMPLETED' ? [{ name: 'Refund at PayPal', value: words(r.refundStatus), inline: true }] : []),
    ...(slotWords(slot) ? [{ name: 'Priority queue slots', value: slotWords(slot), inline: true }] : [])
  ];
  return {
    kind: bad ? 'action' : unsure ? 'attention' : 'refund_out',
    what,
    product: c.product_title,
    server: cardServer(ctx ? c : null) || serverId,
    orderId: ctx ? orderIdOf(c) : null,
    testMode: ctx ? !!c.test_mode : !!testMode,
    description: why + refundText + cancelSentence(cancel),
    amountCents: Number.isFinite(amountCents) ? amountCents : null,
    currency: currency || c.currency,
    fields
  };
}

// A priority queue subscription that activated at PayPal when its server had no slot
// for it (paymentEvents.claimActivation): not started, cancelled at PayPal. order is
// the checkout order with its user and product. Blue and silent when the cancel went
// through: if PayPal takes the first payment, its refund posts its own card.
function refusedActivationCard({ order, serverId = null, slot = null, cancel = null }) {
  const o = order || {};
  const outcome = cancel ? cancel.outcome : 'none';
  const where = serverLabel(serverId || o.server_id) || 'its server';
  return {
    kind: outcome === 'failed' ? 'action' : outcome === 'unknown' ? 'attention' : 'ended',
    what: 'Subscription not started, server full',
    product: o.product_title,
    server: cardServer(o),
    orderId: orderIdOf(o),
    testMode: !!o.test_mode,
    description: `${where} had no free priority queue slot when this subscription activated at PayPal (it filled while the buyer was approving), so the shop did not start it and nothing was granted. If PayPal takes the first payment, it is refunded automatically.${cancelSentence(cancel)}`,
    fields: [
      ...playerFields(o),
      { name: 'Status', value: 'Not started', inline: true },
      ...(o.paypal_subscription_id ? [{ name: 'Subscription', value: code(o.paypal_subscription_id), inline: true }, { name: 'PayPal subscription', value: cancelWords(cancel), inline: true }] : []),
      ...(slotWords(slot) ? [{ name: 'Priority queue slots', value: slotWords(slot), inline: true }] : [])
    ]
  };
}

// A paid Custom Flag order, for staff to make. imageName is the attachment name
// when the submitted image goes with the card.
function customFlagCard({ orderId, order, customFields, imageName = null }) {
  const o = order || {};
  const cf = customFields || {};
  return {
    kind: 'attention',
    what: 'Custom flag order',
    product: o.product_title,
    server: o.server_id,
    orderId: orderId != null ? orderId : orderIdOf(o),
    testMode: !!o.test_mode,
    amountCents: o.amount_cents,
    currency: o.currency,
    fields: [
      { name: 'Account', value: o.steam_id || 'Unknown', inline: true },
      { name: 'Player name', value: cf.playerName || 'Unknown', inline: true },
      { name: 'In-game name', value: cf.inGameName || 'Unknown', inline: true },
      { name: 'In-game ID', value: cf.guid ? shortId(cf.guid) : 'Unknown', inline: true },
      { name: 'Discord ID', value: cf.discordId || 'Not provided', inline: true },
      { name: 'Receipt', value: `RFGZ-${String(orderId != null ? orderId : orderIdOf(o)).padStart(6, '0')}`, inline: true }
    ],
    imageUrl: imageName ? `attachment://${imageName}` : null
  };
}

// Staff moved a paid priority queue order to another server
// (pqEntitlement.moveSubscriptionServer). order is the live cycle with its user and
// product, read after the move; orderIds every row that changed.
function staffQueueMoveCard({ order, from, to, orderIds = [], reason = null }) {
  const o = order || {};
  const sub = o.paypal_subscription_id || null;
  const fromLabel = serverLabel(from) || 'an unknown server';
  const toLabel = serverLabel(to) || 'an unknown server';
  const fields = [
    ...playerFields(o),
    { name: 'Moved', value: `${fromLabel} to ${toLabel}`, inline: false },
    { name: orderIds.length === 1 ? 'Order changed' : 'Orders changed', value: orderIds.map(id => `#${id}`).join(', ') || 'None', inline: false },
    ...(sub ? [{ name: 'Subscription', value: code(sub), inline: true }] : []),
    ...(reason ? [{ name: 'Reason', value: String(reason), inline: false }] : [])
  ];
  return {
    kind: 'info',
    what: 'Priority queue moved by staff',
    product: o.product_title,
    server: to,
    orderId: orderIdOf(o),
    testMode: !!o.test_mode,
    byStaff: true,
    accessUntil: o.effective_until,
    description: sub
      ? `Staff moved this subscription from ${fromLabel} to ${toLabel}. Every cycle of it now names ${toLabel}, so its renewals pay for ${toLabel}. The paid period is unchanged.`
      : `Staff moved this order from ${fromLabel} to ${toLabel}. The paid period is unchanged.`,
    fields,
    footerExtra: "Takes effect at each server's next restart"
  };
}

// The sync found a server's game.admins would be longer than the limit (sync.js
// checkAdminCeiling). Nothing was removed. Counts only, no in-game IDs.
function adminCeilingCard({ serverId, planned, ceiling, current = null, shopOwned = null, others = null }) {
  const fields = [
    { name: 'Entries after this sync', value: String(planned), inline: true },
    { name: 'Limit', value: String(ceiling), inline: true },
    ...(Number.isFinite(current) ? [{ name: 'Entries before', value: String(current), inline: true }] : []),
    ...(Number.isFinite(shopOwned) ? [{ name: 'Priority queue, from the shop', value: String(shopOwned), inline: true }] : []),
    ...(Number.isFinite(others) ? [{ name: 'Game masters and others', value: String(others), inline: true }] : [])
  ];
  return {
    kind: 'action',
    what: 'Admin list over the limit',
    server: serverId,
    description: `This server's admin list has ${planned} entries, over the limit of ${ceiling}. Nothing was removed: the shop never drops a paying player or a game master to make room. Free a place by removing a game master on the GM tab, or by revoking a priority queue order for this server. The shop stops selling this server until it is back under the limit.`,
    fields,
    footerExtra: 'Entitlement sync. Posted again if the list grows, or twice a day while it stays over.'
  };
}

// PayPal billed a subscription whose orders were all revoked or refunded
// (pqGuards.recordRevokedRenewal). context is the newest order with its user and
// product, when the call site could load it.
// How an order's state reads on a card. A revoke with no money back is stored as
// 'refunded' (entitlement readers need that), but it was not a refund.
function orderStateWords(x) {
  if (!x) return 'unknown';
  if (x.status === 'refunded' && x.revoked_without_refund_at != null) return 'revoked, no refund';
  return x.status || 'unknown';
}

function revokedRenewalCard({ subId, saleId, orders = [], amountCents = null, currency = 'usd', context = null }) {
  const c = context || {};
  const latest = orders.length ? orders[orders.length - 1] : null;
  const accounts = Array.from(new Set(orders.map(x => x.steam_id).filter(Boolean)));
  const fields = [
    { name: 'Orders', value: orders.map(x => `#${x.id} ${orderStateWords(x)}`).join(', ') || 'None', inline: false },
    { name: 'Player', value: playerName(c) || 'Unknown', inline: true },
    { name: 'Account', value: accounts.join(', ') || 'Unknown', inline: true },
    { name: 'Subscription', value: code(subId), inline: true },
    { name: 'Sale', value: code(saleId), inline: true }
  ];
  if (!Number.isFinite(amountCents)) fields.push({ name: 'Amount', value: 'Not given by PayPal', inline: true });
  return {
    kind: 'action',
    what: 'Renewal received for a revoked subscription',
    product: c.product_title,
    server: cardServer(c),
    orderId: latest ? latest.id : orderIdOf(c),
    testMode: orders.length > 0 && orders.every(x => x.test_mode),
    description: 'PayPal billed a subscription whose orders were all revoked or refunded. Nothing was granted.',
    amountCents: Number.isFinite(amountCents) ? amountCents : null,
    currency,
    fields,
    footerExtra: 'Cancel the agreement in PayPal, and refund this payment if the player should not be billed.'
  };
}

// A renewal booked after the subscription's newest cycle was revoked
// (pqGuards.refundedLatestCycle). original is the subscription's first live order.
// It is the one card for that sale: it carries the renewal's facts too.
// noRefund: that cycle was revoked with no money back. nextCharge: PayPal's next
// billing time, unix seconds.
function renewalAfterRefundCard({ subId, saleId, refundedOrderId, newOrderId, original, amountCents, noRefund = false, nextCharge = null }) {
  const o = original || {};
  const fields = [
    { name: noRefund ? 'Revoked cycle (no refund)' : 'Refunded cycle', value: `#${refundedOrderId}`, inline: true },
    { name: 'New cycle', value: `#${newOrderId}`, inline: true },
    { name: 'Player', value: playerName(o) || o.steam_id || 'Unknown', inline: true },
    { name: 'Account', value: o.steam_id || 'Unknown', inline: true },
    { name: 'Subscription', value: code(subId), inline: true },
    { name: 'Sale', value: code(saleId), inline: true }
  ];
  if (!Number.isFinite(amountCents)) fields.push({ name: 'Amount', value: 'Not given by PayPal', inline: true });
  return {
    kind: 'action',
    what: noRefund ? 'Renewal after a revoke' : 'Renewal after a refund',
    product: o.product_title,
    server: cardServer(o),
    orderId: newOrderId,
    testMode: !!o.test_mode,
    description: noRefund
      ? 'PayPal billed a subscription whose latest cycle staff had revoked without a refund. The renewal was booked and its perks given as normal, because the shop cannot tell whether the subscription was meant to carry on.'
      : "PayPal billed a subscription whose latest cycle was refunded. The renewal was booked and its perks given as normal, because a refund made on PayPal's side can leave a subscription that is meant to carry on.",
    amountCents: Number.isFinite(amountCents) ? amountCents : null,
    currency: o.currency,
    nextCharge,
    fields,
    footerExtra: 'If the subscription was meant to end, revoke the new cycle with a refund: that also cancels it at PayPal.'
  };
}

// A second live priority queue subscription for the same account and server
// (pqGuards.duplicateLiveSubscription). order is the new one, other the one already live.
function duplicateSubscriptionCard(order, other) {
  const o = order || {};
  const x = other || {};
  const where = o.server_specific && o.server_id ? serverLabel(o.server_id) : 'every server';
  return {
    kind: 'action',
    what: 'Duplicate priority queue subscription',
    product: o.product_title,
    server: o.server_specific ? o.server_id : null,
    orderId: orderIdOf(o),
    testMode: !!o.test_mode,
    description: `This account now pays for two auto-renewing priority queue subscriptions for ${where}. Nothing was cancelled or refunded. Check with the player, then cancel and refund the one they did not mean to buy.`,
    fields: [
      { name: 'Player', value: playerName(o) || o.steam_id || 'Unknown', inline: true },
      { name: 'Account', value: o.steam_id || 'Unknown', inline: true },
      { name: 'New', value: `#${o.id} ${code(o.paypal_subscription_id)}`, inline: false },
      { name: 'Already live', value: `#${x.id} ${code(x.paypal_subscription_id)}${discordDate(x.effective_until) ? `, paid up to ${discordDate(x.effective_until)}` : ''}`, inline: false }
    ],
    footerExtra: 'Revoke with refund also cancels that subscription at PayPal'
  };
}

// ---- Staff revokes, refunds, reversals, disputes (paymentEvents.js) -----------------

// PayPal's upper-case codes in plain words: WAITING_FOR_SELLER_RESPONSE becomes
// "Waiting for seller response".
function words(value) {
  if (value == null || value === '') return null;
  const s = String(value).toLowerCase().replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const DISPUTE_REASONS = Object.freeze({
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Not as described',
  UNAUTHORISED: 'Not authorised by the account holder',
  CREDIT_NOT_PROCESSED: 'Refund not processed',
  DUPLICATE_TRANSACTION: 'Charged twice',
  INCORRECT_AMOUNT: 'Wrong amount charged',
  PAYMENT_BY_OTHER_MEANS: 'Paid another way',
  CANCELED_RECURRING_BILLING: 'Billed after cancelling',
  PROBLEM_WITH_REMITTANCE: 'Problem with the payment',
  OTHER: 'Other'
});

const CANCEL_RESULTS = Object.freeze({
  cancelled: 'Cancelled at PayPal',
  already_ended: 'Already ended at PayPal'
});

// The one card for a staff revoke, from the admin page or the ticket bot's /refund.
// refunded is true only when a refund was asked for and PayPal accepted it: the
// route posts refundUnknownCard or nothing when the refund call fails.
// refundStatus other than COMPLETED means PayPal has not finished the refund.
// earlierRefundedCents: refunds made in PayPal before this revoke; coveredEarlier:
// a refund was asked for but those already covered the order, so none was made.
// cancel is paymentEvents.cancelAtPayPal's result. A refused cancel makes the card
// red, since the agreement can bill the player again; no answer from PayPal makes
// it amber, since it may or may not have gone through.
function staffRevokeCard({
  order, refunded = false, refundedCents = null, refundId = null, refundStatus = null, cancel = null,
  earlierRefundedCents = 0, coveredEarlier = false
}) {
  const o = order || {};
  const c = cancel || { outcome: 'none' };
  const failed = c.outcome === 'failed';
  const unknown = c.outcome === 'unknown';
  const pending = refunded && !!refundStatus && String(refundStatus).toUpperCase() !== 'COMPLETED';
  const price = money(o.amount_cents, o.currency) || 'unpriced';
  const paid = Number.isFinite(refundedCents) && refundedCents > 0 ? refundedCents : o.amount_cents;
  const got = money(paid, o.currency) || price;
  const earlier = Number(earlierRefundedCents) > 0 ? money(earlierRefundedCents, o.currency) : null;
  const sub = o.paypal_subscription_id || null;
  let description;
  if (pending) {
    description = `Staff asked PayPal to refund ${got} and removed this order's perks. PayPal has not finished the refund yet, so the money has not reached the buyer. A card follows if PayPal reports that the refund failed.`;
  } else if (refunded) {
    description = `Staff refunded ${got} to the buyer's PayPal and removed this order's perks.`;
  } else if (coveredEarlier) {
    description = "Staff removed this order's perks. Refunds made earlier in PayPal already covered the order, so nothing more was refunded.";
  } else {
    description = "Staff removed this order's perks. No money was returned.";
  }
  if (earlier && !coveredEarlier) description += ` ${earlier} had already been refunded in PayPal before this.`;
  if (failed) {
    description += ` PayPal did not cancel the subscription${c.status ? ` (HTTP ${c.status})` : ''}, so it can bill again: cancel it in PayPal.`;
  } else if (unknown) {
    description += ' PayPal did not answer the request to cancel the subscription, so it may still be active: check it in PayPal.';
  }
  const fields = [
    ...playerFields(o),
    { name: 'Status', value: refunded ? (pending ? 'Refund pending' : 'Refunded') : 'Revoked', inline: true }
  ];
  if (sub) {
    fields.push({ name: 'Subscription', value: code(sub), inline: true });
    fields.push({
      name: 'PayPal subscription',
      value: failed ? `Cancel failed${c.status ? ` (HTTP ${c.status})` : ''}`
        : unknown ? 'No answer from PayPal: check it there'
          : (CANCEL_RESULTS[c.outcome] || 'Not cancelled'),
      inline: true
    });
  }
  if (!refunded) fields.push({ name: 'Refund', value: coveredEarlier ? `None now (earlier refunds covered the ${price} order)` : `None (the order was ${price})`, inline: true });
  if (earlier) fields.push({ name: 'Refunded earlier in PayPal', value: earlier, inline: true });
  if (refunded && refundId) fields.push({ name: 'Refund id', value: code(refundId), inline: true });
  if (pending) fields.push({ name: 'Refund at PayPal', value: words(refundStatus), inline: true });
  return {
    kind: failed ? 'action' : (unknown || pending) ? 'attention' : (refunded ? 'refund_out' : 'info'),
    what: pending ? `Refund pending ${got}` : refunded ? `Refunded ${got}` : 'Access removed, not refunded',
    product: o.product_title,
    server: cardServer(o),
    orderId: orderIdOf(o),
    testMode: !!o.test_mode,
    byStaff: true,
    description,
    amountCents: refunded ? paid : null,
    currency: o.currency,
    fields
  };
}

// A staff refund whose PayPal call got no answer (timed out, or the network
// failed): PayPal may or may not have made the refund, so the shop changed nothing.
// amountCents is what was asked for.
function refundUnknownCard({ order, amountCents = null }) {
  const o = order || {};
  const asked = money(Number.isFinite(amountCents) ? amountCents : o.amount_cents, o.currency) || 'the refund';
  return {
    kind: 'action',
    what: 'Refund state unknown',
    product: o.product_title,
    server: cardServer(o),
    orderId: orderIdOf(o),
    testMode: !!o.test_mode,
    description: `Staff asked PayPal to refund ${asked} for this order and PayPal did not answer in time, so nobody knows yet whether the money went back. Nothing was changed: the order keeps its perks and its subscription. Check the payment in PayPal before trying again. If it was refunded, the shop records that when PayPal reports it; then revoke without a refund to cancel the subscription.`,
    amountCents: Number.isFinite(amountCents) ? amountCents : null,
    currency: o.currency,
    fields: [
      ...playerFields(o),
      { name: 'Status', value: words(o.status) || 'Completed', inline: true },
      ...(o.paypal_subscription_id ? [{ name: 'Subscription', value: code(o.paypal_subscription_id), inline: true }] : []),
      ...(o.paypal_capture_id ? [{ name: 'Payment', value: code(o.paypal_capture_id), inline: true }] : [])
    ]
  };
}

// A refund or reversal PayPal reported (paymentEvents.applyRefundEvent's plan). order
// is the matched order with its user and product, or null.
function refundEventCard({ plan, order = null, testMode = false }) {
  const p = plan || {};
  const o = order || {};
  const reversal = p.kind === 'reversal';
  const got = money(p.amountCents, p.currency || o.currency) || 'an amount PayPal did not give';
  const sub = o.paypal_subscription_id || p.subscriptionId || null;
  const refs = [
    ...(sub ? [{ name: 'Subscription', value: code(sub), inline: true }] : []),
    ...(p.paymentId ? [{ name: 'Payment', value: code(p.paymentId), inline: true }] : []),
    ...(p.refundId && !String(p.refundId).startsWith('event:') ? [{ name: reversal ? 'Reversal' : 'Refund id', value: code(p.refundId), inline: true }] : [])
  ];
  const base = {
    product: o.product_title,
    server: cardServer(order ? o : null),
    orderId: order ? orderIdOf(o) : null,
    testMode: order ? !!o.test_mode : !!testMode,
    amountCents: Number.isFinite(p.amountCents) ? p.amountCents : null,
    currency: p.currency || o.currency
  };
  const who = order ? playerFields(o) : [];
  const status = (value) => ({ name: 'Status', value, inline: true });
  switch (p.action) {
    case 'refunded':
      return {
        ...base, kind: 'refund_out', what: 'Order refunded',
        description: `${got} was refunded in PayPal, outside the shop. This order is now refunded and its perks are removed.`,
        fields: [...who, status('Refunded'), ...refs]
      };
    case 'partial': {
      const price = money(o.amount_cents, o.currency);
      return {
        ...base, kind: 'refund_out', what: 'Partial refund',
        description: `${got} of this${price ? ` ${price}` : ''} order was refunded in PayPal, outside the shop. The order stays active and keeps its perks: revoke it if access should end.`,
        fields: [
          ...who, status('Completed, partly refunded'),
          ...(Number.isFinite(p.refundedSoFarCents) ? [{ name: 'Refunded so far', value: money(p.refundedSoFarCents, p.currency || o.currency), inline: true }] : []),
          ...refs
        ]
      };
    }
    case 'recorded':
      if (p.revokedWithoutRefund) {
        return {
          ...base, kind: 'refund_out', what: 'Refund recorded',
          description: `${got} was refunded in PayPal for an order staff had revoked without a refund. Its perks were already removed; it now counts as refunded. Nothing else changed.`,
          fields: [...who, status('Refunded'), ...refs]
        };
      }
      return {
        ...base, kind: 'refund_out', what: 'Refund recorded',
        description: `${got} was refunded in PayPal for an order that is ${o.status === 'refunded' ? 'already refunded' : `marked ${o.status || 'closed'}`}. Nothing else changed.`,
        fields: [...who, status(words(o.status) || 'Unknown'), ...refs]
      };
    case 'reversed':
      return {
        ...base, kind: 'action', what: 'Payment reversed',
        description: `PayPal took ${got} back for this order (a chargeback or a bank reversal). The order and its perks were not changed. Answer it in PayPal, then revoke the order if access should end.`,
        fields: [...who, status(words(o.status) || 'Unknown'), ...refs]
      };
    case 'unmatched':
      return reversal
        ? {
            ...base, kind: 'action', what: 'Payment reversed, no matching order',
            description: `PayPal took ${got} back for a payment the shop has no order for. Nothing was changed. Look the payment up in PayPal.`,
            fields: refs
          }
        : {
            ...base, kind: 'attention', what: 'Refund with no matching order',
            description: `${got} was refunded in PayPal for a payment the shop has no order for. Nothing was changed.`,
            fields: refs
          };
    default:
      throw new TypeError(`no card for refund action "${p.action}"`);
  }
}

// PayPal could not complete a refund it had accepted (paymentEvents.applyRefundFailure's
// plan). order is the order the refund was for, with its user and product, or null.
function refundFailedCard({ plan, order = null, testMode = false }) {
  const p = plan || {};
  const o = order || {};
  const got = money(p.amountCents, p.currency || o.currency) || 'a refund';
  const bySource = p.source === 'staff' ? 'Staff made this refund through the shop. ' : '';
  return {
    kind: 'action',
    what: 'Refund failed',
    product: o.product_title,
    server: cardServer(order ? o : null),
    orderId: order ? orderIdOf(o) : null,
    testMode: order ? !!o.test_mode : !!testMode,
    description: `PayPal could not complete ${got} back to the buyer, so the money did not reach them. ${bySource}Nothing was changed on the order or its perks. Refund the buyer again in PayPal, or contact them.`,
    amountCents: Number.isFinite(p.amountCents) ? p.amountCents : null,
    currency: p.currency || o.currency,
    fields: [
      ...(order ? [...playerFields(o), { name: 'Status', value: words(o.status) || 'Unknown', inline: true }] : [{ name: 'Order', value: 'No order matches the refunded payment', inline: false }]),
      ...(o.paypal_subscription_id ? [{ name: 'Subscription', value: code(o.paypal_subscription_id), inline: true }] : []),
      ...(p.paymentId ? [{ name: 'Payment', value: code(p.paymentId), inline: true }] : []),
      ...(p.refundId ? [{ name: 'Refund id', value: code(p.refundId), inline: true }] : [])
    ]
  };
}

// A PayPal dispute (paymentEvents.applyDisputeEvent). card is opened, status_changed
// or resolved; result (resolved only) is lost, won or unclear. Only a lost dispute
// changes the order (paymentEvents.revokeForLostDispute): revoke is that result, and
// every other card says nothing changed.
function disputeCard({ card, dispute, previous = null, order = null, result = null, revoke = null, testMode = false }) {
  const d = dispute || {};
  const o = order || {};
  const amount = money(d.amountCents, d.currency || o.currency);
  const reason = DISPUTE_REASONS[d.reason] || words(d.reason) || 'Not given';
  const fields = [
    ...(order ? playerFields(o) : []),
    { name: 'Dispute', value: code(d.disputeId), inline: true },
    { name: 'Reason', value: reason, inline: true },
    ...(d.stage ? [{ name: 'Stage', value: words(d.stage), inline: true }] : []),
    { name: 'PayPal status', value: words(d.status) || 'Not given', inline: true },
    ...(o.paypal_subscription_id ? [{ name: 'Subscription', value: code(o.paypal_subscription_id), inline: true }] : []),
    ...(d.paymentId ? [{ name: 'Payment', value: code(d.paymentId), inline: true }] : [])
  ];
  if (!order) fields.push({ name: 'Order', value: 'No order matches the disputed payment', inline: false });
  const base = {
    product: o.product_title,
    server: cardServer(order ? o : null),
    orderId: order ? orderIdOf(o) : null,
    testMode: order ? !!o.test_mode : !!testMode,
    amountCents: Number.isFinite(d.amountCents) ? d.amountCents : null,
    currency: d.currency || o.currency
  };
  const unchanged = 'Nothing was changed on the order or its perks.';
  if (card === 'opened') {
    const by = discordDate(d.respondBy);
    return {
      ...base, kind: 'action', what: 'Dispute opened',
      description: `The buyer disputed ${amount || 'a payment'} in PayPal (${reason.toLowerCase()}). ${unchanged} Answer it in PayPal's Resolution Center${by ? ` by ${by}` : ''}.`,
      fields: [...fields, ...(by ? [{ name: 'Respond by', value: by, inline: true }] : [])]
    };
  }
  if (card === 'status_changed') {
    const ours = d.status === 'WAITING_FOR_SELLER_RESPONSE';
    return {
      ...base, kind: ours ? 'action' : 'attention', what: 'Dispute updated',
      description: `PayPal moved this dispute from ${(words(previous && previous.status) || 'an unknown status').toLowerCase()} to ${(words(d.status) || 'an unknown status').toLowerCase()}.${ours ? ' PayPal is waiting for the shop to respond.' : ''} ${unchanged}`,
      fields
    };
  }
  if (card === 'resolved') {
    const outcome = words(d.outcome) || 'Not given';
    const withOutcome = [...fields, { name: 'Outcome', value: outcome, inline: true }];
    if (result === 'lost') {
      const lost = money(d.amountRefundedCents, d.currency || o.currency) || amount || 'the disputed amount';
      if (revoke && revoke.revoked) {
        return {
          ...base, kind: 'refund_out', what: 'Dispute lost',
          description: `PayPal closed this dispute in the buyer's favour, so the shop lost ${lost}. The order is now refunded and its perks were removed automatically.${o.paypal_subscription_id ? ' Its subscription was not cancelled: if PayPal bills it again, cancel it in PayPal.' : ''}`,
          fields: [...withOutcome, { name: 'Status', value: 'Refunded', inline: true }]
        };
      }
      const rest = revoke && revoke.reason === 'not_completed'
        ? ` The order was already ${(words(revoke.status) || 'closed').toLowerCase()}, so nothing on it changed.`
        : ` ${unchanged} Decide whether the order should keep its perks.`;
      return {
        ...base, kind: 'action', what: 'Dispute lost',
        description: `PayPal closed this dispute in the buyer's favour, so the shop lost ${lost}.${rest}`,
        fields: withOutcome
      };
    }
    if (result === 'won') {
      return {
        ...base, kind: 'money_in', what: 'Dispute won',
        description: `PayPal closed this dispute in the shop's favour, so the shop keeps ${amount || 'the money'}. ${unchanged}`,
        fields: withOutcome
      };
    }
    return {
      ...base, kind: 'attention', what: 'Dispute closed',
      description: `PayPal closed this dispute without saying who kept the money. Check the outcome in PayPal. ${unchanged}`,
      fields: withOutcome
    };
  }
  throw new TypeError(`no dispute card "${card}"`);
}

// PayPal took a subscription payment the shop has no order rows for at all
// (paymentEvents.recordUnmatchedSale). customId is the checkout order PayPal names.
function unmatchedSaleCard({ subId, saleId, amountCents = null, currency = 'usd', customId = null, testMode = false }) {
  const fields = [
    { name: 'Subscription', value: code(subId), inline: true },
    { name: 'Sale', value: code(saleId), inline: true }
  ];
  if (customId != null && customId !== '') fields.push({ name: 'Checkout order named by PayPal', value: `#${customId}`, inline: true });
  if (!Number.isFinite(amountCents)) fields.push({ name: 'Amount', value: 'Not given by PayPal', inline: true });
  return {
    kind: 'action',
    what: 'Payment on a subscription with no orders',
    orderId: null,
    testMode: !!testMode,
    description: 'PayPal took a subscription payment, but the shop has no order for that subscription, so nothing was granted. Find the buyer in PayPal, then refund the payment or set the order up by hand.',
    amountCents: Number.isFinite(amountCents) ? amountCents : null,
    currency,
    fields,
    footerExtra: 'Cancel the agreement in PayPal if it should not bill again.'
  };
}

// A subscription PayPal ended. No Amount: nothing was paid or returned, and an
// amount on this card read as money moving. The standard Access until field shows
// how long the player keeps what they paid for.
function subscriptionEndedCard(endedReason, ctx, { accessUntil = null, note = null, failedCount = 0, outstandingCents = 0, now = Math.floor(Date.now() / 1000) } = {}) {
  const event = { cancelled: 'subscription_cancelled', suspended: 'subscription_suspended', expired: 'subscription_expired' }[endedReason];
  if (!event) throw new TypeError(`unknown ended reason "${endedReason}"`);
  const c = ctx || {};
  const dated = !!discordDate(accessUntil);
  const fields = [];
  let description;
  if (endedReason === 'cancelled') {
    // PayPal records who ended it. "Cancelled by customer" is written only by the
    // shop's own cancel endpoint; an empty note means the buyer did it from PayPal.
    fields.push({ name: 'Cancelled via', value: note || 'PayPal, by the buyer (no note)', inline: false });
    description = 'Auto-renew is off, so PayPal takes no more payments.';
  } else if (endedReason === 'suspended') {
    fields.push({ name: 'Why', value: `PayPal stopped retrying after ${failedCount} failed payment${failedCount === 1 ? '' : 's'}`, inline: false });
    if (outstandingCents) fields.push({ name: 'Outstanding', value: money(outstandingCents, c.currency), inline: true });
    // The close runs after this card; a separate card follows only if it fails.
    description = 'PayPal gave up on failed payments. The shop is closing the agreement at PayPal.';
  } else {
    description = 'The subscription reached the end of its billing cycles.';
  }
  // An agreement that lapsed long ago can end with a date in the past.
  description += !dated ? ' No paid access is left.'
    : Number(accessUntil) > now ? ' The player keeps access until the date shown, then it ends.'
      : ' Their paid access already ended on the date shown.';
  if (!dated) fields.push({ name: 'Access until', value: 'No paid access left', inline: true });
  return orderEventCard(event, c, { accessUntil, amountCents: null, fields, description });
}

// The automatic close of a suspended agreement did not go through. ctx is the
// subscription's newest order with its user and product; cancel is
// paymentEvents.cancelAtPayPal's result (failed: PayPal refused; unknown: no answer).
function closeSuspendedFailedCard({ subId, ctx = null, cancel = null }) {
  const c = ctx || {};
  const r = cancel || { outcome: 'failed' };
  const unknown = r.outcome === 'unknown';
  return {
    kind: unknown ? 'attention' : 'action',
    what: 'Could not close a suspended agreement',
    product: c.product_title,
    server: cardServer(ctx),
    orderId: ctx ? orderIdOf(c) : null,
    testMode: !!c.test_mode,
    description: unknown
      ? 'PayPal suspended this agreement and the shop asked PayPal to close it, but PayPal did not answer. It may still be open: check it in PayPal and cancel it there if it is.'
      : `PayPal suspended this agreement and refused to close it${r.status ? ` (HTTP ${r.status})` : ''}, so PayPal could still revive and bill it. Cancel it in PayPal.`,
    fields: [
      ...(ctx ? playerFields(c) : []),
      { name: 'Subscription', value: code(subId), inline: true }
    ]
  };
}

// ---- The daily PayPal reconciliation (tools/reconcile.js) ----------------------------

// Transaction Search event codes for money received, in words. Any other code in
// the T00 group is shown as its code.
const PAYMENT_CODE_WORDS = Object.freeze({
  T0000: 'General payment',
  T0002: 'Subscription payment',
  T0003: 'Preapproved payment',
  T0006: 'Checkout payment',
  T0007: 'Website payment',
  T0011: 'Mobile payment'
});

// One card lists at most this many; the preview endpoint lists the rest.
const UNBOOKED_LIST_MAX = 20;

// "$45.00", or "$30.00 + 12.50 EUR" when payments came in more than one currency.
function totalOf(payments) {
  const by = new Map();
  for (const p of payments) {
    if (!Number.isFinite(p.amountCents)) continue;
    const cur = String(p.currency || 'USD').toUpperCase();
    by.set(cur, (by.get(cur) || 0) + p.amountCents);
  }
  return [...by.entries()].map(([cur, cents]) => money(cents, cur)).join(' + ') || null;
}

// The one card a reconciliation run posts: every shop payment PayPal took that no
// record in the shop accounts for. payments: [{ transactionId, code, amountCents,
// currency, at, subscriptionId, invoiceId, orderId, unattachedOrderId }], oldest
// first. unattachedOrderId is set for a subscription's first payment whose order is
// active and granting perks but never had this payment attached (its sale event was
// lost): nothing is owed for those, and they are listed apart so nobody sets up a
// second order for money that already bought one. The run asks PayPal for no payer
// details, so there are none here to show.
function unbookedPaymentsCard({ payments = [], windowStart = null, windowEnd = null }) {
  const list = Array.isArray(payments) ? payments : [];
  const shown = list.slice(0, UNBOOKED_LIST_MAX);
  const lineOf = (p) => {
    const bits = [
      money(p.amountCents, p.currency) || 'amount not given',
      discordDate(p.at, 'f') || 'time not given',
      PAYMENT_CODE_WORDS[p.code] || (p.code ? `event ${p.code}` : null),
      p.subscriptionId ? `subscription ${code(p.subscriptionId)}` : null,
      p.invoiceId ? `invoice ${code(p.invoiceId)}` : null,
      p.unattachedOrderId ? `order #${p.unattachedOrderId} is active but this payment was never attached to it`
        : p.orderId ? `order #${p.orderId} named by PayPal` : null
    ].filter(Boolean);
    return `${code(p.transactionId)} ${bits.join(', ')}`;
  };
  const unbooked = shown.filter(p => !p.unattachedOrderId).map(lineOf);
  const unattached = shown.filter(p => p.unattachedOrderId).map(lineOf);
  const anyUnbooked = list.some(p => !p.unattachedOrderId);
  const anyUnattached = list.some(p => p.unattachedOrderId);
  const description = [];
  if (unbooked.length) {
    description.push(
      'PayPal took these payments, but no order, renewal, refund, dispute or earlier alert in the shop matches them. Nothing was granted for them, and no card went out when they arrived.',
      '',
      ...unbooked,
      '',
      'Look each one up in PayPal by its transaction id, then refund it or set the order up by hand.'
    );
  }
  if (unattached.length) {
    if (description.length) description.push('');
    description.push(
      'These paid for an order that is active and already grants its perks, but the payment was never attached to that order. Nothing is owed: do not set up another order for them.',
      '',
      ...unattached
    );
  }
  if (list.length > shown.length) {
    description.push('', `...and ${list.length - shown.length} more. GET /api/shop/admin/reconcile/preview lists every one.`);
  }
  const from = discordDate(windowStart, 'f');
  const to = discordDate(windowEnd, 'f');
  return {
    kind: anyUnbooked || !anyUnattached ? 'action' : 'attention',
    what: list.length === 1 ? 'PayPal payment the shop never booked' : `${list.length} PayPal payments the shop never booked`,
    description: description.join('\n'),
    fields: [
      { name: 'Payments', value: String(list.length), inline: true },
      { name: 'Total', value: totalOf(list) || 'Not given by PayPal', inline: true },
      ...(from && to ? [{ name: 'Checked', value: `${from} to ${to}`, inline: false }] : [])
    ],
    footerExtra: 'Daily PayPal check. Each payment is reported once.'
  };
}

module.exports = {
  PLATFORM_LABELS, ORDER_EVENTS, DISPUTE_REASONS, PAYMENT_CODE_WORDS, playerName, playerFields, orderIdOf, words,
  cardServer, orderStateWords,
  orderEventCard, customFlagCard, staffQueueMoveCard, adminCeilingCard,
  unpaidEndedCard, refusedPaymentCard, refusedActivationCard,
  revokedRenewalCard, renewalAfterRefundCard, duplicateSubscriptionCard,
  staffRevokeCard, refundUnknownCard, refundEventCard, refundFailedCard, disputeCard, unmatchedSaleCard,
  subscriptionEndedCard, closeSuspendedFailedCard,
  unbookedPaymentsCard, UNBOOKED_LIST_MAX
};

// Unfinished checkouts (decisions A3 and A4, 2026-10-20).
//
// In the 60 days to 2026-10-19, 118 checkouts were paid and 25 reached PayPal and
// never came back. Two jobs, run together every quarter hour from server.js:
//
//   1. expireAbandonedCheckouts: a pending order older than 48 hours becomes
//      'cancelled' with cancelled_reason 'expired'. Never an order with a payment
//      booked on it, never a cycle of a subscription that has paid (an active
//      subscription's renewal in flight), never anything but 'pending'. The status
//      is the one every reader already handles: no entitlement, no sync, the
//      custom-flag upload reaped, and fulfilment still rescues the row should the
//      payment land late (routes/shop.js fulfillOrder accepts a cancelled row; the
//      ACTIVATED webhook fulfils through it).
//
//   2. runFinishReminders: one "finish your purchase" email per order, an hour or
//      more after a live checkout that reached PayPal and is still pending, to the
//      account's own email only. A later attempt at the same product by the same
//      account supersedes an earlier one, so a buyer who starts again is not
//      emailed about the attempt they abandoned. finish_reminder_sent_at is
//      written BEFORE the send: a crash or a second process can cost a player the
//      email, never send it twice. Nothing else is in the email.
//
// Nothing runs on require: both functions take the database handle as a parameter
// so the tests use a throwaway copy of the real schema (test/checkouts.test.js).
const { SERVER_LABELS, SELLABLE_SERVER_IDS } = require('../gameServers');
const { DEFAULT_PERSONA } = require('../webAuth');
const saleWindow = require('../saleWindow');

const HOUR_S = 3600;
const REMIND_AFTER_S = 1 * HOUR_S;
const EXPIRE_AFTER_S = 48 * HOUR_S;
const RUN_EVERY_MS = 15 * 60 * 1000;
const FIRST_RUN_MS = 90 * 1000;
// A ceiling on one run's emails; the real number is a handful a day.
const MAX_PER_RUN = 50;

// Pending rows older than the cutoff with no payment booked and no paid sibling
// cycle. A row that never reached PayPal is included too: the five-minute sweeper
// normally takes those, and a 48-hour-old one is stale by any measure.
const EXPIRE_SELECT_SQL = `
  SELECT o.id, o.paypal_order_id, o.paypal_subscription_id
  FROM orders o
  WHERE o.status = 'pending'
    AND o.created_at < @cutoff
    AND o.paypal_capture_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM orders c
      WHERE o.paypal_subscription_id IS NOT NULL
        AND c.paypal_subscription_id = o.paypal_subscription_id
        AND c.status IN ('completed', 'refunded')
    )
  ORDER BY o.id ASC
`;

function expireAbandonedCheckouts(db, { now = nowS() } = {}) {
  const cutoff = now - EXPIRE_AFTER_S;
  const mark = db.prepare(`
    UPDATE orders SET status = 'cancelled', cancelled_reason = 'expired'
    WHERE id = ? AND status = 'pending' AND paypal_capture_id IS NULL
  `);
  const expired = db.transaction(() => {
    const rows = db.prepare(EXPIRE_SELECT_SQL).all({ cutoff });
    const done = [];
    for (const r of rows) {
      if (mark.run(r.id).changes) done.push(r.id);
    }
    return done;
  })();
  if (expired.length) console.log(`[checkouts] expired ${expired.length} unfinished checkout(s) older than 48 h: #${expired.join(', #')}`);
  return { now, cutoff, expired };
}

// Live, pending, reached PayPal, old enough, not yet expired, not yet reminded, on
// an account with an email, not a cycle of a paying subscription, and the account's
// latest attempt at that product.
const DUE_SQL = `
  SELECT o.id, o.steam_id, o.product_id, o.server_id, o.amount_cents, o.created_at, o.paypal_subscription_id,
         p.title AS product_title, p.currency, p.server_specific, p.active AS product_active,
         p.available_from, p.available_until,
         u.email, u.persona, u.gamertag, u.bi_uid_name
  FROM orders o
  JOIN products p ON p.id = o.product_id
  JOIN users u    ON u.steam_id = o.steam_id
  WHERE o.status = 'pending'
    AND o.test_mode = 0
    AND o.finish_reminder_sent_at IS NULL
    AND (o.paypal_order_id IS NOT NULL OR o.paypal_subscription_id IS NOT NULL)
    AND o.created_at <= @remindBefore
    AND o.created_at > @expireAfter
    AND u.email IS NOT NULL AND trim(u.email) != ''
    AND NOT EXISTS (
      SELECT 1 FROM orders c
      WHERE o.paypal_subscription_id IS NOT NULL
        AND c.paypal_subscription_id = o.paypal_subscription_id
        AND c.status IN ('completed', 'refunded')
    )
    AND NOT EXISTS (
      SELECT 1 FROM orders later
      WHERE later.steam_id = o.steam_id AND later.product_id = o.product_id
        AND later.id > o.id AND later.status IN ('pending', 'completed')
    )
  ORDER BY o.created_at ASC, o.id ASC
`;

function shopBase() {
  return (process.env.BASE_URL || 'https://reforgedz.net').replace(/\/+$/, '');
}

// Where "finish my purchase" goes: the product straight into checkout with the
// server already chosen (the shop's ?buy= link), or the shop front for a product
// that is off or not on sale now.
function restartFor(row, now, base = shopBase()) {
  const canRestart = !!row.product_active && saleWindow.onSale(row, now);
  if (!canRestart) return { canRestart: false, url: `${base}/shop` };
  const server = row.server_specific && SELLABLE_SERVER_IDS.includes(row.server_id) ? row.server_id : null;
  return { canRestart: true, url: `${base}/shop?buy=${encodeURIComponent(row.product_id)}${server ? '&server=' + encodeURIComponent(server) : ''}` };
}

// The name to greet a player by, or null (a website account is "Player" until its
// in-game name is known, which is no name at all).
function playerName(row) {
  const persona = row.persona && row.persona !== DEFAULT_PERSONA ? row.persona : null;
  return persona || row.gamertag || row.bi_uid_name || null;
}

function remindersOff(env = process.env) {
  return ['off', '0', 'false'].includes(String(env.FINISH_REMINDERS || '').trim().toLowerCase());
}

// What a run would send, and sends it unless dryRun. The summary holds order ids
// and counts only, never an email address.
async function runFinishReminders({ db, now = nowS(), send, dryRun = false, max = MAX_PER_RUN } = {}) {
  if (!db) throw new Error('runFinishReminders needs the database handle');
  const sendMail = send || ((payload) => require('../invoiceMail').sendFinishCheckout(payload));
  const out = { now, dryRun: !!dryRun, due: 0, sent: 0, failed: 0, counts: { alreadySent: 0, overCap: 0 }, items: [], skipped: [] };
  const rows = db.prepare(DUE_SQL).all({ remindBefore: now - REMIND_AFTER_S, expireAfter: now - EXPIRE_AFTER_S });
  out.due = rows.length;
  const claim = db.prepare('UPDATE orders SET finish_reminder_sent_at = ? WHERE id = ? AND finish_reminder_sent_at IS NULL AND status = \'pending\'');

  for (const row of rows) {
    if (out.items.length >= max) { out.counts.overCap += 1; out.skipped.push({ orderId: row.id, reason: 'overCap' }); continue; }
    const restart = restartFor(row, now);
    const item = { orderId: row.id, productId: row.product_id, serverId: row.server_specific ? row.server_id : null, kind: row.paypal_subscription_id ? 'subscription' : 'one_time', status: 'would_send' };
    out.items.push(item);
    if (dryRun) continue;
    if (!claim.run(now, row.id).changes) {
      out.items.pop();
      out.counts.alreadySent += 1;
      out.skipped.push({ orderId: row.id, reason: 'alreadySent' });
      continue;
    }
    let result;
    try {
      result = await sendMail({
        to: String(row.email).trim(),
        displayName: playerName(row),
        productTitle: row.product_title,
        serverLabel: row.server_specific && row.server_id ? (SERVER_LABELS[row.server_id] || String(row.server_id).toUpperCase()) : null,
        amountCents: row.amount_cents,
        currency: String(row.currency || 'USD').toUpperCase(),
        restartUrl: restart.url,
        canRestart: restart.canRestart
      });
    } catch (e) {
      result = { ok: false, error: e && e.message };
    }
    if (result && result.ok) { item.status = 'sent'; out.sent += 1; }
    else { item.status = 'failed'; out.failed += 1; }
  }
  if (!dryRun && (out.due || out.sent || out.failed)) {
    const line = `[checkouts] finish-purchase emails: ${out.due} due, ${out.sent} sent, ${out.failed} failed; skipped ${out.counts.alreadySent} already sent, ${out.counts.overCap} over the cap of ${max}`;
    if (out.failed || out.counts.overCap) console.error(line);
    else console.log(line);
  }
  return out;
}

// One tick: expire first, so nothing both expires and gets a reminder, then the
// emails. A copy with no mail server (a rehearsal blanks SMTP_HOST) would claim
// every reminder and send none, so without one the email step does nothing at all.
async function runScheduled() {
  const db = require('../db');
  expireAbandonedCheckouts(db);
  if (remindersOff()) return null;
  if (!process.env.SMTP_HOST) return null;
  return runFinishReminders({ db });
}

let scheduled = false;
function scheduleCheckoutJobs() {
  if (scheduled) return;
  scheduled = true;
  const tick = () => runScheduled().catch(e => console.error('[checkouts] run failed:', e.message));
  setTimeout(tick, FIRST_RUN_MS);
  setInterval(tick, RUN_EVERY_MS);
  console.log(`[checkouts] unfinished checkouts expire after 48 h; finish-purchase emails ${remindersOff() ? 'off (FINISH_REMINDERS)' : 'after 1 h'}; every ${RUN_EVERY_MS / 60000} min`);
}

function nowS() { return Math.floor(Date.now() / 1000); }

module.exports = {
  expireAbandonedCheckouts, runFinishReminders, scheduleCheckoutJobs, restartFor, playerName, remindersOff,
  REMIND_AFTER_S, EXPIRE_AFTER_S, RUN_EVERY_MS, MAX_PER_RUN
};

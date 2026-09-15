// The "your priority queue ends soon" email (plan J5).
//
// Many live priority queue subscriptions are cancelled but still paid up, and
// nothing told those players before their queue priority simply stopped. Many cancel straight after buying, using the subscription as a
// one-off, and would have bought again if asked. So once a day this emails
// players whose priority queue ends in 48 to 72 hours and will not renew: a
// subscription they cancelled, or a one-time purchase. The link goes to the shop
// with the same product and server ready to buy, never to a sign-in, because
// the email goes to the PayPal payer address, which is not necessarily the
// account's.
//
// Once a day at 15:00 UTC, scheduled from server.js next to the backup and the
// health card. EXPIRY_REMINDERS=off turns it off. Nothing runs on require: the
// scheduler loads the database only when a run starts, and runExpiryReminders
// takes the handle as a parameter so the tests can use a throwaway copy
// (test/reminders.test.js).
const { SERVER_LABELS, SELLABLE_SERVER_IDS } = require('../gameServers');
const { DEFAULT_PERSONA } = require('../webAuth');

const DAILY_UTC = { hour: 15, minute: 0 };
const HOUR_S = 3600;
// A 24-hour window a daily run moves through exactly once, so each paid-up
// period gets one chance at a reminder two to three days before it ends.
const WINDOW_FROM_S = 48 * HOUR_S;
const WINDOW_TO_S = 72 * HOUR_S;
// A ceiling on one run. The daily number is a handful; if a bug ever matched
// every order, this is how many players could be emailed before anyone noticed.
const MAX_PER_RUN = 50;

// Completed, live-mode priority queue orders whose paid-up period ends inside
// the window and will not renew: a PayPal subscription marked cancelled, or an
// order that belongs to no subscription (a one-time purchase). For a
// subscription only its newest cycle counts: older cycles keep the end dates of
// their own months, and a tie on the end date goes to the higher order id, so a
// subscription is never reminded twice.
const DUE_SQL = `
  SELECT o.id, o.steam_id, o.product_id, o.server_id, o.effective_until, o.payer_email,
         o.paypal_subscription_id, o.subscription_cancelled_at,
         p.title AS product_title, p.server_specific, p.active AS product_active,
         u.persona, u.gamertag, u.bi_uid_name
  FROM orders o
  JOIN products p ON p.id = o.product_id
  JOIN users u    ON u.steam_id = o.steam_id
  WHERE o.status = 'completed'
    AND o.test_mode = 0
    AND p.grants_priority_queue = 1
    AND o.effective_until IS NOT NULL
    AND o.effective_until >= ? AND o.effective_until < ?
    AND (
      (o.paypal_subscription_id IS NOT NULL AND o.subscription_cancelled_at IS NOT NULL)
      OR (o.paypal_subscription_id IS NULL AND o.stripe_subscription_id IS NULL)
    )
    AND NOT EXISTS (
      SELECT 1 FROM orders later
      WHERE o.paypal_subscription_id IS NOT NULL
        AND later.paypal_subscription_id = o.paypal_subscription_id
        AND later.id != o.id
        AND later.status = 'completed'
        AND (later.effective_until IS NULL
             OR later.effective_until > o.effective_until
             OR (later.effective_until = o.effective_until AND later.id > o.id))
    )
  ORDER BY o.effective_until ASC, o.id ASC
`;

// A failing renewal is its own conversation: PayPal is retrying and the player
// has had the payment-failed email, so "ends soon, buy again" would contradict it.
const OPEN_ISSUE_SQL = `
  SELECT 1 FROM subscription_billing_issues
  WHERE paypal_subscription_id = ? AND resolved_at IS NULL
  LIMIT 1
`;

// Whether the same account keeps queue priority on that server anyway, through
// another order: a subscription still billing, or any order whose period runs
// past this one's end (a lifetime one-time purchase included). Test-mode orders
// count here because the game-server sync counts them too. A subscription not
// tied to a server covers every server; a one-server order does not cover an
// order for every server.
const STILL_COVERED_SQL = `
  SELECT 1 FROM orders o2
  JOIN products p2 ON p2.id = o2.product_id
  WHERE o2.steam_id = ?
    AND o2.id != ?
    AND o2.status = 'completed'
    AND p2.grants_priority_queue = 1
    AND (? IS NULL OR o2.paypal_subscription_id IS NULL OR o2.paypal_subscription_id != ?)
    AND (COALESCE(p2.server_specific, 0) = 0 OR (? = 1 AND o2.server_id = ?))
    AND (
      (o2.paypal_subscription_id IS NOT NULL
        AND o2.subscription_cancelled_at IS NULL AND o2.subscription_ended_reason IS NULL
        AND (o2.effective_until IS NULL OR o2.effective_until > ?))
      OR o2.effective_until IS NULL
      OR o2.effective_until > ?
    )
  LIMIT 1
`;

// The payer email of the subscription's most recent order that has one: a
// renewal can come from a different PayPal address than the first payment.
const SUB_EMAIL_SQL = `
  SELECT payer_email FROM orders
  WHERE paypal_subscription_id = ? AND payer_email IS NOT NULL AND trim(payer_email) != ''
  ORDER BY COALESCE(completed_at, created_at) DESC, id DESC
  LIMIT 1
`;

function remindersOff(env = process.env) {
  return ['off', '0', 'false'].includes(String(env.EXPIRY_REMINDERS || '').trim().toLowerCase());
}

function shopBase() {
  return (process.env.BASE_URL || 'https://reforgedz.net').replace(/\/+$/, '');
}

// The shop's own "Start again" link (public/account.html, public/shop.js): the
// product opens in checkout with the server already chosen. A product no longer
// on sale gets the shop front instead, where its replacement is.
function restartUrlFor(row, base = shopBase()) {
  if (!row.product_active) return `${base}/shop`;
  const server = row.server_specific && SELLABLE_SERVER_IDS.includes(row.server_id) ? row.server_id : null;
  return `${base}/shop?buy=${encodeURIComponent(row.product_id)}${server ? '&server=' + encodeURIComponent(server) : ''}`;
}

// The name to greet a player by, or null. A website account is "Player" until
// its in-game name is known, which is no name at all.
function playerName(row) {
  const persona = row.persona && row.persona !== DEFAULT_PERSONA ? row.persona : null;
  return persona || row.gamertag || row.bi_uid_name || null;
}

function payerEmailFor(db, row) {
  const own = typeof row.payer_email === 'string' && row.payer_email.trim() ? row.payer_email.trim() : null;
  if (!row.paypal_subscription_id) return own;
  const latest = db.prepare(SUB_EMAIL_SQL).get(row.paypal_subscription_id);
  return latest ? String(latest.payer_email).trim() : own;
}

// What a run would send, and sends it unless dryRun. Resolves to a summary with
// order ids, dates and counts only, never an email address, so the admin preview
// can show it as it is.
//
// At most once: the reminder_sent row is written BEFORE the email goes, so a
// crash, a failed send or a second process can cost a player their reminder but
// can never send it twice. A period staff extend gets a new end date, and so its
// own reminder.
async function runExpiryReminders({ db, now = Math.floor(Date.now() / 1000), send, dryRun = false, max = MAX_PER_RUN } = {}) {
  if (!db) throw new Error('runExpiryReminders needs the database handle');
  const sendMail = send || ((payload) => require('../invoiceMail').sendPriorityQueueEnding(payload));
  const from = now + WINDOW_FROM_S;
  const to = now + WINDOW_TO_S;
  const out = {
    now, windowStart: from, windowEnd: to, dryRun: !!dryRun,
    due: 0, sent: 0, failed: 0,
    counts: { alreadySent: 0, billingIssue: 0, stillCovered: 0, noEmail: 0, overCap: 0 },
    items: [], skipped: []
  };

  const rows = db.prepare(DUE_SQL).all(from, to);
  out.due = rows.length;
  const sentBefore = db.prepare('SELECT 1 FROM reminder_sent WHERE order_id = ? AND effective_until = ?');
  const openIssue = db.prepare(OPEN_ISSUE_SQL);
  const stillCovered = db.prepare(STILL_COVERED_SQL);
  const claim = db.prepare('INSERT OR IGNORE INTO reminder_sent (order_id, effective_until, sent_at) VALUES (?, ?, ?)');

  const skip = (row, reason) => {
    out.counts[reason] += 1;
    out.skipped.push({ orderId: row.id, effectiveUntil: row.effective_until, reason });
  };

  for (const row of rows) {
    if (sentBefore.get(row.id, row.effective_until)) { skip(row, 'alreadySent'); continue; }
    if (row.paypal_subscription_id && openIssue.get(row.paypal_subscription_id)) { skip(row, 'billingIssue'); continue; }
    const sub = row.paypal_subscription_id || null;
    const specific = row.server_specific ? 1 : 0;
    if (stillCovered.get(row.steam_id, row.id, sub, sub, specific, row.server_id, now, row.effective_until)) {
      skip(row, 'stillCovered'); continue;
    }
    const email = payerEmailFor(db, row);
    if (!email) { skip(row, 'noEmail'); continue; }
    if (out.items.length >= max) { skip(row, 'overCap'); continue; }

    const item = {
      orderId: row.id,
      effectiveUntil: row.effective_until,
      serverId: row.server_specific ? row.server_id : null,
      productId: row.product_id,
      kind: row.paypal_subscription_id ? 'cancelled_subscription' : 'one_time',
      status: 'would_send'
    };
    out.items.push(item);
    if (dryRun) continue;

    if (!claim.run(row.id, row.effective_until, now).changes) {
      // Another run claimed it between the check above and here.
      out.items.pop();
      skip(row, 'alreadySent');
      continue;
    }
    let result;
    try {
      result = await sendMail({
        to: email,
        displayName: playerName(row),
        productTitle: row.product_title,
        serverLabel: row.server_specific && row.server_id ? (SERVER_LABELS[row.server_id] || String(row.server_id).toUpperCase()) : null,
        endsAt: row.effective_until,
        restartUrl: restartUrlFor(row)
      });
    } catch (e) {
      result = { ok: false, error: e && e.message };
    }
    if (result && result.ok) { item.status = 'sent'; out.sent += 1; }
    else { item.status = 'failed'; out.failed += 1; }
  }

  if (!dryRun) {
    const c = out.counts;
    const line = `[reminders] priority queue ending: ${out.due} due, ${out.sent} sent, ${out.failed} failed; skipped ${c.alreadySent} already sent, ${c.billingIssue} billing issue, ${c.stillCovered} still covered, ${c.noEmail} no email, ${c.overCap} over the cap of ${max}`;
    if (out.failed || c.overCap) console.error(line);
    else console.log(line);
  }
  return out;
}

// Unix seconds of the next scheduled run after `nowMs`.
function nextRunAt(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DAILY_UTC.hour, DAILY_UTC.minute, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return Math.floor(next.getTime() / 1000);
}

// A copy with no mail server (a rehearsal blanks SMTP_HOST) would claim every
// reminder and send none, so without one the run does nothing at all.
async function runScheduled() {
  if (!process.env.SMTP_HOST) {
    console.log('[reminders] no SMTP_HOST, so no reminder was sent or recorded');
    return null;
  }
  return runExpiryReminders({ db: require('../db') });
}

let scheduled = false;
function scheduleDailyReminders() {
  if (scheduled) return;
  scheduled = true;
  if (remindersOff()) {
    console.log('[reminders] priority queue ending emails are off (EXPIRY_REMINDERS)');
    return;
  }
  const arm = () => setTimeout(() => {
    runScheduled().catch(e => console.error('[reminders] daily run failed:', e.message)).finally(arm);
  }, Math.max(1000, nextRunAt() * 1000 - Date.now()));
  arm();
  console.log(`[reminders] priority queue ending emails daily at ${String(DAILY_UTC.hour).padStart(2, '0')}:${String(DAILY_UTC.minute).padStart(2, '0')} UTC`);
}

module.exports = {
  runExpiryReminders, scheduleDailyReminders, nextRunAt, remindersOff, restartUrlFor, playerName,
  WINDOW_FROM_S, WINDOW_TO_S, MAX_PER_RUN
};

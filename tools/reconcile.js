// The daily PayPal reconciliation: money PayPal took that the shop never booked.
//
// Every payment the shop books leaves its PayPal id on an order
// (orders.paypal_capture_id holds the capture of a one-time purchase and the sale
// of each subscription cycle), and the webhook paths that deliberately book
// nothing record the payment instead (revoked_renewals, unmatched_sales, and
// refunds and disputes in paypal_refunds and paypal_disputes). A payment in none
// of those reached nobody: its webhook never arrived, or a path dropped it. The
// webhooks cannot catch that themselves, because the missing event IS the problem.
//
// So once a day at 08:30 UTC, half an hour before the health card, this reads the
// last three days of PayPal Transaction Search and posts ONE red card listing each
// successful incoming payment nothing in the shop accounts for. reconcile_seen
// remembers what was reported, so each payment reaches staff once.
//
// Scheduled from server.js next to the other daily jobs. RECONCILE=off turns it
// off, and a copy without live PayPal credentials checks nothing. Staff can see
// what a run would report, with nothing posted or recorded, at
// GET /api/shop/admin/reconcile/preview. Nothing runs on require: runReconcile
// takes the database, the PayPal client and the poster as parameters, so
// test/reconcile.test.js drives it with fakes.

const cards = require('../paymentCards');
const paymentEvents = require('../paymentEvents');

const HOUR = 3600;
const DAY = 86400;
const DAILY_UTC = { hour: 8, minute: 30 };
// Three days: every payment falls inside the window of at least two daily runs,
// so one missed run (a restart across 08:30, a PayPal outage) loses nothing.
const LOOKBACK_S = 3 * DAY;
// Transaction Search shows a payment some hours after it happens, and PayPal keeps
// retrying a webhook that failed. A payment younger than this is left to the next
// run, which still covers it, instead of being reported while its webhook may yet
// book it.
const SETTLE_S = 6 * HOUR;
const PAGE_SIZE = 500;
// Three days are a page or two. Far more means something is wrong, and a partial
// list must never read as the whole picture, so the run stops instead.
const MAX_PAGES = 20;

const nowUnix = () => Math.floor(Date.now() / 1000);

function unixOf(t) {
  if (!t) return null;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

// Money received. A PayPal account's transactions include much that is not a
// payment received (money sent, holds and releases, conversions, refunds), so
// only a successful payment in the T00 group with a positive amount counts.
function isIncomingPayment(detail) {
  const info = detail && detail.transaction_info;
  if (!info || !info.transaction_id) return false;
  if (!/^T00\d\d$/.test(String(info.transaction_event_code || ''))) return false;
  if (String(info.transaction_status || '').toUpperCase() !== 'S') return false;
  const v = parseFloat(info.transaction_amount && info.transaction_amount.value);
  return Number.isFinite(v) && v > 0;
}

// The parts of one transaction a staff card may show. Reads transaction_info only;
// a payer block, if PayPal ever sent one, is never looked at.
function paymentOf(detail) {
  const info = (detail && detail.transaction_info) || {};
  const amt = info.transaction_amount || {};
  const v = parseFloat(amt.value);
  const ref = typeof info.paypal_reference_id === 'string' ? info.paypal_reference_id : '';
  const custom = String(info.custom_field == null ? '' : info.custom_field).trim();
  const named = /^\d{1,9}$/.test(custom) ? parseInt(custom, 10) : null;
  return {
    transactionId: String(info.transaction_id),
    code: info.transaction_event_code ? String(info.transaction_event_code) : null,
    amountCents: Number.isFinite(v) ? Math.round(Math.abs(v) * 100) : null,
    currency: String(amt.currency_code || 'USD').toUpperCase(),
    at: unixOf(info.transaction_initiation_date),
    // A subscription payment refers to its billing agreement, I-...
    subscriptionId: /^I-[A-Z0-9]+$/i.test(ref) ? ref : null,
    invoiceId: info.invoice_id ? String(info.invoice_id).slice(0, 64) : null,
    // The shop sets custom_id to its own order id; anything else is not shown.
    orderId: named && named > 0 ? named : null
  };
}

// A payment the shop could have taken: a subscription payment (T0002) or a
// Checkout capture (T0006), or any payment carrying something only a sale has (a
// billing agreement, a numeric custom id, an invoice id). Money received that is
// not shape of a sale is never posted to a staff channel; the admin preview lists
// it, so nothing is hidden from staff who look.
const SHOP_PAYMENT_CODES = new Set(['T0002', 'T0006']);
function isShopPayment(p) {
  return !!p && (SHOP_PAYMENT_CODES.has(p.code) || !!p.subscriptionId || !!p.orderId || !!p.invoiceId);
}

// Where the shop already accounts for a PayPal payment id, if anywhere.
const KNOWN_SQL = `
  SELECT 'order' AS src FROM orders WHERE paypal_capture_id = @id
  UNION ALL SELECT 'revoked_renewal' FROM revoked_renewals WHERE sale_id = @id
  UNION ALL SELECT 'unmatched_sale' FROM unmatched_sales WHERE sale_id = @id
  UNION ALL SELECT 'refund' FROM paypal_refunds WHERE payment_id = @id
  UNION ALL SELECT 'dispute' FROM paypal_disputes WHERE payment_id = @id
  LIMIT 1
`;

function reconcileOff(env = process.env) {
  return ['off', '0', 'false'].includes(String(env.RECONCILE || '').trim().toLowerCase());
}

// Unix seconds of the next scheduled run after `nowMs`.
function nextRunAt(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DAILY_UTC.hour, DAILY_UTC.minute, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return Math.floor(next.getTime() / 1000);
}

const errorText = (e) => String((e && e.message) || e).slice(0, 200);

// One run. Resolves to a summary with PayPal transaction ids, amounts and dates
// only. dryRun (the preview) reads PayPal and the database and neither posts nor
// records. post(spec) sends the card and resolves to { ok } (default:
// discordCard.sendCard).
//
// A failed PayPal page stops the whole run with nothing posted: payments missing
// from a partial read would look accounted for.
//
// The card is posted first and the ids are recorded only once Discord accepted it.
// That is the opposite order from the reminder emails, on purpose: a lost staff
// alert about money is worse than the same alert twice.
async function runReconcile({ db, paypal, now = nowUnix(), post = null, dryRun = false, logger = console } = {}) {
  if (!db) throw new Error('runReconcile needs the database handle');
  if (!paypal) throw new Error('runReconcile needs the PayPal client');
  const out = {
    ranAt: now, dryRun: !!dryRun, ok: false, skipped: null, error: null,
    windowStart: now - LOOKBACK_S, windowEnd: now - SETTLE_S, lastRefreshed: null,
    pages: 0, rows: 0, incoming: 0,
    booked: { order: 0, revoked_renewal: 0, unmatched_sale: 0, refund: 0, dispute: 0 },
    unbooked: [], alreadyReported: [], otherIncoming: [], reported: 0, posted: null
  };
  if (typeof paypal.isConfigured === 'function' && !paypal.isConfigured(false)) {
    out.skipped = 'live PayPal is not configured';
    return out;
  }

  const details = [];
  try {
    let totalPages = 1;
    for (let page = 1; page <= totalPages; page++) {
      const res = await paypal.searchTransactions(false, {
        start: out.windowStart * 1000, end: out.windowEnd * 1000, page, pageSize: PAGE_SIZE,
        transactionStatus: 'S', fields: 'transaction_info'
      });
      if (!res || !Array.isArray(res.transaction_details)) throw new Error(`page ${page} came back without a transaction list`);
      details.push(...res.transaction_details);
      out.pages = page;
      if (res.last_refreshed_datetime) out.lastRefreshed = String(res.last_refreshed_datetime);
      totalPages = Math.max(1, parseInt(res.total_pages, 10) || 1);
      if (totalPages > MAX_PAGES) throw new Error(`PayPal reports ${totalPages} pages, more than the ${MAX_PAGES} a run reads`);
    }
  } catch (e) {
    out.error = errorText(e);
    logger.error(`[reconcile] PayPal transaction search failed, so no payment was checked or reported: ${out.error}`);
    return out;
  }
  out.rows = details.length;

  try {
    const payments = new Map();
    for (const d of details) {
      if (!isIncomingPayment(d)) continue;
      const p = paymentOf(d);
      if (!payments.has(p.transactionId)) payments.set(p.transactionId, p);
    }
    out.incoming = payments.size;
    const known = db.prepare(KNOWN_SQL);
    const seen = db.prepare('SELECT reported_at FROM reconcile_seen WHERE transaction_id = ?');
    for (const p of payments.values()) {
      const k = known.get({ id: p.transactionId });
      if (k) { out.booked[k.src] += 1; continue; }
      if (!isShopPayment(p)) { out.otherIncoming.push(p); continue; }
      const r = seen.get(p.transactionId);
      if (r) { out.alreadyReported.push({ ...p, reportedAt: r.reported_at }); continue; }
      // A subscription's first payment whose sale event was lost: the checkout row is
      // completed and granting perks but holds no payment id. The card must not call
      // that money unbooked-and-ungranted, or staff set up a second order for it.
      const firstRow = p.subscriptionId ? paymentEvents.unpaidFirstCycleRow(db, p.subscriptionId) : null;
      const unattached = firstRow && paymentEvents.isFirstCycleSale(firstRow, p.at) ? firstRow.id : null;
      out.unbooked.push({ ...p, unattachedOrderId: unattached });
    }
  } catch (e) {
    out.error = `database: ${errorText(e)}`;
    out.unbooked = [];
    out.alreadyReported = [];
    out.otherIncoming = [];
    logger.error(`[reconcile] could not compare PayPal payments with the database, so nothing was reported: ${out.error}`);
    return out;
  }
  const byTime = (a, b) => ((a.at || 0) - (b.at || 0)) || a.transactionId.localeCompare(b.transactionId);
  out.unbooked.sort(byTime);
  out.alreadyReported.sort(byTime);
  out.otherIncoming.sort(byTime);
  out.ok = true;
  if (dryRun) return out;

  const others = out.otherIncoming.length
    ? `; ${out.otherIncoming.length} that are not shop sales were left out (the admin preview lists them)` : '';
  if (!out.unbooked.length) {
    logger.log(`[reconcile] ${out.incoming} incoming PayPal payment(s) in the last ${LOOKBACK_S / DAY} days, all shop payments accounted for${others}`);
    return out;
  }

  const spec = cards.unbookedPaymentsCard({ payments: out.unbooked, windowStart: out.windowStart, windowEnd: out.windowEnd });
  const send = post || ((s) => require('./lib/discordCard').sendCard(s));
  let posted;
  try {
    posted = await send(spec);
  } catch {
    posted = { ok: false, status: 0 };
  }
  out.posted = {
    ok: !!(posted && posted.ok),
    status: posted && posted.status != null ? posted.status : null,
    skipped: (posted && posted.skipped) || null
  };
  const ids = out.unbooked.map(p => p.transactionId).join(', ');
  if (!out.posted.ok) {
    logger.error(`[reconcile] ${out.unbooked.length} PayPal payment(s) booked by nothing in the shop, but the card was not posted${out.posted.skipped ? ` (${out.posted.skipped})` : ''}, so the next run reports them again: ${ids}`);
    return out;
  }
  try {
    const mark = db.prepare('INSERT OR IGNORE INTO reconcile_seen (transaction_id, reported_at) VALUES (?, ?)');
    db.transaction(() => {
      for (const p of out.unbooked) out.reported += mark.run(p.transactionId, now).changes;
    })();
  } catch (e) {
    logger.error(`[reconcile] card posted but not recorded, so the next run posts it again: ${errorText(e)}`);
  }
  logger.error(`[reconcile] ${out.unbooked.length} PayPal payment(s) booked by nothing in the shop, reported to staff: ${ids}`);
  return out;
}

// What the admin preview returns.
function previewOf(out) {
  return {
    ok: out.ok, skipped: out.skipped, error: out.error,
    windowStart: out.windowStart, windowEnd: out.windowEnd, lastRefreshed: out.lastRefreshed,
    pages: out.pages, incoming: out.incoming, booked: out.booked,
    wouldReport: out.unbooked.length, unbooked: out.unbooked, alreadyReported: out.alreadyReported,
    otherIncoming: out.otherIncoming
  };
}

// The last scheduled run in this process, for the health card. Previews do not count.
let lastRun = null;
function lastReconcileRun() { return lastRun; }

function summaryOf(out) {
  return {
    ranAt: out.ranAt, ok: out.ok, skipped: out.skipped, error: out.error,
    incoming: out.incoming, unbooked: out.unbooked.length, reported: out.reported,
    posted: out.posted ? out.posted.ok : null
  };
}

async function runScheduled() {
  const out = await runReconcile({ db: require('../db'), paypal: require('../paypal') });
  lastRun = summaryOf(out);
  if (out.skipped) console.log(`[reconcile] ${out.skipped}, so no payment was checked`);
  return out;
}

let scheduled = false;
function scheduleDailyReconcile() {
  if (scheduled) return;
  scheduled = true;
  if (reconcileOff()) {
    console.log('[reconcile] the daily PayPal check is off (RECONCILE)');
    return;
  }
  const arm = () => setTimeout(() => {
    runScheduled().catch((e) => {
      lastRun = { ranAt: nowUnix(), ok: false, skipped: null, error: errorText(e), incoming: 0, unbooked: 0, reported: 0, posted: null };
      console.error('[reconcile] daily run failed:', e.message);
    }).finally(arm);
  }, Math.max(1000, nextRunAt() * 1000 - Date.now()));
  arm();
  console.log(`[reconcile] PayPal payments checked against orders daily at ${String(DAILY_UTC.hour).padStart(2, '0')}:${String(DAILY_UTC.minute).padStart(2, '0')} UTC`);
}

module.exports = {
  runReconcile, scheduleDailyReconcile, lastReconcileRun, reconcileOff, nextRunAt, previewOf,
  isIncomingPayment, isShopPayment, paymentOf, LOOKBACK_S, SETTLE_S, PAGE_SIZE, MAX_PAGES
};

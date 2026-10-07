// VAT evidence: which country each paying buyer is in, from two independent sources.
//
// A seller outside the EU owes VAT on digital sales to EU and UK consumers from the
// first sale, at the buyer's country's rate, and must hold two pieces of evidence of
// that country that do not contradict each other. The shop records:
//   orders.ip_country     where the browser was when checkout started (Cloudflare's
//                         CF-IPCountry header; a renewal carries its checkout's value)
//   orders.payer_country  the country PayPal holds for the payer, read from
//                         Transaction Search once a day
// Only the two-letter code is kept. The payer block PayPal returns also holds a name
// and an email; neither is read or stored here.
//
// buildVatReport turns those into the quarter's totals per country and lists every
// payment whose two sources disagree or are missing, for a person to settle.
//
// Takes the database and the PayPal client as parameters and does nothing on
// require, so test/vat.test.js drives it with the real schema and a fake PayPal.

const { vatFor, vatIncludedCents, RATES_CHECKED } = require('./vatRates');

const DAY = 86400;
const HOUR = 3600;
const DAILY_UTC = { hour: 8, minute: 40 };
// The same window as the daily reconciliation: every payment is seen by at least two
// runs, and one younger than SETTLE_S is left to the next run, while Transaction
// Search may not show it yet.
const LOOKBACK_S = 3 * DAY;
const SETTLE_S = 6 * HOUR;
const PAGE_SIZE = 500;
const MAX_PAGES = 20;
// PayPal answers at most 31 days per Transaction Search call.
const MAX_WINDOW_S = 31 * DAY;

// Codes that look like a country but are not one: Cloudflare's unknown (XX) and Tor
// (T1), and the old reserved and regional codes some geolocation feeds use.
const NOT_A_COUNTRY = new Set(['XX', 'T1', 'ZZ', 'EU', 'AP', 'A1', 'A2', 'O1']);

function normalizeCountry(v) {
  const c = String(v == null ? '' : v).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || NOT_A_COUNTRY.has(c)) return null;
  return c;
}

// Cloudflare adds CF-IPCountry to every request it proxies (IP Geolocation), so the
// browser's country arrives with the checkout request itself.
function ipCountryOf(req) {
  const h = req && req.headers ? req.headers['cf-ipcountry'] : null;
  return normalizeCountry(Array.isArray(h) ? h[0] : h);
}

// PayPal's country for the payer of one Transaction Search row. The code only.
function payerCountryOf(detail) {
  const p = detail && detail.payer_info;
  if (!p) return null;
  return normalizeCountry(p.country_code || (p.address && p.address.country_code));
}

const errorText = (e) => String((e && e.message) || e).slice(0, 200);
const nowUnix = () => Math.floor(Date.now() / 1000);

// Fill orders.payer_country for the payments PayPal lists in [start, end] (unix
// seconds, at most 31 days). Only rows with no country yet are written, so a run can
// be repeated safely. A failed page stops the run; rows filled before it stay filled,
// because each one is true on its own.
async function fillPayerCountries({ db, paypal, start, end, dryRun = false, logger = console } = {}) {
  if (!db) throw new Error('fillPayerCountries needs the database handle');
  if (!paypal) throw new Error('fillPayerCountries needs the PayPal client');
  const out = { start, end, dryRun: !!dryRun, pages: 0, rows: 0, withCountry: 0, filled: 0, error: null, skipped: null };
  if (!(end > start)) { out.error = 'the window is empty'; return out; }
  if (end - start > MAX_WINDOW_S) { out.error = 'PayPal answers at most 31 days per call'; return out; }
  if (typeof paypal.isConfigured === 'function' && !paypal.isConfigured(false)) {
    out.skipped = 'live PayPal is not configured';
    return out;
  }
  // A dry run counts the rows a real run would fill and writes nothing.
  const fill = dryRun
    ? (() => { const q = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE paypal_capture_id = ? AND payer_country IS NULL AND test_mode = 0'); return { run: (_c, id) => ({ changes: q.get(id).n }) }; })()
    : db.prepare('UPDATE orders SET payer_country = ? WHERE paypal_capture_id = ? AND payer_country IS NULL AND test_mode = 0');
  try {
    let totalPages = 1;
    for (let page = 1; page <= totalPages; page++) {
      const res = await paypal.searchTransactions(false, {
        start: start * 1000, end: end * 1000, page, pageSize: PAGE_SIZE,
        transactionStatus: 'S', fields: 'transaction_info,payer_info'
      });
      if (!res || !Array.isArray(res.transaction_details)) throw new Error(`page ${page} came back without a transaction list`);
      out.pages = page;
      totalPages = Math.max(1, parseInt(res.total_pages, 10) || 1);
      if (totalPages > MAX_PAGES) throw new Error(`PayPal reports ${totalPages} pages, more than the ${MAX_PAGES} a run reads`);
      for (const d of res.transaction_details) {
        const id = d && d.transaction_info && d.transaction_info.transaction_id;
        if (!id) continue;
        out.rows += 1;
        const country = payerCountryOf(d);
        if (!country) continue;
        out.withCountry += 1;
        out.filled += fill.run(country, String(id)).changes;
      }
    }
  } catch (e) {
    out.error = errorText(e);
    logger.error(`[vat] PayPal transaction search failed: ${out.error}`);
  }
  return out;
}

// [start, end] cut into PayPal-sized windows (31 days at most), oldest first, for a
// backfill over months (tools/vatBackfill.js).
function windowsBetween(start, end, size = MAX_WINDOW_S) {
  const out = [];
  for (let s = start; s < end; s += size) out.push({ start: s, end: Math.min(end, s + size) });
  return out;
}

// The daily run: the last three days, as the reconciliation reads them.
async function runDailyFill({ db, paypal, now = nowUnix(), logger = console } = {}) {
  const out = await fillPayerCountries({ db, paypal, start: now - LOOKBACK_S, end: now - SETTLE_S, logger });
  if (!out.error && !out.skipped) {
    logger.log(`[vat] payer country recorded for ${out.filled} payment(s); ${out.withCountry} of ${out.rows} PayPal rows carried one`);
  }
  return out;
}

function vatOff(env = process.env) {
  return ['off', '0', 'false'].includes(String(env.VAT_EVIDENCE || '').trim().toLowerCase());
}

// Unix seconds of the next scheduled run after nowMs.
function nextRunAt(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DAILY_UTC.hour, DAILY_UTC.minute, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return Math.floor(next.getTime() / 1000);
}

// Daily at 08:40 UTC, ten minutes after the reconciliation. VAT_EVIDENCE=off turns
// it off. Scheduled from server.js; nothing runs on require.
function scheduleDailyFill({ db, paypal, logger = console } = {}) {
  if (vatOff()) {
    logger.log('[vat] daily payer-country fill is off (VAT_EVIDENCE=off)');
    return null;
  }
  let timer = null;
  const arm = () => {
    const wait = Math.max(1000, nextRunAt() * 1000 - Date.now());
    timer = setTimeout(async () => {
      try { await runDailyFill({ db, paypal, logger }); } catch (e) { logger.error(`[vat] daily fill failed: ${errorText(e)}`); }
      arm();
    }, wait);
    if (timer.unref) timer.unref();
  };
  arm();
  logger.log(`[vat] daily payer-country fill at ${String(DAILY_UTC.hour).padStart(2, '0')}:${String(DAILY_UTC.minute).padStart(2, '0')} UTC`);
  return () => timer && clearTimeout(timer);
}

// '2026Q4' -> { start, end } unix seconds, end exclusive. null when malformed.
function quarterBounds(quarter) {
  const m = /^(\d{4})Q([1-4])$/.exec(String(quarter || '').trim().toUpperCase());
  if (!m) return null;
  const y = Number(m[1]);
  const q = Number(m[2]);
  const start = Date.UTC(y, (q - 1) * 3, 1) / 1000;
  const end = q === 4 ? Date.UTC(y + 1, 0, 1) / 1000 : Date.UTC(y, q * 3, 1) / 1000;
  return { start, end };
}

// How well the two sources back each other up.
function evidenceOf(payer, ip) {
  if (payer && ip) return payer === ip ? 'match' : 'conflict';
  if (payer) return 'payer-only';
  if (ip) return 'ip-only';
  return 'none';
}

// The quarter's VAT position. Kept payments only: live, completed, not refunded,
// counted in the quarter they completed. The country is PayPal's when it has one
// (the billing account), else the checkout's. Amounts are in the currency the shop
// sells in (USD); a One Stop Shop return is filed in euros at the ECB rate of the
// quarter's last day, which this report does not fetch.
function buildVatReport(db, { quarter } = {}) {
  const b = quarterBounds(quarter);
  if (!b) throw new Error('quarter must look like 2026Q4');
  const rows = db.prepare(`
    SELECT o.id, o.amount_cents, o.completed_at, o.payer_country, o.ip_country,
      (SELECT f.ip_country FROM orders f
        WHERE o.paypal_subscription_id IS NOT NULL AND f.paypal_subscription_id = o.paypal_subscription_id
          AND f.ip_country IS NOT NULL ORDER BY f.id LIMIT 1) AS checkout_ip_country
    FROM orders o
    WHERE o.status = 'completed' AND o.test_mode = 0 AND o.amount_cents > 0
      AND o.completed_at >= ? AND o.completed_at < ?
    ORDER BY o.id
  `).all(b.start, b.end);

  const byCountry = new Map();
  const totals = { 'EU-OSS': { orders: 0, grossCents: 0, vatCents: 0 }, UK: { orders: 0, grossCents: 0, vatCents: 0 }, none: { orders: 0, grossCents: 0 } };
  const unknown = { orders: 0, grossCents: 0 };
  const review = [];
  for (const r of rows) {
    const payer = normalizeCountry(r.payer_country);
    const ip = normalizeCountry(r.ip_country) || normalizeCountry(r.checkout_ip_country);
    const evidence = evidenceOf(payer, ip);
    const country = payer || ip;
    if (evidence === 'conflict' || evidence === 'none') review.push({ orderId: r.id, payerCountry: payer, ipCountry: ip, evidence });
    if (!country) {
      unknown.orders += 1;
      unknown.grossCents += r.amount_cents;
      continue;
    }
    const { scheme, rate } = vatFor(country);
    let c = byCountry.get(country);
    if (!c) {
      c = { country, scheme, rate, orders: 0, grossCents: 0, vatCents: 0, evidence: { match: 0, conflict: 0, 'payer-only': 0, 'ip-only': 0 } };
      byCountry.set(country, c);
    }
    c.orders += 1;
    c.grossCents += r.amount_cents;
    c.evidence[evidence] += 1;
  }
  for (const c of byCountry.values()) {
    // VAT is worked out on each country's total, the way a return reports it.
    c.vatCents = vatIncludedCents(c.grossCents, c.rate);
    const t = totals[c.scheme];
    t.orders += c.orders;
    t.grossCents += c.grossCents;
    if (c.scheme !== 'none') t.vatCents += c.vatCents;
  }
  const list = [...byCountry.values()].sort((a, z) => (z.grossCents - a.grossCents) || a.country.localeCompare(z.country));
  return {
    quarter: String(quarter).trim().toUpperCase(),
    from: new Date(b.start * 1000).toISOString(),
    to: new Date(b.end * 1000).toISOString(),
    currency: 'USD',
    ratesChecked: RATES_CHECKED,
    orders: rows.length,
    grossCents: rows.reduce((s, r) => s + r.amount_cents, 0),
    byCountry: list,
    totals,
    unknown,
    review,
    notes: [
      'Prices include VAT, so the VAT shown is the part of each gross amount the rate makes up.',
      `Rates were checked on ${RATES_CHECKED}; check them against the EU tax database and GOV.UK before filing.`,
      'Refunded orders are left out. A refund after a quarter was filed is corrected in a later return.',
      'A conflict or a missing country needs a third piece of evidence (or a person\'s decision) before filing.'
    ]
  };
}

module.exports = {
  normalizeCountry, ipCountryOf, payerCountryOf, fillPayerCountries, runDailyFill, scheduleDailyFill,
  nextRunAt, vatOff, quarterBounds, evidenceOf, buildVatReport, windowsBetween, MAX_WINDOW_S
};

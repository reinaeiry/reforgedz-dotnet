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

// The quarter's VAT position, the way the returns are made up:
//   sales        every paid live sale, counted in the quarter it was paid, whatever
//                happened to it later (a staff revoke that kept the money stays a sale);
//   refunds      every refund and chargeback reversal PayPal reported (never one that
//                failed), in the quarter it happened, against the sale's country. A
//                refunded order with no refund on record (refunds before 2026-09-15 were
//                not recorded) is netted out in its own sale's quarter, and counted.
//   corrections  an EU refund of a sale from an EARLIER quarter stays out of this
//                quarter's figures: the One Stop Shop corrects that quarter, in the
//                correction part of a later return that names the period and the country
//                (Revenue's non-Union OSS manual 4.1). A UK refund counts in the quarter it
//                is paid (VAT Notice 700 18.2.6) at the VAT rate of the sale (18.2.5).
// The country is PayPal's when it has one (the billing account), else the checkout's.
// Every sale without two matching sources is listed for review: a seller outside the
// EU needs two pieces of evidence that agree.
// Amounts are in USD, the currency the shop sells in. Each return asks, per country, for
// the value excluding VAT and the VAT due, in its own currency, so the report adds both
// when given the rates, entered the way they are published (it fetches none):
//   usdPerEur         the ECB reference rate (US dollars per euro) of the quarter's last
//                     day, applied to the quarter's totals (Revenue's manual 4.3);
//   usdPerGbpByMonth  { 'YYYY-MM': US dollars per pound }: HMRC's monthly rate, each UK
//                     sale converted at its own month's rate (VAT Notice 700). A UK refund
//                     uses its SALE's month: the notice names no rate for a refund, so that
//                     is a choice to confirm with the accountant. A month without a rate is
//                     an error that names it, never 0.
const CHECKOUT_IP_SQL = `(SELECT f.ip_country FROM orders f
        WHERE o.paypal_subscription_id IS NOT NULL AND f.paypal_subscription_id = o.paypal_subscription_id
          AND f.ip_country IS NOT NULL ORDER BY f.id LIMIT 1)`;
// The refunds that gave money back. A refund PayPal later reported as failed keeps its
// row as kind 'refund_failed' (paymentEvents.js); that money was kept.
const MONEY_BACK_KINDS_SQL = "('refund', 'reversal')";

// A bad report request (an error the admin route answers with 400).
function badInput(message) {
  const e = new Error(message);
  e.code = 'BAD_INPUT';
  return e;
}
// US dollars per euro or per pound: both have stayed between 0.8 and 2.1 for decades.
// The band refuses a rate entered the wrong way up only when it falls outside it.
const isUsdRate = (r) => typeof r === 'number' && Number.isFinite(r) && r > 0.5 && r < 3;
const monthLabel = (unix) => new Date(unix * 1000).toISOString().slice(0, 7);
const quarterLabel = (unix) => {
  const d = new Date(unix * 1000);
  return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
};

// The admin route's query (?quarter=2027Q1&usdPerEur=1.16&usdPerGbp=2027-01:1.27,...)
// as buildVatReport's options. Only plain strings are read: Express turns ?gbp[x]=1 into
// an object, which String() or Number() would throw on.
function parseReportQuery(query = {}) {
  const text = (v, name) => {
    if (v == null || v === '') return null;
    if (typeof v !== 'string') throw badInput(`${name} must be given once, as text`);
    return v;
  };
  const quarter = text(query.quarter, 'quarter');
  const eur = text(query.usdPerEur, 'usdPerEur');
  const gbp = text(query.usdPerGbp, 'usdPerGbp');
  let usdPerGbpByMonth = null;
  if (gbp != null) {
    usdPerGbpByMonth = Object.create(null);
    for (const pair of gbp.split(',')) {
      const [month, rate, extra] = pair.split(':');
      if (extra !== undefined || rate === undefined) throw badInput('usdPerGbp must look like 2027-01:1.27,2027-02:1.26');
      const m = month.trim();
      if (Object.prototype.hasOwnProperty.call(usdPerGbpByMonth, m)) throw badInput(`usdPerGbp gives ${m} twice`);
      usdPerGbpByMonth[m] = Number(rate);
    }
  }
  return { quarter: quarter || '', usdPerEur: eur == null ? null : Number(eur), usdPerGbpByMonth: usdPerGbpByMonth && { ...usdPerGbpByMonth } };
}

function buildVatReport(db, { quarter, usdPerEur = null, usdPerGbpByMonth = null } = {}) {
  const b = quarterBounds(quarter);
  if (!b) throw badInput('quarter must look like 2026Q4');
  if (usdPerEur != null && !isUsdRate(usdPerEur)) throw badInput('usdPerEur must be the ECB rate in US dollars per euro, like 1.16');
  if (usdPerGbpByMonth != null) {
    const ok = typeof usdPerGbpByMonth === 'object'
      && Object.entries(usdPerGbpByMonth).every(([m, r]) => /^\d{4}-\d{2}$/.test(m) && isUsdRate(r));
    if (!ok) throw badInput('usdPerGbp must map YYYY-MM to US dollars per pound, like 2027-01:1.27');
  }
  const sales = db.prepare(`
    SELECT o.id, o.amount_cents, o.status, o.revoked_without_refund_at, o.payer_country, o.ip_country, o.completed_at,
      ${CHECKOUT_IP_SQL} AS checkout_ip_country,
      (SELECT COUNT(*) FROM paypal_refunds r WHERE r.order_id = o.id) AS refund_rows
    FROM orders o
    WHERE o.status IN ('completed', 'refunded') AND o.test_mode = 0 AND o.amount_cents > 0
      AND o.completed_at >= ? AND o.completed_at < ?
    ORDER BY o.id
  `).all(b.start, b.end);
  const refunds = db.prepare(`
    SELECT r.refund_id, r.amount_cents, r.kind, r.received_at, o.id AS order_id, o.amount_cents AS order_cents,
      o.completed_at AS sale_at, o.payer_country, o.ip_country, ${CHECKOUT_IP_SQL} AS checkout_ip_country
    FROM paypal_refunds r
    LEFT JOIN orders o ON o.id = r.order_id
    WHERE COALESCE(r.test_mode, 0) = 0 AND r.kind IN ${MONEY_BACK_KINDS_SQL}
      AND r.received_at >= ? AND r.received_at < ?
      AND (o.id IS NULL OR o.test_mode = 0)
    ORDER BY r.received_at, r.refund_id
  `).all(b.start, b.end);

  const byCountry = new Map();
  const corrections = new Map();
  const unknown = { orders: 0, salesCents: 0, refundCents: 0 };
  const review = [];
  let undatedRefunds = 0;
  const countryOf = (r) => {
    const payer = normalizeCountry(r.payer_country);
    const ip = normalizeCountry(r.ip_country) || normalizeCountry(r.checkout_ip_country);
    return { payer, ip, country: payer || ip, evidence: evidenceOf(payer, ip) };
  };
  const bucket = (country) => {
    let c = byCountry.get(country);
    if (!c) {
      const { scheme, rate } = vatFor(country);
      c = { country, scheme, rate, orders: 0, salesCents: 0, refundCents: 0, netCents: 0, vatCents: 0,
        evidence: { match: 0, conflict: 0, 'payer-only': 0, 'ip-only': 0 } };
      byCountry.set(country, c);
    }
    return c;
  };
  // UK sales and refunds in pence, each at its sale month's rate (country -> pence).
  const gbp = new Map();
  const missingMonths = new Set();
  const addGbp = (c, field, cents, saleAt) => {
    if (usdPerGbpByMonth == null || c.scheme !== 'UK') return;
    const rate = usdPerGbpByMonth[monthLabel(saleAt)];
    if (rate == null) { missingMonths.add(monthLabel(saleAt)); return; }
    const g = gbp.get(c.country) || { salesCents: 0, refundCents: 0 };
    g[field] += Math.round(cents / rate);
    gbp.set(c.country, g);
  };

  for (const r of sales) {
    const w = countryOf(r);
    if (w.evidence !== 'match') review.push({ orderId: r.id, payerCountry: w.payer, ipCountry: w.ip, evidence: w.evidence });
    // A refund with no record and no date: netted out in this, the sale's, quarter. Any
    // row counts as a record, a failed one too: a failed refund leaves the order marked
    // refunded although the money stayed (paymentEvents.applyRefundFailure).
    const undated = r.status === 'refunded' && r.revoked_without_refund_at == null && r.refund_rows === 0;
    if (undated) undatedRefunds += 1;
    if (!w.country) {
      unknown.orders += 1;
      unknown.salesCents += r.amount_cents;
      if (undated) unknown.refundCents += r.amount_cents;
      continue;
    }
    const c = bucket(w.country);
    c.orders += 1;
    c.salesCents += r.amount_cents;
    c.evidence[w.evidence] += 1;
    addGbp(c, 'salesCents', r.amount_cents, r.completed_at);
    if (undated) {
      c.refundCents += r.amount_cents;
      addGbp(c, 'refundCents', r.amount_cents, r.completed_at);
    }
  }
  for (const r of refunds) {
    const cents = r.amount_cents != null ? Math.abs(r.amount_cents) : r.order_cents;
    if (cents == null) {
      review.push({ refundId: r.refund_id, orderId: r.order_id, evidence: 'refund-without-amount' });
      continue;
    }
    const w = r.order_id == null ? { country: null } : countryOf(r);
    if (!w.country) {
      unknown.refundCents += cents;
      if (r.order_id == null) review.push({ refundId: r.refund_id, orderId: null, evidence: 'refund-without-order' });
      continue;
    }
    const { scheme, rate } = vatFor(w.country);
    if (scheme === 'EU-OSS' && r.sale_at != null && r.sale_at < b.start) {
      const period = quarterLabel(r.sale_at);
      const key = `${period}|${w.country}`;
      const x = corrections.get(key) || { period, country: w.country, scheme, rate, refunds: 0, refundCents: 0 };
      x.refunds += 1;
      x.refundCents += cents;
      corrections.set(key, x);
      continue;
    }
    const c = bucket(w.country);
    c.refundCents += cents;
    addGbp(c, 'refundCents', cents, r.sale_at != null ? r.sale_at : r.received_at);
  }
  if (missingMonths.size) {
    throw badInput(`usdPerGbp needs a rate for ${[...missingMonths].sort().join(', ')}`);
  }

  const totals = {
    'EU-OSS': { salesCents: 0, refundCents: 0, netCents: 0, vatCents: 0, exclusiveCents: 0 },
    UK: { salesCents: 0, refundCents: 0, netCents: 0, vatCents: 0, exclusiveCents: 0 },
    none: { salesCents: 0, refundCents: 0, netCents: 0 }
  };
  // What each return asks for, in its currency: null until the rate is given.
  const returnTotals = {
    'EU-OSS': usdPerEur != null ? { currency: 'EUR', exclusiveCents: 0, vatCents: 0 } : null,
    UK: usdPerGbpByMonth != null ? { currency: 'GBP', exclusiveCents: 0, vatCents: 0 } : null
  };
  for (const c of byCountry.values()) {
    c.netCents = c.salesCents - c.refundCents;
    // VAT is worked out on each country's net total, the way a return reports it; a UK
    // quarter whose refunds outweigh its sales shows a negative figure.
    c.vatCents = vatIncludedCents(c.netCents, c.rate);
    c.exclusiveCents = c.netCents - c.vatCents;
    c.returnFigures = null;
    // Converted once, then split, so the VAT is always the value times the rate.
    let net = null;
    if (c.scheme === 'EU-OSS' && usdPerEur != null) net = { currency: 'EUR', cents: Math.round(c.netCents / usdPerEur) };
    if (c.scheme === 'UK' && usdPerGbpByMonth != null) {
      const g = gbp.get(c.country) || { salesCents: 0, refundCents: 0 };
      net = { currency: 'GBP', cents: g.salesCents - g.refundCents };
    }
    if (net) {
      const vat = vatIncludedCents(net.cents, c.rate);
      c.returnFigures = { currency: net.currency, exclusiveCents: net.cents - vat, vatCents: vat };
    }
    const t = totals[c.scheme];
    t.salesCents += c.salesCents;
    t.refundCents += c.refundCents;
    t.netCents += c.netCents;
    if (c.scheme !== 'none') {
      t.vatCents += c.vatCents;
      t.exclusiveCents += c.exclusiveCents;
    }
    const rt = returnTotals[c.scheme];
    if (rt && c.returnFigures) {
      rt.exclusiveCents += c.returnFigures.exclusiveCents;
      rt.vatCents += c.returnFigures.vatCents;
    }
  }
  // The EU corrections, in USD and negative (VAT given back): the euro amount uses the
  // rate of the return being corrected, which this report does not know.
  const correctionList = [...corrections.values()].map(x => {
    const vat = vatIncludedCents(x.refundCents, x.rate);
    return { ...x, vatCents: -vat, exclusiveCents: -(x.refundCents - vat) };
  }).sort((a, z) => a.period.localeCompare(z.period) || a.country.localeCompare(z.country));
  const list = [...byCountry.values()].sort((a, z) => (z.netCents - a.netCents) || a.country.localeCompare(z.country));
  return {
    quarter: String(quarter).trim().toUpperCase(),
    from: new Date(b.start * 1000).toISOString(),
    to: new Date(b.end * 1000).toISOString(),
    currency: 'USD',
    ratesChecked: RATES_CHECKED,
    orders: sales.length,
    salesCents: sales.reduce((s, r) => s + r.amount_cents, 0),
    refunds: refunds.length,
    undatedRefunds,
    byCountry: list,
    totals,
    returnTotals,
    corrections: correctionList,
    exchange: { usdPerEur, usdPerGbpByMonth: usdPerGbpByMonth && { ...usdPerGbpByMonth } },
    unknown,
    review,
    notes: [
      'Prices include VAT, so the VAT shown is the part of each net amount the rate makes up; exclusiveCents is the rest, the value a return asks for.',
      usdPerEur != null
        ? `EU figures in euros at 1 EUR = ${usdPerEur} USD, which must be the ECB reference rate of the quarter's last day.`
        : "Pass usdPerEur (the ECB reference rate of the quarter's last day, US dollars per euro) for the EU figures in euros.",
      usdPerGbpByMonth != null
        ? 'UK figures in pounds, each sale at its month\'s rate as given (US dollars per pound); a refund at its sale\'s month.'
        : "Pass usdPerGbp (HMRC's monthly rate for each month, US dollars per pound) for the UK figures in pounds.",
      `Rates were checked on ${RATES_CHECKED}; check them against the EU tax database and GOV.UK before filing.`,
      'Sales count in the quarter they were paid; refunds and chargeback reversals in the quarter they happened; failed refunds not at all.',
      `${correctionList.length} EU correction(s): refunds of earlier quarters' sales, for the correction part of the return, converted at the rate of the return they correct.`,
      `${undatedRefunds} refunded order(s) in this quarter have no refund on record and were netted out in their sale's quarter.`,
      'Every sale without two matching pieces of evidence is listed under review; settle each before filing.'
    ]
  };
}

module.exports = {
  normalizeCountry, ipCountryOf, payerCountryOf, fillPayerCountries, runDailyFill, scheduleDailyFill,
  nextRunAt, vatOff, quarterBounds, evidenceOf, buildVatReport, parseReportQuery, windowsBetween, MAX_WINDOW_S
};

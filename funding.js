// How much of this month's running costs the community has covered so far.
//
// The site shows one public number, a percentage, so players can see the servers
// are player-funded and how close this month is (funding plan, 2026-10). Amounts
// never leave this module: the public endpoint returns the percentage and a status.
//
// Costs are the monthly entries on the admin Finances tab (monthly_expenses, kind
// 'monthly', tax included). Money in is this UTC month's kept payments: completed
// live orders, plus orders staff revoked WITHOUT a refund (the money stayed), less
// PayPal's fee (recorded, else estimated at the US Checkout rate) and less the VAT
// inside the price where the buyer's country is known to owe it (vatEvidence.js).
//
// Takes the database as a parameter and does nothing on require
// (test/funding.test.js).

const { vatFor, vatIncludedCents } = require('./vatRates');
const { normalizeCountry } = require('./vatEvidence');

// PayPal Checkout, US, as of October 2026: 3.49% + $0.49 a payment. Only used for
// a payment whose fee PayPal never reported.
const FEE_PERCENT = 3.49;
const FEE_FIXED_CENTS = 49;
// Shown as at least 0 and at most this, so a slow month or a windfall never prints
// a silly number.
const MAX_SHOWN_PCT = 999;

function estimatedFeeCents(amountCents) {
  return Math.round((amountCents * FEE_PERCENT) / 100) + FEE_FIXED_CENTS;
}

// [start, end) of the UTC month holding `now` (unix seconds), and its label.
function monthOf(now) {
  const d = new Date(now * 1000);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  const label = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return { start, end, label };
}

// The private figures behind the percentage, for staff and tests.
function coverage(db, { now = Math.floor(Date.now() / 1000) } = {}) {
  const m = monthOf(now);
  const costs = db.prepare(`
    SELECT COALESCE(SUM(amount_cents + COALESCE(tax_cents, 0)), 0) AS cents
    FROM monthly_expenses WHERE kind = 'monthly'
  `).get().cents;
  const rows = db.prepare(`
    SELECT amount_cents, fee_cents, payer_country, ip_country
    FROM orders
    WHERE test_mode = 0 AND amount_cents > 0 AND completed_at >= ? AND completed_at < ?
      AND (status = 'completed' OR (status = 'refunded' AND revoked_without_refund_at IS NOT NULL))
  `).all(m.start, m.end);
  let grossCents = 0;
  let feeCents = 0;
  let vatCents = 0;
  for (const r of rows) {
    grossCents += r.amount_cents;
    feeCents += r.fee_cents != null ? Math.abs(r.fee_cents) : estimatedFeeCents(r.amount_cents);
    const country = normalizeCountry(r.payer_country) || normalizeCountry(r.ip_country);
    const { scheme, rate } = vatFor(country);
    if (scheme !== 'none') vatCents += vatIncludedCents(r.amount_cents, rate);
  }
  const keptCents = grossCents - feeCents - vatCents;
  const pct = costs > 0 ? Math.max(0, Math.floor((keptCents * 100) / costs)) : null;
  return { month: m.label, payments: rows.length, grossCents, feeCents, vatCents, keptCents, costsCents: costs, coveredPct: pct };
}

// What the public endpoint returns: the percentage and a status, no amounts.
// status: 'covered' at 100% or more, 'short' below, 'unknown' with no costs entered.
function publicCoverage(db, opts = {}) {
  const c = coverage(db, opts);
  if (c.coveredPct == null) return { month: c.month, coveredPct: null, status: 'unknown' };
  return {
    month: c.month,
    coveredPct: Math.min(MAX_SHOWN_PCT, c.coveredPct),
    status: c.coveredPct >= 100 ? 'covered' : 'short'
  };
}

module.exports = { coverage, publicCoverage, monthOf, estimatedFeeCents, FEE_PERCENT, FEE_FIXED_CENTS };

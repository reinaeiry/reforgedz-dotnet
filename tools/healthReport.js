#!/usr/bin/env node
// The daily card in #Payment-Processor: is the shop healthy, and what did money do
// in the last day, in one glance.
//
// Every morning at 09:00 UTC (scheduled from server.js), half an hour after the
// PayPal reconciliation (tools/reconcile.js):
//   1. give back any entitlement role a linked, present member is missing
//   2. run the deep doctor (every integration, server files, owed roles)
//   3. post one card (tools/lib/discordCard.js): grey and silent when healthy,
//      amber when something is wrong, red on a failure, with each one named so the
//      fix is obvious. The money lines never change the colour: every money problem
//      already has its own red card. Warnings staff have accepted are listed under
//      "Known, parked" and leave the card grey.
//
//   node tools/healthReport.js            run now and post (the card says "Manual run")
//   node tools/healthReport.js --no-post  run now, print only
//   node tools/healthReport.js --dry-run  report missing roles without granting
const path = require('path');
if (require.main === module) require('dotenv').config({ path: process.env.ENV_FILE || path.join(__dirname, '..', '.env'), quiet: true });

// The doctor, the database and the sync load only when a run starts, so the card
// can be built and tested without them (test/healthReport.test.js).
const { sendCard, money, serverLabel } = require('./lib/discordCard');

const DAILY_UTC = { hour: 9, minute: 0 };
const HOUR = 3600;
const DAY = 86400;
// The reconciliation runs every 24 hours; a last run older than this means its
// timer has stopped.
const RECONCILE_STALE_S = 26 * HOUR;
const nowUnix = () => Math.floor(Date.now() / 1000);

// ---- Warnings staff have accepted --------------------------------------------------
// Each one is still listed on the card, under "Known, parked", but does not turn it
// amber: a card that is amber every day for the same known thing teaches staff to
// stop reading it.
//
// The list is configuration, not code (HEALTH_PARKED_WARNINGS), because what one
// deployment has accepted says nothing about another. It is a JSON array of
//   { "check": a doctor check id, "match": a pattern, "note": the line staff read }
// and the pattern must match the check's WHOLE detail text, so anything more in the
// same check (a second item, reworded doctor text) is a real warning again. Keep it
// short and exact.
//
// Returns { list, error }. A setting that cannot be read parks nothing and becomes a
// warning of its own, so a typo never hides a real problem.
function parkedWarningsFrom(env = process.env) {
  const none = Object.freeze([]);
  const raw = String((env && env.HEALTH_PARKED_WARNINGS) || '').trim();
  if (!raw) return { list: none, error: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { list: none, error: `HEALTH_PARKED_WARNINGS is not valid JSON, so nothing is parked: ${e.message}` };
  }
  if (!Array.isArray(parsed)) return { list: none, error: 'HEALTH_PARKED_WARNINGS must be a JSON array, so nothing is parked' };
  const list = [];
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i];
    const ok = e && typeof e.check === 'string' && e.check && typeof e.match === 'string' && e.match
      && typeof e.note === 'string' && e.note.trim();
    if (!ok) return { list: none, error: `HEALTH_PARKED_WARNINGS entry ${i + 1} needs check, match and note, so nothing is parked` };
    let re;
    try {
      re = new RegExp(`^(?:${e.match})$`);
    } catch {
      return { list: none, error: `HEALTH_PARKED_WARNINGS entry ${i + 1} has a match that is not a valid pattern, so nothing is parked` };
    }
    list.push(Object.freeze({
      check: e.check,
      note: e.note.trim(),
      matches: (detail) => {
        const d = String(detail || '');
        return d !== '' && re.test(d);
      }
    }));
  }
  return { list: Object.freeze(list), error: null };
}

// Failures, real warnings and accepted warnings, in the report's order.
function sortChecks(checks, accepted = parkedWarningsFrom().list) {
  const problems = [];
  const warnings = [];
  const parked = [];
  for (const c of checks || []) {
    if (c.status === 'fail') problems.push(c);
    else if (c.status === 'warn') {
      const a = accepted.find(x => x.check === c.id && x.matches(String(c.detail || '')));
      if (a) parked.push({ ...c, note: a.note });
      else warnings.push(c);
    }
  }
  return { problems, warnings, parked };
}

// ---- Money in the last 24 hours ------------------------------------------------------

function addTo(totals, currency, cents) {
  if (!Number.isFinite(cents)) return;
  const cur = String(currency || 'usd').toUpperCase();
  totals[cur] = (totals[cur] || 0) + cents;
}

// "$55.00", or "$55.00 + 12.50 EUR". Dollars first.
function totalsText(totals) {
  const keys = Object.keys(totals || {}).sort((a, b) => (a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b)));
  return keys.map(k => money(totals[k], k)).join(' + ') || money(0, 'USD');
}

// The day before `now`, from the shop's own records: payments booked (new and
// renewals), refunds and reversals recorded, payments the reconciliation reported,
// and every dispute still open. Sandbox orders, and refunds and disputes on them,
// are left out. Orders carry no currency of their own; their product's is used.
function moneyLast24h(db, now = nowUnix()) {
  const since = now - DAY;
  const out = {
    since, until: now,
    paymentsIn: { count: 0, newCount: 0, totals: {} },
    renewals: { count: 0, totals: {} },
    refundsOut: { count: 0, noAmount: 0, totals: {} },
    reversals: { count: 0, totals: {} },
    unbookedFound: 0,
    openDisputes: { count: 0, waitingForShop: 0, totals: {} }
  };

  // A renewal is a cycle row with an earlier row on the same subscription.
  const payments = db.prepare(`
    SELECT o.amount_cents AS cents, p.currency AS currency,
           (o.paypal_subscription_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM orders e WHERE e.paypal_subscription_id = o.paypal_subscription_id AND e.id < o.id)) AS renewal
    FROM orders o
    LEFT JOIN products p ON p.id = o.product_id
    WHERE o.test_mode = 0 AND o.status IN ('completed', 'refunded')
      AND o.completed_at > ? AND o.completed_at <= ?
  `).all(since, now);
  for (const r of payments) {
    out.paymentsIn.count += 1;
    addTo(out.paymentsIn.totals, r.currency, r.cents);
    if (r.renewal) {
      out.renewals.count += 1;
      addTo(out.renewals.totals, r.currency, r.cents);
    } else {
      out.paymentsIn.newCount += 1;
    }
  }

  const refunds = db.prepare(`
    SELECT r.kind, r.amount_cents AS cents, COALESCE(r.currency, p.currency) AS currency
    FROM paypal_refunds r
    LEFT JOIN orders o ON o.id = r.order_id
    LEFT JOIN products p ON p.id = o.product_id
    WHERE r.received_at > ? AND r.received_at <= ? AND COALESCE(o.test_mode, 0) = 0
      AND r.kind IN ('refund', 'reversal')
  `).all(since, now);
  for (const r of refunds) {
    const bucket = r.kind === 'reversal' ? out.reversals : out.refundsOut;
    bucket.count += 1;
    if (r.cents == null) { if (bucket === out.refundsOut) out.refundsOut.noAmount += 1; } else addTo(bucket.totals, r.currency, r.cents);
  }

  out.unbookedFound = db.prepare('SELECT COUNT(*) AS n FROM reconcile_seen WHERE reported_at > ? AND reported_at <= ?').get(since, now).n;

  const disputes = db.prepare(`
    SELECT d.status, d.amount_cents AS cents, COALESCE(d.currency, p.currency) AS currency
    FROM paypal_disputes d
    LEFT JOIN orders o ON o.id = d.order_id
    LEFT JOIN products p ON p.id = o.product_id
    WHERE COALESCE(d.status, '') != 'RESOLVED' AND COALESCE(o.test_mode, 0) = 0
  `).all();
  for (const d of disputes) {
    out.openDisputes.count += 1;
    if (d.status === 'WAITING_FOR_SELLER_RESPONSE') out.openDisputes.waitingForShop += 1;
    addTo(out.openDisputes.totals, d.currency, d.cents);
  }
  return out;
}

function moneyText(m) {
  const lines = [
    `Payments in: ${m.paymentsIn.count}, ${totalsText(m.paymentsIn.totals)}`,
    `Renewals booked (part of those): ${m.renewals.count}, ${totalsText(m.renewals.totals)}`,
    `Refunds out: ${m.refundsOut.count}, ${totalsText(m.refundsOut.totals)}${m.refundsOut.noAmount ? `, ${m.refundsOut.noAmount} with no amount given` : ''}`
  ];
  if (m.reversals.count) lines.push(`Payments reversed: ${m.reversals.count}, ${totalsText(m.reversals.totals)}`);
  lines.push(`Unbooked payments found by the PayPal check: ${m.unbookedFound}`);
  const d = m.openDisputes;
  lines.push(`Open disputes (any age): ${d.count}${d.count ? `, ${totalsText(d.totals)}` : ''}${d.waitingForShop ? `, ${d.waitingForShop} waiting for the shop` : ''}`);
  return lines.join('\n');
}

// ---- Active entitlements --------------------------------------------------------------
// Distinct in-game IDs per server, from exactly what the entitlement sync sends each
// server (sync.buildPerServerPurchaseBuckets, and buildPriorityQueueGuidsPerServer for
// priority queue). Counting order rows overstates it: one player can hold several
// live orders, and staff grants and blocks change what a server really gets.
function entitlementsByServer(buckets, pq = {}) {
  const distinct = (list) => new Set([...(list || [])].map(g => (g ? String(g).toLowerCase() : null)).filter(Boolean)).size;
  return Object.keys(buckets || {}).map(serverId => ({
    serverId,
    ids: distinct((buckets[serverId] || []).map(e => e && e.guid)),
    priorityQueue: distinct(pq && pq[serverId])
  }));
}

function entitlementsText(list) {
  return list.map(s => `${serverLabel(s.serverId)}: ${s.ids}, ${s.priorityQueue} with priority queue`).join('\n') || 'No servers';
}

// ---- The PayPal reconciliation's last run ---------------------------------------------
// status: { off, last } from tools/reconcile.js. Returns a line for the description,
// or a warning when the check failed, stopped running or could not post its card.
function reconcileSummary(status, now = nowUnix()) {
  if (!status) return { bit: null, check: null };
  const warn = (detail) => ({ bit: null, check: { id: 'paypal.reconcile', status: 'warn', detail } });
  if (status.off) return { bit: 'PayPal check off (RECONCILE)', check: null };
  const last = status.last;
  if (!last) return { bit: 'PayPal check has not run since the shop last started', check: null };
  const at = last.ranAt ? `${new Date(last.ranAt * 1000).toISOString().slice(11, 16)} UTC` : 'last';
  if (last.ranAt && now - last.ranAt > RECONCILE_STALE_S) {
    return warn(`the daily PayPal check last ran ${Math.round((now - last.ranAt) / HOUR)} h ago; its timer is not running`);
  }
  if (last.error) return warn(`the ${at} PayPal check could not finish, so no payment was checked: ${last.error}`);
  if (last.skipped) return { bit: `PayPal check skipped: ${last.skipped}`, check: null };
  if (last.unbooked && !last.posted) {
    return warn(`the ${at} PayPal check found ${last.unbooked} unbooked payment${last.unbooked === 1 ? '' : 's'} but could not post its card; the next run reports them again`);
  }
  const n = last.incoming || 0;
  return { bit: `PayPal check ${at}: ${n} payment${n === 1 ? '' : 's'}, ${last.unbooked ? `${last.unbooked} unbooked reported` : 'all booked'}`, check: null };
}

// ---- The card ---------------------------------------------------------------------------

function line(report, id) {
  const c = (report.checks || []).find(x => x.id === id);
  return c ? c.detail : null;
}

// A card spec for discordCard.buildCard. Healthy is grey and silent, not green:
// green in the channel means money arrived.
//   extra.money         moneyLast24h's result
//   extra.entitlements  entitlementsByServer's result
//   extra.reconcile     { off, last } from tools/reconcile.js
//   extra.manual        a run started by hand, marked "Manual run"
//   extra.errors        [{ id, detail }] parts of the card that could not be read
//   extra.parked        parkedWarningsFrom's result (default: read from the environment)
function buildHealthCard(report, heal, extra = {}) {
  const { money: moneyLines = null, entitlements = null, reconcile = null, manual = false, errors = [], now = nowUnix() } = extra || {};
  const parkedConfig = (extra && extra.parked) || parkedWarningsFrom();
  const recon = reconcileSummary(reconcile, now);
  const checks = [
    ...(report.checks || []),
    ...(recon.check ? [recon.check] : []),
    ...(parkedConfig.error ? [{ id: 'health.parked', status: 'warn', detail: parkedConfig.error }] : []),
    ...(errors || []).map(e => ({ id: e.id, status: 'warn', detail: e.detail }))
  ];
  const { problems, warnings, parked } = sortChecks(checks, parkedConfig.list);
  const kind = problems.length ? 'action' : warnings.length ? 'attention' : 'info';
  let title = problems.length
    ? `Shop health: ${problems.length} problem${problems.length > 1 ? 's' : ''}`
    : warnings.length ? `Shop health: OK, ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : 'Shop health: all clear';
  if (manual) title += ' · Manual run';

  const bits = [];
  if (manual) bits.push('Manual run');
  const bill = line(report, 'billing.issues');
  if (bill) bits.push(bill.startsWith('no open') ? 'no failing renewals' : bill.replace(/ \(players.*$/, '').replace(/^(\d+) open/, '$1 failing renewals'));
  const servers = line(report, 'ssh.servers');
  if (servers) { const exact = (servers.match(/ exact/g) || []).length; const total = (servers.match(/(\d+) servers reachable/) || [])[1]; if (total) bits.push(`${exact}/${total} servers exact`); }
  const roles = line(report, 'roles.parity');
  if (roles) bits.push(roles.replace(/, \d+ owed to members who left/, ''));
  const backup = line(report, 'backup.local');
  if (backup) bits.push(`backup ${backup.split(',')[0]}`);
  const offsite = line(report, 'backup.offsite');
  const offsiteCheck = (report.checks || []).find(c => c.id === 'backup.offsite');
  if (offsite && offsiteCheck && offsiteCheck.status === 'ok') bits.push(`offsite ${[...new Set(offsite.split(',').map(s => s.trim().split(' ')[0]))].join('+')}`);
  if (recon.bit) bits.push(recon.bit);
  if (heal && !heal.error) {
    if (heal.granted) bits.push(`${heal.granted} role${heal.granted > 1 ? 's' : ''} given back`);
    else if (heal.missing) bits.push(`${heal.missing} role${heal.missing > 1 ? 's' : ''} missing, not granted`);
  } else if (heal && heal.error) {
    bits.push(`role heal failed: ${heal.error}`);
  }

  const fields = [
    ...problems.map(c => ({ name: `FAIL ${c.id}`, value: c.detail })),
    ...warnings.map(c => ({ name: `warn ${c.id}`, value: c.detail }))
  ];
  if (entitlements) fields.push({ name: 'Active entitlements (distinct in-game IDs per server)', value: entitlementsText(entitlements) });
  if (moneyLines) fields.push({ name: 'Money, last 24 hours', value: moneyText(moneyLines) });
  if (parked.length) fields.push({ name: 'Known, parked', value: parked.map(c => `${c.id}: ${c.note}`).join('\n') });
  if (heal && heal.details && heal.details.length) {
    fields.push({ name: heal.dryRun ? 'roles missing (preview)' : `roles given back (${heal.granted}/${heal.missing})`, value: heal.details.slice(0, 10).map(d => `${d.persona || d.userId}: ${d.product}`).join('\n') || '-' });
  }
  const okCount = report.summary ? report.summary.ok : 0;
  return {
    kind,
    what: title,
    description: bits.join(' · '),
    fields,
    footerExtra: `version ${report.version ? report.version.slice(0, 7) : '?'} · ${okCount} ok / ${warnings.length} warn${parked.length ? ` (+${parked.length} parked)` : ''} / ${problems.length} fail · npm run doctor -- --deep`
  };
}

// manual defaults to true: only the scheduler says a run is not by hand.
async function runDailyHealth({ post = true, dryRun = false, manual = true } = {}) {
  let heal = null;
  try {
    heal = await require('../routes/shop').healMissingDiscordRoles({ dryRun, max: 25 });
  } catch (e) {
    heal = { error: e.message };
  }
  const report = await require('./doctor').runDoctor({ deep: true });
  const errors = [];
  let moneyLines = null;
  try {
    moneyLines = moneyLast24h(require('../db'));
  } catch (e) {
    errors.push({ id: 'health.money', detail: `the money lines could not be read: ${e.message}` });
  }
  let entitlements = null;
  try {
    const sync = require('../sync');
    entitlements = entitlementsByServer(sync.buildPerServerPurchaseBuckets(), sync.buildPriorityQueueGuidsPerServer());
  } catch (e) {
    errors.push({ id: 'health.entitlements', detail: `active entitlements could not be counted: ${e.message}` });
  }
  let reconcile = null;
  try {
    const r = require('./reconcile');
    reconcile = { off: r.reconcileOff(), last: r.lastReconcileRun() };
  } catch (e) {
    errors.push({ id: 'paypal.reconcile', detail: `the PayPal check's status could not be read: ${e.message}` });
  }
  const card = buildHealthCard(report, heal, { money: moneyLines, entitlements, reconcile, manual, errors });
  let posted = { ok: false, skipped: 'not requested' };
  if (post) posted = await sendCard(card);
  console.log(`[health] ${card.what} (${report.summary.ok}/${report.summary.warn}/${report.summary.fail})${heal && heal.granted ? `, ${heal.granted} roles healed` : ''}${posted.ok ? ', posted' : ', not posted: ' + JSON.stringify(posted)}`);
  return { report, heal, card, posted };
}

function msUntilNextDaily(now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DAILY_UTC.hour, DAILY_UTC.minute, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

let scheduled = false;
function scheduleDailyHealth() {
  if (scheduled) return;
  scheduled = true;
  const arm = () => setTimeout(() => {
    runDailyHealth({ post: true, manual: false }).catch(e => console.error('[health] daily run failed:', e.message)).finally(arm);
  }, msUntilNextDaily());
  arm();
  console.log(`[health] daily card at ${String(DAILY_UTC.hour).padStart(2, '0')}:${String(DAILY_UTC.minute).padStart(2, '0')} UTC`);
}

module.exports = {
  runDailyHealth, buildHealthCard, scheduleDailyHealth,
  parkedWarningsFrom, sortChecks, moneyLast24h, moneyText, entitlementsByServer, reconcileSummary
};

if (require.main === module) {
  runDailyHealth({ post: !process.argv.includes('--no-post'), dryRun: process.argv.includes('--dry-run'), manual: true }).then((r) => {
    console.log(JSON.stringify(r.card, null, 2));
    process.exit(r.report.ok ? 0 : 1);
  }).catch((e) => { console.error('health failed:', e.stack || e.message); process.exit(2); });
}

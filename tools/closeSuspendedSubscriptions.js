#!/usr/bin/env node
// Close billing agreements PayPal has given up on.
//
// After three failed payments PayPal SUSPENDS an agreement: it stops billing,
// but the agreement still exists and only the merchant could revive it. That
// contradicts what the shop already tells the player -- the card, the email and
// the account page all say a suspended subscription cannot be restarted -- and
// it leaves a state nobody needs to reason about. Since 2026-09-12 the webhook
// closes each new suspension as it happens; this closes the ones that suspended
// before that, and doubles as a safety net if a webhook is ever missed.
//
//   npm run close-suspended              list what WOULD be closed, touch nothing
//   npm run close-suspended -- --apply   actually close them
//
// ⛔ --apply REFUSES TO RUN if any lookup failed. The first version of this tool
// fired 400 sequential PayPal calls with no delay: PayPal rate-limited it, the
// 12s client timeout cascaded, 45 subscriptions could not be read, and it still
// printed a confident "would close: 15" while silently omitting one real
// suspension. A sweep that under-reports is worse than no sweep, so an
// incomplete picture is now a hard stop rather than a footnote.
const path = require('path');
if (require.main === module) require('dotenv').config({ path: process.env.ENV_FILE || path.join(__dirname, '..', '.env'), quiet: true });

const Database = require('better-sqlite3');
const { dataPath } = require('../dataDir');
const paypal = require('../paypal');

const REASON = 'Closed by ReforgedZ after PayPal stopped retrying failed payments';
const THROTTLE_MS = 220;        // between lookups, to stay under PayPal's limit
const LOOKUP_ATTEMPTS = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry the things that are worth retrying: PayPal's own rate limit, and the
// client-side abort that follows once it starts throttling. A 404 means the
// agreement was never created (an abandoned checkout) and is not a problem.
async function lookup(testMode, sub) {
  for (let attempt = 0; attempt < LOOKUP_ATTEMPTS; attempt++) {
    try {
      return { state: 'ok', data: await paypal.getSubscription(testMode, sub) };
    } catch (e) {
      const msg = e.message || String(e);
      if (/\b404\b/.test(msg)) return { state: 'never-created' };
      const worthRetrying = /429|aborted|timed? ?out|ETIMEDOUT|ECONNRESET|socket|network/i.test(msg);
      if (!worthRetrying || attempt === LOOKUP_ATTEMPTS - 1) return { state: 'error', error: msg.slice(0, 100) };
      await sleep(2000 * Math.pow(2, attempt));   // 2s, 4s, 8s
    }
  }
}

function candidates() {
  const db = new Database(dataPath('shop.db'), { readonly: true });
  try {
    // Only subscriptions that ever mattered: one that took a payment, or one we
    // recorded a billing problem against. A subscription id with neither is an
    // approval the buyer abandoned, which PayPal 404s -- there were ~200 of
    // those, and asking about each one is what triggered the rate limiting.
    return db.prepare(`
      SELECT o.paypal_subscription_id AS sub,
             MAX(o.test_mode) AS testMode,
             MAX(o.effective_until) AS eff,
             (SELECT persona FROM users WHERE steam_id = o.steam_id) AS persona
      FROM orders o
      WHERE o.paypal_subscription_id IS NOT NULL
      GROUP BY o.paypal_subscription_id
      HAVING SUM(o.status = 'completed') > 0
          OR SUM(o.status = 'refunded') > 0
          OR o.paypal_subscription_id IN (SELECT paypal_subscription_id FROM subscription_billing_issues)
    `).all();
  } finally {
    db.close();
  }
}

async function closeSuspended({ apply = false } = {}) {
  const rows = candidates();
  const now = Math.floor(Date.now() / 1000);
  const report = {
    checked: 0, total: rows.length, neverCreated: 0, notSuspended: 0,
    suspended: [], skippedPaidUp: [], closed: [], failed: [], lookupErrors: [], aborted: false
  };

  console.log(`  checking ${rows.length} subscriptions that took a payment or had a billing problem`);
  console.log(`  (about ${Math.max(1, Math.ceil(rows.length * (THROTTLE_MS + 400) / 60000))} min; abandoned checkouts are skipped)`);

  // Pass 1: classify everything. Nothing is changed in this pass, so a partial
  // picture can still be turned into a refusal rather than a partial sweep.
  for (const r of rows) {
    report.checked++;
    if (report.checked % 25 === 0) console.log(`    ...${report.checked}/${rows.length}, ${report.suspended.length} suspended, ${report.lookupErrors.length} unreadable`);
    const res = await lookup(!!r.testMode, r.sub);
    if (res.state === 'never-created') { report.neverCreated++; continue; }
    if (res.state === 'error') { report.lookupErrors.push({ sub: r.sub, persona: r.persona || '?', error: res.error }); continue; }

    const s = res.data;
    if (String(s.status).toUpperCase() !== 'SUSPENDED') { report.notSuspended++; continue; }
    const bi = s.billing_info || {};
    const entry = {
      sub: r.sub, persona: r.persona || '?', testMode: !!r.testMode, eff: r.eff,
      owed: bi.outstanding_balance ? bi.outstanding_balance.value : '0',
      lastPaid: bi.last_payment ? bi.last_payment.time.slice(0, 10) : 'never',
      fails: bi.failed_payments_count
    };
    // A suspended agreement should never still be inside a paid period, but if
    // one is, the player still has what they paid for and this is not the place
    // to decide otherwise.
    if (r.eff && r.eff > now) report.skippedPaidUp.push(entry);
    else report.suspended.push(entry);
    await sleep(THROTTLE_MS);
  }

  if (!apply) return report;

  // Hard stop: an incomplete survey must not become a partial sweep.
  if (report.lookupErrors.length) {
    report.aborted = true;
    return report;
  }

  // Pass 2: close them.
  for (const e of report.suspended) {
    try {
      await paypal.cancelSubscription(e.testMode, e.sub, REASON);
      report.closed.push(e);
      console.log(`  closed ${e.sub} (${e.persona}, owed $${e.owed}, last paid ${e.lastPaid})`);
    } catch (err) {
      report.failed.push({ ...e, error: (err.message || String(err)).slice(0, 120) });
      console.error(`  FAILED ${e.sub} (${e.persona}): ${err.message}`);
    }
    await sleep(400);
  }
  return report;
}

function printReport(r, apply) {
  console.log('');
  console.log(`  subscriptions surveyed:        ${r.checked} of ${r.total}`);
  console.log(`  never created (abandoned):     ${r.neverCreated}`);
  console.log(`  live or already closed:        ${r.notSuspended}`);
  console.log(`  unreadable (lookup failed):    ${r.lookupErrors.length}`);
  for (const e of r.lookupErrors) console.log(`    ${String(e.persona).substring(0, 18).padEnd(18)} ${e.sub}  ${e.error}`);
  if (r.skippedPaidUp.length) {
    console.log(`  SUSPENDED but still paid up, left alone: ${r.skippedPaidUp.length}`);
    for (const e of r.skippedPaidUp) console.log(`    ${e.persona} (paid to ${new Date(e.eff * 1000).toISOString().slice(0, 10)})`);
  }
  console.log(`  suspended and finished:        ${r.suspended.length}`);
  for (const e of r.suspended) {
    console.log(`    ${String(e.persona).substring(0, 18).padEnd(18)} owed $${String(e.owed).padEnd(6)} last paid ${e.lastPaid}  fails=${e.fails}${e.testMode ? '  [test mode]' : ''}`);
  }
  if (r.aborted) {
    console.log('');
    console.log(`  ⛔ REFUSED TO APPLY: ${r.lookupErrors.length} subscription(s) could not be read, so this survey is incomplete.`);
    console.log('     Closing only the ones that happened to answer would leave the rest in limbo and report success.');
    console.log('     Re-run the dry run until it reports 0 unreadable, then --apply.');
    return;
  }
  if (apply) {
    console.log(`  closed:                        ${r.closed.length}`);
    if (r.failed.length) { console.log(`  FAILED: ${r.failed.length}`); for (const e of r.failed) console.log(`    ${e.persona}: ${e.error}`); }
  } else {
    console.log('');
    console.log('  DRY RUN. Nothing was changed.');
    if (r.lookupErrors.length) console.log('  ⚠️ --apply would REFUSE while any subscription is unreadable. Re-run until that line reads 0.');
    else console.log('  Re-run with --apply to close the subscriptions listed above.');
  }
}

module.exports = { closeSuspended };

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  console.log(apply ? 'Closing suspended PayPal agreements' : 'Dry run: suspended PayPal agreements that would be closed');
  closeSuspended({ apply }).then(async (r) => {
    printReport(r, apply);
    if (apply && !r.aborted && (r.closed.length || r.failed.length)) {
      const { postCard, COLORS } = require('./lib/discordCard');
      await postCard({
        title: 'Suspended subscriptions closed',
        color: r.failed.length ? COLORS.amber : COLORS.grey,
        description: `${r.closed.length} agreement${r.closed.length === 1 ? '' : 's'} PayPal had given up on are now properly cancelled, so none can sit in limbo or be revived. No access changed: all of these had already lost their perks.`,
        fields: [
          { name: 'Closed', value: String(r.closed.length), inline: true },
          { name: 'Failed', value: String(r.failed.length), inline: true },
          { name: 'Players', value: r.closed.map((e) => e.persona).join(', ').slice(0, 1000) || '-' }
        ],
        footer: 'npm run close-suspended -- --apply'
      }).catch(() => {});
    }
    process.exit(r.aborted || r.failed.length ? 1 : 0);
  }).catch((e) => { console.error('failed:', e.stack || e.message); process.exit(2); });
}

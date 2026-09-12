#!/usr/bin/env node
// The daily card in #Payment-Processor: is the shop healthy, in one glance.
//
// Every morning at 09:00 UTC (scheduled from server.js):
//   1. give back any entitlement role a linked, present member is missing
//   2. run the deep doctor (every integration, server files, owed roles)
//   3. post one embed: green when healthy, amber when only warnings, red on a
//      failure, with each non-OK check named so the fix is obvious
//
//   node tools/healthReport.js            run now and post
//   node tools/healthReport.js --no-post  run now, print only
//   node tools/healthReport.js --dry-run  report missing roles without granting
const path = require('path');
if (require.main === module) require('dotenv').config({ path: process.env.ENV_FILE || path.join(__dirname, '..', '.env'), quiet: true });

const { runDoctor } = require('./doctor');
const { postCard, COLORS } = require('./lib/discordCard');

const DAILY_UTC = { hour: 9, minute: 0 };

function line(report, id) {
  const c = report.checks.find(x => x.id === id);
  return c ? c.detail : null;
}

function buildCard(report, heal) {
  const problems = report.checks.filter(c => c.status === 'fail');
  const warnings = report.checks.filter(c => c.status === 'warn');
  const color = problems.length ? COLORS.red : warnings.length ? COLORS.amber : COLORS.green;
  const title = problems.length
    ? `Shop health: ${problems.length} problem${problems.length > 1 ? 's' : ''}`
    : warnings.length ? `Shop health: OK, ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : 'Shop health: all clear';

  const bits = [];
  const dbLine = line(report, 'db.file');
  if (dbLine) { const m = dbLine.match(/(\d+) active entitlements/); if (m) bits.push(`${m[1]} active entitlements`); }
  const bill = line(report, 'billing.issues');
  if (bill) bits.push(bill.startsWith('no open') ? 'no failing renewals' : bill.replace(/ \(players.*$/, '').replace(/^(\d+) open/, '$1 failing renewals'));
  const servers = line(report, 'ssh.servers');
  if (servers) { const exact = (servers.match(/ exact/g) || []).length; const total = (servers.match(/(\d+) servers reachable/) || [])[1]; if (total) bits.push(`${exact}/${total} servers exact`); }
  const roles = line(report, 'roles.parity');
  if (roles) bits.push(roles.replace(/, \d+ owed to members who left/, ''));
  const backup = line(report, 'backup.local');
  if (backup) bits.push(`backup ${backup.split(',')[0]}`);
  const offsite = line(report, 'backup.offsite');
  if (offsite && report.checks.find(c => c.id === 'backup.offsite').status === 'ok') bits.push(`offsite ${[...new Set(offsite.split(',').map(s => s.trim().split(' ')[0]))].join('+')}`);
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
  if (heal && heal.details && heal.details.length) {
    fields.push({ name: heal.dryRun ? 'roles missing (preview)' : `roles given back (${heal.granted}/${heal.missing})`, value: heal.details.slice(0, 10).map(d => `${d.persona || d.userId}: ${d.product}`).join('\n') || '-' });
  }
  return {
    title, color,
    description: bits.join(' · '),
    fields,
    footer: `version ${report.version ? report.version.slice(0, 7) : '?'} · ${report.summary.ok} ok / ${report.summary.warn} warn / ${report.summary.fail} fail · npm run doctor -- --deep`
  };
}

async function runDailyHealth({ post = true, dryRun = false } = {}) {
  let heal = null;
  try {
    heal = await require('../routes/shop').healMissingDiscordRoles({ dryRun, max: 25 });
  } catch (e) {
    heal = { error: e.message };
  }
  const report = await runDoctor({ deep: true });
  const card = buildCard(report, heal);
  let posted = { ok: false, skipped: 'not requested' };
  if (post) posted = await postCard(card);
  console.log(`[health] ${card.title} (${report.summary.ok}/${report.summary.warn}/${report.summary.fail})${heal && heal.granted ? `, ${heal.granted} roles healed` : ''}${posted.ok ? ', posted' : ', not posted: ' + JSON.stringify(posted)}`);
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
    runDailyHealth({ post: true }).catch(e => console.error('[health] daily run failed:', e.message)).finally(arm);
  }, msUntilNextDaily());
  arm();
  console.log(`[health] daily card at ${String(DAILY_UTC.hour).padStart(2, '0')}:${String(DAILY_UTC.minute).padStart(2, '0')} UTC`);
}

module.exports = { runDailyHealth, buildCard, scheduleDailyHealth };

if (require.main === module) {
  runDailyHealth({ post: !process.argv.includes('--no-post'), dryRun: process.argv.includes('--dry-run') }).then((r) => {
    console.log(JSON.stringify(r.card, null, 2));
    process.exit(r.report.ok ? 0 : 1);
  }).catch((e) => { console.error('health failed:', e.stack || e.message); process.exit(2); });
}

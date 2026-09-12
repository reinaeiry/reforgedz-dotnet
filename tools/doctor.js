#!/usr/bin/env node
// Is this shop deployment healthy and complete? One command, every integration.
//
//   npm run doctor               everything that can be checked without touching
//                                game files or walking Discord members (~20 s)
//   npm run doctor -- --deep     also compare purchases.json and game.admins on
//                                every server against the database, and every
//                                owed Discord role against what members hold
//   npm run doctor -- --offline  only what needs no network: config, database,
//                                files, backups. For a freshly restored copy.
//   npm run doctor -- --json     machine-readable
//
// Exit code 1 if anything FAILs. Also served as GET /api/shop/admin/doctor.
//
// Every check is read-only. SHOP_REHEARSAL=1 turns a blanked outbound
// credential into a SKIP instead of a FAIL, so a restored copy can be judged
// on what it is meant to have.
const fs = require('fs');
const path = require('path');
const APP_DIR = path.join(__dirname, '..');
// ENV_FILE lets a rehearsal copy be judged from its own env without touching .env.
if (require.main === module) require('dotenv').config({ path: process.env.ENV_FILE || path.join(APP_DIR, '.env'), quiet: true });

const Database = require('better-sqlite3');
const { DATA_DIR, dataPath } = require('../dataDir');
const manifest = require('./lib/envManifest');
const { gitSha } = require('./lib/version');
const backup = require('./backup');

const REHEARSAL = process.env.SHOP_REHEARSAL === '1';
const CHECK_TIMEOUT_MS = 25000;

const hrs = (ms) => (ms / 3600000).toFixed(1) + ' h';
const mins = (ms) => Math.round(ms / 60000) + ' min';

function result(status, detail) { return { status, detail }; }
const ok = (d) => result('ok', d);
const warn = (d) => result('warn', d);
const fail = (d) => result('fail', d);
const skip = (d) => result('skip', d);

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms); })
  ]);
}

async function fetchJson(url, opts = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(t);
  }
}

// A read-only handle on the live database, opened per check and closed after.
function withDb(fn) {
  const p = dataPath('shop.db');
  if (!fs.existsSync(p)) throw new Error(`no database at ${p}`);
  const db = new Database(p, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}

// ---------------------------------------------------------------------------
// The checks. Each returns {status, detail}; throwing counts as a fail.
// ---------------------------------------------------------------------------

const CHECKS = [];
function check(id, group, opts, fn) { CHECKS.push({ id, group, ...opts, fn }); }

check('env.vars', 'config', { offline: true }, async () => {
  const missing = [];
  const blankedForRehearsal = [];
  for (const v of manifest.VARS) {
    if (!v.required) continue;
    const val = process.env[v.name];
    if (val && String(val).trim()) continue;
    if (REHEARSAL && manifest.REHEARSAL_BLANK.includes(v.name)) blankedForRehearsal.push(v.name);
    else missing.push(v.name);
  }
  const dead = manifest.DEAD.filter(n => process.env[n] != null);
  const notes = [];
  if (dead.length) notes.push(`retired variables still set: ${dead.join(', ')}`);
  const ss = process.env.SESSION_SECRET || '';
  if (ss && (ss.length < 16 || ss === 'dev-secret-change-me')) return fail('SESSION_SECRET is weak or the default; console accounts would be forgeable');
  if (missing.length) return fail(`missing: ${missing.join(', ')}${notes.length ? '; ' + notes.join('; ') : ''}`);
  if (!process.env.GAME_SERVER_HOST_FINGERPRINTS && !REHEARSAL) notes.push('GAME_SERVER_HOST_FINGERPRINTS unset: game-host SSH keys are accepted unchecked');
  if (!process.env.BACKUP_OFFSITE && !REHEARSAL) notes.push('BACKUP_OFFSITE unset: backups stay on this box only');
  const base = `${manifest.VARS.filter(v => v.required).length} required present` + (blankedForRehearsal.length ? `; blanked for rehearsal: ${blankedForRehearsal.length}` : '');
  return notes.length ? warn(`${base}; ${notes.join('; ')}`) : ok(base);
});

check('env.example', 'config', { offline: true }, async () => {
  const p = path.join(APP_DIR, '.env.example');
  if (!fs.existsSync(p)) return warn('.env.example missing from the checkout');
  const names = new Set(manifest.parseEnvFile(fs.readFileSync(p, 'utf8')).map(([k]) => k));
  const absent = manifest.VARS.map(v => v.name).filter(n => !names.has(n));
  return absent.length ? warn(`template lacks: ${absent.join(', ')} (run npm run env:example)`) : ok(`template lists all ${manifest.VARS.length} variables`);
});

check('db.file', 'database', { offline: true }, async () => withDb((db) => {
  const mode = db.pragma('journal_mode', { simple: true });
  const integ = db.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check).join('; ');
  if (integ !== 'ok') return fail(`integrity_check: ${integ}`);
  const c = (sql) => db.prepare(sql).get().c;
  const users = c('SELECT COUNT(*) c FROM users');
  const orders = c('SELECT COUNT(*) c FROM orders');
  const active = c("SELECT COUNT(*) c FROM orders WHERE status='completed' AND (effective_until IS NULL OR effective_until > unixepoch())");
  const detail = `integrity ok, journal ${mode}, ${users} users, ${orders} orders, ${active} active entitlements`;
  return mode === 'wal' ? ok(detail) : warn(detail + ' (expected wal)');
}));

check('db.schema', 'database', { offline: true }, async () => withDb((db) => {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  const need = ['users', 'products', 'orders', 'priority_queue_grants', 'config_admin_sync_state', 'subscription_billing_issues', 'console_relink_tokens', 'accounts', 'account_identities', 'discord_role_events'];
  const missingTables = need.filter(t => !tables.has(t));
  const col = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c);
  const needCols = [['orders', 'subscription_ended_reason'], ['orders', 'effective_until'], ['users', 'console_lock_gen'], ['users', 'account_id']];
  const missingCols = needCols.filter(([t, c]) => tables.has(t) && !col(t, c)).map(([t, c]) => `${t}.${c}`);
  if (missingTables.length || missingCols.length) return fail(`migrations not applied: ${[...missingTables, ...missingCols].join(', ')} (boot the app once)`);
  return ok(`${need.length} tables, latest columns present`);
}));

check('files', 'files', { offline: true }, async () => {
  const notes = [];
  const probe = path.join(DATA_DIR, `.doctor-write-${process.pid}`);
  try { fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe); } catch (e) { return fail(`DATA_DIR ${DATA_DIR} not writable: ${e.message}`); }
  for (const d of ['uploads', 'backups']) {
    const p = dataPath(d);
    if (!fs.existsSync(p)) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) { notes.push(`${d}/ cannot be created: ${e.message}`); } }
  }
  if (!fs.existsSync(dataPath('sessions-store.db'))) notes.push('no sessions-store.db yet (nobody has signed in on this copy)');
  if (!fs.existsSync(path.join(APP_DIR, 'radio'))) notes.push('radio/ missing (Modest AI Radio will be empty)');
  if (!fs.existsSync(path.join(APP_DIR, 'public', 'downloads'))) notes.push('public/downloads missing (NattiiGuard installer 404s)');
  return notes.length ? warn(`DATA_DIR ${DATA_DIR} writable; ${notes.join('; ')}`) : ok(`DATA_DIR ${DATA_DIR} writable, uploads/ backups/ present`);
});

check('backup.local', 'backups', { offline: true }, async () => {
  const s = backup.lastBackupStatus();
  const daily = backup.listSorted(dataPath('backups', 'daily'));
  if (!s) return daily.length ? warn(`${daily.length} daily snapshots but no last-backup.json`) : warn('no backup has run yet on this copy');
  if (s.host && s.host !== require('os').hostname()) return warn(`last recorded backup ran on ${s.host} ${hrs(s.ageMs)} ago; this copy has not backed up yet (first run 90 s after boot)`);
  if (!s.ok) return fail(`last run failed: ${s.errors.join('; ')}`);
  if (s.stale) return fail(`last backup ${hrs(s.ageMs)} ago (${s.finishedAt}); expected nightly`);
  return ok(`${hrs(s.ageMs)} ago, ${s.bytes} bytes, ${daily.length} daily kept`);
});

check('backup.offsite', 'backups', { offline: true, deepTimeoutMs: 60000 }, async ({ deep }) => {
  const targets = backup.offsiteTargets();
  if (!targets.length) return REHEARSAL ? skip('no offsite in rehearsal') : warn('BACKUP_OFFSITE empty: nothing leaves this box');
  const s = backup.lastBackupStatus();
  if (!s) return warn(`targets ${targets.join(',')} configured, no run recorded yet`);
  const bad = [];
  const good = [];
  for (const t of targets) {
    const r = s.offsite && s.offsite[t];
    if (!r) bad.push(`${t}: not attempted`);
    else if (!r.ok) bad.push(`${t}: ${r.error}`);
    else if (Date.now() - new Date(r.at).getTime() > backup.STALE_AFTER_MS) bad.push(`${t}: last copy ${hrs(Date.now() - new Date(r.at).getTime())} ago`);
    else good.push(`${t} ${hrs(Date.now() - new Date(r.at).getTime())} ago`);
  }
  if (deep) {
    if (targets.includes('r2')) {
      try {
        const r2 = require('./lib/r2');
        const objs = (await r2.listObjects()).filter(o => /shop-\d{8}T\d{6}Z\.db\.gz$/.test(o.key));
        if (!objs.length) bad.push('r2: bucket holds no snapshots');
        else good.push(`r2 bucket newest ${hrs(Date.now() - objs[0].lastModified)} ago (${objs.length} kept)`);
      } catch (e) { bad.push(`r2 list: ${e.message}`); }
    }
    if (targets.includes('na')) {
      try {
        const remote = require('./lib/remote');
        const dir = process.env.BACKUP_NA_DIR || '/root/reforgedz-shop-backups';
        const newest = await remote.withEntry((conn) => remote.newestRemote(conn, 'na', dir, 'shop-*.db.gz'));
        if (!newest) bad.push('na: directory holds no snapshots');
        else good.push(`na newest ${hrs(Date.now() - newest.mtime)} ago`);
      } catch (e) { bad.push(`na check: ${e.message}`); }
    }
  }
  return bad.length ? fail(`${bad.join('; ')}${good.length ? '; ok: ' + good.join(', ') : ''}`) : ok(good.join(', '));
});

async function paypalCheck(testMode) {
  const paypal = require('../paypal');
  const label = testMode ? 'sandbox' : 'live';
  if (!paypal.isConfigured(testMode)) {
    if (REHEARSAL) return skip(`${label} credentials blanked for rehearsal`);
    return testMode ? warn('sandbox credentials not set (admin test purchases unavailable)') : fail('live credentials not set');
  }
  const url = `${(process.env.BASE_URL || '').replace(/\/+$/, '')}/api/shop/paypal/webhook`;
  const hooks = await paypal.listWebhooks(testMode);
  const mine = hooks.find(h => h.url === url);
  if (!mine) return fail(`${label}: signed in, but no webhook registered for ${url} (${hooks.length} others). Boot the app once to register it.`);
  const have = new Set((mine.event_types || []).map(e => e.name));
  const missing = paypal.WEBHOOK_EVENTS.filter(n => !have.has(n));
  if (missing.length) return fail(`${label}: webhook ${mine.id} lacks ${missing.join(', ')}`);
  // A stray webhook URL can itself be a credential (a Discord webhook, say); show where it points, not its token.
  const strays = hooks.filter(h => h.url !== url).map(h => String(h.url).replace(/\/([^/]{16,})$/, '/…'));
  return strays.length ? warn(`${label}: webhook ${mine.id} bound with all ${have.size} events; other webhooks on this app: ${strays.join(', ')}`) : ok(`${label}: webhook ${mine.id}, ${have.size} events`);
}
check('paypal.live', 'payments', {}, () => paypalCheck(false));
check('paypal.sandbox', 'payments', {}, () => paypalCheck(true));

check('smtp', 'email', {}, async () => {
  if (!process.env.SMTP_HOST) return REHEARSAL ? skip('SMTP blanked for rehearsal') : fail('SMTP_HOST not set: no receipts or billing emails');
  const nodemailer = require('nodemailer');
  const tx = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000
  });
  await tx.verify();
  return ok(`${process.env.SMTP_USER || 'anonymous'}@${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587} accepts our login`);
});

check('discord.bot', 'discord', {}, async () => {
  if (!process.env.DISCORD_BOT_TOKEN) return REHEARSAL ? skip('bot token blanked for rehearsal') : fail('DISCORD_BOT_TOKEN not set: no entitlement roles');
  const discord = require('../discord');
  discord.invalidateRolesCache();
  const r = await discord.fetchAssignableRoles();
  if (r.error) return fail(`Discord: ${r.error}`);
  const assignable = new Map(r.roles.map(x => [x.id, x]));
  const products = withDb(db => db.prepare('SELECT title, discord_role_id FROM products WHERE active=1 AND discord_role_id IS NOT NULL').all());
  const bad = products.filter(p => !assignable.has(String(p.discord_role_id))).map(p => `${p.title} (${p.discord_role_id})`);
  if (bad.length) return fail(`role missing or above the bot's top role: ${bad.join(', ')}`);
  return ok(`bot top role position ${r.botPosition}; ${products.length} product roles assignable: ${products.map(p => assignable.get(String(p.discord_role_id)).name).join(', ')}`);
});

check('discord.webhook', 'discord', {}, async () => {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return REHEARSAL ? skip('webhook blanked for rehearsal') : fail('DISCORD_WEBHOOK_URL not set: no purchase cards');
  const r = await fetchJson(url);
  if (!r.ok || !r.json || !r.json.channel_id) return fail(`webhook lookup ${r.status}`);
  return ok(`"${r.json.name}" into channel ${r.json.channel_id}`);
});

check('ssh.servers', 'game servers', { timeoutMs: 60000, deepTimeoutMs: 150000 }, async ({ deep }) => {
  if (!process.env.SSH_PRIVATE_KEY_B64) return REHEARSAL ? skip('SSH key blanked for rehearsal') : fail('SSH_PRIVATE_KEY_B64 not set: no entitlement sync');
  const remote = require('./lib/remote');
  const sync = require('../sync');
  const { listServers } = require('../gameServers');
  const servers = listServers();
  if (!servers.length) return fail('no servers resolved from GAME_SERVER_* paths');
  const notes = [];
  const problems = [];
  await remote.withEntry(async (conn, entry) => {
    notes.push(`entry ${entry.user}@${entry.host}${sync.PINNED_FINGERPRINTS.length ? ' (host key pinned)' : ' (host key NOT pinned)'}`);
    let buckets = null;
    let pq = null;
    if (deep) { buckets = sync.buildPerServerPurchaseBuckets(); pq = sync.buildPriorityQueueGuidsPerServer(); }
    for (const s of servers) {
      try {
        const p = await remote.probeServerPaths(conn, s);
        if (!p.dir) { problems.push(`${s.id}: shop path missing (${s.path})`); continue; }
        if (!p.config) problems.push(`${s.id}: config.json missing`);
        if (!p.purchasesMtime) problems.push(`${s.id}: purchases.json never written`);
        else if (Date.now() - p.purchasesMtime > 30 * 60000) notes.push(`${s.id} purchases.json ${mins(Date.now() - p.purchasesMtime)} old`);
        if (deep && p.purchasesMtime && p.config) {
          const remoteList = JSON.parse((await remote.readRemoteFile(conn, s, s.path + '/purchases.json')).toString('utf8'));
          const want = new Set((buckets[s.id] || []).map(e => `${e.guid}|${e.item}`));
          const have = new Set(remoteList.map(e => `${e.guid}|${e.item}`));
          const missing = [...want].filter(k => !have.has(k)).length;
          const extra = [...have].filter(k => !want.has(k)).length;
          if (missing || extra) problems.push(`${s.id}: purchases.json differs (${missing} missing, ${extra} extra)`);
          const cfg = JSON.parse((await remote.readRemoteFile(conn, s, s.configPath)).toString('utf8'));
          const admins = new Set(Array.isArray(cfg.game && cfg.game.admins) ? cfg.game.admins : []);
          const pqMissing = [...(pq[s.id] || [])].filter(g => !admins.has(g)).length;
          if (pqMissing) problems.push(`${s.id}: ${pqMissing} priority-queue GUIDs not in game.admins`);
          else notes.push(`${s.id} exact (${want.size} entries, ${(pq[s.id] || new Set()).size} PQ)`);
        }
      } catch (e) {
        problems.push(`${s.id}: ${e.message.split('\n')[0]}`);
      }
    }
  });
  if (problems.length) return fail(`${problems.join('; ')}${notes.length ? ' | ' + notes.join(', ') : ''}`);
  return sync.PINNED_FINGERPRINTS.length ? ok(`${servers.length} servers reachable; ${notes.join(', ')}`) : warn(`${servers.length} servers reachable; ${notes.join(', ')}`);
});

check('sync.recent', 'game servers', { offline: true }, async () => withDb((db) => {
  if (REHEARSAL && !process.env.SSH_PRIVATE_KEY_B64) return skip('no sync in rehearsal');
  const row = db.prepare('SELECT MAX(updated_at) AS t, COUNT(*) AS n FROM config_admin_sync_state').get();
  if (!row || !row.t) return warn('no sync has recorded state yet');
  const age = Date.now() - row.t * 1000;
  if (age > 60 * 60000) return fail(`last successful admins sync ${mins(age)} ago (${row.n} servers); the 10-minute timer is not running`);
  if (age > 15 * 60000) return warn(`last successful admins sync ${mins(age)} ago`);
  return ok(`last successful admins sync ${mins(age)} ago across ${row.n} servers`);
}));

check('panel', 'integrations', {}, async () => {
  const url = (process.env.PTERODACTYL_PANEL_URL || '').replace(/\/+$/, '');
  const key = process.env.PTERODACTYL_CLIENT_API_KEY;
  if (!url || !key) return REHEARSAL ? skip('panel blanked for rehearsal') : fail('PTERODACTYL_PANEL_URL / PTERODACTYL_CLIENT_API_KEY not set: no status tiles');
  const r = await fetchJson(`${url}/api/client?per_page=1`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  if (!r.ok) return fail(`${url} answered ${r.status}`);
  return ok(`${url} lists ${r.json && r.json.meta && r.json.meta.pagination ? r.json.meta.pagination.total : '?'} servers`);
});

check('battlemetrics', 'integrations', {}, async () => {
  const tk = process.env.BATTLEMETRICS_TOKEN;
  if (!tk) return REHEARSAL ? skip('token blanked for rehearsal') : fail('BATTLEMETRICS_TOKEN not set: console sign-in and player counts break');
  const r = await fetchJson('https://api.battlemetrics.com/servers?filter[search]=ReforgedZ&page[size]=1', { headers: { Authorization: `Bearer ${tk}` } });
  if (!r.ok) return fail(`BattleMetrics answered ${r.status}`);
  return ok('token accepted');
});

check('steam', 'integrations', {}, async () => {
  const key = process.env.STEAM_API_KEY;
  const id = (process.env.ADMIN_STEAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
  if (!key) return REHEARSAL ? skip('key blanked for rehearsal') : fail('STEAM_API_KEY not set: Steam sign-in breaks');
  if (!id) return warn('ADMIN_STEAM_IDS empty; cannot exercise the key');
  const r = await fetchJson(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${id}`);
  if (!r.ok) return fail(`Steam Web API answered ${r.status}`);
  return ok('key accepted');
});

check('public', 'public', {}, async () => {
  const base = (process.env.BASE_URL || '').replace(/\/+$/, '');
  if (!base) return fail('BASE_URL not set');
  const v = await fetchJson(`${base}/api/shop/version`);
  const here = gitSha();
  if (!v.ok) return fail(`${base}/api/shop/version answered ${v.status}: is this copy the one behind the domain?`);
  const there = v.json && v.json.sha;
  const prods = await fetchJson(`${base}/api/shop/products`);
  const n = prods.ok && Array.isArray(prods.json) ? prods.json.length : null;
  if (here && there && here !== there) return warn(`${base} serves ${String(there).slice(0, 7)}, this checkout is ${here.slice(0, 7)} (another instance is behind the domain, or a deploy is pending)`);
  return ok(`${base} serves ${there ? String(there).slice(0, 7) : 'unknown'}, ${n == null ? '?' : n} products`);
});

check('billing.issues', 'payments', { offline: true }, async () => withDb((db) => {
  const r = db.prepare('SELECT COUNT(*) n, MIN(first_seen_at) oldest FROM subscription_billing_issues WHERE resolved_at IS NULL').get();
  if (!r.n) return ok('no open billing issues');
  return ok(`${r.n} open, oldest ${r.oldest ? Math.round((Date.now() / 1000 - r.oldest) / 86400) + ' d' : '?'} (players failing renewal; expected, not a fault)`);
}));

check('roles.parity', 'discord', { deepOnly: true, deepTimeoutMs: 240000 }, async () => {
  if (!process.env.DISCORD_BOT_TOKEN) return skip('no bot token');
  const discord = require('../discord');
  const owed = withDb(db => db.prepare(`
    SELECT DISTINCT u.discord_id, p.discord_role_id, p.title
    FROM orders o JOIN users u ON u.steam_id = o.steam_id JOIN products p ON p.id = o.product_id
    WHERE o.status='completed' AND p.discord_role_id IS NOT NULL AND u.discord_id IS NOT NULL AND u.discord_id != ''
      AND (o.effective_until IS NULL OR o.effective_until > unixepoch())`).all());
  const byUser = new Map();
  for (const r of owed) { if (!byUser.has(r.discord_id)) byUser.set(r.discord_id, []); byUser.get(r.discord_id).push(r); }
  let held = 0, missing = 0, left = 0;
  const missingNames = [];
  for (const [uid, rows] of byUser) {
    const roles = await discord.getMemberRoleIds(uid);
    if (roles == null) { left += rows.length; continue; }
    for (const r of rows) {
      if (roles.includes(String(r.discord_role_id))) held++;
      else { missing++; if (missingNames.length < 5) missingNames.push(`${uid}:${r.title}`); }
    }
    await new Promise(res => setTimeout(res, 120));
  }
  const detail = `${held} held, ${missing} missing, ${left} owed to members who left`;
  return missing ? warn(`${detail}; missing: ${missingNames.join(', ')}`) : ok(detail);
});

// ---------------------------------------------------------------------------

async function runDoctor({ deep = false, offline = false } = {}) {
  const ranAt = new Date().toISOString();
  const selected = CHECKS.filter(c => (offline ? c.offline : true) && (c.deepOnly ? deep : true));
  const results = await Promise.all(selected.map(async (c) => {
    const t0 = Date.now();
    try {
      const r = await withTimeout(Promise.resolve(c.fn({ deep })), (deep && c.deepTimeoutMs) || c.timeoutMs || CHECK_TIMEOUT_MS);
      return { id: c.id, group: c.group, status: r.status, detail: r.detail, ms: Date.now() - t0 };
    } catch (e) {
      return { id: c.id, group: c.group, status: 'fail', detail: (e && e.message) || String(e), ms: Date.now() - t0 };
    }
  }));
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) summary[r.status] = (summary[r.status] || 0) + 1;
  return {
    ranAt, deep, offline, rehearsal: REHEARSAL, dataDir: DATA_DIR, version: gitSha(),
    ok: summary.fail === 0, summary, checks: results
  };
}

function printReport(report) {
  const tag = { ok: ' OK ', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };
  console.log(`shop doctor ${report.ranAt}  version ${report.version ? report.version.slice(0, 7) : '?'}  ${report.rehearsal ? 'REHEARSAL  ' : ''}${report.deep ? 'deep' : report.offline ? 'offline' : 'standard'}`);
  console.log(`data dir ${report.dataDir}`);
  console.log('');
  for (const r of report.checks) {
    console.log(`[${tag[r.status]}] ${r.id.padEnd(16)} ${r.detail}${r.ms > 3000 ? `  (${(r.ms / 1000).toFixed(1)}s)` : ''}`);
  }
  console.log('');
  const s = report.summary;
  console.log(`${report.ok ? 'HEALTHY' : 'PROBLEMS'}: ${s.ok} ok, ${s.warn} warn, ${s.fail} fail, ${s.skip} skipped`);
}

module.exports = { runDoctor, printReport };

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  runDoctor({ deep: args.has('--deep'), offline: args.has('--offline') }).then((report) => {
    if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    process.exit(report.ok ? 0 : 1);
  }).catch((e) => {
    console.error('doctor crashed:', e && (e.stack || e.message));
    process.exit(2);
  });
}

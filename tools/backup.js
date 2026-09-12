#!/usr/bin/env node
// Nightly backup of the shop database, kept on this box and copied off it.
//
//   npm run backup            take one now (reason "manual")
//   require('./tools/backup').scheduleNightlyBackups()   from server.js
//
// Layout under DATA_DIR/backups:
//   daily/shop-<UTC stamp>.db.gz     newest 14 kept
//   weekly/shop-<UTC stamp>.db.gz    Sunday's copy, newest 8 kept
//   last-backup.json                 what happened last time (the doctor reads it)
//
// Off the box (BACKUP_OFFSITE, comma-separated):
//   na   the NA game host, over the same SSH hop the entitlement sync uses
//   r2   Cloudflare R2, kept 60 newest
//
// Everything is best-effort past the local snapshot: a failed copy is recorded
// and reported, never thrown into the app.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { dataPath, ensureDataDir } = require('../dataDir');
const { snapshotDb, integrityCheck, sha256File } = require('./lib/snapshot');

const KEEP_DAILY = 14;
const KEEP_WEEKLY = 8;
const KEEP_R2 = 60;
const KEEP_NA_DAYS = 45;
const NIGHTLY_UTC = { hour: 3, minute: 30 };
const STALE_AFTER_MS = 26 * 60 * 60 * 1000;

function statusFile() { return dataPath('backups', 'last-backup.json'); }

function stampNow() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); // 20260912T033000Z
}

function listSorted(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^shop-\d{8}T\d{6}Z\.db\.gz$/.test(f)).sort().reverse();
}

function prune(dir, keep) {
  const files = listSorted(dir);
  for (const f of files.slice(keep)) fs.unlinkSync(path.join(dir, f));
  return files.slice(0, keep);
}

function offsiteTargets() {
  return (process.env.BACKUP_OFFSITE || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

async function copyToNa(file, name) {
  const remote = require('./lib/remote');
  const dir = process.env.BACKUP_NA_DIR || '/root/reforgedz-shop-backups';
  return remote.withEntry(async (conn) => {
    const sha = await remote.pushFile(conn, 'na', dir, name, fs.readFileSync(file));
    const kept = await remote.pruneRemote(conn, 'na', dir, 'shop-*.db.gz', KEEP_NA_DAYS);
    return { sha256: sha, kept: kept.length, dir };
  });
}

async function copyToR2(file, name) {
  const r2 = require('./lib/r2');
  if (!r2.isConfigured()) throw new Error('R2 not configured');
  const key = await r2.putObject(name, fs.readFileSync(file), 'application/gzip');
  const objects = await r2.listObjects();
  const ours = objects.filter(o => /shop-\d{8}T\d{6}Z\.db\.gz$/.test(o.key));
  for (const o of ours.slice(KEEP_R2)) await r2.deleteObject(o.key).catch(() => {});
  return { key, kept: Math.min(ours.length, KEEP_R2), bucket: r2.cfg().bucket };
}

async function runBackup({ reason = 'manual' } = {}) {
  const startedAt = new Date();
  const dailyDir = ensureDataDir('backups', 'daily');
  const weeklyDir = ensureDataDir('backups', 'weekly');
  const stamp = stampNow();
  const name = `shop-${stamp}.db.gz`;
  const rawPath = path.join(dailyDir, `shop-${stamp}.db`);
  const gzPath = path.join(dailyDir, name);

  const status = { reason, host: require('os').hostname(), startedAt: startedAt.toISOString(), finishedAt: null, ok: false, file: null, bytes: 0, sha256: null, integrity: null, local: {}, offsite: {}, errors: [] };
  try {
    snapshotDb(dataPath('shop.db'), rawPath);
    const integrity = integrityCheck(rawPath);
    status.integrity = integrity.message;
    if (!integrity.ok) throw new Error(`Snapshot failed integrity check: ${integrity.message}`);
    fs.writeFileSync(gzPath, zlib.gzipSync(fs.readFileSync(rawPath), { level: 9 }));
    fs.unlinkSync(rawPath);
    status.file = gzPath;
    status.bytes = fs.statSync(gzPath).size;
    status.sha256 = sha256File(gzPath);

    if (startedAt.getUTCDay() === 0) fs.copyFileSync(gzPath, path.join(weeklyDir, name));
    status.local.daily = prune(dailyDir, KEEP_DAILY).length;
    status.local.weekly = prune(weeklyDir, KEEP_WEEKLY).length;

    for (const target of offsiteTargets()) {
      const t0 = Date.now();
      try {
        const r = target === 'na' ? await copyToNa(gzPath, name)
          : target === 'r2' ? await copyToR2(gzPath, name)
          : (() => { throw new Error(`unknown target "${target}"`); })();
        status.offsite[target] = { ok: true, at: new Date().toISOString(), ms: Date.now() - t0, ...r };
      } catch (e) {
        status.offsite[target] = { ok: false, at: new Date().toISOString(), ms: Date.now() - t0, error: e.message };
        status.errors.push(`${target}: ${e.message}`);
      }
    }
    status.ok = true;
  } catch (e) {
    status.errors.push(e.message);
    try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath); } catch { /* best effort */ }
  }
  status.finishedAt = new Date().toISOString();
  try {
    ensureDataDir('backups');
    fs.writeFileSync(statusFile(), JSON.stringify(status, null, 2));
  } catch (e) {
    status.errors.push(`status file: ${e.message}`);
  }
  const off = Object.entries(status.offsite).map(([k, v]) => `${k}=${v.ok ? 'ok' : 'FAILED'}`).join(' ');
  console.log(`[backup] ${status.ok ? 'done' : 'FAILED'} (${reason}) ${status.file ? path.basename(status.file) : ''} ${status.bytes} bytes ${off}${status.errors.length ? ' errors: ' + status.errors.join('; ') : ''}`);
  return status;
}

// The last recorded run, with ages worked out for the doctor. Null if never run.
function lastBackupStatus() {
  try {
    const s = JSON.parse(fs.readFileSync(statusFile(), 'utf8'));
    const finished = s.finishedAt ? new Date(s.finishedAt) : null;
    s.ageMs = finished ? Date.now() - finished.getTime() : null;
    s.stale = s.ageMs == null || s.ageMs > STALE_AFTER_MS;
    return s;
  } catch {
    return null;
  }
}

function msUntilNextNightly(now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), NIGHTLY_UTC.hour, NIGHTLY_UTC.minute, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

let scheduled = false;
function scheduleNightlyBackups() {
  if (scheduled) return;
  scheduled = true;
  const arm = () => setTimeout(() => {
    runBackup({ reason: 'nightly' }).catch(e => console.error('[backup] nightly failed:', e.message)).finally(arm);
  }, msUntilNextNightly());
  arm();
  // A deploy that lands after a missed night should not wait until tomorrow.
  const last = lastBackupStatus();
  if (!last || last.stale) {
    setTimeout(() => runBackup({ reason: last ? 'catch-up' : 'first' }).catch(e => console.error('[backup] catch-up failed:', e.message)), 90 * 1000);
  }
  console.log(`[backup] nightly at ${String(NIGHTLY_UTC.hour).padStart(2, '0')}:${String(NIGHTLY_UTC.minute).padStart(2, '0')} UTC, offsite: ${offsiteTargets().join(',') || 'none'}`);
}

module.exports = { runBackup, lastBackupStatus, scheduleNightlyBackups, offsiteTargets, listSorted, STALE_AFTER_MS };

if (require.main === module) {
  require('dotenv').config({ path: process.env.ENV_FILE || path.join(__dirname, '..', '.env'), quiet: true });
  runBackup({ reason: 'manual' }).then(s => process.exit(s.ok && !s.errors.length ? 0 : 1));
}

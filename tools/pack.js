#!/usr/bin/env node
// Everything needed to stand this shop up somewhere else, in one file.
//
//   npm run pack                              -> DATA_DIR/packs/shop-pack-<stamp>-<sha>.tar.gz
//   npm run pack -- --out /some/dir
//   npm run pack -- --passphrase-file /path   encrypt .env with this passphrase
//   PACK_PASSPHRASE=... npm run pack          same, from the environment
//   npm run pack -- --no-env                  leave .env out on purpose
//
// Contents:
//   MANIFEST.json      commit, node, counts, sha256 of every file, variable names
//   shop.db            consistent snapshot (VACUUM INTO), integrity-checked
//   sessions-store.db  snapshot, so nobody is signed out by the move
//   uploads/           custom-flag images
//   *.json stats       radio and NattiiGuard counters, backups/last-backup.json
//   env.enc.json       .env encrypted with the passphrase (AES-256-GCM, scrypt)
//   env.names.json     the variable names present, always, so a restore without
//                      the passphrase still knows what it is missing
//
// The pack never contains a plaintext secret. Without a passphrase, .env is
// left out and the manifest says so loudly.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const APP_DIR = path.join(__dirname, '..');
require('dotenv').config({ path: process.env.ENV_FILE || path.join(APP_DIR, '.env'), quiet: true });

const { DATA_DIR, dataPath, ensureDataDir } = require('../dataDir');
const { snapshotDb, integrityCheck, sha256File, describeDb } = require('./lib/snapshot');
const secretbox = require('./lib/secretbox');
const manifestLib = require('./lib/envManifest');
const { gitSha } = require('./lib/version');

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
const hasFlag = (f) => process.argv.includes(f);

function passphrase() {
  const file = arg('--passphrase-file');
  if (file) return fs.readFileSync(file, 'utf8').trim();
  if (process.env.PACK_PASSPHRASE) return process.env.PACK_PASSPHRASE.trim();
  return null;
}

function copyIfExists(src, dest, files) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true });
    for (const f of walk(dest)) files.push(f);
  } else {
    fs.copyFileSync(src, dest);
    files.push(dest);
  }
  return true;
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

function main() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const sha = gitSha();
  const name = `shop-pack-${stamp}-${sha ? sha.slice(0, 7) : 'nogit'}`;
  const outDir = arg('--out') ? path.resolve(arg('--out')) : ensureDataDir('packs');
  const stage = path.join(outDir, name);
  fs.mkdirSync(stage, { recursive: true });
  const files = [];
  const notes = [];

  // Database, consistent and verified.
  const dbSrc = dataPath('shop.db');
  if (!fs.existsSync(dbSrc)) throw new Error(`no database at ${dbSrc}`);
  const dbDest = path.join(stage, 'shop.db');
  snapshotDb(dbSrc, dbDest);
  const integ = integrityCheck(dbDest);
  if (!integ.ok) throw new Error(`snapshot integrity: ${integ.message}`);
  files.push(dbDest);
  const counts = describeDb(dbDest);

  // Sessions (also SQLite WAL), uploads, counters, last backup status.
  const sessSrc = dataPath('sessions-store.db');
  if (fs.existsSync(sessSrc)) { snapshotDb(sessSrc, path.join(stage, 'sessions-store.db')); files.push(path.join(stage, 'sessions-store.db')); }
  else notes.push('no sessions-store.db');
  if (!copyIfExists(dataPath('uploads'), path.join(stage, 'uploads'), files)) notes.push('no uploads/');
  for (const f of ['radio-stats.json', 'nattiiguard-stats.json']) if (!copyIfExists(dataPath(f), path.join(stage, f), files)) notes.push(`no ${f}`);
  copyIfExists(dataPath('backups', 'last-backup.json'), path.join(stage, 'backups', 'last-backup.json'), files);

  // .env: names always, contents only under a passphrase.
  const envPath = process.env.ENV_FILE || path.join(APP_DIR, '.env');
  let envEncrypted = false;
  let envNames = [];
  if (fs.existsSync(envPath)) {
    const text = fs.readFileSync(envPath, 'utf8');
    envNames = manifestLib.parseEnvFile(text).map(([k]) => k);
    const pass = hasFlag('--no-env') ? null : passphrase();
    if (pass) {
      fs.writeFileSync(path.join(stage, 'env.enc.json'), JSON.stringify(secretbox.encrypt(text, pass)));
      files.push(path.join(stage, 'env.enc.json'));
      envEncrypted = true;
    } else {
      notes.push(hasFlag('--no-env') ? '.env left out (--no-env)' : '.env NOT included: no passphrase given (PACK_PASSPHRASE or --passphrase-file)');
    }
    fs.writeFileSync(path.join(stage, 'env.names.json'), JSON.stringify({
      names: envNames,
      secret: envNames.filter(n => manifestLib.isSecret(n)),
      retired: envNames.filter(n => manifestLib.DEAD.includes(n)),
      missingRequired: manifestLib.VARS.filter(v => v.required && !envNames.includes(v.name)).map(v => v.name)
    }, null, 2));
    files.push(path.join(stage, 'env.names.json'));
  } else {
    notes.push('no .env found');
  }

  // Non-secret deployment facts a restore wants to compare against.
  let servers = [];
  try { servers = require('../gameServers').listServers().map(s => ({ id: s.id, region: s.region, host: s.host, port: s.port, user: s.user, path: s.path })); } catch { /* not configured */ }

  const manifest = {
    packVersion: 1,
    name,
    createdAt: new Date().toISOString(),
    host: os.hostname(),
    gitSha: sha,
    node: process.version,
    dataDir: DATA_DIR,
    counts,
    envEncrypted,
    envVariableCount: envNames.length,
    servers,
    hostFingerprintsPinned: !!process.env.GAME_SERVER_HOST_FINGERPRINTS,
    baseUrl: process.env.BASE_URL || null,
    notes,
    files: files.map(f => ({ path: path.relative(stage, f).split(path.sep).join('/'), bytes: fs.statSync(f).size, sha256: sha256File(f) }))
  };
  fs.writeFileSync(path.join(stage, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));

  const tarball = path.join(outDir, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', tarball, '-C', outDir, name], { stdio: 'inherit' });
  fs.rmSync(stage, { recursive: true, force: true });

  console.log(`pack: ${tarball}`);
  console.log(`      ${fs.statSync(tarball).size} bytes, sha256 ${sha256File(tarball)}`);
  console.log(`      commit ${sha || 'unknown'}, ${counts.users} users, ${counts.orders} orders (${counts.activeEntitlements} active), ${counts.products} products`);
  console.log(`      .env ${envEncrypted ? `encrypted (${envNames.length} variables)` : 'NOT INCLUDED'}`);
  for (const n of notes) console.log(`      note: ${n}`);
  if (!envEncrypted && !hasFlag('--no-env')) process.exitCode = 3;
  return tarball;
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('pack failed:', e.message); process.exit(1); }
}

module.exports = { main };

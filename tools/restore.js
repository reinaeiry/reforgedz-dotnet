#!/usr/bin/env node
// Put a pack back: on a new server, or as a rehearsal copy next to the real one.
//
//   npm run restore -- <pack.tar.gz>                          into DATA_DIR
//   npm run restore -- <pack.tar.gz> --into /data             elsewhere
//   npm run restore -- <pack.tar.gz> --passphrase-file /path  also write .env
//   npm run restore -- <pack.tar.gz> --rehearsal --port 3010  a copy that can
//        never charge, email, message or touch a game server: outbound
//        credentials blanked, BASE_URL pointed at localhost, SHOP_REHEARSAL=1
//   --force   overwrite an existing shop.db or .env (never on a live box)
//
// Refuses to overwrite a database or a .env unless told to. Verifies every
// file's sha256 against the manifest and the database's integrity before
// anything is copied into place. Prints what to run next; runs nothing itself.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const APP_DIR = path.join(__dirname, '..');

const { sha256File, integrityCheck, describeDb } = require('./lib/snapshot');
const secretbox = require('./lib/secretbox');
const manifestLib = require('./lib/envManifest');
const { gitSha } = require('./lib/version');

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
const hasFlag = (f) => process.argv.includes(f);

function passphrase() {
  const file = arg('--passphrase-file');
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return (process.env.PACK_PASSPHRASE || '').trim() || null;
}

// Rewrite a .env for a rehearsal copy: blank every outbound credential, point
// the origin at localhost, mark it. Keeps line order and comments.
function rehearsalEnv(text, port, dataDir) {
  const blank = new Set(manifestLib.REHEARSAL_BLANK);
  const set = { BASE_URL: `http://localhost:${port}`, PORT: String(port), SHOP_REHEARSAL: '1', DATA_DIR: dataDir };
  const seen = new Set();
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!m) { out.push(raw); continue; }
    const key = m[1];
    seen.add(key);
    if (key in set) out.push(`${key}=${set[key]}`);
    else if (blank.has(key)) out.push(`${key}=`);
    else out.push(raw);
  }
  for (const [k, v] of Object.entries(set)) if (!seen.has(k)) out.push(`${k}=${v}`);
  return out.join('\n') + '\n';
}

function main() {
  const packFile = process.argv[2];
  if (!packFile || packFile.startsWith('--')) throw new Error('usage: restore.js <pack.tar.gz> [--into dir] [--rehearsal --port N] [--passphrase-file f] [--force]');
  if (!fs.existsSync(packFile)) throw new Error(`no such file: ${packFile}`);
  const rehearsal = hasFlag('--rehearsal');
  const port = parseInt(arg('--port') || '3010', 10);
  const into = path.resolve(arg('--into') || process.env.DATA_DIR || APP_DIR);
  const force = hasFlag('--force');
  const envOut = path.resolve(arg('--env-out') || path.join(APP_DIR, '.env'));

  if (fs.existsSync(path.join(into, 'shop.db')) && !force) throw new Error(`${path.join(into, 'shop.db')} already exists. This is a live database unless you know otherwise; pass --force to overwrite it.`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-restore-'));
  try {
    execFileSync('tar', ['-xzf', packFile, '-C', tmp], { stdio: 'inherit' });
    const dirs = fs.readdirSync(tmp).filter(d => fs.existsSync(path.join(tmp, d, 'MANIFEST.json')));
    if (dirs.length !== 1) throw new Error('pack does not contain exactly one MANIFEST.json');
    const stage = path.join(tmp, dirs[0]);
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'MANIFEST.json'), 'utf8'));
    if (manifest.packVersion !== 1) throw new Error(`unknown pack version ${manifest.packVersion}`);

    // Every byte as recorded.
    for (const f of manifest.files) {
      const p = path.join(stage, ...f.path.split('/'));
      if (!fs.existsSync(p)) throw new Error(`missing from pack: ${f.path}`);
      const got = sha256File(p);
      if (got !== f.sha256) throw new Error(`checksum mismatch: ${f.path}`);
    }
    const integ = integrityCheck(path.join(stage, 'shop.db'));
    if (!integ.ok) throw new Error(`database in pack fails integrity_check: ${integ.message}`);

    const here = gitSha();
    if (manifest.gitSha && here && manifest.gitSha !== here) {
      console.log(`note: pack was taken at ${manifest.gitSha.slice(0, 7)}, this checkout is ${here.slice(0, 7)}. Newer code migrates the database forward on first boot; older code is not supported.`);
    }

    fs.mkdirSync(into, { recursive: true });
    const copied = [];
    for (const f of manifest.files) {
      if (f.path === 'env.enc.json' || f.path === 'env.names.json' || f.path === 'MANIFEST.json') continue;
      const src = path.join(stage, ...f.path.split('/'));
      const dest = path.join(into, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      copied.push(f.path);
    }
    // A restored WAL database must not inherit stale sidecars from a previous copy.
    for (const side of ['shop.db-wal', 'shop.db-shm', 'sessions-store.db-wal', 'sessions-store.db-shm']) {
      const p = path.join(into, side);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    // .env
    let envState = 'not in pack';
    const encPath = path.join(stage, 'env.enc.json');
    if (fs.existsSync(encPath)) {
      const pass = passphrase();
      if (!pass) {
        envState = 'in pack but no passphrase given (PACK_PASSPHRASE or --passphrase-file); not written';
      } else {
        let text = secretbox.decrypt(JSON.parse(fs.readFileSync(encPath, 'utf8')), pass).toString('utf8');
        if (rehearsal) text = rehearsalEnv(text, port, into);
        if (fs.existsSync(envOut) && !force) throw new Error(`${envOut} already exists; pass --force to overwrite it, or --env-out <path>`);
        fs.writeFileSync(envOut, text, { mode: 0o600 });
        envState = `written to ${envOut}${rehearsal ? ' (rehearsal: outbound credentials blanked, BASE_URL=http://localhost:' + port + ')' : ''}`;
      }
    }

    const counts = describeDb(path.join(into, 'shop.db'));
    console.log(`restored ${manifest.name} into ${into}`);
    console.log(`  taken ${manifest.createdAt} on ${manifest.host}, commit ${manifest.gitSha ? manifest.gitSha.slice(0, 7) : '?'}`);
    console.log(`  files: ${copied.join(', ')}`);
    console.log(`  database: ${counts.users} users, ${counts.orders} orders, ${counts.activeEntitlements} active entitlements, ${counts.products} products` +
      (manifest.counts && manifest.counts.orders !== counts.orders ? '  (DIFFERS FROM MANIFEST)' : '  (matches manifest)'));
    console.log(`  .env: ${envState}`);
    console.log('');
    const prefix = into !== APP_DIR ? `DATA_DIR=${into} ` : '';
    console.log('next:');
    console.log('  npm install');
    console.log(`  ${prefix}npm run doctor -- --offline`);
    console.log(`  ${prefix}node server.js         # then the doctor again without --offline`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('restore failed:', e.message); process.exit(1); }
}

module.exports = { main, rehearsalEnv };

// Tests for the staff audit record and the staff in-game ID edit (adminAudit.js)
// against the REAL schema: db.js is loaded with DATA_DIR pointed at a throwaway
// folder, so every migration runs exactly as it will on the live database.
// Needs better-sqlite3, so run it where the shop's node_modules are.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-adminaudit-'));
process.env.DATA_DIR = dataDir;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const audit = require('../adminAudit');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const NOW = 1800000000;
const G1 = '41b8ec0d-f0bd-4c41-b2a9-8213ebe04aac';
const G2 = '9a0c1f2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';

let seq = 0;
function user({ biUid = null, proof = null, name = null } = {}) {
  seq += 1;
  const id = `7656119${String(seq).padStart(10, '0')}`;
  db.prepare('INSERT INTO users (steam_id, persona, bi_uid, bi_uid_proof, bi_uid_name, bi_uid_set_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, `Staffed${seq}`, biUid, proof, name, biUid ? NOW - 100 : null);
  return id;
}
const userRow = (id) => db.prepare('SELECT bi_uid, bi_uid_proof, bi_uid_name, bi_uid_set_at FROM users WHERE steam_id = ?').get(id);
const auditRows = (target) => db.prepare('SELECT * FROM admin_audit WHERE target = ? ORDER BY id').all(target);
const set = (steamId, biUid, extra = {}) => audit.staffSetBiUid(db, {
  steamId, biUid, actor: 'steam:76561190000000999', reason: 'ticket 1234', ip: '203.0.113.9', now: NOW, ...extra
});

// ---- Schema -----------------------------------------------------------------

test('the migration adds the in-game ID proof columns and the audit table with its index', () => {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  for (const c of ['bi_uid_name', 'bi_uid_proof', 'bi_uid_set_at']) assert.ok(cols.includes(c), c);
  assert.deepEqual(db.prepare('PRAGMA table_info(admin_audit)').all().map(c => c.name),
    ['id', 'ts', 'actor', 'action', 'target', 'before_json', 'after_json', 'reason', 'ip']);
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_admin_audit_target'").get();
  assert.match(idx.sql, /admin_audit\s*\(\s*target\s*,\s*ts\s*\)/);
});

test('running every migration again on boot changes nothing', () => {
  const shape = () => db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
  const before = shape();
  for (let i = 0; i < 2; i++) {
    const r = spawnSync(process.execPath, ['-e', "require('./db')"], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
  }
  assert.deepEqual(shape(), before);
});

// ---- The record -------------------------------------------------------------

test('recordAdminAudit stores who, what, the values as JSON, a tidied reason and the address', () => {
  const id = audit.recordAdminAudit(db, {
    actor: 'apikey', action: 'test.thing', target: 'web:abc',
    before: { a: 1 }, after: { a: 2, list: ['x'] }, reason: `  ${'r'.repeat(600)}  `, ip: '198.51.100.7', now: NOW
  });
  const row = db.prepare('SELECT * FROM admin_audit WHERE id = ?').get(id);
  assert.equal(row.ts, NOW);
  assert.equal(row.actor, 'apikey');
  assert.equal(row.action, 'test.thing');
  assert.equal(row.target, 'web:abc');
  assert.deepEqual(JSON.parse(row.before_json), { a: 1 });
  assert.deepEqual(JSON.parse(row.after_json), { a: 2, list: ['x'] });
  assert.equal(row.reason, 'r'.repeat(500));
  assert.equal(row.ip, '198.51.100.7');

  const bare = db.prepare('SELECT * FROM admin_audit WHERE id = ?').get(audit.recordAdminAudit(db, { actor: 'apikey', action: 'test.bare', reason: '   ' }));
  assert.equal(bare.before_json, null);
  assert.equal(bare.reason, null);
  assert.ok(Math.abs(bare.ts - Date.now() / 1000) < 60, 'defaults to now');

  assert.throws(() => audit.recordAdminAudit(db, { action: 'x' }), /actor/);
  assert.throws(() => audit.recordAdminAudit(db, { actor: 'apikey' }), /action/);
});

test('adminActor names a signed-in admin by Steam id and anything else as the shared key', () => {
  const session = (role, authed = true) => ({ isAuthenticated: () => authed, user: { steam_id: '76561190000000001', role } });
  assert.equal(audit.adminActor(session('admin')), 'steam:76561190000000001');
  assert.equal(audit.adminActor(session('user')), 'apikey');
  assert.equal(audit.adminActor(session('admin', false)), 'apikey');
  assert.equal(audit.adminActor({ headers: {} }), 'apikey');
});

// ---- Staff in-game ID edit ----------------------------------------------------

test('staff set a tidied ID: proof staff, name cleared, time stamped, audited with before and after', () => {
  const id = user({ biUid: G2, proof: 'pasted', name: 'OldName' });
  const out = set(id, ` {${G1.toUpperCase()}} `);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { ok: true, bi_uid: G1 });
  assert.deepEqual(userRow(id), { bi_uid: G1, bi_uid_proof: 'staff', bi_uid_name: null, bi_uid_set_at: NOW });

  const rows = auditRows(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, 'steam:76561190000000999');
  assert.equal(rows[0].action, 'bi_uid.set');
  assert.equal(rows[0].reason, 'ticket 1234');
  assert.equal(rows[0].ip, '203.0.113.9');
  assert.deepEqual(JSON.parse(rows[0].before_json), { bi_uid: G2, bi_uid_proof: 'pasted', bi_uid_name: 'OldName', bi_uid_set_at: NOW - 100 });
  assert.deepEqual(JSON.parse(rows[0].after_json), { bi_uid: G1, bi_uid_proof: 'staff', bi_uid_name: null, bi_uid_set_at: NOW });
});

test('the placeholder, junk and non-text are refused and change nothing', () => {
  const id = user({ biUid: G2, proof: 'find_me' });
  const cases = [
    ['00000000-0000-0000-0000-000000000000', /placeholder/],
    ['{00000000-0000-0000-0000-000000000000}', /placeholder/],
    ['41b8ec0d-f0bd-4c41-b2a9', /not a valid in-game ID/],
    ["41b8ec0d-f0bd-4c41-b2a9-8213ebe04aac');alert(1)//", /not a valid in-game ID/],
    [12345, /as text/],
    [{ id: G1 }, /as text/],
  ];
  for (const [value, message] of cases) {
    const out = set(id, value);
    assert.equal(out.status, 400, String(value));
    assert.match(out.body.error, message);
  }
  assert.deepEqual(userRow(id), { bi_uid: G2, bi_uid_proof: 'find_me', bi_uid_name: null, bi_uid_set_at: NOW - 100 });
  assert.equal(auditRows(id).length, 0);
  assert.deepEqual(set('76561199999999999', G1).status, 404);
});

test('an ID on another account needs confirming, lists those accounts, and is audited when confirmed', () => {
  // Its own ID: earlier tests leave G1 and G2 on other accounts in this database.
  const G3 = 'c0ffee00-1234-4abc-9def-00000000c0de';
  const holderA = user({ biUid: G3.toUpperCase() });
  const holderB = user({ biUid: G3 });
  const target = user();
  const refused = set(target, G3);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'id_on_other_account');
  assert.deepEqual(refused.body.otherAccounts, [holderA, holderB].sort());
  assert.equal(userRow(target).bi_uid, null);
  assert.equal(auditRows(target).length, 0);

  assert.equal(set(target, G3, { confirmShared: 'true' }).status, 409, 'only a real true confirms');
  const saved = set(target, G3, { confirmShared: true });
  assert.equal(saved.status, 200);
  assert.equal(userRow(target).bi_uid, G3);
  assert.deepEqual(JSON.parse(auditRows(target)[0].after_json).also_on_accounts, [holderA, holderB].sort());

  assert.equal(set(holderB, G3).status, 409, 'the account itself does not count, the others still do');
});

test('clearing the ID leaves no proof, is audited, and never moves priority queue grants', () => {
  const id = user({ biUid: G2, proof: 'staff' });
  db.prepare("INSERT INTO priority_queue_grants (guid, server_id, removed, granted_by) VALUES (?, 'eu1', 0, 'staff'), (?, 'eu2', 1, 'staff')").run(G2, G2);
  for (const value of ['', '   ', null, undefined]) {
    const out = set(id, value);
    assert.equal(out.status, 200, String(value));
    assert.deepEqual(out.body, { ok: true, bi_uid: null });
  }
  assert.deepEqual(userRow(id), { bi_uid: null, bi_uid_proof: null, bi_uid_name: null, bi_uid_set_at: NOW });
  assert.equal(auditRows(id).length, 4);
  assert.equal(JSON.parse(auditRows(id)[0].before_json).bi_uid, G2);

  assert.equal(set(id, G1, { confirmShared: true }).status, 200);
  assert.deepEqual(
    db.prepare('SELECT guid, server_id, removed FROM priority_queue_grants WHERE guid IN (?, ?) ORDER BY server_id').all(G1, G2),
    [{ guid: G2, server_id: 'eu1', removed: 0 }, { guid: G2, server_id: 'eu2', removed: 1 }]
  );
});

// Tests for the player's own in-game ID save, its proof and the player name stored
// with it (inGameId.js), against the REAL schema: db.js is loaded with DATA_DIR
// pointed at a throwaway folder, so every migration runs exactly as it will on
// the live database.
// Needs better-sqlite3, so run it where the shop's node_modules are.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-ingameid-'));
process.env.DATA_DIR = dataDir;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const ids = require('../inGameId');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const NOW = 1800000000;
const G1 = '41b8ec0d-f0bd-4c41-b2a9-8213ebe04aac';
const G2 = '9a0c1f2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';

let seq = 0;
function user({ platform = 'steam', persona = null, biUid = null, name = null, proof = null } = {}) {
  seq += 1;
  const id = platform === 'web' ? `web:${String(seq).padStart(24, '0')}` : `7656119${String(seq).padStart(10, '0')}`;
  db.prepare('INSERT INTO users (steam_id, persona, platform, bi_uid, bi_uid_name, bi_uid_proof, bi_uid_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, persona || `Steamer${seq}`, platform, biUid, name, proof, biUid ? NOW - 1000 : null);
  return id;
}
const row = (id) => db.prepare('SELECT persona, bi_uid, bi_uid_name, bi_uid_proof, bi_uid_set_at FROM users WHERE steam_id = ?').get(id);

// ---- Saving -----------------------------------------------------------------

test('a Find me pick stores the ID, the player name, proof find_me and the time', () => {
  const id = user({ persona: 'SteamName' });
  const proof = ids.proofForSave({ picked: true, verified: true });
  assert.equal(proof, 'find_me');
  const saved = ids.saveOwnBiUid(db, { steamId: id, biUid: G1, name: '  Rook  ', proof, now: NOW });
  assert.deepEqual(saved, { biUid: G1, name: 'Rook', proof: 'find_me', setAt: NOW });
  assert.deepEqual(row(id), { persona: 'SteamName', bi_uid: G1, bi_uid_name: 'Rook', bi_uid_proof: 'find_me', bi_uid_set_at: NOW });
});

test('a paste is pasted_verified or pasted_unverified, and a new ID never keeps the old name', () => {
  assert.equal(ids.proofForSave({ picked: false, verified: true }), 'pasted_verified');
  assert.equal(ids.proofForSave({ picked: false, verified: false }), 'pasted_unverified');
  const id = user({ biUid: G1, name: 'OldName', proof: 'find_me' });
  ids.saveOwnBiUid(db, { steamId: id, biUid: G2, name: null, proof: 'pasted_unverified', now: NOW + 5 });
  assert.deepEqual(row(id), { persona: row(id).persona, bi_uid: G2, bi_uid_name: null, bi_uid_proof: 'pasted_unverified', bi_uid_set_at: NOW + 5 });
});

test('a website account takes the player name as its display name; other accounts keep theirs', () => {
  const web = user({ platform: 'web', persona: 'Player' });
  ids.saveOwnBiUid(db, { steamId: web, biUid: G1, name: 'Rook', proof: 'pasted_verified', isWeb: true, now: NOW });
  assert.equal(row(web).persona, 'Rook');

  const unnamed = user({ platform: 'web', persona: 'Player' });
  ids.saveOwnBiUid(db, { steamId: unnamed, biUid: G1, name: '   ', proof: 'pasted_unverified', isWeb: true, now: NOW });
  assert.equal(row(unnamed).persona, 'Player', 'no name known, so the display name stays');
  assert.equal(row(unnamed).bi_uid_name, null);

  const steam = user({ persona: 'SteamName' });
  ids.saveOwnBiUid(db, { steamId: steam, biUid: G1, name: 'Rook', proof: 'find_me', now: NOW });
  assert.equal(row(steam).persona, 'SteamName');

  const long = user({ platform: 'web', persona: 'Player' });
  ids.saveOwnBiUid(db, { steamId: long, biUid: G1, name: 'x'.repeat(100), proof: 'find_me', isWeb: true, now: NOW });
  assert.equal(row(long).bi_uid_name.length, 64);
  assert.equal(row(long).persona.length, 64);
});

test('saving refuses the staff proof, an unknown proof, or a missing account or ID', () => {
  const id = user();
  assert.throws(() => ids.saveOwnBiUid(db, { steamId: id, biUid: G1, proof: 'staff', now: NOW }), /not a player proof/);
  assert.throws(() => ids.saveOwnBiUid(db, { steamId: id, biUid: G1, proof: 'pasted', now: NOW }), /not a player proof/);
  assert.throws(() => ids.saveOwnBiUid(db, { steamId: id, biUid: null, proof: 'find_me', now: NOW }));
  assert.throws(() => ids.saveOwnBiUid(db, { steamId: '', biUid: G1, proof: 'find_me', now: NOW }));
  assert.equal(row(id).bi_uid, null);
  assert.deepEqual(ids.PROOFS, ['find_me', 'pasted_verified', 'pasted_unverified', 'staff']);
});

// ---- A name looked up later -------------------------------------------------

test('a looked-up name is stored only while the ID is still the one looked up', () => {
  const id = user({ biUid: G1, proof: 'staff' });
  assert.equal(ids.storeLookedUpName(db, { steamId: id, biUid: G1.toUpperCase(), name: ' Rook ' }), true);
  assert.equal(row(id).bi_uid_name, 'Rook');
  assert.equal(row(id).bi_uid_proof, 'staff', 'a lookup names the player; it proves nothing');
  assert.equal(row(id).bi_uid_set_at, NOW - 1000, 'a lookup is not a change of ID');

  db.prepare('UPDATE users SET bi_uid = ? WHERE steam_id = ?').run(G2, id);
  assert.equal(ids.storeLookedUpName(db, { steamId: id, biUid: G1, name: 'Stranger' }), false);
  assert.equal(row(id).bi_uid_name, 'Rook');

  assert.equal(ids.storeLookedUpName(db, { steamId: id, biUid: G2, name: '' }), false);
  assert.equal(ids.storeLookedUpName(db, { steamId: id, biUid: G2, name: 42 }), false);
  const none = user();
  assert.equal(ids.storeLookedUpName(db, { steamId: none, biUid: G1, name: 'Rook' }), false, 'no ID, nothing to name');
});

// ---- Wording ----------------------------------------------------------------

test('the receipt line names the player in plain words, or is left out', () => {
  const line = ids.recipientLine('Rook');
  assert.match(line, /^Priority queue goes to Rook, /);
  assert.doesNotMatch(line, /[–—]/);
  assert.doesNotMatch(line, /dayz/i);
  for (const nothing of [null, undefined, '', '   ', 7]) assert.equal(ids.recipientLine(nothing), null);
  assert.equal(ids.cleanPlayerName('  a b  '), 'a b');
});

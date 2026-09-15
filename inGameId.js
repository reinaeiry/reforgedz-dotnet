// The player's own in-game ID save, with how it was chosen and the player name
// seen with it (plan J13 and J10).
//
// users.bi_uid is where queue priority and every perk goes, and the account page
// and receipts showed only a raw 36-character ID, so a mistyped or planted ID
// went unnoticed until the queue did not work. Storing the BattleMetrics name
// lets the account page, the confirmation and the receipt say who the priority
// goes to. Storing how the ID was chosen (bi_uid_proof) is the first step towards
// ever relying on one: today nothing does.
//
// Takes the database handle as a parameter and does nothing on require, so the
// tests run it against a throwaway copy of the real schema (test/inGameId.test.js).

// How an ID got onto an account:
//   find_me            the player picked themselves from a Find me search
//   pasted_verified    pasted, and BattleMetrics has seen that ID
//   pasted_unverified  pasted while BattleMetrics could not be asked
//   staff              set by staff (adminAudit.staffSetBiUid)
// None of these proves the ID belongs to the person typing: Find me and a paste
// both show only that the player exists.
const PROOFS = ['find_me', 'pasted_verified', 'pasted_unverified', 'staff'];

// A player name as stored: trimmed, at most 64 characters, or null.
function cleanPlayerName(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, 64);
  return s || null;
}

function proofForSave({ picked, verified }) {
  if (picked) return 'find_me';
  return verified ? 'pasted_verified' : 'pasted_unverified';
}

// Save the player's own in-game ID. The name, proof and time always change with
// the ID, so an old name can never sit next to a new ID. A website account also
// takes the player name as its display name once one is known: that is what the
// account page shows and the name the game-server sync writes.
function saveOwnBiUid(db, { steamId, biUid, name = null, proof, isWeb = false, now }) {
  if (!steamId || !biUid) throw new Error('saving an in-game ID needs the account and the ID');
  if (!PROOFS.includes(proof) || proof === 'staff') throw new Error(`not a player proof: ${proof}`);
  const at = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
  const playerName = cleanPlayerName(name);
  db.prepare(`
    UPDATE users SET bi_uid = ?, bi_uid_name = ?, bi_uid_proof = ?, bi_uid_set_at = ?,
      persona = CASE WHEN ? = 1 AND ? IS NOT NULL THEN ? ELSE persona END
    WHERE steam_id = ?
  `).run(biUid, playerName, proof, at, isWeb ? 1 : 0, playerName, playerName, String(steamId));
  return { biUid, name: playerName, proof, setAt: at };
}

// Store a name looked up later for the account's current ID. Only while the ID is
// still the one that was looked up: the player may have changed it while
// BattleMetrics was answering, and the name must never land on a different ID.
// Returns whether it was stored.
function storeLookedUpName(db, { steamId, biUid, name }) {
  const playerName = cleanPlayerName(name);
  if (!steamId || !biUid || !playerName) return false;
  return db.prepare(`
    UPDATE users SET bi_uid_name = ?
    WHERE steam_id = ? AND bi_uid IS NOT NULL AND lower(bi_uid) = lower(?)
  `).run(playerName, String(steamId), String(biUid)).changes > 0;
}

// The receipt line naming who the priority goes to, or null when no name is known.
function recipientLine(name) {
  const playerName = cleanPlayerName(name);
  if (!playerName) return null;
  return `Priority queue goes to ${playerName}, the player on your in-game ID. If that is not you, change your in-game ID on your account page.`;
}

module.exports = { PROOFS, cleanPlayerName, proofForSave, saveOwnBiUid, storeLookedUpName, recipientLine };

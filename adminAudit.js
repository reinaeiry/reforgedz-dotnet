// A durable record of staff changes to accounts, and the staff in-game ID edit
// that writes one.
//
// requireAdmin's [admin-audit] line names only the method and URL, carries no
// value before or after and no reason, and lives in a container log that rotates
// within days. So once a dispute surfaced ("who moved my queue priority?") there
// was nothing to read. admin_audit keeps that record in the shop database.
//
// Takes the database handle as a parameter and does nothing on require, so the
// tests run it against a throwaway copy of the real schema (test/adminAudit.test.js).
const { asReforgerUuid } = require('./battlemetrics');

// Who acted, in the words requireAdmin logs: a signed-in admin by Steam id, else
// the shared key (the ticket bot and the admin page backend hold it).
function adminActor(req) {
  const signedInAdmin = req && typeof req.isAuthenticated === 'function' && req.isAuthenticated()
    && req.user && req.user.role === 'admin';
  return signedInAdmin ? `steam:${req.user.steam_id}` : 'apikey';
}

function cleanReason(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, 500);
  return s || null;
}

const asJson = (v) => (v == null ? null : JSON.stringify(v));

// One row per staff change. before and after are stored as JSON. Returns the row id.
function recordAdminAudit(db, { actor, action, target = null, before = null, after = null, reason = null, ip = null, now }) {
  if (!actor || !action) throw new Error('an admin audit record needs an actor and an action');
  const ts = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
  return db.prepare(`
    INSERT INTO admin_audit (ts, actor, action, target, before_json, after_json, reason, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ts, String(actor), String(action), target == null ? null : String(target),
    asJson(before), asJson(after), cleanReason(reason), ip == null ? null : String(ip)).lastInsertRowid;
}

// Staff set or clear an account's in-game ID (PUT /api/shop/admin/users/:steamId/bi-uid).
// It used to save whatever arrived: no format check, no word that another account
// holds the ID, no record of the old value. Now the ID is tidied and checked the
// way the player's own box checks it, the all-zero placeholder is refused, and the
// change is recorded with the reason staff gave.
//
// One thing it deliberately does not do:
//  - Refuse an ID another account holds. A player with a Steam and a console account
//    legitimately carries one ID on both. Staff are shown which accounts and must
//    confirm. /refund refuses an ID found on more than one account, so saying yes
//    has that cost.
//
// Returns { status, body } for the route to send, plus before and after on success.
function staffSetBiUid(db, { steamId, biUid, confirmShared, actor, reason, ip, now }) {
  const at = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
  const user = db.prepare(
    'SELECT steam_id, bi_uid, bi_uid_name, bi_uid_proof, bi_uid_set_at FROM users WHERE steam_id = ?'
  ).get(String(steamId || ''));
  if (!user) return { status: 404, body: { error: 'User not found' } };

  let next = null;
  const clearing = biUid == null || (typeof biUid === 'string' && !biUid.trim());
  if (!clearing) {
    if (typeof biUid !== 'string') {
      return { status: 400, body: { error: 'Send the in-game ID as text, or leave it empty to clear it.' } };
    }
    if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(biUid.replace(/[{}\s]/g, ''))) {
      return { status: 400, body: { error: 'That is the placeholder all-zero ID, not a real identity. Get their real one.' } };
    }
    next = asReforgerUuid(biUid);
    if (!next) {
      return { status: 400, body: { error: 'That is not a valid in-game ID. Expected xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' } };
    }
  }

  let otherAccounts = [];
  if (next) {
    otherAccounts = db.prepare(
      'SELECT steam_id FROM users WHERE lower(bi_uid) = ? AND steam_id != ? ORDER BY steam_id'
    ).all(next, user.steam_id).map(r => r.steam_id);
    if (otherAccounts.length && confirmShared !== true) {
      return {
        status: 409,
        body: {
          code: 'id_on_other_account',
          error: 'That in-game ID is already on another account. Check it is the same player, then confirm to save it on both. /refund refuses an ID that is on more than one account.',
          otherAccounts
        }
      };
    }
  }

  const before = { bi_uid: user.bi_uid, bi_uid_proof: user.bi_uid_proof, bi_uid_name: user.bi_uid_name, bi_uid_set_at: user.bi_uid_set_at };
  // A cleared ID has nothing to prove, so it carries no proof either.
  const after = { bi_uid: next, bi_uid_proof: next ? 'staff' : null, bi_uid_name: null, bi_uid_set_at: at };
  if (otherAccounts.length) after.also_on_accounts = otherAccounts;

  db.transaction(() => {
    db.prepare('UPDATE users SET bi_uid = ?, bi_uid_proof = ?, bi_uid_name = NULL, bi_uid_set_at = ? WHERE steam_id = ?')
      .run(after.bi_uid, after.bi_uid_proof, at, user.steam_id);
    recordAdminAudit(db, { actor, action: 'bi_uid.set', target: user.steam_id, before, after, reason, ip, now: at });
  })();

  return { status: 200, body: { ok: true, bi_uid: next }, before, after };
}

module.exports = { adminActor, recordAdminAudit, staffSetBiUid };

// Helpers for finding a player and signing a console player in without dead ends.
//
// The identity finder (battlemetrics.js findPlayers) shows a player the accounts
// their text could mean; they pick themselves. The picks a browser was shown are
// remembered in its session, and only those can be confirmed, so a crafted
// player id cannot sign in as someone the search never matched.

const CANDIDATE_TTL_MS = 15 * 60 * 1000;
const CANDIDATE_MAX = 12;

// Remember what the finder just showed this browser, merged with anything it
// showed in the last quarter hour.
function rememberCandidates(session, candidates, now = Date.now()) {
  if (!session) return;
  const prev = session.identityFind && now - session.identityFind.at <= CANDIDATE_TTL_MS
    ? session.identityFind.list
    : [];
  const byId = new Map(prev.map((c) => [c.bmPlayerId, c]));
  for (const c of candidates || []) {
    if (!c || !/^\d{1,20}$/.test(String(c.bmPlayerId))) continue;
    byId.delete(String(c.bmPlayerId));
    byId.set(String(c.bmPlayerId), { bmPlayerId: String(c.bmPlayerId), name: String(c.name || ''), biUid: c.biUid || null });
  }
  session.identityFind = { at: now, list: Array.from(byId.values()).slice(-CANDIDATE_MAX) };
}

// The remembered pick with this id, or null when it was never shown here or has expired.
function pickCandidate(session, ref, now = Date.now()) {
  const found = session && session.identityFind;
  if (!found || now - found.at > CANDIDATE_TTL_MS) return null;
  // Only a string or a number: String() on a crafted JSON object such as
  // {"toString":1} throws, and that used to leave the request hanging.
  if (typeof ref !== 'string' && typeof ref !== 'number') return null;
  const id = String(ref);
  if (!/^\d{1,20}$/.test(id)) return null;
  return found.list.find((c) => c.bmPlayerId === id) || null;
}

// "j•••••@g•••.com": enough for a player to recognise their own address,
// not enough to learn someone else's.
function maskEmail(email) {
  const s = String(email || '').trim();
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  const dots = (n) => '•'.repeat(n);
  return `${local[0]}${dots(Math.max(3, Math.min(6, local.length - 1)))}@${host[0]}${dots(3)}${tld}`;
}

// An account with a completed purchase has something to lose (subscriptions it
// could cancel, perks, receipts), so signing in to it from a new device needs
// proof. An account that never bought anything has nothing to take over.
function accountIsProtected(db, steamId) {
  return !!db.prepare("SELECT 1 FROM orders WHERE steam_id = ? AND status = 'completed' LIMIT 1").get(steamId);
}

// The PayPal email the account most recently paid with, or null.
function latestPayerEmail(db, steamId) {
  const row = db.prepare(`
    SELECT payer_email FROM orders
    WHERE steam_id = ? AND payer_email IS NOT NULL AND trim(payer_email) != ''
    ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 1
  `).get(steamId);
  return row ? String(row.payer_email).trim() : null;
}

module.exports = {
  rememberCandidates,
  pickCandidate,
  maskEmail,
  accountIsProtected,
  latestPayerEmail,
  CANDIDATE_TTL_MS,
  CANDIDATE_MAX,
};

// Plain website accounts: an email and a password.
//
// The owner's model (2026-09-14): a player makes a quick account on the site,
// adds their in-game id, and buys priority queue. Steam, Xbox and PlayStation
// sign-in stay only so existing customers can move over. A web account is a
// users row like any other (steam_id "web:<hex>", platform "web"), so every join
// on users.steam_id (orders, entitlements, the game-server sync, Discord roles,
// refunds) works unchanged; an existing customer who adds an email and password
// keeps the same row, so nothing they own or pay for moves.
//
// How an account that already exists gets email sign-in, and why each is safe:
//   - Steam: from its account page, and the email counts only once the link sent
//     to it is opened ("attach"), so nobody can put someone else's address on
//     their account and catch that person's password reset.
//   - Xbox / PlayStation: console sign-in never proved ownership (a gamertag and a
//     browser cookie), so a console session alone cannot add one. It comes through
//     the email the account's purchases were paid with ("claim"), or within an hour
//     of a staff re-link ("attach"), which clears whatever sign-in was there before.
//   - Staff (ADMIN_STEAM_IDS): Steam only. Admin rights never ride on a password.
//
// Passwords are scrypt hashes. Links are single-use sha256-stored tokens.

const crypto = require('crypto');

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const TOKEN_TTL_S = 60 * 60;
const TOKEN_COOLDOWN_S = 2 * 60;
const RELINK_ATTACH_WINDOW_S = 60 * 60;
const LOGIN_FAIL_LIMIT = 10; // one email from one address
const LOGIN_FAIL_EMAIL_LIMIT = 100; // one email from everywhere
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const THROTTLE_MAX_KEYS = 10000;
const SCRYPT_CONCURRENCY = 2;
const SCRYPT_QUEUE_MAX = 64;
const MAIL_GAP_S = 2 * 60;
const MAIL_PER_ADDRESS_PER_DAY = 5;
const MAIL_PER_HOUR = 120;
const DEFAULT_PERSONA = 'Player';
const CLAIM_PLATFORMS = new Set(['xbox', 'psn']);
const PURPOSES = new Set(['reset', 'claim', 'attach']);

const CONSOLE_CLAIM_HELP = 'To add email sign-in to an Xbox or PlayStation account, sign out, choose Sign in, then "Forgot password", and enter the email you paid with. We will email you a link. No access to that email? Open a ticket in our Discord.';
const STAFF_STEAM_ONLY = 'Staff accounts sign in with Steam only.';

const nowS = () => Math.floor(Date.now() / 1000);

// ADMIN_STEAM_IDS, read when asked, so it always agrees with the environment.
function isStaffAccount(steamId) {
  if (!steamId) return false;
  return String(process.env.ADMIN_STEAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(String(steamId));
}

// ---- Input ------------------------------------------------------------------

// Plain ASCII addresses only. Anything a mail library could read as a second
// recipient or a display name (<, >, ;, commas, quotes, control characters) is
// refused, and lower-casing ASCII matches SQLite's lower() on payer emails.
const EMAIL_RE = /^[a-z0-9_%+'-](?:[a-z0-9._%+'-]{0,62}[a-z0-9_%+'-])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,22}[a-z0-9]$/;

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 6 || e.length > 254) return null;
  if (!EMAIL_RE.test(e) || e.includes('..')) return null;
  return e;
}

// The problem with a proposed password, in words a player can act on, or null.
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters for your password.`;
  if (pw.length > PASSWORD_MAX) return `Keep your password under ${PASSWORD_MAX} characters.`;
  return null;
}

// ---- Passwords --------------------------------------------------------------

// At most SCRYPT_CONCURRENCY hashes at once. Each one holds a libuv thread and
// 32 MB for a while, and the pool has four threads shared with file and DNS work,
// so a burst of sign-ins must queue rather than stall the rest of the site. A
// queue past SCRYPT_QUEUE_MAX is refused as busy instead of growing.
const scryptGate = { active: 0, waiting: [], peak: 0, concurrency: SCRYPT_CONCURRENCY, queueMax: SCRYPT_QUEUE_MAX };

function busyError() {
  const e = new Error('Sign-in is busy. Try again in a few seconds.');
  e.code = 'auth_busy';
  return e;
}

function acquireScrypt() {
  if (scryptGate.active < scryptGate.concurrency) {
    scryptGate.active += 1;
    scryptGate.peak = Math.max(scryptGate.peak, scryptGate.active);
    return Promise.resolve();
  }
  if (scryptGate.waiting.length >= scryptGate.queueMax) return Promise.reject(busyError());
  return new Promise((resolve) => scryptGate.waiting.push(resolve));
}

function releaseScrypt() {
  const next = scryptGate.waiting.shift();
  if (next) next(); // the slot passes straight to the next in line
  else scryptGate.active -= 1;
}

async function scryptAsync(pw, salt, keylen, opts) {
  await acquireScrypt();
  try {
    return await new Promise((resolve, reject) => {
      crypto.scrypt(pw, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
    });
  } finally {
    releaseScrypt();
  }
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

let dummyHashPromise = null;

// True only for the password that produced the stored hash. A missing or
// malformed hash still costs one scrypt, so a sign-in for an email with no
// password takes as long as a wrong password and reveals nothing. A busy refusal
// is thrown, not reported as a wrong password.
async function verifyPassword(pw, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    if (!dummyHashPromise) {
      dummyHashPromise = hashPassword(crypto.randomBytes(24).toString('hex')).catch((e) => {
        dummyHashPromise = null;
        throw e;
      });
    }
    const dummy = await dummyHashPromise;
    if (typeof pw === 'string' && pw.length <= PASSWORD_MAX) await verifyPassword(pw, dummy);
    return false;
  }
  if (typeof pw !== 'string' || pw.length > PASSWORD_MAX) return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (![N, R, P].every(Number.isInteger) || N < 16384 || N > 1048576 || R < 1 || R > 32 || P < 1 || P > 16) return false;
  const expected = Buffer.from(keyB64, 'base64url');
  if (expected.length < 32) return false;
  try {
    const key = await scryptAsync(pw, Buffer.from(saltB64, 'base64url'), expected.length, { N, r: R, p: P, maxmem: SCRYPT.maxmem });
    return crypto.timingSafeEqual(key, expected);
  } catch (e) {
    if (e && e.code === 'auth_busy') throw e;
    return false;
  }
}

// ---- Accounts ---------------------------------------------------------------

function getUser(db, steamId) {
  return db.prepare('SELECT * FROM users WHERE steam_id = ?').get(steamId) || null;
}

function findUserByEmail(db, email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}

function createWebUser(db, { email, passwordHash }) {
  const steamId = 'web:' + crypto.randomBytes(12).toString('hex');
  db.prepare(`
    INSERT INTO users (steam_id, persona, avatar_url, role, platform, email, password_hash)
    VALUES (?, ?, NULL, 'user', 'web', ?, ?)
  `).run(steamId, DEFAULT_PERSONA, email, passwordHash);
  return getUser(db, steamId);
}

// Why this signed-in account cannot start adding email sign-in, or null.
//   relinkedAt  when this session was signed in by a staff re-link, in seconds
function addLoginRefusal(user, { relinkedAt = null, now = nowS() } = {}) {
  if (!user) return { status: 401, code: 'signed_out', error: 'Sign in required' };
  if (user.email) return { status: 409, code: 'has_login', error: 'This account already signs in with an email.' };
  if (isStaffAccount(user.steam_id)) return { status: 403, code: 'staff', error: STAFF_STEAM_ONLY };
  if (CLAIM_PLATFORMS.has(user.platform)) {
    const age = relinkedAt ? now - Number(relinkedAt) : Infinity;
    if (!(age >= 0 && age <= RELINK_ATTACH_WINDOW_S)) return { status: 403, code: 'needs_claim', error: CONSOLE_CLAIM_HELP };
  }
  return null;
}

// Who a "forgot password" (or a sign-up with a known email) is for.
//   { purpose: 'reset', user }  the account that signs in with this email
//   { purpose: 'claim', user }  no such account, but an Xbox or PlayStation
//                               customer paid with this email: the link sets up
//                               email sign-in on THAT account (the most recent)
//   { purpose: 'steam', user }  a Steam customer paid with it: they are told to
//                               sign in with Steam, where their purchases are
//   null                        nobody, and the request says nothing either way
// Test-mode orders and staff accounts never count.
function resolveEmailTarget(db, email) {
  const own = findUserByEmail(db, email);
  if (own) return { purpose: 'reset', user: own };
  const payers = db.prepare(`
    SELECT u.steam_id, u.platform, MAX(COALESCE(o.completed_at, o.created_at)) AS paid_at
    FROM users u JOIN orders o ON o.steam_id = u.steam_id
    WHERE lower(trim(o.payer_email)) = ? AND o.status = 'completed' AND o.test_mode = 0
      AND (u.email IS NULL OR u.email = '')
    GROUP BY u.steam_id
    ORDER BY paid_at DESC, u.steam_id
  `).all(email).filter((r) => !isStaffAccount(r.steam_id));
  const claim = payers.find((r) => CLAIM_PLATFORMS.has(r.platform));
  if (claim) return { purpose: 'claim', user: getUser(db, claim.steam_id) };
  const steam = payers.find((r) => r.platform == null || r.platform === 'steam');
  if (steam) return { purpose: 'steam', user: getUser(db, steam.steam_id) };
  return null;
}

// A staff re-link hands a console account to whoever opened the link, so any email
// sign-in already on it goes, with every session and outstanding link: it may be
// the very reason for the re-link. Call inside the re-link's transaction.
function clearLoginForRelink(db, steamId, now = nowS()) {
  db.prepare('UPDATE users SET email = NULL, password_hash = NULL, email_verified_at = NULL, auth_gen = auth_gen + 1 WHERE steam_id = ?').run(steamId);
  db.prepare('UPDATE auth_tokens SET used_at = ? WHERE steam_id = ? AND used_at IS NULL').run(now, steamId);
}

// ---- Links ------------------------------------------------------------------

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// A fresh single-use link. Earlier unused links stay valid: they all went to the
// same inbox, and retiring them let anyone who knew the address void the link its
// owner was about to open. The per-account cooldown and the mail budget bound how
// many exist, and using any one of them retires the rest.
function issueToken(db, { steamId, purpose, email, ttlSeconds = TOKEN_TTL_S, now = nowS() }) {
  if (!PURPOSES.has(purpose)) throw new Error(`unknown link purpose: ${purpose}`);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`
    INSERT INTO auth_tokens (token_hash, steam_id, purpose, email, issued_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(hashToken(token), steamId, purpose, email, now, now + ttlSeconds);
  return token;
}

// A link was sent for this account moments ago: do not send another.
function recentlyIssued(db, steamId, purpose, now = nowS(), cooldownSeconds = TOKEN_COOLDOWN_S) {
  return !!db.prepare('SELECT 1 FROM auth_tokens WHERE steam_id = ? AND purpose = ? AND issued_at > ? LIMIT 1')
    .get(steamId, purpose, now - cooldownSeconds);
}

// Why a live link cannot do its job on this account right now, or null.
function linkRefusal(db, row, user) {
  if (row.purpose === 'reset') {
    if (user.email !== row.email) return { code: 'stale', error: 'This link is for an email this account no longer uses. Ask for a new one.' };
    return null;
  }
  if (isStaffAccount(user.steam_id)) return { code: 'staff', error: STAFF_STEAM_ONLY };
  if (row.purpose === 'claim' && !CLAIM_PLATFORMS.has(user.platform)) {
    return { code: 'not_claimable', error: 'This link cannot set up sign-in on that account. Ask for a new one.' };
  }
  const holder = findUserByEmail(db, row.email);
  if (holder && holder.steam_id !== user.steam_id) {
    return { code: 'email_taken', error: 'That email already signs in to another ReforgedZ account. Use "Forgot password" with it instead.' };
  }
  if (user.email) {
    return user.email === row.email
      ? { code: 'has_login', error: 'This account already signs in with this email. Sign in, or use "Forgot password".' }
      : { code: 'has_login', error: 'This account already signs in with a different email.' };
  }
  return null;
}

// Look a link up without using it.  { row, user }  |  { error, code? }
function readToken(db, token, now = nowS()) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return { error: 'This link is not valid. Ask for a new one.' };
  const row = db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ?').get(hashToken(token));
  if (!row) return { error: 'This link is not valid. Ask for a new one.' };
  if (row.used_at) return { error: 'This link has already been used. Ask for a new one.' };
  if (row.expires_at <= now) return { error: 'This link has expired. Ask for a new one.' };
  const user = getUser(db, row.steam_id);
  if (!user) return { error: 'The account this link was for no longer exists.' };
  const refusal = linkRefusal(db, row, user);
  if (refusal) return refusal;
  return { row, user };
}

// Use a link to set a password (and, for a claim or attach, the email).
//   { user, purpose }  signed-in-ready account; auth_gen went up, so every other
//                      session ends, and console_lock_gen, so no old console cookie
//                      proves anything
//   { error, code? }   nothing changed, and a refused link is NOT used up, so it
//                      still works once the problem is fixed
async function completeToken(db, { token, password, now = nowS() }) {
  const found = readToken(db, token, now);
  if (found.error) return found;
  const problem = passwordProblem(password);
  if (problem) return { error: problem, code: 'weak_password' };
  const hash = await hashPassword(password);
  const at = Math.max(now, nowS());
  return db.transaction(() => {
    // Read again inside the transaction: the account may have changed while the
    // password was hashing.
    const again = readToken(db, token, now);
    if (again.error) return again;
    const { row, user } = again;
    const used = db.prepare('UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(at, row.token_hash).changes === 1;
    if (!used) return { error: 'This link has already been used. Ask for a new one.' };
    if (row.purpose === 'reset') {
      db.prepare(`
        UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?),
          auth_gen = auth_gen + 1, console_lock_gen = console_lock_gen + 1
        WHERE steam_id = ?
      `).run(hash, at, user.steam_id);
    } else {
      db.prepare(`
        UPDATE users SET email = ?, password_hash = ?, email_verified_at = ?,
          auth_gen = auth_gen + 1, console_lock_gen = console_lock_gen + 1
        WHERE steam_id = ?
      `).run(row.email, hash, at, user.steam_id);
    }
    // Every other outstanding link for this account dies with this one.
    db.prepare('UPDATE auth_tokens SET used_at = ? WHERE steam_id = ? AND used_at IS NULL').run(at, user.steam_id);
    return { user: getUser(db, user.steam_id), purpose: row.purpose };
  })();
}

// ---- Wrong-password throttle ------------------------------------------------
// In memory. One email from one address waits after LOGIN_FAIL_LIMIT wrong
// passwords in the window; the email from anywhere only after
// LOGIN_FAIL_EMAIL_LIMIT, so a stranger cannot lock a player out by typing wrong
// passwords at their address. A forgotten-password link always still works.

const failures = new Map();

function throttleEntry(key, now) {
  const f = failures.get(key);
  if (f && now - f.first > LOGIN_FAIL_WINDOW_MS) {
    failures.delete(key);
    return null;
  }
  return f || null;
}

const pairKey = (email, ip) => `p:${email}|${ip || ''}`;
const emailKey = (email) => `e:${email}`;

function loginLocked(email, ip, now = Date.now()) {
  const pair = throttleEntry(pairKey(email, ip), now);
  const all = throttleEntry(emailKey(email), now);
  return !!((pair && pair.count >= LOGIN_FAIL_LIMIT) || (all && all.count >= LOGIN_FAIL_EMAIL_LIMIT));
}

// Expired entries go first. Only if the map is still over the cap do the oldest
// live ones go, which takes thousands of addresses working at the sign-in limit.
function pruneFailures(now) {
  for (const [key, f] of failures) if (now - f.first > LOGIN_FAIL_WINDOW_MS) failures.delete(key);
  for (const key of failures.keys()) {
    if (failures.size <= THROTTLE_MAX_KEYS) break;
    failures.delete(key);
  }
}

function recordLoginFailure(email, ip, now = Date.now()) {
  for (const key of [pairKey(email, ip), emailKey(email)]) {
    const f = throttleEntry(key, now);
    if (f) f.count += 1;
    else failures.set(key, { count: 1, first: now });
  }
  if (failures.size > THROTTLE_MAX_KEYS) pruneFailures(now);
}

function clearLoginFailures(email, ip) {
  failures.delete(pairKey(email, ip));
  failures.delete(emailKey(email));
}

// ---- Mail budget ------------------------------------------------------------
// Whether one more account email may go to this address now, counting it if so:
// one every two minutes and five a day per address, MAIL_PER_HOUR in all. The
// same mail server sends invoices, so these links must not become a way to flood
// an inbox or spend its reputation. In memory; a restart forgets, which is fine.

const mailSent = new Map();
let mailHour = [];

function takeMailSlot(email, now = nowS()) {
  const day = (mailSent.get(email) || []).filter((t) => now - t < 86400);
  mailHour = mailHour.filter((t) => now - t < 3600);
  if (day.length && now - day[day.length - 1] < MAIL_GAP_S) return false;
  if (day.length >= MAIL_PER_ADDRESS_PER_DAY) return false;
  if (mailHour.length >= MAIL_PER_HOUR) return false;
  day.push(now);
  mailSent.set(email, day);
  mailHour.push(now);
  if (mailSent.size > THROTTLE_MAX_KEYS) {
    for (const [k, times] of mailSent) if (!times.length || now - times[times.length - 1] >= 86400) mailSent.delete(k);
  }
  return true;
}

module.exports = {
  normalizeEmail,
  passwordProblem,
  hashPassword,
  verifyPassword,
  isStaffAccount,
  findUserByEmail,
  createWebUser,
  addLoginRefusal,
  resolveEmailTarget,
  clearLoginForRelink,
  issueToken,
  recentlyIssued,
  readToken,
  completeToken,
  loginLocked,
  recordLoginFailure,
  clearLoginFailures,
  takeMailSlot,
  DEFAULT_PERSONA,
  TOKEN_TTL_S,
  PASSWORD_MIN,
  RELINK_ATTACH_WINDOW_S,
  CONSOLE_CLAIM_HELP,
  _test: {
    failures,
    mailSent,
    scryptGate,
    hashToken,
    resetMailBudget() { mailSent.clear(); mailHour = []; },
    LOGIN_FAIL_LIMIT,
    LOGIN_FAIL_EMAIL_LIMIT,
    LOGIN_FAIL_WINDOW_MS,
    THROTTLE_MAX_KEYS,
    MAIL_GAP_S,
    MAIL_PER_ADDRESS_PER_DAY,
    MAIL_PER_HOUR,
  },
};

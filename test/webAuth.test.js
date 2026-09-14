// Tests for plain website accounts (webAuth.js) against the REAL schema: db.js is
// loaded with DATA_DIR pointed at a throwaway folder, so every migration runs
// exactly as it will on the live database, then the tests use that database.
// Needs better-sqlite3, so run it where the shop's node_modules are.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-webauth-'));
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_STEAM_IDS;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const auth = require('../webAuth');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let seq = 0;
function legacyUser({ platform = 'steam', email = null } = {}) {
  seq += 1;
  const id = platform === 'steam' ? `7656119${String(seq).padStart(10, '0')}` : `console:${900000 + seq}`;
  db.prepare("INSERT INTO users (steam_id, persona, role, platform, bm_player_id, email) VALUES (?, ?, 'user', ?, ?, ?)")
    .run(id, `Legacy${seq}`, platform, platform === 'steam' ? null : String(900000 + seq), email);
  return id;
}

function productId() {
  const row = db.prepare('SELECT id FROM products LIMIT 1').get();
  if (row) return row.id;
  return db.prepare("INSERT INTO products (title, price_cents, type) VALUES ('Test', 100, 'one_time')").run().lastInsertRowid;
}

function order(steamId, { status = 'completed', payerEmail = null, at = 1000, testMode = 0 } = {}) {
  return db.prepare('INSERT INTO orders (steam_id, product_id, status, amount_cents, created_at, completed_at, payer_email, test_mode) VALUES (?, ?, ?, 100, ?, ?, ?, ?)')
    .run(steamId, productId(), status, at, status === 'completed' ? at : null, payerEmail, testMode).lastInsertRowid;
}

const userRow = (id) => db.prepare('SELECT * FROM users WHERE steam_id = ?').get(id);
const tokenRow = (token) => db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ?').get(auth._test.hashToken(token));

// Run fn with ADMIN_STEAM_IDS set to these ids, then put it back.
async function asStaff(ids, fn) {
  const prev = process.env.ADMIN_STEAM_IDS;
  process.env.ADMIN_STEAM_IDS = ids.join(',');
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.ADMIN_STEAM_IDS;
    else process.env.ADMIN_STEAM_IDS = prev;
  }
}

// ---- Schema -----------------------------------------------------------------

test('the migration adds the sign-in columns, the unique email index and the token table', () => {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  for (const c of ['email', 'password_hash', 'email_verified_at', 'auth_gen']) assert.ok(cols.includes(c), c);
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_users_email'").get();
  assert.match(idx.sql, /UNIQUE/);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_tokens'").get());
});

test('re-running the migrations on boot is a no-op, and a web account gets an account row but no platform identity', () => {
  const user = auth.createWebUser(db, { email: 'boot@example.com', passwordHash: 'x' });
  assert.equal(user.account_id, null);
  const identitiesBefore = db.prepare('SELECT COUNT(*) AS n FROM account_identities').get().n;
  db.close();
  const r = spawnSync(process.execPath, ['-e', "require('./db')"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  delete require.cache[require.resolve('../db')];
  console.log = () => {};
  const fresh = require('../db');
  Object.assign(console, quiet);
  const after = fresh.prepare('SELECT * FROM users WHERE steam_id = ?').get(user.steam_id);
  assert.ok(after.account_id, 'backfill linked the web account to an account row');
  assert.equal(fresh.prepare('SELECT COUNT(*) AS n FROM account_identities').get().n, identitiesBefore);
  // Keep using the reopened handle for the rest of the file.
  Object.setPrototypeOf(db, Object.getPrototypeOf(fresh));
  db.prepare = fresh.prepare.bind(fresh);
  db.transaction = fresh.transaction.bind(fresh);
  db.close = fresh.close.bind(fresh);
});

test('the token table takes the three link kinds and nothing else', () => {
  const u = auth.createWebUser(db, { email: 'kinds@example.com', passwordHash: 'h' });
  const insert = db.prepare('INSERT INTO auth_tokens (token_hash, steam_id, purpose, email, issued_at, expires_at) VALUES (?, ?, ?, ?, 1, 2)');
  for (const p of ['reset', 'claim', 'attach']) insert.run(`kind-${p}`, u.steam_id, p, 'kinds@example.com');
  assert.throws(() => insert.run('kind-bogus', u.steam_id, 'bogus', 'kinds@example.com'), /CHECK/);
});

// ---- Input ------------------------------------------------------------------

test('normalizeEmail takes plain addresses and refuses anything a mail library could misread', () => {
  assert.equal(auth.normalizeEmail('  John.Doe@Example.COM '), 'john.doe@example.com');
  assert.equal(auth.normalizeEmail('a@b.co'), 'a@b.co');
  assert.equal(auth.normalizeEmail("o'brien+shop@mail.example.org"), "o'brien+shop@mail.example.org");
  assert.equal(auth.normalizeEmail('rh-a-1f2e@example.test'), 'rh-a-1f2e@example.test');
  const nl = String.fromCharCode(10);
  const nul = String.fromCharCode(0);
  const bad = [
    '', 'nope', 'a@b', '@example.com', 'a b@example.com', 'a@@example.com', 'a@example..com',
    '<a@example.com>', 'Name <a@example.com>', 'a@example.com>', 'a;b@example.com', 'a,b@example.com', 'a"b@example.com',
    `a@example.com${nl}bcc@evil.example`, `a${nul}@example.com`, `j${String.fromCodePoint(0xf6)}rg@example.com`,
    '.a@example.com', 'a.@example.com', 'a..b@example.com', 'a@-example.com', 'a@example.c', 'a@example.123',
    `${'x'.repeat(65)}@example.com`, `${'x'.repeat(250)}@example.com`, 42, null, { toString: 1 },
  ];
  for (const b of bad) assert.equal(auth.normalizeEmail(b), null, typeof b === 'string' ? JSON.stringify(b) : String(typeof b));
  assert.equal(auth.passwordProblem('12345678'), null);
  assert.ok(auth.passwordProblem('1234567'));
  assert.ok(auth.passwordProblem('x'.repeat(201)));
  assert.ok(auth.passwordProblem(undefined));
});

// ---- Passwords --------------------------------------------------------------

test('passwords: scrypt format, right one verifies, anything else does not', async () => {
  const h = await auth.hashPassword('correct horse');
  assert.match(h, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.notEqual(h, await auth.hashPassword('correct horse'), 'salted');
  assert.equal(await auth.verifyPassword('correct horse', h), true);
  assert.equal(await auth.verifyPassword('correct horsE', h), false);
  assert.equal(await auth.verifyPassword('', h), false);
  assert.equal(await auth.verifyPassword('correct horse', null), false);
  assert.equal(await auth.verifyPassword('correct horse', 'scrypt$1$1$1$x$y'), false);
  assert.equal(await auth.verifyPassword('x'.repeat(201), h), false);
});

test('scrypt runs two at a time, queues the rest, and refuses a queue that is too long', async () => {
  const gate = auth._test.scryptGate;
  gate.peak = 0;
  await Promise.all(Array.from({ length: 6 }, (_, i) => auth.hashPassword(`queued password ${i}`)));
  assert.equal(gate.peak, 2);
  assert.equal(gate.active, 0);
  const savedQueue = gate.queueMax;
  const savedConcurrency = gate.concurrency;
  gate.queueMax = 1;
  try {
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => auth.hashPassword(`burst password ${i}`)));
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'rejected']);
    assert.equal(results[3].reason.code, 'auth_busy');
  } finally {
    gate.queueMax = savedQueue;
  }
  const h = await auth.hashPassword('busy check');
  gate.concurrency = 0;
  gate.queueMax = 0;
  try {
    await assert.rejects(auth.verifyPassword('busy check', h), { code: 'auth_busy' }, 'busy is not a wrong password');
    await assert.rejects(auth.verifyPassword('busy check', null), { code: 'auth_busy' });
  } finally {
    gate.concurrency = savedConcurrency;
    gate.queueMax = savedQueue;
  }
  assert.equal(gate.active, 0);
  assert.equal(gate.waiting.length, 0);
  assert.equal(await auth.verifyPassword('busy check', h), true);
});

// ---- Accounts ---------------------------------------------------------------

test('createWebUser makes a web row; an email can only sign in to one account', () => {
  const u = auth.createWebUser(db, { email: 'new@example.com', passwordHash: 'h' });
  assert.match(u.steam_id, /^web:[0-9a-f]{24}$/);
  assert.equal(u.platform, 'web');
  assert.equal(u.persona, auth.DEFAULT_PERSONA);
  assert.equal(u.role, 'user');
  assert.throws(() => auth.createWebUser(db, { email: 'new@example.com', passwordHash: 'h' }), /UNIQUE/);
  assert.equal(auth.findUserByEmail(db, 'new@example.com').steam_id, u.steam_id);
});

test('adding email sign-in: Steam may, staff never, a console account only just after a staff re-link', async () => {
  const now = 7000000;
  const steam = { steam_id: '76561190000000001', platform: 'steam', email: null };
  assert.equal(auth.addLoginRefusal(steam, { now }), null);
  assert.equal(auth.addLoginRefusal({ ...steam, platform: null }, { now }), null);
  assert.equal(auth.addLoginRefusal({ ...steam, email: 'x@example.com' }, { now }).code, 'has_login');
  assert.equal(auth.addLoginRefusal(null).code, 'signed_out');
  await asStaff(['1', steam.steam_id], () => assert.equal(auth.addLoginRefusal(steam, { now }).code, 'staff'));
  const xbox = { steam_id: 'console:1', platform: 'xbox', email: null };
  assert.equal(auth.addLoginRefusal(xbox, { now }).code, 'needs_claim');
  assert.equal(auth.addLoginRefusal(xbox, { now, relinkedAt: now - 60 }), null);
  assert.equal(auth.addLoginRefusal(xbox, { now, relinkedAt: now - auth.RELINK_ATTACH_WINDOW_S - 1 }).code, 'needs_claim');
  assert.equal(auth.addLoginRefusal({ ...xbox, platform: 'psn' }, { now, relinkedAt: now + 60 }).code, 'needs_claim');
  assert.equal(auth.addLoginRefusal({ ...xbox, platform: 'psn' }, { now, relinkedAt: 'soon' }).code, 'needs_claim');
});

test('resolveEmailTarget: own account resets, a console payer claims, a Steam payer is pointed to Steam, nothing else counts', async () => {
  const web = auth.createWebUser(db, { email: 'owner@example.com', passwordHash: 'h' });
  assert.deepEqual(auth.resolveEmailTarget(db, 'owner@example.com'), { purpose: 'reset', user: userRow(web.steam_id) });

  const older = legacyUser({ platform: 'psn' });
  const newer = legacyUser({ platform: 'xbox' });
  const steamLater = legacyUser();
  order(older, { payerEmail: 'Shared@Example.com', at: 1000 });
  order(newer, { payerEmail: 'shared@example.com ', at: 2000 });
  order(steamLater, { payerEmail: 'shared@example.com', at: 3000 });
  const t = auth.resolveEmailTarget(db, 'shared@example.com');
  assert.equal(t.purpose, 'claim', 'a console account comes before a later Steam purchase');
  assert.equal(t.user.steam_id, newer, 'the most recently paid console account');

  const steamPayer = legacyUser();
  order(steamPayer, { payerEmail: 'steamer@example.com' });
  const s = auth.resolveEmailTarget(db, 'steamer@example.com');
  assert.equal(s.purpose, 'steam');
  assert.equal(s.user.steam_id, steamPayer);

  const sandbox = legacyUser({ platform: 'xbox' });
  order(sandbox, { payerEmail: 'sandbox@example.com', testMode: 1 });
  assert.equal(auth.resolveEmailTarget(db, 'sandbox@example.com'), null, 'test-mode orders never count');

  const staff = legacyUser({ platform: 'psn' });
  order(staff, { payerEmail: 'staff@example.com' });
  await asStaff([staff], () => assert.equal(auth.resolveEmailTarget(db, 'staff@example.com'), null, 'staff accounts never'));
  assert.equal(auth.resolveEmailTarget(db, 'staff@example.com').purpose, 'claim');

  const unpaid = legacyUser({ platform: 'xbox' });
  order(unpaid, { status: 'pending', payerEmail: 'unpaid@example.com' });
  assert.equal(auth.resolveEmailTarget(db, 'unpaid@example.com'), null);

  const already = legacyUser({ platform: 'psn', email: 'already@example.com' });
  order(already, { payerEmail: 'oldpaypal@example.com' });
  assert.equal(auth.resolveEmailTarget(db, 'oldpaypal@example.com'), null);

  assert.equal(auth.resolveEmailTarget(db, 'nobody@example.com'), null);
});

// ---- Links ------------------------------------------------------------------

test('a reset link works once, sets the password, and ends other sessions, console cookies and links', async () => {
  const hash = await auth.hashPassword('old password');
  const u = auth.createWebUser(db, { email: 'reset@example.com', passwordHash: hash });
  const other = auth.issueToken(db, { steamId: u.steam_id, purpose: 'reset', email: 'reset@example.com' });
  const token = auth.issueToken(db, { steamId: u.steam_id, purpose: 'reset', email: 'reset@example.com' });
  assert.equal(auth.readToken(db, other).user.steam_id, u.steam_id, 'a newer link does not retire an older one');
  assert.equal(auth.readToken(db, token).user.steam_id, u.steam_id);
  assert.equal((await auth.completeToken(db, { token, password: 'short' })).code, 'weak_password');
  assert.equal(tokenRow(token).used_at, null, 'a refused password does not use the link up');
  const done = await auth.completeToken(db, { token, password: 'new password 1' });
  assert.equal(done.user.steam_id, u.steam_id);
  assert.equal(done.user.auth_gen, 1);
  assert.equal(done.user.console_lock_gen, 1);
  assert.ok(done.user.email_verified_at);
  assert.equal(await auth.verifyPassword('new password 1', done.user.password_hash), true);
  assert.equal(await auth.verifyPassword('old password', done.user.password_hash), false);
  assert.match((await auth.completeToken(db, { token, password: 'again password' })).error, /already been used/);
  assert.match(auth.readToken(db, other).error, /already been used/);
});

test('a claim link sets up email sign-in on the existing console account, keeping its orders', async () => {
  const steamId = legacyUser({ platform: 'psn' });
  const orderId = order(steamId, { payerEmail: 'buyer@example.com' });
  const target = auth.resolveEmailTarget(db, 'buyer@example.com');
  const token = auth.issueToken(db, { steamId: target.user.steam_id, purpose: target.purpose, email: 'buyer@example.com' });
  const done = await auth.completeToken(db, { token, password: 'my new password' });
  assert.equal(done.purpose, 'claim');
  assert.equal(done.user.steam_id, steamId);
  assert.equal(done.user.email, 'buyer@example.com');
  assert.equal(done.user.platform, 'psn');
  assert.ok(done.user.email_verified_at);
  assert.equal(done.user.auth_gen, 1);
  assert.equal(done.user.console_lock_gen, 1);
  assert.equal(await auth.verifyPassword('my new password', done.user.password_hash), true);
  assert.equal(db.prepare('SELECT steam_id FROM orders WHERE id = ?').get(orderId).steam_id, steamId);
});

test('a refused claim changes nothing and leaves its link usable; never a Steam or staff account', async () => {
  const steamId = legacyUser({ platform: 'xbox' });
  order(steamId, { payerEmail: 'race@example.com' });
  const token = auth.issueToken(db, { steamId, purpose: 'claim', email: 'race@example.com' });
  const other = auth.createWebUser(db, { email: 'race@example.com', passwordHash: 'h' });
  const r = await auth.completeToken(db, { token, password: 'a good password' });
  assert.equal(r.code, 'email_taken');
  assert.equal(userRow(steamId).email, null);
  assert.equal(tokenRow(token).used_at, null, 'not used up');
  db.prepare('UPDATE users SET email = NULL WHERE steam_id = ?').run(other.steam_id);
  assert.equal((await auth.completeToken(db, { token, password: 'a good password' })).purpose, 'claim', 'the same link works once the problem is gone');

  const steamRow = legacyUser();
  const steamToken = auth.issueToken(db, { steamId: steamRow, purpose: 'claim', email: 'steamclaim@example.com' });
  assert.equal((await auth.completeToken(db, { token: steamToken, password: 'a good password' })).code, 'not_claimable');
  assert.equal(userRow(steamRow).email, null);

  const staffRow = legacyUser({ platform: 'psn' });
  const staffToken = auth.issueToken(db, { steamId: staffRow, purpose: 'claim', email: 'staffclaim@example.com' });
  await asStaff([staffRow], async () => {
    assert.equal((await auth.completeToken(db, { token: staffToken, password: 'a good password' })).code, 'staff');
  });
  assert.equal(userRow(staffRow).email, null);
});

test('an attach link puts the confirmed email and a password on the account that asked; never on staff', async () => {
  const steamId = legacyUser();
  const orderId = order(steamId, { payerEmail: 'someone@example.com' });
  const token = auth.issueToken(db, { steamId, purpose: 'attach', email: 'confirmed@example.com' });
  assert.equal(auth.readToken(db, token).row.purpose, 'attach');
  assert.equal(userRow(steamId).email, null, 'nothing saved before the link is opened');
  const done = await auth.completeToken(db, { token, password: 'attach password' });
  assert.equal(done.purpose, 'attach');
  assert.equal(done.user.steam_id, steamId);
  assert.equal(done.user.email, 'confirmed@example.com');
  assert.ok(done.user.email_verified_at);
  assert.equal(done.user.auth_gen, 1);
  assert.equal(db.prepare('SELECT steam_id FROM orders WHERE id = ?').get(orderId).steam_id, steamId);

  const staffId = legacyUser();
  const staffToken = auth.issueToken(db, { steamId: staffId, purpose: 'attach', email: 'boss@example.com' });
  await asStaff([staffId], async () => {
    assert.equal((await auth.completeToken(db, { token: staffToken, password: 'boss password' })).code, 'staff');
  });
  assert.equal(userRow(staffId).email, null);
  assert.equal(tokenRow(staffToken).used_at, null);
});

test('a staff re-link clears email sign-in, sessions and outstanding links', () => {
  const id = legacyUser({ platform: 'xbox' });
  db.prepare("UPDATE users SET email = 'squatter@example.com', password_hash = 'h', email_verified_at = 1 WHERE steam_id = ?").run(id);
  const token = auth.issueToken(db, { steamId: id, purpose: 'reset', email: 'squatter@example.com' });
  db.transaction(() => auth.clearLoginForRelink(db, id))();
  const u = userRow(id);
  assert.equal(u.email, null);
  assert.equal(u.password_hash, null);
  assert.equal(u.email_verified_at, null);
  assert.equal(u.auth_gen, 1);
  assert.match(auth.readToken(db, token).error, /already been used/);
});

test('links: newer ones leave older ones alone, expiry is enforced, junk is refused, cooldown is per account and kind', () => {
  const u = auth.createWebUser(db, { email: 'links@example.com', passwordHash: 'h' });
  const now = 5000000;
  const first = auth.issueToken(db, { steamId: u.steam_id, purpose: 'reset', email: 'links@example.com', now });
  assert.equal(auth.recentlyIssued(db, u.steam_id, 'reset', now + 60), true);
  assert.equal(auth.recentlyIssued(db, u.steam_id, 'reset', now + 3600), false);
  assert.equal(auth.recentlyIssued(db, u.steam_id, 'attach', now + 60), false);
  const second = auth.issueToken(db, { steamId: u.steam_id, purpose: 'reset', email: 'links@example.com', now: now + 10 });
  assert.equal(auth.readToken(db, first, now + 20).user.steam_id, u.steam_id);
  assert.equal(auth.readToken(db, second, now + 20).user.steam_id, u.steam_id);
  assert.match(auth.readToken(db, second, now + 10 + auth.TOKEN_TTL_S).error, /expired/);
  assert.match(auth.readToken(db, 'short').error, /not valid/);
  assert.match(auth.readToken(db, 'x'.repeat(43)).error, /not valid/);
  assert.match(auth.readToken(db, { toString: 1 }).error, /not valid/);
  assert.ok(tokenRow(second), 'found by its hash');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_tokens WHERE token_hash = ?').get(second).n, 0, 'the link itself is never stored');
  assert.throws(() => auth.issueToken(db, { steamId: u.steam_id, purpose: 'bogus', email: 'links@example.com' }), /unknown link purpose/);
  db.prepare("UPDATE users SET email = 'moved@example.com' WHERE steam_id = ?").run(u.steam_id);
  assert.equal(auth.readToken(db, second, now + 20).code, 'stale', 'a reset link for an address the account no longer uses does nothing');
});

// ---- Throttle ---------------------------------------------------------------

test('wrong passwords lock one email from one address; elsewhere it works until the email-wide limit', () => {
  const L = auth._test.LOGIN_FAIL_LIMIT;
  const W = auth._test.LOGIN_FAIL_WINDOW_MS;
  const e = 'throttle@example.com';
  const t0 = 1000000;
  for (let i = 0; i < L - 1; i++) auth.recordLoginFailure(e, '1.1.1.1', t0 + i);
  assert.equal(auth.loginLocked(e, '1.1.1.1', t0 + 100), false);
  auth.recordLoginFailure(e, '1.1.1.1', t0 + 200);
  assert.equal(auth.loginLocked(e, '1.1.1.1', t0 + 300), true);
  assert.equal(auth.loginLocked(e, '2.2.2.2', t0 + 300), false, 'the owner somewhere else is not locked out');
  assert.equal(auth.loginLocked(e, '1.1.1.1', t0 + W + 1), false);

  const spread = 'spread@example.com';
  for (let i = 0; i < auth._test.LOGIN_FAIL_EMAIL_LIMIT; i++) auth.recordLoginFailure(spread, `10.0.${Math.floor(i / 200)}.${i % 200}`, t0);
  assert.equal(auth.loginLocked(spread, '9.9.9.9', t0 + 1), true, 'many addresses still hit the email-wide limit');
  auth.clearLoginFailures(spread, '9.9.9.9');
  assert.equal(auth.loginLocked(spread, '9.9.9.9', t0 + 2), false);
});

test('a full throttle drops expired entries before any live lock', () => {
  const failures = auth._test.failures;
  failures.clear();
  const MAX = auth._test.THROTTLE_MAX_KEYS;
  const t0 = 50000000;
  const live = 'locked@example.com';
  for (let i = 0; i < auth._test.LOGIN_FAIL_LIMIT; i++) auth.recordLoginFailure(live, '3.3.3.3', t0);
  const staleAt = t0 - auth._test.LOGIN_FAIL_WINDOW_MS - 5;
  for (let i = 0; i < (MAX - 2) / 2; i++) auth.recordLoginFailure(`flood${i}@example.com`, '4.4.4.4', staleAt);
  assert.equal(failures.size, MAX);
  auth.recordLoginFailure('trigger@example.com', '5.5.5.5', t0 + 1);
  assert.ok(failures.size < 10, `size ${failures.size}`);
  assert.equal(auth.loginLocked(live, '3.3.3.3', t0 + 2), true, 'the oldest entry, still live, survived');
  failures.clear();
});

// ---- Mail budget ------------------------------------------------------------

test('mail budget: one every two minutes and five a day per address, and a cap per hour overall', () => {
  auth._test.resetMailBudget();
  const gap = auth._test.MAIL_GAP_S;
  const t = 9000000;
  const inbox = 'inbox@example.com';
  assert.equal(auth.takeMailSlot(inbox, t), true);
  assert.equal(auth.takeMailSlot(inbox, t + 60), false, 'too soon');
  let at = t;
  for (let i = 1; i < auth._test.MAIL_PER_ADDRESS_PER_DAY; i++) {
    at += gap;
    assert.equal(auth.takeMailSlot(inbox, at), true);
  }
  assert.equal(auth.takeMailSlot(inbox, at + gap), false, 'a sixth in one day');
  assert.equal(auth.takeMailSlot(inbox, t + 86400 + 1), true, 'the oldest fell out of the day');

  auth._test.resetMailBudget();
  for (let i = 0; i < auth._test.MAIL_PER_HOUR; i++) assert.equal(auth.takeMailSlot(`person${i}@example.com`, t), true);
  assert.equal(auth.takeMailSlot('one-more@example.com', t + 10), false, 'the hourly cap covers every address');
  assert.equal(auth.takeMailSlot('one-more@example.com', t + 3601), true);
  auth._test.resetMailBudget();
});

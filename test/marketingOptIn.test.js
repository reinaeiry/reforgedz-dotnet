// Tests for the news-by-email opt-in (decision G12, 2026-10-19) against the REAL
// schema: db.js is loaded with DATA_DIR pointed at a throwaway folder, so the
// migration runs exactly as it will on the live database.
//   - the users table gains marketing_opt_in (0/1, default 0), marketing_opt_in_at
//     (unix seconds) and marketing_opt_in_form (the wording version shown);
//   - every account starts at 0, a web sign-up included unless its box was a real tick;
//   - the choice round-trips: a tick, then an untick, each stamped with its time and
//     the wording version;
//   - only the JSON boolean true counts as a tick.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-optin-'));
process.env.DATA_DIR = dataDir;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const auth = require('../webAuth');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const row = (id) => db.prepare('SELECT marketing_opt_in, marketing_opt_in_at, marketing_opt_in_form FROM users WHERE steam_id = ?').get(id);

test('the migration adds the three columns, and an existing account defaults to 0 with no time or form', () => {
  const cols = db.prepare('PRAGMA table_info(users)').all();
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
  assert.ok(byName.marketing_opt_in, 'marketing_opt_in');
  assert.equal(byName.marketing_opt_in.dflt_value, '0');
  assert.equal(byName.marketing_opt_in.notnull, 1);
  assert.ok(byName.marketing_opt_in_at, 'marketing_opt_in_at');
  assert.ok(byName.marketing_opt_in_form, 'marketing_opt_in_form');

  // A Steam account written the way the Steam strategy writes it: no opt-in columns named.
  db.prepare("INSERT INTO users (steam_id, persona, avatar_url, role) VALUES ('76561190000000077', 'Old', '', 'user')").run();
  assert.deepEqual(row('76561190000000077'), { marketing_opt_in: 0, marketing_opt_in_at: null, marketing_opt_in_form: null });
  assert.deepEqual(auth.marketingOptInOf(db.prepare('SELECT * FROM users WHERE steam_id = ?').get('76561190000000077')),
    { marketingOptIn: false, marketingOptInAt: null, marketingOptInForm: null });
});

test('a web sign-up defaults to 0; a ticked box records 1 with the time and the wording version', () => {
  const plain = auth.createWebUser(db, { email: 'plain@example.com', passwordHash: 'h' });
  assert.deepEqual(row(plain.steam_id), { marketing_opt_in: 0, marketing_opt_in_at: null, marketing_opt_in_form: null });

  const ticked = auth.createWebUser(db, { email: 'ticked@example.com', passwordHash: 'h', marketingOptIn: true, now: 1_760_000_000 });
  assert.deepEqual(row(ticked.steam_id), { marketing_opt_in: 1, marketing_opt_in_at: 1_760_000_000, marketing_opt_in_form: auth.MARKETING_FORM });

  // Anything that is not the boolean true is not a tick.
  for (const v of ['true', 1, 'on', 'yes', {}, [], null, undefined]) {
    const u = auth.createWebUser(db, { email: `v${Math.random().toString(16).slice(2)}@example.com`, passwordHash: 'h', marketingOptIn: v });
    assert.equal(row(u.steam_id).marketing_opt_in, 0, `value ${JSON.stringify(v)} must not opt in`);
  }
});

test('the choice round-trips: tick, untick, each stamped with its time and the wording version', () => {
  const u = auth.createWebUser(db, { email: 'trip@example.com', passwordHash: 'h' });
  assert.equal(row(u.steam_id).marketing_opt_in, 0);

  const on = auth.setMarketingOptIn(db, u.steam_id, true, { now: 1_760_000_100 });
  assert.deepEqual(on, { marketingOptIn: true, marketingOptInAt: 1_760_000_100, marketingOptInForm: auth.MARKETING_FORM });
  assert.deepEqual(row(u.steam_id), { marketing_opt_in: 1, marketing_opt_in_at: 1_760_000_100, marketing_opt_in_form: auth.MARKETING_FORM });

  const off = auth.setMarketingOptIn(db, u.steam_id, false, { now: 1_760_000_200 });
  assert.deepEqual(off, { marketingOptIn: false, marketingOptInAt: 1_760_000_200, marketingOptInForm: auth.MARKETING_FORM });
  assert.deepEqual(row(u.steam_id), { marketing_opt_in: 0, marketing_opt_in_at: 1_760_000_200, marketing_opt_in_form: auth.MARKETING_FORM });

  // Setting it for an account that does not exist changes nothing and says so.
  assert.equal(auth.setMarketingOptIn(db, 'web:nobody', true), null);
  // And the other accounts are untouched.
  assert.equal(row('76561190000000077').marketing_opt_in, 0);
});

test('only the JSON boolean true is a tick (the request body check)', () => {
  assert.equal(auth.optInFromBody(true), true);
  for (const v of [false, 'true', 'on', 1, 0, null, undefined, {}, [], 'yes', ' true ']) {
    assert.equal(auth.optInFromBody(v), false, JSON.stringify(v));
  }
});

test('the wording and its version are set and plain', () => {
  assert.equal(auth.MARKETING_TEXT, 'Email me ReforgedZ news (you can stop any time)');
  assert.match(auth.MARKETING_FORM, /^[a-z0-9-]{3,32}$/);
});

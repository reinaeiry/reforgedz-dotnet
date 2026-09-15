// Tests for the buy-flow counters (funnel.js) against the REAL schema: db.js is
// loaded with DATA_DIR pointed at a throwaway folder, so every migration runs
// exactly as it will on the live database. Also the per-key cap the funnel beacon
// and the name lookup use (windowLimit.js), which needs no database.
// Needs better-sqlite3, so run it where the shop's node_modules are.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-funnel-'));
process.env.DATA_DIR = dataDir;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const funnel = require('../funnel');
const { windowLimit } = require('../windowLimit');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const utc = (...parts) => Date.UTC(...parts) / 1000;
const rowsFor = (day) => db.prepare('SELECT step, n FROM funnel_counts WHERE day = ? ORDER BY step').all(day);

// Run fn with console.error captured, and hand back what it printed.
function captureErrors(fn) {
  const lines = [];
  const prev = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try { return { result: fn(), lines }; } finally { console.error = prev; }
}

// ---- Counting ---------------------------------------------------------------

test('each step counts once per call, per UTC day, and a new day starts a new row', () => {
  const lastSecond = utc(2027, 0, 15, 23, 59, 59);
  assert.equal(funnel.countStep(db, 'buy_clicked', lastSecond), true);
  funnel.countStep(db, 'buy_clicked', lastSecond);
  funnel.countStep(db, 'payment_completed', lastSecond);
  funnel.countStep(db, 'buy_clicked', lastSecond + 1);
  assert.deepEqual(rowsFor('2027-01-15'), [{ step: 'buy_clicked', n: 2 }, { step: 'payment_completed', n: 1 }]);
  assert.deepEqual(rowsFor('2027-01-16'), [{ step: 'buy_clicked', n: 1 }]);
});

test('the server and page steps are the known steps, with no overlap and no repeats', () => {
  const all = [...funnel.SERVER_STEPS, ...funnel.CLIENT_STEPS];
  assert.equal(new Set(all).size, all.length, 'no step is both a server and a page step');
  assert.deepEqual([...all].sort(), [...funnel.STEPS].sort());
  assert.equal(new Set(funnel.STEPS).size, funnel.STEPS.length);
  assert.deepEqual(funnel.CLIENT_STEPS, ['buy_clicked', 'signin_shown', 'id_prompt_shown', 'discord_prompt_shown', 'checkout_cancelled_seen']);
  for (const s of ['account_created', 'signed_in', 'id_saved_find', 'id_saved_paste', 'checkout_started', 'checkout_blocked_duplicate', 'payment_completed']) {
    assert.ok(funnel.SERVER_STEPS.includes(s), s);
  }
});

test('an unknown step or an unusable time stores nothing, returns false and logs', () => {
  const day = utc(2027, 1, 1, 12);
  const { lines } = captureErrors(() => {
    assert.equal(funnel.countStep(db, 'nope', day), false);
    assert.equal(funnel.countStep(db, '__proto__', day), false);
    assert.equal(funnel.countStep(db, { toString: () => 'buy_clicked' }, day), false);
    assert.equal(funnel.countStep(db, 'buy_clicked', NaN), false);
  });
  assert.deepEqual(rowsFor('2027-02-01'), []);
  assert.equal(lines.length, 4);
  for (const l of lines) assert.match(l, /^\[funnel\] could not count a step/);
});

test('a broken database never throws out of countStep', () => {
  const broken = { prepare() { throw new Error('database is locked'); } };
  const { result, lines } = captureErrors(() => funnel.countStep(broken, 'signed_in', utc(2027, 1, 2)));
  assert.equal(result, false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /database is locked/);
});

test('the table holds a day, a step and a count, and nothing that names a player', () => {
  assert.deepEqual(db.prepare('PRAGMA table_info(funnel_counts)').all().map(c => c.name), ['day', 'step', 'n']);
});

test('dayOf is the UTC calendar day', () => {
  assert.equal(funnel.dayOf(utc(2027, 5, 30, 23, 59, 59)), '2027-06-30');
  assert.equal(funnel.dayOf(utc(2027, 6, 1, 0, 0, 0)), '2027-07-01');
  assert.equal(funnel.dayOf('not a time'), null);
});

// ---- Reading ----------------------------------------------------------------

test('readFunnel returns the last N days including today, newest first', () => {
  const today = utc(2028, 2, 31, 12);
  funnel.countStep(db, 'checkout_started', today);
  funnel.countStep(db, 'signin_shown', today);
  funnel.countStep(db, 'checkout_started', today - 86400);
  funnel.countStep(db, 'checkout_started', today - 29 * 86400);
  funnel.countStep(db, 'checkout_started', today - 30 * 86400);
  const out = funnel.readFunnel(db, { days: 30, now: today });
  assert.equal(out.days, 30);
  assert.equal(out.since, '2028-03-02');
  assert.deepEqual(out.steps, funnel.STEPS);
  assert.deepEqual(out.rows, [
    { day: '2028-03-31', step: 'checkout_started', n: 1 },
    { day: '2028-03-31', step: 'signin_shown', n: 1 },
    { day: '2028-03-30', step: 'checkout_started', n: 1 },
    { day: '2028-03-02', step: 'checkout_started', n: 1 }
  ]);
});

test('readFunnel keeps days between 1 and 366 and defaults to 30', () => {
  const now = utc(2028, 2, 31, 12);
  assert.equal(funnel.readFunnel(db, { days: '7', now }).days, 7);
  assert.equal(funnel.readFunnel(db, { days: 0, now }).days, 1);
  assert.equal(funnel.readFunnel(db, { days: -5, now }).days, 1);
  assert.equal(funnel.readFunnel(db, { days: 9999, now }).days, 366);
  assert.equal(funnel.readFunnel(db, { days: 'abc', now }).days, 30);
  assert.equal(funnel.readFunnel(db, { now }).days, 30);
  assert.deepEqual(funnel.readFunnel(db, { days: 1, now }).rows.map(r => r.day), ['2028-03-31', '2028-03-31']);
});

// ---- The per-key cap ----------------------------------------------------------

test('windowLimit allows the limit per key per window, then starts again', () => {
  const take = windowLimit({ limit: 3, windowMs: 1000 });
  const t0 = 1000000;
  assert.equal(take('a', t0), true);
  assert.equal(take('a', t0 + 1), true);
  assert.equal(take('a', t0 + 2), true);
  assert.equal(take('a', t0 + 3), false);
  assert.equal(take('b', t0 + 3), true, 'another key has its own count');
  assert.equal(take('a', t0 + 999), false);
  assert.equal(take('a', t0 + 1000), true, 'a new window');
});

test('windowLimit forgets the oldest keys past maxKeys but keeps the one it is counting', () => {
  const take = windowLimit({ limit: 1, windowMs: 60000, maxKeys: 3 });
  const t0 = 5000000;
  for (let i = 0; i < 10; i++) assert.equal(take(`k${i}`, t0), true);
  assert.equal(take('k9', t0), false, 'the newest keys are still counted');
  assert.equal(take('k8', t0), false);
  assert.equal(take('k0', t0), true, 'the oldest key was forgotten');
  assert.equal(take('k0', t0), false);
});

test('windowLimit refuses a limit or window that is not positive', () => {
  assert.throws(() => windowLimit({ limit: 0, windowMs: 1000 }));
  assert.throws(() => windowLimit({ limit: 5, windowMs: 0 }));
  assert.throws(() => windowLimit({ limit: 'many', windowMs: 1000 }));
});

// Tests for the "your priority queue ends soon" run (tools/reminders.js) and its
// email (invoiceMail.priorityQueueEndingEmail) against the REAL schema: db.js is
// loaded with DATA_DIR pointed at a throwaway folder, so every migration runs
// exactly as it will on the live database. Mail goes to a fake sender.
// Needs better-sqlite3, so run it where the shop's node_modules are.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-reminders-'));
process.env.DATA_DIR = dataDir;
process.env.BASE_URL = 'https://shop.example.test';
delete process.env.EXPIRY_REMINDERS;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const reminders = require('../tools/reminders');
const { priorityQueueEndingEmail } = require('../invoiceMail');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const HOUR = 3600;
const DAY = 86400;
// Each test works around its own moment, 60 days apart, so one test's orders
// never fall inside another test's window.
const at = (k) => 1800000000 + k * 60 * DAY;

let seq = 0;
function user({ persona = null, platform = 'steam', gamertag = null, biUidName = null } = {}) {
  seq += 1;
  const id = `7656119${String(seq).padStart(10, '0')}`;
  db.prepare('INSERT INTO users (steam_id, persona, platform, gamertag, bi_uid_name) VALUES (?, ?, ?, ?, ?)')
    .run(id, persona || `Player${seq}`, platform, gamertag, biUidName);
  return id;
}

function product({ pq = 1, serverSpecific = 1, type = 'subscription', active = 1, title = null } = {}) {
  seq += 1;
  return Number(db.prepare('INSERT INTO products (title, price_cents, type, grants_priority_queue, server_specific, active) VALUES (?, 1500, ?, ?, ?, ?)')
    .run(title || `Product ${seq}`, type, pq, serverSpecific, active).lastInsertRowid);
}

const PQ_EU = product({ title: 'Priority Queue' });
const PQ_GLOBAL = product({ serverSpecific: 0, title: 'Priority Queue (all servers)' });
const PQ_ONE_TIME = product({ type: 'one_time', title: 'Priority Queue 30 days' });
const ROLE_ONLY = product({ pq: 0, serverSpecific: 0, type: 'one_time' });

function order(steamId, productId, {
  status = 'completed', serverId = 'eu1', sub = null, stripeSub = null, until, testMode = 0,
  cancelledAt = null, endedReason = null, email = 'buyer@example.com', completedAt = null
} = {}) {
  const done = completedAt == null ? (until || 0) - 30 * DAY : completedAt;
  return Number(db.prepare(`
    INSERT INTO orders (steam_id, product_id, server_id, status, amount_cents, test_mode, paypal_subscription_id,
                        stripe_subscription_id, effective_until, subscription_cancelled_at, subscription_ended_reason,
                        payer_email, created_at, completed_at)
    VALUES (?, ?, ?, ?, 1500, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(steamId, productId, serverId, status, testMode, sub, stripeSub, until, cancelledAt, endedReason, email, done, done).lastInsertRowid);
}

// A subscription the player cancelled, still paid up until `until`.
const cancelledSub = (steamId, productId, sub, until, extra = {}) => order(steamId, productId, {
  sub, until, cancelledAt: until - 20 * DAY, endedReason: 'cancelled', ...extra
});

function fakeSender(reply = async () => ({ ok: true })) {
  const sent = [];
  return { sent, send: async (payload) => { sent.push(payload); return reply(payload, sent.length); } };
}

// A real run, with its one summary line kept out of the test output.
async function run(opts) {
  const prev = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try { return await reminders.runExpiryReminders({ db, ...opts }); } finally { Object.assign(console, prev); }
}

const claimed = (orderId) => db.prepare('SELECT effective_until, sent_at FROM reminder_sent WHERE order_id = ? ORDER BY effective_until').all(orderId);

// ---- The main case, and at most once ------------------------------------------

test('a cancelled subscription ending in 48 to 72 hours gets one reminder with the shop link, and never a second', async () => {
  const now = at(1);
  const buyer = user({ persona: 'Rook' });
  order(buyer, PQ_EU, { sub: 'I-A', until: now - 5 * DAY, cancelledAt: now - DAY, endedReason: 'cancelled', email: 'first@example.com', completedAt: now - 35 * DAY });
  const newest = order(buyer, PQ_EU, { sub: 'I-A', until: now + 60 * HOUR, cancelledAt: now - DAY, endedReason: 'cancelled', email: 'latest@example.com', completedAt: now - 5 * DAY });

  const mail = fakeSender();
  const first = await run({ now, send: mail.send });
  assert.equal(first.due, 1);
  assert.equal(first.sent, 1);
  assert.deepEqual(mail.sent, [{
    to: 'latest@example.com',
    displayName: 'Rook',
    productTitle: 'Priority Queue',
    serverLabel: 'EU1 (Chernarus)',
    endsAt: now + 60 * HOUR,
    restartUrl: `https://shop.example.test/shop?buy=${PQ_EU}&server=eu1`
  }]);
  assert.deepEqual(first.items, [{ orderId: newest, effectiveUntil: now + 60 * HOUR, serverId: 'eu1', productId: PQ_EU, kind: 'cancelled_subscription', status: 'sent' }]);
  assert.deepEqual(claimed(newest), [{ effective_until: now + 60 * HOUR, sent_at: now }]);
  assert.doesNotMatch(JSON.stringify(first), /@/, 'the summary carries no email address');

  const again = await run({ now, send: mail.send });
  assert.equal(again.sent, 0);
  assert.equal(again.counts.alreadySent, 1);
  const hourLater = await run({ now: now + HOUR, send: mail.send });
  assert.equal(hourLater.sent, 0);
  assert.equal(mail.sent.length, 1);
});

test('the window starts at 48 hours and ends just before 72 hours', async () => {
  const now = at(2);
  const ends = [48 * HOUR - 1, 48 * HOUR, 72 * HOUR - 1, 72 * HOUR].map((d) => ({ d, id: order(user(), PQ_ONE_TIME, { until: now + d }) }));
  const mail = fakeSender();
  const out = await run({ now, send: mail.send, dryRun: true });
  assert.deepEqual(out.items.map(i => i.orderId), [ends[1].id, ends[2].id]);
  assert.equal(out.windowStart, now + 48 * HOUR);
  assert.equal(out.windowEnd, now + 72 * HOUR);
});

test('a dry run sends nothing, records nothing and shows order ids and dates only', async () => {
  const now = at(3);
  const id = order(user(), PQ_ONE_TIME, { until: now + 50 * HOUR, email: 'dry@example.com' });
  const mail = fakeSender();
  const out = await run({ now, send: mail.send, dryRun: true });
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.items, [{ orderId: id, effectiveUntil: now + 50 * HOUR, serverId: 'eu1', productId: PQ_ONE_TIME, kind: 'one_time', status: 'would_send' }]);
  assert.equal(mail.sent.length, 0);
  assert.deepEqual(claimed(id), []);
  assert.doesNotMatch(JSON.stringify(out), /@/);
});

// ---- What counts ----------------------------------------------------------------

test('a one-time purchase is reminded; a still-billing, sandbox, refunded, old Stripe or non priority queue order is not', async () => {
  const now = at(4);
  const until = now + 50 * HOUR;
  const oneTime = order(user(), PQ_ONE_TIME, { until });
  order(user(), PQ_EU, { sub: 'I-LIVE', until });
  cancelledSub(user(), PQ_EU, 'I-SANDBOX', until, { testMode: 1 });
  order(user(), PQ_ONE_TIME, { until, status: 'refunded' });
  order(user(), PQ_ONE_TIME, { until, stripeSub: 'sub_legacy' });
  order(user(), ROLE_ONLY, { until, serverId: null });
  const out = await run({ now, dryRun: true });
  assert.deepEqual(out.items.map(i => i.orderId), [oneTime]);
});

test('only the newest cycle of a subscription counts, and a tie on the end date is reminded once', async () => {
  const now = at(5);
  const longer = user();
  cancelledSub(longer, PQ_EU, 'I-OLDER', now + 50 * HOUR);
  cancelledSub(longer, PQ_EU, 'I-OLDER', now + 50 * HOUR + 30 * DAY);

  const tied = user();
  cancelledSub(tied, PQ_EU, 'I-TIE', now + 55 * HOUR);
  const higher = cancelledSub(tied, PQ_EU, 'I-TIE', now + 55 * HOUR);

  const out = await run({ now, dryRun: true });
  assert.deepEqual(out.items.map(i => i.orderId), [higher]);
});

test('another subscription still in its renewal window keeps covering; a cancelled, sandbox or undated order does not', async () => {
  const now = at(6);
  const until = now + 50 * HOUR;

  // Due two hours ago and still billing: PayPal has not taken the renewal yet.
  const renewing = user();
  const a = cancelledSub(renewing, PQ_EU, 'I-W1', until);
  order(renewing, PQ_EU, { sub: 'I-W2', until: now - 2 * HOUR });

  const cancelledEarlier = user();
  const b = cancelledSub(cancelledEarlier, PQ_EU, 'I-W3', until);
  cancelledSub(cancelledEarlier, PQ_EU, 'I-W4', now - 2 * HOUR);

  const sandbox = user();
  const c = cancelledSub(sandbox, PQ_EU, 'I-W5', until);
  order(sandbox, PQ_EU, { sub: 'I-W6', until: now + 20 * DAY, testMode: 1 });

  const undated = user();
  const d = cancelledSub(undated, PQ_EU, 'I-W7', until);
  order(undated, PQ_ONE_TIME, { until: null });

  const out = await run({ now, dryRun: true });
  assert.deepEqual(out.items.map(i => i.orderId).sort((x, y) => x - y), [b, c, d]);
  assert.deepEqual(out.skipped.map(s => [s.orderId, s.reason]), [[a, 'stillCovered']]);
  assert.equal(Object.prototype.hasOwnProperty.call(out.counts, 'billingIssue'), false, 'a failing renewal ends the subscription, so it is no reason to skip');
});

test('an account that keeps priority queue on that server another way is not reminded', async () => {
  const now = at(7);
  const until = now + 50 * HOUR;

  const renewing = user();
  const a = cancelledSub(renewing, PQ_EU, 'I-A1', until);
  order(renewing, PQ_EU, { sub: 'I-A2', until: now + 20 * DAY });

  const otherServer = user();
  const b = cancelledSub(otherServer, PQ_EU, 'I-B1', until);
  order(otherServer, PQ_EU, { sub: 'I-B2', serverId: 'eu2', until: now + 20 * DAY });

  const everywhere = user();
  const c = cancelledSub(everywhere, PQ_EU, 'I-C1', until);
  order(everywhere, PQ_GLOBAL, { sub: 'I-C2', serverId: null, until: now + 20 * DAY });

  const allServersEnding = user();
  const d = cancelledSub(allServersEnding, PQ_GLOBAL, 'I-D1', until, { serverId: null });
  order(allServersEnding, PQ_EU, { sub: 'I-D2', until: now + 20 * DAY });

  const boughtOnce = user();
  const e = cancelledSub(boughtOnce, PQ_EU, 'I-E1', until);
  order(boughtOnce, PQ_ONE_TIME, { until: now + 10 * DAY });

  const lapsedBefore = user();
  const f = cancelledSub(lapsedBefore, PQ_EU, 'I-F1', until);
  cancelledSub(lapsedBefore, PQ_EU, 'I-F0', now - 3 * DAY);

  // An order with no end date is not paid priority queue (pqEntitlement.js), so it
  // covers nothing and the dated one is reminded.
  const lifetime = user();
  const g = order(lifetime, PQ_ONE_TIME, { until });
  order(lifetime, PQ_ONE_TIME, { until: null });

  const stranger = user();
  const h = cancelledSub(stranger, PQ_EU, 'I-H1', until);
  order(user(), PQ_EU, { sub: 'I-H2', until: now + 20 * DAY });

  const out = await run({ now, dryRun: true });
  assert.deepEqual(out.items.map(i => i.orderId).sort((x, y) => x - y), [b, d, f, g, h]);
  assert.deepEqual(out.skipped.map(s => [s.orderId, s.reason]).sort((x, y) => x[0] - y[0]),
    [[a, 'stillCovered'], [c, 'stillCovered'], [e, 'stillCovered']]);
  assert.equal(out.items.find(i => i.orderId === d).serverId, null, 'an all-server order names no server');
});

test('no payer email skips; a subscription writes to its newest order that has one', async () => {
  const now = at(8);
  const none = cancelledSub(user(), PQ_EU, 'I-NOMAIL', now + 50 * HOUR, { email: null });
  const blank = order(user(), PQ_ONE_TIME, { until: now + 50 * HOUR, email: '   ' });

  const mixed = user();
  cancelledSub(mixed, PQ_EU, 'I-MIX', now - 5 * DAY, { email: 'paid-first@example.com', completedAt: now - 35 * DAY });
  cancelledSub(mixed, PQ_EU, 'I-MIX', now + 51 * HOUR, { email: null, completedAt: now - 5 * DAY });

  const changed = user();
  cancelledSub(changed, PQ_EU, 'I-NEW', now - 5 * DAY, { email: 'old@example.com', completedAt: now - 35 * DAY });
  cancelledSub(changed, PQ_EU, 'I-NEW', now + 52 * HOUR, { email: 'new@example.com', completedAt: now - 5 * DAY });

  const mail = fakeSender();
  const out = await run({ now, send: mail.send });
  assert.deepEqual(mail.sent.map(m => m.to), ['paid-first@example.com', 'new@example.com']);
  assert.deepEqual(out.skipped.map(s => [s.orderId, s.reason]), [[none, 'noEmail'], [blank, 'noEmail']]);
  assert.deepEqual(claimed(none), [], 'a skipped order is not recorded, so a fixed email still gets it');
});

// ---- Failure, the cap and new periods -------------------------------------------

test('the reminder is recorded before sending, so a failed or throwing send is never retried', async () => {
  const now = at(9);
  const one = order(user(), PQ_ONE_TIME, { until: now + 50 * HOUR });
  const two = order(user(), PQ_ONE_TIME, { until: now + 51 * HOUR });
  const flaky = fakeSender(async (payload, n) => {
    if (n === 1) return { ok: false, error: 'connection refused' };
    throw new Error('socket hang up');
  });
  const out = await run({ now, send: flaky.send });
  assert.equal(out.sent, 0);
  assert.equal(out.failed, 2);
  assert.deepEqual(out.items.map(i => i.status), ['failed', 'failed']);
  assert.equal(claimed(one).length, 1);
  assert.equal(claimed(two).length, 1);

  const good = fakeSender();
  const later = await run({ now: now + HOUR, send: good.send });
  assert.equal(good.sent.length, 0);
  assert.equal(later.counts.alreadySent, 2);
});

test('a run stops at the cap and the rest go out on the next run', async () => {
  const now = at(10);
  const made = [];
  for (let i = 0; i < 5; i++) made.push(order(user(), PQ_ONE_TIME, { until: now + 50 * HOUR + i }));
  const mail = fakeSender();
  const first = await run({ now, send: mail.send, max: 3 });
  assert.equal(first.sent, 3);
  assert.equal(first.counts.overCap, 2);
  const second = await run({ now, send: mail.send, max: 3 });
  assert.equal(second.sent, 2);
  assert.equal(second.counts.alreadySent, 3);
  assert.equal(mail.sent.length, 5);
  assert.equal(reminders.MAX_PER_RUN, 50);
});

test('a period extended by staff gets its own reminder', async () => {
  const now = at(11);
  const id = order(user(), PQ_ONE_TIME, { until: now + 50 * HOUR });
  const mail = fakeSender();
  assert.equal((await run({ now, send: mail.send })).sent, 1);
  db.prepare('UPDATE orders SET effective_until = ? WHERE id = ?').run(now + 30 * DAY + 50 * HOUR, id);
  assert.equal((await run({ now: now + 30 * DAY, send: mail.send })).sent, 1);
  assert.equal(claimed(id).length, 2);
});

test('an order on a product no longer on sale links to the shop front', async () => {
  const now = at(12);
  const retired = product({ type: 'one_time', active: 0, title: 'Old Priority Queue' });
  order(user({ persona: 'Player', gamertag: 'ConsoleRook' }), retired, { until: now + 50 * HOUR });
  const mail = fakeSender();
  await run({ now, send: mail.send });
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].restartUrl, 'https://shop.example.test/shop');
  assert.equal(mail.sent[0].displayName, 'ConsoleRook');
});

// ---- Pieces -----------------------------------------------------------------------

test('the Start again link, the greeting name and the off switch', () => {
  const base = 'https://x.test';
  assert.equal(reminders.restartUrlFor({ product_active: 1, server_specific: 1, server_id: 'na2', product_id: 7 }, base), 'https://x.test/shop?buy=7&server=na2');
  assert.equal(reminders.restartUrlFor({ product_active: 1, server_specific: 1, server_id: 'dev1', product_id: 7 }, base), 'https://x.test/shop?buy=7', 'never a server the shop does not sell');
  assert.equal(reminders.restartUrlFor({ product_active: 1, server_specific: 0, server_id: null, product_id: 8 }, base), 'https://x.test/shop?buy=8');
  assert.equal(reminders.restartUrlFor({ product_active: 0, server_specific: 1, server_id: 'eu1', product_id: 7 }, base), 'https://x.test/shop');

  assert.equal(reminders.playerName({ persona: 'Rook' }), 'Rook');
  assert.equal(reminders.playerName({ persona: 'Player', gamertag: 'Tag' }), 'Tag');
  assert.equal(reminders.playerName({ persona: 'Player', gamertag: null, bi_uid_name: 'InGame' }), 'InGame');
  assert.equal(reminders.playerName({ persona: 'Player' }), null);

  for (const v of ['off', 'OFF ', '0', 'false']) assert.equal(reminders.remindersOff({ EXPIRY_REMINDERS: v }), true, v);
  for (const v of ['', 'on', '1', undefined]) assert.equal(reminders.remindersOff({ EXPIRY_REMINDERS: v }), false, String(v));
});

test('the next run is the next 15:00 UTC', () => {
  assert.equal(reminders.nextRunAt(Date.UTC(2027, 0, 15, 14, 59, 59)), Date.UTC(2027, 0, 15, 15) / 1000);
  assert.equal(reminders.nextRunAt(Date.UTC(2027, 0, 15, 15, 0, 0)), Date.UTC(2027, 0, 16, 15) / 1000);
  assert.equal(reminders.nextRunAt(Date.UTC(2027, 11, 31, 20)), Date.UTC(2028, 0, 1, 15) / 1000);
});

test('a run without the database handle refuses to start', async () => {
  await assert.rejects(() => reminders.runExpiryReminders({ now: at(13) }), /database/);
});

// ---- The email ----------------------------------------------------------------------

test('the email says what ends and when, links only to the shop, in plain words', () => {
  const restartUrl = 'https://shop.example.test/shop?buy=3&server=eu1';
  const mail = priorityQueueEndingEmail({
    displayName: '<b>Rook</b>', productTitle: 'Priority Queue', serverLabel: 'EU1 (Chernarus)',
    endsAt: Date.UTC(2027, 0, 20, 12) / 1000, restartUrl
  });
  assert.equal(mail.subject, 'Your ReforgedZ priority queue ends soon');
  assert.match(mail.html, /Hi &lt;b&gt;Rook&lt;\/b&gt;,/);
  assert.doesNotMatch(mail.html, /<b>Rook/);
  assert.ok(mail.html.includes('href="https://shop.example.test/shop?buy=3&amp;server=eu1"'));
  assert.ok(mail.text.includes(restartUrl));
  for (const body of [mail.html, mail.text]) {
    assert.match(body, /EU1 \(Chernarus\)/);
    assert.match(body, /2027/);
    assert.match(body, /UTC/);
    assert.doesNotMatch(body, /[–—]/, 'no en or em dashes');
    assert.doesNotMatch(body, /dayz/i);
    assert.doesNotMatch(body, /password|reset|sign in|\/auth\//i, 'never a sign-in link');
  }

  const bare = priorityQueueEndingEmail({ endsAt: null });
  assert.match(bare.text, /^Hi there,/);
  assert.match(bare.text, /https:\/\/shop\.example\.test\/shop/);
  assert.doesNotMatch(bare.text, / on undefined| on null/);
});

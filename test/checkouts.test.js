// Tests for the unfinished-checkout jobs (tools/checkouts.js, decisions A3 and A4 of
// 2026-10-20) and the "finish your purchase" email (invoiceMail.finishCheckoutEmail)
// against the REAL schema: db.js is loaded with DATA_DIR pointed at a throwaway
// folder. Mail goes to a fake sender. Nothing connects to PayPal.
//   - expiry: a pending order older than 48 h with no payment booked and no paid
//     sibling cycle becomes 'cancelled' with cancelled_reason 'expired'; a paid,
//     refunded, captured or younger order is never touched, nor a cycle of a
//     subscription that has paid;
//   - the email: once per order, an hour or more after a live checkout that
//     reached PayPal, to the account's email only, the latest attempt only,
//     claimed before the send so a failure or a second run never sends it twice;
//   - the email renders both ways with the product, the amount and the link.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-checkouts-'));
process.env.DATA_DIR = dataDir;
process.env.BASE_URL = 'https://shop.example.test';
delete process.env.FINISH_REMINDERS;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const jobs = require('../tools/checkouts');
const webAuth = require('../webAuth');
const paypal = require('../paypal');
const { finishCheckoutEmail } = require('../invoiceMail');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const HOUR = 3600;
const NOW = 1_800_000_000;

let seq = 0;
function user({ email = null, persona = null } = {}) {
  seq += 1;
  const id = `web:${String(seq).padStart(24, '0')}`;
  db.prepare('INSERT INTO users (steam_id, persona, platform, email) VALUES (?, ?, ?, ?)').run(id, persona || 'Player', 'web', email);
  return id;
}
function product({ title, type = 'one_time', price = 500, pq = 0, serverSpecific = 0, active = 1, from = null, until = null } = {}) {
  seq += 1;
  return Number(db.prepare(`
    INSERT INTO products (title, price_cents, type, grants_priority_queue, server_specific, active, available_from, available_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title || `Product ${seq}`, price, type, pq, serverSpecific, active, from, until).lastInsertRowid);
}
function order(steamId, productId, {
  status = 'pending', ageS = 2 * HOUR, amount = 500, orderId = null, sub = null, capture = null, test = 0,
  serverId = null, completedAt = null, reason = null, remindedAt = null
} = {}) {
  const created = NOW - ageS;
  return Number(db.prepare(`
    INSERT INTO orders (steam_id, product_id, status, amount_cents, created_at, completed_at, paypal_order_id,
                        paypal_subscription_id, paypal_capture_id, test_mode, server_id, cancelled_reason, finish_reminder_sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(steamId, productId, status, amount, created, completedAt, orderId, sub, capture, test, serverId, reason, remindedAt).lastInsertRowid);
}
const row = (id) => db.prepare('SELECT status, cancelled_reason, finish_reminder_sent_at FROM orders WHERE id = ?').get(id);

function fakeSender(reply = async () => ({ ok: true })) {
  const sent = [];
  return { sent, send: async (payload) => { sent.push(payload); return reply(payload, sent.length); } };
}
// A run with PayPal saying "never approved" and an open mail budget, unless a test
// says otherwise, so the tests above the PayPal and budget ones stay about the rows.
async function run(opts) {
  const log = console.log; const err = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    return await jobs.runFinishReminders({ db, now: NOW, checkPayPal: async () => 'unapproved', mailSlot: () => true, ...opts });
  } finally { console.log = log; console.error = err; }
}
function expire(opts) {
  const log = console.log;
  console.log = () => {};
  try { return jobs.expireAbandonedCheckouts(db, { now: NOW, ...opts }); } finally { console.log = log; }
}

test('the migration adds cancelled_reason and finish_reminder_sent_at to orders', () => {
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  assert.ok(cols.includes('cancelled_reason'));
  assert.ok(cols.includes('finish_reminder_sent_at'));
});

// ---- Expiry (A4) -------------------------------------------------------------

test('expiry: pending checkouts older than 48 h expire; anything paid, captured, younger or a paying subscription\'s cycle is never touched', () => {
  // No email on this account, so none of these rows is ever due for the email tests below.
  const u = user();
  const p = product({ title: 'Supporter' });
  const oneTimeOld = order(u, p, { ageS: 49 * HOUR, orderId: 'PO-1' });
  const subOld = order(u, p, { ageS: 49 * HOUR, sub: 'S-new' });
  const neverReachedOld = order(u, p, { ageS: 49 * HOUR });
  const paidCycle = order(u, p, { ageS: 49 * HOUR, sub: 'S-paid' });                 // a renewal in flight...
  const paidFirst = order(u, p, { status: 'completed', ageS: 30 * 86400, sub: 'S-paid', capture: 'SALE-1', completedAt: NOW - 30 * 86400 }); // ...of this paid subscription
  const captured = order(u, p, { ageS: 49 * HOUR, orderId: 'PO-2', capture: 'CAP-2' });
  const completed = order(u, p, { status: 'completed', ageS: 49 * HOUR, orderId: 'PO-3', capture: 'CAP-3', completedAt: NOW - 49 * HOUR });
  const refunded = order(u, p, { status: 'refunded', ageS: 49 * HOUR, orderId: 'PO-4', capture: 'CAP-4', completedAt: NOW - 49 * HOUR });
  const cancelledBefore = order(u, p, { status: 'cancelled', ageS: 49 * HOUR });
  const young = order(u, p, { ageS: 47 * HOUR, orderId: 'PO-5' });
  const edge = order(u, p, { ageS: 48 * HOUR, orderId: 'PO-6' });                     // exactly 48 h: not yet

  const out = expire();
  assert.deepEqual(out.expired, [oneTimeOld, subOld, neverReachedOld]);
  for (const id of out.expired) assert.deepEqual(row(id), { status: 'cancelled', cancelled_reason: 'expired', finish_reminder_sent_at: null });
  assert.equal(row(paidCycle).status, 'pending', 'a cycle of a subscription that has paid is left alone');
  assert.equal(row(paidFirst).status, 'completed');
  assert.equal(row(captured).status, 'pending', 'a payment is booked on it');
  assert.equal(row(completed).status, 'completed');
  assert.equal(row(refunded).status, 'refunded');
  assert.deepEqual(row(cancelledBefore), { status: 'cancelled', cancelled_reason: null, finish_reminder_sent_at: null });
  assert.equal(row(young).status, 'pending');
  assert.equal(row(edge).status, 'pending');

  // A second run finds nothing more.
  assert.deepEqual(expire().expired, []);

  // Fulfilment still rescues an expired row, as it does any cancelled one: the
  // guard fulfillOrder uses, applied to the expired order, matches it.
  const guard = fs.readFileSync(path.join(__dirname, '..', 'routes', 'shop.js'), 'utf8');
  assert.ok(guard.includes("WHERE id = ? AND status IN ('pending', 'cancelled')"), 'fulfillOrder accepts a cancelled row');
  const rescued = db.prepare("UPDATE orders SET status = 'completed', completed_at = ? WHERE id = ? AND status IN ('pending', 'cancelled')").run(NOW, oneTimeOld);
  assert.equal(rescued.changes, 1);
});

// ---- The email (A3) ----------------------------------------------------------------

test('the email goes once per order, an hour after a live checkout that reached PayPal, to the account email, with the product, the amount and a restart link', async () => {
  const u = user({ email: ' Buyer@Example.com ', persona: 'Rook' });
  const p = product({ title: 'Supporter', price: 1000 });
  const due = order(u, p, { ageS: 90 * 60, orderId: 'PO-10', amount: 1000 });
  const tooYoung = order(u, product({ title: 'Other' }), { ageS: 30 * 60, orderId: 'PO-11' });
  const sender = fakeSender();

  const first = await run({ send: sender.send });
  assert.equal(first.due, 1);
  assert.equal(first.sent, 1);
  assert.deepEqual(first.items, [{ orderId: due, productId: p, serverId: null, kind: 'one_time', status: 'sent' }]);
  assert.equal(sender.sent.length, 1);
  const mail = sender.sent[0];
  assert.equal(mail.to, 'Buyer@Example.com');
  assert.equal(mail.displayName, 'Rook');
  assert.equal(mail.productTitle, 'Supporter');
  assert.equal(mail.amountCents, 1000);
  assert.equal(mail.currency, 'USD');
  assert.equal(mail.serverLabel, null);
  assert.equal(mail.canRestart, true);
  assert.equal(mail.restartUrl, `https://shop.example.test/shop?buy=${p}`);
  assert.equal(row(due).finish_reminder_sent_at, NOW);
  assert.equal(row(tooYoung).finish_reminder_sent_at, null);

  // Never twice: a second run, and a run an hour later, send nothing for it. (An
  // hour later the 30-minute-old order is due in its own right, so that run gets
  // its own sender.)
  const again = await run({ send: sender.send });
  assert.equal(again.due, 0);
  assert.equal(sender.sent.length, 1);
  const laterSender = fakeSender();
  const later = await run({ send: laterSender.send, now: NOW + HOUR });
  assert.deepEqual(later.items.map((i) => i.orderId), [tooYoung], 'only the order that has just become due');
  assert.equal(row(due).finish_reminder_sent_at, NOW, 'the first order keeps its one stamp');
});

test('not due: no account email, sandbox, expired age, a paying subscription\'s cycle, never reached PayPal, already completed, or superseded by a later attempt', async () => {
  const p = product({ title: 'Backer', type: 'subscription', price: 1000 });
  const noEmail = order(user(), p, { ageS: 2 * HOUR, sub: 'S-1' });
  const sandbox = order(user({ email: 's@example.com' }), p, { ageS: 2 * HOUR, sub: 'S-2', test: 1 });
  const tooOld = order(user({ email: 'o@example.com' }), p, { ageS: 49 * HOUR, sub: 'S-3' });
  const payer = user({ email: 'r@example.com' });
  order(payer, p, { status: 'completed', ageS: 20 * 86400, sub: 'S-4', capture: 'SALE-4', completedAt: NOW - 20 * 86400 });
  const renewal = order(payer, p, { ageS: 2 * HOUR, sub: 'S-4' });
  const neverReached = order(user({ email: 'n@example.com' }), p, { ageS: 2 * HOUR });
  const done = order(user({ email: 'd@example.com' }), p, { status: 'completed', ageS: 2 * HOUR, sub: 'S-6', capture: 'SALE-6', completedAt: NOW - HOUR });
  const retrier = user({ email: 't@example.com' });
  const earlierAttempt = order(retrier, p, { ageS: 3 * HOUR, sub: 'S-7a' });
  const laterAttempt = order(retrier, p, { ageS: 2 * HOUR, sub: 'S-7b' });
  const finisher = user({ email: 'f@example.com' });
  const abandoned = order(finisher, p, { ageS: 3 * HOUR, sub: 'S-8a' });
  order(finisher, p, { status: 'completed', ageS: 2 * HOUR, sub: 'S-8b', capture: 'SALE-8', completedAt: NOW - HOUR });

  const sender = fakeSender();
  const out = await run({ send: sender.send });
  assert.deepEqual(out.items.map((i) => i.orderId), [laterAttempt], 'only the latest attempt of the one account that is due');
  for (const id of [noEmail, sandbox, tooOld, renewal, neverReached, done, earlierAttempt, abandoned]) {
    assert.equal(row(id).finish_reminder_sent_at, null, `order ${id} not claimed`);
  }
  assert.equal(sender.sent[0].kind, undefined);
  assert.equal(sender.sent[0].productTitle, 'Backer');
  assert.equal(out.items[0].kind, 'subscription');
});

test('a server-specific priority queue checkout names the server and links straight into it; off-sale or inactive products get the shop front', async () => {
  const pq = product({ title: 'Priority Queue', type: 'subscription', price: 1500, pq: 1, serverSpecific: 1 });
  const ended = product({ title: 'Winter Armband', until: NOW - 86400 });
  const notYet = product({ title: 'Spring Armband', from: NOW + 86400 });
  const retired = product({ title: 'Old Thing', active: 0 });
  const u = user({ email: 'pq@example.com' });
  const pqOrder = order(u, pq, { ageS: 2 * HOUR, sub: 'S-PQ', amount: 1500, serverId: 'eu1' });
  const endedOrder = order(user({ email: 'w@example.com' }), ended, { ageS: 2 * HOUR, orderId: 'PO-W' });
  const notYetOrder = order(user({ email: 'sp@example.com' }), notYet, { ageS: 2 * HOUR, orderId: 'PO-S' });
  const retiredOrder = order(user({ email: 'rt@example.com' }), retired, { ageS: 2 * HOUR, orderId: 'PO-R' });

  const sender = fakeSender();
  const out = await run({ send: sender.send });
  assert.equal(out.sent, 4);
  const byOrder = Object.fromEntries(out.items.map((i, k) => [i.orderId, sender.sent[k]]));
  assert.equal(byOrder[pqOrder].serverLabel, 'EU1 (Chernarus)');
  assert.equal(byOrder[pqOrder].restartUrl, `https://shop.example.test/shop?buy=${pq}&server=eu1`);
  assert.equal(byOrder[pqOrder].canRestart, true);
  assert.equal(byOrder[pqOrder].amountCents, 1500);
  for (const id of [endedOrder, notYetOrder, retiredOrder]) {
    assert.equal(byOrder[id].canRestart, false, `order ${id}`);
    assert.equal(byOrder[id].restartUrl, 'https://shop.example.test/shop');
  }
});

test('a failed send, a dry run and the cap: claimed before sending, nothing claimed on a dry run, the rest wait for the next run', async () => {
  const p = product({ title: 'Supporter' });
  const a = order(user({ email: 'a1@example.com' }), p, { ageS: 2 * HOUR, orderId: 'PO-A' });
  const b = order(user({ email: 'b1@example.com' }), p, { ageS: 2 * HOUR, orderId: 'PO-B' });
  const c = order(user({ email: 'c1@example.com' }), p, { ageS: 2 * HOUR, orderId: 'PO-C' });

  const dry = await run({ dryRun: true, send: fakeSender().send });
  assert.equal(dry.due, 3);
  assert.equal(dry.sent, 0);
  for (const id of [a, b, c]) assert.equal(row(id).finish_reminder_sent_at, null);

  // The first send fails: the order stays claimed, so it is never retried.
  const failing = fakeSender(async (payload, n) => (n === 1 ? { ok: false, error: 'smtp down' } : { ok: true }));
  const capped = await run({ send: failing.send, max: 2 });
  assert.equal(capped.failed, 1);
  assert.equal(capped.sent, 1);
  assert.equal(capped.counts.overCap, 1);
  assert.equal(row(a).finish_reminder_sent_at, NOW, 'claimed although the send failed');
  assert.equal(row(b).finish_reminder_sent_at, NOW);
  assert.equal(row(c).finish_reminder_sent_at, null, 'over the cap: waits');

  const next = await run({ send: fakeSender().send, now: NOW + 15 * 60 });
  assert.deepEqual(next.items.map((i) => i.orderId), [c]);
  assert.equal(next.sent, 1);
});

test('a thrown sender counts as failed and never throws out of the run', async () => {
  const p = product({ title: 'Supporter' });
  const a = order(user({ email: 'x@example.com' }), p, { ageS: 2 * HOUR, orderId: 'PO-X' });
  const out = await run({ send: async () => { throw new Error('boom'); } });
  assert.equal(out.failed, 1);
  assert.equal(row(a).finish_reminder_sent_at, NOW);
});

test('PayPal is asked first: a checkout approved or paid there, or one PayPal could not be asked about, gets no email and stays unclaimed for the next run', async () => {
  const p = product({ title: 'Supporter' });
  const unapproved = order(user({ email: 'u1@example.com' }), p, { ageS: 2 * HOUR, orderId: 'PO-U' });
  const approved = order(user({ email: 'u2@example.com' }), p, { ageS: 2 * HOUR, orderId: 'PO-AP' });
  const unknown = order(user({ email: 'u3@example.com' }), p, { ageS: 2 * HOUR, orderId: 'PO-UN' });
  const states = { 'PO-U': 'unapproved', 'PO-AP': 'in_progress', 'PO-UN': 'unknown' };
  const sender = fakeSender();
  const out = await run({ send: sender.send, checkPayPal: async (row) => states[row.paypal_order_id] });
  assert.equal(out.due, 3);
  assert.deepEqual(out.items.map((i) => i.orderId), [unapproved]);
  assert.equal(out.counts.inProgress, 1);
  assert.equal(out.counts.unknown, 1);
  assert.equal(row(approved).finish_reminder_sent_at, null);
  assert.equal(row(unknown).finish_reminder_sent_at, null);
  // Next run, PayPal now answers "never approved" for the one it could not read: it goes.
  const next = await run({ send: sender.send, now: NOW + 15 * 60, checkPayPal: async (r) => (r.paypal_order_id === 'PO-AP' ? 'in_progress' : 'unapproved') });
  assert.deepEqual(next.items.map((i) => i.orderId), [unknown]);
  assert.equal(row(approved).finish_reminder_sent_at, null, 'still in progress at PayPal: still no email');
  // The rows the job hands PayPal carry the ids it needs: the one-time order id was
  // missing from the query once, and every one-time email was skipped for it.
  assert.equal(sender.sent.length, 2);
  // Tidy up: the approved order stays due by the rows alone, which the budget test
  // below must not see.
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(approved);
});

test('the PayPal state check: an unapproved order or an APPROVAL_PENDING subscription may be emailed; anything else is in progress; a failed call is unknown', async () => {
  const orig = { getOrder: paypal.getOrder, getSubscription: paypal.getSubscription };
  try {
    const answers = {};
    paypal.getOrder = async (test, id) => { assert.equal(test, false); if (answers[id] instanceof Error) throw answers[id]; return { id, status: answers[id] }; };
    paypal.getSubscription = async (test, id) => { assert.equal(test, false); if (answers[id] instanceof Error) throw answers[id]; return { id, status: answers[id] }; };
    const o = (id) => ({ id: 1, paypal_order_id: id, paypal_subscription_id: null });
    const s = (id) => ({ id: 2, paypal_order_id: null, paypal_subscription_id: id });
    Object.assign(answers, { A: 'CREATED', B: 'PAYER_ACTION_REQUIRED', C: 'SAVED', D: 'APPROVED', E: 'COMPLETED', F: 'VOIDED', G: new Error('paypal 500'),
      S1: 'APPROVAL_PENDING', S2: 'APPROVED', S3: 'ACTIVE', S4: 'CANCELLED', S5: new Error('timeout') });
    const err = console.error; console.error = () => {};
    try {
      for (const id of ['A', 'B', 'C']) assert.equal(await jobs.paypalState(o(id)), 'unapproved', id);
      for (const id of ['D', 'E', 'F']) assert.equal(await jobs.paypalState(o(id)), 'in_progress', id);
      assert.equal(await jobs.paypalState(o('G')), 'unknown');
      assert.equal(await jobs.paypalState(s('S1')), 'unapproved');
      for (const id of ['S2', 'S3', 'S4']) assert.equal(await jobs.paypalState(s(id)), 'in_progress', id);
      assert.equal(await jobs.paypalState(s('S5')), 'unknown');
    } finally { console.error = err; }
  } finally {
    Object.assign(paypal, orig);
  }
});

test('the mail budget: two due orders on one address in one run send one; the other waits for the next run and is never double-claimed', async () => {
  webAuth._test.resetMailBudget();
  const u = user({ email: 'budget@example.com' });
  const a = order(u, product({ title: 'Supporter' }), { ageS: 3 * HOUR, orderId: 'PO-B1' });
  const b = order(u, product({ title: 'Red Armband' }), { ageS: 2 * HOUR, orderId: 'PO-B2' });
  const sender = fakeSender();
  const first = await run({ send: sender.send, mailSlot: webAuth.takeMailSlot });
  assert.deepEqual(first.items.map((i) => i.orderId), [a]);
  assert.equal(first.counts.budget, 1);
  assert.equal(row(b).finish_reminder_sent_at, null);
  const second = await run({ send: sender.send, now: NOW + 15 * 60, mailSlot: webAuth.takeMailSlot });
  assert.deepEqual(second.items.map((i) => i.orderId), [b]);
  assert.equal(sender.sent.length, 2);
  assert.equal(row(a).finish_reminder_sent_at, NOW);
  assert.equal(row(b).finish_reminder_sent_at, NOW + 15 * 60);
  webAuth._test.resetMailBudget();
});

test('the switch: FINISH_REMINDERS=off, 0 or false turns the email off; anything else leaves it on', () => {
  assert.equal(jobs.remindersOff({}), false);
  assert.equal(jobs.remindersOff({ FINISH_REMINDERS: 'on' }), false);
  for (const v of ['off', 'OFF', '0', 'false', ' false ']) assert.equal(jobs.remindersOff({ FINISH_REMINDERS: v }), true, v);
});

// ---- The email itself ---------------------------------------------------------------

test('the email renders both ways: product, amount and link, escaped in the HTML, plain in the text, nothing else', () => {
  const mail = finishCheckoutEmail({
    displayName: '<b>Rook</b>', productTitle: 'Priority Queue', serverLabel: 'EU1 (Chernarus)',
    amountCents: 1500, currency: 'usd', restartUrl: 'https://shop.example.test/shop?buy=3&server=eu1', canRestart: true
  });
  assert.equal(mail.subject, 'Finish your ReforgedZ purchase');
  assert.match(mail.html, /Hi &lt;b&gt;Rook&lt;\/b&gt;,/);
  assert.doesNotMatch(mail.html, /<b>Rook/);
  assert.ok(mail.html.includes('<strong>Priority Queue</strong>'));
  assert.ok(mail.html.includes('<strong>15.00 USD</strong>'));
  assert.ok(mail.html.includes('href="https://shop.example.test/shop?buy=3&amp;server=eu1"'));
  assert.ok(mail.html.includes('Finish my purchase'));
  assert.ok(mail.text.includes('https://shop.example.test/shop?buy=3&server=eu1'));
  assert.ok(mail.text.includes('Priority Queue for EU1 (Chernarus) for 15.00 USD'));
  for (const body of [mail.html, mail.text]) {
    assert.ok(body.includes('nothing was charged'));
    assert.ok(body.includes('only reminder about this order'));
    assert.doesNotMatch(body, /undefined|null|NaN/);
    assert.doesNotMatch(body, /unsubscribe|newsletter|offer|discount|news/i, 'transactional only');
  }

  const off = finishCheckoutEmail({ displayName: null, productTitle: 'Winter Armband', amountCents: 500, restartUrl: 'https://shop.example.test/shop', canRestart: false });
  assert.match(off.text, /^Hi there,/);
  assert.ok(off.text.includes('not on sale right now'));
  assert.ok(off.html.includes('Open the shop'));
  assert.doesNotMatch(off.text, /start the purchase again/i);
  assert.doesNotMatch(off.text, /undefined|null/);
});

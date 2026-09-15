// Tests for the one priority queue rule (pqEntitlement.js) against the REAL schema:
// db.js is loaded with DATA_DIR pointed at a throwaway folder, so every migration
// runs exactly as it will on the live database, then the tests use it. Nothing is
// synced, posted or charged. Needs better-sqlite3, so run it where the shop's
// node_modules are.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-pqrule-'));
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_CEILING;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const pq = require('../pqEntitlement');
const { SERVER_IDS } = require('../gameServers');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const HOUR = 3600;
const DAY = 86400;
// Each test works around its own moment, far apart, so one test's orders are long
// over by the time another test looks.
const at = (k) => 1800000000 + k * 400 * DAY;

let seq = 0;
const next = () => ++seq;
const guidN = (n) => `0000abcd-0000-4000-8000-${String(n).padStart(12, '0')}`;

function user({ biUid } = {}) {
  const n = next();
  const id = `7656119${String(n).padStart(10, '0')}`;
  const guid = biUid === undefined ? guidN(n) : biUid;
  db.prepare('INSERT INTO users (steam_id, persona, bi_uid, platform) VALUES (?, ?, ?, ?)').run(id, `Player${n}`, guid, 'steam');
  return id;
}
const guidOf = (steamId) => db.prepare('SELECT bi_uid FROM users WHERE steam_id = ?').get(steamId).bi_uid;

function product({ grantsPq = 1, serverSpecific = 1, type = 'subscription', stockLimit = 40, title = null, overrides = null } = {}) {
  return Number(db.prepare(`
    INSERT INTO products (title, price_cents, type, grants_priority_queue, server_specific, stock_limit, stock_limit_overrides)
    VALUES (?, 1500, ?, ?, ?, ?, ?)
  `).run(title || `Product ${next()}`, type, grantsPq, serverSpecific, stockLimit, overrides).lastInsertRowid);
}

const PQ = product({ title: 'Priority Queue' });
const PQ_ALL = product({ serverSpecific: 0, title: 'Priority Queue (all servers)' });
const BACKER = product({ grantsPq: 0, serverSpecific: 0, title: 'ReforgedZ Backer', stockLimit: null });
const SUPPORTER = product({ grantsPq: 0, serverSpecific: 0, type: 'one_time', title: 'ReforgedZ Supporter', stockLimit: null });

function order(steamId, productId, {
  status = 'completed', serverId = 'eu1', sub = `I-SUB${next()}`, until = null, testMode = 0,
  cancelledAt = null, endedReason = null, createdAt = null
} = {}) {
  const created = createdAt != null ? createdAt : (until != null ? until - 30 * DAY : at(0));
  return Number(db.prepare(`
    INSERT INTO orders (steam_id, product_id, server_id, status, amount_cents, test_mode, paypal_subscription_id,
                        effective_until, subscription_cancelled_at, subscription_ended_reason, created_at, completed_at)
    VALUES (?, ?, ?, ?, 1500, ?, ?, ?, ?, ?, ?, ?)
  `).run(steamId, productId, serverId, status, testMode, sub, until, cancelledAt, endedReason, created,
    status === 'completed' ? created : null).lastInsertRowid);
}

function gameMasters(serverId, n) {
  db.prepare(`
    INSERT INTO config_admin_sync_state (server_id, non_shop_admin_count, updated_at) VALUES (?, ?, 0)
    ON CONFLICT(server_id) DO UPDATE SET non_shop_admin_count = excluded.non_shop_admin_count
  `).run(serverId, n);
}

const serverOf = (id) => db.prepare('SELECT server_id FROM orders WHERE id = ?').get(id).server_id;

// ---- The rule ---------------------------------------------------------------------

test('a paid, dated, live-mode order holds priority queue on its own server, until its paid period ends', () => {
  const now = at(1);
  const buyer = user();
  const g = guidOf(buyer);
  order(buyer, PQ, { serverId: 'eu2', sub: null, until: now + 10 * DAY });

  const sets = pq.pqGuidsPerServer(db, now);
  assert.deepEqual(Object.keys(sets), SERVER_IDS);
  assert.equal(sets.eu2.has(g), true);
  for (const s of ['eu1', 'na1', 'na2', 'dev1']) assert.equal(sets[s].has(g), false, s);

  assert.equal(pq.holdsPq(db, { biUid: ` ${g.toUpperCase()} `, serverId: 'eu2', now }), true, 'case and spaces are ignored');
  assert.equal(pq.holdsPq(db, { biUid: g, serverId: 'eu1', now }), false);
  assert.equal(pq.holdsPq(db, { biUid: g, now }), true, 'on any server');
  assert.equal(pq.holdsPq(db, { biUid: '', serverId: 'eu2', now }), false);
  assert.equal(pq.accountHoldsPq(db, { steamId: buyer, serverId: 'eu2', now }), true);
  assert.equal(pq.accountHoldsPq(db, { steamId: buyer, serverId: 'eu1', now }), false);
  assert.equal(pq.holdsPq(db, { biUid: g, serverId: 'eu2', now: now + 10 * DAY }), false, 'a one-time order ends at its end date');

  const rows = pq.livePqRows(db, now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item, 'Priority Queue');
  assert.equal(rows[0].server_id, 'eu2');
});

test('an order for every server covers every server the shop syncs', () => {
  const now = at(2);
  const buyer = user();
  const g = guidOf(buyer);
  order(buyer, PQ_ALL, { serverId: null, until: now + DAY });
  const sets = pq.pqGuidsPerServer(db, now);
  for (const s of SERVER_IDS) assert.equal(sets[s].has(g), true, s);
  assert.equal(pq.holdsPq(db, { biUid: g, serverId: 'eu3', now }), false, 'not a server the shop syncs');
  assert.deepEqual(pq.coveredServers({ server_specific: 0 }), SERVER_IDS);
  assert.deepEqual(pq.coveredServers({ server_specific: 1, server_id: 'na2' }), ['na2']);
  assert.deepEqual(pq.coveredServers({ server_specific: 1, server_id: 'eu3' }), []);
});

test('sandbox, undated, refunded, pending, cancelled and expired orders hold nothing; Backer and Supporter never do', () => {
  const now = at(3);
  const cases = {
    sandbox: { testMode: 1, until: now + DAY },
    undated: { until: null },
    refunded: { status: 'refunded', until: now + DAY },
    pending: { status: 'pending', until: now + DAY },
    cancelledRow: { status: 'cancelled', until: now + DAY },
    expiredOneTime: { sub: null, until: now }
  };
  for (const [name, opts] of Object.entries(cases)) {
    const u = user();
    order(u, PQ, opts);
    assert.equal(pq.holdsPq(db, { biUid: guidOf(u), now }), false, name);
    assert.equal(pq.accountHoldsPq(db, { steamId: u, now }), false, name);
  }

  const backer = user();
  order(backer, BACKER, { serverId: null, until: now + DAY });
  const supporter = user();
  order(supporter, SUPPORTER, { serverId: null, sub: null, until: null });
  for (const u of [backer, supporter]) assert.equal(pq.holdsPq(db, { biUid: guidOf(u), now }), false);

  const noId = user({ biUid: null });
  order(noId, PQ, { until: now + DAY });
  const blankId = user({ biUid: '' });
  order(blankId, PQ, { until: now + DAY });

  assert.deepEqual(pq.livePqRows(db, now), [], 'nothing above holds priority queue');
  for (const s of SERVER_IDS) assert.equal(pq.pqGuidsPerServer(db, now)[s].size, 0, s);
});

test('staff grants and blocks are ignored: a grant gives nothing and a block hides nothing', () => {
  const now = at(4);
  const grant = db.prepare('INSERT INTO priority_queue_grants (guid, server_id, removed, granted_by, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
  const gifted = guidN(900001);
  grant.run(gifted, 'eu1', 0, 'staff', now, null);
  grant.run(gifted, 'na1', 0, 'staff', now, now + DAY);

  const payer = user();
  const paid = guidOf(payer);
  order(payer, PQ, { serverId: 'eu1', until: now + DAY });
  grant.run(paid, 'eu1', 1, 'staff', now, null);

  assert.equal(pq.holdsPq(db, { biUid: gifted, now }), false, 'a staff grant is not a payment');
  assert.equal(pq.holdsPq(db, { biUid: paid, serverId: 'eu1', now }), true, 'a staff block does not hide a paid order');
  const sets = pq.pqGuidsPerServer(db, now);
  assert.deepEqual([...sets.eu1], [paid]);
  assert.equal(sets.na1.size, 0);
});

test('a subscription still billing keeps its slot until 6 hours after its due time; a cancelled or ended one gets no window', () => {
  const due = at(5);
  const W = pq.RENEWAL_WINDOW_S;
  assert.equal(W, 6 * HOUR);

  const renewing = user();
  order(renewing, PQ, { until: due });
  const cancelled = user();
  order(cancelled, PQ, { until: due, cancelledAt: due - 10 * DAY, endedReason: 'cancelled' });
  const unpaid = user();
  order(unpaid, PQ, { until: due, endedReason: 'unpaid' });
  const markedCancelled = user();
  order(markedCancelled, PQ, { until: due, cancelledAt: due - DAY });
  const oneTime = user();
  order(oneTime, PQ, { sub: null, until: due });

  const holds = (u, t) => pq.holdsPq(db, { biUid: guidOf(u), serverId: 'eu1', now: t });
  for (const u of [renewing, cancelled, unpaid, markedCancelled, oneTime]) assert.equal(holds(u, due - 1), true);
  assert.equal(holds(renewing, due), true, 'at the due time');
  assert.equal(holds(renewing, due + W - 1), true, 'due + 6 h - 1 s');
  assert.equal(holds(renewing, due + W), false, 'due + 6 h');
  assert.equal(holds(cancelled, due), false, 'cancelled: no window');
  assert.equal(holds(unpaid, due), false, 'ended as unpaid: no window');
  assert.equal(holds(markedCancelled, due), false, 'marked cancelled without a reason: no window');
  assert.equal(holds(oneTime, due), false, 'not a subscription: no window');

  assert.equal(pq.accountHoldsPq(db, { steamId: renewing, serverId: 'eu1', now: due + W - 1 }), true);
  assert.equal(pq.pqGuidsPerServer(db, due + W - 1).eu1.has(guidOf(renewing)), true, 'the set agrees');
  assert.equal(pq.pqGuidsPerServer(db, due + W).eu1.has(guidOf(renewing)), false);
});

test('the role rule: priority queue follows the rule with its window, other products keep their own', () => {
  const now = at(6);
  const perks = (steamId, t = now) => db.prepare(`
    SELECT COUNT(*) AS n FROM orders o JOIN products p ON p.id = o.product_id
    WHERE o.steam_id = @steamId AND ${pq.perksLiveSql('o', 'p')}
  `).get({ steamId, now: t }).n > 0;

  const renewer = user();
  order(renewer, PQ, { until: now - 2 * HOUR });
  const unpaid = user();
  order(unpaid, PQ, { until: now - 2 * HOUR, endedReason: 'unpaid' });
  const sandbox = user();
  order(sandbox, PQ, { until: now + DAY, testMode: 1 });
  const supporter = user();
  order(supporter, SUPPORTER, { serverId: null, sub: null, until: null });
  const sandboxSupporter = user();
  order(sandboxSupporter, SUPPORTER, { serverId: null, sub: null, until: null, testMode: 1 });
  const lapsedBacker = user();
  order(lapsedBacker, BACKER, { serverId: null, until: now - HOUR });
  const refundedSupporter = user();
  order(refundedSupporter, SUPPORTER, { serverId: null, sub: null, until: null, status: 'refunded' });

  assert.equal(perks(renewer), true, 'inside the renewal window');
  assert.equal(perks(renewer, now + 4 * HOUR), false, 'the window closed');
  assert.equal(perks(unpaid), false);
  assert.equal(perks(sandbox), false);
  assert.equal(perks(supporter), true, 'no end date never lapses');
  assert.equal(perks(sandboxSupporter), true, 'other products keep their old rule');
  assert.equal(perks(lapsedBacker), false);
  assert.equal(perks(refundedSupporter), false);

  assert.throws(() => pq.livePqOrderSql('o; DROP TABLE orders', 'p'), /alias/);
  assert.throws(() => pq.perksLiveSql('o', 'p)'), /alias/);
});

// ---- Slots --------------------------------------------------------------------------

test('slots are min(cap, ceiling - game masters) less the holders: 15 game masters and 35 holders leave none, 14 leave one', () => {
  const now = at(7);
  gameMasters('na2', 15);
  for (let i = 0; i < 35; i++) order(user(), PQ, { serverId: 'na2', until: now + 20 * DAY });

  assert.deepEqual({ ...pq.pqSlotFree(db, { serverId: 'na2', now, productId: PQ }) },
    { serverId: 'na2', cap: 40, gm: 15, ceiling: 50, limit: 35, used: 35, reserved: 0, available: 0, free: false });

  gameMasters('na2', 14);
  let s = pq.pqSlotFree(db, { serverId: 'na2', now, productId: PQ });
  assert.equal(s.limit, 36);
  assert.equal(s.available, 1);
  assert.equal(s.free, true);

  gameMasters('na2', 2);
  s = pq.pqSlotFree(db, { serverId: 'na2', now, productId: PQ });
  assert.equal(s.limit, 40, 'the cap binds when there are few game masters');
  assert.equal(s.available, 5);
  assert.equal(pq.pqSlotFree(db, { serverId: 'na2', now, productId: PQ, ceiling: 37 }).free, false, 'a lower ceiling');

  const holder = db.prepare("SELECT steam_id FROM orders WHERE server_id = 'na2' AND status = 'completed' AND effective_until = ? LIMIT 1").get(now + 20 * DAY).steam_id;
  order(holder, PQ, { serverId: 'na2', until: now + 25 * DAY });
  assert.equal(pq.pqSlotFree(db, { serverId: 'na2', now, productId: PQ }).used, 35, 'two orders for one ID take one slot');

  const capped = product({ overrides: JSON.stringify({ na2: 35 }) });
  assert.equal(pq.pqSlotFree(db, { serverId: 'na2', now, productId: capped }).free, false, 'a per-server cap');
  assert.equal(pq.stockCapFor({ stock_limit: 40, stock_limit_overrides: '{"na2":35}' }, 'na2'), 35);
  assert.equal(pq.stockCapFor({ stock_limit: 40, stock_limit_overrides: 'not json' }, 'na2'), 40);
  assert.equal(pq.stockCapFor({ stock_limit: null }, 'na2'), null);

  const uncapped = product({ stockLimit: null });
  gameMasters('na2', 14);
  s = pq.pqSlotFree(db, { serverId: 'na2', now, productId: uncapped });
  assert.equal(s.cap, null);
  assert.equal(s.limit, 36, 'with no cap the ceiling still binds');

  assert.equal(pq.pqSlotFree(db, { serverId: 'eu3', now, productId: PQ }).free, false, 'a server the shop does not sync');
  assert.equal(pq.adminCeiling({ ADMIN_CEILING: '45' }), 45);
  assert.equal(pq.adminCeiling({ ADMIN_CEILING: 'lots' }), 50);
  assert.equal(pq.adminCeiling({}), 50);

  const all = pq.pqSlotsPerServer(db, { product: db.prepare('SELECT * FROM products WHERE id = ?').get(PQ), now });
  assert.deepEqual(Object.keys(all), SERVER_IDS);
  gameMasters('na2', 0);
});

test('a checkout waiting at PayPal holds its slot for 30 minutes; abandoned, sandbox, other-server, own checkouts and a holder buying again do not', () => {
  const now = at(8);
  gameMasters('na1', 16);
  const holders = [];
  for (let i = 0; i < 33; i++) {
    const u = user();
    holders.push(u);
    order(u, PQ, { serverId: 'na1', until: now + 20 * DAY });
  }
  const slot = (extra = {}) => pq.pqSlotFree(db, { serverId: 'na1', now, productId: PQ, ...extra });
  assert.equal(slot().free, true, 'limit 34, 33 held');

  const buyer = user();
  const waiting = order(buyer, PQ, { status: 'pending', serverId: 'na1', createdAt: now - 10 * 60 });
  assert.equal(slot().reserved, 1);
  assert.equal(slot().free, false, 'the last slot is held for the buyer at PayPal');
  assert.equal(slot({ excludeSteamId: buyer }).free, true, "a buyer's own waiting checkout does not lock them out");
  assert.equal(slot({ excludeOrderId: waiting }).free, true);
  assert.equal(pq.pqSlotFree(db, { serverId: 'na1', now: now + 21 * 60, productId: PQ }).free, true, 'after 30 minutes it holds nothing');
  assert.equal(pq.CHECKOUT_RESERVATION_S, 30 * 60);
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(waiting);

  order(user(), PQ, { status: 'pending', serverId: 'na1', createdAt: now - 40 * 60 });
  order(user(), PQ, { status: 'pending', serverId: 'na1', createdAt: now - 60, testMode: 1 });
  order(user(), PQ, { status: 'pending', serverId: 'na2', createdAt: now - 60 });
  order(user(), PQ, { status: 'pending', serverId: 'na1', sub: null, createdAt: now - 60 });
  order(holders[1], PQ, { status: 'pending', serverId: 'na1', createdAt: now - 60 });
  assert.equal(slot().reserved, 0, 'abandoned, sandbox, another server, never a subscription, or an account already holding a slot here');
  assert.equal(slot().free, true);

  // Another account typing a holder's in-game ID is not that holder buying again.
  const borrowed = order(user({ biUid: guidOf(holders[0]).toUpperCase() }), PQ, { status: 'pending', serverId: 'na1', createdAt: now - 60 });
  assert.equal(slot().reserved, 1, "a holder's ID on another account still holds a slot");
  assert.equal(slot().free, false);
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(borrowed);

  const twin = guidN(900200);
  order(user({ biUid: twin }), PQ, { status: 'pending', serverId: 'na1', createdAt: now - 60 });
  order(user({ biUid: twin.toUpperCase() }), PQ, { status: 'pending', serverId: 'na1', createdAt: now - 60 });
  assert.equal(slot().reserved, 1, 'one in-game ID waiting twice holds one slot');

  order(user(), PQ_ALL, { status: 'pending', serverId: null, createdAt: now - 60 });
  assert.equal(pq.pqSlotFree(db, { serverId: 'na2', now, productId: PQ }).reserved, 2, 'an all-server checkout holds a slot on every server');
  gameMasters('na1', 0);
});

// ---- A staff move -------------------------------------------------------------------

test('a staff move changes the server on every row of the subscription, audits it, and renewals follow', () => {
  const now = at(9);
  gameMasters('eu1', 10);
  const buyer = user();
  const g = guidOf(buyer);
  const sub = 'I-MOVE-ALL';
  const first = order(buyer, PQ, { serverId: 'eu2', sub, until: now - 30 * DAY });
  const second = order(buyer, PQ, { serverId: 'eu2', sub, until: now + 5 * DAY });
  const abandoned = order(buyer, PQ, { serverId: 'eu2', sub, status: 'cancelled' });
  const otherSub = order(buyer, PQ, { serverId: 'na1', sub: 'I-MOVE-OTHER', until: now + 5 * DAY });
  const stranger = order(user(), PQ, { serverId: 'eu2', sub: 'I-MOVE-STRANGER', until: now + 5 * DAY });

  const res = pq.moveSubscriptionServer(db, {
    guid: g.toUpperCase(), from: 'eu2', to: 'eu1', actor: 'steam:76561190000000001', reason: 'wants to play with friends', ip: '127.0.0.1', now
  });
  assert.deepEqual({ ...res }, {
    ok: true, status: 200, orderId: second, subscriptionId: sub, steamId: buyer, productId: PQ,
    from: 'eu2', to: 'eu1', orderIds: [first, second, abandoned], updated: 3
  });
  for (const id of [first, second, abandoned]) assert.equal(serverOf(id), 'eu1');
  assert.equal(serverOf(otherSub), 'na1', "the account's other subscription is untouched");
  assert.equal(serverOf(stranger), 'eu2', "another account's order is untouched");

  // The renewal webhook copies the server from this row (routes/shop.js, PAYMENT.SALE.COMPLETED).
  const source = db.prepare(`
    SELECT server_id FROM orders WHERE paypal_subscription_id = ? AND status IN ('completed','pending') ORDER BY id ASC LIMIT 1
  `).get(sub);
  assert.equal(source.server_id, 'eu1');

  const sets = pq.pqGuidsPerServer(db, now);
  assert.equal(sets.eu1.has(g), true);
  assert.equal(sets.eu2.has(g), false);

  const audit = db.prepare("SELECT * FROM admin_audit WHERE action = 'pq.move' AND target = ?").all(buyer);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, 'steam:76561190000000001');
  assert.equal(audit[0].ts, now);
  assert.equal(audit[0].ip, '127.0.0.1');
  assert.equal(audit[0].reason, 'wants to play with friends');
  assert.deepEqual(JSON.parse(audit[0].before_json), { server_id: 'eu2', order_ids: [first, second, abandoned], subscription_id: sub });
  assert.deepEqual(JSON.parse(audit[0].after_json), { server_id: 'eu1' });
  gameMasters('eu1', 0);
});

test('a move is refused for a full destination, a lapsed or refunded order, a shared ID without orderId, the same server and a server not sold', () => {
  const now = at(10);
  for (const s of ['eu1', 'eu2', 'na1', 'na2']) gameMasters(s, 10);
  const move = (args) => pq.moveSubscriptionServer(db, { actor: 'apikey', now, ...args });
  const refusals = [];
  const refused = (r, status, code) => {
    assert.equal(r.ok, false, code);
    assert.equal(r.status, status, code);
    assert.equal(r.code, code);
    refusals.push(r);
    return r;
  };

  const a = user();
  const ga = guidOf(a);
  const aOrder = order(a, PQ, { serverId: 'na2', until: now + 5 * DAY });
  refused(move({ guid: ga, from: 'na2', to: 'na2' }), 400, 'same_server');
  refused(move({ guid: ga, to: 'na2' }), 400, 'same_server');
  refused(move({ guid: ga, from: 'na2', to: 'dev1' }), 400, 'bad_server');
  refused(move({ guid: ga, from: 'xx9', to: 'na1' }), 400, 'bad_server');
  refused(move({ guid: '  ', to: 'na1' }), 400, 'bad_request');

  gameMasters('na1', 50);
  const full = refused(move({ guid: ga, from: 'na2', to: 'na1' }), 409, 'destination_full');
  assert.deepEqual(full.slot, { limit: 0, used: 0, reserved: 0 });
  assert.equal(serverOf(aOrder), 'na2', 'nothing changed');
  gameMasters('na1', 10);

  const lapsed = user();
  const lapsedOrder = order(lapsed, PQ, { serverId: 'na2', sub: null, until: now - DAY });
  refused(move({ guid: guidOf(lapsed), from: 'na2', to: 'na1' }), 404, 'no_live_order');
  refused(move({ guid: guidOf(lapsed), to: 'na1', orderId: lapsedOrder }), 409, 'not_live');
  const refundedAcct = user();
  const refundedOrder = order(refundedAcct, PQ, { serverId: 'na2', status: 'refunded', until: now + 5 * DAY });
  refused(move({ guid: guidOf(refundedAcct), to: 'na1', orderId: refundedOrder }), 409, 'not_live');

  const shared = guidN(900300);
  const o1 = order(user({ biUid: shared }), PQ, { serverId: 'eu2', until: now + 5 * DAY });
  const o2 = order(user({ biUid: shared.toUpperCase() }), PQ, { serverId: 'eu2', until: now + 9 * DAY });
  const amb = refused(move({ guid: shared, from: 'eu2', to: 'eu1' }), 409, 'ambiguous');
  assert.deepEqual(amb.orderIds, [o1, o2]);
  assert.equal(serverOf(o1), 'eu2');
  assert.equal(serverOf(o2), 'eu2');

  const ok = move({ guid: shared, from: 'eu2', to: 'eu1', orderId: o2 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.orderIds, [o2]);
  refused(move({ guid: shared, to: 'eu1', orderId: o1 }), 409, 'already_on_destination');
  refused(move({ guid: ga, to: 'eu1', orderId: o1 }), 409, 'wrong_player');
  refused(move({ guid: shared, from: 'na2', to: 'na1', orderId: o1 }), 409, 'not_on_source');

  const global = user();
  const globalOrder = order(global, PQ_ALL, { serverId: null, until: now + 5 * DAY });
  refused(move({ guid: guidOf(global), to: 'eu1', orderId: globalOrder }), 400, 'not_movable');
  refused(move({ guid: guidOf(global), to: 'eu1' }), 404, 'no_live_order');
  refused(move({ guid: ga, to: 'eu1', orderId: 99999999 }), 404, 'no_order');

  const once = user();
  const onceOrder = order(once, PQ, { serverId: 'na2', sub: null, until: now + 5 * DAY });
  const moved = move({ guid: guidOf(once), to: 'na1', orderId: onceOrder });
  assert.equal(moved.ok, true, 'a one-time order moves by its id');
  assert.equal(moved.subscriptionId, null);
  assert.deepEqual(moved.orderIds, [onceOrder]);
  assert.equal(serverOf(onceOrder), 'na1');

  assert.throws(() => pq.moveSubscriptionServer(db, { guid: ga, from: 'na2', to: 'na1', now }), /staff member/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'pq.move' AND ts = ?").get(now).n, 2, 'only the two moves are audited');
  for (const r of refusals) assert.doesNotMatch(r.error, /[—–]|dayz/i, r.code);
  for (const s of ['eu1', 'eu2', 'na1', 'na2']) gameMasters(s, 0);
});

// ---- The grant machinery is gone ------------------------------------------------------

test('nothing reads or writes staff grants any more, and the grant machinery is gone', () => {
  const root = path.join(__dirname, '..');
  const files = [];
  for (const name of fs.readdirSync(root)) if (name.endsWith('.js')) files.push(path.join(root, name));
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) files.push(p);
    }
  };
  for (const dir of ['routes', 'tools', 'lib']) walk(path.join(root, dir));

  // The table is kept. Only the schema, the doctor's table list and the backup's row count name it.
  const mayName = new Set(['db.js', path.join('tools', 'doctor.js'), path.join('tools', 'lib', 'snapshot.js')]);
  const gone = ['rollGrantsForward', 'deriveHolderExpiry', 'applyPqGrant', 'applyPqDeny', 'clearLeftoverPqDenies',
    'clearLeftoverBlocksForOrder', 'blockedOnServer', 'queueMoveForOrder', 'leftoverBlockCards', 'playerQueueMoveCard',
    'pqSelfServiceInfo', 'PQ_SELF_MOVE_ENABLED'];
  const problems = [];
  for (const f of files) {
    const rel = path.relative(root, f);
    const text = fs.readFileSync(f, 'utf8');
    if (/(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+priority_queue_grants/i.test(text)) problems.push(`${rel} writes priority_queue_grants`);
    if (text.includes('priority_queue_grants') && !mayName.has(rel)) problems.push(`${rel} names priority_queue_grants`);
    for (const name of gone) if (text.includes(name)) problems.push(`${rel} still has ${name}`);
  }
  assert.ok(files.length > 20, `${files.length} files looked at`);
  assert.deepEqual(problems, []);
});

// ---- Racing checkouts, ID changes and abandoned checkouts ------------------------------
// Kept last, and on later moments than every test above: an order dated after a test's
// moment is still live when that test looks.

test('only checkouts started earlier count against an activating one, so the earlier buyer gets the last slot', () => {
  const now = at(11);
  gameMasters('eu2', 48);
  order(user(), PQ, { serverId: 'eu2', until: now + 20 * DAY });
  const early = order(user(), PQ, { status: 'pending', serverId: 'eu2', createdAt: now - 120 });
  const late = order(user(), PQ, { status: 'pending', serverId: 'eu2', createdAt: now - 60 });
  const tie = order(user(), PQ, { status: 'pending', serverId: 'eu2', createdAt: now - 60 });
  const mark = (id) => { const r = db.prepare('SELECT created_at, id FROM orders WHERE id = ?').get(id); return { createdAt: r.created_at, id: r.id }; };
  const slotFor = (id) => pq.pqSlotFree(db, { serverId: 'eu2', now, productId: PQ, excludeOrderId: id, reservedBefore: mark(id) });
  assert.equal(slotFor(early).reserved, 0);
  assert.equal(slotFor(early).free, true, 'later checkouts never push out the earliest');
  assert.equal(slotFor(late).reserved, 1);
  assert.equal(slotFor(late).free, false);
  assert.equal(slotFor(tie).reserved, 2, 'started in the same second: the lower order id is the earlier');
  assert.equal(pq.pqSlotFree(db, { serverId: 'eu2', now, productId: PQ }).reserved, 3, 'the shop page and checkout count them all');
  gameMasters('eu2', 0);
});

test('changing an in-game ID is refused only where it would add a second entry on a full server', () => {
  const now = at(12);
  gameMasters('na1', 48);
  const ax = user();
  const gx = guidOf(ax);
  order(ax, PQ, { serverId: 'na1', until: now + 10 * DAY });
  const s1 = user();
  order(s1, PQ, { serverId: 'na1', until: now + 10 * DAY });
  const shared = user({ biUid: gx });
  order(shared, PQ, { serverId: 'na1', until: now + 10 * DAY });
  assert.equal(pq.pqSlotFree(db, { serverId: 'na1', now, productId: PQ }).free, false, 'two IDs against a limit of two');

  const fresh = guidN(900400);
  const change = (steamId, fromBiUid, toBiUid) => pq.idChangeFullServers(db, { steamId, fromBiUid, toBiUid, now });
  assert.deepEqual(change(s1, guidOf(s1), fresh), [], 'the old ID leaves as the new one comes');
  assert.deepEqual(change(shared, gx, fresh), ['na1'], 'the old ID stays for the other account, so the new one is a second entry');
  assert.deepEqual(change(shared, gx, guidOf(s1).toUpperCase()), [], 'an ID already listed there adds nothing');
  assert.deepEqual(change(shared, gx, gx.toUpperCase()), [], 'the same ID');
  assert.deepEqual(change(user(), null, fresh), [], 'no priority queue, nothing moves');
  gameMasters('na1', 47);
  assert.deepEqual(change(shared, gx, fresh), [], 'a server with a free slot takes it');
  gameMasters('na1', 0);
});

test('priority queue checkouts started and never finished are counted per account for a day', () => {
  const now = at(13);
  const buyer = user();
  order(buyer, PQ, { status: 'pending', createdAt: now - 60 });
  order(buyer, PQ, { status: 'cancelled', createdAt: now - HOUR });
  order(buyer, PQ, { until: now + DAY, createdAt: now - 2 * HOUR });
  order(buyer, PQ, { status: 'pending', createdAt: now - 60, testMode: 1 });
  order(buyer, PQ, { status: 'pending', createdAt: now - 60, sub: null });
  order(buyer, PQ, { status: 'cancelled', createdAt: now - 25 * HOUR });
  order(buyer, BACKER, { status: 'pending', serverId: null, createdAt: now - 60 });
  assert.equal(pq.unfinishedPqCheckouts(db, { steamId: buyer, now }), 2, 'pending or cancelled, live mode, handed to PayPal, in the last day');
  assert.equal(pq.unfinishedPqCheckouts(db, { steamId: user(), now }), 0);
  assert.equal(pq.unfinishedPqCheckouts(db, { steamId: null, now }), 0);
  assert.equal(pq.PQ_CHECKOUTS_PER_DAY, 5);
});

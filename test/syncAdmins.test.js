// Tests for the game.admins sync (sync.js): which staff roles cover which server,
// when a lapsed shop-owned entry is released or stripped, the ceiling alert, and the
// entitlement builders the sync writes from. The builders run against the REAL
// schema (db.js with DATA_DIR pointed at a throwaway folder). Nothing connects to a
// game server or Discord. Needs better-sqlite3 and ssh2, so run it where the shop's
// node_modules are.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-syncadmins-'));
process.env.DATA_DIR = dataDir;
delete process.env.STAFF_DISCORD_ROLE_IDS;
delete process.env.ADMIN_CEILING;

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = () => {};
const db = require('../db');
Object.assign(console, quiet);
const sync = require('../sync');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const FOUNDER = '1360329397415972926';
const SYSTEMS_DEV = '1518411617187135518';
const GM_EU1 = '1497061513175765003';
const GM_NA2 = '1497064031259984033';
const GM_EU3 = '1499237259109601363';
const GM_NA3 = '1499237354324492378';
const SOLD = ['eu1', 'eu2', 'na1', 'na2', 'dev1'];

// ---- Staff roles per server --------------------------------------------------------

test('the default staff roles: the admin roles cover every server, each Gamemaster role only its own', () => {
  const roles = sync.staffRoleServers({});
  assert.equal(roles.size, 11);
  assert.deepEqual([...roles.keys()].sort(), [...sync.DEFAULT_STAFF_ROLE_IDS].sort());
  for (const s of SOLD) {
    assert.equal(sync.staffRoleCovering([FOUNDER], s, roles), FOUNDER, s);
    assert.equal(sync.staffRoleCovering([SYSTEMS_DEV], s, roles), SYSTEMS_DEV, s);
    assert.equal(sync.staffRoleCovering([GM_NA3], s, roles), null, `NA3 names no synced server (${s})`);
    assert.equal(sync.staffRoleCovering([GM_EU3], s, roles), null, `EU3 is the dev server (${s})`);
  }
  assert.equal(sync.staffRoleCovering([GM_EU1], 'eu1', roles), GM_EU1);
  assert.equal(sync.staffRoleCovering([GM_EU1], 'eu2', roles), null);
  assert.equal(sync.staffRoleCovering([GM_EU1, GM_NA2], 'na2', roles), GM_NA2);
  assert.equal(sync.staffRoleCovering(['123456789012345678'], 'eu1', roles), null, 'not a staff role');
  assert.equal(sync.staffRoleCovering(null, 'eu1', roles), null);
});

test('STAFF_DISCORD_ROLE_IDS replaces the map: a bare id covers every server, id:servers only those', () => {
  const roles = sync.staffRoleServers({
    STAFF_DISCORD_ROLE_IDS: ' 111111111111111111 , 222222222222222222:eu1, 333333333333333333:NA1+na2 ,444444444444444444:*, not-a-role:eu1, 55:eu1'
  });
  assert.deepEqual([...roles.keys()], ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444']);
  assert.equal(roles.get('111111111111111111'), '*');
  assert.equal(roles.get('444444444444444444'), '*');
  assert.deepEqual([...roles.get('333333333333333333')], ['na1', 'na2']);
  assert.equal(sync.staffRoleCovering(['222222222222222222'], 'eu1', roles), '222222222222222222');
  assert.equal(sync.staffRoleCovering(['222222222222222222'], 'eu2', roles), null);
  assert.equal(sync.staffRoleCovering(['333333333333333333'], 'na2', roles), '333333333333333333');
  assert.equal(sync.staffRoleCovering([FOUNDER], 'eu1', roles), null, 'the defaults are replaced, not added to');
});

test('staff protection is per server: shop admins everywhere, a Gamemaster on their own server, an unknown answer keeps the claim', () => {
  const roles = sync.staffRoleServers({});
  const gm = { steam_id: '76561190000000001', role: 'user', discord_id: '123456789012345678', discord_linked_via: 'oauth', persona: 'GmPlayer' };
  const protect = (extra) => sync.staffProtection({ user: gm, roleServers: roles, ...extra });

  const home = protect({ heldRoleIds: [GM_EU1], serverId: 'eu1' });
  assert.equal(home.kind, 'staff');
  assert.match(home.why, /covers eu1/);
  assert.equal(protect({ heldRoleIds: [GM_EU1], serverId: 'eu2' }), null, 'a Gamemaster on another server is a lapsed buyer there');
  assert.equal(protect({ heldRoleIds: [], serverId: 'eu1' }), null);
  assert.equal(protect({ heldRoleIds: [FOUNDER], serverId: 'na2' }).kind, 'staff');
  assert.equal(protect({ heldRoleIds: null, serverId: 'eu2' }).kind, 'unknown', 'no answer that settles it: kept for this sync');
  assert.equal(protect({ lookupError: 'HTTP 500', serverId: 'eu2' }).kind, 'unknown');
  assert.equal(protect({ notMember: true, serverId: 'eu1' }), null, 'not in the Discord: no staff role, stripped');

  // A Discord id typed into the paste box could be anyone's: its roles prove nothing.
  const pasted = { ...gm, discord_linked_via: 'paste' };
  assert.equal(sync.staffProtection({ user: pasted, heldRoleIds: [FOUNDER], serverId: 'eu1', roleServers: roles }), null);
  assert.equal(sync.staffProtection({ user: pasted, heldRoleIds: null, serverId: 'eu1', roleServers: roles }), null, 'and is never kept on an unknown answer');
  const legacy = { ...gm, discord_linked_via: null };
  assert.equal(sync.staffProtection({ user: legacy, heldRoleIds: [GM_EU1], serverId: 'eu1', roleServers: roles }), null, 'a link from before the shop recorded how it was made');

  const noDiscord = { ...gm, discord_id: null };
  assert.equal(sync.staffProtection({ user: noDiscord, serverId: 'eu1', roleServers: roles }), null, 'no Discord linked: staff status cannot be checked');
  assert.equal(sync.staffProtection({ user: noDiscord, serverId: 'na2', adminSteamIds: new Set([gm.steam_id]), roleServers: roles }).kind, 'staff', 'shop admins are staff everywhere');
  assert.equal(sync.staffProtection({ user: { ...noDiscord, role: 'admin' }, serverId: 'na2', roleServers: roles }).kind, 'staff');
});

test('a Gamemaster whose shop-owned priority queue lapsed stays listed on their own server and is stripped elsewhere', () => {
  const roles = sync.staffRoleServers({});
  const g = '0000abcd-0000-4000-8000-000000000777';
  const other = '0000abcd-0000-4000-8000-000000000778';
  const user = { steam_id: '76561190000000002', role: 'user', discord_id: '123456789012345679', discord_linked_via: 'oauth', persona: 'Mod' };
  const planFor = (serverId) => {
    const p = sync.staffProtection({ user, heldRoleIds: [GM_EU1], serverId, roleServers: roles });
    return sync.planAdmins({
      currentAdmins: [other, g], previouslyOwned: new Set([g]), desiredGuids: new Set(),
      protectedGuids: new Map(p ? [[g, p]] : [])
    });
  };
  const home = planFor('eu1');
  assert.deepEqual(home.strip, []);
  assert.deepEqual(home.released, [g]);
  assert.deepEqual(home.newAdmins, [other, g]);
  const away = planFor('eu2');
  assert.deepEqual(away.strip, [g]);
  assert.deepEqual(away.released, []);
  assert.deepEqual(away.newAdmins, [other]);
  assert.equal(away.newOwned.size, 0);
});

test("Discord's answer about a member: a member, not a member (404 Unknown Member or User), or no answer that settles it", () => {
  const discord = require('../discord');
  assert.deepEqual(discord.memberStateOf(200, { roles: [GM_EU1] }), { state: 'member', roles: [GM_EU1] });
  assert.deepEqual(discord.memberStateOf(200, {}), { state: 'member', roles: [] });
  assert.deepEqual(discord.memberStateOf(404, { code: 10007, message: 'Unknown Member' }), { state: 'not_member', status: 404 });
  assert.deepEqual(discord.memberStateOf(404, { code: 10013, message: 'Unknown User' }), { state: 'not_member', status: 404 });
  assert.equal(discord.memberStateOf(404, { code: 10004, message: 'Unknown Guild' }).state, 'unknown', 'a wrong guild says nothing about the player');
  assert.equal(discord.memberStateOf(404, null).state, 'unknown');
  for (const status of [401, 403, 429, 500, 502]) assert.equal(discord.memberStateOf(status, { code: 0 }).state, 'unknown', String(status));
});

test('a claim kept on an unknown answer runs out after a day', () => {
  const T = 1800000000;
  assert.equal(sync.UNKNOWN_KEEP_S, 24 * 3600);
  assert.equal(sync.unknownExpired(T, T), false);
  assert.equal(sync.unknownExpired(T, T + sync.UNKNOWN_KEEP_S - 1), false);
  assert.equal(sync.unknownExpired(T, T + sync.UNKNOWN_KEEP_S), true);
  assert.equal(sync.unknownExpired(undefined, T), false);
});

test('staff protection is asked only of the accounts that bought priority queue for that server', async () => {
  const now = 1800000000;
  const g = '0000abcd-0000-4000-8000-000000000901';
  const pqProduct = Number(db.prepare(
    "INSERT INTO products (title, price_cents, type, grants_priority_queue, server_specific, stock_limit) VALUES ('Priority Queue (staff test)', 1500, 'subscription', 1, 1, 40)"
  ).run().lastInsertRowid);
  const addUser = (steamId, extra) => {
    db.prepare('INSERT INTO users (steam_id, persona, bi_uid, platform) VALUES (?, ?, ?, ?)').run(steamId, 'Somebody', g, 'steam');
    for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE users SET ${k} = ? WHERE steam_id = ?`).run(v, steamId);
  };
  const addOrder = (steamId, serverId) => db.prepare(`
    INSERT INTO orders (steam_id, product_id, server_id, status, amount_cents, test_mode, paypal_subscription_id, effective_until, created_at, completed_at)
    VALUES (?, ?, ?, 'completed', 1500, 0, NULL, ?, ?, ?)
  `).run(steamId, pqProduct, serverId, now - 3600, now - 30 * 86400, now - 30 * 86400);

  // A shop admin carrying the same in-game ID, who bought priority queue only for another server.
  addUser('76561190000000901', { role: 'admin' });
  addOrder('76561190000000901', 'na1');
  // The buyer of the lapsed EU1 entry, whose Discord link was pasted.
  addUser('76561190000000902', { discord_id: '123456789012345601', discord_linked_via: 'paste' });
  addOrder('76561190000000902', 'eu1');

  const quietWarn = console.warn;
  console.warn = () => {};
  try {
    let out = await sync.protectedStaffGuids([g], 'eu1', now);
    assert.equal(out.size, 0, "another account's staff status does not keep this entry, and a pasted link proves nothing");
    out = await sync.protectedStaffGuids([g], 'na1', now);
    assert.equal(out.get(g).kind, 'staff', 'the shop admin bought for NA1, so it is their entry there');
  } finally {
    console.warn = quietWarn;
  }
});

// ---- The ceiling --------------------------------------------------------------------

test('the ceiling card: silent at the limit, once when over, again only when the list grows or 12 hours later', () => {
  const T = 1800000000;
  const step = (prev, planned, now) => sync.ceilingAlert(prev, { planned, ceiling: 50, now });
  assert.equal(sync.CEILING_REPEAT_S, 12 * 3600);

  assert.deepEqual(step(null, 50, T), { alert: false, next: null }, '50 of 50 is fine');
  let r = step(null, 51, T);
  assert.equal(r.alert, true, '51 of 50');
  assert.deepEqual(r.next, { planned: 51, at: T });
  r = step(r.next, 51, T + 600);
  assert.equal(r.alert, false, 'the next sync, unchanged');
  r = step(r.next, 50, T + 1200);
  assert.deepEqual(r, { alert: false, next: null }, 'back at the limit clears it');
  r = step(r.next, 51, T + 1800);
  assert.equal(r.alert, true, 'over again');
  r = step(r.next, 52, T + 2400);
  assert.equal(r.alert, true, 'grew');
  r = step(r.next, 51, T + 3000);
  assert.equal(r.alert, false, 'shrank, still over');
  const kept = r.next;
  assert.equal(kept.at, T + 2400);
  assert.equal(step(kept, 51, T + 2400 + sync.CEILING_REPEAT_S - 1).alert, false);
  assert.equal(step(kept, 51, T + 2400 + sync.CEILING_REPEAT_S).alert, true, 'still over twelve hours later');
});

// ---- What the sync writes -------------------------------------------------------------

test('the sync writes priority queue by the one rule: grants ignored, sandbox and undated left out, renewers kept; Backer, Supporter and Custom Flag never reach a game server', () => {
  const now = 1800000000;
  const HOUR = 3600;
  const DAY = 86400;
  let n = 0;
  const guid = (k) => `0000abcd-0000-4000-8000-${String(k).padStart(12, '0')}`;
  const user = (g) => {
    n++;
    const id = `7656119${String(n).padStart(10, '0')}`;
    db.prepare('INSERT INTO users (steam_id, persona, bi_uid, platform) VALUES (?, ?, ?, ?)').run(id, `Player${n}`, g, 'steam');
    return id;
  };
  const product = (title, grantsPq, serverSpecific, type = 'subscription') => Number(db.prepare(
    'INSERT INTO products (title, price_cents, type, grants_priority_queue, server_specific, stock_limit) VALUES (?, 1500, ?, ?, ?, 40)'
  ).run(title, type, grantsPq, serverSpecific).lastInsertRowid);
  const order = (steamId, productId, { serverId = 'eu1', sub = `I-S${++n}`, until = null, testMode = 0 } = {}) => db.prepare(`
    INSERT INTO orders (steam_id, product_id, server_id, status, amount_cents, test_mode, paypal_subscription_id, effective_until, created_at, completed_at)
    VALUES (?, ?, ?, 'completed', 1500, ?, ?, ?, ?, ?)
  `).run(steamId, productId, serverId, testMode, sub, until, now - 10 * DAY, now - 10 * DAY);

  const PQ = product('Priority Queue', 1, 1);
  const BACKER = product('ReforgedZ Backer', 0, 0);
  const SUPPORTER = product('ReforgedZ Supporter', 0, 0, 'one_time');
  const FLAG = product('Custom Flag', 0, 1, 'one_time');
  const LATER = product('A Later Perk', 0, 0, 'one_time');

  const [g1, g2, g3, g4, g5, g6, g7, g8, g9] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(guid);
  const payer = user(g1);
  order(payer, PQ, { serverId: 'eu1', until: now + 5 * DAY });
  order(payer, PQ, { serverId: 'eu1', sub: null, until: now + 9 * DAY });
  order(user(g2), PQ, { serverId: 'eu2', until: now - 2 * HOUR });
  order(user(g3), PQ, { serverId: 'eu1', until: now + 5 * DAY, testMode: 1 });
  order(user(g4), PQ, { serverId: 'na1', until: null });
  const grant = db.prepare('INSERT INTO priority_queue_grants (guid, server_id, removed, granted_by, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, NULL)');
  grant.run(g5, 'eu1', 0, 'staff', now);
  grant.run(g1, 'eu1', 1, 'staff', now);
  order(user(g6), BACKER, { serverId: null, until: now + 5 * DAY });
  order(user(g7), SUPPORTER, { serverId: null, sub: null, until: null });
  order(user(g8), FLAG, { serverId: 'eu1', sub: null, until: null });
  order(user(g9), LATER, { serverId: null, sub: null, until: null });
  // The priority queue buyer also backs the server: only their priority queue is written.
  order(payer, SUPPORTER, { serverId: null, sub: null, until: null });
  order(payer, BACKER, { serverId: null, until: now + 5 * DAY });

  const tail = (g) => g.slice(-3);
  const pqSets = sync.buildPriorityQueueGuidsPerServer(now);
  assert.deepEqual([...pqSets.eu1].map(tail), ['001'], 'paid, blocked or not; no grant, no sandbox');
  assert.deepEqual([...pqSets.eu2].map(tail), ['002'], 'a renewer inside the window');
  for (const s of ['na1', 'na2', 'dev1']) assert.equal(pqSets[s].size, 0, `${s}: an order with no end date gives nothing`);

  const buckets = sync.buildPerServerPurchaseBuckets(now);
  const items = (s) => buckets[s].map(e => `${tail(e.guid)}|${e.item}`).sort();
  assert.deepEqual(items('eu1'), ['001|Priority Queue'], 'two live orders for one ID are one entry; no Backer, Supporter or Custom Flag');
  assert.deepEqual(items('eu2'), ['002|Priority Queue']);
  for (const s of ['na1', 'na2', 'dev1']) assert.deepEqual(items(s), [], s);
  assert.deepEqual(Object.keys(buckets), SOLD);
  assert.deepEqual(buckets.eu1[0], { name: 'Player1', guid: g1, item: 'Priority Queue' }, 'the entry the mod reads is unchanged');
  for (const s of SOLD) {
    assert.ok(buckets[s].every(e => e.item === 'Priority Queue'), `${s}: priority queue only`);
    for (const g of [g6, g7, g8, g9]) assert.equal(buckets[s].some(e => e.guid === g), false, `${s} ${tail(g)}`);
  }

  // purchases.json and game.admins' priority queue part are the same IDs, both ways:
  // the mod never takes a buyer for a real admin, and the file names nobody else.
  for (const [s, set] of Object.entries(pqSets)) {
    assert.deepEqual(buckets[s].map(e => e.guid).sort(), [...set].sort(), s);
  }
  assert.equal(sync.purchaseSyncSummary(buckets, pqSets), '[sync] eu1=1 eu2=1 na1=0 na2=0 dev1=0');

  const later = now + 4 * HOUR;
  assert.equal(sync.buildPriorityQueueGuidsPerServer(later).eu2.size, 0, 'the renewal window closed');
  assert.equal(sync.buildPerServerPurchaseBuckets(later).eu2.some(e => e.item === 'Priority Queue'), false);
});

test('the sync log line: priority queue holders per server, and the file length only where the two differ', () => {
  const g = (k) => `0000abcd-0000-4000-8000-${String(k).padStart(12, '0')}`;
  const pq = { eu1: new Set([g(1), g(2)]), eu2: new Set([g(3)]), na1: new Set(), na2: new Set(), dev1: new Set() };
  const buckets = {
    eu1: [{ guid: g(1), item: 'Priority Queue' }, { guid: g(2), item: 'Priority Queue' }],
    // One ID holding two differently named priority queue products: two file entries, one admin entry.
    eu2: [{ guid: g(3), item: 'Priority Queue' }, { guid: g(3), item: 'Priority Queue 30 days' }],
    na1: [], na2: [], dev1: []
  };
  const line = sync.purchaseSyncSummary(buckets, pq);
  assert.equal(line, '[sync] eu1=2 eu2=1 (file 2) na1=0 na2=0 dev1=0');
  assert.ok(line.startsWith('[sync] eu1='), 'existing checks find the line by its start');
  assert.doesNotMatch(line, /pq=|0000abcd/);
  assert.equal(sync.purchaseSyncSummary({}, {}, ['eu1', 'na1']), '[sync] eu1=0 na1=0');
});

// The one priority queue rule.
//
// "Does this in-game ID hold priority queue on this server?" is asked in many
// places: the sync that writes each server's game.admins and purchases.json, the
// shop's stock and checkout, the staff holder list and move, the Discord Priority
// Queue role, the health card and the "ends soon" reminder. They all ask here, so
// they can never disagree about who holds a slot.
//
// The owner's rule (2026-09-15): priority queue is a paid order whose paid period
// has not ended. Nothing else counts: no staff grants, no grace days, no staff
// extensions, no sandbox orders, no order without an end date. Backer and
// Supporter are not priority queue (grants_priority_queue = 0); they only give a
// Discord role and keep their own rules.
//
// One allowance. An auto-renewing PayPal subscription that is still billing keeps
// its slot for RENEWAL_WINDOW_S after its paid period ends, while PayPal takes the
// renewal: PayPal charges a renewal some time after the due time, usually within a
// couple of hours. Without the window every renewer would drop out of the admin
// list and see their slot offered for sale each month. A subscription that was
// cancelled or ended gets no window, its paid period is all it has, and a renewal
// that never arrives frees the slot when the window closes.
//
// A priority queue order tied to one server covers that server; one that is not
// covers every server the shop syncs (SERVER_IDS).
//
// Every function takes the database handle and the time as parameters, and nothing
// runs on require (test/pqEntitlement.test.js).

const { SERVER_IDS, SELLABLE_SERVER_IDS, SERVER_LABELS } = require('./gameServers');

const HOUR_S = 3600;
const RENEWAL_WINDOW_S = 6 * HOUR_S;
// A checkout waiting at PayPal holds its slot this long, so two buyers cannot both
// approve the last one. Long enough for a buyer to finish at PayPal; an abandoned
// checkout stops holding anything after it.
const CHECKOUT_RESERVATION_S = 30 * 60;
// Reforger reads game.admins at start, and priority queue shares that list with the
// game masters. More than 50 entries has stopped servers starting, so the list never
// goes past this. Overridable with ADMIN_CEILING.
const DEFAULT_ADMIN_CEILING = 50;

const nowUnix = () => Math.floor(Date.now() / 1000);
const lowerId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const labelOf = (id) => SERVER_LABELS[id] || String(id || '').toUpperCase();

function adminCeiling(env = process.env) {
  const n = parseInt(env && env.ADMIN_CEILING, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_ADMIN_CEILING;
}

const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function alias(a) {
  if (!ALIAS_RE.test(String(a))) throw new TypeError(`not a table alias: "${a}"`);
  return a;
}

// ---- The rule, as SQL -----------------------------------------------------------
// A WHERE fragment: order `o`, joined to its product `p`, holds priority queue at
// the named parameter @now. Bind @now (unix seconds) in the statement that uses it.
function livePqOrderSql(o = 'o', p = 'p') {
  o = alias(o); p = alias(p);
  return `(${o}.status = 'completed'
    AND ${p}.grants_priority_queue = 1
    AND ${o}.test_mode = 0
    AND ${o}.effective_until IS NOT NULL
    AND (${o}.effective_until > @now
      OR (${o}.paypal_subscription_id IS NOT NULL
        AND ${o}.subscription_cancelled_at IS NULL
        AND ${o}.subscription_ended_reason IS NULL
        AND ${o}.effective_until + ${RENEWAL_WINDOW_S} > @now)))`;
}

// A WHERE fragment for "this order still gives its product's perks at @now", for the
// Discord roles. Priority queue follows the rule above, window included, so a renewer
// keeps the role through the renewal morning. Every other product keeps its own rule:
// completed and not expired, and an order with no end date never expires.
function perksLiveSql(o = 'o', p = 'p') {
  o = alias(o); p = alias(p);
  return `((${p}.grants_priority_queue = 0
      AND ${o}.status = 'completed'
      AND (${o}.effective_until IS NULL OR ${o}.effective_until > @now))
    OR ${livePqOrderSql(o, p)})`;
}

// The servers one order covers, from a row carrying server_specific and server_id.
function coveredServers(row, serverIds = SERVER_IDS) {
  if (!row) return [];
  if (!row.server_specific) return serverIds.slice();
  return row.server_id && serverIds.includes(row.server_id) ? [row.server_id] : [];
}

// Every order holding priority queue at `now` whose account has an in-game ID,
// oldest first.
function livePqRows(db, now = nowUnix()) {
  return db.prepare(`
    SELECT o.id AS order_id, o.steam_id, o.product_id, o.server_id, o.effective_until, o.created_at,
           o.paypal_subscription_id, u.bi_uid AS guid, COALESCE(u.gamertag, u.persona) AS name,
           p.title AS item, p.server_specific
    FROM orders o
    JOIN users u    ON u.steam_id = o.steam_id
    JOIN products p ON p.id = o.product_id
    WHERE ${livePqOrderSql('o', 'p')}
      AND u.bi_uid IS NOT NULL AND u.bi_uid != ''
    ORDER BY o.id ASC
  `).all({ now });
}

// { serverId: Set of in-game IDs } for every server in serverIds: exactly what the
// sync writes into each server's game.admins for priority queue. IDs are kept as
// stored, since that is how they sit in the admin list.
function pqGuidsPerServer(db, now = nowUnix(), serverIds = SERVER_IDS) {
  const out = Object.fromEntries(serverIds.map(id => [id, new Set()]));
  for (const r of livePqRows(db, now)) {
    for (const id of coveredServers(r, serverIds)) out[id].add(r.guid);
  }
  return out;
}

function anyCovers(rows, serverId) {
  if (serverId == null) return rows.some(r => coveredServers(r).length > 0);
  return rows.some(r => coveredServers(r).includes(serverId));
}

// Whether the in-game ID holds priority queue on serverId (any server when null),
// through any account (or any account but excludeSteamId). Case and surrounding
// spaces are ignored.
function holdsPq(db, { biUid, serverId = null, now = nowUnix(), excludeSteamId = null } = {}) {
  const guid = lowerId(biUid);
  if (!guid) return false;
  const rows = db.prepare(`
    SELECT o.server_id, p.server_specific
    FROM orders o JOIN users u ON u.steam_id = o.steam_id JOIN products p ON p.id = o.product_id
    WHERE lower(u.bi_uid) = @guid AND (@exSteam IS NULL OR o.steam_id != @exSteam) AND ${livePqOrderSql('o', 'p')}
  `).all({ guid, now, exSteam: excludeSteamId == null ? null : String(excludeSteamId) });
  return anyCovers(rows, serverId);
}

// The same question keyed on the account rather than the in-game ID, for checkout's
// "a renewal takes no new slot" exemption: anyone can type a holder's ID, so the
// exemption must come from the buyer's own orders.
function accountHoldsPq(db, { steamId, serverId = null, now = nowUnix() } = {}) {
  if (!steamId) return false;
  const rows = db.prepare(`
    SELECT o.server_id, p.server_specific
    FROM orders o JOIN products p ON p.id = o.product_id
    WHERE o.steam_id = @steamId AND ${livePqOrderSql('o', 'p')}
  `).all({ steamId: String(steamId), now });
  return anyCovers(rows, serverId);
}

// ---- Slots ----------------------------------------------------------------------

// Per-server stock cap for a server_specific product: the optional
// stock_limit_overrides JSON map ({serverId: limit}), else the shared stock_limit.
// null = no cap of its own.
function stockCapFor(product, serverId) {
  if (!product) return null;
  const raw = product.stock_limit_overrides;
  if (raw) {
    let ov = raw;
    if (typeof raw === 'string') { try { ov = JSON.parse(raw); } catch { ov = null; } }
    if (ov && ov[serverId] != null) return ov[serverId];
  }
  return product.stock_limit == null ? null : product.stock_limit;
}

// Game masters and other entries the shop did not write, per server, as the last
// sync measured them (sync.js stores non_shop_admin_count on every run).
function gmCountPerServer(db, serverIds = SERVER_IDS) {
  const out = Object.fromEntries(serverIds.map(id => [id, 0]));
  for (const row of db.prepare('SELECT server_id, non_shop_admin_count FROM config_admin_sync_state').all()) {
    if (Object.prototype.hasOwnProperty.call(out, row.server_id)) out[row.server_id] = row.non_shop_admin_count || 0;
  }
  return out;
}

// Priority queue checkouts waiting at PayPal: pending, handed to PayPal as a
// subscription, live mode, younger than CHECKOUT_RESERVATION_S. before
// ({ createdAt, id }) keeps only checkouts started earlier than that one.
function waitingCheckouts(db, { now, excludeSteamId = null, excludeOrderId = null, before = null }) {
  const bCreated = before && Number.isFinite(Number(before.createdAt)) && before.createdAt != null ? Number(before.createdAt) : null;
  return db.prepare(`
    SELECT o.id, o.steam_id, o.server_id, o.created_at, p.server_specific, u.bi_uid
    FROM orders o
    JOIN products p ON p.id = o.product_id
    JOIN users u    ON u.steam_id = o.steam_id
    WHERE o.status = 'pending'
      AND p.grants_priority_queue = 1
      AND o.test_mode = 0
      AND o.paypal_subscription_id IS NOT NULL
      AND o.created_at > @since
      AND (@exSteam IS NULL OR o.steam_id != @exSteam)
      AND (@exOrder IS NULL OR o.id != @exOrder)
      AND (@bCreated IS NULL OR o.created_at < @bCreated OR (o.created_at = @bCreated AND o.id < @bId))
  `).all({
    since: now - CHECKOUT_RESERVATION_S,
    exSteam: excludeSteamId == null ? null : String(excludeSteamId),
    exOrder: excludeOrderId == null ? null : Number(excludeOrderId),
    bCreated,
    bId: bCreated == null ? null : Number(before.id) || 0
  });
}

// Slots per server for a priority queue product:
//   limit     min(the product's cap, ceiling - game masters)
//   used      IDs holding priority queue there (the admin list's priority queue part)
//   reserved  checkouts waiting at PayPal for it, one per in-game ID (or per account
//             with no ID), leaving out accounts that already hold priority queue there:
//             buying again takes no new slot. Keyed on the account, not the ID, since
//             any account can type a holder's ID.
//   available limit - used - reserved, never below 0; free is available > 0
// excludeSteamId leaves one buyer's own waiting checkouts out (their earlier
// abandoned checkout must not lock them out); excludeOrderId leaves out one order
// (the checkout being activated); reservedBefore ({ createdAt, id }) counts only
// checkouts started before that one, so the earlier of two buyers racing for the
// last slot gets it and a later checkout that is never finished cannot push out a
// buyer who paid.
function pqSlotsPerServer(db, { product = null, now = nowUnix(), serverIds = SERVER_IDS, excludeSteamId = null, excludeOrderId = null, reservedBefore = null, ceiling = adminCeiling() } = {}) {
  const sets = Object.fromEntries(SERVER_IDS.map(id => [id, new Set()]));
  const holderAccounts = Object.fromEntries(SERVER_IDS.map(id => [id, new Set()]));
  for (const r of livePqRows(db, now)) {
    for (const id of coveredServers(r)) {
      sets[id].add(r.guid);
      holderAccounts[id].add(String(r.steam_id));
    }
  }
  const gm = gmCountPerServer(db, SERVER_IDS);
  const waiting = waitingCheckouts(db, { now, excludeSteamId, excludeOrderId, before: reservedBefore });
  const out = {};
  for (const id of serverIds) {
    const set = sets[id] || new Set();
    const accounts = holderAccounts[id] || new Set();
    const reservedBy = new Set();
    for (const w of waiting) {
      if (!coveredServers(w).includes(id)) continue;
      if (accounts.has(String(w.steam_id))) continue;
      const g = lowerId(w.bi_uid);
      reservedBy.add(g || `account:${w.steam_id}`);
    }
    const rawCap = stockCapFor(product, id);
    const cap = rawCap == null ? null : Number(rawCap);
    const gms = gm[id] || 0;
    const limit = Math.max(0, Math.min(cap == null ? Infinity : cap, ceiling - gms));
    const used = set.size;
    const reserved = reservedBy.size;
    out[id] = {
      serverId: id, cap, gm: gms, ceiling, limit, used, reserved,
      available: Math.max(0, limit - used - reserved),
      free: used + reserved < limit
    };
  }
  return out;
}

// One server's slots (pqSlotsPerServer); pass the product row or its id.
function pqSlotFree(db, { serverId, now = nowUnix(), productId = null, product = null, excludeSteamId = null, excludeOrderId = null, reservedBefore = null, ceiling = adminCeiling() } = {}) {
  const prod = product || (productId != null ? db.prepare('SELECT * FROM products WHERE id = ?').get(productId) : null) || null;
  if (!SERVER_IDS.includes(serverId)) {
    return { serverId, cap: null, gm: 0, ceiling, limit: 0, used: 0, reserved: 0, available: 0, free: false };
  }
  return pqSlotsPerServer(db, { product: prod, now, serverIds: [serverId], excludeSteamId, excludeOrderId, reservedBefore, ceiling })[serverId];
}

// ---- Changing an in-game ID -----------------------------------------------------------
// A player changing their in-game ID moves their priority queue to the new ID at the
// next sync. Usually that swaps one admin list entry for another. But when another
// account still holds priority queue on the old ID, the old entry stays and the new
// ID is a second entry, which a full server has no room for. Returns the servers
// where the change would add an entry and there is no free slot (empty: allowed).
function idChangeFullServers(db, { steamId, fromBiUid = null, toBiUid, now = nowUnix() } = {}) {
  const from = lowerId(fromBiUid);
  const to = lowerId(toBiUid);
  if (!steamId || !to || from === to) return [];
  const rows = db.prepare(`
    SELECT o.server_id, o.product_id, p.server_specific
    FROM orders o JOIN products p ON p.id = o.product_id
    WHERE o.steam_id = @steamId AND ${livePqOrderSql('o', 'p')}
    ORDER BY o.id ASC
  `).all({ steamId: String(steamId), now });
  const productOn = new Map();
  for (const r of rows) for (const id of coveredServers(r)) if (!productOn.has(id)) productOn.set(id, r.product_id);
  const full = [];
  for (const [serverId, productId] of productOn) {
    if (holdsPq(db, { biUid: to, serverId, now })) continue;
    if (from && !holdsPq(db, { biUid: from, serverId, now, excludeSteamId: steamId })) continue;
    if (!pqSlotFree(db, { serverId, now, productId }).free) full.push(serverId);
  }
  return full;
}

// ---- Checkouts started and never finished ---------------------------------------------
// Each priority queue checkout handed to PayPal holds a slot for
// CHECKOUT_RESERVATION_S. An account may start PQ_CHECKOUTS_PER_DAY of them in a day
// without finishing one (PayPal trouble, a changed mind); past that, checkout says to
// try again later, so no one can keep a server looking sold out by starting checkouts
// and abandoning them. Sandbox checkouts are not counted.
const PQ_CHECKOUTS_PER_DAY = 5;
function unfinishedPqCheckouts(db, { steamId, now = nowUnix() } = {}) {
  if (!steamId) return 0;
  return db.prepare(`
    SELECT COUNT(*) AS n FROM orders o JOIN products p ON p.id = o.product_id
    WHERE o.steam_id = ? AND p.grants_priority_queue = 1 AND o.test_mode = 0
      AND o.paypal_subscription_id IS NOT NULL AND o.status IN ('pending', 'cancelled')
      AND o.created_at > ?
  `).get(String(steamId), now - 24 * HOUR_S).n;
}

// ---- A staff move -----------------------------------------------------------------
// "I bought priority queue on EU2, put me on EU1" is a subscription change: the
// order's server changes on EVERY row of the subscription (or the one-time order),
// so the paid period carries over and renewals, which copy the server from the
// subscription's first row, bill for the new server. Nothing else is written: no
// grant, no block. PayPal needs no change, since nothing there names a server.
//
// Refused: a destination that is not sold or has no free slot, the server the order
// is already on, an order with no paid priority queue left (lapsed or refunded), a
// destination where the ID already holds priority queue (that would be two
// subscriptions for one slot), and, without orderId, an in-game ID with more than
// one paid priority queue order to choose from (two accounts can carry one ID).
//
// Checks and the write run in one transaction, with an admin_audit row. Returns
//   { ok: true, status: 200, orderId, subscriptionId, steamId, productId, from, to, orderIds, updated }
// or { ok: false, status, code, error, ...details }. orderId is the live cycle.
function moveSubscriptionServer(db, { guid, from = null, to, orderId = null, actor, reason = null, ip = null, now = nowUnix() } = {}) {
  const refuse = (status, code, error, extra = {}) => ({ ok: false, status, code, error, ...extra });
  const g = lowerId(guid);
  if (!g) return refuse(400, 'bad_request', 'Invalid GUID');
  if (!SELLABLE_SERVER_IDS.includes(to)) return refuse(400, 'bad_server', 'Invalid destination server');
  const fromId = from == null || from === '' ? null : from;
  if (fromId !== null && !SERVER_IDS.includes(fromId)) return refuse(400, 'bad_server', 'Invalid source server');
  if (fromId === to) return refuse(400, 'same_server', 'Source and destination must differ.');
  if (!actor) throw new Error('a priority queue move needs the staff member who made it');

  const ORDER_SQL = `
    SELECT o.*, u.bi_uid, p.grants_priority_queue, p.server_specific
    FROM orders o JOIN users u ON u.steam_id = o.steam_id JOIN products p ON p.id = o.product_id`;

  return db.transaction(() => {
    let unit;
    if (orderId != null) {
      const row = db.prepare(`${ORDER_SQL} WHERE o.id = @id`).get({ id: Number(orderId) });
      if (!row) return refuse(404, 'no_order', `Order #${orderId} was not found.`);
      if (lowerId(row.bi_uid) !== g) return refuse(409, 'wrong_player', `Order #${orderId} does not belong to this in-game ID.`);
      if (!row.grants_priority_queue || !row.server_specific) {
        return refuse(400, 'not_movable', `Order #${orderId} is not priority queue for one server, so there is no server to move.`);
      }
      unit = row.paypal_subscription_id ? { sub: row.paypal_subscription_id, id: null } : { sub: null, id: row.id };
    } else {
      const live = db.prepare(`
        ${ORDER_SQL}
        WHERE lower(u.bi_uid) = @g AND p.server_specific = 1 AND ${livePqOrderSql('o', 'p')}
          AND (@from IS NULL OR o.server_id = @from)
        ORDER BY o.id ASC
      `).all({ g, from: fromId, now });
      const units = new Map();
      for (const r of live) units.set(r.paypal_subscription_id ? `sub:${r.paypal_subscription_id}` : `order:${r.id}`, r);
      if (!units.size) {
        return refuse(404, 'no_live_order', `This in-game ID has no paid priority queue${fromId ? ` on ${labelOf(fromId)}` : ''} to move.`);
      }
      if (units.size > 1) {
        return refuse(409, 'ambiguous',
          'This in-game ID has more than one paid priority queue order to choose from (on another account, or a second subscription). Say which one to move with its order number.',
          { orderIds: [...units.values()].map(r => r.id) });
      }
      const r = [...units.values()][0];
      unit = r.paypal_subscription_id ? { sub: r.paypal_subscription_id, id: null } : { sub: null, id: r.id };
    }

    const inUnit = unit.sub ? 'o.paypal_subscription_id = @sub' : 'o.id = @id';
    const unitParams = unit.sub ? { sub: unit.sub } : { id: unit.id };
    const rows = db.prepare(`${ORDER_SQL} WHERE ${inUnit} ORDER BY o.id ASC`).all(unitParams);
    const liveRow = db.prepare(`
      ${ORDER_SQL}
      WHERE ${inUnit} AND ${livePqOrderSql('o', 'p')}
      ORDER BY o.effective_until DESC, o.id DESC LIMIT 1
    `).get({ ...unitParams, now });
    if (!liveRow) {
      return refuse(409, 'not_live', 'That order has no paid priority queue left: it has lapsed or was refunded, so there is nothing to move.',
        { orderIds: rows.map(r => r.id) });
    }
    const current = liveRow.server_id;
    if (fromId !== null && current !== fromId) {
      return refuse(409, 'not_on_source', `That order is on ${labelOf(current)}, not ${labelOf(fromId)}.`, { orderIds: [liveRow.id] });
    }
    if (current === to) return refuse(400, 'same_server', `That order is already on ${labelOf(to)}.`);
    if (holdsPq(db, { biUid: g, serverId: to, now })) {
      return refuse(409, 'already_on_destination',
        `This in-game ID already has priority queue on ${labelOf(to)}. Moving this order there would bill twice for one slot: revoke one of the orders instead.`,
        { orderIds: [liveRow.id] });
    }
    const slot = pqSlotFree(db, { serverId: to, now, productId: liveRow.product_id });
    if (!slot.free) {
      return refuse(409, 'destination_full', `${labelOf(to)} is full: it has no free priority queue slot.`,
        { slot: { limit: slot.limit, used: slot.used, reserved: slot.reserved } });
    }

    const updated = db.prepare(`UPDATE orders SET server_id = @to WHERE ${unit.sub ? 'paypal_subscription_id = @sub' : 'id = @id'}`)
      .run({ ...unitParams, to }).changes;
    const orderIds = rows.map(r => r.id);
    require('./adminAudit').recordAdminAudit(db, {
      actor,
      action: 'pq.move',
      target: liveRow.steam_id,
      before: { server_id: current, order_ids: orderIds, subscription_id: unit.sub },
      after: { server_id: to },
      reason,
      ip,
      now
    });
    return {
      ok: true, status: 200,
      orderId: liveRow.id, subscriptionId: unit.sub, steamId: liveRow.steam_id, productId: liveRow.product_id,
      from: current, to, orderIds, updated
    };
  })();
}

module.exports = {
  RENEWAL_WINDOW_S, CHECKOUT_RESERVATION_S, DEFAULT_ADMIN_CEILING, PQ_CHECKOUTS_PER_DAY,
  adminCeiling, livePqOrderSql, perksLiveSql, coveredServers, livePqRows, pqGuidsPerServer,
  holdsPq, accountHoldsPq, stockCapFor, gmCountPerServer, pqSlotsPerServer, pqSlotFree,
  idChangeFullServers, unfinishedPqCheckouts, moveSubscriptionServer
};

// tradeLedger.js -- the Economy KPI data layer.
//
// The game servers append one JSON line per caps transaction to
//   <volume>/profile/profile/trade_ledger/trades-YYYY-MM-DD.ndjson
// (MOD_TradeLedger.c in the ReforgedZ Dev addon). pullTradeLedgers() tails every
// file over SSH -- the save inspector's channel -- into trade_events, keeping a
// byte cursor per file so each pull only moves the new bytes. Every row carries
// `income` (caps that entered the player's pocket) and `spend` (caps that left
// it), so the KPI queries are plain GROUP BYs. A marketplace sale becomes TWO
// rows, one per side (MARKET_SELL for the seller, MARKET_BUY for the buyer).
//
// Rows imported from the Discord trade channel (tradeDiscordImport.js) share
// the table with source='discord'; they have no uid, prefab or tax, which the
// page says out loud.
const db = require('./db');
const { listAllServers } = require('./gameServers');
const { sshOpen, sshRun, wrapForRegion, getPrivateKey } = require('./sync');

const FILE_RE = /^trades-\d{4}-\d{2}-\d{2}\.ndjson$/;
// Bound a single pull so a months-old backlog streams over several pulls
// instead of one giant SSH read.
const MAX_BYTES_PER_FILE = 8 * 1024 * 1024;

// <volume>/profile/profile/eiry/reforgedz-dotnet-shop  ->  <volume>/profile/profile/trade_ledger
// ($profile: on the dedicated server is <volume>/profile/profile, same root the
// save inspector derives .save/game from.)
function ledgerDirFromShopPath(shopPath) {
  if (!shopPath) return null;
  const i = shopPath.indexOf('/profile/');
  if (i < 0) return null;
  return shopPath.substring(0, i) + '/profile/profile/trade_ledger';
}

function dayOf(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

// Discord-era rows have no uid, so a player is keyed by uid when we have one and
// by lower-cased name otherwise. The two never merge; the page shows both.
function playerKey(uid, name) {
  if (uid) return String(uid);
  return 'name:' + String(name || '').trim().toLowerCase();
}

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO trade_events
    (server_id, source, dedupe_key, ts, day, op, uid, player_name, player_key, trader,
     prefab, label, category, qty, unit_price, gross, tax, net, income, spend, stock_after, cp_uid, cp_name)
  VALUES
    (@server_id, @source, @dedupe_key, @ts, @day, @op, @uid, @player_name, @player_key, @trader,
     @prefab, @label, @category, @qty, @unit_price, @gross, @tax, @net, @income, @spend, @stock_after, @cp_uid, @cp_name)
`);

const insertMany = db.transaction((rows) => {
  let n = 0;
  for (const r of rows) n += insertStmt.run(r).changes;
  return n;
});

function num(v) { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; }
function str(v) { return v == null ? '' : String(v); }

// One ledger line -> one or two trade_events rows.
function rowsFromLedgerEvent(serverId, ev) {
  if (!ev || typeof ev !== 'object') return [];
  const ts = num(ev.ts);
  if (ts <= 0 || typeof ev.op !== 'string') return [];
  const key = `${serverId}:${num(ev.sid)}:${num(ev.seq)}`;
  const base = {
    server_id: serverId, source: 'ledger', ts, day: dayOf(ts),
    trader: str(ev.trader), prefab: str(ev.prefab), label: str(ev.label),
    category: ev.cat == null ? null : num(ev.cat),
    qty: num(ev.qty), unit_price: num(ev.unit), gross: num(ev.gross), tax: num(ev.tax), net: num(ev.net),
    stock_after: ev.stock == null || num(ev.stock) < 0 ? null : num(ev.stock),
    cp_uid: null, cp_name: null,
  };
  const uid = str(ev.uid) || null;
  const name = str(ev.name);
  if (ev.op === 'MARKET') {
    const cpUid = str(ev.cpUid) || null;
    const cpName = str(ev.cpName);
    return [
      { ...base, dedupe_key: key + ':s', op: 'MARKET_SELL', uid, player_name: name, player_key: playerKey(uid, name),
        income: base.net, spend: 0, cp_uid: cpUid, cp_name: cpName },
      // Tax is booked once, on the seller row, so SUM(tax) is not doubled.
      { ...base, dedupe_key: key + ':b', op: 'MARKET_BUY', uid: cpUid, player_name: cpName, player_key: playerKey(cpUid, cpName),
        income: 0, spend: base.gross, tax: 0, cp_uid: uid, cp_name: name },
    ];
  }
  if (ev.op === 'SELL') {
    return [{ ...base, dedupe_key: key, op: 'SELL', uid, player_name: name, player_key: playerKey(uid, name), income: base.net, spend: 0 }];
  }
  if (ev.op === 'BUY') {
    return [{ ...base, dedupe_key: key, op: 'BUY', uid, player_name: name, player_key: playerKey(uid, name), income: 0, spend: base.net }];
  }
  return [];
}

// Parse a block of NDJSON text for one server and insert it. Returns counts.
// Exposed so a ledger file copied by hand can be loaded without SSH.
function ingestLedgerText(serverId, text) {
  const rows = [];
  let bad = 0;
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev = null;
    try { ev = JSON.parse(t); } catch { bad++; continue; }
    const r = rowsFromLedgerEvent(serverId, ev);
    if (!r.length) bad++;
    rows.push(...r);
  }
  const inserted = rows.length ? insertMany(rows) : 0;
  return { lines: rows.length, inserted, bad };
}

const upsertCursor = db.prepare(`
  INSERT INTO trade_ledger_cursors (server_id, file, offset, updated_at)
  VALUES (?, ?, ?, unixepoch())
  ON CONFLICT(server_id, file) DO UPDATE SET offset = excluded.offset, updated_at = excluded.updated_at
`);

const ingestChunk = db.transaction((serverId, file, newOffset, text) => {
  const r = ingestLedgerText(serverId, text);
  upsertCursor.run(serverId, file, newOffset);
  return r;
});

// Tail every ledger file on one server from its cursor. One SSH exec per server;
// the NA box is reached through the nested hop wrapForRegion adds.
async function pullOne(conn, server) {
  const dir = ledgerDirFromShopPath(server.path);
  if (!dir) return { server: server.id, skipped: 'no path' };

  const cursors = db.prepare('SELECT file, offset FROM trade_ledger_cursors WHERE server_id = ?').all(server.id);
  const cases = cursors
    .filter(c => FILE_RE.test(c.file))
    .map(c => `${c.file}) echo ${Math.max(0, num(c.offset))};;`)
    .join(' ');

  const inner = [
    `LD='${dir}'`,
    `[ -d "$LD" ] || exit 0`,
    `off() { case "$1" in ${cases} *) echo 0;; esac; }`,
    `for f in "$LD"/trades-*.ndjson; do [ -f "$f" ] || continue; n=$(basename "$f"); s=$(stat -c %s "$f"); o=$(off "$n"); [ "$s" -gt "$o" ] || continue; echo "FILE:$n:$o:$(tail -c +$((o+1)) "$f" | head -c ${MAX_BYTES_PER_FILE} | base64 -w0)"; done`,
  ].join('; ');

  const out = await sshRun(conn, wrapForRegion(server, inner), 120000);

  const result = { server: server.id, files: 0, lines: 0, inserted: 0, bad: 0 };
  for (const line of String(out).split('\n')) {
    const m = line.match(/^FILE:([^:]+):(\d+):([A-Za-z0-9+/=]*)$/);
    if (!m) continue;
    const file = m[1];
    if (!FILE_RE.test(file)) continue;
    const offset = parseInt(m[2], 10) || 0;
    const buf = Buffer.from(m[3], 'base64');
    // Only complete lines: the server may be mid-write on the last one. The
    // cursor stops at the last newline so the partial line is re-read next time.
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) continue;
    const chunk = buf.subarray(0, end + 1);
    const r = ingestChunk(server.id, file, offset + chunk.length, chunk.toString('utf8'));
    result.files++;
    result.lines += r.lines;
    result.inserted += r.inserted;
    result.bad += r.bad;
  }
  return result;
}

let pulling = false;
let lastPull = null;

async function pullTradeLedgers() {
  if (pulling) return { skipped: 'pull already running', lastPull };
  pulling = true;
  const startedAt = Date.now();
  try {
    const servers = listAllServers();
    const privateKey = getPrivateKey();
    if (!privateKey) throw new Error('SSH key not configured');
    const entryHost = servers.find(s => s.region === 'eu') || servers[0];
    if (!entryHost) throw new Error('No game servers configured');

    const report = [];
    const conn = await sshOpen(privateKey, entryHost.host, entryHost.port, entryHost.user);
    try {
      for (const server of servers) {
        try {
          report.push(await pullOne(conn, server));
        } catch (e) {
          report.push({ server: server.id, error: e.message });
        }
      }
    } finally {
      conn.end();
    }
    lastPull = { startedAt, finishedAt: Date.now(), report };
    const total = report.reduce((a, r) => a + (r.inserted || 0), 0);
    if (total > 0) console.log(`[trade-ledger] pulled ${total} new trade rows`);
    return lastPull;
  } catch (e) {
    lastPull = { startedAt, finishedAt: Date.now(), error: e.message };
    console.error('[trade-ledger] pull failed:', e.message);
    return lastPull;
  } finally {
    pulling = false;
  }
}

// ============================================================
//  KPI queries
// ============================================================

// Filters: { server: 'eu1'|'' , from: unix|0, to: unix|0 }
function whereClause(f, extra = []) {
  const c = ['1=1'];
  const p = [];
  if (f.server) { c.push('server_id = ?'); p.push(f.server); }
  if (f.from) { c.push('ts >= ?'); p.push(f.from); }
  if (f.to) { c.push('ts < ?'); p.push(f.to); }
  for (const [sql, val] of extra) { c.push(sql); if (val !== undefined) p.push(val); }
  return { sql: c.join(' AND '), params: p };
}

const ITEM_KEY = "COALESCE(NULLIF(prefab, ''), 'label:' || lower(label))";
const SELL_OPS = "op IN ('SELL','MARKET_SELL')";
const BUY_OPS = "op IN ('BUY','MARKET_BUY')";
// A marketplace sale is two rows; count it once.
const TRADE_COUNT = "SUM(CASE WHEN op <> 'MARKET_BUY' THEN 1 ELSE 0 END)";

function summary(f) {
  const w = whereClause(f);
  const totals = db.prepare(`
    SELECT ${TRADE_COUNT} AS trades,
           COALESCE(SUM(income), 0) AS income,
           COALESCE(SUM(spend), 0) AS spend,
           COALESCE(SUM(tax), 0) AS tax,
           COUNT(DISTINCT player_key) AS players,
           COALESCE(SUM(CASE WHEN ${SELL_OPS} THEN qty ELSE 0 END), 0) AS sold_qty,
           COALESCE(SUM(CASE WHEN ${BUY_OPS} THEN qty ELSE 0 END), 0) AS bought_qty,
           SUM(CASE WHEN op = 'MARKET_SELL' THEN 1 ELSE 0 END) AS market_sales,
           SUM(CASE WHEN source = 'discord' THEN 1 ELSE 0 END) AS discord_rows,
           MIN(ts) AS first_ts, MAX(ts) AS last_ts
    FROM trade_events WHERE ${w.sql}`).get(...w.params);

  const daily = db.prepare(`
    SELECT day, ${TRADE_COUNT} AS trades, SUM(income) AS income, SUM(spend) AS spend, SUM(tax) AS tax,
           COUNT(DISTINCT player_key) AS players
    FROM trade_events WHERE ${w.sql} GROUP BY day ORDER BY day`).all(...w.params);

  const byOp = db.prepare(`
    SELECT op, COUNT(*) AS rows_, SUM(qty) AS qty, SUM(income) AS income, SUM(spend) AS spend
    FROM trade_events WHERE ${w.sql} GROUP BY op ORDER BY op`).all(...w.params);

  const byCategory = db.prepare(`
    SELECT category, ${TRADE_COUNT} AS trades, SUM(qty) AS qty, SUM(income) AS income, SUM(spend) AS spend
    FROM trade_events WHERE ${w.sql} GROUP BY category ORDER BY (income + spend) DESC`).all(...w.params);

  const byServer = db.prepare(`
    SELECT server_id, ${TRADE_COUNT} AS trades, SUM(income) AS income, SUM(spend) AS spend, COUNT(DISTINCT player_key) AS players
    FROM trade_events WHERE ${w.sql} GROUP BY server_id ORDER BY server_id`).all(...w.params);

  const byHour = db.prepare(`
    SELECT CAST(strftime('%H', ts, 'unixepoch') AS INTEGER) AS hour, ${TRADE_COUNT} AS trades, SUM(income) AS income, SUM(spend) AS spend
    FROM trade_events WHERE ${w.sql} GROUP BY hour ORDER BY hour`).all(...w.params);

  return { totals, daily, byOp, byCategory, byServer, byHour };
}

const PLAYER_SORTS = { income: 'income', spend: 'spend', net: 'net', trades: 'trades', last_ts: 'last_ts', income_1d: 'income_1d', income_7d: 'income_7d', income_30d: 'income_30d', spend_1d: 'spend_1d', spend_7d: 'spend_7d', spend_30d: 'spend_30d' };

// Rolling windows are anchored to NOW (not the filter's `to`): "today" is the
// current UTC day, 7d/30d are the trailing windows. They ignore the from/to
// filter deliberately so the columns always mean the same thing.
function windows() {
  const now = Math.floor(Date.now() / 1000);
  const dayStart = Math.floor(now / 86400) * 86400;
  return { d1: dayStart, d7: now - 7 * 86400, d30: now - 30 * 86400 };
}

function players(f, opts = {}) {
  const sort = PLAYER_SORTS[opts.sort] || 'income';
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), 1000);
  const extra = [];
  if (opts.q) extra.push(['lower(player_name) LIKE ?', '%' + String(opts.q).toLowerCase() + '%']);
  const w = whereClause(f, extra);
  const { d1, d7, d30 } = windows();
  const rows = db.prepare(`
    SELECT player_key, MAX(uid) AS uid, MAX(ts) AS last_ts, player_name, MIN(ts) AS first_ts,
           ${TRADE_COUNT} AS trades,
           SUM(income) AS income, SUM(spend) AS spend, SUM(income) - SUM(spend) AS net,
           SUM(CASE WHEN ts >= ${d1} THEN income ELSE 0 END) AS income_1d,
           SUM(CASE WHEN ts >= ${d7} THEN income ELSE 0 END) AS income_7d,
           SUM(CASE WHEN ts >= ${d30} THEN income ELSE 0 END) AS income_30d,
           SUM(CASE WHEN ts >= ${d1} THEN spend ELSE 0 END) AS spend_1d,
           SUM(CASE WHEN ts >= ${d7} THEN spend ELSE 0 END) AS spend_7d,
           SUM(CASE WHEN ts >= ${d30} THEN spend ELSE 0 END) AS spend_30d,
           SUM(CASE WHEN source = 'discord' THEN 1 ELSE 0 END) AS discord_rows,
           GROUP_CONCAT(DISTINCT server_id) AS servers
    FROM trade_events WHERE ${w.sql}
    GROUP BY player_key ORDER BY ${sort} DESC, last_ts DESC LIMIT ?`).all(...w.params, limit);
  return { rows, windows: { d1, d7, d30 } };
}

function player(f, key) {
  const w = whereClause(f, [['player_key = ?', key]]);
  const totals = db.prepare(`
    SELECT player_key, MAX(uid) AS uid, MAX(ts) AS last_ts, player_name, MIN(ts) AS first_ts,
           ${TRADE_COUNT} AS trades, SUM(income) AS income, SUM(spend) AS spend, SUM(income) - SUM(spend) AS net, SUM(tax) AS tax,
           COUNT(DISTINCT day) AS active_days, GROUP_CONCAT(DISTINCT server_id) AS servers,
           SUM(CASE WHEN source = 'discord' THEN 1 ELSE 0 END) AS discord_rows
    FROM trade_events WHERE ${w.sql}`).get(...w.params);
  if (!totals || !totals.player_name) return null;

  const daily = db.prepare(`
    SELECT day, ${TRADE_COUNT} AS trades, SUM(income) AS income, SUM(spend) AS spend
    FROM trade_events WHERE ${w.sql} GROUP BY day ORDER BY day`).all(...w.params);

  const weekly = db.prepare(`
    SELECT strftime('%Y-W%W', ts, 'unixepoch') AS week, MIN(day) AS from_day, ${TRADE_COUNT} AS trades, SUM(income) AS income, SUM(spend) AS spend
    FROM trade_events WHERE ${w.sql} GROUP BY week ORDER BY week`).all(...w.params);

  const monthly = db.prepare(`
    SELECT substr(day, 1, 7) AS month, ${TRADE_COUNT} AS trades, SUM(income) AS income, SUM(spend) AS spend
    FROM trade_events WHERE ${w.sql} GROUP BY month ORDER BY month`).all(...w.params);

  const itemSql = (ops) => `
    SELECT ${ITEM_KEY} AS item_key, label, MAX(prefab) AS prefab, MAX(category) AS category, MAX(ts) AS last_ts,
           COUNT(*) AS trades, SUM(qty) AS qty, SUM(income) AS income, SUM(spend) AS spend,
           CAST(SUM(income + spend) AS REAL) / NULLIF(SUM(qty), 0) AS avg_unit
    FROM trade_events WHERE ${w.sql} AND ${ops}
    GROUP BY item_key ORDER BY (income + spend) DESC LIMIT 50`;
  const topSold = db.prepare(itemSql(SELL_OPS)).all(...w.params);
  const topBought = db.prepare(itemSql(BUY_OPS)).all(...w.params);

  const traders = db.prepare(`
    SELECT trader, ${TRADE_COUNT} AS trades, SUM(income) AS income, SUM(spend) AS spend
    FROM trade_events WHERE ${w.sql} GROUP BY trader ORDER BY (income + spend) DESC`).all(...w.params);

  const recent = db.prepare(`
    SELECT id, server_id, source, ts, op, trader, prefab, label, category, qty, unit_price, gross, tax, net, income, spend, stock_after, cp_name
    FROM trade_events WHERE ${w.sql} ORDER BY ts DESC, id DESC LIMIT 200`).all(...w.params);

  return { totals, daily, weekly, monthly, topSold, topBought, traders, recent };
}

const ITEM_SORTS = { sell_caps: 'sell_caps', sell_qty: 'sell_qty', sell_avg: 'sell_avg', buy_caps: 'buy_caps', buy_qty: 'buy_qty', buy_avg: 'buy_avg', players: 'players', trades: 'trades', total: 'total', last_ts: 'last_ts' };

function items(f, opts = {}) {
  const sort = ITEM_SORTS[opts.sort] || 'total';
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), 2000);
  const w = whereClause(f);
  const params = [...w.params];
  let sql = w.sql;
  if (opts.q) {
    const like = '%' + String(opts.q).toLowerCase() + '%';
    sql += ' AND (lower(label) LIKE ? OR lower(prefab) LIKE ?)';
    params.push(like, like);
  }
  if (opts.category !== undefined && opts.category !== '') {
    sql += ' AND category = ?';
    params.push(parseInt(opts.category, 10) || 0);
  }
  const rows = db.prepare(`
    SELECT ${ITEM_KEY} AS item_key, MAX(ts) AS last_ts, label, MAX(prefab) AS prefab, MAX(category) AS category,
           COUNT(*) AS trades, COUNT(DISTINCT player_key) AS players,
           SUM(CASE WHEN ${SELL_OPS} THEN qty ELSE 0 END) AS sell_qty,
           SUM(CASE WHEN ${SELL_OPS} THEN income ELSE 0 END) AS sell_caps,
           CAST(SUM(CASE WHEN ${SELL_OPS} THEN income ELSE 0 END) AS REAL) / NULLIF(SUM(CASE WHEN ${SELL_OPS} THEN qty ELSE 0 END), 0) AS sell_avg,
           SUM(CASE WHEN ${BUY_OPS} THEN qty ELSE 0 END) AS buy_qty,
           SUM(CASE WHEN ${BUY_OPS} THEN spend ELSE 0 END) AS buy_caps,
           CAST(SUM(CASE WHEN ${BUY_OPS} THEN spend ELSE 0 END) AS REAL) / NULLIF(SUM(CASE WHEN ${BUY_OPS} THEN qty ELSE 0 END), 0) AS buy_avg,
           SUM(income) + SUM(spend) AS total,
           SUM(CASE WHEN source = 'discord' THEN 1 ELSE 0 END) AS discord_rows
    FROM trade_events WHERE ${sql}
    GROUP BY item_key ORDER BY ${sort} DESC, last_ts DESC LIMIT ?`).all(...params, limit);
  return { rows };
}

function item(f, key) {
  const w = whereClause(f, [[`${ITEM_KEY} = ?`, key]]);
  const totals = db.prepare(`
    SELECT ${ITEM_KEY} AS item_key, label, MAX(prefab) AS prefab, MAX(category) AS category, MIN(ts) AS first_ts, MAX(ts) AS last_ts,
           COUNT(*) AS trades, COUNT(DISTINCT player_key) AS players,
           SUM(CASE WHEN ${SELL_OPS} THEN qty ELSE 0 END) AS sell_qty, SUM(CASE WHEN ${SELL_OPS} THEN income ELSE 0 END) AS sell_caps,
           SUM(CASE WHEN ${BUY_OPS} THEN qty ELSE 0 END) AS buy_qty, SUM(CASE WHEN ${BUY_OPS} THEN spend ELSE 0 END) AS buy_caps
    FROM trade_events WHERE ${w.sql}`).get(...w.params);
  if (!totals || !totals.label) return null;
  const daily = db.prepare(`
    SELECT day, SUM(CASE WHEN ${SELL_OPS} THEN qty ELSE 0 END) AS sell_qty, SUM(CASE WHEN ${SELL_OPS} THEN income ELSE 0 END) AS sell_caps,
           SUM(CASE WHEN ${BUY_OPS} THEN qty ELSE 0 END) AS buy_qty, SUM(CASE WHEN ${BUY_OPS} THEN spend ELSE 0 END) AS buy_caps,
           MIN(CASE WHEN ${SELL_OPS} THEN unit_price END) AS sell_unit_min, MAX(CASE WHEN ${SELL_OPS} THEN unit_price END) AS sell_unit_max,
           MIN(CASE WHEN ${BUY_OPS} THEN unit_price END) AS buy_unit_min, MAX(CASE WHEN ${BUY_OPS} THEN unit_price END) AS buy_unit_max
    FROM trade_events WHERE ${w.sql} GROUP BY day ORDER BY day`).all(...w.params);
  const topPlayers = db.prepare(`
    SELECT player_key, player_name, MAX(ts) AS last_ts, COUNT(*) AS trades, SUM(qty) AS qty, SUM(income) AS income, SUM(spend) AS spend
    FROM trade_events WHERE ${w.sql} GROUP BY player_key ORDER BY (income + spend) DESC LIMIT 50`).all(...w.params);
  const traders = db.prepare(`
    SELECT trader, COUNT(*) AS trades, SUM(qty) AS qty, SUM(income) AS income, SUM(spend) AS spend
    FROM trade_events WHERE ${w.sql} GROUP BY trader ORDER BY (income + spend) DESC`).all(...w.params);
  return { totals, daily, topPlayers, traders };
}

function traders(f) {
  const w = whereClause(f);
  const rows = db.prepare(`
    SELECT trader, ${TRADE_COUNT} AS trades, COUNT(DISTINCT player_key) AS players, SUM(qty) AS qty,
           SUM(income) AS paid_out, SUM(spend) AS taken_in, SUM(tax) AS tax, MAX(ts) AS last_ts,
           COUNT(DISTINCT ${ITEM_KEY}) AS distinct_items
    FROM trade_events WHERE ${w.sql} GROUP BY trader ORDER BY (paid_out + taken_in) DESC`).all(...w.params);
  return { rows };
}

function ledger(f, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 200, 1), 50000);
  const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);
  const extra = [];
  if (opts.op) extra.push(['op = ?', String(opts.op)]);
  if (opts.player) extra.push(['player_key = ?', String(opts.player)]);
  if (opts.item) extra.push([`${ITEM_KEY} = ?`, String(opts.item)]);
  if (opts.trader) extra.push(['trader = ?', String(opts.trader)]);
  const w = whereClause(f, extra);
  let sql = w.sql;
  const params = [...w.params];
  if (opts.q) {
    const like = '%' + String(opts.q).toLowerCase() + '%';
    sql += ' AND (lower(player_name) LIKE ? OR lower(label) LIKE ?)';
    params.push(like, like);
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM trade_events WHERE ${sql}`).get(...params).n;
  const rows = db.prepare(`
    SELECT id, server_id, source, ts, op, uid, player_name, player_key, trader, prefab, label, category, qty, unit_price, gross, tax, net, income, spend, stock_after, cp_name
    FROM trade_events WHERE ${sql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { rows, total, limit, offset };
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function ledgerCsv(f, opts = {}) {
  const { rows } = ledger(f, { ...opts, limit: opts.limit || 50000, offset: 0 });
  const cols = ['ts', 'time_utc', 'server_id', 'source', 'op', 'uid', 'player_name', 'trader', 'label', 'prefab', 'category', 'qty', 'unit_price', 'gross', 'tax', 'net', 'income', 'spend', 'stock_after', 'cp_name'];
  const lines = [cols.join(',')];
  for (const r of rows) {
    r.time_utc = new Date(r.ts * 1000).toISOString();
    lines.push(cols.map(c => csvEscape(r[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

function status() {
  const perServer = db.prepare(`
    SELECT server_id, source, COUNT(*) AS rows_, MIN(ts) AS first_ts, MAX(ts) AS last_ts
    FROM trade_events GROUP BY server_id, source ORDER BY server_id, source`).all();
  const cursors = db.prepare('SELECT server_id, file, offset, updated_at FROM trade_ledger_cursors ORDER BY server_id, file').all();
  const total = db.prepare('SELECT COUNT(*) AS n FROM trade_events').get().n;
  return { total, perServer, cursors, lastPull, pulling };
}

module.exports = {
  ledgerDirFromShopPath, rowsFromLedgerEvent, ingestLedgerText, insertMany, playerKey, dayOf,
  pullTradeLedgers, summary, players, player, items, item, traders, ledger, ledgerCsv, status,
};

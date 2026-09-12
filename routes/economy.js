// routes/economy.js -- the Economy KPI API behind /admin/economy.
//
// Read-only views over trade_events (tradeLedger.js) plus two maintenance
// actions: pull the game servers' ledger files now, and backfill history from
// the Discord trade channel. Same requireAdmin gate as the save inspector.
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('./shop');
const tradeLedger = require('../tradeLedger');
const discordImport = require('../tradeDiscordImport');
const { listSaveServers } = require('../gameServers');
const db = require('../db');

const SERVER_RE = /^[a-z0-9._-]{1,40}$/;

// ?server=eu1&from=<unix>&to=<unix>  (from defaults to 30 days back; to open-ended)
function filters(req) {
  const q = req.query || {};
  const server = SERVER_RE.test(String(q.server || '')) ? String(q.server) : '';
  let from = parseInt(q.from, 10);
  let to = parseInt(q.to, 10);
  if (!Number.isFinite(from) || from < 0) from = q.from === '0' ? 0 : Math.floor(Date.now() / 1000) - 30 * 86400;
  if (!Number.isFinite(to) || to <= 0) to = 0;
  return { server, from, to };
}

function guard(fn) {
  return (req, res) => {
    try {
      const out = fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (e) {
      console.error('[economy]', req.path, e.message);
      res.status(500).json({ error: e.message || 'Query failed' });
    }
  };
}

router.get('/api/shop/admin/economy/servers', requireAdmin, guard(() => {
  const configured = listSaveServers();
  const seen = db.prepare('SELECT DISTINCT server_id FROM trade_events ORDER BY server_id').all().map(r => r.server_id);
  const ids = new Set(configured.map(s => s.id));
  const servers = [...configured];
  for (const id of seen) if (!ids.has(id)) servers.push({ id, label: id.toUpperCase() + ' (history only)' });
  return { servers };
}));

router.get('/api/shop/admin/economy/summary', requireAdmin, guard((req) => tradeLedger.summary(filters(req))));
router.get('/api/shop/admin/economy/players', requireAdmin, guard((req) => tradeLedger.players(filters(req), req.query)));
router.get('/api/shop/admin/economy/player', requireAdmin, guard((req, res) => {
  const key = String(req.query.key || '');
  if (!key) return res.status(400).json({ error: 'key required' });
  const out = tradeLedger.player(filters(req), key);
  if (!out) return res.status(404).json({ error: 'No trades for that player in this range' });
  return out;
}));
router.get('/api/shop/admin/economy/items', requireAdmin, guard((req) => tradeLedger.items(filters(req), req.query)));
router.get('/api/shop/admin/economy/item', requireAdmin, guard((req, res) => {
  const key = String(req.query.key || '');
  if (!key) return res.status(400).json({ error: 'key required' });
  const out = tradeLedger.item(filters(req), key);
  if (!out) return res.status(404).json({ error: 'No trades for that item in this range' });
  return out;
}));
router.get('/api/shop/admin/economy/traders', requireAdmin, guard((req) => tradeLedger.traders(filters(req))));
router.get('/api/shop/admin/economy/ledger', requireAdmin, guard((req) => tradeLedger.ledger(filters(req), req.query)));
router.get('/api/shop/admin/economy/ledger.csv', requireAdmin, (req, res) => {
  try {
    const csv = tradeLedger.ledgerCsv(filters(req), req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reforgedz-trades-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('[economy] csv', e.message);
    res.status(500).json({ error: e.message });
  }
});
router.get('/api/shop/admin/economy/status', requireAdmin, guard(() => ({ ...tradeLedger.status(), discordImport: discordImport.getJob() })));

router.post('/api/shop/admin/economy/pull', requireAdmin, async (req, res) => {
  try {
    res.json(await tradeLedger.pullTradeLedgers());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Body: { channelId, sinceDays } -- sinceDays 0/blank = the whole channel.
router.post('/api/shop/admin/economy/import-discord', requireAdmin, (req, res) => {
  const { channelId, sinceDays, serverMap } = req.body || {};
  const days = parseInt(sinceDays, 10);
  const since = Number.isFinite(days) && days > 0 ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
  try {
    res.json(discordImport.startImport(String(channelId || ''), { since, serverMap: serverMap && typeof serverMap === 'object' ? serverMap : null }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
router.get('/api/shop/admin/economy/import-discord', requireAdmin, (req, res) => res.json(discordImport.getJob()));

// Pull the ledgers every 5 minutes (the purchase sync runs on 10). Skipped
// entirely when SSH is not configured so a dev box does not log a failure
// every five minutes.
if (process.env.SSH_PRIVATE_KEY_B64) {
  setTimeout(() => tradeLedger.pullTradeLedgers().catch(() => {}), 20 * 1000);
  setInterval(() => tradeLedger.pullTradeLedgers().catch(() => {}), 5 * 60 * 1000);
}

module.exports = { router };

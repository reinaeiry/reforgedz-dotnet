// tradeDiscordImport.js -- backfill trade_events from the Discord trade channel.
//
// Before the ledger file existed the only record of a trade was the webhook
// line the game server posted to Discord. This walks a channel's history with
// the bot token (DISCORD_BOT_TOKEN -- the bot needs View Channel + Read Message
// History there) and parses the two line shapes the game writes:
//
//   [EU1] <t:1757600000:T> **Name** bought 2x Item from Trader for 300 Caps (150 ea) | stock 5
//   [EU1] <t:1757600000:T> **Name** sold 1x Item to Trader for 120 Caps (120 ea)
//   EU1 | SALE: Seller sold Item to Buyer for 500 Caps            (player marketplace)
//
// Rows land with source='discord': no uid, no prefab, no tax split (the page
// says so). Dedupe key is the Discord message id + line index, so re-running an
// import is harmless.
const { insertMany, playerKey, dayOf } = require('./tradeLedger');

const DISCORD_API = 'https://discord.com/api/v10';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function discordGet(path, attempt = 0) {
  const token = process.env.DISCORD_BOT_TOKEN || '';
  if (!token) throw new Error('DISCORD_BOT_TOKEN not set');
  const res = await fetch(`${DISCORD_API}${path}`, { headers: { Authorization: `Bot ${token}` } });
  if (res.status === 429 && attempt < 8) {
    let waitMs = parseFloat(res.headers.get('retry-after') || '') * 1000;
    if (!isFinite(waitMs)) waitMs = 2 ** attempt * 1000;
    await sleep(Math.min(Math.max(waitMs, 250), 60000));
    return discordGet(path, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord ${res.status} on ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// "[EU1]" / "EU1" / "ReforgedZ EU 2" / "[DEV]" -> eu1 / eu2 / dev1. Anything
// else is kept lower-cased so it still groups, and can be mapped later.
function normalizeServerTag(tag, serverMap) {
  const t = String(tag || '').trim();
  if (!t) return 'unknown';
  if (serverMap && serverMap[t]) return serverMap[t];
  const m = t.match(/\b(eu|na)\s*-?\s*(\d)\b/i);
  if (m) return `${m[1].toLowerCase()}${m[2]}`;
  if (/\bdev\b|\btest\b/i.test(t)) return 'dev1';
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

const TRADER_HEAD = /^(?:\[([^\]]+)\]\s*)?<t:(\d+):[a-zA-Z]>\s*\*\*(.+?)\*\*\s+(bought|sold)\s+(.*)$/;
const TRADER_TAIL = /\s+for\s+(-?\d+)\s+Caps\s+\((-?\d+)\s+ea\)(?:\s*\|\s*stock\s+(\d+))?\s*$/;
const MARKET_LINE = /^(.*?)\s*\|\s*SALE:\s*(.+?)\s+sold\s+(.+)\s+for\s+(-?\d+)\s+Caps\s*$/;

// Split "3x Some Item from Trader Name" on the LAST " from " / " to " so an
// item called "Key to Mansion" keeps its name.
function splitHead(head, keyword) {
  const q = head.match(/^(\d+)x\s+(.*)$/);
  if (!q) return null;
  const rest = q[2];
  const idx = rest.lastIndexOf(` ${keyword} `);
  if (idx < 0) return null;
  return { qty: parseInt(q[1], 10), label: rest.slice(0, idx).trim(), other: rest.slice(idx + keyword.length + 2).trim() };
}

// One Discord message -> trade_events rows. Exported for tests.
function parseMessage(msg, serverMap) {
  const rows = [];
  const content = String(msg.content || '');
  const msgTs = Math.floor(new Date(msg.timestamp).getTime() / 1000);
  content.split('\n').forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const key = `discord:${msg.id}:${idx}`;

    const th = line.match(TRADER_HEAD);
    if (th) {
      const tail = th[5].match(TRADER_TAIL);
      if (!tail) return;
      const head = th[5].slice(0, th[5].length - tail[0].length);
      const verb = th[4];
      const parts = splitHead(head, verb === 'bought' ? 'from' : 'to');
      if (!parts) return;
      const ts = parseInt(th[2], 10) || msgTs;
      const total = parseInt(tail[1], 10) || 0;
      const unit = parseInt(tail[2], 10) || 0;
      const stock = tail[3] != null ? parseInt(tail[3], 10) : null;
      const name = th[3].trim();
      const op = verb === 'bought' ? 'BUY' : 'SELL';
      rows.push({
        server_id: normalizeServerTag(th[1], serverMap), source: 'discord', dedupe_key: key, ts, day: dayOf(ts), op,
        uid: null, player_name: name, player_key: playerKey(null, name), trader: parts.other, prefab: '', label: parts.label,
        category: null, qty: parts.qty, unit_price: unit, gross: total, tax: 0, net: total,
        income: op === 'SELL' ? total : 0, spend: op === 'BUY' ? total : 0, stock_after: stock, cp_uid: null, cp_name: null,
      });
      return;
    }

    const mk = line.match(MARKET_LINE);
    if (mk) {
      const idx2 = mk[3].lastIndexOf(' to ');
      if (idx2 < 0) return;
      const label = mk[3].slice(0, idx2).trim();
      const buyer = mk[3].slice(idx2 + 4).trim();
      const seller = mk[2].trim();
      const total = parseInt(mk[4], 10) || 0;
      const serverId = normalizeServerTag(mk[1], serverMap);
      const base = {
        server_id: serverId, source: 'discord', ts: msgTs, day: dayOf(msgTs), trader: 'Marketplace', prefab: '', label,
        category: null, qty: 1, unit_price: total, gross: total, tax: 0, net: total, stock_after: null,
      };
      rows.push({ ...base, dedupe_key: key + ':s', op: 'MARKET_SELL', uid: null, player_name: seller, player_key: playerKey(null, seller), income: total, spend: 0, cp_uid: null, cp_name: buyer });
      rows.push({ ...base, dedupe_key: key + ':b', op: 'MARKET_BUY', uid: null, player_name: buyer, player_key: playerKey(null, buyer), income: 0, spend: total, cp_uid: null, cp_name: seller });
    }
  });
  return rows;
}

let job = null;

function getJob() { return job; }

// Walk the channel newest -> oldest until `since` (unix seconds, optional).
// Runs detached; poll getJob() for progress.
function startImport(channelId, { since = 0, serverMap = null } = {}) {
  if (job && job.running) throw new Error('An import is already running');
  if (!/^\d{5,25}$/.test(String(channelId))) throw new Error('channelId must be a Discord snowflake');
  job = { running: true, channelId: String(channelId), since, startedAt: Date.now(), finishedAt: null, messages: 0, parsed: 0, inserted: 0, oldestTs: null, error: null };
  (async () => {
    let before = null;
    try {
      for (;;) {
        const qs = `?limit=100${before ? `&before=${before}` : ''}`;
        const batch = await discordGet(`/channels/${channelId}/messages${qs}`);
        if (!Array.isArray(batch) || batch.length === 0) break;
        const rows = [];
        let stop = false;
        for (const msg of batch) {
          const ts = Math.floor(new Date(msg.timestamp).getTime() / 1000);
          if (since && ts < since) { stop = true; break; }
          job.messages++;
          job.oldestTs = ts;
          rows.push(...parseMessage(msg, serverMap));
        }
        job.parsed += rows.length;
        if (rows.length) job.inserted += insertMany(rows);
        if (stop || batch.length < 100) break;
        before = batch[batch.length - 1].id;
        await sleep(350); // stay well under the 50 req/s global bucket alongside the ticket bot
      }
    } catch (e) {
      job.error = e.message;
      console.error('[trade-discord-import]', e.message);
    } finally {
      job.running = false;
      job.finishedAt = Date.now();
      console.log(`[trade-discord-import] done: ${job.messages} messages, ${job.parsed} lines, ${job.inserted} new rows`);
    }
  })();
  return job;
}

module.exports = { startImport, getJob, parseMessage, normalizeServerTag };

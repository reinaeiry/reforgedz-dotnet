require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const db = require('./db');
const { lookupPlayerByGamertag } = require('./battlemetrics');
const fx = require('./fx');
const reforgedzServers = require('./reforgedzServers');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_IDS = (process.env.ADMIN_STEAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// ---- Passport Steam setup ----
passport.serializeUser((user, done) => done(null, user.steam_id));
passport.deserializeUser((steamId, done) => {
  const user = db.prepare('SELECT * FROM users WHERE steam_id = ?').get(steamId);
  done(null, user || null);
});

passport.use(new SteamStrategy({
  returnURL: BASE_URL + '/auth/steam/callback',
  realm: BASE_URL + '/',
  apiKey: process.env.STEAM_API_KEY
}, (identifier, profile, done) => {
  const steamId = profile.id;
  const persona = profile.displayName;
  const avatar = profile.photos && profile.photos[2] ? profile.photos[2].value : (profile.photos && profile.photos[0] ? profile.photos[0].value : '');
  const role = ADMIN_IDS.includes(steamId) ? 'admin' : 'user';

  db.prepare(`
    INSERT INTO users (steam_id, persona, avatar_url, role) VALUES (?, ?, ?, ?)
    ON CONFLICT(steam_id) DO UPDATE SET persona = excluded.persona, avatar_url = excluded.avatar_url, role = ?
  `).run(steamId, persona, avatar, role, role);

  const user = db.prepare('SELECT * FROM users WHERE steam_id = ?').get(steamId);
  done(null, user);
}));

// ---- Stripe webhook (must be before express.json) ----
const shopRoutes = require('./routes/shop');
app.post('/api/shop/webhook', express.raw({ type: 'application/json' }), shopRoutes.webhookHandler);

// ---- Middleware ----
app.use(express.json());
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: __dirname }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/radio', express.static(path.join(__dirname, 'radio')));

// ---- Auth routes ----
app.get('/auth/steam', passport.authenticate('steam'));
app.get('/auth/steam/callback',
  passport.authenticate('steam', { failureRedirect: '/shop' }),
  (req, res) => res.redirect('/shop')
);
app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.redirect('/shop');
    });
  });
});
app.get('/api/auth/me', (req, res) => {
  if (!req.isAuthenticated()) return res.json(null);
  res.json({
    steam_id: req.user.steam_id,
    persona: req.user.persona,
    avatar_url: req.user.avatar_url,
    role: req.user.role,
    bi_uid: req.user.bi_uid || null,
    platform: req.user.platform || 'steam',
    gamertag: req.user.gamertag || null,
    discord_id: req.user.discord_id || null
  });
});

// ---- Console sign-in (Xbox / PlayStation, no real OAuth) ----
const CONSOLE_COOKIE = 'rz_console_locked';
const CONSOLE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000;

function signConsoleCookie(payload) {
  const secret = process.env.SESSION_SECRET || 'dev-secret-change-me';
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyConsoleCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  let raw = null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === CONSOLE_COOKIE) { raw = decodeURIComponent(trimmed.slice(eq + 1)); break; }
  }
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return null;
  const encoded = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const secret = process.env.SESSION_SECRET || 'dev-secret-change-me';
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  let sigBuf, expBuf;
  try { sigBuf = Buffer.from(sig, 'base64url'); expBuf = Buffer.from(expected, 'base64url'); }
  catch { return null; }
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try { return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { return null; }
}

function setConsoleCookie(res, payload) {
  res.cookie(CONSOLE_COOKIE, signConsoleCookie(payload), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: CONSOLE_COOKIE_MAX_AGE,
    path: '/'
  });
}

const VALID_PLATFORMS = new Set(['xbox', 'psn']);

app.post('/api/auth/console/lookup', async (req, res) => {
  const { platform, gamertag } = req.body || {};
  if (!VALID_PLATFORMS.has(platform)) return res.status(400).json({ error: 'Invalid platform' });
  if (!gamertag || typeof gamertag !== 'string' || !gamertag.trim()) return res.status(400).json({ error: 'Gamertag required' });

  const result = await lookupPlayerByGamertag(gamertag.trim(), platform);
  if (!result) return res.status(404).json({ error: 'No matching player found on BattleMetrics. Make sure you have played on a tracked server with this gamertag.' });
  res.json({ bmPlayerId: result.bmPlayerId, biUid: result.biUid, displayName: result.displayName, platform });
});

app.post('/api/auth/console/confirm', async (req, res) => {
  const { platform, gamertag } = req.body || {};
  if (!VALID_PLATFORMS.has(platform)) return res.status(400).json({ error: 'Invalid platform' });
  if (!gamertag || typeof gamertag !== 'string' || !gamertag.trim()) return res.status(400).json({ error: 'Gamertag required' });

  const lookup = await lookupPlayerByGamertag(gamertag.trim(), platform);
  if (!lookup) return res.status(404).json({ error: 'Could not verify that gamertag against BattleMetrics.' });

  const lockCookie = verifyConsoleCookie(req);
  if (lockCookie && (lockCookie.platform !== platform || lockCookie.bmPlayerId !== lookup.bmPlayerId)) {
    return res.status(409).json({
      error: `Your console identity is already linked to ${lockCookie.gamertag} (${lockCookie.platform}). To change it, open a ticket in our Discord.`
    });
  }

  const synthId = 'console:' + lookup.bmPlayerId;

  let existing = db.prepare('SELECT * FROM users WHERE bm_player_id = ?').get(lookup.bmPlayerId);
  if (existing && existing.platform !== platform) {
    return res.status(409).json({
      error: `That BattleMetrics player is already registered on a different platform. Open a ticket in our Discord to fix this.`
    });
  }

  if (!existing) {
    try {
      db.prepare(`
        INSERT INTO users (steam_id, persona, avatar_url, bi_uid, role, platform, gamertag, bm_player_id)
        VALUES (?, ?, NULL, ?, 'user', ?, ?, ?)
      `).run(synthId, lookup.displayName || gamertag.trim(), lookup.biUid || null, platform, gamertag.trim(), lookup.bmPlayerId);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'That console identity is already in use. Open a ticket in our Discord.' });
      }
      throw e;
    }
    existing = db.prepare('SELECT * FROM users WHERE bm_player_id = ?').get(lookup.bmPlayerId);
  } else if (lookup.biUid && !existing.bi_uid) {
    db.prepare('UPDATE users SET bi_uid = ? WHERE steam_id = ?').run(lookup.biUid, existing.steam_id);
    existing.bi_uid = lookup.biUid;
  }

  req.login(existing, (err) => {
    if (err) {
      console.error('Console login error:', err.message);
      return res.status(500).json({ error: 'Session creation failed' });
    }
    setConsoleCookie(res, { platform, gamertag: existing.gamertag, bmPlayerId: existing.bm_player_id, ts: Date.now() });
    res.json({ ok: true, persona: existing.persona, gamertag: existing.gamertag, platform: existing.platform, bi_uid: existing.bi_uid || null });
  });
});

// ---- FX rates ----
app.get('/api/shop/fx', async (req, res) => {
  const data = await fx.getRates();
  res.json(data);
});

// ---- Shop API routes ----
app.use(shopRoutes.router);

// ---- Radio ----
let trackCache = null;

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function readMp3Meta(filePath) {
  const meta = { artist: '', duration: 0 };
  try {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const fd = fs.openSync(filePath, 'r');
    const readSize = Math.min(65536, fs.statSync(filePath).size);
    const headerBuf = Buffer.alloc(readSize);
    fs.readSync(fd, headerBuf, 0, readSize, 0);

    let id3Size = 0;
    if (headerBuf.toString('ascii', 0, 3) === 'ID3') {
      id3Size = 10 + ((headerBuf[6] << 21) | (headerBuf[7] << 14) | (headerBuf[8] << 7) | headerBuf[9]);

      let pos = 10;
      const end = Math.min(id3Size, headerBuf.length);
      while (pos + 10 < end) {
        const frameId = headerBuf.toString('ascii', pos, pos + 4);
        const frameSize = headerBuf.readUInt32BE(pos + 4);
        if (frameSize === 0 || frameSize > end - pos - 10) break;
        if (frameId === 'TPE1') {
          const enc = headerBuf[pos + 10];
          if (enc === 0) meta.artist = headerBuf.toString('latin1', pos + 11, pos + 10 + frameSize);
          else if (enc === 3) meta.artist = headerBuf.toString('utf8', pos + 11, pos + 10 + frameSize);
          else if (enc === 1 || enc === 2) {
            const s = enc === 1 ? pos + 13 : pos + 11;
            meta.artist = headerBuf.toString('utf16le', s, pos + 10 + frameSize);
          }
          meta.artist = meta.artist.replace(/\0/g, '').trim();
        }
        pos += 10 + frameSize;
      }
    }

    const frameBuf = Buffer.alloc(16);
    fs.readSync(fd, frameBuf, 0, 16, id3Size);
    fs.closeSync(fd);

    for (let i = 0; i < frameBuf.length - 4; i++) {
      if (frameBuf[i] === 0xFF && (frameBuf[i + 1] & 0xE0) === 0xE0) {
        const ver = (frameBuf[i + 1] >> 3) & 3;
        const layer = (frameBuf[i + 1] >> 1) & 3;
        const brIdx = (frameBuf[i + 2] >> 4) & 0xF;
        const brTable = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
        if (ver === 3 && layer === 1 && brTable[brIdx]) {
          meta.duration = Math.round((fileSize - id3Size) * 8 / (brTable[brIdx] * 1000));
        }
        break;
      }
    }
  } catch (e) {}
  return meta;
}

function loadAllTracks() {
  const radioDir = path.join(__dirname, 'radio');
  const categories = {};
  const trackMap = {};

  try {
    const folders = fs.readdirSync(radioDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const folder of folders) {
      const folderPath = path.join(radioDir, folder.name);
      const files = fs.readdirSync(folderPath)
        .filter(f => /\.(mp3|wav)$/i.test(f))
        .map(f => {
          const rawName = f.replace(/\.(mp3|wav)$/i, '').trim();
          // Split on " - " to separate title from artist in filename
          const parts = rawName.split(' - ');
          const nameFromFile = parts[0].replace(/[_]/g, ' ').replace(/\s+/g, ' ').trim();
          const artistFromFile = parts.length > 1 ? parts.slice(1).join(' - ').trim() : '';
          const mp3Meta = /\.mp3$/i.test(f) ? readMp3Meta(path.join(folderPath, f)) : { artist: '', duration: 0 };
          const fp = `/radio/${encodeURIComponent(folder.name)}/${encodeURIComponent(f)}`;
          const track = {
            title: nameFromFile,
            artist: mp3Meta.artist || artistFromFile || 'Modest',
            duration: mp3Meta.duration,
            file: fp,
            category: folder.name
          };
          trackMap[fp] = track;
          return track;
        });

      if (files.length > 0) {
        categories[folder.name] = files;
      }
    }
  } catch (e) {}

  return { categories, trackMap };
}

trackCache = loadAllTracks();

const statsFile = path.join(__dirname, 'radio-stats.json');
let listenStats = { plays: {}, totalSeconds: 0 };

try {
  if (fs.existsSync(statsFile)) {
    listenStats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    listenStats.plays = listenStats.plays || {};
    listenStats.totalSeconds = listenStats.totalSeconds || 0;
  }
} catch (e) {}

let saveStatsTimer = null;
function saveStats() {
  clearTimeout(saveStatsTimer);
  saveStatsTimer = setTimeout(() => {
    try { fs.writeFileSync(statsFile, JSON.stringify(listenStats)); } catch (e) {}
  }, 2000);
}

app.get('/api/radio/tracks', (req, res) => {
  if (!trackCache) trackCache = loadAllTracks();
  res.json(trackCache.categories);
});

app.get('/api/radio/stats', (req, res) => {
  res.json(listenStats);
});

app.post('/api/radio/play', (req, res) => {
  const { file } = req.body;
  if (!file) return res.sendStatus(400);
  listenStats.plays[file] = (listenStats.plays[file] || 0) + 1;
  saveStats();
  res.json({ plays: listenStats.plays[file] });
});

app.post('/api/radio/listened', (req, res) => {
  const { seconds } = req.body;
  if (!seconds || seconds <= 0) return res.sendStatus(400);
  listenStats.totalSeconds += Math.floor(seconds);
  saveStats();
  res.sendStatus(200);
});

// ---- Pterodactyl Server Status ----
const PTERO_URL = (process.env.PTERODACTYL_PANEL_URL || '').replace(/\/+$/, '');
const PTERO_KEY = process.env.PTERODACTYL_CLIENT_API_KEY || '';
const STATUS_POLL_INTERVAL = 30000;

// BattleMetrics IDs are resolved automatically per server (by IP, then port,
// then by server name) and cached for the lifetime of the process.
const bmIdCache = new Map();

let serverStatusCache = { servers: [], lastUpdate: null };

async function fetchBattleMetricsPlayers(bmId) {
  try {
    const res = await fetch(`https://api.battlemetrics.com/servers/${bmId}`);
    if (!res.ok) return null;
    const data = await res.json();
    const a = data?.data?.attributes;
    if (!a) return null;
    return { players: a.players ?? 0, max: a.maxPlayers ?? 0 };
  } catch {
    return null;
  }
}

async function resolveBattleMetricsId(rawIp, port, serverName) {
  if (!rawIp) return null;
  const portNum = Number(port);
  try {
    const ipUrl = `https://api.battlemetrics.com/servers?filter[game]=reforger&filter[search]=${encodeURIComponent(rawIp)}&page[size]=10`;
    const res = await fetch(ipUrl);
    if (res.ok) {
      const list = (await res.json())?.data || [];
      const exact = list.find(s => s.attributes?.ip === rawIp && Number(s.attributes?.port) === portNum);
      if (exact?.id) return exact.id;
      const ipOnly = list.find(s => s.attributes?.ip === rawIp);
      if (ipOnly?.id) return ipOnly.id;
    }
    const tagMatch = (serverName || '').match(/\[([^\]]+)\]/);
    const tag = tagMatch ? tagMatch[1] : null;
    if (tag) {
      const nameRes = await fetch(`https://api.battlemetrics.com/servers?filter[game]=reforger&filter[search]=${encodeURIComponent(tag)}&page[size]=5`);
      if (nameRes.ok) {
        const nd = (await nameRes.json())?.data || [];
        const tagUpper = tag.toUpperCase();
        const nameHit = nd.find(s => (s.attributes?.name || '').toUpperCase().includes(tagUpper));
        if (nameHit?.id) return nameHit.id;
      }
    }
  } catch {}
  return null;
}

async function pteroFetch(endpoint) {
  const res = await fetch(`${PTERO_URL}${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${PTERO_KEY}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`Pterodactyl API ${res.status}: ${res.statusText}`);
  return res.json();
}

function detectRegion(name, node) {
  const n = ((name || '') + ' ' + (node || '')).toLowerCase();
  if (n.includes('eu') || n.includes('europe')) return 'EU';
  if (n.includes('na') || n.includes('us') || n.includes('america')) return 'NA';
  return '??';
}

function formatUptime(ms) {
  if (!ms || ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function pollServerStatus() {
  if (!PTERO_URL || !PTERO_KEY) return;
  try {
    const listRes = await pteroFetch('/api/client?per_page=50');
    const servers = listRes.data || [];
    const statusList = [];

    for (const srv of servers) {
      const attr = srv.attributes;
      const id = attr.identifier;
      const nameLower = (attr.name || '').toLowerCase();

      // Skip dev servers and web servers
      if (nameLower.includes('dev') || nameLower.includes('.net') || nameLower.includes('.com')) continue;

      const region = detectRegion(attr.name, attr.node);

      // Get default allocation for IP:port
      const allocs = attr.relationships?.allocations?.data || [];
      const def = allocs.find(a => a.attributes?.is_default) || allocs[0];
      const ip = def ? `${def.attributes.ip_alias || def.attributes.ip}:${def.attributes.port}` : null;

      let state = 'unknown';
      let uptime = null;
      try {
        const res = await pteroFetch(`/api/client/servers/${id}/resources`);
        state = res.attributes?.current_state || 'unknown';
        uptime = res.attributes?.resources?.uptime || null;
      } catch (e) {
        state = 'unknown';
      }

      let players = null;
      let max = null;
      let bmId = bmIdCache.get(id);
      if (!bmId) {
        bmId = await resolveBattleMetricsId(def?.attributes?.ip, def?.attributes?.port, attr.name);
        if (bmId) {
          bmIdCache.set(id, bmId);
          reforgedzServers.rememberBmId(bmId);
          console.log(`Resolved BattleMetrics ID for ${attr.name}: ${bmId}`);
        }
      } else {
        reforgedzServers.rememberBmId(bmId);
      }
      if (bmId) {
        const bm = await fetchBattleMetricsPlayers(bmId);
        if (bm) { players = bm.players; max = bm.max; }
      }
      if (state !== 'running') {
        players = 0;
        if (max == null) max = 64;
      }

      statusList.push({ name: attr.name, identifier: id, region, state, ip, uptime: formatUptime(uptime), players, max });
    }

    serverStatusCache = { servers: statusList, lastUpdate: new Date().toISOString() };
  } catch (e) {
    console.error('Pterodactyl poll error:', e.message);
  }
}

if (PTERO_URL && PTERO_KEY) {
  pollServerStatus();
  setInterval(pollServerStatus, STATUS_POLL_INTERVAL);
  console.log('Server status polling started');
}

app.get('/api/servers/status', (req, res) => {
  res.json(serverStatusCache);
});

// ---- Page routes ----
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/monetization', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'monetization.html'));
});

app.get('/shop', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'shop.html'));
});

app.get('/admin/orders', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-orders.html'));
});

app.get('/map', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'map', 'index.html'));
});

app.get('/radio', (req, res) => {
  const trackFile = req.query.track;
  if (!trackFile) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }

  if (!trackCache) trackCache = loadAllTracks();
  const track = trackCache.trackMap[trackFile];

  let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

  if (track) {
    const dur = track.duration ? `${Math.floor(track.duration / 60)}:${(track.duration % 60).toString().padStart(2, '0')}` : '';
    const shareUrl = `https://reforgedz.net/radio?track=${encodeURIComponent(trackFile)}`;
    const audioUrl = `https://reforgedz.net${trackFile}`;
    const title = `${escHtml(track.title)} - ${escHtml(track.artist)}`;
    const desc = `${escHtml(track.category)}${dur ? ' \u00b7 ' + dur : ''} | Modest AI Radio on ReforgedZ.net`;

    html = html.replace(/\s*<!-- Open Graph \/ Discord embed -->[\s\S]*?<meta name="twitter:card"[^>]*>/m, `
  <!-- Open Graph / Discord embed -->
  <meta property="og:type" content="music.song">
  <meta property="og:url" content="${shareUrl}">
  <meta property="og:site_name" content="Modest AI Radio">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${desc}">
  <meta property="og:image" content="https://reforgedz.net/reforgedz.jpg">
  <meta property="og:audio" content="${audioUrl}">
  <meta property="og:audio:type" content="audio/mpeg">
  <meta name="theme-color" content="#cc1f1f">
  <meta name="twitter:card" content="player">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${desc}">
  <meta name="twitter:player" content="${audioUrl}">
  <meta name="twitter:player:stream" content="${audioUrl}">
  <meta name="twitter:player:stream:content_type" content="audio/mpeg">`);

    html = html.replace(/<title>[^<]*<\/title>/, `<title>${escHtml(track.title)} - ${escHtml(track.artist)} | Modest AI Radio</title>`);
  }

  res.send(html);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ReforgedZ.net running on port ${PORT}`);
});

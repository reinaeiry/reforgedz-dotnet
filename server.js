require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
// Session store on better-sqlite3 (which the app already uses), dropping the
// unmaintained connect-sqlite3 and its entire native-build dependency chain
// (sqlite3 → node-gyp → tar/cacache/glob/...). Fresh DB filename so it doesn't
// collide with the old connect-sqlite3 table schema in sessions.db — existing
// logins reset once on cutover, which is expected.
const SqliteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');
const sessionDb = new Database(path.join(__dirname, 'sessions-store.db'));
sessionDb.pragma('journal_mode = WAL');
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
const IS_PROD = process.env.NODE_ENV === 'production';

// Constant-time string compare for shared secrets (avoids timing side-channels).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// fetch() with an abort timeout so a hung upstream (BattleMetrics / Pterodactyl)
// can never stall the status poller or pin an event-loop slot indefinitely.
async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

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

// Behind Pterodactyl/nginx, so the client's real IP is in X-Forwarded-For.
// trust proxy = 1 means trust one hop of proxy; needed for rate-limit to key by real IP.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---- Security headers ----
// Hand-rolled (no new dependency) so it applies to EVERY response, including
// static files served below. NOTE: script-src/style-src keep 'unsafe-inline'
// because the shop, admin, monetization and map pages use inline <script>
// blocks and inline on* handlers; a stricter nonce-based policy would need those
// refactored first. unpkg.com is allowlisted because /map loads Leaflet +
// markercluster from it; the Google Fonts hosts serve the site-wide fonts.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
  "img-src 'self' data: https:",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self'",
  "media-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests"
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // HSTS only in production (never pin HTTPS-only on a local http:// dev box).
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ---- Rate limiting ----
const rateLimit = require('express-rate-limit');

// ---- PayPal webhook (must be before express.json AND before the global/auth
// limiters, because PayPal controls its retry cadence and its IPs change;
// signature verification needs the raw body). It gets its OWN generous limiter
// so a flood of forged webhooks can't amplify into unbounded outbound calls to
// PayPal (each verify attempt costs us round-trips) — PayPal's real retries are
// bursty but bounded well under this ceiling. ----
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests.' }
});
const shopRoutes = require('./routes/shop');
app.post('/api/shop/paypal/webhook', webhookLimiter, express.raw({ type: '*/*' }), shopRoutes.webhookHandler);
// Back-compat alias so any still-registered Stripe webhook URL doesn't 404.
app.post('/api/shop/webhook', webhookLimiter, express.raw({ type: '*/*' }), shopRoutes.webhookHandler);

// Register PayPal webhooks with PayPal on boot (idempotent).
shopRoutes.registerPayPalWebhooks().catch((e) => console.error('[paypal] webhook registration error:', e.message));

// Generous global ceiling to catch obvious abuse without hurting real users.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' }
});

// Tighter limiter for write endpoints (POST/PUT/DELETE on /api/...).
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many write requests. Slow down.' }
});

// Stricter still for auth + checkout endpoints (cheaper to brute-force these).
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Try again in a minute.' }
});

app.use(globalLimiter);

// ---- wifi.reforgedz.net ----
// The Cloudflare tunnel points the wifi subdomain at this same container, so
// route by Host before sessions/static kick in. Besides the page itself, the
// subdomain serves its own speed-test endpoints, because the site's CSP is
// connect-src 'self': the tester may only talk to its own origin.
//
//   /ping.bin        32 B, edge-cached  -> latency to the nearest Cloudflare PoP
//   /blob-<n>m.bin   incompressible bulk, edge-cached -> download measures the
//                    user's access network, not the tunnel back to this box
//   /upload          POST, drained and counted here -> upload DOES traverse to
//                    this box; the page labels it accordingly
//
// The .bin extension matters: it is on Cloudflare's default-cacheable list, so
// with Cache-Control public the edge keeps these and only /upload and the page
// itself ever reach this process once a PoP is warm.
const wifiPage = path.join(__dirname, 'public', 'wifi', 'index.html');
// 1 MiB of noise, repeated per-request below. gzip's 32 KB window cannot fold
// the repetition, so the wire size is the advertised size.
const wifiChunk = crypto.randomBytes(1024 * 1024);
const WIFI_BLOBS = { '/blob-1m.bin': 1, '/blob-10m.bin': 10, '/blob-25m.bin': 25 };
const WIFI_UPLOAD_CAP = 40 * 1024 * 1024;

function sendWifiBlob(res, mib) {
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(mib * wifiChunk.length),
    'Cache-Control': 'public, max-age=86400, immutable'
  });
  let left = mib;
  (function pump() {
    while (left > 0) {
      left--;
      if (!res.write(wifiChunk)) { res.once('drain', pump); return; }
    }
    res.end();
  })();
}

app.use((req, res, next) => {
  if (req.hostname !== 'wifi.reforgedz.net') return next();

  if (req.method === 'POST' && req.path === '/upload') {
    let received = 0;
    req.on('data', (c) => {
      received += c.length;
      if (received > WIFI_UPLOAD_CAP) req.destroy();
    });
    req.on('end', () => res.json({ received }));
    req.on('error', () => { try { res.destroy(); } catch {} });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(404).end();
  if (req.path === '/ping.bin') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': '32',
      'Cache-Control': 'public, max-age=86400, immutable'
    });
    return res.end(wifiChunk.subarray(0, 32));
  }
  const mib = WIFI_BLOBS[req.path];
  if (mib) return sendWifiBlob(res, mib);
  res.sendFile(wifiPage);
});

// ---- Middleware ----
app.use(express.json());
app.use(session({
  store: new SqliteStore({
    client: sessionDb,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 }
  }),
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

// ---- Tighter limiter on /api writes ----
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return writeLimiter(req, res, next);
});

// ---- CSRF defense via Origin/Referer check on state-changing requests.
// Skips: GETs, the PayPal webhook (different signing), and requests carrying
// the shared admin API key (server-to-server calls from the admin page).
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.path === '/api/shop/paypal/webhook' || req.path === '/api/shop/webhook') return next();
  const apiKey = req.headers['x-shop-admin-key'];
  if (apiKey && process.env.SHOP_ADMIN_API_KEY && safeEqual(apiKey, process.env.SHOP_ADMIN_API_KEY)) return next();

  let allowedHost;
  try { allowedHost = new URL(BASE_URL).host; }
  catch { allowedHost = ''; }

  const origin = req.headers.origin;
  const referer = req.headers.referer;
  let originHost = '';
  try {
    if (origin) originHost = new URL(origin).host;
    else if (referer) originHost = new URL(referer).host;
  } catch {}

  if (!allowedHost || originHost !== allowedHost) {
    return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  next();
});

// ---- NattiiGuard download counter ----
// Counts only -- no IPs, no user agents, nothing personal. Same file pattern as
// radio-stats.json. Registered BEFORE express.static, which would otherwise serve
// /downloads/* first and the count would never happen.
const ngStatsFile = path.join(__dirname, 'nattiiguard-stats.json');
let ngStats = { total: 0, byDay: {}, updates: 0 };
try { ngStats = { updates: 0, ...JSON.parse(fs.readFileSync(ngStatsFile, 'utf8')) }; } catch {}

// The version manifest is the single source of truth for a release: the app's
// built-in updater polls /nattiiguard/version and compares against itself.
// Shipping an update = new installer in public/downloads + rewrite this file,
// in the SAME commit (the sha256 must always match the exe being served).
const ngManifestFile = path.join(__dirname, 'nattiiguard-version.json');
let ngManifest = null;
try { ngManifest = JSON.parse(fs.readFileSync(ngManifestFile, 'utf8')); } catch {}

function countNattiiGuardDownload(isUpdate) {
  const day = new Date().toISOString().slice(0, 10);
  ngStats.total += 1;
  ngStats.byDay[day] = (ngStats.byDay[day] || 0) + 1;
  if (isUpdate) ngStats.updates += 1;
  fs.writeFile(ngStatsFile, JSON.stringify(ngStats, null, 2), () => {});
}

app.use('/downloads', (req, res, next) => {
  if (req.method === 'GET' && /NattiiGuard-Setup.*\.exe$/i.test(req.path)) {
    countNattiiGuardDownload(req.query.update === '1');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/radio', express.static(path.join(__dirname, 'radio')));

// ---- Auth routes ----
app.get('/auth/steam', authLimiter, passport.authenticate('steam'));
app.get('/auth/steam/callback', authLimiter,
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

app.post('/api/auth/console/lookup', authLimiter, async (req, res) => {
  const { platform, gamertag } = req.body || {};
  if (!VALID_PLATFORMS.has(platform)) return res.status(400).json({ error: 'Invalid platform' });
  if (!gamertag || typeof gamertag !== 'string' || !gamertag.trim()) return res.status(400).json({ error: 'Gamertag required' });

  const result = await lookupPlayerByGamertag(gamertag.trim(), platform);
  if (!result) return res.status(404).json({ error: 'No matching player found on BattleMetrics. Make sure you have played on a tracked server with this gamertag.' });
  res.json({ bmPlayerId: result.bmPlayerId, biUid: result.biUid, displayName: result.displayName, platform });
});

app.post('/api/auth/console/confirm', authLimiter, async (req, res) => {
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

  // Account takeover protection: gamertags are public, BM lookup just maps
  // gamertag → bm_player_id with no proof of ownership. If we already have an
  // account on that bm_player_id, only let the requester log in when their
  // console cookie proves they're the same person who originally linked.
  // First-time account creation is unrestricted because there's nothing yet
  // to take over.
  if (existing && (!lockCookie || lockCookie.bmPlayerId !== existing.bm_player_id)) {
    return res.status(409).json({
      error: 'This gamertag is already linked to an account. If it is yours and you cleared your cookies (or switched browsers), open a ticket in our Discord and an admin will re-link you.'
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
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  const { file } = req.body || {};
  if (!file || typeof file !== 'string') return res.sendStatus(400);
  // Only count real, known tracks — otherwise an attacker could grow
  // radio-stats.json without bound by posting arbitrary keys.
  if (!trackCache) trackCache = loadAllTracks();
  if (!trackCache.trackMap[file]) return res.sendStatus(400);
  listenStats.plays[file] = (listenStats.plays[file] || 0) + 1;
  saveStats();
  res.json({ plays: listenStats.plays[file] });
});

app.post('/api/radio/listened', (req, res) => {
  const seconds = Number(req.body && req.body.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return res.sendStatus(400);
  // Cap a single report at one hour so a crafted value can't inflate the total.
  listenStats.totalSeconds += Math.min(Math.floor(seconds), 3600);
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

// BattleMetrics stopped serving anonymous API requests (every endpoint now
// 403s without a token), so all BM calls must carry the same token the
// player-search already uses.
function bmAuthHeaders() {
  const tk = process.env.BATTLEMETRICS_TOKEN;
  return tk ? { Authorization: `Bearer ${tk}` } : {};
}

async function fetchBattleMetricsPlayers(bmId) {
  try {
    const res = await fetchWithTimeout(`https://api.battlemetrics.com/servers/${bmId}`, { headers: bmAuthHeaders() }, 8000);
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
    const res = await fetchWithTimeout(ipUrl, { headers: bmAuthHeaders() }, 8000);
    if (!res.ok) console.warn(`[bm] server search HTTP ${res.status} for ${rawIp}`);
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
      const nameRes = await fetchWithTimeout(`https://api.battlemetrics.com/servers?filter[game]=reforger&filter[search]=${encodeURIComponent(tag)}&page[size]=5`, { headers: bmAuthHeaders() }, 8000);
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
  const res = await fetchWithTimeout(`${PTERO_URL}${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${PTERO_KEY}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  }, 10000);
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

// Gate the admin pages server-side. The APIs behind them are already
// requireAdmin-guarded, but serving the HTML to anyone leaks the full admin
// surface (endpoint names, destructive operations). Return 404 to non-admins so
// the paths aren't even discoverable. Admins are always session-authenticated.
function requireAdminPage(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.user && req.user.role === 'admin') return next();
  return res.status(404).send('Not found');
}

app.get('/admin/orders', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-orders.html'));
});

app.get('/admin/saves', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-saves.html'));
});

app.get('/map', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'map', 'index.html'));
});

// Short links worth pasting in Discord when someone says "my game keeps crashing".
// The filename comes from the version manifest, so a release updates one file.
const NATTIIGUARD_INSTALLER = (ngManifest && ngManifest.file) || 'NattiiGuard-Setup-3.1.0.exe';

app.get('/nattiiguard', (req, res) => {
  res.redirect('/#nattiiguard');
});

app.get('/nattiiguard/download', (req, res) => {
  countNattiiGuardDownload(false);   // this path bypasses the /downloads middleware
  res.download(path.join(__dirname, 'public', 'downloads', NATTIIGUARD_INSTALLER));
});

// What the app's updater polls on launch. 404 (not a stale answer) if the
// manifest is missing/corrupt -- the app treats any non-200 as "no update".
app.get('/nattiiguard/version', (req, res) => {
  if (!ngManifest) return res.status(404).json({ error: 'no manifest' });
  res.json(ngManifest);
});

// "Has anyone downloaded it yet?" -- answerable without SSH. Counts only.
app.get('/nattiiguard/stats', (req, res) => {
  const days = Object.entries(ngStats.byDay).sort().slice(-14);
  res.json({ total: ngStats.total, updates: ngStats.updates, last14days: Object.fromEntries(days) });
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
    // Use the *cached* track.file (filesystem-derived, already URL-encoded
    // segment-by-segment in loadAllTracks) rather than the raw query value,
    // so meta-tag injection is impossible even if the query param was crafted.
    const safeFile = track.file;
    const dur = track.duration ? `${Math.floor(track.duration / 60)}:${(track.duration % 60).toString().padStart(2, '0')}` : '';
    const shareUrl = `https://reforgedz.net/radio?track=${encodeURIComponent(safeFile)}`;
    const audioUrl = escHtml(`https://reforgedz.net${safeFile}`);
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

// ---- Catch-all error handler ----
// A thrown route error returns JSON (not an HTML stack page) and never bubbles
// up to crash the process. Must be registered AFTER all routes.
app.use((err, req, res, next) => {
  console.error('[express] Unhandled route error:', err && (err.stack || err.message || err));
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ---- Process-level guards (steady uptime) ----
// This is a single Node process serving the site, shop, radio and status pages.
// Log-and-continue beats crashing the whole box on one stray async error; the
// per-route handler above and the PayPal webhook handler already follow this
// philosophy. Anything genuinely fatal will still surface loudly in the logs.
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled promise rejection:', reason && (reason.stack || reason.message || reason));
});
process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception (kept alive):', err && (err.stack || err.message || err));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ReforgedZ.net running on port ${PORT}`);
});

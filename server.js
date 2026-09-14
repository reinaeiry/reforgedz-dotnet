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
const { dataPath } = require('./dataDir');
const sessionDb = new Database(dataPath('sessions-store.db'));
sessionDb.pragma('journal_mode = WAL');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const db = require('./db');
const { cleanGamertag, orgId: bmOrgId, findPlayers, asReforgerUuid } = require('./battlemetrics');
const fx = require('./fx');
const reforgedzServers = require('./reforgedzServers');
const webAuth = require('./webAuth');
const consoleIdentity = require('./consoleIdentity');
const { sendAccountLink } = require('./invoiceMail');

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
  // Admin is decided by ADMIN_STEAM_IDS on every request, not by whatever the row
  // said when this person last logged in. The Steam callback below persists role
  // at login and nothing ever writes it back, so removing someone from
  // ADMIN_STEAM_IDS used to leave their existing 30-day session -- and their row --
  // with refund, revoke, save-purge and re-link rights. Only 'admin' is derived
  // here; any other role on the row is left as it is.
  if (user) user.role = ADMIN_IDS.includes(user.steam_id) ? 'admin' : (user.role === 'admin' ? 'user' : user.role);
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
  // static.cloudflareinsights.com is Cloudflare's Web Analytics beacon, injected
  // at the edge; without it every page logged a blocked-script error.
  "script-src 'self' 'unsafe-inline' https://unpkg.com https://static.cloudflareinsights.com",
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

// ---- wiki.reforgedz.net: the retired wiki's host, every request 301s to the new wiki ----
// Served from this box (it used to be a Cloudflare Worker, which bots on the old host pushed past the free daily
// request cap). Any method; the target only ever comes from lib/wiki-aliases.json.
const wikiRedirect = require('./lib/wiki-redirect');
app.use((req, res, next) => {
  if (req.hostname !== 'wiki.reforgedz.net') return next();
  res.writeHead(301, {
    Location: wikiRedirect.locationFor(`https://wiki.reforgedz.net${req.originalUrl}`),
    // A day, not forever, so browsers pick up a changed table or a removed redirect.
    'Cache-Control': 'public, max-age=86400',
    'Content-Length': '0'
  });
  res.end();
});

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
    // 'auto' marks the session cookie Secure whenever the request arrived over HTTPS, as Express
    // sees it through `trust proxy` (Cloudflare sets X-Forwarded-Proto). It used to key on
    // NODE_ENV === 'production', which is unset in this container, so the 30-day login cookie
    // was never Secure. 'auto' cannot break sign-in: if a request is not seen as HTTPS the cookie
    // is still set, just without the flag -- whereas secure: true would refuse to set it at all.
    secure: 'auto'
  }
}));
app.use(passport.initialize());
app.use(passport.session());

// Every sign-in records the account's auth_gen in the session, and a session whose
// generation no longer matches (the password was reset since) is signed out.
// Sessions from before this existed carry none, which reads as 0, the value every
// account starts with, so nobody is signed out by the change itself.
//
// It also records how the session signed in (options.authMethod: 'steam',
// 'password', 'link' or 'relink'). Admin rights come from ADMIN_STEAM_IDS and hold
// only on a Steam session: a password or an emailed link never makes anyone an
// admin. Sessions from before this existed carry no method, and the only way one
// of those could belong to an ADMIN_STEAM_IDS account was Steam.
app.use((req, res, next) => {
  const logIn = req.logIn;
  if (typeof logIn === 'function') {
    const wrapped = function (user, options, done) {
      if (typeof options === 'function') { done = options; options = {}; }
      const method = (options && options.authMethod) || 'other';
      return logIn.call(req, user, options, (err) => {
        if (!err && req.session && user) {
          req.session.authGen = Number(user.auth_gen) || 0;
          req.session.authMethod = method;
        }
        if (done) done(err);
      });
    };
    req.login = wrapped;
    req.logIn = wrapped;
  }
  if (req.user && (Number(req.session && req.session.authGen) || 0) !== (Number(req.user.auth_gen) || 0)) {
    return req.logout((err) => {
      if (err) console.error('[auth] sign-out after a password reset failed:', err.message);
      next();
    });
  }
  if (req.user && req.user.role === 'admin') {
    const method = req.session && req.session.authMethod;
    if (method !== undefined && method !== 'steam') req.user.role = 'user';
  }
  next();
});

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
const ngStatsFile = dataPath('nattiiguard-stats.json');
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

// public/admin-*.html are only meant to be reached through their requireAdminPage
// routes (/admin/orders, /admin/console-relink, /admin/saves), which sendFile
// them. Left to express.static they went to anyone who asked for the file
// directly -- including as /admin%2Dorders.html, /%2e/admin-orders.html or
// /x/../admin-orders.html, because send decodes and normalises a path before it
// touches the disk. So match the way send does: decode once, resolve dot
// segments, then test the file name. Answer exactly as requireAdminPage does, so
// the two responses are indistinguishable.
app.use((req, res, next) => {
  let requested;
  try { requested = decodeURIComponent(req.path); } catch { return next(); }
  if (/^admin-.*\.html$/i.test(path.posix.basename(path.posix.normalize(requested)))) {
    return res.status(404).send('Not found');
  }
  next();
});
// ---- The wiki (reforgedz.net/wiki) ----
// Built by the ReforgedZ-Wiki repo and copied into public/wiki by its deploy script; served from this box rather
// than a Cloudflare Worker. Its security headers come from public/wiki/_headers, which the wiki build writes, so
// the wiki repo stays the source of truth for its own CSP. HTML and data revalidate on every visit (the pages
// change with the mod); Express's ETags keep that cheap.
const WIKI_DIR = path.join(__dirname, 'public', 'wiki');
const WIKI_HEADERS = (() => {
  const out = {};
  try {
    let inBlock = false;
    for (const line of fs.readFileSync(path.join(WIKI_DIR, '_headers'), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (!/^\s/.test(line)) { inBlock = line.trim() === '/wiki/*'; continue; }
      if (!inBlock) continue;
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch {}
  return out;
})();
function setWikiHeaders(res) {
  for (const [name, value] of Object.entries(WIKI_HEADERS)) res.setHeader(name, value);
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
}
// _headers is build metadata, not a page: the general static handler further down would otherwise serve it.
app.get('/wiki/_headers', (req, res) => { setWikiHeaders(res); res.status(404).sendFile(path.join(WIKI_DIR, '404.html')); });
const wikiStatic = express.static(WIKI_DIR, { index: 'index.html', redirect: true, maxAge: 0, setHeaders: setWikiHeaders });
app.use('/wiki', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  wikiStatic(req, res, () => {
    // Nothing on disk for this path: the wiki's own 404 page, with the wiki's headers.
    setWikiHeaders(res);
    res.status(404).sendFile(path.join(WIKI_DIR, '404.html'), (err) => { if (err) next(); });
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/radio', express.static(path.join(__dirname, 'radio')));

// ---- Auth routes ----

// Where to send someone once they are signed in. Every sign-in used to land on
// /shop, so a player who started on /account ("Go to the shop to sign in")
// had to find their way back by hand. Only a same-origin path is honoured;
// anything else — an absolute URL, a protocol-relative //host, a backslash
// trick — falls through to /shop.
function safeReturnTo(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  if (/[\r\n]/.test(raw)) return null;
  return raw;
}

app.get('/auth/steam', authLimiter, (req, res, next) => {
  const dest = safeReturnTo(req.query.next);
  if (dest) req.session.returnTo = dest; else delete req.session.returnTo;
  next();
}, passport.authenticate('steam'));
app.get('/auth/steam/callback', authLimiter,
  // passport ≥0.6 regenerates the session on login and would drop returnTo
  // without keepSessionInfo.
  // authMethod reaches the sign-in wrapper below: admin rights need a Steam session.
  passport.authenticate('steam', { failureRedirect: '/shop', keepSessionInfo: true, authMethod: 'steam' }),
  (req, res) => {
    const dest = safeReturnTo(req.session.returnTo) || '/shop';
    delete req.session.returnTo;
    res.redirect(dest);
  }
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
    discord_id: req.user.discord_id || null,
    email: req.user.email || null,
    has_password: !!req.user.password_hash,
    email_verified: !!req.user.email_verified_at
  });
});

// ---- Website accounts: email and password -----------------------------------
// The shop's own sign-in (webAuth.js, which explains who can add email sign-in to
// an existing account, and why). Steam stays for staff and existing Steam
// customers. Xbox and PlayStation customers move over with "Forgot password" and
// the email they paid with, which sets a password on the account they already
// have, so no order or subscription moves.

function signInAndReply(req, res, user, method, extra = {}) {
  req.login(user, { authMethod: method }, (err) => {
    if (err) {
      console.error('[auth] session error:', err.message);
      return res.status(500).json({ error: 'Could not sign you in. Try again.' });
    }
    res.json({ ok: true, ...extra });
  });
}

// A thrown error in a sign-in route: "busy" (too many passwords hashing at once)
// is its own answer; anything else is logged and a 500.
function authError(res, e, where, message) {
  if (e && e.code === 'auth_busy') return res.status(503).json({ code: 'busy', error: e.message });
  console.error(`[auth] ${where} failed:`, e && e.message);
  return res.status(500).json({ error: message });
}

// The name an existing account goes by in emails and on the link page.
function accountLabel(user) {
  if (!user || user.platform === 'web') return null;
  return user.gamertag || user.persona || null;
}

function publicBase() {
  let base = String(process.env.PUBLIC_BASE_URL || BASE_URL);
  while (base.endsWith('/')) base = base.slice(0, -1);
  return base;
}

// Send what an email target needs: a reset, claim or attach link, or for a Steam
// customer a pointer to Steam sign-in. Never throws. { ok } or { ok: false,
// skipped | error }: skipped 'cooldown' when this account had the same link
// moments ago, 'budget' when this address or the site has had its share of mail.
async function mailAccountLink(target, email) {
  const now = Math.floor(Date.now() / 1000);
  const usesLink = target.purpose !== 'steam';
  if (usesLink && webAuth.recentlyIssued(db, target.user.steam_id, target.purpose, now)) return { ok: false, skipped: 'cooldown' };
  if (!webAuth.takeMailSlot(email, now)) return { ok: false, skipped: 'budget' };
  let url = `${publicBase()}/auth/steam?next=${encodeURIComponent('/account')}`;
  if (usesLink) {
    const token = webAuth.issueToken(db, { steamId: target.user.steam_id, purpose: target.purpose, email, now });
    url = `${publicBase()}/account/reset?token=${encodeURIComponent(token)}`;
  }
  const sent = await sendAccountLink({
    to: email,
    purpose: target.purpose,
    accountName: accountLabel(target.user),
    url,
    expiresMinutes: Math.round(webAuth.TOKEN_TTL_S / 60)
  });
  if (sent.ok) console.log(`[auth] ${target.purpose} email sent for ${target.user.steam_id}`);
  else console.error(`[auth] ${target.purpose} email for ${target.user.steam_id} not sent: ${sent.skipped || 'send failed'}`);
  return sent;
}

// A sign-up with an email ReforgedZ already knows (an account signs in with it,
// or a customer paid with it) gets this one answer whichever it is, and the email
// itself gets what fits: a reset link, a link to set up sign-in on the account the
// customer already has, or a pointer to Steam. So sign-up does not reveal whether
// an address belongs to a paying customer, and a customer never ends up with a
// second, empty account that hides their purchases.
const KNOWN_EMAIL_REPLY = {
  ok: true,
  linkSent: true,
  message: 'That email is already registered with ReforgedZ, so we have not made a second account. We sent it an email with the next step. If you know your password, choose Sign in instead. Check your spam folder too.'
};

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { email: rawEmail, password } = req.body || {};
    const email = webAuth.normalizeEmail(rawEmail);
    if (!email) return res.status(400).json({ error: 'Enter a valid email address.' });
    const problem = webAuth.passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    const target = webAuth.resolveEmailTarget(db, email);
    if (target) {
      mailAccountLink(target, email).catch((e) => console.error('[auth] sign-up email failed:', e.message));
      return res.json(KNOWN_EMAIL_REPLY);
    }
    const hash = await webAuth.hashPassword(password);
    let user;
    try {
      user = webAuth.createWebUser(db, { email, passwordHash: hash });
    } catch (e) {
      // Registered by someone else while the password was hashing.
      if (String(e.message).includes('UNIQUE')) return res.json(KNOWN_EMAIL_REPLY);
      throw e;
    }
    console.log(`[auth] new website account ${user.steam_id}`);
    signInAndReply(req, res, user, 'password');
  } catch (e) {
    authError(res, e, 'register', 'Could not create your account. Try again.');
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email: rawEmail, password } = req.body || {};
    const email = webAuth.normalizeEmail(rawEmail);
    const wrong = () => res.status(401).json({ error: 'Email or password is incorrect.' });
    if (!email || typeof password !== 'string' || !password) return wrong();
    if (webAuth.loginLocked(email, req.ip)) {
      return res.status(429).json({ code: 'locked', error: 'Too many wrong passwords. Wait 15 minutes, or use "Forgot password".' });
    }
    const user = webAuth.findUserByEmail(db, email);
    const ok = await webAuth.verifyPassword(password, user ? user.password_hash : null);
    if (!user || !ok) {
      webAuth.recordLoginFailure(email, req.ip);
      return wrong();
    }
    webAuth.clearLoginFailures(email, req.ip);
    signInAndReply(req, res, user, 'password');
  } catch (e) {
    authError(res, e, 'login', 'Could not sign you in. Try again.');
  }
});

app.post('/api/auth/reset/request', authLimiter, (req, res) => {
  const email = webAuth.normalizeEmail((req.body || {}).email);
  if (!email) return res.status(400).json({ error: 'Enter a valid email address.' });
  // The same answer, at the same speed, whether or not the email is known.
  res.json({
    ok: true,
    message: 'If that email has a ReforgedZ account or has bought from us, an email is on its way. A link in it works once and expires in 60 minutes. Check your spam folder too.'
  });
  try {
    const target = webAuth.resolveEmailTarget(db, email);
    if (target) mailAccountLink(target, email).catch((e) => console.error('[auth] reset email failed:', e.message));
  } catch (e) {
    console.error('[auth] reset request failed:', e.message);
  }
});

app.get('/api/auth/reset/check', authLimiter, (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const found = webAuth.readToken(db, token);
  if (found.error) return res.status(400).json({ code: found.code || null, error: found.error });
  res.json({
    ok: true,
    purpose: found.row.purpose,
    email: found.row.email,
    accountName: accountLabel(found.user)
  });
});

app.post('/api/auth/reset/complete', authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body || {};
    const done = await webAuth.completeToken(db, { token: typeof token === 'string' ? token : '', password });
    if (done.error) return res.status(400).json({ code: done.code || null, error: done.error });
    if (done.user.email) webAuth.clearLoginFailures(done.user.email, req.ip);
    console.log(`[auth] ${done.purpose} completed for ${done.user.steam_id}`);
    signInAndReply(req, res, done.user, 'link', { purpose: done.purpose });
  } catch (e) {
    authError(res, e, 'reset complete', 'Could not save your password. Try again.');
  }
});

app.get('/account/reset', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reset.html'));
});

// A signed-in account asks to add email sign-in. Nothing is saved yet: the email
// gets a link, and opening it (proof the address is theirs) sets the email and a
// password on this same account, so every order stays where it is.
app.post('/api/auth/add-login', authLimiter, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Sign in required' });
  try {
    const email = webAuth.normalizeEmail((req.body || {}).email);
    if (!email) return res.status(400).json({ error: 'Enter a valid email address.' });
    const refusal = webAuth.addLoginRefusal(req.user, { relinkedAt: req.session && req.session.relinkedAt });
    if (refusal) return res.status(refusal.status).json({ code: refusal.code, error: refusal.error });
    if (webAuth.findUserByEmail(db, email)) {
      return res.status(409).json({ code: 'email_taken', error: 'That email already signs in to another ReforgedZ account. Use a different email, or sign in to that account instead.' });
    }
    const sent = await mailAccountLink({ purpose: 'attach', user: req.user }, email);
    if (sent.ok) {
      return res.json({ ok: true, linkSent: true, message: `We emailed a link to ${email}. Open it within 60 minutes to confirm the address and choose a password. Check your spam folder too.` });
    }
    if (sent.skipped === 'cooldown' || sent.skipped === 'budget') {
      return res.status(429).json({ code: 'wait', error: 'We sent a link moments ago. Check your email, or try again in a few minutes.' });
    }
    return res.status(503).json({ code: 'mail_failed', error: 'We could not send the email just now. Try again in a few minutes.' });
  } catch (e) {
    authError(res, e, 'add-login', 'Could not send the link. Try again.');
  }
});

// "Find me" in the in-game ID box: the players a name or pasted ID could mean,
// for a signed-in player to pick from. Picks are remembered in the session, and
// /api/shop/set-bi-uid only accepts a pick this browser was shown.
const findLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many searches. Try again in a minute.' }
});

app.post('/api/identity/find', findLimiter, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Sign in required' });
  const { query, wide } = req.body || {};
  if (typeof query !== 'string' || !query.trim()) return res.status(400).json({ error: 'Type the name you play under, or paste your in-game ID.' });
  if (!asReforgerUuid(query) && !cleanGamertag(query)) {
    return res.status(400).json({ error: 'That does not look like a player name or an in-game ID.' });
  }
  const result = await findPlayers(query, { wide: wide === true });
  if (result.unavailable) return res.status(503).json({ error: 'We could not reach BattleMetrics to search. Please try again in a minute.' });
  consoleIdentity.rememberCandidates(req.session, result.candidates);
  res.json({
    candidates: result.candidates.map((c) => ({
      ref: c.bmPlayerId, name: c.name, lastSeen: c.lastSeen, previousName: c.previousName, exact: c.exact
    }))
  });
});

// ---- Console sign-in (retired 2026-09-14) -----------------------------------
// Xbox and PlayStation sign-in was a gamertag plus a browser cookie. It never
// proved who was typing, so it is gone. Existing console customers set up email
// sign-in with "Forgot password" and the email they paid with (webAuth.js
// "claim"); anyone without that email gets a staff re-link below. Old pages that
// still call these routes are told where sign-in went.
const VALID_PLATFORMS = new Set(['xbox', 'psn']);
const CONSOLE_SIGNIN_MOVED = {
  code: 'console_signin_moved',
  error: 'Xbox and PlayStation sign-in has moved to email. Choose Sign in, then "Forgot password", and enter the email you paid with: we will email you a link to set a password on the account you already have. New here? Create an account with your email. No access to the email you paid with? Open a ticket in our Discord.'
};
app.post('/api/auth/console/lookup', authLimiter, (req, res) => res.status(410).json(CONSOLE_SIGNIN_MOVED));
app.post('/api/auth/console/confirm', authLimiter, (req, res) => res.status(410).json(CONSOLE_SIGNIN_MOVED));

// ---- Console re-link (staff-issued, single use) ----------------------------
// See db.js for why this exists: without it, a console player who clears
// cookies or switches device is permanently locked out of their own account
// and staff have no way to help, despite the refusal message promising one.

// 24h, widened from 15 min on 2026-09-04. The link is now issued through a
// Founder approval in Discord (/relink), and the gap between "player asks" and
// "Founder is at a keyboard" is hours, not minutes — a 15-minute link was dead
// before the player ever saw it. Single use is what actually bounds the risk:
// the token dies on first open, and issuing a new one retires the old one, so
// the TTL is only the ceiling on a link nobody ever clicked.
const RELINK_TTL_MS = 24 * 60 * 60 * 1000;
const RELINK_TOKEN_BYTES = 32;

function hashRelinkToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function findConsoleUser({ bmPlayerId, gamertag }) {
  if (bmPlayerId) {
    return db.prepare('SELECT * FROM users WHERE bm_player_id = ?').get(String(bmPlayerId).trim());
  }
  if (gamertag) {
    return db.prepare(
      "SELECT * FROM users WHERE platform IN ('xbox','psn') AND lower(gamertag) = lower(?)"
    ).get(String(gamertag).trim());
  }
  return null;
}

// Staff: issue a re-link for an EXISTING console account.
app.post('/api/shop/admin/console/relink', writeLimiter, shopRoutes.requireAdmin, (req, res) => {
  const { gamertag, bmPlayerId } = req.body || {};
  if (!gamertag && !bmPlayerId) return res.status(400).json({ error: 'Give a gamertag or a BattleMetrics player id' });

  // requireAdmin admits a signed-in admin OR the shared key the ticket bot uses,
  // so attribute whichever one actually got in.
  const issuedBy = (req.user && req.user.steam_id) ? `steam:${req.user.steam_id}` : 'discord-bot';

  const user = findConsoleUser({ bmPlayerId, gamertag });
  if (!user) return res.status(404).json({ error: 'No account found for that gamertag or player id' });
  // Steam is refused on purpose, and it is not a guard waiting to be relaxed.
  // A Steam account has no lockout to remedy: it signs in through real Steam
  // OpenID, any browser, any time — `rz_console_locked` exists only because
  // console sign-in has no ownership proof at all. Issuing a re-link for one
  // would create a bearer link that signs someone into a Steam-authenticated
  // account WITHOUT Steam, which is strictly worse than the problem it solves.
  // It also does not fit the storage: console_relink_tokens keys on
  // `bm_player_id TEXT NOT NULL`, and all 220 Steam users have it NULL
  // (measured 2026-09-04), so supporting Steam means a schema change and a
  // second lookup path as well as a second auth story.
  if (!VALID_PLATFORMS.has(user.platform)) {
    return res.status(400).json({ error: `That is a ${user.platform} account, not a console one. Only Xbox and PlayStation use the console lock — a Steam player can just sign in with Steam again.` });
  }
  if (!user.bm_player_id) return res.status(400).json({ error: 'That account has no BattleMetrics player id to re-link' });

  const token = crypto.randomBytes(RELINK_TOKEN_BYTES).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + Math.floor(RELINK_TTL_MS / 1000);

  const issue = db.transaction(() => {
    // Only one live link per player: issuing a new one retires any earlier
    // unused link, so a token that leaked into a Discord channel stops working
    // the moment staff reissue.
    db.prepare(
      "UPDATE console_relink_tokens SET used_at = ?, used_note = 'superseded' WHERE bm_player_id = ? AND used_at IS NULL"
    ).run(now, user.bm_player_id);
    db.prepare(`
      INSERT INTO console_relink_tokens (token_hash, bm_player_id, platform, issued_by, issued_at, expires_at)
      VALUES (?,?,?,?,?,?)
    `).run(hashRelinkToken(token), user.bm_player_id, user.platform, issuedBy, now, expiresAt);
  });
  issue();

  const base = process.env.PUBLIC_BASE_URL || 'https://reforgedz.net';
  console.log(`[console-relink] issued for ${user.gamertag} (${user.platform}/${user.bm_player_id}) by ${issuedBy}`);
  res.json({
    ok: true,
    url: `${base}/console-relink?token=${encodeURIComponent(token)}`,
    expiresAt,
    expiresInMinutes: Math.round(RELINK_TTL_MS / 60000),
    expiresInHours: Math.round(RELINK_TTL_MS / 3600000),
    gamertag: user.gamertag,
    platform: user.platform
  });
});

// Player-facing page. Static: the token is only ever read by the script on it.
app.get('/console-relink', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'console-relink.html'));
});

function loadRelinkToken(token) {
  if (!token || typeof token !== 'string') return { error: 'Missing link' };
  const row = db.prepare('SELECT * FROM console_relink_tokens WHERE token_hash = ?').get(hashRelinkToken(token));
  if (!row) return { error: 'This link is not valid. Ask staff for a new one.' };
  if (row.used_at) return { error: 'This link has already been used. Ask staff for a new one.' };
  if (row.expires_at < Math.floor(Date.now() / 1000)) return { error: 'This link has expired. Ask staff for a new one.' };
  const user = db.prepare('SELECT * FROM users WHERE bm_player_id = ?').get(row.bm_player_id);
  if (!user) return { error: 'The account this link points at no longer exists.' };
  return { row, user };
}

// Read-only check so the page can say who it is for. Safe for link previews:
// it never consumes the token.
app.get('/api/auth/console/relink/check', authLimiter, (req, res) => {
  const { row, user, error } = loadRelinkToken(req.query.token);
  if (error) return res.status(400).json({ error });
  res.json({ ok: true, gamertag: user.gamertag, platform: user.platform, expiresAt: row.expires_at });
});

// Consume. POST on purpose: Discord and other clients follow GET links to build
// previews, which would burn a single-use token before the player ever clicked.
app.post('/api/auth/console/relink', authLimiter, (req, res) => {
  const { token } = req.body || {};
  const { row, user, error } = loadRelinkToken(typeof token === 'string' ? token : '');
  if (error) return res.status(400).json({ error });

  // Atomic claim. In the same transaction the account is handed over cleanly:
  // every email sign-in, session and outstanding link on it is retired
  // (webAuth.clearLoginForRelink), because whoever is already in may be the reason
  // staff issued the link. Keyed on steam_id, the row's primary key.
  const nowSec = Math.floor(Date.now() / 1000);
  const claimAndRetire = db.transaction(() => {
    const claimed = db.prepare(
      'UPDATE console_relink_tokens SET used_at = ?, used_note = ? WHERE token_hash = ? AND used_at IS NULL'
    ).run(nowSec, String(req.ip || '').slice(0, 64), row.token_hash);
    if (claimed.changes !== 1) return false;
    db.prepare('UPDATE users SET console_lock_gen = console_lock_gen + 1 WHERE steam_id = ?').run(user.steam_id);
    webAuth.clearLoginForRelink(db, user.steam_id, nowSec);
    return true;
  });
  if (!claimAndRetire()) {
    return res.status(400).json({ error: 'This link has already been used. Ask staff for a new one.' });
  }

  // Read back after the transaction: signing in with the old auth_gen would end
  // this session on its very next request.
  const fresh = db.prepare('SELECT * FROM users WHERE steam_id = ?').get(user.steam_id);
  req.login(fresh, { authMethod: 'relink' }, (err) => {
    if (err) {
      console.error('[console-relink] session error:', err.message);
      return res.status(500).json({ error: 'Could not sign you in. Ask staff for a new link.' });
    }
    // For the next hour this session may add email sign-in (webAuth.addLoginRefusal).
    req.session.relinkedAt = nowSec;
    console.log(`[console-relink] consumed for ${fresh.gamertag} (${fresh.platform}) from ${req.ip}`);
    res.json({
      ok: true,
      gamertag: fresh.gamertag,
      platform: fresh.platform,
      addEmailWithinMinutes: Math.round(webAuth.RELINK_ATTACH_WINDOW_S / 60)
    });
  });
});

// ---- FX rates ----
app.get('/api/shop/fx', async (req, res) => {
  const data = await fx.getRates();
  res.json(data);
});

// ---- Shop API routes ----
app.use(shopRoutes.router);

// ---- Economy KPI API (/admin/economy) ----
app.use(require('./routes/economy').router);

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

const statsFile = dataPath('radio-stats.json');
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
// What console sign-in searched first after the last poll, so a change is logged once.
let lastSignInScope = null;
// Per panel server: why its record is kept out of the sign-in scope (null = it is
// in), and when a record outside the organisation was last looked up again.
const signInRefusal = new Map();
const signInRetryAt = new Map();

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
    // ip/port come back on the same request, so the caller can confirm this
    // BattleMetrics record still belongs to the server we cached it for.
    // The owning organisation tells console sign-in whether this record is ours
    // (see pollServerStatus). Records outside it carry no organization relationship.
    const org = data?.data?.relationships?.organization?.data?.id;
    return { players: a.players ?? 0, max: a.maxPlayers ?? 0, ip: a.ip ?? null, port: a.port ?? null, orgId: org ? String(org) : null };
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
      // More than one record can sit at one address (BattleMetrics can create a
      // new record when a server moves). Prefer the one under our organisation:
      // console sign-in only trusts that one.
      const exacts = list.filter(s => s.attributes?.ip === rawIp && Number(s.attributes?.port) === portNum);
      const exact = exacts.find(s => String(s.relationships?.organization?.data?.id || '') === bmOrgId()) || exacts[0];
      if (exact?.id) return exact.id;
      // Fall back to IP-only ONLY when that IP hosts a single Reforger server.
      // Several of ours share a box (EU1/EU2/EU Dev on one IP), so an unqualified
      // IP match would hand this server a different one's BattleMetrics id — that
      // is how "eirys goonserver" ended up mirroring EU1's player count.
      const ipMatches = list.filter(s => s.attributes?.ip === rawIp);
      if (ipMatches.length === 1 && ipMatches[0].id) return ipMatches[0].id;
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
      // Only the official public game servers belong on the homepage. Match the
      // [EU1]/[EU2]/[NA1]/[NA2] tag POSITIVELY rather than blacklisting keywords:
      // the old "skip anything containing dev/.net/.com" let unrelated servers on
      // the same panel through — a Palworld server named "eirys goonserver" showed
      // up as a phantom entry. Dev builds are tagged "[EU Dev]"/"[NA Dev]" (no
      // digit after the region), so they stay excluded as before.
      if (!/\[(?:EU|NA)\d+\]/i.test(attr.name || '')) continue;

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
          console.log(`Resolved BattleMetrics ID for ${attr.name}: ${bmId}`);
        }
      }
      if (bmId) {
        let bm = await fetchBattleMetricsPlayers(bmId);
        // A cached id is only right until the server moves. When a server changes
        // allocation the old id keeps resolving happily to somebody else's server
        // -- that is how NA1 and NA2 both ended up reporting the NA Dev server's
        // player count. Confirm the record still matches this allocation, and
        // re-resolve once if it does not. Costs no extra request: the check uses
        // the ip/port already returned above.
        const wantIp = def?.attributes?.ip;
        const wantAlias = def?.attributes?.ip_alias;
        const wantPort = Number(def?.attributes?.port);
        // The panel can hold a bind address in ip and the public one in ip_alias;
        // BattleMetrics only ever sees the public one.
        const pointsElsewhere = (b) => !!(b && wantIp && b.ip && ((b.ip !== wantIp && b.ip !== wantAlias) || Number(b.port) !== wantPort));
        if (pointsElsewhere(bm)) {
          console.warn(`[bm] cached id ${bmId} for ${attr.name} points at ${bm.ip}:${bm.port}, expected ${wantIp}:${wantPort} — re-resolving`);
          bmIdCache.delete(id);
          // Proven not to be this server: out of the sign-in scope now, even if
          // the read of a replacement below fails.
          reforgedzServers.forgetBmId(id);
          const fresh = await resolveBattleMetricsId(wantIp, wantPort, attr.name);
          if (fresh && fresh !== bmId) {
            bmId = fresh;
            bmIdCache.set(id, bmId);
            console.log(`Re-resolved BattleMetrics ID for ${attr.name}: ${bmId}`);
            bm = await fetchBattleMetricsPlayers(bmId);
          }
        }
        if (bm) {
          players = bm.players;
          max = bm.max;
          // Console sign-in searches these records first and trusts a gamertag
          // found there without asking the organisation. So only a record at this
          // server's own address that BattleMetrics lists under our organisation
          // may join that scope: the tag fallback in resolveBattleMetricsId can
          // pick another community's "[EU1]". When BattleMetrics could not be read
          // (bm null) the scope is left as it was.
          let refused = null;
          if (pointsElsewhere(bm)) refused = `record ${bmId} is at ${bm.ip}:${bm.port}, not this server's address`;
          else if (String(bm.orgId || '') !== bmOrgId()) refused = `record ${bmId} is not under BattleMetrics organisation ${bmOrgId()}`;
          if (!refused) {
            reforgedzServers.setBmId(id, bmId);
          } else {
            reforgedzServers.forgetBmId(id);
            // A record at the right address but outside the organisation is never
            // corrected by the address check above. Look again every 10 minutes:
            // after a move, the organisation's own record can appear beside it.
            if (!pointsElsewhere(bm) && Date.now() - (signInRetryAt.get(id) || 0) > 10 * 60 * 1000) {
              signInRetryAt.set(id, Date.now());
              bmIdCache.delete(id);
            }
          }
          // Say why, once, whenever a server leaves or rejoins the scope.
          const was = signInRefusal.get(id) || null;
          if (refused !== was) {
            if (refused) console.warn(`[bm] ${attr.name} is not in the console sign-in scope: ${refused}`);
            else console.log(`[bm] ${attr.name} is back in the console sign-in scope (${bmId})`);
            signInRefusal.set(id, refused);
          }
        }
      }
      if (state !== 'running') {
        players = 0;
        if (max == null) max = 64;
      }

      statusList.push({ name: attr.name, identifier: id, region, state, ip, uptime: formatUptime(uptime), players, max });
    }

    // A server the panel no longer lists leaves the sign-in scope too.
    reforgedzServers.retainServers(statusList.map((s) => s.identifier));
    const signInScope = reforgedzServers.getBmIds().join(',');
    if (signInScope !== lastSignInScope) {
      console.log(`[bm] console sign-in searches ${signInScope ? `these server records first: ${signInScope}` : 'the organisation only (no verified server records yet)'}`);
      lastSignInScope = signInScope;
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

// Player account area: linked accounts, subscription health, purchase
// history. The page itself is public HTML -- everything on it comes from
// /api/shop/account/summary, which is requireAuth-gated and scoped to the
// session user, so a signed-out visitor just gets the sign-in prompt.
app.get('/account', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'account.html'));
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

app.get('/admin/console-relink', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-console-relink.html'));
});

app.get('/admin/saves', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-saves.html'));
});

app.get('/admin/economy', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-economy.html'));
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

// Nightly database snapshot, kept here and copied off the box (tools/backup.js).
// Lives in the app so there is no cron entry to forget on a new host.
try {
  require('./tools/backup').scheduleNightlyBackups();
} catch (e) {
  console.error('[backup] could not schedule:', e.message);
}
// The morning health card in #Payment-Processor (tools/healthReport.js): heals
// missing entitlement roles, runs the deep doctor, posts one embed.
try {
  require('./tools/healthReport').scheduleDailyHealth();
} catch (e) {
  console.error('[health] could not schedule:', e.message);
}

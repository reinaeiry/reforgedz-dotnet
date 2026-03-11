require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const db = require('./db');

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
    role: req.user.role
  });
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
    const headerBuf = Buffer.alloc(2048);
    fs.readSync(fd, headerBuf, 0, 2048, 0);

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
          const name = f.replace(/\.(mp3|wav)$/i, '')
            .replace(/[-_]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const mp3Meta = /\.mp3$/i.test(f) ? readMp3Meta(path.join(folderPath, f)) : { artist: '', duration: 0 };
          const fp = `/radio/${encodeURIComponent(folder.name)}/${encodeURIComponent(f)}`;
          const track = {
            title: name,
            artist: mp3Meta.artist || 'Modest',
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

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

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

    // Read MPEG frame header for duration estimate
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
          const filePath = `/radio/${encodeURIComponent(folder.name)}/${encodeURIComponent(f)}`;
          const track = {
            title: name,
            artist: mp3Meta.artist || 'Modest',
            duration: mp3Meta.duration,
            file: filePath,
            category: folder.name
          };
          trackMap[filePath] = track;
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

app.use(express.static(path.join(__dirname, 'public')));
app.use('/radio', express.static(path.join(__dirname, 'radio')));

app.get('/api/radio/tracks', (req, res) => {
  if (!trackCache) trackCache = loadAllTracks();
  res.json(trackCache.categories);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
    const ogTags = `
    <meta property="og:type" content="music.song">
    <meta property="og:title" content="${escHtml(track.title)} - ${escHtml(track.artist)}">
    <meta property="og:description" content="${escHtml(track.category)}${dur ? ' \u00b7 ' + dur : ''} | Modest AI Radio on ReforgedZ.net">
    <meta property="og:url" content="https://reforgedz.net/radio?track=${encodeURIComponent(trackFile)}">
    <meta property="og:site_name" content="Modest AI Radio">
    <meta property="og:audio" content="https://reforgedz.net${trackFile}">
    <meta property="og:audio:type" content="audio/mpeg">
    <meta name="theme-color" content="#cc1f1f">`;
    html = html.replace('</head>', ogTags + '\n  </head>');
  }

  res.send(html);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ReforgedZ.net running on port ${PORT}`);
});

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/radio', express.static(path.join(__dirname, 'radio')));

app.get('/api/radio/tracks', (req, res) => {
  const radioDir = path.join(__dirname, 'radio');
  const categories = {};

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
          return {
            title: name,
            file: `/radio/${encodeURIComponent(folder.name)}/${encodeURIComponent(f)}`,
            category: folder.name
          };
        });

      if (files.length > 0) {
        categories[folder.name] = files;
      }
    }

    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read radio directory' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ReforgedZ.net running on port ${PORT}`);
});

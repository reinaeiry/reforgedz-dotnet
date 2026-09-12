// Where the shop keeps the files it writes (database, sessions, uploads,
// backups, stats). Defaults to the app directory, which is how the Pterodactyl
// deployment has always run; a Docker deployment sets DATA_DIR to a mounted
// volume so the code and the data live apart. Everything that writes state
// goes through this so the two layouts never drift.
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;

function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts);
}

// mkdir -p for a directory under DATA_DIR. Returns the absolute path.
function ensureDataDir(...parts) {
  const p = dataPath(...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

module.exports = { DATA_DIR, APP_DIR: __dirname, dataPath, ensureDataDir };

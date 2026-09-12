// The commit this checkout is running. Read from .git without spawning git,
// so it works inside the Pterodactyl container and in Docker (where the image
// carries SHOP_VERSION instead of a .git directory).
const fs = require('fs');
const path = require('path');

function gitSha(appDir = path.join(__dirname, '..', '..')) {
  if (process.env.SHOP_VERSION) return String(process.env.SHOP_VERSION).slice(0, 40);
  try {
    const head = fs.readFileSync(path.join(appDir, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 40);
    const ref = head.slice(4).trim();
    const refFile = path.join(appDir, '.git', ref);
    if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf8').trim().slice(0, 40);
    const packed = fs.readFileSync(path.join(appDir, '.git', 'packed-refs'), 'utf8');
    const line = packed.split('\n').find(l => l.endsWith(' ' + ref));
    return line ? line.split(' ')[0].slice(0, 40) : null;
  } catch {
    return null;
  }
}

module.exports = { gitSha };

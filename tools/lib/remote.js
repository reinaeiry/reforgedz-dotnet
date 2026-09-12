// Talking to the game hosts from tools/: one SSH session to the entry host
// (EU), commands for NA wrapped in the nested hop exactly as sync.js does it.
// Adds the one thing sync.js never needed: streaming bytes to a remote file,
// used to put the nightly backup on the NA box.
const { sshOpen, sshRun, getPrivateKey, wrapForRegion, SSH_STRICT } = require('../../sync');
const { listServers } = require('../../gameServers');

function entryHost() {
  const servers = listServers();
  return servers.find(s => s.region === 'eu') || servers[0] || null;
}

function naHost() {
  return listServers().find(s => s.region === 'na') || null;
}

// Runs fn(conn) against the entry host and always closes the session.
async function withEntry(fn) {
  const key = getPrivateKey();
  if (!key) throw new Error('SSH_PRIVATE_KEY_B64 not set');
  const entry = entryHost();
  if (!entry) throw new Error('No game server configured (GAME_SERVER_EU_HOST / GAME_SERVER_EU_PATHS)');
  const conn = await sshOpen(key, entry.host, entry.port, entry.user);
  try {
    return await fn(conn, entry);
  } finally {
    try { conn.end(); } catch { /* already closed */ }
  }
}

// Like sshRun, but feeds `input` to the command's stdin. The nested NA form
// uses bash -c "$(...)" rather than sync.js's `| bash`, because a command read
// from a pipe would leave nothing on stdin for the payload.
function sshRunWithStdin(conn, command, input, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SSH command timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    conn.exec(command, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      let stdout = '';
      let stderr = '';
      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      stream.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`Exit ${code}: ${stderr.trim() || stdout.trim()}`));
      });
      stream.end(input);
    });
  });
}

function nestedForNa(innerCmd) {
  const na = naHost();
  if (!na) throw new Error('No NA host configured');
  const b64 = Buffer.from(innerCmd, 'utf8').toString('base64');
  return `ssh -o StrictHostKeyChecking=${SSH_STRICT} -o ConnectTimeout=10 -p ${na.port} ${na.user}@${na.host} 'bash -c "$(echo ${b64} | base64 -d)"'`;
}

// Shell-quote a path. Volume paths are pterodactyl-generated, but backup dirs
// come from .env, so quote rather than trust.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Write `buffer` to <dir>/<name> on the entry host (region 'eu') or the NA
// host (region 'na'), atomically, and return the remote sha256.
async function pushFile(conn, region, dir, name, buffer) {
  const target = `${dir.replace(/\/+$/, '')}/${name}`;
  const inner = `mkdir -p ${q(dir)} && cat > ${q(target + '.tmp')} && mv -f ${q(target + '.tmp')} ${q(target)} && sha256sum ${q(target)} | cut -d' ' -f1`;
  const cmd = region === 'na' ? nestedForNa(inner) : inner;
  const out = await sshRunWithStdin(conn, cmd, buffer);
  return out.trim();
}

// Delete files older than `days` matching `glob` in a remote dir; list what is left.
async function pruneRemote(conn, region, dir, glob, days) {
  const inner = `mkdir -p ${q(dir)} && find ${q(dir)} -maxdepth 1 -name ${q(glob)} -mtime +${Math.max(1, days | 0)} -delete; ls -1t ${q(dir)} 2>/dev/null | head -50`;
  const cmd = region === 'na' ? nestedForNa(inner) : inner;
  const out = await sshRun(conn, cmd, 60000);
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

// Newest matching file in a remote dir: { name, mtime } or null.
async function newestRemote(conn, region, dir, glob) {
  const inner = `ls -1t ${q(dir)}/${glob} 2>/dev/null | head -1 | xargs -r stat -c '%n %Y'`;
  const cmd = region === 'na' ? nestedForNa(inner) : inner;
  const out = (await sshRun(conn, cmd, 60000)).trim();
  if (!out) return null;
  const sp = out.lastIndexOf(' ');
  return { name: out.slice(0, sp).split('/').pop(), mtime: new Date(parseInt(out.slice(sp + 1), 10) * 1000) };
}

// Read a remote file as a Buffer (base64 over the channel, so binary-safe).
async function readRemoteFile(conn, server, remotePath) {
  const inner = `cat ${q(remotePath)} | base64 -w0`;
  const out = await sshRun(conn, wrapForRegion(server, inner), 60000);
  return Buffer.from(out.trim(), 'base64');
}

// One round trip per server: does the shop path exist, do config.json and
// purchases.json exist, and when was purchases.json last written.
async function probeServerPaths(conn, server) {
  const inner = [
    `test -d ${q(server.path)} && echo DIR=1 || echo DIR=0`,
    `test -f ${q(server.configPath)} && echo CFG=1 || echo CFG=0`,
    `test -f ${q(server.path + '/purchases.json')} && echo PUR=$(stat -c %Y ${q(server.path + '/purchases.json')}) || echo PUR=0`
  ].join('; ');
  const out = await sshRun(conn, wrapForRegion(server, inner), 30000);
  const kv = Object.fromEntries(out.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split('=')));
  return { dir: kv.DIR === '1', config: kv.CFG === '1', purchasesMtime: kv.PUR && kv.PUR !== '0' ? new Date(parseInt(kv.PUR, 10) * 1000) : null };
}

module.exports = { withEntry, entryHost, naHost, sshRunWithStdin, pushFile, pruneRemote, newestRemote, readRemoteFile, probeServerPaths };

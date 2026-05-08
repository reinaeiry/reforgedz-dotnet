const { Client } = require('ssh2');
const db = require('./db');
const { listServers, SERVER_IDS } = require('./gameServers');

function getPrivateKey() {
  const b64 = process.env.SSH_PRIVATE_KEY_B64;
  if (b64) return Buffer.from(b64, 'base64');
  console.error('[sync] SSH_PRIVATE_KEY_B64 not set in .env');
  return null;
}

function sshExec(privateKey, host, port, username, command) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error('SSH timed out after 30s'));
    }, 30000);

    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timeout); conn.end(); return reject(err); }
        let stderr = '';
        stream.on('close', (code) => {
          clearTimeout(timeout);
          conn.end();
          if (code === 0) resolve();
          else reject(new Error(`Exit code ${code}: ${stderr}`));
        });
        stream.stderr.on('data', (d) => { stderr += d.toString(); });
      });
    });
    conn.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    conn.connect({
      host, port, username, privateKey,
      readyTimeout: 10000,
      hostVerifier: () => true
    });
  });
}

function buildPerServerBuckets() {
  const rows = db.prepare(`
    SELECT
      COALESCE(u.gamertag, u.persona) AS name,
      u.bi_uid AS guid,
      p.title AS item,
      p.server_specific AS server_specific,
      o.server_id AS server_id
    FROM orders o
    JOIN users u ON o.steam_id = u.steam_id
    JOIN products p ON o.product_id = p.id
    WHERE o.status = 'completed' AND u.bi_uid IS NOT NULL AND u.bi_uid != ''
  `).all();

  const buckets = Object.fromEntries(SERVER_IDS.map(id => [id, []]));

  for (const r of rows) {
    const entry = { name: r.name, guid: r.guid, item: r.item };
    if (!r.server_specific) {
      for (const id of SERVER_IDS) buckets[id].push(entry);
    } else if (r.server_id && buckets[r.server_id]) {
      buckets[r.server_id].push(entry);
    }
  }

  // Dedupe within each bucket on (guid|item) — a global + server-specific item
  // with the same title shouldn't appear twice on the same server's JSON.
  for (const id of SERVER_IDS) {
    const seen = new Set();
    buckets[id] = buckets[id].filter(e => {
      const k = `${e.guid}|${e.item}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  return buckets;
}

function buildWriteCommandForServer(server, json) {
  const b64 = Buffer.from(json).toString('base64');
  const remotePath = server.path + '/purchases.json';
  return `mkdir -p '${server.path}' && echo '${b64}' | base64 -d > '${remotePath}' && echo '[sync] ${server.id} OK'`;
}

async function syncPurchasesToServers() {
  const servers = listServers();
  if (servers.length === 0) {
    console.log('[sync] No game servers configured (check GAME_SERVER_EU_PATHS / GAME_SERVER_NA_PATHS)');
    return;
  }

  const buckets = buildPerServerBuckets();
  const totals = SERVER_IDS.map(id => `${id}=${(buckets[id] || []).length}`).join(' ');
  console.log(`[sync] entries per server: ${totals}`);

  const privateKey = getPrivateKey();
  if (!privateKey) return;

  // EU servers — write directly on the EU host
  const euServers = servers.filter(s => s.region === 'eu');
  const naServers = servers.filter(s => s.region === 'na');

  const euCmds = euServers.map(s =>
    buildWriteCommandForServer(s, JSON.stringify(buckets[s.id], null, 2))
  );

  // NA servers — nested SSH from EU host to NA host (single nested session,
  // matches the existing pattern that avoids opening NA SSH from this app's host)
  let naCmd = null;
  if (naServers.length > 0) {
    const naInner = naServers
      .map(s => buildWriteCommandForServer(s, JSON.stringify(buckets[s.id], null, 2)))
      .join(' ; ');
    const na = naServers[0]; // host/port/user are shared across NA servers
    naCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${na.port} ${na.user}@${na.host} "${naInner}"`;
  }

  const eu = euServers[0] || null;
  if (!eu) {
    console.log('[sync] No EU server configured to drive sync from — aborting');
    return;
  }

  const fullCmd = [...euCmds, naCmd].filter(Boolean).join(' ; ');

  try {
    await sshExec(privateKey, eu.host, eu.port, eu.user, fullCmd);
    console.log('[sync] All paths synced OK');
  } catch (e) {
    console.error('[sync] Sync failed:', e.message);
  }
}

module.exports = { syncPurchasesToServers };

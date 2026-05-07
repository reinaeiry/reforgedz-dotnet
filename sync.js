const { Client } = require('ssh2');
const db = require('./db');

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

async function syncPurchasesToServers() {
  const rows = db.prepare(`
    SELECT DISTINCT
      COALESCE(u.gamertag, u.persona) AS name,
      u.bi_uid AS guid,
      p.title AS item
    FROM orders o
    JOIN users u ON o.steam_id = u.steam_id
    JOIN products p ON o.product_id = p.id
    WHERE o.status = 'completed' AND u.bi_uid IS NOT NULL AND u.bi_uid != ''
  `).all();

  console.log(`[sync] ${rows.length} purchase(s) to sync`);

  const privateKey = getPrivateKey();
  if (!privateKey) return;

  const json = JSON.stringify(rows, null, 2);
  const jsonB64 = Buffer.from(json).toString('base64');

  const euHost = process.env.GAME_SERVER_EU_HOST;
  const euPort = parseInt(process.env.GAME_SERVER_EU_PORT) || 22;
  const euUser = process.env.GAME_SERVER_EU_USER || 'root';

  if (!euHost) {
    console.log('[sync] GAME_SERVER_EU_HOST not set, skipping');
    return;
  }

  // Build ONE command that writes to all paths in a single SSH session
  const parts = [];

  // EU paths — write directly on the EU host
  const euPaths = (process.env.GAME_SERVER_EU_PATHS || '').split(',').filter(Boolean);
  for (const basePath of euPaths) {
    const remotePath = basePath + '/purchases.json';
    parts.push(`mkdir -p '${basePath}' && echo '${jsonB64}' | base64 -d > '${remotePath}' && echo '[sync] EU:${basePath.split('/').pop()} OK'`);
  }

  // NA paths — nested SSH from EU host to NA host
  const naHost = process.env.GAME_SERVER_NA_HOST;
  if (naHost) {
    const naPort = parseInt(process.env.GAME_SERVER_NA_PORT) || 22;
    const naUser = process.env.GAME_SERVER_NA_USER || 'root';
    const naPaths = (process.env.GAME_SERVER_NA_PATHS || '').split(',').filter(Boolean);

    // Build one nested SSH command that writes all NA paths at once
    const naParts = [];
    for (const basePath of naPaths) {
      const remotePath = basePath + '/purchases.json';
      naParts.push(`mkdir -p '${basePath}' && echo '${jsonB64}' | base64 -d > '${remotePath}' && echo '[sync] NA:${basePath.split('/').pop()} OK'`);
    }
    if (naParts.length > 0) {
      const naCmd = naParts.join(' ; ');
      parts.push(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${naPort} ${naUser}@${naHost} "${naCmd}"`);
    }
  }

  const fullCmd = parts.join(' ; ');
  console.log(`[sync] Syncing ${euPaths.length} EU + ${(process.env.GAME_SERVER_NA_PATHS || '').split(',').filter(Boolean).length} NA paths in 1 SSH session`);

  try {
    await sshExec(privateKey, euHost, euPort, euUser, fullCmd);
    console.log('[sync] All paths synced OK');
  } catch (e) {
    console.error('[sync] Sync failed:', e.message);
  }
}

module.exports = { syncPurchasesToServers };

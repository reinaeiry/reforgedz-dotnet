const { Client } = require('ssh2');
const db = require('./db');

function getPrivateKey() {
  const b64 = process.env.SSH_PRIVATE_KEY_B64;
  if (b64) {
    console.log('[sync] SSH key loaded from env');
    return Buffer.from(b64, 'base64');
  }
  console.error('[sync] SSH_PRIVATE_KEY_B64 not set in .env');
  return null;
}

function sshExec(privateKey, host, port, username, command) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error('SSH timed out after 15s'));
    }, 15000);

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
    SELECT DISTINCT u.persona as name, u.bi_uid as guid, p.title as item
    FROM orders o
    JOIN users u ON o.steam_id = u.steam_id
    JOIN products p ON o.product_id = p.id
    WHERE o.status = 'completed' AND u.bi_uid IS NOT NULL AND u.bi_uid != ''
  `).all();

  console.log(`[sync] ${rows.length} purchase(s) to sync`);

  const privateKey = getPrivateKey();
  if (!privateKey) return;

  const json = JSON.stringify(rows, null, 2);

  // EU host — we SSH here for everything (container can only reach EU host)
  const euHost = process.env.GAME_SERVER_EU_HOST;
  const euPort = parseInt(process.env.GAME_SERVER_EU_PORT) || 22;
  const euUser = process.env.GAME_SERVER_EU_USER || 'root';

  if (!euHost) {
    console.log('[sync] GAME_SERVER_EU_HOST not set, skipping');
    return;
  }

  // Build all commands to run on the EU host in one SSH session
  const commands = [];

  // EU local paths — write directly on the EU host
  const euPaths = (process.env.GAME_SERVER_EU_PATHS || '').split(',').filter(Boolean);
  for (const basePath of euPaths) {
    const remotePath = basePath + '/purchases.json';
    commands.push({ name: `EU:${remotePath}`, cmd: `mkdir -p '${basePath}' && cat > '${remotePath}' << 'PURCHASES_EOF'\n${json}\nPURCHASES_EOF` });
  }

  // NA paths — SSH from EU host to NA host
  const naHost = process.env.GAME_SERVER_NA_HOST;
  if (naHost) {
    const naPort = parseInt(process.env.GAME_SERVER_NA_PORT) || 22;
    const naUser = process.env.GAME_SERVER_NA_USER || 'root';
    const naPaths = (process.env.GAME_SERVER_NA_PATHS || '').split(',').filter(Boolean);
    for (const basePath of naPaths) {
      const remotePath = basePath + '/purchases.json';
      const innerCmd = `mkdir -p '${basePath}' && cat > '${remotePath}' << 'PURCHASES_EOF'\n${json}\nPURCHASES_EOF`;
      // Wrap in ssh command that runs on EU host, forwarding to NA
      commands.push({
        name: `NA:${remotePath}`,
        cmd: `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${naPort} ${naUser}@${naHost} '${innerCmd.replace(/'/g, "'\\''")}'`
      });
    }
  }

  console.log(`[sync] ${commands.length} path(s) to sync via ${euHost}`);

  // Execute each command via SSH to EU host
  for (const { name, cmd } of commands) {
    try {
      await sshExec(privateKey, euHost, euPort, euUser, cmd);
      console.log(`[sync] ${name} OK`);
    } catch (e) {
      console.error(`[sync] ${name} FAILED:`, e.message);
    }
  }
}

module.exports = { syncPurchasesToServers };

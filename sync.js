const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const db = require('./db');

function getPrivateKey() {
  // Load SSH key from base64 env var (works inside Pterodactyl containers)
  const b64 = process.env.SSH_PRIVATE_KEY_B64;
  if (b64) {
    console.log('[sync] SSH key loaded from env');
    return Buffer.from(b64, 'base64');
  }
  console.error('[sync] SSH_PRIVATE_KEY_B64 not set in .env');
  return null;
}

function getServerConfigs() {
  const servers = [];

  const euHost = process.env.GAME_SERVER_EU_HOST;
  if (euHost) {
    const euPaths = (process.env.GAME_SERVER_EU_PATHS || '').split(',').filter(Boolean);
    if (euPaths.length > 0) {
      servers.push({
        name: 'EU',
        host: euHost,
        port: parseInt(process.env.GAME_SERVER_EU_PORT) || 22,
        username: process.env.GAME_SERVER_EU_USER || 'root',
        paths: euPaths
      });
    }
  }

  const naHost = process.env.GAME_SERVER_NA_HOST;
  if (naHost) {
    const naPaths = (process.env.GAME_SERVER_NA_PATHS || '').split(',').filter(Boolean);
    if (naPaths.length > 0) {
      servers.push({
        name: 'NA',
        host: naHost,
        port: parseInt(process.env.GAME_SERVER_NA_PORT) || 22,
        username: process.env.GAME_SERVER_NA_USER || 'root',
        paths: naPaths
      });
    }
  }

  return servers;
}

function sshExec(privateKey, config, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        let stderr = '';
        stream.on('close', (code) => {
          conn.end();
          if (code === 0) resolve();
          else reject(new Error(`Exit code ${code}: ${stderr}`));
        });
        stream.stderr.on('data', (d) => { stderr += d.toString(); });
      });
    });
    conn.on('error', reject);
    conn.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey: privateKey
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
  const servers = getServerConfigs();
  console.log(`[sync] ${servers.length} server(s) configured:`, servers.map(s => `${s.name}(${s.host})`).join(', '));

  if (servers.length === 0) {
    console.log('[sync] No game servers configured, skipping');
    return;
  }

  const privateKey = getPrivateKey();
  if (!privateKey) return;

  const json = JSON.stringify(rows, null, 2);

  for (const server of servers) {
    for (const basePath of server.paths) {
      const remotePath = basePath + '/purchases.json';
      try {
        const cmd = `mkdir -p '${basePath}' && cat > '${remotePath}' << 'PURCHASES_EOF'\n${json}\nPURCHASES_EOF`;
        await sshExec(privateKey, server, cmd);
        console.log(`[sync] ${server.name}: written ${remotePath}`);
      } catch (e) {
        console.error(`[sync] ${server.name} failed ${remotePath}:`, e.message);
      }
    }
  }
}

module.exports = { syncPurchasesToServers };

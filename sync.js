const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const db = require('./db');

// Default SSH key path — inside the Pterodactyl container's persistent storage
const DEFAULT_KEY_PATH = '/home/container/ssh_keys/id_ed25519';

function getServerConfigs() {
  const servers = [];

  // EU — SSH to host machine (app runs in a Pterodactyl container, can't write host paths directly)
  const euHost = process.env.GAME_SERVER_EU_HOST;
  if (euHost) {
    const euPaths = (process.env.GAME_SERVER_EU_PATHS || '').split(',').filter(Boolean);
    if (euPaths.length > 0) {
      servers.push({
        type: 'ssh',
        name: 'EU',
        host: euHost,
        port: parseInt(process.env.GAME_SERVER_EU_PORT) || 22,
        username: process.env.GAME_SERVER_EU_USER || 'root',
        privateKeyPath: process.env.GAME_SERVER_EU_KEY_PATH || undefined,
        paths: euPaths
      });
    }
  }

  // NA — SSH to remote host
  const naHost = process.env.GAME_SERVER_NA_HOST;
  if (naHost) {
    const naPaths = (process.env.GAME_SERVER_NA_PATHS || '').split(',').filter(Boolean);
    if (naPaths.length > 0) {
      servers.push({
        type: 'ssh',
        name: 'NA',
        host: naHost,
        port: parseInt(process.env.GAME_SERVER_NA_PORT) || 22,
        username: process.env.GAME_SERVER_NA_USER || 'root',
        privateKeyPath: process.env.GAME_SERVER_NA_KEY_PATH || undefined,
        paths: naPaths
      });
    }
  }

  return servers;
}

function sshExec(config, command) {
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

    const connectOpts = {
      host: config.host,
      port: config.port,
      username: config.username
    };

    // Try explicit key path, then default container key path
    const keyPaths = [
      config.privateKeyPath,
      DEFAULT_KEY_PATH
    ].filter(Boolean);

    let keyLoaded = false;
    for (const keyPath of keyPaths) {
      try {
        connectOpts.privateKey = fs.readFileSync(keyPath);
        keyLoaded = true;
        console.log(`[sync] Using SSH key: ${keyPath}`);
        break;
      } catch (e) { /* try next */ }
    }

    if (!keyLoaded) {
      console.error(`[sync] No SSH key found for ${config.host} (tried: ${keyPaths.join(', ')})`);
    }

    conn.connect(connectOpts);
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
  const json = JSON.stringify(rows, null, 2);
  const servers = getServerConfigs();
  console.log(`[sync] ${servers.length} server(s) configured:`, servers.map(s => `${s.name}(${s.host})`).join(', '));

  if (servers.length === 0) {
    console.log('[sync] No game servers configured, skipping');
    return;
  }

  for (const server of servers) {
    for (const basePath of server.paths) {
      const remotePath = basePath + '/purchases.json';
      try {
        const cmd = `mkdir -p '${basePath}' && cat > '${remotePath}' << 'PURCHASES_EOF'\n${json}\nPURCHASES_EOF`;
        await sshExec(server, cmd);
        console.log(`[sync] ${server.name}: written ${remotePath}`);
      } catch (e) {
        console.error(`[sync] ${server.name} failed ${remotePath}:`, e.message);
      }
    }
  }
}

module.exports = { syncPurchasesToServers };

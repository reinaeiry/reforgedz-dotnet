const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const db = require('./db');

function getServerConfigs() {
  const servers = [];

  // EU paths are LOCAL (reforgedz-dotnet runs on EU box)
  const euPaths = (process.env.GAME_SERVER_EU_PATHS || '').split(',').filter(Boolean);
  if (euPaths.length > 0) {
    servers.push({ type: 'local', paths: euPaths });
  }

  // NA paths need SSH
  const naHost = process.env.GAME_SERVER_NA_HOST;
  if (naHost) {
    const naPaths = (process.env.GAME_SERVER_NA_PATHS || '').split(',').filter(Boolean);
    if (naPaths.length > 0) {
      servers.push({
        type: 'ssh',
        host: naHost,
        port: parseInt(process.env.GAME_SERVER_NA_PORT) || 22,
        username: process.env.GAME_SERVER_NA_USER || 'root',
        password: process.env.GAME_SERVER_NA_PASSWORD || undefined,
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

    if (config.privateKeyPath) {
      try {
        connectOpts.privateKey = fs.readFileSync(config.privateKeyPath);
      } catch (e) {
        return reject(new Error(`Cannot read SSH key: ${config.privateKeyPath}`));
      }
    } else if (config.password) {
      connectOpts.password = config.password;
    } else {
      // Try default SSH key locations
      const defaultKeys = [
        path.join(process.env.HOME || '/root', '.ssh', 'id_rsa'),
        path.join(process.env.HOME || '/root', '.ssh', 'id_ed25519')
      ];
      for (const keyPath of defaultKeys) {
        try {
          connectOpts.privateKey = fs.readFileSync(keyPath);
          break;
        } catch (e) { /* try next */ }
      }
    }

    conn.connect(connectOpts);
  });
}

function writeLocal(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

async function syncPurchasesToServers() {
  const rows = db.prepare(`
    SELECT DISTINCT u.persona as name, u.bi_uid as guid, p.title as item
    FROM orders o
    JOIN users u ON o.steam_id = u.steam_id
    JOIN products p ON o.product_id = p.id
    WHERE o.status = 'completed' AND u.bi_uid IS NOT NULL AND u.bi_uid != ''
  `).all();

  const json = JSON.stringify(rows, null, 2);
  const servers = getServerConfigs();

  if (servers.length === 0) {
    console.log('[sync] No game servers configured, skipping');
    return;
  }

  for (const server of servers) {
    if (server.type === 'local') {
      // EU — write directly to filesystem
      for (const basePath of server.paths) {
        const filePath = basePath + '/purchases.json';
        try {
          writeLocal(filePath, json);
          console.log(`[sync] Written locally: ${filePath}`);
        } catch (e) {
          console.error(`[sync] Local write failed ${filePath}:`, e.message);
        }
      }
    } else {
      // NA — write via SSH
      for (const basePath of server.paths) {
        const remotePath = basePath + '/purchases.json';
        try {
          const cmd = `mkdir -p '${basePath}' && cat > '${remotePath}' << 'PURCHASES_EOF'\n${json}\nPURCHASES_EOF`;
          await sshExec(server, cmd);
          console.log(`[sync] Uploaded to ${server.host}:${remotePath}`);
        } catch (e) {
          console.error(`[sync] SSH failed ${server.host}:${remotePath}:`, e.message);
        }
      }
    }
  }
}

module.exports = { syncPurchasesToServers };

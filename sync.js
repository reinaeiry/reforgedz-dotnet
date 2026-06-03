const { Client } = require('ssh2');
const db = require('./db');
const { listServers, SERVER_IDS } = require('./gameServers');

function getPrivateKey() {
  const b64 = process.env.SSH_PRIVATE_KEY_B64;
  if (b64) return Buffer.from(b64, 'base64');
  console.error('[sync] SSH_PRIVATE_KEY_B64 not set in .env');
  return null;
}

function sshOpen(privateKey, host, port, username) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error('SSH connect timed out after 15s'));
    }, 15000);
    conn.on('ready', () => { clearTimeout(timeout); resolve(conn); });
    conn.on('error', (err) => { clearTimeout(timeout); reject(err); });
    conn.connect({
      host, port, username, privateKey,
      readyTimeout: 10000,
      hostVerifier: () => true
    });
  });
}

function sshRun(conn, command) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('SSH command timed out after 30s')), 30000);
    conn.exec(command, (err, stream) => {
      if (err) { clearTimeout(timeout); return reject(err); }
      let stdout = '';
      let stderr = '';
      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      stream.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve(stdout);
        else reject(new Error(`Exit ${code}: ${stderr.trim() || stdout.trim()}`));
      });
    });
  });
}

function buildPerServerPurchaseBuckets() {
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

  // Manual priority-queue grants need to land in purchases.json too — otherwise
  // the game-side mod (which reads purchases.json) won't know about them.
  // Use the canonical title of an active priority-queue-granting product so it
  // matches whatever the mod expects; fall back to the literal "Priority Queue".
  const pqProduct = db.prepare(`
    SELECT title FROM products WHERE grants_priority_queue = 1 AND active = 1 ORDER BY created_at DESC LIMIT 1
  `).get();
  const pqItemTitle = (pqProduct && pqProduct.title) || 'Priority Queue';

  const manualGrants = db.prepare(`SELECT guid, server_id, display_name FROM priority_queue_grants`).all();

  const buckets = Object.fromEntries(SERVER_IDS.map(id => [id, []]));

  for (const r of rows) {
    const entry = { name: r.name, guid: r.guid, item: r.item };
    if (!r.server_specific) {
      for (const id of SERVER_IDS) buckets[id].push(entry);
    } else if (r.server_id && buckets[r.server_id]) {
      buckets[r.server_id].push(entry);
    }
  }

  for (const g of manualGrants) {
    if (!g.guid || !buckets[g.server_id]) continue;
    buckets[g.server_id].push({
      name: g.display_name || '',
      guid: g.guid,
      item: pqItemTitle
    });
  }

  // Dedupe per bucket on (guid|item) — keeps the first occurrence, so a
  // purchase entry's `name` (which comes from the user's persona/gamertag)
  // wins over a manual grant's display_name if both exist for the same guid.
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

// Build the set of GUIDs that should sit in each server's game.admins
// array as a result of priority-queue entitlements (purchases or manual grants).
function buildPriorityQueueGuidsPerServer() {
  const orderRows = db.prepare(`
    SELECT
      u.bi_uid AS guid,
      p.server_specific,
      o.server_id
    FROM orders o
    JOIN users u ON o.steam_id = u.steam_id
    JOIN products p ON o.product_id = p.id
    WHERE o.status = 'completed'
      AND p.grants_priority_queue = 1
      AND u.bi_uid IS NOT NULL AND u.bi_uid != ''
      AND (o.effective_until IS NULL OR o.effective_until > unixepoch())
  `).all();

  const manualRows = db.prepare(`SELECT guid, server_id FROM priority_queue_grants`).all();

  const out = Object.fromEntries(SERVER_IDS.map(id => [id, new Set()]));

  for (const r of orderRows) {
    if (!r.server_specific) {
      for (const id of SERVER_IDS) out[id].add(r.guid);
    } else if (r.server_id && out[r.server_id]) {
      out[r.server_id].add(r.guid);
    }
  }

  for (const r of manualRows) {
    if (out[r.server_id]) out[r.server_id].add(r.guid);
  }

  return out;
}

function buildWritePurchasesCmd(server, json) {
  const b64 = Buffer.from(json).toString('base64');
  const remotePath = server.path + '/purchases.json';
  return `mkdir -p '${server.path}' && echo '${b64}' | base64 -d > '${remotePath}' && echo '[sync] ${server.id} OK'`;
}

function wrapForRegion(server, innerCmd) {
  // EU servers we hit directly from the entry SSH session (which connects to EU host).
  // NA servers we reach via a nested SSH from the EU host to the NA host.
  if (server.region === 'eu') return innerCmd;
  // Base64-encode the inner command so nothing inside it can break out of the
  // outer SSH quoting. The remote shell decodes and pipes to bash. Single-quote
  // wrapping is safe because base64 alphabet is [A-Za-z0-9+/=] only.
  const innerB64 = Buffer.from(innerCmd, 'utf8').toString('base64');
  return `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${server.port} ${server.user}@${server.host} 'echo ${innerB64} | base64 -d | bash'`;
}

async function patchServerAdmins(conn, server, desiredGuids) {
  if (!server.configPath) {
    console.log(`[admins-sync] ${server.id} no configPath, skipping`);
    return;
  }

  // 1) Read current config.json (base64-encoded over SSH)
  const readInner = `cat '${server.configPath}' | base64 -w0`;
  let b64Content;
  try {
    b64Content = (await sshRun(conn, wrapForRegion(server, readInner))).trim();
  } catch (e) {
    console.error(`[admins-sync] ${server.id} read failed:`, e.message);
    return;
  }
  if (!b64Content) {
    console.error(`[admins-sync] ${server.id} config.json empty or missing`);
    return;
  }

  let config;
  try {
    config = JSON.parse(Buffer.from(b64Content, 'base64').toString('utf8'));
  } catch (e) {
    console.error(`[admins-sync] ${server.id} config.json parse failed:`, e.message);
    return;
  }

  if (!config.game || typeof config.game !== 'object') config.game = {};
  const currentAdmins = Array.isArray(config.game.admins) ? config.game.admins.slice() : [];

  // 2) Look up the GUIDs WE put there last time
  const prevRow = db.prepare('SELECT previously_owned_json FROM config_admin_sync_state WHERE server_id = ?').get(server.id);
  let previouslyOwned;
  try {
    previouslyOwned = new Set(prevRow ? JSON.parse(prevRow.previously_owned_json) : []);
  } catch {
    previouslyOwned = new Set();
  }

  // Record the non-shop (GM/owner) admin count so the shop can cap priority
  // queue at (ceiling - GMs) and never push game.admins past the limit. Stored
  // every sync, including the no-op case handled below.
  const nonShopAdminCount = currentAdmins.filter(g => !previouslyOwned.has(g)).length;
  db.prepare(`
    INSERT INTO config_admin_sync_state (server_id, non_shop_admin_count, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(server_id) DO UPDATE SET
      non_shop_admin_count = excluded.non_shop_admin_count,
      updated_at = excluded.updated_at
  `).run(server.id, nonShopAdminCount);

  // 3) Compute new array: strip OUR previously-owned entries that are no longer
  //    desired, then add OUR currently-desired entries. Entries from the GM tab
  //    (or anything else) live untouched in `currentAdmins`.
  const newAdmins = currentAdmins.filter(g => !previouslyOwned.has(g));
  for (const g of desiredGuids) {
    if (g && !newAdmins.includes(g)) newAdmins.push(g);
  }

  // 4) No-op if nothing actually changed
  const sameSet = newAdmins.length === currentAdmins.length
    && newAdmins.every(g => currentAdmins.includes(g));
  const prevMatches = previouslyOwned.size === desiredGuids.size
    && [...desiredGuids].every(g => previouslyOwned.has(g));
  if (sameSet && prevMatches) {
    return;
  }

  // 5) Write back
  config.game.admins = newAdmins;
  const newJson = JSON.stringify(config, null, 2);
  const newB64 = Buffer.from(newJson).toString('base64');
  const writeInner = `echo '${newB64}' | base64 -d > '${server.configPath}'`;
  try {
    await sshRun(conn, wrapForRegion(server, writeInner));
  } catch (e) {
    console.error(`[admins-sync] ${server.id} write failed:`, e.message);
    return;
  }

  // 6) Update our tracking
  db.prepare(`
    INSERT INTO config_admin_sync_state (server_id, previously_owned_json, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(server_id) DO UPDATE SET
      previously_owned_json = excluded.previously_owned_json,
      updated_at = excluded.updated_at
  `).run(server.id, JSON.stringify([...desiredGuids]));

  console.log(`[admins-sync] ${server.id} game.admins ${currentAdmins.length} -> ${newAdmins.length} (shop-owned: ${desiredGuids.size})`);
}

async function syncPurchasesToServers() {
  const servers = listServers();
  if (servers.length === 0) {
    console.log('[sync] No game servers configured');
    return;
  }

  const buckets = buildPerServerPurchaseBuckets();
  const pqGuids = buildPriorityQueueGuidsPerServer();

  const totals = SERVER_IDS.map(id => `${id}=${(buckets[id] || []).length}/pq=${(pqGuids[id] || new Set()).size}`).join(' ');
  console.log(`[sync] ${totals}`);

  const privateKey = getPrivateKey();
  if (!privateKey) return;

  const entryHost = servers.find(s => s.region === 'eu') || servers[0];
  if (!entryHost) return;

  let conn;
  try {
    conn = await sshOpen(privateKey, entryHost.host, entryHost.port, entryHost.user);
  } catch (e) {
    console.error('[sync] SSH connect failed:', e.message);
    return;
  }

  try {
    // 1) Write purchases.json — single combined shell command, matches old behaviour
    const purchaseCmds = servers.map(s => wrapForRegion(s, buildWritePurchasesCmd(s, JSON.stringify(buckets[s.id], null, 2))));
    try {
      await sshRun(conn, purchaseCmds.join(' ; '));
      console.log('[sync] purchases.json synced');
    } catch (e) {
      console.error('[sync] purchases.json failed:', e.message);
    }

    // 2) Patch each server's game.admins additively
    for (const server of servers) {
      try {
        await patchServerAdmins(conn, server, pqGuids[server.id] || new Set());
      } catch (e) {
        console.error(`[admins-sync] ${server.id} unhandled:`, e.message);
      }
    }
  } finally {
    conn.end();
  }
}

module.exports = { syncPurchasesToServers, buildPriorityQueueGuidsPerServer };

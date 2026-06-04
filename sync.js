const { Client } = require('ssh2');
const db = require('./db');
const { listServers, SERVER_IDS, saveGamePathFromShopPath } = require('./gameServers');

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

// Walk a parsed record and collect the JSON paths where a string value contains
// the query — i.e. *why* grep matched this file.
function findMatchPaths(obj, query, base, out, depth) {
  if (obj == null || depth > 14 || out.length > 8) return;
  if (typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const path = base ? base + '.' + k : k;
    if (typeof v === 'string') {
      if (v.includes(query)) out.push({ path, key: k });
    } else if (typeof v === 'object') {
      findMatchPaths(v, query, path, out, depth + 1);
    }
  }
}

// Friendly label for how the searched value relates to a record.
function deriveMatchRole(data, query, paths) {
  if (data && data.id === query) return 'This record (own id)';
  const keys = paths.map(p => p.key);
  if (keys.includes('uid')) return 'This player (own uid)';
  if (keys.includes('lastKillerUID')) return 'Killed by — this UID is the killer';
  if (keys.includes('playerEntity')) return 'Character pointer';
  if (keys.some(k => /owner|admin|member|authoriz|builder|buddy|team|grant/i.test(k))) return 'Owner / member reference';
  if (paths.length) return 'Referenced in: ' + paths[0].path;
  return 'Match';
}

// Freetext search of a server's persistence save files (one JSON per entity).
// Greps over SSH (honouring the NA/eu3 hop) for an exact string and returns the
// matching records, parsed. The query is base64-encoded and matched with
// `grep -F -- "$Q"`, so it can never break the shell or be read as an option.
async function searchSaveFiles(serverId, query, limit = 50) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return { results: [], total: 0, shown: 0 };

  const servers = listServers();
  const server = servers.find(s => s.id === serverId);
  if (!server) throw new Error('Unknown server');
  const saveBase = server.savePath || saveGamePathFromShopPath(server.path);
  if (!saveBase) throw new Error('No save path for this server');

  const privateKey = getPrivateKey();
  if (!privateKey) throw new Error('SSH key not configured');
  const entryHost = servers.find(s => s.region === 'eu') || servers[0];
  if (!entryHost) throw new Error('No entry host');

  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const qb64 = Buffer.from(q, 'utf8').toString('base64');
  const inner = [
    `SB='${saveBase}'`,
    `Q=$(printf %s '${qb64}' | base64 -d)`,
    `[ -d "$SB" ] || { echo "COUNT:0"; exit 0; }`,
    `echo "COUNT:$(grep -rlF --include='*.json' -- "$Q" "$SB" 2>/dev/null | grep -v '/playthrough' | wc -l)"`,
    `grep -rlF --include='*.json' -- "$Q" "$SB" 2>/dev/null | grep -v '/playthrough' | head -${cap} | while IFS= read -r f; do echo "FILE:$f:$(base64 -w0 "$f")"; done`,
  ].join('; ');
  const cmd = wrapForRegion(server, inner);

  const conn = await sshOpen(privateKey, entryHost.host, entryHost.port, entryHost.user);
  let out;
  try {
    out = await sshRun(conn, cmd);
  } finally {
    conn.end();
  }

  let total = 0;
  const results = [];
  for (const line of String(out).split('\n')) {
    if (line.startsWith('COUNT:')) { total = parseInt(line.slice(6), 10) || 0; continue; }
    const m = line.match(/^FILE:(.*?):([A-Za-z0-9+/=]+)$/);
    if (!m) continue;
    const fpath = m[1];
    let data = null;
    try { data = JSON.parse(Buffer.from(m[2], 'base64').toString('utf8')); } catch {}
    const category = (fpath.match(/\/gamemode\/([^/]+)\//) || [])[1]
      || (fpath.match(/\/game\/[^/]+\/([^/]+)\//) || [])[1] || '';
    const world = (fpath.match(/\/game\/([^/]+)\//) || [])[1] || '';
    const id = (fpath.split('/').pop() || '').replace(/\.json$/, '');
    const paths = [];
    if (data) findMatchPaths(data, q, '', paths, 0);
    const role = deriveMatchRole(data, q, paths);
    results.push({ category, world, id, data, role, matchPaths: paths.map(p => p.path).slice(0, 5) });
  }
  return { results, total, shown: results.length, cap };
}

// Overview of a server's save: per-world, per-category JSON counts. Powers the
// inspector's browse view + download targets.
async function listSaveCategories(serverId) {
  const servers = listServers();
  const server = servers.find(s => s.id === serverId);
  if (!server) throw new Error('Unknown server');
  const saveBase = server.savePath || saveGamePathFromShopPath(server.path);
  if (!saveBase) throw new Error('No save path for this server');
  const privateKey = getPrivateKey();
  if (!privateKey) throw new Error('SSH key not configured');
  const entryHost = servers.find(s => s.region === 'eu') || servers[0];

  const inner = `SB='${saveBase}'; [ -d "$SB" ] || exit 0; for w in "$SB"/*/; do wn=$(basename "$w"); for c in "$w"gamemode/*/; do [ -d "$c" ] || continue; cn=$(basename "$c"); n=$(find "$c" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l); echo "$wn|$cn|$n"; done; done`;
  const cmd = wrapForRegion(server, inner);
  const conn = await sshOpen(privateKey, entryHost.host, entryHost.port, entryHost.user);
  let out;
  try { out = await sshRun(conn, cmd); } finally { conn.end(); }

  const categories = [];
  for (const line of String(out).split('\n')) {
    const p = line.split('|');
    if (p.length !== 3) continue;
    categories.push({ world: p[0], category: p[1], count: parseInt(p[2], 10) || 0, rel: `${p[0]}/gamemode/${p[1]}` });
  }
  return { categories };
}

// Open a streaming tar.gz of a path under the save root (a category folder, a
// world, a single record, or '.' for the whole save). Path is sanitised + sent
// base64 so traversal/shell injection is impossible. Returns {conn, stream}.
async function openSaveDownloadStream(serverId, relPath) {
  const servers = listServers();
  const server = servers.find(s => s.id === serverId);
  if (!server) throw new Error('Unknown server');
  const saveBase = server.savePath || saveGamePathFromShopPath(server.path);
  if (!saveBase) throw new Error('No save path for this server');

  let rel = String(relPath == null ? '.' : relPath).replace(/\\/g, '/').replace(/\.\.(\/|$)/g, '').replace(/^\/+/, '').trim();
  if (!rel) rel = '.';

  const privateKey = getPrivateKey();
  if (!privateKey) throw new Error('SSH key not configured');
  const entryHost = servers.find(s => s.region === 'eu') || servers[0];

  const relB64 = Buffer.from(rel, 'utf8').toString('base64');
  const inner = `SB='${saveBase}'; REL=$(printf %s '${relB64}' | base64 -d); cd "$SB" 2>/dev/null || exit 1; tar -czf - -- "$REL" 2>/dev/null`;
  const cmd = wrapForRegion(server, inner);

  const conn = await sshOpen(privateKey, entryHost.host, entryHost.port, entryHost.user);
  const stream = await new Promise((resolve, reject) => {
    conn.exec(cmd, (err, s) => (err ? reject(err) : resolve(s)));
  });
  const safeName = `${serverId}-${rel === '.' ? 'save' : rel.replace(/[^\w.-]+/g, '_')}.tar.gz`;
  return { conn, stream, filename: safeName };
}

// Fetch a single save record by its entity id (the file is named <id>.json).
// Used to resolve a Player's linked character (entity.playerEntity). id is
// validated to hex/dash only, so it's safe to interpolate.
async function getSaveRecord(serverId, entityId) {
  const id = String(entityId == null ? '' : entityId).trim();
  if (!/^[0-9a-fA-F-]{6,64}$/.test(id)) throw new Error('Invalid entity id');

  const servers = listServers();
  const server = servers.find(s => s.id === serverId);
  if (!server) throw new Error('Unknown server');
  const saveBase = server.savePath || saveGamePathFromShopPath(server.path);
  if (!saveBase) throw new Error('No save path for this server');
  const privateKey = getPrivateKey();
  if (!privateKey) throw new Error('SSH key not configured');
  const entryHost = servers.find(s => s.region === 'eu') || servers[0];

  const inner = `SB='${saveBase}'; f=$(find "$SB" -name '${id}.json' 2>/dev/null | head -1); if [ -n "$f" ]; then echo "FILE:$f:$(base64 -w0 "$f")"; fi`;
  const cmd = wrapForRegion(server, inner);
  const conn = await sshOpen(privateKey, entryHost.host, entryHost.port, entryHost.user);
  let out;
  try { out = await sshRun(conn, cmd); } finally { conn.end(); }

  const m = String(out).match(/^FILE:(.*?):([A-Za-z0-9+/=]+)$/m);
  if (!m) return { found: false, id };
  let data = null;
  try { data = JSON.parse(Buffer.from(m[2], 'base64').toString('utf8')); } catch {}
  const category = (m[1].match(/\/gamemode\/([^/]+)\//) || [])[1] || '';
  const world = (m[1].match(/\/game\/([^/]+)\//) || [])[1] || '';
  return { found: true, id, category, world, data };
}

// ---- Save-editing helpers (require the server stopped; back up first) ----

function volumeUuidFromPath(p) {
  const m = String(p || '').match(/\/volumes\/([^/]+)\//);
  return m ? m[1] : null;
}
// Recoverable trash sibling of .save (NOT under .save/game, so the game never loads it).
function trashBaseFromSave(saveBase) {
  return saveBase.replace(/\/\.save\/game$/, '/.save-inspector-trash');
}

async function saveOpContext(serverId) {
  const servers = listServers();
  const server = servers.find(s => s.id === serverId);
  if (!server) throw new Error('Unknown server');
  const saveBase = server.savePath || saveGamePathFromShopPath(server.path);
  if (!saveBase) throw new Error('No save path for this server');
  const uuid = volumeUuidFromPath(server.path);
  if (!uuid) throw new Error('Cannot resolve server container');
  const privateKey = getPrivateKey();
  if (!privateKey) throw new Error('SSH key not configured');
  const entryHost = servers.find(s => s.region === 'eu') || servers[0];
  if (!entryHost) throw new Error('No entry host');
  return { server, saveBase, uuid, privateKey, entryHost, trashBase: trashBaseFromSave(saveBase) };
}

async function runOn(ctx, inner) {
  const cmd = wrapForRegion(ctx.server, inner);
  const conn = await sshOpen(ctx.privateKey, ctx.entryHost.host, ctx.entryHost.port, ctx.entryHost.user);
  try { return await sshRun(conn, cmd); } finally { conn.end(); }
}

// Robust "is the game server running?" probe. Two-tier so it can NEVER silently
// mis-report a live server as stopped (which would let an admin edit a save that
// the running server then overwrites — exactly the EU3 "drop didn't stick" bug):
//   1. docker — if `docker ps` RUNS cleanly (exit 0), trust it: container present
//      = running, absent = stopped. Exact, used wherever the SSH user sees docker.
//   2. fallback — if docker is unavailable to that user/host (e.g. the EU3 nested
//      hop runs as a non-docker user, so the probe errors), infer from save activity:
//      a running server rewrites a .json under the save root every few minutes, so a
//      write in the last 10 min = running. Fails safe toward "running" when unsure.
// Emits RUNNING or STOPPED into $__RZ_RUN.
function detectRunningSnippet(uuid, saveBase) {
  return [
    `__RZ_RUN=STOPPED; __RZ_DOK=no`,
    `if command -v docker >/dev/null 2>&1; then __RZ_O=$(docker ps -q -f name=${uuid} 2>/dev/null); if [ $? -eq 0 ]; then __RZ_DOK=yes; [ -n "$__RZ_O" ] && __RZ_RUN=RUNNING; fi; fi`,
    `if [ "$__RZ_DOK" = no ]; then __RZ_O=$(find '${saveBase}' -name '*.json' -mmin -10 -print -quit 2>/dev/null); [ -n "$__RZ_O" ] && __RZ_RUN=RUNNING; fi`,
  ].join('; ');
}

// Is the game server running? (destructive ops are blocked when it is)
async function getServerRunning(serverId) {
  const ctx = await saveOpContext(serverId);
  const out = await runOn(ctx, `${detectRunningSnippet(ctx.uuid, ctx.saveBase)}; echo "$__RZ_RUN"`);
  return /RUNNING/.test(String(out));
}

// Embeddable guard for destructive ops: prints RUNNING and exits early if the
// server appears to be up (or can't be confirmed down). Pass the op context's
// uuid AND saveBase so the docker-unavailable fallback can check save activity.
const RUNNING_GUARD = (uuid, saveBase) => `${detectRunningSnippet(uuid, saveBase)}; if [ "$__RZ_RUN" = RUNNING ]; then echo RUNNING; exit 0; fi`;

// Overwrite a record's JSON. Server should be stopped; pass force=true to proceed
// while running (safe for dormant records — the server doesn't re-read files at
// runtime — but a live entity's record is overwritten by the next savepoint).
async function updateSaveRecord(serverId, entityId, jsonText, force = false) {
  const id = String(entityId == null ? '' : entityId).trim();
  if (!/^[0-9a-fA-F-]{6,64}$/.test(id)) throw new Error('Invalid entity id');
  let obj;
  try { obj = JSON.parse(jsonText); } catch { throw new Error('Invalid JSON'); }
  const newJson = JSON.stringify(obj, null, 4);
  const ctx = await saveOpContext(serverId);
  const b64 = Buffer.from(newJson, 'utf8').toString('base64');
  const inner = [
    force ? '' : RUNNING_GUARD(ctx.uuid, ctx.saveBase),
    `SB='${ctx.saveBase}'; TRASH='${ctx.trashBase}/edits'`,
    `f=$(find "$SB" -name '${id}.json' 2>/dev/null | head -1)`,
    `[ -z "$f" ] && { echo NOTFOUND; exit 0; }`,
    `mkdir -p "$TRASH"; cp "$f" "$TRASH/${id}.$(date +%s).bak.json"`,
    `printf %s '${b64}' | base64 -d > "$f"`,
    `echo OK`,
  ].filter(Boolean).join('; ');
  const out = (await runOn(ctx, inner)).trim();
  if (out.includes('RUNNING')) return { ok: false, error: 'server_running' };
  if (out.includes('NOTFOUND')) return { ok: false, error: 'not_found' };
  return { ok: out.includes('OK') };
}

// Move records to the recoverable trash. Server should be stopped; pass force=true
// to proceed while running (dead/orphan records drop and stay — they're not in the
// server's memory; a live entity's record just gets re-saved on the next savepoint).
async function deleteSaveRecords(serverId, ids, force = false) {
  const valid = (Array.isArray(ids) ? ids : []).map(x => String(x).trim()).filter(x => /^[0-9a-fA-F-]{6,64}$/.test(x));
  if (!valid.length) throw new Error('No valid ids');
  if (valid.length > 5000) throw new Error('Too many at once (max 5000)');
  const ctx = await saveOpContext(serverId);
  const idsB64 = Buffer.from(valid.join('\n'), 'utf8').toString('base64');
  const inner = [
    force ? '' : RUNNING_GUARD(ctx.uuid, ctx.saveBase),
    `SB='${ctx.saveBase}'; TS=$(date +%s); TRASH="${ctx.trashBase}/deleted/$TS"; mkdir -p "$TRASH" 2>&1 | sed 's/^/MKDIRERR:/'`,
    `printf %s '${idsB64}' | base64 -d | while IFS= read -r id || [ -n "$id" ]; do [ -z "$id" ] && continue; f=$(find "$SB" -name "$id.json" 2>/dev/null | head -1); if [ -z "$f" ]; then echo "NOTFOUND:$id"; else e=$(mv "$f" "$TRASH/" 2>&1) && echo "OK:$id" || echo "FAIL:$id:$e"; fi; done`,
    `echo "MOVED:$(find "$TRASH" -name '*.json' 2>/dev/null | wc -l)"; echo "TRASH:$TRASH"`,
  ].filter(Boolean).join('; ');
  const out = (await runOn(ctx, inner)).trim();
  if (out.includes('RUNNING')) return { ok: false, error: 'server_running' };
  const moved = parseInt((out.match(/MOVED:(\d+)/) || [])[1], 10) || 0;
  const trash = (out.match(/TRASH:(\S+)/) || [])[1] || '';
  const notFound = (out.match(/NOTFOUND:/g) || []).length;
  const failLines = (String(out).split('\n').filter(l => l.startsWith('FAIL:') || l.startsWith('MKDIRERR:')));
  const reason = failLines.length ? failLines.slice(0, 3).join(' | ') : (notFound ? `not found on ${serverId} (wrong server?)` : '');
  return { ok: true, moved, requested: valid.length, trash, notFound, failed: failLines.length, reason };
}

const ORPHAN_UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
function safeCategory(c) {
  const cat = String(c == null ? 'Item' : c).trim();
  if (!/^[A-Za-z]+$/.test(cat)) throw new Error('Invalid category');
  return cat;
}

// Records in a category whose id is referenced by NO file outside that category.
// For Item = loose world loot; for Character = dead/old bodies no player points
// to (Player.playerEntity is the "live" reference). Returns the list + totals.
async function scanOrphans(serverId, category = 'Item', limit = 1000) {
  const cat = safeCategory(category);
  const ctx = await saveOpContext(serverId);
  const cap = Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 5000);
  const inner = [
    `SB='${ctx.saveBase}'; [ -d "$SB" ] || { echo "TOTAL:0"; echo "ALL:0"; exit 0; }`,
    `T=$(mktemp -d)`,
    `find "$SB"/*/gamemode/${cat} -name '*.json' 2>/dev/null | sed 's#.*/##; s#\\.json$##' | tr 'A-F' 'a-f' | sort -u > "$T/ids"`,
    `find "$SB" -name '*.json' -not -path '*/gamemode/${cat}/*' -print0 2>/dev/null | xargs -0 grep -hoE '${ORPHAN_UUID}' 2>/dev/null | tr 'A-F' 'a-f' | sort -u > "$T/refs"`,
    `comm -23 "$T/ids" "$T/refs" > "$T/orph"`,
    `echo "ALL:$(wc -l < "$T/ids")"; echo "TOTAL:$(wc -l < "$T/orph")"`,
    `head -${cap} "$T/orph" | while IFS= read -r id; do f=$(find "$SB"/*/gamemode/${cat} -name "$id.json" 2>/dev/null | head -1); [ -n "$f" ] && echo "ORPH:$id:$(jq -c '{prefab:.spawnData.prefab,coords:.spawnData.coords,name:(.components|to_entries|map(.value.name)|map(select(.))|first)}' "$f" 2>/dev/null | base64 -w0)"; done`,
    `rm -rf "$T"`,
  ].join('; ');
  const out = await runOn(ctx, inner);
  let total = 0, all = 0;
  const orphans = [];
  for (const line of String(out).split('\n')) {
    if (line.startsWith('TOTAL:')) { total = parseInt(line.slice(6), 10) || 0; continue; }
    if (line.startsWith('ALL:')) { all = parseInt(line.slice(4), 10) || 0; continue; }
    const m = line.match(/^ORPH:([0-9a-fA-F-]+):([A-Za-z0-9+/=]+)$/);
    if (!m) continue;
    let info = {};
    try { info = JSON.parse(Buffer.from(m[2], 'base64').toString('utf8')); } catch {}
    orphans.push({ id: m[1], prefab: info.prefab, coords: info.coords, name: info.name });
  }
  return { category: cat, total: all, orphanCount: total, shown: orphans.length, orphans };
}

// Move ALL orphans of a category to the recoverable trash in one pass. Server
// should be stopped; pass force=true to run while up (orphans are dormant — not in
// server memory — so they drop and stay). Efficient (glob mv) for large cleanups.
async function purgeOrphans(serverId, category, force = false) {
  const cat = safeCategory(category);
  const ctx = await saveOpContext(serverId);
  const inner = [
    force ? '' : RUNNING_GUARD(ctx.uuid, ctx.saveBase),
    `SB='${ctx.saveBase}'; [ -d "$SB" ] || { echo "MOVED:0"; exit 0; }`,
    `T=$(mktemp -d); TS=$(date +%s); TRASH="${ctx.trashBase}/orphans-${cat}-$TS"; mkdir -p "$TRASH"`,
    `find "$SB"/*/gamemode/${cat} -name '*.json' 2>/dev/null | sed 's#.*/##; s#\\.json$##' | tr 'A-F' 'a-f' | sort -u > "$T/ids"`,
    `find "$SB" -name '*.json' -not -path '*/gamemode/${cat}/*' -print0 2>/dev/null | xargs -0 grep -hoE '${ORPHAN_UUID}' 2>/dev/null | tr 'A-F' 'a-f' | sort -u > "$T/refs"`,
    `comm -23 "$T/ids" "$T/refs" | while IFS= read -r id; do mv "$SB"/*/gamemode/${cat}/"$id".json "$TRASH/" 2>/dev/null; done`,
    `echo "MOVED:$(find "$TRASH" -name '*.json' 2>/dev/null | wc -l)"; echo "TRASH:$TRASH"`,
    `rm -rf "$T"`,
  ].filter(Boolean).join('; ');
  const out = (await runOn(ctx, inner)).trim();
  if (out.includes('RUNNING')) return { ok: false, error: 'server_running' };
  const moved = parseInt((out.match(/MOVED:(\d+)/) || [])[1], 10) || 0;
  const trash = (out.match(/TRASH:(\S+)/) || [])[1] || '';
  return { ok: true, moved, trash };
}

// A character's damage component stores per-hitzone health; the "Health" hitzone
// is the global one. <= 0 == dead body. This filter returns that value (or null
// if the record has no such hitzone). We treat ONLY a positively-found value <= 0
// as dead, so a living character (Health > 0) or an ambiguous record (no health
// persisted) can never be flagged — the cleaner is physically incapable of
// touching a living character.
const DEAD_HEALTH_JQ = '([.components[]? | objects | .hitzones? // empty | .[]? | select(.name=="Health") | .health] | first)';

// Scan the Character category for confirmed-dead bodies (Health hitzone <= 0).
// Returns total character count, dead count, and a capped sample list.
async function scanDeadCharacters(serverId, limit = 1000) {
  const ctx = await saveOpContext(serverId);
  const cap = Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 5000);
  const inner = [
    `SB='${ctx.saveBase}'; [ -d "$SB" ] || { echo "ALL:0"; echo "DEAD:0"; exit 0; }`,
    `T=$(mktemp -d)`,
    `echo "ALL:$(find "$SB"/*/gamemode/Character -name '*.json' 2>/dev/null | wc -l)"`,
    `find "$SB"/*/gamemode/Character -name '*.json' -print0 2>/dev/null | xargs -0 -r jq -r '${DEAD_HEALTH_JQ} as $h | select($h != null and $h <= 0) | {id:(input_filename|sub(".*/";"")|rtrimstr(".json")), prefab:(.spawnData.prefab // ""), name:([.components[]? | objects | .name // empty] | first // ""), health:$h} | @json' 2>/dev/null > "$T/dead"`,
    `echo "DEAD:$(wc -l < "$T/dead")"`,
    `head -${cap} "$T/dead" | while IFS= read -r j; do echo "D:$(printf %s "$j" | base64 -w0)"; done`,
    `rm -rf "$T"`,
  ].join('; ');
  const out = await runOn(ctx, inner);
  let all = 0, dead = 0;
  const items = [];
  for (const line of String(out).split('\n')) {
    if (line.startsWith('ALL:')) { all = parseInt(line.slice(4), 10) || 0; continue; }
    if (line.startsWith('DEAD:')) { dead = parseInt(line.slice(5), 10) || 0; continue; }
    if (line.startsWith('D:')) {
      try { items.push(JSON.parse(Buffer.from(line.slice(2), 'base64').toString('utf8'))); } catch {}
    }
  }
  return { total: all, deadCount: dead, shown: items.length, dead: items };
}

// Move every confirmed-dead character (Health hitzone <= 0) to the recoverable
// trash in one pass. Server should be stopped; pass force=true to run while up —
// dead bodies are dormant (despawned, not in memory), so they drop and stay. A dead
// body still linked to a player just means that player fresh-spawns on next join.
async function purgeDeadCharacters(serverId, force = false) {
  const ctx = await saveOpContext(serverId);
  const inner = [
    force ? '' : RUNNING_GUARD(ctx.uuid, ctx.saveBase),
    `SB='${ctx.saveBase}'; [ -d "$SB" ] || { echo "MOVED:0"; exit 0; }`,
    `T=$(mktemp -d); TS=$(date +%s); TRASH="${ctx.trashBase}/dead-characters-$TS"; mkdir -p "$TRASH"`,
    `find "$SB"/*/gamemode/Character -name '*.json' -print0 2>/dev/null | xargs -0 -r jq -r '${DEAD_HEALTH_JQ} as $h | select($h != null and $h <= 0) | input_filename' 2>/dev/null > "$T/deadfiles"`,
    `while IFS= read -r f; do [ -n "$f" ] && mv "$f" "$TRASH/" 2>/dev/null; done < "$T/deadfiles"`,
    `echo "MOVED:$(find "$TRASH" -name '*.json' 2>/dev/null | wc -l)"; echo "TRASH:$TRASH"`,
    `rm -rf "$T"`,
  ].filter(Boolean).join('; ');
  const out = (await runOn(ctx, inner)).trim();
  if (out.includes('RUNNING')) return { ok: false, error: 'server_running' };
  const moved = parseInt((out.match(/MOVED:(\d+)/) || [])[1], 10) || 0;
  const trash = (out.match(/TRASH:(\S+)/) || [])[1] || '';
  return { ok: true, moved, trash };
}

// List every player (from Player records) with name, uid, linked character id, and
// key stats — powers the player-name dropdown / DB table. One jq pass over Player/.
async function listPlayers(serverId) {
  const ctx = await saveOpContext(serverId);
  const inner = [
    `SB='${ctx.saveBase}'; [ -d "$SB" ] || exit 0`,
    `find "$SB"/*/gamemode/Player -name '*.json' -print0 2>/dev/null | xargs -0 -r jq -c '([.components[]?|objects|select(.name!=null and .uid!=null)]|first) as $d | {rec:.id, char:(.entity.playerEntity//""), name:($d.name//""), uid:($d.uid//""), humanity:($d.humanity//0), deaths:($d.totalDeaths//0), kills:($d.playerKills//0), zkills:($d.zombieKills//0), playtime:($d.totalPlaytime//0), logins:($d.loginCount//0), lastLogin:($d.lastLogin//""), isDead:($d.isDead//0), fresh:($d.isFreshSpawn//0)}' 2>/dev/null`,
  ].join('; ');
  const out = await runOn(ctx, inner);
  const players = [];
  for (const line of String(out).split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try { const p = JSON.parse(t); if (p.name) players.push(p); } catch {}
  }
  players.sort((a, b) => String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase()));
  return { players, count: players.length };
}

// List records inside one collection (category) — compact summary per record for
// the collection browser. Capped; returns total so the UI can show "X of Y".
async function listCollectionRecords(serverId, category, limit = 1000) {
  const cat = safeCategory(category);
  const ctx = await saveOpContext(serverId);
  const cap = Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 3000);
  const inner = [
    `SB='${ctx.saveBase}'`,
    `echo "TOTAL:$(find "$SB"/*/gamemode/${cat} -name '*.json' 2>/dev/null | wc -l)"`,
    `find "$SB"/*/gamemode/${cat} -name '*.json' 2>/dev/null | head -${cap} | while IFS= read -r f; do j=$(jq -c '{id:(.id // (input_filename|sub(".*/";"")|rtrimstr(".json"))), prefab:(.spawnData.prefab//""), coords:(.spawnData.coords//null), store:(.configuration.m_rStoreName//""), name:([.components[]?|objects|.name//empty]|first // ""), health:([.components[]?|objects|.hitzones?//empty|.[]?|select(.name=="Health")|.health]|first)}' "$f" 2>/dev/null); [ -n "$j" ] && echo "R:$(printf %s "$j" | base64 -w0)"; done`,
  ].join('; ');
  const out = await runOn(ctx, inner);
  let total = 0; const records = [];
  for (const line of String(out).split('\n')) {
    if (line.startsWith('TOTAL:')) { total = parseInt(line.slice(6), 10) || 0; continue; }
    if (line.startsWith('R:')) { try { records.push(JSON.parse(Buffer.from(line.slice(2), 'base64').toString('utf8'))); } catch {} }
  }
  return { category: cat, total, shown: records.length, records };
}

// Custom counts for the stat bar. A "base" (territory) = a placed Fortify FlagPole;
// "base parts" = the rest of the BaseBuilding collection (walls, floors, etc).
const FLAG_PREFAB = 'EFFA90623A05EB25'; // ReforgedZ_Fortify FlagPole.et
async function getExtraStats(serverId) {
  const ctx = await saveOpContext(serverId);
  const inner = [
    `SB='${ctx.saveBase}'`,
    `BB=$(find "$SB"/*/gamemode/BaseBuilding -name '*.json' 2>/dev/null | wc -l)`,
    `FL=$(find "$SB"/*/gamemode/BaseBuilding -name '*.json' -print0 2>/dev/null | xargs -0 -r jq -r 'select(.spawnData.prefab=="${FLAG_PREFAB}") | input_filename' 2>/dev/null | wc -l)`,
    `echo "BB:$BB"; echo "FLAGS:$FL"`,
  ].join('; ');
  const out = await runOn(ctx, inner);
  const bb = parseInt((out.match(/BB:(\d+)/) || [])[1], 10) || 0;
  const flags = parseInt((out.match(/FLAGS:(\d+)/) || [])[1], 10) || 0;
  return { flags, baseBuilding: bb, baseParts: Math.max(0, bb - flags) };
}

module.exports = { syncPurchasesToServers, buildPriorityQueueGuidsPerServer, searchSaveFiles, listSaveCategories, openSaveDownloadStream, getSaveRecord, getServerRunning, updateSaveRecord, deleteSaveRecords, scanOrphans, purgeOrphans, scanDeadCharacters, purgeDeadCharacters, listPlayers, getExtraStats, listCollectionRecords };

const crypto = require('crypto');
const { Client } = require('ssh2');
const db = require('./db');
// listServers() = servers the shop syncs to (eu3 deliberately excluded).
// listAllServers() = every reachable server, used by the save inspector so a
// server retired from sale can still have its saves read.
const { listServers, listAllServers, SERVER_IDS, saveGamePathFromShopPath } = require('./gameServers');

function getPrivateKey() {
  const b64 = process.env.SSH_PRIVATE_KEY_B64;
  if (b64) return Buffer.from(b64, 'base64');
  console.error('[sync] SSH_PRIVATE_KEY_B64 not set in .env');
  return null;
}

// Host-key pinning. When GAME_SERVER_HOST_FINGERPRINTS is set (comma-separated
// base64 SHA-256 fingerprints), every SSH host key must match one of them or the
// connection is refused — this blocks MITM on the sync channel. When it's unset
// we log the fingerprint and accept (trust-on-first-use), so pinning can be
// rolled out without an uptime break: read the logged values, then set the env.
const PINNED_FINGERPRINTS = (process.env.GAME_SERVER_HOST_FINGERPRINTS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function hostKeyFingerprint(keyBuf) {
  return crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}

function verifyHostKey(keyBuf) {
  const fp = hostKeyFingerprint(keyBuf);
  if (PINNED_FINGERPRINTS.length === 0) {
    console.warn(`[sync] SSH host key SHA256:${fp} accepted (no GAME_SERVER_HOST_FINGERPRINTS set — set it to pin).`);
    return true;
  }
  const ok = PINNED_FINGERPRINTS.includes(fp);
  if (!ok) console.error(`[sync] SSH host key SHA256:${fp} REJECTED — not in GAME_SERVER_HOST_FINGERPRINTS.`);
  return ok;
}

// For the nested NA hop / rsync that shell out to the `ssh` binary: default to
// accept-new (TOFU — records the key on first use, then pins) instead of the old
// blanket StrictHostKeyChecking=no. Set GAME_SERVER_STRICT_HOSTKEYS=1 once a
// known_hosts is provisioned to require an already-trusted key.
const SSH_STRICT = process.env.GAME_SERVER_STRICT_HOSTKEYS === '1' ? 'yes' : 'accept-new';

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
      hostVerifier: verifyHostKey
    });
  });
}

function sshRun(conn, command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`SSH command timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
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

// Entries written to each server's purchases.json. Expired entitlements are
// excluded: the game-side mod reads this file, so a lapsed subscription left in
// it keeps granting its perk forever, and a former buyer who has since been made
// a GM ends up listed as both. Lifetime purchases (effective_until NULL) stay.
// Mirrors the filter used by buildPriorityQueueGuidsPerServer below, which the
// game.admins sync has always applied - only this file was missing it.
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
      AND (o.effective_until IS NULL OR o.effective_until > unixepoch())
  `).all();

  // Manual priority-queue grants need to land in purchases.json too — otherwise
  // the game-side mod (which reads purchases.json) won't know about them.
  // Use the canonical title of an active priority-queue-granting product so it
  // matches whatever the mod expects; fall back to the literal "Priority Queue".
  const pqProduct = db.prepare(`
    SELECT title FROM products WHERE grants_priority_queue = 1 AND active = 1 ORDER BY created_at DESC LIMIT 1
  `).get();
  const pqItemTitle = (pqProduct && pqProduct.title) || 'Priority Queue';

  const manualGrants = db.prepare(`SELECT guid, server_id, display_name, removed FROM priority_queue_grants WHERE removed = 1 OR expires_at IS NULL OR expires_at > unixepoch()`).all();

  const buckets = Object.fromEntries(SERVER_IDS.map(id => [id, []]));

  for (const r of rows) {
    const entry = { name: r.name, guid: r.guid, item: r.item };
    if (!r.server_specific) {
      for (const id of SERVER_IDS) buckets[id].push(entry);
    } else if (r.server_id && buckets[r.server_id]) {
      buckets[r.server_id].push(entry);
    }
  }

  const denied = new Set();   // "guid|server" — hidden by a deny row (removed=1)
  for (const g of manualGrants) {
    if (!g.guid || !buckets[g.server_id]) continue;
    if (g.removed) { denied.add(`${g.guid}|${g.server_id}`); continue; }
    buckets[g.server_id].push({
      name: g.display_name || '',
      guid: g.guid,
      item: pqItemTitle
    });
  }

  // Dedupe per bucket on (guid|item) — keeps the first occurrence, so a
  // purchase entry's `name` (which comes from the user's persona/gamertag)
  // wins over a manual grant's display_name if both exist for the same guid.
  // Also drop any (guid, server) hidden by a deny row.
  for (const id of SERVER_IDS) {
    const seen = new Set();
    buckets[id] = buckets[id].filter(e => {
      if (denied.has(`${e.guid}|${id}`)) return false;
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

  const manualRows = db.prepare(`SELECT guid, server_id, removed FROM priority_queue_grants WHERE removed = 1 OR expires_at IS NULL OR expires_at > unixepoch()`).all();

  const out = Object.fromEntries(SERVER_IDS.map(id => [id, new Set()]));

  for (const r of orderRows) {
    if (!r.server_specific) {
      for (const id of SERVER_IDS) out[id].add(r.guid);
    } else if (r.server_id && out[r.server_id]) {
      out[r.server_id].add(r.guid);
    }
  }

  // Manual layer: grants add, denies (removed=1) remove — so an admin can toggle a
  // purchase-driven server off, exactly like a manual grant.
  for (const r of manualRows) {
    if (!out[r.server_id]) continue;
    if (r.removed) out[r.server_id].delete(r.guid);
    else out[r.server_id].add(r.guid);
  }

  return out;
}

function buildWritePurchasesCmd(server, json) {
  const b64 = Buffer.from(json).toString('base64');
  const remotePath = server.path + '/purchases.json';
  const tmpPath = remotePath + '.tmp';
  // Write to a sibling temp file and rename over the target. A plain
  // redirect truncates the live file first, so a game server reading it at
  // that moment sees an empty or half-written entitlement list -- and two
  // syncs overlapping (this runs from ~15 call sites plus two timers) could
  // interleave into it. rename(2) within the same directory is atomic, so a
  // reader gets either the old file or the new one, never a partial one.
  // chmod --reference keeps whatever mode that server's file already had;
  // they are not consistent across servers, so don't impose one.
  return [
    `mkdir -p '${server.path}'`,
    `echo '${b64}' | base64 -d > '${tmpPath}'`,
    `{ chmod --reference='${remotePath}' '${tmpPath}' 2>/dev/null || true; }`,
    `mv -f '${tmpPath}' '${remotePath}'`,
    `echo '[sync] ${server.id} OK'`
  ].join(' && ');
}

function wrapForRegion(server, innerCmd) {
  // EU servers we hit directly from the entry SSH session (which connects to EU host).
  // NA servers we reach via a nested SSH from the EU host to the NA host.
  if (server.region === 'eu') return innerCmd;
  // Base64-encode the inner command so nothing inside it can break out of the
  // outer SSH quoting. The remote shell decodes and pipes to bash. Single-quote
  // wrapping is safe because base64 alphabet is [A-Za-z0-9+/=] only.
  const innerB64 = Buffer.from(innerCmd, 'utf8').toString('base64');
  return `ssh -o StrictHostKeyChecking=${SSH_STRICT} -o ConnectTimeout=10 -p ${server.port} ${server.user}@${server.host} 'echo ${innerB64} | base64 -d | bash'`;
}

// Read config.json + its on-disk SHA-256 in one round-trip, so the write can
// compare-and-swap on it. Returns { config, hash } or null if the file is empty.
async function readConfigWithHash(conn, server) {
  const p = server.configPath;
  const inner = `sha256sum '${p}' | cut -d' ' -f1; cat '${p}' | base64 -w0`;
  const out = (await sshRun(conn, wrapForRegion(server, inner))).trim();
  if (!out) return null;
  const nl = out.indexOf('\n');
  if (nl < 0) throw new Error('config read malformed');
  const hash = out.slice(0, nl).trim();
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error('config hash malformed');
  const config = JSON.parse(Buffer.from(out.slice(nl + 1).trim(), 'base64').toString('utf8'));
  return { config, hash };
}

// Write config.json under an flock on <config>.lock, but ONLY if its on-disk
// SHA-256 still matches `expectedHash` (compare-and-swap) — so a concurrent
// write from the admin page (GM Management) is never clobbered. tmp+mv keeps the
// file whole. Returns 'ok' | 'stale' | 'err'. Uses the SAME lock file + CAS
// protocol as the admin page's atomicMutateConfig, so the two processes are
// mutually exclusive across their separate SSH sessions.
async function casWriteConfig(conn, server, configObj, expectedHash) {
  const p = server.configPath;
  const b64 = Buffer.from(JSON.stringify(configObj, null, 2)).toString('base64');
  const inner = [
    `exec 9>'${p}.lock' || exit 20`,
    `flock -w 15 9 || exit 21`,
    `CUR=$(sha256sum '${p}' 2>/dev/null | cut -d' ' -f1)`,
    `if [ "$CUR" != '${expectedHash}' ]; then echo STALE; exit 0; fi`,
    `printf %s '${b64}' | base64 -d > '${p}.tmp.shopsync' || exit 24`,
    `mv '${p}.tmp.shopsync' '${p}' || exit 25`,
    `echo OK`,
  ].join('\n');
  const out = (await sshRun(conn, wrapForRegion(server, inner))).trim();
  if (/(^|\n)OK$/.test(out)) return 'ok';
  if (out.includes('STALE')) return 'stale';
  return 'err';
}

async function patchServerAdmins(conn, server, desiredGuids) {
  if (!server.configPath) {
    console.log(`[admins-sync] ${server.id} no configPath, skipping`);
    return;
  }

  // GUIDs WE put there last time (so we strip only our own lapsed entries).
  const prevRow = db.prepare('SELECT previously_owned_json FROM config_admin_sync_state WHERE server_id = ?').get(server.id);
  let previouslyOwned;
  try {
    previouslyOwned = new Set(prevRow ? JSON.parse(prevRow.previously_owned_json) : []);
  } catch {
    previouslyOwned = new Set();
  }

  // Atomic read-modify-write loop: read config + hash, recompute, then CAS-write
  // under flock. If the admin page (or anything) changed the file in between, the
  // CAS fails 'stale' and we retry against the fresh copy — never clobbering a GM
  // that was just added on the GM Management page.
  for (let attempt = 0; attempt < 5; attempt++) {
    let read;
    try {
      read = await readConfigWithHash(conn, server);
    } catch (e) {
      console.error(`[admins-sync] ${server.id} read failed:`, e.message);
      return;
    }
    if (!read) {
      console.error(`[admins-sync] ${server.id} config.json empty or missing`);
      return;
    }
    const { config, hash } = read;

    if (!config.game || typeof config.game !== 'object') config.game = {};
    const currentAdmins = Array.isArray(config.game.admins) ? config.game.admins.slice() : [];

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

    // Strip OUR previously-owned entries no longer desired, then add OUR desired
    // entries. Entries from the GM tab (or anything else) live untouched.
    const newAdmins = currentAdmins.filter(g => !previouslyOwned.has(g));
    for (const g of desiredGuids) {
      if (g && !newAdmins.includes(g)) newAdmins.push(g);
    }

    // No-op if nothing actually changed.
    const sameSet = newAdmins.length === currentAdmins.length
      && newAdmins.every(g => currentAdmins.includes(g));
    const prevMatches = previouslyOwned.size === desiredGuids.size
      && [...desiredGuids].every(g => previouslyOwned.has(g));
    if (sameSet && prevMatches) {
      return;
    }

    config.game.admins = newAdmins;
    let res;
    try {
      res = await casWriteConfig(conn, server, config, hash);
    } catch (e) {
      console.error(`[admins-sync] ${server.id} write failed:`, e.message);
      return;
    }
    if (res === 'stale') {
      console.warn(`[admins-sync] ${server.id} config changed under us — retrying (attempt ${attempt + 1})`);
      continue;
    }
    if (res !== 'ok') {
      console.error(`[admins-sync] ${server.id} CAS write failed unexpectedly`);
      return;
    }

    // Update our tracking only after a successful write.
    db.prepare(`
      INSERT INTO config_admin_sync_state (server_id, previously_owned_json, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(server_id) DO UPDATE SET
        previously_owned_json = excluded.previously_owned_json,
        updated_at = excluded.updated_at
    `).run(server.id, JSON.stringify([...desiredGuids]));

    console.log(`[admins-sync] ${server.id} game.admins ${currentAdmins.length} -> ${newAdmins.length} (shop-owned: ${desiredGuids.size})`);
    return;
  }
  console.error(`[admins-sync] ${server.id} game.admins CAS conflict — retries exhausted, will retry next sync`);
}

// Coalescing guard. Every caller is fire-and-forget, and a purchase can easily
// land while the 10-minute periodic sync is mid-flight, which used to mean two
// concurrent SSH sessions writing the same files. If a sync is requested while
// one is running we do NOT drop it -- the request is remembered and one more
// pass runs afterwards, so the last state always reaches the servers.
let syncInFlight = null;
let syncRequestedAgain = false;

async function syncPurchasesToServers() {
  if (syncInFlight) {
    syncRequestedAgain = true;
    return syncInFlight;
  }
  syncInFlight = (async () => {
    try {
      return await runPurchaseSync();
    } finally {
      syncInFlight = null;
      if (syncRequestedAgain) {
        syncRequestedAgain = false;
        syncPurchasesToServers().catch(e => console.error('[sync] coalesced re-run failed:', e.message));
      }
    }
  })();
  return syncInFlight;
}

async function runPurchaseSync() {
  // Sellable/synced servers only — eu3 is a dev box now and must not be written to.
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
    // The per-server commands are chained with ';' so one failure doesn't stop
    // the rest, which also means the chain's exit code only reflects the LAST
    // command — a failed nested hop to NA would still look like success. Each
    // command echoes "[sync] <id> OK" on completion, so confirm every server
    // individually rather than trusting the exit code.
    const purchaseCmds = servers.map(s => wrapForRegion(s, buildWritePurchasesCmd(s, JSON.stringify(buckets[s.id], null, 2))));
    try {
      const out = await sshRun(conn, purchaseCmds.join(' ; '));
      const missing = servers.filter(s => !out.includes(`[sync] ${s.id} OK`));
      if (missing.length === 0) {
        console.log(`[sync] purchases.json synced to all ${servers.length} servers`);
      } else {
        const wrote = servers.filter(s => !missing.includes(s)).map(s => s.id);
        console.error(
          `[sync] purchases.json NOT confirmed on: ${missing.map(s => s.id).join(', ')}` +
          ` — those servers are STALE. Written OK: ${wrote.join(', ') || 'none'}`
        );
      }
    } catch (e) {
      console.error('[sync] purchases.json failed for ALL servers:', e.message);
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

  const servers = listAllServers();
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
  const servers = listAllServers();
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
  const servers = listAllServers();
  const server = servers.find(s => s.id === serverId);
  if (!server) throw new Error('Unknown server');
  const saveBase = server.savePath || saveGamePathFromShopPath(server.path);
  if (!saveBase) throw new Error('No save path for this server');

  // Sanitise the requested sub-path. The previous single-pass ../ strip could be
  // defeated by doubled sequences (`....//` → `../`), so instead: normalise, then
  // reject anything that still contains a `..` segment or is absolute. This
  // confines the download to paths at or under the save root.
  let rel = String(relPath == null ? '.' : relPath).replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!rel) rel = '.';
  const posix = require('path').posix;
  const normalised = posix.normalize(rel);
  if (normalised === '..' || normalised.startsWith('../') || normalised.includes('/../') || posix.isAbsolute(normalised)) {
    throw new Error('Path escapes save root');
  }
  rel = normalised;

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

  const servers = listAllServers();
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
  const servers = listAllServers();
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

async function runOn(ctx, inner, timeoutMs = 30000) {
  const cmd = wrapForRegion(ctx.server, inner);
  const conn = await sshOpen(ctx.privateKey, ctx.entryHost.host, ctx.entryHost.port, ctx.entryHost.user);
  try { return await sshRun(conn, cmd, timeoutMs); } finally { conn.end(); }
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

// Persistence stores whose records live in the Item collection but are REAL placed
// player structures (workbenches, salvage benches — flag-registered base objects with
// owner/placement components). They must NEVER be treated as orphans or swept by an
// Item purge. Matched by the m_rStoreName in each record's configuration.
const PROTECTED_STORES = ['673F305B76CC7974'];
// grep alternation for the store guids, e.g. 673F305B76CC7974|AAAA...
const PROTECTED_STORES_GREP = PROTECTED_STORES.join('|');
// Heavy save scans (orphan detect / collection list) walk 20k+ files — the default
// 30s SSH timeout is too short; give them room.
const SAVE_HEAVY_TIMEOUT = 180000;

// Emit (into $T/protected AND appended to $T/refs) the ids of records in this category
// that belong to a PROTECTED_STORES store. grep (not jq) so a malformed record can never
// abort the scan and silently expose a real structure to deletion.
function protectStoresSnippet(saveBase, cat) {
  return `find "${saveBase}"/*/gamemode/${cat} -maxdepth 1 -name '*.json' -print0 2>/dev/null | xargs -0 -r grep -lE '"m_rStoreName":[[:space:]]*"(${PROTECTED_STORES_GREP})"' 2>/dev/null | sed 's#.*/##; s#\\.json$##' | tr 'A-F' 'a-f' | sort -u > "$T/protected"; cat "$T/protected" >> "$T/refs"; sort -u "$T/refs" -o "$T/refs"`;
}

function safeCategory(c) {
  const cat = String(c == null ? 'Item' : c).trim();
  if (!/^[A-Za-z]+$/.test(cat)) throw new Error('Invalid category');
  return cat;
}

// Records in a category whose id is referenced by NO CURRENT record outside that
// category. For Item = loose world loot (items stored in bases/inventories are
// referenced by their BaseBuilding/Character record and kept); for Character =
// dead/old bodies no player points to (Player.playerEntity is the "live" ref).
// Savepoint journals (playthrough*/System) are excluded from the reference scan:
// an id in a `removedLoaded` removal-journal is NOT a live reference and was
// deflating the orphan count. Returns the list + totals.
async function scanOrphans(serverId, category = 'Item', limit = 1000) {
  const cat = safeCategory(category);
  const ctx = await saveOpContext(serverId);
  const cap = Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 5000);
  const inner = [
    `SB='${ctx.saveBase}'; [ -d "$SB" ] || { echo "TOTAL:0"; echo "ALL:0"; exit 0; }`,
    `T=$(mktemp -d)`,
    `find "$SB"/*/gamemode/${cat} -name '*.json' 2>/dev/null | sed 's#.*/##; s#\\.json$##' | tr 'A-F' 'a-f' | sort -u > "$T/ids"`,
    `find "$SB" -name '*.json' -not -path '*/gamemode/${cat}/*' -not -path '*/playthrough*' -print0 2>/dev/null | xargs -0 grep -hoE '${ORPHAN_UUID}' 2>/dev/null | tr 'A-F' 'a-f' | sort -u > "$T/refs"`,
    protectStoresSnippet(ctx.saveBase, cat),
    `comm -23 "$T/ids" "$T/refs" > "$T/orph"`,
    `echo "ALL:$(wc -l < "$T/ids")"; echo "TOTAL:$(wc -l < "$T/orph")"; echo "PROTECTED:$(wc -l < "$T/protected")"`,
    `head -${cap} "$T/orph" | while IFS= read -r id; do f=$(find "$SB"/*/gamemode/${cat} -name "$id.json" 2>/dev/null | head -1); [ -n "$f" ] && echo "ORPH:$id:$(jq -c '{prefab:.spawnData.prefab,coords:.spawnData.coords,store:(.configuration.m_rStoreName // ""),name:((.components // {})|to_entries|map(.value.name?)|map(select(.))|first)}' "$f" 2>/dev/null | base64 -w0)"; done`,
    `rm -rf "$T"`,
  ].join('; ');
  const out = await runOn(ctx, inner, SAVE_HEAVY_TIMEOUT);
  let total = 0, all = 0, protectedCount = 0;
  const orphans = [];
  for (const line of String(out).split('\n')) {
    if (line.startsWith('TOTAL:')) { total = parseInt(line.slice(6), 10) || 0; continue; }
    if (line.startsWith('ALL:')) { all = parseInt(line.slice(4), 10) || 0; continue; }
    if (line.startsWith('PROTECTED:')) { protectedCount = parseInt(line.slice(10), 10) || 0; continue; }
    const m = line.match(/^ORPH:([0-9a-fA-F-]+):([A-Za-z0-9+/=]+)$/);
    if (!m) continue;
    let info = {};
    try { info = JSON.parse(Buffer.from(m[2], 'base64').toString('utf8')); } catch {}
    orphans.push({ id: m[1], prefab: info.prefab, coords: info.coords, store: info.store, name: info.name });
  }
  return { category: cat, total: all, orphanCount: total, protectedCount, shown: orphans.length, orphans };
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
    `find "$SB" -name '*.json' -not -path '*/gamemode/${cat}/*' -not -path '*/playthrough*' -print0 2>/dev/null | xargs -0 grep -hoE '${ORPHAN_UUID}' 2>/dev/null | tr 'A-F' 'a-f' | sort -u > "$T/refs"`,
    protectStoresSnippet(ctx.saveBase, cat),
    `comm -23 "$T/ids" "$T/refs" | while IFS= read -r id; do mv "$SB"/*/gamemode/${cat}/"$id".json "$TRASH/" 2>/dev/null; done`,
    `echo "MOVED:$(find "$TRASH" -name '*.json' 2>/dev/null | wc -l)"; echo "TRASH:$TRASH"; echo "PROTECTED:$(wc -l < "$T/protected")"`,
    `rm -rf "$T"`,
  ].filter(Boolean).join('; ');
  const out = (await runOn(ctx, inner, SAVE_HEAVY_TIMEOUT)).trim();
  if (out.includes('RUNNING')) return { ok: false, error: 'server_running' };
  const moved = parseInt((out.match(/MOVED:(\d+)/) || [])[1], 10) || 0;
  const trash = (out.match(/TRASH:(\S+)/) || [])[1] || '';
  const protectedCount = parseInt((out.match(/PROTECTED:(\d+)/) || [])[1], 10) || 0;
  return { ok: true, moved, trash, protectedCount };
}

// Fast counts for the loose-item sweep: how many records the category holds, how
// many are protected placed structures (workbench/salvage store), and how many the
// sweep would delete. Read-only — safe while the server is running.
async function scanLooseItems(serverId, category) {
  const cat = safeCategory(category);
  const ctx = await saveOpContext(serverId);
  const inner = [
    `SB='${ctx.saveBase}'; [ -d "$SB" ] || { echo "ALL:0"; echo "PROT:0"; exit 0; }`,
    `echo "ALL:$(find "$SB"/*/gamemode/${cat} -maxdepth 1 -name '*.json' 2>/dev/null | wc -l)"`,
    `echo "PROT:$(find "$SB"/*/gamemode/${cat} -maxdepth 1 -name '*.json' -print0 2>/dev/null | xargs -0 -r grep -lE '"m_rStoreName":[[:space:]]*"(${PROTECTED_STORES_GREP})"' 2>/dev/null | wc -l)"`,
  ].join('; ');
  const out = await runOn(ctx, inner, SAVE_HEAVY_TIMEOUT);
  const total = parseInt((out.match(/ALL:(\d+)/) || [])[1], 10) || 0;
  const protectedCount = parseInt((out.match(/PROT:(\d+)/) || [])[1], 10) || 0;
  return { category: cat, total, protectedCount, prunable: Math.max(0, total - protectedCount) };
}

// Move EVERY record in a category to the recoverable trash EXCEPT those in a
// PROTECTED_STORES store. For Item this clears loose world loot AND stray duplicate
// files. Verified safe (checked against a live DB copy): real stored loot (player
// inventories, base/vehicle storage) is embedded IN FULL inside its parent
// Character/BaseBuilding/Vehicle record — the standalone file in this folder is a
// duplicate copy, so the stored item respawns from the parent either way. Server
// should be stopped; everything moves to a recoverable trash folder. grep -L keys
// the sweep on file CONTENT, so a malformed record is swept, never kept by mistake.
async function purgeLooseItems(serverId, category, force = false) {
  const cat = safeCategory(category);
  const ctx = await saveOpContext(serverId);
  const inner = [
    force ? '' : RUNNING_GUARD(ctx.uuid, ctx.saveBase),
    `SB='${ctx.saveBase}'; [ -d "$SB" ] || { echo "MOVED:0"; exit 0; }`,
    `TS=$(date +%s); TRASH="${ctx.trashBase}/loose-${cat}-$TS"; mkdir -p "$TRASH"`,
    // grep -L = files NOT containing a protected store name — everything to sweep
    `KEPT=0; for W in "$SB"/*/gamemode/${cat}; do [ -d "$W" ] || continue; find "$W" -maxdepth 1 -name '*.json' -print0 2>/dev/null | xargs -0 -r grep -LE '"m_rStoreName":[[:space:]]*"(${PROTECTED_STORES_GREP})"' 2>/dev/null | xargs -d '\\n' -r mv -t "$TRASH" 2>/dev/null; KEPT=$((KEPT + $(find "$W" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l))); done`,
    `echo "MOVED:$(find "$TRASH" -name '*.json' 2>/dev/null | wc -l)"; echo "KEPT:$KEPT"; echo "TRASH:$TRASH"`,
  ].filter(Boolean).join('; ');
  const out = (await runOn(ctx, inner, SAVE_HEAVY_TIMEOUT)).trim();
  if (out.includes('RUNNING')) return { ok: false, error: 'server_running' };
  const moved = parseInt((out.match(/MOVED:(\d+)/) || [])[1], 10) || 0;
  const kept = parseInt((out.match(/KEPT:(\d+)/) || [])[1], 10) || 0;
  const trash = (out.match(/TRASH:(\S+)/) || [])[1] || '';
  return { ok: true, moved, kept, trash };
}

// --- Inactive-character prune (accounts not seen in N days) ---
// lastLogin is a "YYYY-MM-DD HH:MM:SS" string, which sorts chronologically, so we
// compare it as a STRING against the cutoff (one `date` call, no per-record spawn).
// A Player links to its character via .entity.playerEntity. Accounts with a blank
// lastLogin are SKIPPED (never pruned). Only the Character record is moved; the
// Player account/stats are kept, so a returning player just fresh-spawns a body.
function inactiveCharsSnippet(days) {
  return [
    `CUT=$(date -d '${days} days ago' '+%Y-%m-%d %H:%M:%S')`,
    `find "$G/Player" -maxdepth 1 -name '*.json' -print0 2>/dev/null | xargs -0 -r -n300 jq -rc '{c:(.entity.playerEntity//""),l:([.components[]?|objects|.lastLogin//empty]|first//"")}|[.c,.l]|@tsv' 2>/dev/null > "$T/pl"`,
    `awk -F'\\t' -v cut="$CUT" '$2!="" && ($2"")<(cut"") && $1!="" {print $1}' "$T/pl" | sort -u > "$T/chars"`,
  ].join('; ');
}

async function scanInactiveCharacters(serverId, days = 14) {
  const d = Math.min(Math.max(parseInt(days, 10) || 14, 1), 3650);
  const ctx = await saveOpContext(serverId);
  const inner = [
    `SB='${ctx.saveBase}'; G=$(ls -d "$SB"/*/gamemode 2>/dev/null | head -1); [ -d "$G" ] || { echo "PLAYERS:0"; exit 0; }`,
    `T=$(mktemp -d)`,
    inactiveCharsSnippet(d),
    `echo "PLAYERS:$(wc -l < "$T/pl")"`,
    `echo "SKIP:$(awk -F'\\t' '$2==""{c++} END{print c+0}' "$T/pl")"`,
    `echo "INACTIVE:$(wc -l < "$T/chars")"`,
    `B=$(while IFS= read -r c; do f="$G/Character/$c.json"; [ -f "$f" ] && stat -c %s "$f"; done < "$T/chars" | awk '{s+=$1} END{print s+0}'); echo "MB:$((B/1024/1024))"`,
    `rm -rf "$T"`,
  ].join('; ');
  const out = await runOn(ctx, inner, SAVE_HEAVY_TIMEOUT);
  return {
    days: d,
    players: parseInt((out.match(/PLAYERS:(\d+)/) || [])[1], 10) || 0,
    inactive: parseInt((out.match(/INACTIVE:(\d+)/) || [])[1], 10) || 0,
    skipped: parseInt((out.match(/SKIP:(\d+)/) || [])[1], 10) || 0,
    mb: parseInt((out.match(/MB:(\d+)/) || [])[1], 10) || 0,
  };
}

async function purgeInactiveCharacters(serverId, days = 14, force = false) {
  const d = Math.min(Math.max(parseInt(days, 10) || 14, 1), 3650);
  const ctx = await saveOpContext(serverId);
  const inner = [
    force ? '' : RUNNING_GUARD(ctx.uuid, ctx.saveBase),
    `SB='${ctx.saveBase}'; G=$(ls -d "$SB"/*/gamemode 2>/dev/null | head -1); [ -d "$G" ] || { echo "MOVED:0"; exit 0; }`,
    `T=$(mktemp -d); TS=$(date +%s); TRASH="${ctx.trashBase}/inactive-${d}d-$TS"; mkdir -p "$TRASH"`,
    inactiveCharsSnippet(d),
    `moved=0; while IFS= read -r c; do [ -n "$c" ] && mv "$G/Character/$c".json "$TRASH/" 2>/dev/null && moved=$((moved+1)); done < "$T/chars"`,
    `echo "MOVED:$moved"; echo "TRASH:$TRASH"`,
    `rm -rf "$T"`,
  ].filter(Boolean).join('; ');
  const out = (await runOn(ctx, inner, SAVE_HEAVY_TIMEOUT)).trim();
  if (out.includes('RUNNING')) return { ok: false, error: 'server_running' };
  const moved = parseInt((out.match(/MOVED:(\d+)/) || [])[1], 10) || 0;
  const trash = (out.match(/TRASH:(\S+)/) || [])[1] || '';
  return { ok: true, moved, days: d, trash };
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
// Robustness (this used to return nothing for EVERY collection + Exit-1 on big ones):
//  - `//` MUST be spaced: jq 1.7 reads `.x?//y` / `.x//y` glued as the destructuring
//    operator `?//` -> compile error -> zero records.
//  - list to a temp file (no `find | head` SIGPIPE that made the pipeline exit non-zero),
//  - batch jq via `xargs` (no 1-process-per-file storm blowing the SSH timeout),
//  - end on `rm` so the command always exits 0 (sshRun rejects ANY non-zero exit).
const COLLECTION_JQ = '"R:" + ({id:(.id // (input_filename|sub(".*/";"")|rtrimstr(".json"))), prefab:(.spawnData.prefab // ""), coords:(.spawnData.coords // null), store:(.configuration.m_rStoreName // ""), name:([.components[]? | objects | .name // empty] | first // ""), comps:((.components // {}) | length), health:([.components[]? | objects | .hitzones? // empty | .[]? | select(.name=="Health") | .health] | first)} | tojson)';
async function listCollectionRecords(serverId, category, limit = 1000) {
  const cat = safeCategory(category);
  const ctx = await saveOpContext(serverId);
  const cap = Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 3000);
  const inner = [
    `SB='${ctx.saveBase}'`,
    `T=$(mktemp -d)`,
    `find "$SB"/*/gamemode/${cat} -maxdepth 1 -name '*.json' 2>/dev/null > "$T/all"`,
    `echo "TOTAL:$(wc -l < "$T/all")"`,
    `head -${cap} "$T/all" | tr '\\n' '\\0' | xargs -0 -r -n 500 jq -rc '${COLLECTION_JQ}' 2>/dev/null`,
    `rm -rf "$T"`,
  ].join('; ');
  const out = await runOn(ctx, inner, SAVE_HEAVY_TIMEOUT);
  const protectedSet = new Set(PROTECTED_STORES);
  let total = 0; const records = [];
  for (const line of String(out).split('\n')) {
    if (line.startsWith('TOTAL:')) { total = parseInt(line.slice(6), 10) || 0; continue; }
    if (line.startsWith('R:')) {
      try {
        const rec = JSON.parse(line.slice(2));
        rec.protected = protectedSet.has(rec.store);
        records.push(rec);
      } catch {}
    }
  }
  return { category: cat, total, shown: records.length, records, protectedStores: PROTECTED_STORES };
}

// Composition of a collection: counts per store, split by whether records carry
// component data. Lets an admin SEE what a collection is made of (loose stubs vs
// placed structures vs items-with-state) BEFORE deciding to purge. One batched jq pass.
async function getCollectionStats(serverId, category) {
  const cat = safeCategory(category);
  const ctx = await saveOpContext(serverId);
  const inner = [
    `SB='${ctx.saveBase}'; [ -d "$SB" ] || { echo "TOTAL:0"; exit 0; }`,
    `T=$(mktemp -d)`,
    `find "$SB"/*/gamemode/${cat} -maxdepth 1 -name '*.json' 2>/dev/null > "$T/all"`,
    `echo "TOTAL:$(wc -l < "$T/all")"`,
    `tr '\\n' '\\0' < "$T/all" | xargs -0 -r -n 500 jq -rc '(.configuration.m_rStoreName // "none") + "\\t" + (((.components // {}) | length) > 0 | tostring)' 2>/dev/null | sort | uniq -c | sort -rn | while IFS= read -r n rest; do printf 'S:%s:%s\\n' "$n" "$rest"; done`,
    `rm -rf "$T"`,
  ].join('; ');
  const out = await runOn(ctx, inner, SAVE_HEAVY_TIMEOUT);
  const protectedSet = new Set(PROTECTED_STORES);
  let total = 0; const stores = {};
  for (const line of String(out).split('\n')) {
    if (line.startsWith('TOTAL:')) { total = parseInt(line.slice(6), 10) || 0; continue; }
    const m = line.match(/^S:(\d+):(\S+)\t(true|false)$/);
    if (!m) continue;
    const count = parseInt(m[1], 10) || 0;
    const store = m[2];
    const withComps = m[3] === 'true';
    if (!stores[store]) stores[store] = { store, total: 0, withComponents: 0, withoutComponents: 0, protected: protectedSet.has(store) };
    stores[store].total += count;
    if (withComps) stores[store].withComponents += count; else stores[store].withoutComponents += count;
  }
  const list = Object.values(stores).sort((a, b) => b.total - a.total);
  const protectedTotal = list.filter(s => s.protected).reduce((a, s) => a + s.total, 0);
  return { category: cat, total, stores: list, protectedStores: PROTECTED_STORES, protectedTotal };
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

// ---- Full DB copy between servers ----
// Copies the whole persistence save (<volume>/profile/profile/.save — world DB +
// savepoints) from one server to another. The destination must be STOPPED (checked
// with the same two-tier probe destructive ops use); its current .save is kept as
// .save.pre-copy.<ts>. The source may stay live: rsync runs twice, the second
// --delete pass picks up whatever changed during the first.
// A ~300MB copy takes minutes, so the job runs DETACHED (nohup) on the entry host
// (or on the shared remote host when both servers live there) and the HTTP layer
// polls a marker file. Job registry is in-memory: a website restart mid-copy only
// loses the status view, never the copy itself.
const dbCopyJobs = new Map(); // jobId -> { via: 'entry'|serverId, marker, log, from, to, startedAt }

async function startSaveDbCopy(fromId, toId) {
  if (fromId === toId) throw new Error('Source and destination must be different servers');
  const from = await saveOpContext(fromId);
  const to = await saveOpContext(toId);

  if (await getServerRunning(toId)) {
    const e = new Error('destination_running');
    e.code = 'destination_running';
    throw e;
  }

  const onEntry = s => s.region === 'eu';
  const fromRoot = from.saveBase.replace(/\/game$/, '');   // .../profile/profile/.save
  const toRoot = to.saveBase.replace(/\/game$/, '');
  const toProfile = toRoot.replace(/\/\.save$/, '');       // .../profile/profile

  // Topology: the job always runs where it can reach both sides with existing keys.
  // The entry host holds the hop key to the remote nodes, so any pair involving the
  // entry host runs there; a pair sharing one remote host runs nested on that host.
  let via = 'entry';
  let srcSpec = `${fromRoot}/`;
  let dstSpec = `${toRoot}/`;
  let rsyncE = '';
  let dexec = '';
  if (onEntry(from.server) && onEntry(to.server)) {
    // both local to the entry host - plain local rsync
  } else if (onEntry(from.server)) {
    dstSpec = `${to.server.user}@${to.server.host}:${toRoot}/`;
    rsyncE = `-e "ssh -o StrictHostKeyChecking=${SSH_STRICT} -p ${to.server.port}"`;
    dexec = `ssh -o StrictHostKeyChecking=${SSH_STRICT} -o ConnectTimeout=10 -p ${to.server.port} ${to.server.user}@${to.server.host}`;
  } else if (onEntry(to.server)) {
    srcSpec = `${from.server.user}@${from.server.host}:${fromRoot}/`;
    rsyncE = `-e "ssh -o StrictHostKeyChecking=${SSH_STRICT} -p ${from.server.port}"`;
  } else if (from.server.host === to.server.host && from.server.region === to.server.region) {
    via = toId; // shared remote box - run the whole job there with local paths
  } else {
    throw new Error(`Copy from ${fromId} to ${toId} is not supported (servers on different remote hosts)`);
  }

  const jobId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e8).toString(36)}`;
  const log = `/tmp/rz-dbcopy-${jobId}.log`;
  const marker = `/tmp/rz-dbcopy-${jobId}.done`;

  // dex() runs a command on the destination box (via ssh when the job host isn't it).
  // Volume paths are pterodactyl-generated ([a-z0-9-/.]) so plain interpolation is safe.
  const script = [
    `#!/bin/bash`,
    `exec > ${log} 2>&1`,
    `echo "DB copy ${fromId} -> ${toId} started $(date '+%F %T')"`,
    `DEXEC='${dexec}'`,
    `dex() { if [ -n "$DEXEC" ]; then $DEXEC "$1"; else bash -c "$1"; fi; }`,
    `TS=$(date +%s)`,
    `OWN=$(dex "stat -c %u:%g ${toProfile}")`,
    `echo "destination owner: $OWN - backing up current .save as .save.pre-copy.$TS"`,
    `dex "cd ${toProfile} && { [ -d .save ] && mv .save .save.pre-copy.$TS; mkdir -p .save; }"`,
    `echo "rsync pass 1 (bulk)..."`,
    `rsync -a ${rsyncE} ${srcSpec} ${dstSpec}`,
    `R1=$?`,
    `echo "rsync pass 2 (delta + delete)..."`,
    `rsync -a --delete ${rsyncE} ${srcSpec} ${dstSpec}`,
    `R2=$?`,
    `echo "rsync pass1=$R1 pass2=$R2"`,
    `dex "chown -R $OWN ${toProfile}/.save"`,
    `SIZE=$(dex "du -sm ${toProfile}/.save | cut -f1")`,
    `BB=$(dex "find ${toProfile}/.save -path '*gamemode/BaseBuilding*' -name '*.json' 2>/dev/null | wc -l")`,
    `if [ "$R2" = "0" ]; then echo "DONE size=\${SIZE}MB basebuilding=\${BB} backup=.save.pre-copy.\${TS}" > ${marker}; else echo "FAIL rsync exit \${R2} - old destination save preserved at .save.pre-copy.\${TS}" > ${marker}; fi`,
    `echo "finished $(date '+%F %T')"`,
  ].join('\n');

  const scriptB64 = Buffer.from(script, 'utf8').toString('base64');
  const installer = `echo ${scriptB64} | base64 -d > /tmp/rz-dbcopy-${jobId}.sh; chmod +x /tmp/rz-dbcopy-${jobId}.sh; nohup /tmp/rz-dbcopy-${jobId}.sh >/dev/null 2>&1 & sleep 1; echo LAUNCHED`;
  const cmd = via === 'entry' ? installer : wrapForRegion(to.server, installer);

  const conn = await sshOpen(from.privateKey, from.entryHost.host, from.entryHost.port, from.entryHost.user);
  let out;
  try { out = await sshRun(conn, cmd, 30000); } finally { conn.end(); }
  if (!/LAUNCHED/.test(String(out))) throw new Error('Copy job failed to launch');

  dbCopyJobs.set(jobId, { via, marker, log, from: fromId, to: toId, startedAt: Date.now() });
  return { jobId, from: fromId, to: toId };
}

async function getSaveDbCopyStatus(jobId) {
  const job = dbCopyJobs.get(String(jobId));
  if (!job) return { found: false, error: 'Unknown job (website restarted mid-copy?). The copy itself keeps running - check the destination .save on the box.' };

  const probe = `if [ -f ${job.marker} ]; then echo "MARK:$(cat ${job.marker})"; fi; echo "LOGTAIL:"; tail -n 6 ${job.log} 2>/dev/null`;
  const servers = listAllServers();
  const entryHost = servers.find(s => s.region === 'eu') || servers[0];
  const privateKey = getPrivateKey();
  if (!privateKey) throw new Error('SSH key not configured');
  let cmd = probe;
  if (job.via !== 'entry') {
    const viaServer = servers.find(s => s.id === job.via);
    if (!viaServer) throw new Error('Job host no longer configured');
    cmd = wrapForRegion(viaServer, probe);
  }
  const conn = await sshOpen(privateKey, entryHost.host, entryHost.port, entryHost.user);
  let out;
  try { out = await sshRun(conn, cmd, 20000); } finally { conn.end(); }

  const text = String(out);
  const mark = (text.match(/^MARK:(.*)$/m) || [])[1] || null;
  const logTail = (text.split(/^LOGTAIL:\s*$/m)[1] || '').trim();
  let ok = null;
  if (mark) ok = mark.startsWith('DONE');
  return { found: true, done: !!mark, ok, message: mark, logTail, from: job.from, to: job.to, startedAt: job.startedAt };
}

module.exports = { syncPurchasesToServers, buildPriorityQueueGuidsPerServer, searchSaveFiles, listSaveCategories, openSaveDownloadStream, getSaveRecord, getServerRunning, updateSaveRecord, deleteSaveRecords, scanOrphans, purgeOrphans, scanDeadCharacters, purgeDeadCharacters, listPlayers, getExtraStats, listCollectionRecords, getCollectionStats, purgeLooseItems, scanLooseItems, scanInactiveCharacters, purgeInactiveCharacters, startSaveDbCopy, getSaveDbCopyStatus };

// Cosmetic entitlements for the game servers: the Locker (funding plan, 2026-10).
//
// A product with a cosmetic_key (for example 'armband.stripes-red' or 'flag.wolf')
// unlocks that cosmetic in game for the buyer's in-game ID. The purchase sync writes
// the live list to cosmetics.json next to each server's purchases.json, and the mod
// reads it and checks every claim and equip on the server. purchases.json stays
// priority queue only (sync.js explains why): the two files never mix.
//
// Live means a completed live order that has not expired (a one-time purchase has no
// end date and never expires) on an account with an in-game ID. Refunds and staff
// revokes set status 'refunded', so those drop out at the next sync.
//
// Until some product carries a cosmetic_key the sync writes no cosmetics.json at
// all, so shipping this code changes nothing on a game server by itself. From the
// first time one does, it writes the file on every run, an empty list included.
//
// Takes the database as a parameter and does nothing on require
// (test/cosmetics.test.js).

const crypto = require('crypto');

// Lowercase letters, digits, dot, dash and underscore; starts with a letter or digit.
// The mod matches keys exactly, so one spelling rule keeps the two sides in step.
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isCosmeticKey(v) {
  return typeof v === 'string' && KEY_RE.test(v);
}

// The admin form's value: '' or null clears it, anything else must be a valid key.
// Returns { ok, value } so the route can answer 400 with the rule.
function normalizeCosmeticKey(v) {
  if (v === undefined || v === null) return { ok: true, value: null };
  const s = String(v).trim().toLowerCase();
  if (s === '') return { ok: true, value: null };
  return isCosmeticKey(s) ? { ok: true, value: s } : { ok: false, value: null };
}

// Whether a product is delivered to the buyer's in-game ID: priority queue and
// in-game cosmetics are; Discord-only perks (Backer, Supporter) are not. Checkout
// asks for the ID before payment only when this is true.
function deliveredInGame(product) {
  return !!product && (!!product.grants_priority_queue || isCosmeticKey(product.cosmetic_key));
}

function cosmeticsConfigured(db) {
  return !!db.prepare("SELECT 1 FROM products WHERE cosmetic_key IS NOT NULL AND cosmetic_key != '' LIMIT 1").get();
}

// Whether the sync writes cosmetics.json: from the first run that finds a cosmetic
// key, for good. Without the record, clearing the last key would stop the writes and
// leave every server holding the last list it got, ended entitlements included.
function cosmeticsInUse(db, now = Math.floor(Date.now() / 1000)) {
  if (cosmeticsConfigured(db)) {
    db.prepare('INSERT OR IGNORE INTO cosmetics_sync_state (id, first_configured_at) VALUES (1, ?)').run(now);
    return true;
  }
  return !!db.prepare('SELECT 1 FROM cosmetics_sync_state WHERE id = 1').get();
}

// Every server gets the same list (cosmetics are not tied to a server): one entry per
// in-game ID and key, oldest order first, in purchases.json's shape.
function buildCosmeticEntries(db, now = Math.floor(Date.now() / 1000)) {
  const rows = db.prepare(`
    SELECT u.bi_uid AS guid, COALESCE(u.gamertag, u.persona) AS name, p.cosmetic_key AS item
    FROM orders o
    JOIN users u    ON u.steam_id = o.steam_id
    JOIN products p ON p.id = o.product_id
    WHERE o.status = 'completed' AND o.test_mode = 0
      AND p.cosmetic_key IS NOT NULL AND p.cosmetic_key != ''
      AND (o.effective_until IS NULL OR o.effective_until > @now)
      AND u.bi_uid IS NOT NULL AND u.bi_uid != ''
    ORDER BY o.id
  `).all({ now });
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!isCosmeticKey(r.item)) continue;
    const k = `${String(r.guid).toLowerCase()}|${r.item}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ name: r.name || '', guid: r.guid, item: r.item });
  }
  return out;
}

// Base64 characters per command. Each command travels as one argument to the remote
// shell, which Linux caps at 128 KiB, and a server reached through the NA hop gets it
// base64-encoded once more (sync.wrapForRegion), so 32 KiB keeps every command near
// 44 KiB whatever the list's size. One command, in the usual case.
const CHUNK_B64 = 32 * 1024;

// The remote commands that write one server's cosmetics.json, to run in order, each
// as its own SSH command. The content travels base64-encoded in chunks appended to a
// sibling file; the last command decodes it, checks its SHA-256 and only then renames
// it over the target, so a server reading the file sees the old list or the new one,
// never half of one, and a lost chunk leaves the old list in place. The last command
// prints '[cosmetics] <id> OK' only once the rename is done.
function buildWriteCosmeticsCmds(server, json, chunkSize = CHUNK_B64) {
  const b64 = Buffer.from(json).toString('base64');
  const sha = crypto.createHash('sha256').update(json).digest('hex');
  const target = server.path + '/cosmetics.json';
  const tmpPath = target + '.tmp';
  const partPath = target + '.b64';
  const cmds = [];
  for (let i = 0; i < b64.length || i === 0; i += chunkSize) {
    cmds.push(`printf '%s' '${b64.slice(i, i + chunkSize)}' >> '${partPath}'`);
  }
  cmds[0] = `mkdir -p '${server.path}' && : > '${partPath}' && ${cmds[0]}`;
  cmds[cmds.length - 1] = [
    cmds[cmds.length - 1],
    `base64 -d '${partPath}' > '${tmpPath}'`,
    `echo '${sha}  ${tmpPath}' | sha256sum -c --status`,
    `{ chmod --reference='${server.path}/purchases.json' '${tmpPath}' 2>/dev/null || true; }`,
    `mv -f '${tmpPath}' '${target}'`,
    `rm -f '${partPath}'`,
    `echo '[cosmetics] ${server.id} OK'`
  ].join(' && ');
  return cmds;
}

module.exports = {
  CHUNK_B64, isCosmeticKey, normalizeCosmeticKey, deliveredInGame, cosmeticsConfigured, cosmeticsInUse,
  buildCosmeticEntries, buildWriteCosmeticsCmds
};

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
// all, so shipping this code changes nothing on a game server by itself.
//
// Takes the database as a parameter and does nothing on require
// (test/cosmetics.test.js).

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

// The remote command that writes one server's cosmetics.json. Same pattern as
// purchases.json: the content travels base64-encoded, lands in a sibling temp file and
// is renamed over the target, so a server reading it sees the old list or the new one,
// never half of one. Each server confirms on its own line, because the commands are
// chained with ';' and the exit code only reflects the last.
function buildWriteCosmeticsCmd(server, json) {
  const b64 = Buffer.from(json).toString('base64');
  const remotePath = server.path + '/cosmetics.json';
  const tmpPath = remotePath + '.tmp';
  return [
    `mkdir -p '${server.path}'`,
    `echo '${b64}' | base64 -d > '${tmpPath}'`,
    `{ chmod --reference='${server.path}/purchases.json' '${tmpPath}' 2>/dev/null || true; }`,
    `mv -f '${tmpPath}' '${remotePath}'`,
    `echo '[cosmetics] ${server.id} OK'`
  ].join(' && ');
}

module.exports = { isCosmeticKey, normalizeCosmeticKey, deliveredInGame, cosmeticsConfigured, buildCosmeticEntries, buildWriteCosmeticsCmd };

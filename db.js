const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'shop.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Disable SQLite's auto-rewriting of foreign-key references in dependent
// tables when a parent table is renamed. We recreate parent tables in our
// migrations and that auto-rewrite breaks child FKs.
db.pragma('legacy_alter_table = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    steam_id    TEXT PRIMARY KEY,
    persona     TEXT NOT NULL,
    avatar_url  TEXT,
    bi_uid      TEXT,
    role        TEXT NOT NULL DEFAULT 'user',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS products (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    price_cents     INTEGER NOT NULL,
    currency        TEXT NOT NULL DEFAULT 'usd',
    type            TEXT NOT NULL CHECK(type IN ('one_time','subscription')),
    stripe_price_id TEXT,
    image_url       TEXT,
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS orders (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    steam_id                TEXT NOT NULL REFERENCES users(steam_id),
    product_id              INTEGER NOT NULL REFERENCES products(id),
    stripe_session_id       TEXT,
    stripe_subscription_id  TEXT,
    status                  TEXT NOT NULL DEFAULT 'pending',
    amount_cents            INTEGER NOT NULL,
    created_at              INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at            INTEGER
  );
`);

function userHasColumn(name) {
  return db.prepare("PRAGMA table_info(users)").all().some(c => c.name === name);
}

if (!userHasColumn('bi_uid')) {
  db.exec("ALTER TABLE users ADD COLUMN bi_uid TEXT");
}
if (!userHasColumn('platform')) {
  db.exec("ALTER TABLE users ADD COLUMN platform TEXT NOT NULL DEFAULT 'steam'");
}
if (!userHasColumn('gamertag')) {
  db.exec("ALTER TABLE users ADD COLUMN gamertag TEXT");
}
if (!userHasColumn('bm_player_id')) {
  db.exec("ALTER TABLE users ADD COLUMN bm_player_id TEXT");
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_bm_player_id
  ON users(bm_player_id) WHERE bm_player_id IS NOT NULL
`);

function productsNeedsMigration() {
  const cols = db.prepare("PRAGMA table_info(products)").all();
  const hasIntervalDays = cols.some(c => c.name === 'interval_days');
  const hasImagesJson = cols.some(c => c.name === 'images_json');
  if (!hasIntervalDays || !hasImagesJson) return true;
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='products'").get();
  return row && /CHECK\s*\(\s*type\s+IN\s*\(\s*'one_time'\s*,\s*'subscription'\s*\)\s*\)/i.test(row.sql);
}

function productHasColumn(name) {
  return db.prepare("PRAGMA table_info(products)").all().some(c => c.name === name);
}

if (productsNeedsMigration()) {
  db.exec('PRAGMA foreign_keys = OFF');
  const migrate = db.transaction(() => {
    db.exec('ALTER TABLE products RENAME TO products_old');
    db.exec(`
      CREATE TABLE products (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        title           TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        price_cents     INTEGER NOT NULL,
        currency        TEXT NOT NULL DEFAULT 'usd',
        type            TEXT NOT NULL,
        stripe_price_id TEXT,
        image_url       TEXT,
        images_json     TEXT,
        interval_days   INTEGER,
        active          INTEGER NOT NULL DEFAULT 1,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec(`
      INSERT INTO products (id, title, description, price_cents, currency, type, stripe_price_id, image_url, active, created_at, updated_at)
      SELECT id, title, description, price_cents, currency, type, stripe_price_id, image_url, active, created_at, updated_at
      FROM products_old
    `);
    db.exec('DROP TABLE products_old');
  });
  migrate();
  db.exec('PRAGMA foreign_keys = ON');
}

if (!productHasColumn('stock_limit')) {
  db.exec("ALTER TABLE products ADD COLUMN stock_limit INTEGER");
}
if (!productHasColumn('server_specific')) {
  db.exec("ALTER TABLE products ADD COLUMN server_specific INTEGER NOT NULL DEFAULT 0");
}
if (!productHasColumn('grants_priority_queue')) {
  db.exec("ALTER TABLE products ADD COLUMN grants_priority_queue INTEGER NOT NULL DEFAULT 0");
}
if (!productHasColumn('custom_price')) {
  db.exec("ALTER TABLE products ADD COLUMN custom_price INTEGER NOT NULL DEFAULT 0");
}
if (!productHasColumn('price_min_cents')) {
  db.exec("ALTER TABLE products ADD COLUMN price_min_cents INTEGER");
}
if (!productHasColumn('price_max_cents')) {
  db.exec("ALTER TABLE products ADD COLUMN price_max_cents INTEGER");
}
if (!productHasColumn('discord_role_id')) {
  db.exec("ALTER TABLE products ADD COLUMN discord_role_id TEXT");
}
// Optional per-server stock caps for server_specific products, as a JSON map
// of serverId -> limit (e.g. {"eu3":40}). Servers absent from the map fall
// back to the product's shared stock_limit.
if (!productHasColumn('stock_limit_overrides')) {
  db.exec("ALTER TABLE products ADD COLUMN stock_limit_overrides TEXT");
}
if (!userHasColumn('discord_id')) {
  db.exec("ALTER TABLE users ADD COLUMN discord_id TEXT");
}

// PayPal Subscriptions API: cache the live + sandbox catalog-product + plan
// ids per product so checkout doesn't recreate them on every purchase.
if (!productHasColumn('paypal_product_id_live')) {
  db.exec("ALTER TABLE products ADD COLUMN paypal_product_id_live TEXT");
}
if (!productHasColumn('paypal_product_id_test')) {
  db.exec("ALTER TABLE products ADD COLUMN paypal_product_id_test TEXT");
}
if (!productHasColumn('paypal_plan_id_live')) {
  db.exec("ALTER TABLE products ADD COLUMN paypal_plan_id_live TEXT");
}
if (!productHasColumn('paypal_plan_id_test')) {
  db.exec("ALTER TABLE products ADD COLUMN paypal_plan_id_test TEXT");
}

// Monthly expense buckets that the Finances tab subtracts from the Stripe balance.
db.exec(`
  CREATE TABLE IF NOT EXISTS monthly_expenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    note        TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// Manual priority-queue grants (admin-page driven, no Stripe payment).
// (guid, server_id) is unique. server_id is one of eu1/eu2/na1/na2.
db.exec(`
  CREATE TABLE IF NOT EXISTS priority_queue_grants (
    guid          TEXT NOT NULL,
    server_id     TEXT NOT NULL,
    display_name  TEXT,
    granted_by    TEXT,
    granted_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (guid, server_id)
  )
`);

// Manual PQ grants gain an optional expiry (NULL = permanent). Lets the admin page
// show "expires on X" and extend it, instead of the old hack of typing a
// "Remove DD/MM/YYYY" reminder into display_name. Sync honours it (expired = removed).
if (!db.prepare("PRAGMA table_info(priority_queue_grants)").all().some(c => c.name === 'expires_at')) {
  db.exec("ALTER TABLE priority_queue_grants ADD COLUMN expires_at INTEGER");
}

// A "deny" row (removed=1) hides a server for a guid even when a PURCHASE grants it — lets
// admins toggle purchase-driven servers off / switch them, exactly like manual grants,
// WITHOUT touching the order. removed=0 (default) = a normal grant.
if (!db.prepare("PRAGMA table_info(priority_queue_grants)").all().some(c => c.name === 'removed')) {
  db.exec("ALTER TABLE priority_queue_grants ADD COLUMN removed INTEGER NOT NULL DEFAULT 0");
}

// Tracks the set of GUIDs the shop last wrote into each server's
// config.json game.admins array. Used so the shop only ever
// adds/removes its OWN contributed GUIDs — real GMs added via the
// admin page are never touched.
db.exec(`
  CREATE TABLE IF NOT EXISTS config_admin_sync_state (
    server_id              TEXT PRIMARY KEY,
    previously_owned_json  TEXT NOT NULL DEFAULT '[]',
    updated_at             INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// Count of admins in each server's game.admins that the shop did NOT put there
// (GMs + the owner). Recorded on every sync so the shop can cap priority-queue
// stock at (admin ceiling - GMs) and never push game.admins past the 50 limit.
if (!db.prepare("PRAGMA table_info(config_admin_sync_state)").all().some(c => c.name === 'non_shop_admin_count')) {
  db.exec("ALTER TABLE config_admin_sync_state ADD COLUMN non_shop_admin_count INTEGER NOT NULL DEFAULT 0");
}

// Repair: an earlier migration of `products` had SQLite's
// auto-rewrite-of-references behavior on, which silently rewrote
// orders.product_id's FK target to `products_old`. After that table
// was dropped, INSERTs into orders fail with "no such table: products_old".
// Recreate orders with the correct FK if we detect this.
const ordersSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get();
if (ordersSchema && /products_old/i.test(ordersSchema.sql)) {
  db.exec('PRAGMA foreign_keys = OFF');
  const repair = db.transaction(() => {
    db.exec(`
      CREATE TABLE orders_new (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        steam_id                TEXT NOT NULL REFERENCES users(steam_id),
        product_id              INTEGER NOT NULL REFERENCES products(id),
        stripe_session_id       TEXT,
        stripe_subscription_id  TEXT,
        status                  TEXT NOT NULL DEFAULT 'pending',
        amount_cents            INTEGER NOT NULL,
        created_at              INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at            INTEGER
      )
    `);
    db.exec(`
      INSERT INTO orders_new (id, steam_id, product_id, stripe_session_id, stripe_subscription_id, status, amount_cents, created_at, completed_at)
      SELECT id, steam_id, product_id, stripe_session_id, stripe_subscription_id, status, amount_cents, created_at, completed_at
      FROM orders
    `);
    db.exec('DROP TABLE orders');
    db.exec('ALTER TABLE orders_new RENAME TO orders');
  });
  repair();
  db.exec('PRAGMA foreign_keys = ON');
  console.log('[db] Repaired orders.product_id FK reference');
}

function orderHasColumn(name) {
  return db.prepare("PRAGMA table_info(orders)").all().some(c => c.name === name);
}

if (!orderHasColumn('server_id')) {
  db.exec("ALTER TABLE orders ADD COLUMN server_id TEXT");
}
if (!orderHasColumn('test_mode')) {
  db.exec("ALTER TABLE orders ADD COLUMN test_mode INTEGER NOT NULL DEFAULT 0");
}
// PayPal columns (provider swap from Stripe). The old stripe_* columns stay
// for historical orders; new orders populate the paypal_* ones.
if (!orderHasColumn('paypal_order_id')) {
  db.exec("ALTER TABLE orders ADD COLUMN paypal_order_id TEXT");
}
if (!orderHasColumn('paypal_capture_id')) {
  db.exec("ALTER TABLE orders ADD COLUMN paypal_capture_id TEXT");
}
if (!orderHasColumn('payer_email')) {
  db.exec("ALTER TABLE orders ADD COLUMN payer_email TEXT");
}
if (!orderHasColumn('fee_cents')) {
  db.exec("ALTER TABLE orders ADD COLUMN fee_cents INTEGER");
}
if (!orderHasColumn('paypal_subscription_id')) {
  db.exec("ALTER TABLE orders ADD COLUMN paypal_subscription_id TEXT");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_orders_paypal_sub ON orders(paypal_subscription_id) WHERE paypal_subscription_id IS NOT NULL");

// When a recurring subscription cycle was paid, this records the unix
// timestamp the buyer's entitlement is valid through (= the next-billing
// time PayPal reported when the cycle was created or when the sub was
// cancelled). NULL = no expiry (one-time purchases, legacy rows). PQ sync
// honours effective_until so cancelled-mid-cycle subs keep their queue
// skip through the end of the period they already paid for.
if (!orderHasColumn('effective_until')) {
  db.exec("ALTER TABLE orders ADD COLUMN effective_until INTEGER");
}

// Generic slot for custom-checkout product types (currently just
// custom_flag) to stash the extra fields a buyer submitted, as JSON —
// e.g. { playerName, playerAlias, guid, discordId }. NULL for every
// ordinary order. custom_file_path is the path (relative to the
// uploads/ dir) of any file they submitted alongside it.
if (!orderHasColumn('custom_fields_json')) {
  db.exec("ALTER TABLE orders ADD COLUMN custom_fields_json TEXT");
}
if (!orderHasColumn('custom_file_path')) {
  db.exec("ALTER TABLE orders ADD COLUMN custom_file_path TEXT");
}

// Self-healing backfill: Stripe session IDs encode their environment in
// the prefix (cs_test_* vs cs_live_*), so any order still flagged as live
// with a cs_test_ session is sandbox pollution that should be hidden from
// rollups.
{
  const result = db.prepare(
    "UPDATE orders SET test_mode = 1 WHERE test_mode = 0 AND stripe_session_id LIKE 'cs_test_%'"
  ).run();
  if (result.changes > 0) console.log(`[db] Marked ${result.changes} legacy test-mode order(s)`);
}

function expenseHasColumn(name) {
  return db.prepare("PRAGMA table_info(monthly_expenses)").all().some(c => c.name === name);
}
if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='monthly_expenses'").get()) {
  if (!expenseHasColumn('kind')) {
    db.exec("ALTER TABLE monthly_expenses ADD COLUMN kind TEXT NOT NULL DEFAULT 'monthly'");
  }
  if (!expenseHasColumn('incurred_at')) {
    db.exec("ALTER TABLE monthly_expenses ADD COLUMN incurred_at INTEGER");
  }
  if (!expenseHasColumn('tax_cents')) {
    db.exec("ALTER TABLE monthly_expenses ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0");
  }
}

module.exports = db;

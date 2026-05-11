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

module.exports = db;

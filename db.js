const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'shop.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

// Migration: add bi_uid column if missing
try {
  db.prepare("SELECT bi_uid FROM users LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE users ADD COLUMN bi_uid TEXT");
}

module.exports = db;

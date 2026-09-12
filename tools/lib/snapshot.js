// Consistent copies of a live SQLite database. The shop runs in WAL mode, so a
// plain file copy can miss committed rows still sitting in the -wal file;
// VACUUM INTO writes a single self-contained file from a read transaction and
// never blocks the running app.
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');

function snapshotDb(srcPath, destPath) {
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  const src = new Database(srcPath, { readonly: true });
  try {
    // VACUUM INTO takes a literal path; escape single quotes for safety.
    src.exec(`VACUUM INTO '${String(destPath).replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  return destPath;
}

function integrityCheck(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    const msg = rows.map(r => r.integrity_check).join('; ');
    return { ok: msg === 'ok', message: msg };
  } finally {
    db.close();
  }
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

// Row counts that describe a shop database at a glance. Read-only.
function describeDb(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const one = (sql) => { try { return db.prepare(sql).get().c; } catch { return null; } };
    return {
      users: one('SELECT COUNT(*) c FROM users'),
      orders: one('SELECT COUNT(*) c FROM orders'),
      completedOrders: one("SELECT COUNT(*) c FROM orders WHERE status='completed'"),
      activeEntitlements: one("SELECT COUNT(*) c FROM orders WHERE status='completed' AND (effective_until IS NULL OR effective_until > unixepoch())"),
      products: one('SELECT COUNT(*) c FROM products'),
      activeProducts: one('SELECT COUNT(*) c FROM products WHERE active=1'),
      priorityQueueGrants: one('SELECT COUNT(*) c FROM priority_queue_grants'),
      openBillingIssues: one('SELECT COUNT(*) c FROM subscription_billing_issues WHERE resolved_at IS NULL'),
      roleEvents: one('SELECT COUNT(*) c FROM discord_role_events'),
      accounts: one('SELECT COUNT(*) c FROM accounts')
    };
  } finally {
    db.close();
  }
}

module.exports = { snapshotDb, integrityCheck, sha256File, describeDb };

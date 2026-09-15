const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { syncPurchasesToServers, searchSaveFiles, listSaveCategories, openSaveDownloadStream, getSaveRecord, getServerRunning, updateSaveRecord, deleteSaveRecords, scanOrphans, purgeOrphans, scanDeadCharacters, purgeDeadCharacters, listPlayers, getExtraStats, listCollectionRecords, getCollectionStats, purgeLooseItems, scanLooseItems, scanInactiveCharacters, purgeInactiveCharacters, startSaveDbCopy, getSaveDbCopyStatus } = require('../sync');
const { SERVER_IDS, SELLABLE_SERVER_IDS, SERVER_LABELS, isSaveServerId, listSaveServers } = require('../gameServers');
const discord = require('../discord');
const consoleIdentity = require('../consoleIdentity');
const webAuth = require('../webAuth');
const pqGuards = require('../pqGuards');
const pqEntitlement = require('../pqEntitlement');
const { adminActor, staffSetBiUid } = require('../adminAudit');
const { postCard, buildCard, sendCard } = require('../tools/lib/discordCard');
const cards = require('../paymentCards');
const paymentEvents = require('../paymentEvents');
const staffRevoke = require('../staffRevoke');
const funnel = require('../funnel');
const inGameId = require('../inGameId');
const { windowLimit } = require('../windowLimit');
const reminders = require('../tools/reminders');
const reconcile = require('../tools/reconcile');

// ---- PayPal setup ----
const paypal = require('../paypal');
const { describeNextRestart, RESTART_UTC_HOURS } = require('../restartSchedule');
const { sendInvoice, sendSubscriptionInvite, sendSubscriptionCancelled, sendSubscriptionSuspended, sendRefundConfirmation, sendCustomFlagConfirmation, sendPaymentFailed, sendPaymentRefused } = require('../invoiceMail');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Resolved on boot by server.js calling registerPayPalWebhooks(); read at
// verify time. { live, sandbox } webhook ids.
const paypalWebhookIds = {
  live: process.env.PAYPAL_WEBHOOK_ID || null,
  sandbox: process.env.PAYPAL_TEST_WEBHOOK_ID || null
};
function setWebhookId(testMode, id) { paypalWebhookIds[testMode ? 'sandbox' : 'live'] = id; }
function getWebhookId(testMode) { return paypalWebhookIds[testMode ? 'sandbox' : 'live']; }

// ---- Discord webhook ----
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// ---- Custom Flag product (custom checkout: extra fields + an image) ----
// Uploads live outside public/ (not statically servable) since flag
// submissions aren't meant to be publicly browsable by URL guessing —
// staff view them via the admin endpoint below or the Discord post.
const CUSTOM_FLAG_UPLOAD_DIR = require('../dataDir').dataPath('uploads', 'custom-flags');
fs.mkdirSync(CUSTOM_FLAG_UPLOAD_DIR, { recursive: true });
const CUSTOM_FLAG_MAX_BYTES = 16 * 1024 * 1024;
const CUSTOM_FLAG_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg' };
// The #shop support-ticket channel, linked from the confirmation email/
// onscreen message so buyers know where to follow up with their design.
const CUSTOM_FLAG_TICKET_URL = 'https://discord.com/channels/1352364195211120660/1361079415324410026';

// #Payment-Processor (Owner's category). Staff-only, so it can carry payer
// emails and PayPal ids that must never reach a public channel.
//
// Note this is the SAME channel DISCORD_WEBHOOK_URL ("ReforgedZ Payments")
// already posts purchase notifications to. Billing alerts go out through that
// webhook so everything payment-related in the channel comes from one
// identity; this id is only the fallback target when no webhook is set.
const PAYMENT_PROCESSOR_CHANNEL_ID =
  process.env.DISCORD_PAYMENT_CHANNEL_ID || '1481277655826305204';

const customFlagUpload = multer({
  storage: multer.memoryStorage(),
  // fieldArrayIndexLimit 0: the flag form sends no bracketed field names, and without
  // it one request with names like b[4294967294] freezes the whole process for about a
  // minute (multer GHSA-535w). multer 2.3.0 or later is needed for the option to count.
  limits: { fileSize: CUSTOM_FLAG_MAX_BYTES, fieldArrayIndexLimit: 0 },
  fileFilter: (req, file, cb) => {
    const ok = Object.prototype.hasOwnProperty.call(CUSTOM_FLAG_MIME_EXT, file.mimetype);
    cb(ok ? null : new Error('INVALID_FILE_TYPE'), ok);
  }
}).single('flagImage');

// Wraps multer so its errors come back as the same JSON error shape every
// other checkout error uses, instead of falling through to Express's
// default HTML error page.
function handleCustomFlagUpload(req, res, next) {
  customFlagUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Flag image is too large (max 16MB).' });
    }
    if (err.message === 'INVALID_FILE_TYPE') {
      return res.status(400).json({ error: 'Flag image must be a PNG or JPG.' });
    }
    console.error('[custom-flag] upload error:', err.message);
    return res.status(400).json({ error: 'Upload failed. Please try again.' });
  });
}

// Validate an upload by its real magic bytes, not the client-supplied MIME
// header (which is trivially spoofable). Returns 'png' | 'jpg' | null.
function detectImageExt(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';           // \x89PNG
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';                               // JFIF/EXIF
  return null;
}

// The name to call a player by, or null. A website account is "Player" until its
// in-game ID is found, which is no name at all.
function playerNameOf(u) {
  if (!u) return null;
  const persona = u.persona && u.persona !== webAuth.DEFAULT_PERSONA ? u.persona : null;
  return persona || u.gamertag || null;
}

// Staff cards about orders go through paymentCards.js (what each card says) and
// tools/lib/discordCard.js (layout, colour, who is notified, posting). One title
// per PayPal outcome: they once shared "Subscription Cancelled", which had staff
// reading a wave of payment-failure suspensions as players walking away.

function parseImagesJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(s => typeof s === 'string' && s.trim()) : [];
  } catch { return []; }
}

function attachImages(product) {
  if (!product) return product;
  product.images = parseImagesJson(product.images_json);
  return product;
}

const stockUsedStmt = db.prepare(`
  SELECT COUNT(DISTINCT steam_id) AS used
  FROM orders
  WHERE product_id = ? AND status = 'completed'
`);

const perServerStockUsedStmt = db.prepare(`
  SELECT server_id, COUNT(DISTINCT steam_id) AS used
  FROM orders
  WHERE product_id = ? AND status = 'completed' AND server_id IS NOT NULL
  GROUP BY server_id
`);

function stockUsedFor(productId) {
  return stockUsedStmt.get(productId).used;
}

// Guard against a single buyer firing many concurrent checkout requests to
// slip past the sold-out check (a TOCTOU race): one live pending order per
// (buyer, product) at a time. Completed orders are unaffected (renewals etc.).
const recentPendingStmt = db.prepare(`
  SELECT id FROM orders
  WHERE steam_id = ? AND product_id = ? AND status = 'pending' AND created_at > ?
  LIMIT 1
`);
function hasLivePendingOrder(steamId, productId) {
  const cutoff = Math.floor(Date.now() / 1000) - PENDING_TIMEOUT_SECONDS;
  return !!recentPendingStmt.get(steamId, productId, cutoff);
}

function perServerStockUsed(productId) {
  const out = Object.fromEntries(SERVER_IDS.map(id => [id, 0]));
  for (const row of perServerStockUsedStmt.all(productId)) {
    if (row.server_id in out) out[row.server_id] = row.used;
  }
  return out;
}

// Per-server stock cap for a server_specific product: the optional
// stock_limit_overrides JSON map ({serverId: limit}), else the shared stock_limit.
const effectiveStockLimit = pqEntitlement.stockCapFor;

// excludeSteamId: the signed-in viewer, whose own checkouts waiting at PayPal are left
// out of the stock they see, exactly as checkout leaves them out.
function attachStock(product, { excludeSteamId = null } = {}) {
  if (!product) return product;
  if (product.server_specific) {
    const isPq = !!product.grants_priority_queue;
    product.per_server_limit = {};      // the configured cap (display denominator)
    product.per_server_available = {};  // how many can still be sold (numerator)
    if (isPq) {
      // Priority queue stock is the admin list itself (pqEntitlement.pqSlotsPerServer):
      // used is the IDs holding priority queue there by the one rule, the real limit
      // is min(cap, ADMIN_CEILING - game masters) so priority queue plus game masters
      // never pass the ceiling, and a checkout waiting at PayPal holds its slot for a
      // while. The checkout refuses on the same numbers.
      const slots = pqEntitlement.pqSlotsPerServer(db, { product, now: Math.floor(Date.now() / 1000), excludeSteamId });
      product.per_server_used = {};
      for (const id of SERVER_IDS) {
        const s = slots[id];
        product.per_server_used[id] = s.used;
        product.per_server_limit[id] = s.cap;
        product.per_server_available[id] = s.cap == null ? null : s.available;
      }
    } else {
      product.per_server_used = perServerStockUsed(product.id);
      for (const id of SERVER_IDS) {
        const cap = effectiveStockLimit(product, id);
        product.per_server_limit[id] = cap;
        product.per_server_available[id] = cap == null ? null : Math.max(0, cap - (product.per_server_used[id] || 0));
      }
    }
    product.stock_used = Object.values(product.per_server_used).reduce((a, b) => a + b, 0);
    product.sold_out = false;
  } else {
    product.stock_used = stockUsedFor(product.id);
    product.sold_out = product.stock_limit != null && product.stock_used >= product.stock_limit;
  }
  return product;
}

// Stale-pending sweeper. Pending orders older than this are auto-cancelled.
// A payment that lands after the sweep still fulfils: fulfillOrder() accepts a
// 'cancelled' row precisely so a slow checkout can't cost someone their order.
//
// Orders already handed to PayPal are left alone regardless of age — once a
// subscription or order id is attached the buyer is mid-checkout on PayPal's
// side, and cancelling underneath them is what caused paid orders to sit
// 'cancelled'. Only rows that never reached PayPal are swept.
const PENDING_TIMEOUT_SECONDS = 5 * 60;
const SWEEPER_INTERVAL_MS = 5 * 60 * 1000;

const sweepStmt = db.prepare(`
  UPDATE orders SET status = 'cancelled'
  WHERE status = 'pending' AND created_at < ?
    AND paypal_subscription_id IS NULL
    AND paypal_order_id IS NULL
    AND paypal_capture_id IS NULL
`);

function sweepStalePending() {
  const cutoff = Math.floor(Date.now() / 1000) - PENDING_TIMEOUT_SECONDS;
  const result = sweepStmt.run(cutoff);
  if (result.changes > 0) {
    console.log(`[orders] Auto-cancelled ${result.changes} stale pending order(s)`);
  }
}

sweepStalePending();
setInterval(sweepStalePending, SWEEPER_INTERVAL_MS);

// Reap orphaned custom-flag uploads. A cancelled order's image is dead weight
// (a paid-after-cancel order is flipped back to 'completed' by the webhook, so
// anything still 'cancelled' an hour later will never be needed). Unlink the
// file and clear the column so it isn't reaped twice — prevents unbounded disk
// growth from abandoned/malicious checkout loops.
const ORPHAN_FILE_GRACE_SECONDS = 60 * 60;
const reapOrphanStmt = db.prepare(`
  SELECT id, custom_file_path FROM orders
  WHERE status = 'cancelled' AND custom_file_path IS NOT NULL AND created_at < ?
`);
const clearFilePathStmt = db.prepare("UPDATE orders SET custom_file_path = NULL WHERE id = ?");
function reapOrphanUploads() {
  const cutoff = Math.floor(Date.now() / 1000) - ORPHAN_FILE_GRACE_SECONDS;
  let reaped = 0;
  for (const row of reapOrphanStmt.all(cutoff)) {
    // basename() defends against any traversal in a stored path.
    try { fs.unlinkSync(path.join(CUSTOM_FLAG_UPLOAD_DIR, path.basename(row.custom_file_path))); } catch {}
    clearFilePathStmt.run(row.id);
    reaped++;
  }
  if (reaped > 0) console.log(`[orders] Reaped ${reaped} orphaned custom-flag upload(s)`);
}
reapOrphanUploads();
setInterval(reapOrphanUploads, SWEEPER_INTERVAL_MS);

// Whenever a subscription cycle's effective_until just crossed into the past, or
// a subscription's renewal window just closed (pqEntitlement.RENEWAL_WINDOW_S),
// re-run the purchase sync so the GUID drops out of game.admins. No state change
// to the order row: the sync's rule (pqEntitlement.js) handles the entitlement;
// status stays 'completed' so revenue stats still see it.
// Starting this at "now" would silently skip any cycle that lapsed while the
// process was down -- deploys land in that window. Back-date one sweep
// interval so a restart re-examines the period it missed. The sync and the
// reconcile are both idempotent, so an overlapping re-check costs nothing.
let lastEffectiveSweepUnix = Math.floor(Date.now() / 1000) - 15 * 60;
function sweepExpiredEntitlements() {
  const now = Math.floor(Date.now() / 1000);
  const just = db.prepare(`
    SELECT COUNT(*) AS c FROM orders
    WHERE status = 'completed'
      AND effective_until IS NOT NULL
      AND ((effective_until <= @now AND effective_until > @last)
        OR (paypal_subscription_id IS NOT NULL
          AND effective_until + @window <= @now AND effective_until + @window > @last))
  `).get({ now, last: lastEffectiveSweepUnix, window: pqEntitlement.RENEWAL_WINDOW_S }).c;
  lastEffectiveSweepUnix = now;
  if (just > 0) {
    console.log(`[orders] ${just} subscription cycle(s) just lapsed — re-syncing`);
    syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
    // In-game access is filtered by the sync above, but the Discord role is
    // only ever removed by an explicit event -- and a lapse is not one. Without
    // this, an expired subscriber keeps their role indefinitely.
    startRoleReconcile({});
  }
}
setInterval(sweepExpiredEntitlements, 5 * 60 * 1000);

// Periodic re-sync so each server's recorded GM count (which the PQ stock math
// subtracts from the admin ceiling) stays fresh even with no purchase activity.
setInterval(() => syncPurchasesToServers().catch(e => console.error('[sync periodic] Error:', e.message)), 10 * 60 * 1000);
// And once shortly after boot, so a restart does not leave the game servers up to ten
// minutes behind (or turn the morning health card amber for no reason).
setTimeout(() => syncPurchasesToServers().catch(e => console.error('[sync boot] Error:', e.message)), 60 * 1000);

// ---- Middleware helpers ----
function requireAuth(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Sign in required' });
  next();
}

// Constant-time compare so the shared admin key can't be recovered byte-by-byte
// via response-timing analysis.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireAdmin(req, res, next) {
  // Audit trail: every state-changing admin action is attributed, and every
  // rejection is logged with its source IP so probing / key brute-forcing is
  // visible. GETs are read-only and would just be noise, so only log writes.
  const auditWrite = (actor) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      console.log(`[admin-audit] ${actor} ${req.method} ${req.originalUrl} from ${req.ip}`);
    }
  };
  if (req.isAuthenticated() && req.user.role === 'admin') {
    auditWrite(`steam:${req.user.steam_id}`);
    return next();
  }
  // Shared-secret fallback used by the reforgedz admin page backend.
  const apiKey = req.headers['x-shop-admin-key'];
  if (apiKey && process.env.SHOP_ADMIN_API_KEY && safeEqual(apiKey, process.env.SHOP_ADMIN_API_KEY)) {
    auditWrite('apikey');
    return next();
  }
  console.warn(`[admin-audit] DENIED ${req.method} ${req.originalUrl} from ${req.ip}`);
  return res.status(403).json({ error: 'Admin access required' });
}

// ============================================================
//  Public endpoints
// ============================================================

// Get active products
router.get('/api/shop/products', (req, res) => {
  const products = db.prepare(`
    SELECT id, title, description, price_cents, currency, type, image_url, images_json, interval_days, stock_limit, stock_limit_overrides, server_specific, grants_priority_queue, custom_price, price_min_cents, price_max_cents, discord_role_id, active
    FROM products WHERE active = 1 ORDER BY created_at DESC
  `).all();
  // Stock depends on who is looking (a buyer's own checkout at PayPal holds no slot
  // against them), so the answer is never shared between viewers.
  const viewer = req.isAuthenticated && req.isAuthenticated() && req.user ? req.user.steam_id : null;
  res.set('Cache-Control', 'private, no-cache');
  res.json(products.map(p => attachStock(attachImages(p), { excludeSteamId: viewer })));
});

// Payment provider config (PayPal). The redirect flow means the browser
// doesn't need a client token — it just follows the approve URL we return
// from /checkout. Kept for the frontend to know the provider + env.
// Which commit is serving this domain. The doctor compares it with the
// checkout it runs from, which is how a half-finished move shows itself.
router.get('/api/shop/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ sha: require('../tools/lib/version').gitSha(), node: process.version });
});

router.get('/api/shop/config', (req, res) => {
  const testMode = req.query.test === '1';
  res.json({
    provider: 'paypal',
    env: testMode ? 'sandbox' : 'live',
    configured: paypal.isConfigured(testMode),
    // Shown on the Custom Flag confirmation screen/email. Never hardcoded —
    // set CUSTOM_FLAG_TUTORIAL_URL when a real video exists; until then the
    // frontend shows the placeholder string as-is.
    customFlagTutorialUrl: process.env.CUSTOM_FLAG_TUTORIAL_URL || null,
    customFlagTicketUrl: CUSTOM_FLAG_TICKET_URL,
    // The game reads its admin list only at start, so queue priority begins at
    // the next of these (UTC hours). The confirmation page says when.
    restartUtcHours: RESTART_UTC_HOURS,
    // Whether the Connect Discord button can be shown (OAuth credentials set).
    discordOAuth: discordOAuthConfigured()
  });
});

// Create a PayPal checkout order and return the approve URL to redirect to.
router.post('/api/shop/checkout', requireAuth, async (req, res) => {
  const { productId, testMode, serverId, customAmountCents, confirmSharedId } = req.body;
  if (!productId) return res.status(400).json({ error: 'Missing productId' });

  // Only admins can use test mode (sandbox). Checked after the product, so a
  // player is told what their purchase needs before anything about PayPal.
  const useTest = testMode && req.user.role === 'admin';

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  // Custom Flag needs extra fields + an image upload that this plain-JSON
  // endpoint can't carry — it has its own multipart checkout below.
  if (product.type === 'custom_flag') {
    return res.status(400).json({ error: 'This product needs additional details — use the Custom Flag checkout form.' });
  }

  // Queue priority is delivered to an in-game id. Taking the money first and
  // asking later left paid orders with nowhere to deliver (#106 and #675, found
  // 2026-09-14), so the id comes first.
  if (product.grants_priority_queue && !req.user.bi_uid) {
    return res.status(400).json({ code: 'needs_in_game_id', error: 'Add your in-game ID first, so your priority queue has somewhere to go.' });
  }

  // Only a server the shop offers. dev1 is synced to but never sold, so naming it
  // here could only come from a crafted request.
  let orderServerId = null;
  if (product.server_specific) {
    if (!SELLABLE_SERVER_IDS.includes(serverId)) {
      return res.status(400).json({ error: 'Pick a server for this purchase.' });
    }
    orderServerId = serverId;
  }

  const isRecurring = product.type === 'subscription' || product.type === 'recurring_custom';

  // A second priority queue subscription for the same server. pqGuards.js says
  // what each check catches, and why the in-game ID one only asks.
  let sharedIdConfirmed = false;
  if (product.grants_priority_queue && isRecurring) {
    const now = Math.floor(Date.now() / 1000);
    const live = pqGuards.ownLiveSubscription(db, { steamId: req.user.steam_id, serverId: orderServerId, testMode: useTest, now });
    if (live) {
      const labelId = orderServerId || (live.server_specific ? live.server_id : null);
      const label = labelId ? (SERVER_LABELS[labelId] || labelId.toUpperCase()) : 'every server';
      funnel.countStep(db, 'checkout_blocked_duplicate');
      return res.status(409).json(pqGuards.alreadySubscribedRefusal(live, label));
    }
    if (pqGuards.otherAccountLivePq(db, { steamId: req.user.steam_id, biUid: req.user.bi_uid, now })) {
      if (confirmSharedId !== true) {
        console.log(`[pq-guard] ${req.user.steam_id}: in-game ID ${String(req.user.bi_uid).slice(0, 8)}... already has live priority queue on another account (buying ${orderServerId || 'all servers'}); asked to confirm`);
        funnel.countStep(db, 'checkout_blocked_duplicate');
        return res.status(409).json(pqGuards.sharedIdRefusal());
      }
      sharedIdConfirmed = true;
    }
  }

  if (product.server_specific) {
    if (product.grants_priority_queue) {
      // Priority queue is gated on the admin list itself (pqEntitlement.pqSlotFree):
      // the IDs holding priority queue there plus checkouts still waiting at PayPal,
      // against min(cap, ADMIN_CEILING - game masters). A waiting checkout holds its
      // slot, so two buyers cannot both approve the last one. The buyer's own waiting
      // checkouts are left out, so an abandoned one cannot lock them out.
      //
      // A renewal (this account already holds priority queue here) takes no new slot,
      // so it may buy on a full server. Keyed on the account's own orders, not on the
      // in-game ID: anyone can set their ID to a current holder's, buy "as a renewal",
      // then change the ID back and take a new slot.
      const now = Math.floor(Date.now() / 1000);
      const slot = pqEntitlement.pqSlotFree(db, { serverId, now, product, excludeSteamId: req.user.steam_id });
      if (!slot.free && !pqEntitlement.accountHoldsPq(db, { steamId: req.user.steam_id, serverId, now })) {
        return res.status(409).json({ error: `Sold out on ${SERVER_LABELS[serverId] || serverId.toUpperCase()}.` });
      }
    } else {
      const effLimit = effectiveStockLimit(product, serverId);
      if (effLimit != null) {
        const used = perServerStockUsed(product.id)[serverId] || 0;
        const alreadyHas = !!db.prepare(`
          SELECT 1 FROM orders WHERE product_id = ? AND server_id = ? AND steam_id = ? AND status = 'completed' LIMIT 1
        `).get(product.id, serverId, req.user.steam_id);
        if (used >= effLimit && !alreadyHas) {
          return res.status(409).json({ error: `Sold out on ${SERVER_LABELS[serverId] || serverId.toUpperCase()}.` });
        }
      }
    }
  } else if (product.stock_limit != null) {
    const used = stockUsedFor(product.id);
    if (used >= product.stock_limit) {
      const buyerInCount = db.prepare(`
        SELECT 1 FROM orders WHERE product_id = ? AND steam_id = ? AND status = 'completed' LIMIT 1
      `).get(product.id, req.user.steam_id);
      if (!buyerInCount) {
        return res.status(409).json({ error: 'This item is sold out.' });
      }
    }
  }

  // Resolve the price for this checkout. Custom-priced products let the
  // buyer pick any amount within [price_min_cents, price_max_cents].
  let amountCents = product.price_cents;
  if (product.custom_price) {
    const requested = parseInt(customAmountCents, 10);
    if (!Number.isFinite(requested)) {
      return res.status(400).json({ error: 'Pick an amount to pay.' });
    }
    if (product.price_min_cents != null && requested < product.price_min_cents) {
      return res.status(400).json({ error: `Minimum is $${(product.price_min_cents / 100).toFixed(2)}.` });
    }
    if (product.price_max_cents != null && requested > product.price_max_cents) {
      return res.status(400).json({ error: `Maximum is $${(product.price_max_cents / 100).toFixed(2)}.` });
    }
    if (requested < 100) {
      return res.status(400).json({ error: 'Minimum charge is $1.00.' });
    }
    amountCents = requested;
  }

  // A priority queue checkout handed to PayPal holds a slot for a while, so an account
  // that keeps starting them without finishing is told to come back later
  // (pqEntitlement.unfinishedPqCheckouts). Sandbox checkouts are not limited.
  if (product.grants_priority_queue && isRecurring && !useTest) {
    const started = pqEntitlement.unfinishedPqCheckouts(db, { steamId: req.user.steam_id, now: Math.floor(Date.now() / 1000) });
    if (started >= pqEntitlement.PQ_CHECKOUTS_PER_DAY) {
      console.warn(`[pq-guard] ${req.user.steam_id}: ${started} unfinished priority queue checkouts in the last day, another refused`);
      return res.status(429).json({
        code: 'too_many_checkouts',
        error: 'You have started several priority queue checkouts today without finishing one. Try again tomorrow, or open a Shop Support ticket in Discord if something is going wrong at PayPal.'
      });
    }
  }

  // One live checkout per (buyer, product) — closes the concurrent-request
  // race that could otherwise oversell a limited item.
  if (hasLivePendingOrder(req.user.steam_id, product.id)) {
    return res.status(409).json({ error: 'You already have a checkout in progress for this item. Finish or cancel it first.' });
  }

  // Every refusal above is decided from our own data, so a player hears the real
  // reason (already subscribed, sold out, no server) even while PayPal is not set
  // up. Nothing before this point creates an order or talks to PayPal; only the
  // step counter is touched.
  if (!paypal.isConfigured(useTest)) {
    return res.status(503).json({ error: `PayPal ${useTest ? 'sandbox' : 'live'} is not configured.` });
  }

  // Create the pending order row up-front so the customId we hand to PayPal
  // can map back to our DB even before they approve.
  const order = db.prepare(`
    INSERT INTO orders (steam_id, product_id, server_id, status, amount_cents, test_mode) VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(req.user.steam_id, product.id, orderServerId, amountCents, useTest ? 1 : 0);
  const orderId = order.lastInsertRowid;
  if (sharedIdConfirmed) {
    console.log(`[pq-guard] order #${orderId}: ${req.user.steam_id} confirmed in-game ID ${String(req.user.bi_uid).slice(0, 8)}... is theirs although another account has live priority queue on it (buying ${orderServerId || 'all servers'})`);
  }

  try {
    if (isRecurring) {
      // Subscription path — use PayPal Billing Plans + Subscriptions so the
      // buyer is auto-billed each cycle without re-checkout.
      const planId = await ensurePlanForProduct(product, useTest);
      const { id: subscriptionId, approveUrl } = await paypal.createSubscription(useTest, {
        planId,
        customId: orderId,
        brandName: 'ReforgedZ',
        returnUrl: `${BASE_URL}/api/shop/paypal/return-sub?order=${orderId}`,
        cancelUrl: `${BASE_URL}/api/shop/paypal/cancel-sub?order=${orderId}`
      });
      if (!approveUrl) throw new Error('PayPal did not return a subscription approve URL');
      db.prepare('UPDATE orders SET paypal_subscription_id = ? WHERE id = ?').run(subscriptionId, orderId);
      funnel.countStep(db, 'checkout_started');
      return res.json({ url: approveUrl });
    }

    // One-time path (Orders v2 capture).
    const { id: paypalOrderId, approveUrl } = await paypal.createOrder(useTest, {
      amountCents,
      currency: product.currency || 'USD',
      description: product.title,
      customId: orderId,
      brandName: 'ReforgedZ',
      returnUrl: `${BASE_URL}/api/shop/paypal/return?order=${orderId}`,
      cancelUrl: `${BASE_URL}/shop?cancelled=1`
    });
    if (!approveUrl) throw new Error('PayPal did not return an approve URL');
    db.prepare('UPDATE orders SET paypal_order_id = ? WHERE id = ?').run(paypalOrderId, orderId);
    funnel.countStep(db, 'checkout_started');
    res.json({ url: approveUrl });
  } catch (err) {
    console.error('PayPal checkout error:', err.message);
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
    res.status(500).json({ error: 'Failed to create checkout' });
  }
});

// Custom Flag checkout: a one-time purchase like any other, but it collects
// player details + a flag image up front (multipart) instead of the plain
// JSON body /checkout takes. Payment itself still rides the same PayPal
// Orders v2 one-time flow — only the pre-payment collection step differs.
router.post('/api/shop/checkout-custom-flag', requireAuth, handleCustomFlagUpload, async (req, res) => {
  const productId = parseInt(req.body.productId, 10);
  const playerName = String(req.body.playerName || '').trim();
  const inGameName = String(req.body.inGameName || '').trim();
  const guid = cleanGuid(req.body.guid);

  // If the buyer's account already has a Discord ID linked, that's the
  // source of truth — trust it over anything submitted here. Otherwise
  // they must supply one so staff can reach them about the order.
  let discordId = req.user.discord_id || null;
  if (!discordId) {
    const raw = String(req.body.discordId || '').trim();
    if (!raw) return res.status(400).json({ error: 'Discord ID is required — link your Discord from the account menu, or enter one below.' });
    if (!/^\d{15,25}$/.test(raw)) {
      return res.status(400).json({ error: 'Discord ID should be a numeric Discord user ID.' });
    }
    discordId = raw;
  }

  if (!productId) return res.status(400).json({ error: 'Missing productId' });
  if (!playerName) return res.status(400).json({ error: 'Player Name is required.' });
  if (!inGameName) return res.status(400).json({ error: 'In-Game Name is required.' });
  if (!guid) return res.status(400).json({ error: 'A valid Arma Reforger GUID is required.' });
  if (!req.file) return res.status(400).json({ error: 'Please upload your flag image (PNG or JPG).' });

  const useTest = (req.body.testMode === '1' || req.body.testMode === 'true') && req.user.role === 'admin';
  if (!paypal.isConfigured(useTest)) {
    return res.status(503).json({ error: `PayPal ${useTest ? 'sandbox' : 'live'} is not configured.` });
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (product.type !== 'custom_flag') {
    return res.status(400).json({ error: 'This product does not accept a Custom Flag checkout.' });
  }

  const amountCents = product.price_cents;
  // Derive the extension from the file's actual content, not its claimed MIME —
  // an attacker labelling an HTML/SVG polyglot as image/png would otherwise be
  // stored and later served to admins.
  const ext = detectImageExt(req.file.buffer);
  if (!ext) {
    return res.status(400).json({ error: 'Flag image must be a real PNG or JPG file.' });
  }
  const fileName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const diskPath = path.join(CUSTOM_FLAG_UPLOAD_DIR, fileName);

  // One live checkout per (buyer, product) — also bounds abandoned uploads.
  if (hasLivePendingOrder(req.user.steam_id, product.id)) {
    return res.status(409).json({ error: 'You already have a Custom Flag checkout in progress. Finish or cancel it first.' });
  }

  const orderInfo = db.prepare(`
    INSERT INTO orders (steam_id, product_id, status, amount_cents, test_mode, custom_fields_json, custom_file_path)
    VALUES (?, ?, 'pending', ?, ?, ?, ?)
  `).run(
    req.user.steam_id, product.id, amountCents, useTest ? 1 : 0,
    JSON.stringify({ playerName, inGameName, guid, discordId }),
    fileName
  );
  const orderId = orderInfo.lastInsertRowid;

  // Save the image before we ever talk to PayPal — an order shouldn't be
  // payable if we can't actually store what they submitted.
  try {
    fs.writeFileSync(diskPath, req.file.buffer);
  } catch (e) {
    console.error('[custom-flag] failed to save upload:', e.message);
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
    return res.status(500).json({ error: 'Failed to save your uploaded image. Please try again.' });
  }

  try {
    const { id: paypalOrderId, approveUrl } = await paypal.createOrder(useTest, {
      amountCents,
      currency: product.currency || 'USD',
      description: product.title,
      customId: orderId,
      brandName: 'ReforgedZ',
      returnUrl: `${BASE_URL}/api/shop/paypal/return?order=${orderId}`,
      cancelUrl: `${BASE_URL}/shop?cancelled=1`
    });
    if (!approveUrl) throw new Error('PayPal did not return an approve URL');
    db.prepare('UPDATE orders SET paypal_order_id = ? WHERE id = ?').run(paypalOrderId, orderId);
    funnel.countStep(db, 'checkout_started');
    res.json({ url: approveUrl });
  } catch (err) {
    console.error('[custom-flag] PayPal checkout error:', err.message);
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
    fs.unlink(diskPath, () => {});
    res.status(500).json({ error: 'Failed to create checkout' });
  }
});

// Lazily provision (and cache on the product row) the PayPal catalog-product
// + billing-plan ids for this product, per environment. The first checkout
// for a subscription product pays the create cost; subsequent ones reuse.
async function ensurePlanForProduct(product, useTest) {
  const planCol = useTest ? 'paypal_plan_id_test' : 'paypal_plan_id_live';
  const prodCol = useTest ? 'paypal_product_id_test' : 'paypal_product_id_live';

  let planId = product[planCol];
  if (planId) return planId;

  let catalogProductId = product[prodCol];
  if (!catalogProductId) {
    catalogProductId = await paypal.createCatalogProduct(useTest, {
      name: product.title,
      description: product.description || product.title
    });
    db.prepare(`UPDATE products SET ${prodCol} = ? WHERE id = ?`).run(catalogProductId, product.id);
  }

  // Default to monthly. recurring_custom carries its own cadence in days.
  let intervalUnit = 'MONTH';
  let intervalCount = 1;
  if (product.type === 'recurring_custom' && product.interval_days) {
    intervalUnit = 'DAY';
    intervalCount = product.interval_days;
  }

  planId = await paypal.createPlan(useTest, {
    catalogProductId,
    name: `${product.title} (monthly)`,
    description: product.description || product.title,
    priceCents: product.price_cents,
    currency: (product.currency || 'USD').toUpperCase(),
    intervalUnit,
    intervalCount
  });
  db.prepare(`UPDATE products SET ${planCol} = ? WHERE id = ?`).run(planId, product.id);
  return planId;
}

// ---- Shared fulfillment (idempotent) ----
// Transitions a pending order → completed exactly once and runs all the
// side effects: Discord notification, game-server sync, role grant, invoice
// email. Safe to call from both the return handler and the webhook.
// Order + its buyer + product, joined — the shape every order-lifecycle
// notification (fulfillment, payment-denied, refund) needs to build a
// Discord/email payload from just an order id.
function getOrderWithContext(orderId) {
  return db.prepare(`
    SELECT o.*, u.persona, u.bi_uid, u.bi_uid_name, u.platform, u.gamertag, u.bm_player_id, u.discord_id,
           p.title AS product_title, p.type, p.currency, p.grants_priority_queue, p.discord_role_id, p.server_specific
    FROM orders o JOIN users u ON o.steam_id = u.steam_id JOIN products p ON o.product_id = p.id
    WHERE o.id = ?
  `).get(orderId);
}

// The lines under "What happens next" on the receipt. Queue priority only
// takes effect when a server restarts, and a role only lands if Discord is
// linked; until now the buyer was told neither.
function purchaseNextSteps(order) {
  const steps = [];
  const base = BASE_URL.replace(/\/+$/, '');
  if (order.grants_priority_queue) {
    const label = order.server_id ? (SERVER_LABELS[order.server_id] || order.server_id) : 'your server';
    steps.push(`Queue priority on ${label} starts at the next scheduled restart, ${describeNextRestart().text}. Servers restart every 4 hours, so it is never a long wait.`);
    if (!order.bi_uid) steps.push(`Set your in-game id on your account page first, or the priority has nowhere to go: ${base}/account`);
    // Named, so a mistyped or planted in-game ID is noticed on the receipt rather than in the queue.
    else if (inGameId.recipientLine(order.bi_uid_name)) steps.push(inGameId.recipientLine(order.bi_uid_name));
  }
  if (order.discord_role_id) {
    steps.push(order.discord_id
      ? 'Your Discord role is applied automatically, usually within a minute.'
      : `Link your Discord on your account page to receive your role: ${base}/account`);
  }
  steps.push(`See or change any of this on your account page: ${base}/account`);
  return steps;
}

function fulfillOrder(orderId, cap) {
  const order = getOrderWithContext(orderId);
  if (!order) return false;
  if (order.status === 'completed' || order.status === 'refunded') return false; // already done

  // A buyer who lingers on PayPal for more than PENDING_TIMEOUT_SECONDS gets
  // swept to 'cancelled' before their payment lands, so fulfilment has to
  // rescue that row too — not just 'pending' ones. Restricting the UPDATE to
  // 'pending' silently matched zero rows while the rest of this function still
  // sent a "payment completed" notification and ran the sync, leaving people
  // who had genuinely paid with a cancelled order and no entitlement.
  const res = db.prepare(`
    UPDATE orders SET status = 'completed', completed_at = unixepoch(),
      paypal_capture_id = ?, payer_email = ?, fee_cents = ?
    WHERE id = ? AND status IN ('pending', 'cancelled')
  `).run(cap.captureId || null, cap.payerEmail || null, cap.feeCents ?? null, orderId);

  // Never fulfil silently: if nothing moved, the caller's assumptions are wrong
  // and someone has paid without being granted anything.
  if (res.changes === 0) {
    console.error(`[orders] fulfillOrder(${orderId}) matched no row — status was '${order.status}'. NOT fulfilled; investigate.`);
    return false;
  }
  if (order.status === 'cancelled') {
    console.warn(`[orders] order ${orderId} was rescued from 'cancelled' — payment arrived after the stale-pending sweep.`);
  }
  // Only here, after the row moved: a repeat call for the same payment returned above.
  funnel.countStep(db, 'payment_completed');

  // One card per purchase: a Custom Flag order gets its own card below, with the
  // flag attached. A subscription's first payment and a one-time purchase are
  // different news for staff, so they have different titles.
  if (order.type !== 'custom_flag') {
    const isSubscription = !!order.paypal_subscription_id || order.type === 'subscription' || order.type === 'recurring_custom';
    sendCard(() => cards.orderEventCard(isSubscription ? 'subscription_started' : 'payment_completed', order));
  }

  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
  tryAssignDiscordRoleForOrder(orderId);

  // Invoice email to the PayPal payer email (the only email we collect —
  // Steam login doesn't provide one). Fire-and-forget.
  const to = cap.payerEmail || null;
  if (order.type === 'custom_flag') {
    // Extra order-review post (with the submitted image attached) + a
    // combined receipt-and-instructions email instead of the plain invoice.
    let customFields = {};
    try { customFields = JSON.parse(order.custom_fields_json || '{}'); } catch {}
    sendCustomFlagDiscordNotification({ orderId, order, customFields })
      .catch(e => console.error('[custom-flag] Discord notify failed:', e.message));
    if (to) {
      sendCustomFlagConfirmation({
        to,
        orderId,
        productTitle: order.product_title,
        amountCents: order.amount_cents,
        currency: order.currency,
        customFields,
        tutorialUrl: process.env.CUSTOM_FLAG_TUTORIAL_URL || null,
        ticketUrl: CUSTOM_FLAG_TICKET_URL,
        dateMs: Date.now()
      }).catch(() => {});
    }
  } else if (to) {
    sendInvoice({
      to,
      orderId,
      captureId: cap.captureId,
      productTitle: order.product_title,
      amountCents: order.amount_cents,
      currency: order.currency,
      feeCents: cap.feeCents,
      serverLabel: order.server_id ? (SERVER_LABELS[order.server_id] || order.server_id) : null,
      buyerName: cap.payerName || playerNameOf(order),
      dateMs: Date.now(),
      nextSteps: purchaseNextSteps(order)
    }).catch(() => {});
  }
  return true;
}

// Posts a Custom Flag order to the shop-orders Discord webhook with the
// submitted details, attaching the flag image directly (no public URL
// needed — Discord supports embedding a same-request file via the
// attachment:// scheme). Falls back to a plain embed if the file can't be
// read, per the "Discord failure shouldn't block the order" rule.
async function sendCustomFlagDiscordNotification({ orderId, order, customFields }) {
  if (!DISCORD_WEBHOOK_URL) return;

  let fileBuffer = null;
  let fileName = null;
  if (order.custom_file_path) {
    try {
      fileName = path.basename(order.custom_file_path);
      fileBuffer = fs.readFileSync(path.join(CUSTOM_FLAG_UPLOAD_DIR, fileName));
    } catch (e) {
      console.error('[custom-flag] could not read flag image for Discord:', e.message);
      fileBuffer = null;
    }
  }

  let body;
  try {
    body = buildCard(cards.customFlagCard({ orderId, order, customFields, imageName: fileBuffer ? fileName : null }));
  } catch (e) {
    console.error('[custom-flag] card not built:', e.message);
    return;
  }
  await postCard(body, fileBuffer ? { files: [{ name: fileName, data: fileBuffer }] } : {});
}

// PayPal returns the buyer here after they approve. We capture the order,
// fulfill it, and redirect back to the shop.
router.get('/api/shop/paypal/return', async (req, res) => {
  const orderId = parseInt(req.query.order, 10);
  const order = orderId ? db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) : null;
  if (!order || !order.paypal_order_id) {
    return res.redirect(BASE_URL + '/shop?cancelled=1');
  }
  // Only capture pending orders — re-capturing a stale-cancelled order would
  // bill the buyer without granting entitlement (fulfillOrder's UPDATE is
  // gated by status='pending'). Completed orders just bounce to success.
  if (order.status === 'completed') {
    return res.redirect(BASE_URL + '/shop?success=1&order=' + orderId);
  }
  if (order.status !== 'pending') {
    return res.redirect(BASE_URL + '/shop?cancelled=1');
  }
  const useTest = !!order.test_mode;
  try {
    const cap = await paypal.captureOrder(useTest, order.paypal_order_id);
    if (cap.status === 'COMPLETED') {
      fulfillOrder(orderId, cap);
      return res.redirect(BASE_URL + '/shop?success=1&order=' + orderId);
    }
    return res.redirect(BASE_URL + '/shop?cancelled=1');
  } catch (err) {
    console.error('PayPal capture (return) error:', err.message);
    return res.redirect(BASE_URL + '/shop?error=1');
  }
});

// Subscription return path. Buyer is bouncing back to us after the PayPal
// hosted page. Only treat ACTIVE as success — APPROVAL_PENDING means they
// never clicked Subscribe (no billing agreement), APPROVED is a transient
// state right before activation. The canonical activation event is the
// BILLING.SUBSCRIPTION.ACTIVATED webhook, which signs the result; if the
// buyer arrives back before that webhook lands we'd rather show "processing"
// than risk a free fulfillment.
router.get('/api/shop/paypal/return-sub', async (req, res) => {
  const orderId = parseInt(req.query.order, 10);
  const order = orderId ? db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) : null;
  if (!order || !order.paypal_subscription_id) {
    return res.redirect(BASE_URL + '/shop?cancelled=1');
  }
  // Already-fulfilled order: just bounce to success. Anything not pending is
  // treated as terminal — don't re-touch it.
  if (order.status === 'completed') {
    return res.redirect(BASE_URL + '/shop?success=1&order=' + orderId);
  }
  if (order.status !== 'pending') {
    return res.redirect(BASE_URL + '/shop?cancelled=1');
  }
  const useTest = !!order.test_mode;
  try {
    const sub = await paypal.getSubscription(useTest, order.paypal_subscription_id);
    const status = (sub?.status || '').toUpperCase();
    if (status === 'ACTIVE') {
      // The same slot check the ACTIVATED webhook makes, whichever of the two arrives
      // first (paymentEvents.claimActivation). Checked and fulfilled with nothing
      // awaited in between, so no other activation can take the slot in the gap.
      const verdict = paymentEvents.claimActivation(db, { orderId });
      if (verdict.refuse) {
        if (verdict.claimed) {
          paymentEvents.reportRefusedActivation(db, { verdict, payerEmail: sub.subscriber?.email_address || null }, refusalEffects())
            .catch(e => console.error(`[pq-slot] order #${orderId}: refusal not reported: ${e.message}`));
        }
        return res.redirect(BASE_URL + '/shop?soldout=1');
      }
      fulfillOrder(orderId, {
        captureId: sub.id,
        payerEmail: sub.subscriber?.email_address || null,
        feeCents: null
      });
      // The first billing date from this same lookup, so the new priority queue holds
      // its slot now rather than when the ACTIVATED webhook lands.
      pinFirstBillingDate(orderId, sub.billing_info?.next_billing_time, sub.id);
      return res.redirect(BASE_URL + '/shop?success=1&order=' + orderId);
    }
    if (status === 'APPROVED') {
      // First payment not yet captured. Webhook will activate within seconds.
      return res.redirect(BASE_URL + '/shop?processing=1&order=' + orderId);
    }
    return res.redirect(BASE_URL + '/shop?cancelled=1');
  } catch (err) {
    console.error('PayPal subscription (return) error:', err.message);
    return res.redirect(BASE_URL + '/shop?error=1');
  }
});

// A buyer who backs out at PayPal ("Cancel and return") lands here. Their own checkout
// is cancelled at once, so a priority queue checkout stops holding its slot for other
// buyers (pqEntitlement's reservation) and they can start again straight away. Only the
// signed-in buyer's own pending subscription checkout changes; anyone else just goes
// back to the shop. Should the buyer approve that subscription at PayPal after all,
// activation still fulfils it (fulfillOrder accepts a cancelled row).
router.get('/api/shop/paypal/cancel-sub', (req, res) => {
  const orderId = parseInt(req.query.order, 10);
  if (orderId > 0 && req.isAuthenticated && req.isAuthenticated() && req.user) {
    const changed = db.prepare(`
      UPDATE orders SET status = 'cancelled'
      WHERE id = ? AND steam_id = ? AND status = 'pending' AND paypal_subscription_id IS NOT NULL
    `).run(orderId, req.user.steam_id).changes;
    if (changed) console.log(`[orders] order #${orderId}: the buyer backed out at PayPal, checkout cancelled`);
  }
  res.redirect(BASE_URL + '/shop?cancelled=1');
});

// Get current user's orders
router.get('/api/shop/orders', requireAuth, (req, res) => {
  const orders = db.prepare(`
    SELECT o.id, o.product_id, o.status, o.amount_cents, o.created_at, o.completed_at,
           o.stripe_subscription_id, o.paypal_subscription_id, o.subscription_cancelled_at, o.server_id,
           p.title, p.type, p.currency, p.server_specific, p.grants_priority_queue, p.discord_role_id
    FROM orders o JOIN products p ON o.product_id = p.id
    WHERE o.steam_id = ? ORDER BY o.created_at DESC
  `).all(req.user.steam_id);
  res.json(orders);
});

// ---- Self-service priority queue move: retired --------------------------------
// A move is a change to the subscription, made by staff
// (POST /api/shop/admin/priority-queue/switch). The self-service move wrote grants
// and blocks and had been switched off since 2026-09-12; its URL answers 410 for
// one release so an old account page gets a clear answer.
router.post('/api/shop/priority-queue/move', requireAuth, (req, res) => {
  res.status(410).json({
    code: 'retired',
    error: 'Moving your priority queue yourself is no longer offered. Open a Shop Support ticket in Discord and staff will move your subscription to the server you want.'
  });
});

// Set own in-game id (the Bohemia identity id the game servers key queue priority
// and perks on). Anyone signed in can set or change it: the owner's rule is that a
// player who typed it wrong, or has a new game account, fixes it themselves.
// Changing it moves their priority queue to the new id at the next sync, because
// entitlements are read from users.bi_uid every time.
//
// One exception: an Xbox or PlayStation account whose email sign-in is not
// confirmed. Console sign-in never proved who was typing, so whoever got into one
// could otherwise send a paying player's priority to their own ID. It changes once
// the account has email sign-in confirmed through its own inbox: a claim with the
// email it paid with, or an email added just after a staff re-link.
router.post('/api/shop/set-bi-uid', requireAuth, async (req, res) => {
  try {
    await setOwnBiUid(req, res);
  } catch (e) {
    console.error('[bi-uid] save failed:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not save your in-game ID. Try again.' });
  }
});

async function setOwnBiUid(req, res) {
  const isConsole = req.user.platform === 'psn' || req.user.platform === 'xbox';
  if (isConsole && !req.user.email_verified_at) {
    return res.status(403).json({
      code: 'needs_login',
      error: 'Set up email sign-in on this account first, then you can set your in-game ID. Your account page shows how.'
    });
  }

  const body = req.body || {};
  const bm = require('../battlemetrics');
  const bmDown = 'We could not reach BattleMetrics. Please try again in a minute.';
  let cleaned = null;
  let playerName = null;
  let verified = false;

  if (body.ref != null) {
    // A player picked from "Find me"; only picks this browser was shown count.
    const cand = consoleIdentity.pickCandidate(req.session, body.ref);
    if (!cand) return res.status(400).json({ code: 'pick_expired', error: 'That choice has expired. Search for yourself again.' });
    cleaned = cand.biUid;
    if (!cleaned) {
      const found = await bm.reforgerUuidForPlayer(cand.bmPlayerId);
      if (found.unavailable) return res.status(503).json({ error: bmDown });
      cleaned = found.biUid;
    }
    if (!cleaned) {
      return res.status(404).json({ code: 'not_recorded', error: 'BattleMetrics has not recorded an in-game ID for that player yet. Play one round on a ReforgedZ server, or paste your ID from the game.' });
    }
    playerName = cand.name || null;
    verified = true;
  } else {
    const raw = typeof body.biUid === 'string' ? body.biUid : '';
    if (!raw.trim()) return res.status(400).json({ error: 'Enter your in-game ID.' });
    if (/^[{\s]*0{8}-0{4}-0{4}-0{4}-0{12}[}\s]*$/.test(raw)) {
      return res.status(400).json({ error: 'That is the placeholder ID, not yours. Copy the real one from your profile in the game.' });
    }
    // Pasted from the game's profile screen; braces, spaces and capitals are the
    // usual noise around a correct id.
    cleaned = bm.asReforgerUuid(raw);
    if (!cleaned) {
      return res.status(400).json({ error: 'That does not look like an in-game ID. It is 36 characters with dashes, like 41b8ec0d-f0bd-4c41-b2a9-8213ebe04aac.' });
    }
    // Checked with BattleMetrics, so a typo cannot send every perk to nobody and
    // the player sees whose ID it is. A player who has never got onto one of our
    // servers (the queue is why they are buying) is still accepted when
    // BattleMetrics has seen the ID anywhere. If BattleMetrics cannot be asked at
    // all, the save goes through rather than blocking on someone else's outage.
    const ours = await bm.findPlayers(cleaned);
    if (!ours.unavailable && ours.candidates.length) {
      playerName = ours.candidates[0].name || null;
      verified = true;
    } else {
      const seen = await bm.matchReforgerUuid(cleaned).catch(() => ({ found: null }));
      if (seen.found === false) {
        return res.status(400).json({ error: 'BattleMetrics has never seen that ID on any server. Check it against your profile in the game. If you only just started playing, play one round and try again.' });
      }
      if (seen.found === true) verified = true;
      else console.warn('[bi-uid] BattleMetrics check unavailable (%s); saving %s unverified for %s', seen.error, cleaned, req.user.steam_id);
    }
  }

  // The new ID takes over this account's priority queue. Where the old ID stays listed
  // for another account, that adds an admin list entry, and a full server has no room
  // for one (pqEntitlement.idChangeFullServers).
  const current = db.prepare('SELECT bi_uid FROM users WHERE steam_id = ?').get(req.user.steam_id);
  const fullOn = pqEntitlement.idChangeFullServers(db, {
    steamId: req.user.steam_id, fromBiUid: current ? current.bi_uid : null, toBiUid: cleaned, now: Math.floor(Date.now() / 1000)
  });
  if (fullOn.length) {
    const names = fullOn.map(id => SERVER_LABELS[id] || id.toUpperCase()).join(', ');
    console.warn(`[bi-uid] ${req.user.steam_id}: ID change refused, it would add a priority queue entry on full ${fullOn.join(', ')}`);
    return res.status(409).json({
      code: 'server_full',
      error: `Your priority queue cannot move to that ID right now: your current ID also has priority queue through another account, so the new ID would need a second place on ${names}, and there is no free slot. Open a Shop Support ticket in Discord and staff will sort it out.`
    });
  }

  // With the ID go the player name BattleMetrics showed (or none) and how it was
  // chosen, so the account page and receipts can say who the priority goes to
  // (inGameId.js). A website account also takes that name as its display name.
  const picked = body.ref != null;
  const proof = inGameId.proofForSave({ picked, verified });
  const saved = inGameId.saveOwnBiUid(db, {
    steamId: req.user.steam_id, biUid: cleaned, name: playerName, proof, isWeb: req.user.platform === 'web'
  });
  req.user.bi_uid = cleaned;
  funnel.countStep(db, picked ? 'id_saved_find' : 'id_saved_paste');
  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
  res.json({ ok: true, bi_uid: cleaned, verified, playerName, proof: saved.proof });
}

// The player name behind the account's current in-game ID, looked up on request
// and stored (plan J13). IDs saved before names were stored, by staff, or while
// BattleMetrics was down have none, and the account page offers this so the
// player can see whose ID it is. BattleMetrics only names players seen on a
// ReforgedZ server. Capped per account: each lookup spends the BattleMetrics
// budget the Find me search and the homepage player counts share.
const lookupNameLimit = windowLimit({ limit: 6, windowMs: 60 * 1000 });

router.post('/api/shop/account/bi-uid/lookup-name', requireAuth, async (req, res) => {
  if (!lookupNameLimit(req.user.steam_id)) {
    return res.status(429).json({ error: 'Too many lookups. Try again in a minute.' });
  }
  const me = db.prepare('SELECT bi_uid FROM users WHERE steam_id = ?').get(req.user.steam_id);
  const biUid = me && me.bi_uid;
  if (!biUid) return res.status(400).json({ code: 'no_in_game_id', error: 'Add your in-game ID first.' });
  try {
    const found = await require('../battlemetrics').findPlayers(biUid);
    if (found.unavailable) {
      return res.status(503).json({ error: 'We could not reach BattleMetrics. Please try again in a minute.' });
    }
    const name = inGameId.cleanPlayerName(found.candidates[0] && found.candidates[0].name);
    if (!name) {
      return res.status(404).json({ code: 'not_found', error: 'BattleMetrics has not seen that in-game ID on a ReforgedZ server yet. Play one round, then try again.' });
    }
    inGameId.storeLookedUpName(db, { steamId: req.user.steam_id, biUid, name });
    res.json({ ok: true, name });
  } catch (e) {
    console.error('[bi-uid] name lookup failed:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not look up the player name. Try again.' });
  }
});

// Verify/capture a PayPal order (fallback when the return redirect or webhook
// didn't complete fulfillment). Frontend calls this with the order id.
router.post('/api/shop/verify-session', requireAuth, async (req, res) => {
  const orderId = parseInt(req.body.orderId, 10);
  if (!orderId) return res.json({ ok: true, status: 'no_order' });

  const order = db.prepare(`
    SELECT * FROM orders WHERE id = ? AND steam_id = ?
  `).get(orderId, req.user.steam_id);
  if (!order) return res.json({ ok: true, status: 'not_found' });
  if (order.status === 'completed') return res.json({ ok: true, status: 'completed' });
  if (order.status !== 'pending' || !order.paypal_order_id) {
    return res.json({ ok: true, status: order.status });
  }

  const useTest = !!order.test_mode;
  try {
    // Inspect the PayPal order; capture if approved but not yet captured.
    let cap;
    const pp = await paypal.getOrder(useTest, order.paypal_order_id);
    if (pp.status === 'COMPLETED') {
      cap = paypal.normalizeCapture(pp);
    } else if (pp.status === 'APPROVED') {
      cap = await paypal.captureOrder(useTest, order.paypal_order_id);
    } else {
      return res.json({ ok: true, status: pp.status });
    }
    if (cap.status === 'COMPLETED') {
      fulfillOrder(orderId, cap);
      return res.json({ ok: true, status: 'completed' });
    }
    res.json({ ok: true, status: cap.status });
  } catch (err) {
    console.error('Verify (PayPal) error:', err.message);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Billing period end (+ live PayPal status) for the cancel-subscription
// confirmation modal. Only the order's own owner can look it up.
router.get('/api/shop/subscription-info/:orderId', requireAuth, async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND steam_id = ?').get(orderId, req.user.steam_id);
  if (!order || !order.paypal_subscription_id) {
    return res.status(404).json({ error: 'Subscription not found' });
  }

  const useTest = !!order.test_mode;
  let periodEnd = order.effective_until || null;
  let status = null;
  try {
    const sub = await paypal.getSubscription(useTest, order.paypal_subscription_id);
    status = (sub?.status || '').toUpperCase();
    const next = sub?.billing_info?.next_billing_time;
    if (next) {
      const u = Math.floor(new Date(next).getTime() / 1000);
      if (isFinite(u) && u > 0) periodEnd = u;
    }
  } catch (e) {
    console.warn('[subscription-info] PayPal lookup failed:', e.message);
  }

  res.json({ periodEnd, status, active: status === 'ACTIVE' });
});

// Player-initiated cancellation — turns off auto-renew. Access is kept
// through the period already paid for; PayPal's BILLING.SUBSCRIPTION.CANCELLED
// webhook (below) pins effective_until and emails the confirmation once it
// lands, same as an admin- or PayPal-initiated cancellation.
router.post('/api/shop/cancel-subscription', requireAuth, async (req, res) => {
  const orderId = parseInt(req.body.orderId, 10);
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND steam_id = ?').get(orderId, req.user.steam_id);
  if (!order || !order.paypal_subscription_id) {
    return res.status(404).json({ error: 'Subscription not found' });
  }

  const useTest = !!order.test_mode;
  try {
    const sub = await paypal.getSubscription(useTest, order.paypal_subscription_id);
    const status = (sub?.status || '').toUpperCase();
    if (status === 'CANCELLED' || status === 'SUSPENDED' || status === 'EXPIRED') {
      // Self-heal: PayPal already considers it dead (e.g. the cancellation
      // webhook never landed, or it was cancelled from PayPal's own
      // dashboard) — bring our record in line so the buyer stops seeing an
      // active Cancel button for it.
      markSubscriptionCancelledLocally(order.paypal_subscription_id, status.toLowerCase());
      return res.json({ ok: true, alreadyCancelled: true });
    }
    // The player is cancelling, so the CANCELLED webhook must email them and post
    // its card, even if a shop cancel PayPal never answered left a marker behind
    // (PayPal still says ACTIVE, so that cancel did not happen).
    paymentEvents.clearShopCancel(db, order.paypal_subscription_id);
    await paypal.cancelSubscription(useTest, order.paypal_subscription_id, 'Cancelled by customer');
    markSubscriptionCancelledLocally(order.paypal_subscription_id, 'cancelled');
    res.json({ ok: true });
  } catch (e) {
    console.error('[cancel-subscription] PayPal cancel failed:', e.message);
    res.status(502).json({ error: 'Failed to cancel subscription: ' + e.message });
  }
});

// Every order row sharing a PayPal subscription id (one per billing cycle)
// needs this cleared together, or an older cycle's row would surface as
// "the latest cancellable order" once the true latest one gets marked.
// COALESCE keeps the earliest-known cancellation time rather than
// clobbering it on repeat calls (customer double-clicking, webhook arriving
// after a self-heal already ran, etc).
// The reason a subscription ended is kept too, so 'unpaid' or 'no_slot' written by the
// shop survives the CANCELLED webhook its own cancel causes (paymentEvents.markSubscriptionEnded).
function markSubscriptionCancelledLocally(subscriptionId, reason = 'cancelled') {
  paymentEvents.markSubscriptionEnded(db, subscriptionId, reason);
}

// The reverse, for BILLING.SUBSCRIPTION.RE-ACTIVATED. Nothing ever cleared
// these before, so a suspended agreement that PayPal brought back stayed
// "cancelled" on the account page for good — no Cancel button, wrong pill —
// while PayPal billed it again.
function clearSubscriptionEndedLocally(subscriptionId) {
  db.prepare(`
    UPDATE orders SET subscription_cancelled_at = NULL, subscription_ended_reason = NULL
    WHERE paypal_subscription_id = ?
  `).run(subscriptionId);
}

// ============================================================
//  Admin endpoints
// ============================================================

// Get all products (including inactive)
router.get('/api/shop/admin/products', requireAdmin, (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
  const orderCounts = db.prepare('SELECT product_id, COUNT(*) AS cnt FROM orders GROUP BY product_id').all();
  const subCounts = db.prepare(`
    SELECT product_id, COUNT(DISTINCT stripe_subscription_id) AS cnt
    FROM orders WHERE status = 'completed' AND stripe_subscription_id IS NOT NULL
    GROUP BY product_id
  `).all();
  const ordMap = new Map(orderCounts.map(c => [c.product_id, c.cnt]));
  const subMap = new Map(subCounts.map(c => [c.product_id, c.cnt]));
  res.json(products.map(p => {
    p.order_count = ordMap.get(p.id) || 0;
    p.active_sub_count = subMap.get(p.id) || 0;
    return attachStock(attachImages(p));
  }));
});

// Get all orders (admin view with steam names + BI UIDs)
router.get('/api/shop/admin/orders', requireAdmin, (req, res) => {
  const orders = db.prepare(`
    SELECT o.id, o.status, o.amount_cents, o.created_at, o.completed_at, o.test_mode,
           o.stripe_session_id, o.stripe_subscription_id,
           o.custom_fields_json, o.custom_file_path,
           o.steam_id, u.persona, u.avatar_url, u.bi_uid,
           u.platform, u.gamertag, u.bm_player_id,
           p.title, p.type, p.currency
    FROM orders o
    JOIN users u ON o.steam_id = u.steam_id
    JOIN products p ON o.product_id = p.id
    ORDER BY o.created_at DESC
  `).all();
  res.json(orders);
});

// Stream a submitted flag image back to the admin page. Filenames are
// server-generated (not user input) and re-basenamed here regardless, so
// there's no path-traversal surface even though we control the value.
router.get('/api/shop/admin/orders/:id/flag-image', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT custom_file_path FROM orders WHERE id = ?').get(req.params.id);
  if (!order || !order.custom_file_path) return res.status(404).json({ error: 'No flag image for this order' });
  const filePath = path.join(CUSTOM_FLAG_UPLOAD_DIR, path.basename(order.custom_file_path));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Image file missing' });
  res.sendFile(filePath);
});

// Set or clear an account's in-game ID (admin only). adminAudit.staffSetBiUid
// checks the value, asks before saving an ID another account holds, records the
// change in admin_audit, and explains why priority queue grants stay where they are.
// Body: { biUid, confirmShared?, reason? }. 409 { code: 'id_on_other_account', otherAccounts }.
router.put('/api/shop/admin/users/:steamId/bi-uid', requireAdmin, (req, res) => {
  const body = req.body || {};
  const actor = adminActor(req);
  const out = staffSetBiUid(db, {
    steamId: req.params.steamId, biUid: body.biUid, confirmShared: body.confirmShared,
    actor, reason: body.reason, ip: req.ip
  });
  if (out.status !== 200) return res.status(out.status).json(out.body);
  const head = (v) => (v ? `${String(v).slice(0, 8)}...` : 'none');
  console.log(`[bi-uid] ${actor} set the in-game ID on ${req.params.steamId}: ${head(out.before.bi_uid)} -> ${head(out.after.bi_uid)}`);
  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
  res.json(out.body);
});

const VALID_PRODUCT_TYPES = ['one_time', 'subscription', 'recurring_custom', 'custom_flag'];

function normalizeImagesExtra(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const cleaned = value.map(s => String(s || '').trim()).filter(Boolean);
    return JSON.stringify(cleaned);
  }
  if (typeof value === 'string') {
    const cleaned = value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return JSON.stringify(cleaned);
  }
  return undefined;
}

function normalizeStockLimit(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '' || value === false) return null;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// Per-server stock caps as a JSON map {serverId: limit}. Only valid server ids
// with non-negative integer caps are kept; empty result stores NULL (shared
// stock_limit applies everywhere).
function normalizeStockOverrides(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  let obj = value;
  if (typeof value === 'string') { try { obj = JSON.parse(value); } catch { return null; } }
  if (typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const id of SERVER_IDS) {
    const v = obj[id];
    if (v === undefined || v === null || v === '') continue;
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n >= 0) out[id] = n;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

function normalizeAmountCents(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function validateCustomPricing({ customPrice, priceMinCents, priceMaxCents, type }) {
  if (!customPrice) return { ok: true, min: null, max: null };
  if (type !== 'one_time') {
    return { ok: false, error: 'Custom amount pricing is only supported for one-time products.' };
  }
  const min = normalizeAmountCents(priceMinCents);
  const max = normalizeAmountCents(priceMaxCents);
  if (min == null || min < 50) {
    return { ok: false, error: 'priceMinCents must be at least 50 (Stripe minimum).' };
  }
  if (max != null && max < min) {
    return { ok: false, error: 'priceMaxCents must be greater than or equal to priceMinCents.' };
  }
  return { ok: true, min, max };
}

function normalizeDiscordRoleId(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const s = String(v).trim();
  return /^\d{15,25}$/.test(s) ? s : null;
}

// Create product
router.post('/api/shop/admin/products', requireAdmin, (req, res) => {
  const { title, description, priceCents, type, imageUrl, intervalDays, imagesExtra, stockLimit, stockLimitOverrides, serverSpecific, grantsPriorityQueue, customPrice, priceMinCents, priceMaxCents, discordRoleId } = req.body;

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return res.status(400).json({ error: 'Title is required' });
  }
  if (!priceCents || typeof priceCents !== 'number' || priceCents < 1) {
    return res.status(400).json({ error: 'Price must be a positive number (in cents)' });
  }
  if (!type || !VALID_PRODUCT_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Type must be one_time, subscription, recurring_custom, or custom_flag' });
  }

  let intervalDaysVal = null;
  if (type === 'recurring_custom') {
    intervalDaysVal = parseInt(intervalDays, 10);
    if (!intervalDaysVal || intervalDaysVal < 1 || intervalDaysVal > 365) {
      return res.status(400).json({ error: 'intervalDays must be between 1 and 365 for recurring_custom' });
    }
  }

  const imagesJson = normalizeImagesExtra(imagesExtra) ?? null;
  const stockLimitVal = normalizeStockLimit(stockLimit);
  const stockOverridesVal = normalizeStockOverrides(stockLimitOverrides);
  const serverSpecificVal = serverSpecific ? 1 : 0;
  const grantsPqVal = grantsPriorityQueue ? 1 : 0;

  const customCheck = validateCustomPricing({ customPrice, priceMinCents, priceMaxCents, type });
  if (!customCheck.ok) return res.status(400).json({ error: customCheck.error });
  const customPriceVal = customPrice ? 1 : 0;
  const discordRoleIdVal = normalizeDiscordRoleId(discordRoleId);

  const result = db.prepare(`
    INSERT INTO products (title, description, price_cents, type, image_url, interval_days, images_json, stock_limit, stock_limit_overrides, server_specific, grants_priority_queue, custom_price, price_min_cents, price_max_cents, discord_role_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title.trim(), (description || '').trim(), priceCents, type, imageUrl || null, intervalDaysVal, imagesJson, stockLimitVal === undefined ? null : stockLimitVal, stockOverridesVal === undefined ? null : stockOverridesVal, serverSpecificVal, grantsPqVal, customPriceVal, customCheck.min, customCheck.max, discordRoleIdVal || null);

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
  res.json(attachStock(attachImages(product)));
});

// Update product
router.put('/api/shop/admin/products/:id', requireAdmin, (req, res) => {
  const { title, description, priceCents, imageUrl, active, type, intervalDays, imagesExtra, stockLimit, stockLimitOverrides, serverSpecific, grantsPriorityQueue, customPrice, priceMinCents, priceMaxCents, discordRoleId } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  if (type !== undefined && !VALID_PRODUCT_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Invalid type' });
  }

  let intervalDaysParam = null;
  let intervalDaysWasSent = false;
  const effectiveType = type !== undefined ? type : product.type;
  if (intervalDays !== undefined) {
    intervalDaysWasSent = true;
    if (intervalDays === null || intervalDays === '') {
      intervalDaysParam = null;
    } else {
      const n = parseInt(intervalDays, 10);
      if (!n || n < 1 || n > 365) return res.status(400).json({ error: 'intervalDays must be between 1 and 365' });
      intervalDaysParam = n;
    }
  }
  if (effectiveType === 'recurring_custom') {
    const finalIntervalDays = intervalDaysWasSent ? intervalDaysParam : product.interval_days;
    if (!finalIntervalDays) return res.status(400).json({ error: 'intervalDays is required for recurring_custom' });
  }
  if (effectiveType !== 'recurring_custom' && !intervalDaysWasSent) {
    intervalDaysWasSent = true;
    intervalDaysParam = null;
  }

  const imagesJson = normalizeImagesExtra(imagesExtra);
  const stockLimitVal = normalizeStockLimit(stockLimit);
  const stockLimitWasSent = stockLimit !== undefined;
  const stockOverridesVal = normalizeStockOverrides(stockLimitOverrides);
  const stockOverridesWasSent = stockLimitOverrides !== undefined;
  const serverSpecificWasSent = serverSpecific !== undefined;
  const serverSpecificVal = serverSpecific ? 1 : 0;
  const grantsPqWasSent = grantsPriorityQueue !== undefined;
  const grantsPqVal = grantsPriorityQueue ? 1 : 0;

  // Custom pricing: validate using effective values (sent fields override current).
  const customPriceWasSent = customPrice !== undefined;
  const effectiveCustomPrice = customPriceWasSent ? !!customPrice : !!product.custom_price;
  const minWasSent = priceMinCents !== undefined;
  const maxWasSent = priceMaxCents !== undefined;
  const effectiveMin = minWasSent ? normalizeAmountCents(priceMinCents) : product.price_min_cents;
  const effectiveMax = maxWasSent ? normalizeAmountCents(priceMaxCents) : product.price_max_cents;
  if (effectiveCustomPrice) {
    const check = validateCustomPricing({
      customPrice: true,
      priceMinCents: effectiveMin,
      priceMaxCents: effectiveMax,
      type: effectiveType
    });
    if (!check.ok) return res.status(400).json({ error: check.error });
  }
  const customPriceVal = customPrice ? 1 : 0;
  const minVal = minWasSent ? normalizeAmountCents(priceMinCents) : null;
  const maxVal = maxWasSent ? normalizeAmountCents(priceMaxCents) : null;

  const discordRoleIdWasSent = discordRoleId !== undefined;
  const discordRoleIdVal = discordRoleIdWasSent ? normalizeDiscordRoleId(discordRoleId) : null;

  db.prepare(`
    UPDATE products SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      price_cents = COALESCE(?, price_cents),
      image_url = COALESCE(?, image_url),
      type = COALESCE(?, type),
      interval_days = CASE WHEN ? THEN ? ELSE interval_days END,
      images_json = COALESCE(?, images_json),
      stock_limit = CASE WHEN ? THEN ? ELSE stock_limit END,
      stock_limit_overrides = CASE WHEN ? THEN ? ELSE stock_limit_overrides END,
      server_specific = CASE WHEN ? THEN ? ELSE server_specific END,
      grants_priority_queue = CASE WHEN ? THEN ? ELSE grants_priority_queue END,
      custom_price = CASE WHEN ? THEN ? ELSE custom_price END,
      price_min_cents = CASE WHEN ? THEN ? ELSE price_min_cents END,
      price_max_cents = CASE WHEN ? THEN ? ELSE price_max_cents END,
      discord_role_id = CASE WHEN ? THEN ? ELSE discord_role_id END,
      active = COALESCE(?, active),
      updated_at = unixepoch()
    WHERE id = ?
  `).run(
    title !== undefined ? title.trim() : null,
    description !== undefined ? description.trim() : null,
    priceCents !== undefined ? priceCents : null,
    imageUrl !== undefined ? imageUrl : null,
    type !== undefined ? type : null,
    intervalDaysWasSent ? 1 : 0,
    intervalDaysParam,
    imagesJson !== undefined ? imagesJson : null,
    stockLimitWasSent ? 1 : 0,
    stockLimitVal === undefined ? null : stockLimitVal,
    stockOverridesWasSent ? 1 : 0,
    stockOverridesVal === undefined ? null : stockOverridesVal,
    serverSpecificWasSent ? 1 : 0,
    serverSpecificVal,
    grantsPqWasSent ? 1 : 0,
    grantsPqVal,
    customPriceWasSent ? 1 : 0,
    customPriceVal,
    minWasSent ? 1 : 0,
    minVal,
    maxWasSent ? 1 : 0,
    maxVal,
    discordRoleIdWasSent ? 1 : 0,
    discordRoleIdVal,
    active !== undefined ? (active ? 1 : 0) : null,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json(attachStock(attachImages(updated)));
});

// Soft-delete (deactivate) product
router.delete('/api/shop/admin/products/:id', requireAdmin, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  db.prepare('UPDATE products SET active = 0, updated_at = unixepoch() WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Permanent delete product
router.delete('/api/shop/admin/products/:id/permanent', requireAdmin, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  // Check for existing orders referencing this product
  const orderCount = db.prepare('SELECT COUNT(*) as cnt FROM orders WHERE product_id = ?').get(req.params.id).cnt;
  if (orderCount > 0) {
    return res.status(400).json({ error: `Cannot delete — ${orderCount} order(s) reference this product. Use Hard Delete to remove the product and its orders together.` });
  }

  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Hard delete: nukes the product and its orders. Any orders tied to a live
// PayPal subscription must be cancelled with PayPal first — once the order
// rows are gone we lose the paypal_subscription_id link and PayPal would
// keep auto-billing the buyer forever with no local record of it.
router.delete('/api/shop/admin/products/:id/hard', requireAdmin, async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const subsToCancel = db.prepare(`
    SELECT DISTINCT paypal_subscription_id AS subId, test_mode
    FROM orders
    WHERE product_id = ? AND paypal_subscription_id IS NOT NULL AND status = 'completed'
  `).all(req.params.id);

  // Each cancel is marked as the shop's own first, so the CANCELLED webhooks that
  // follow post no card per buyer while the orders are being deleted.
  let cancelledSubs = 0;
  for (const s of subsToCancel) {
    const r = await paymentEvents.cancelAtPayPal({
      db, paypal, testMode: !!s.test_mode, subscriptionId: s.subId, reason: 'Product deleted by admin', source: 'hard_delete'
    });
    if (r.outcome === 'cancelled') cancelledSubs++;
    else if (r.outcome === 'failed') console.error('[hard-delete] Failed to cancel PayPal subscription %s: %s', s.subId, r.error);
    else if (r.outcome === 'unknown') console.error('[hard-delete] PayPal did not answer the cancel of subscription %s, check it in PayPal: %s', s.subId, r.error);
  }

  // Snapshot (user, role) pairs before the rows disappear — we'll need them
  // to remove Discord roles after deletion (the helper queries by order id,
  // which won't exist anymore).
  const discordToCheck = db.prepare(`
    SELECT DISTINCT u.steam_id AS steam_id, u.discord_id AS user_id, p.discord_role_id AS role_id
    FROM orders o JOIN products p ON o.product_id = p.id JOIN users u ON o.steam_id = u.steam_id
    WHERE o.product_id = ? AND o.status = 'completed'
      AND p.discord_role_id IS NOT NULL AND u.discord_id IS NOT NULL
  `).all(req.params.id);

  let deletedOrders = 0;
  const tx = db.transaction(() => {
    deletedOrders = db.prepare('DELETE FROM orders WHERE product_id = ?').run(req.params.id).changes;
    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  });
  tx();

  // After deletion, scrub Discord roles for affected users — but only if
  // no other product still grants them the same role.
  for (const r of discordToCheck) {
    const stillOwed = db.prepare(`
      SELECT 1 FROM orders o2 JOIN products p2 ON o2.product_id = p2.id
      WHERE o2.steam_id = ? AND o2.status = 'completed' AND p2.discord_role_id = ?
      LIMIT 1
    `).get(r.steam_id, r.role_id);
    if (stillOwed) continue;
    discord.removeRole(r.user_id, r.role_id, 'product-hard-delete')
      .catch(e => console.error('[discord] hard-delete role remove %s/%s: %s', r.user_id, r.role_id, e.message));
  }

  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));

  res.json({ ok: true, deletedOrders, cancelledSubs });
});

// Orders a staff revoke is running for right now (staffRevoke.createRevokeTracker).
// PayPal's refund webhook can land before the refund call returns; for an order in
// here the webhook is answered 500 so PayPal delivers it again once the revoke has
// finished, and a second revoke of the same order is refused.
const revokesInFlight = staffRevoke.createRevokeTracker();

// Revoke an order (admin only). With { refund: true } also issues a PayPal
// refund of the original capture. staffRevoke.revokeOrder has the rules: one staff
// action, one card, and the refund and cancel it makes stay quiet when their
// webhooks arrive.
router.post('/api/shop/admin/revoke', requireAdmin, async (req, res) => {
  const { orderId, refund } = req.body;
  if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

  const order = db.prepare(`
    SELECT o.*, u.persona, u.bi_uid, u.platform, u.gamertag, u.bm_player_id,
           p.title as product_title, p.type, p.currency
    FROM orders o JOIN users u ON o.steam_id = u.steam_id JOIN products p ON o.product_id = p.id
    WHERE o.id = ? AND o.status = 'completed'
  `).get(orderId);

  if (!order) return res.status(404).json({ error: 'Completed order not found' });

  let result;
  try {
    result = await staffRevoke.revokeOrder(db, { order, refund: !!refund }, {
      paypal,
      tracker: revokesInFlight,
      markCancelledLocally: (subId) => markSubscriptionCancelledLocally(subId, 'cancelled'),
      sendCard: (specFn) => sendCard(specFn),
      sendRefundEmail: ({ order: o, amountCents }) => {
        sendRefundConfirmation({
          to: o.payer_email,
          displayName: playerNameOf(o),
          productTitle: o.product_title,
          amountCents,
          currency: o.currency,
          captureId: o.paypal_capture_id,
          orderId: o.id,
          dateMs: Date.now()
        }).catch(e => console.error('[refund-mail] send failed:', e.message));
      },
      afterRevoke: (id) => {
        syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
        tryRemoveDiscordRoleForOrder(id);
      }
    });
  } catch (e) {
    console.error(`[revoke] order #${order.id}: revoke failed: ${e.message}`);
    return res.status(500).json({ error: 'Revoke failed: ' + e.message });
  }
  res.status(result.status).json(result.body);
});

// Read-only resolver behind the Discord /refund command: turn an in-game GUID
// into "exactly which order am I about to refund, and what will it cost the
// player". Deliberately a preview rather than a second money path -- the actual
// refund still goes through /api/shop/admin/revoke, which is the audited one.
//
// Called twice by the bot: once to build the confirmation, and again afterwards
// to prove the subscription really did end up CANCELLED at PayPal.
router.get('/api/shop/admin/refund-preview', requireAdmin, async (req, res) => {
  const guid = String(req.query.guid || '').trim().toLowerCase();
  if (!guid) return res.status(400).json({ error: 'Give a GUID' });

  // Shape-check before touching the table. A truncated or mistyped GUID must
  // fail loudly rather than fall through to whatever it happens to match.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(guid)) {
    return res.status(400).json({ error: 'That is not a valid GUID. Expected xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' });
  }
  // The all-zero GUID is a placeholder someone can paste in, and it IS present
  // on a real account -- so without this it resolves to a live, refundable
  // player. Never a genuine identity; refuse it.
  if (/^0+$/.test(guid.replace(/-/g, ''))) {
    return res.status(400).json({ error: 'That is the placeholder all-zero GUID, not a real identity. Get their real one.' });
  }

  // A GUID is NOT unique: a player with both a Steam and a console account can
  // carry the same in-game id on both. Refuse rather than guess which to refund.
  const users = db.prepare(
    "SELECT * FROM users WHERE lower(bi_uid) = ?"
  ).all(guid);
  if (!users.length) return res.status(404).json({ error: 'No account has that GUID' });
  if (users.length > 1) {
    return res.status(409).json({
      error: 'That GUID is on more than one account, so I will not guess which to refund',
      accounts: users.map(u => ({ steamId: u.steam_id, persona: u.persona, gamertag: u.gamertag, platform: u.platform }))
    });
  }
  const user = users[0];

  const orders = db.prepare(`
    SELECT o.*, p.title AS product_title, p.type AS product_type
    FROM orders o JOIN products p ON p.id = o.product_id
    WHERE o.steam_id = ? ORDER BY o.completed_at DESC, o.id DESC
  `).all(user.steam_id);

  const target = orders.find(o => o.status === 'completed' && o.paypal_capture_id);
  const now = Math.floor(Date.now() / 1000);

  let subscription = null;
  const subId = target && target.paypal_subscription_id;
  if (subId) {
    try {
      const sub = await paypal.getSubscription(!!(target && target.test_mode), subId);
      const b = sub.billing_info || {};
      subscription = {
        id: subId,
        status: sub.status,
        alreadyCancelled: sub.status === 'CANCELLED',
        lastPayment: b.last_payment ? { amount: b.last_payment.amount.value, at: b.last_payment.time } : null,
        nextBilling: b.next_billing_time || null,
        failedPayments: b.failed_payments_count ?? null
      };
    } catch (e) {
      subscription = { id: subId, status: 'UNKNOWN', error: e.message };
    }
  }

  res.json({
    ok: true,
    player: {
      persona: user.persona, gamertag: user.gamertag, platform: user.platform,
      steamId: user.steam_id, guid: user.bi_uid, discordId: user.discord_id
    },
    target: target ? {
      orderId: target.id,
      product: target.product_title,
      amountCents: target.amount_cents,
      currency: target.currency || 'USD',
      serverId: target.server_id,
      paidAt: target.completed_at,
      coversUntil: target.effective_until,
      stillInPaidPeriod: !!(target.effective_until && target.effective_until > now),
      captureId: target.paypal_capture_id
    } : null,
    refundable: !!target,
    reason: target ? null
      : (orders.some(o => o.status === 'completed')
          ? 'Their most recent completed order has no PayPal capture stored, so it cannot be refunded through the API'
          : 'They have no completed orders to refund'),
    subscription,
    orderHistory: orders.slice(0, 6).map(o => ({
      id: o.id, status: o.status, product: o.product_title,
      amountCents: o.amount_cents, paidAt: o.completed_at, coversUntil: o.effective_until
    }))
  });
});

// ============================================================
//  Priority Queue management (used by reforgedz admin page)
// ============================================================

// Every current priority queue holder, one entry per in-game ID, for the admin page.
// Orders only, by the one rule (pqEntitlement.livePqRows): exactly the IDs the sync
// writes into game.admins. The entry shape is older than the rule and is kept, so
// sources is always 'purchase', grantedAt is always null and every expiry is a date.
// orders lists each live order (a subscription's latest live cycle), so staff can
// say which one to move when an in-game ID has more than one. It carries only what
// the move needs: no account id and no PayPal subscription id, which every admin page
// user with the GM tool would otherwise receive.
function buildPriorityQueueList(now = Math.floor(Date.now() / 1000)) {
  const byGuid = new Map();
  const blank = (v) => Object.fromEntries(SERVER_IDS.map(id => [id, v]));

  for (const r of pqEntitlement.livePqRows(db, now)) {
    let e = byGuid.get(r.guid);
    if (!e) {
      e = { guid: r.guid, displayName: r.name || '', presence: blank(false), sources: blank(null), exp: blank(-Infinity), latest: -Infinity, purchasedAt: null, units: new Map() };
      byGuid.set(r.guid, e);
    } else if (!e.displayName && r.name) {
      e.displayName = r.name;
    }
    if (r.created_at != null && (e.purchasedAt == null || r.created_at > e.purchasedAt)) e.purchasedAt = r.created_at;
    const until = Number(r.effective_until);
    if (until > e.latest) e.latest = until;
    for (const id of pqEntitlement.coveredServers(r, SERVER_IDS)) {
      e.presence[id] = true;
      e.sources[id] = 'purchase';
      if (until > e.exp[id]) e.exp[id] = until;
    }
    const key = r.paypal_subscription_id ? `sub:${r.paypal_subscription_id}` : `order:${r.order_id}`;
    const prev = e.units.get(key);
    if (!prev || until > prev.effectiveUntil || (until === prev.effectiveUntil && r.order_id > prev.id)) {
      e.units.set(key, {
        id: r.order_id,
        serverId: r.server_specific ? r.server_id : null,
        isSubscription: !!r.paypal_subscription_id,
        effectiveUntil: until
      });
    }
  }

  const out = Array.from(byGuid.values()).map(e => {
    const expiry = {};        // per-server: unix ts, or null = not held there
    let expiresAt = null;     // soonest expiry across servers held
    let assigned = false;     // holds at least one server
    for (const id of SERVER_IDS) {
      if (!e.presence[id]) { expiry[id] = null; continue; }
      assigned = true;
      expiry[id] = e.exp[id];
      if (expiresAt == null || e.exp[id] < expiresAt) expiresAt = e.exp[id];
    }
    // An order on a server the shop no longer syncs holds nothing, but still says when it ends.
    if (!assigned && isFinite(e.latest)) expiresAt = e.latest;
    return {
      guid: e.guid,
      displayName: e.displayName,
      presence: e.presence,
      sources: e.sources,
      expiry,
      expiresAt,
      assigned,
      hasEntitlement: true,
      purchasedAt: e.purchasedAt,
      grantedAt: null,
      orders: Array.from(e.units.values()).sort((a, b) => a.id - b.id)
    };
  });

  return out.sort((a, b) =>
    (a.displayName || '').toLowerCase().localeCompare((b.displayName || '').toLowerCase())
  );
}

// sellable says whether a server can take a staff move (moveSubscriptionServer moves
// priority queue only to a server the shop sells), so the admin page offers only those.
// reserved is the priority queue checkouts waiting at PayPal for the server
// (pqEntitlement.pqSlotsPerServer): each may become an admin list entry within minutes,
// so the GM tab counts them before adding a game master.
function priorityQueueServers(now = Math.floor(Date.now() / 1000)) {
  const slots = pqEntitlement.pqSlotsPerServer(db, { now });
  return SERVER_IDS.map(id => ({
    id, label: SERVER_LABELS[id] || id.toUpperCase(), sellable: SELLABLE_SERVER_IDS.includes(id),
    reserved: slots[id] ? slots[id].reserved : 0
  }));
}

// ============================================================
//  Save Inspector — freetext search over a server's persistence
//  (the .save JSON files), since Pterodactyl's file browser can't.
// ============================================================
// Every reachable server, not just the sellable ones — EU3 is a dev box now but
// its saves still need inspecting.
router.get('/api/shop/admin/save-servers', requireAdmin, (req, res) => {
  res.json(listSaveServers());
});

router.get('/api/shop/admin/save-search', requireAdmin, async (req, res) => {
  const { server, q, limit } = req.query;
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  if (!q || !String(q).trim()) return res.status(400).json({ error: 'Enter something to search for.' });
  try {
    const out = await searchSaveFiles(server, String(q), limit);
    res.json(out);
  } catch (e) {
    console.error('[save-search]', e.message);
    res.status(500).json({ error: e.message || 'Search failed' });
  }
});

// Is the game server running? (destructive edits/deletes are blocked while it is)
router.get('/api/shop/admin/save-status', requireAdmin, async (req, res) => {
  const { server } = req.query;
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json({ running: await getServerRunning(server) });
  } catch (e) {
    console.error('[save-status]', e.message);
    res.status(500).json({ error: e.message || 'Status check failed' });
  }
});

router.post('/api/shop/admin/save-update', requireAdmin, async (req, res) => {
  const { server, id, json, force } = req.body || {};
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    const r = await updateSaveRecord(server, id, json, force === true);
    if (!r.ok && r.error === 'server_running') return res.status(409).json({ error: 'Server is running — stop it first (changes would be overwritten).' });
    if (!r.ok && r.error === 'not_found') return res.status(404).json({ error: 'Record not found.' });
    if (!r.ok && r.error === 'Invalid JSON') return res.status(400).json({ error: 'Invalid JSON.' });
    res.json(r);
  } catch (e) {
    console.error('[save-update]', e.message);
    res.status(e.message === 'Invalid JSON' || e.message === 'Invalid entity id' ? 400 : 500).json({ error: e.message || 'Update failed' });
  }
});

router.post('/api/shop/admin/save-delete', requireAdmin, async (req, res) => {
  const { server, ids, force } = req.body || {};
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    const r = await deleteSaveRecords(server, ids, force === true);
    if (!r.ok && r.error === 'server_running') return res.status(409).json({ error: 'Server is running — stop it first (a delete can reappear).' });
    res.json(r);
  } catch (e) {
    console.error('[save-delete]', e.message);
    res.status(500).json({ error: e.message || 'Delete failed' });
  }
});

router.get('/api/shop/admin/save-orphans', requireAdmin, async (req, res) => {
  const { server, category } = req.query;
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json(await scanOrphans(server, category || 'Item'));
  } catch (e) {
    console.error('[save-orphans]', e.message);
    res.status(500).json({ error: e.message || 'Scan failed' });
  }
});

router.post('/api/shop/admin/save-purge-orphans', requireAdmin, async (req, res) => {
  const { server, category, force } = req.body || {};
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    const r = await purgeOrphans(server, category || 'Item', force === true);
    if (!r.ok && r.error === 'server_running') return res.status(409).json({ error: 'Server is running — stop it first.' });
    res.json(r);
  } catch (e) {
    console.error('[save-purge-orphans]', e.message);
    res.status(500).json({ error: e.message || 'Purge failed' });
  }
});

// Fast read-only counts for the loose sweep: total / protected / prunable.
router.get('/api/shop/admin/save-scan-loose', requireAdmin, async (req, res) => {
  const { server, category } = req.query;
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json(await scanLooseItems(server, category || 'Item'));
  } catch (e) {
    console.error('[save-scan-loose]', e.message);
    res.status(500).json({ error: e.message || 'Scan failed' });
  }
});

// Purge ALL loose records in a category (Item) EXCEPT placed structures (protected
// stores: workbenches / salvage stations). Stored loot is embedded in full inside
// its parent Character/BaseBuilding/Vehicle record, so it survives the sweep.
// Recoverable trash. Verified against a live DB copy on DEV.
router.post('/api/shop/admin/save-purge-loose', requireAdmin, async (req, res) => {
  const { server, category, force } = req.body || {};
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    const r = await purgeLooseItems(server, category || 'Item', force === true);
    if (!r.ok && r.error === 'server_running') return res.status(409).json({ error: 'Server is running — stop it first.' });
    res.json(r);
  } catch (e) {
    console.error('[save-purge-loose]', e.message);
    res.status(500).json({ error: e.message || 'Purge failed' });
  }
});

// Inactive-character prune: count / remove Character records for accounts not seen in N days.
router.get('/api/shop/admin/save-scan-inactive', requireAdmin, async (req, res) => {
  const { server, days } = req.query;
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json(await scanInactiveCharacters(server, days || 14));
  } catch (e) {
    console.error('[save-scan-inactive]', e.message);
    res.status(500).json({ error: e.message || 'Scan failed' });
  }
});

router.post('/api/shop/admin/save-purge-inactive', requireAdmin, async (req, res) => {
  const { server, days, force } = req.body || {};
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    const r = await purgeInactiveCharacters(server, days || 14, force === true);
    if (!r.ok && r.error === 'server_running') return res.status(409).json({ error: 'Server is running — stop it first.' });
    res.json(r);
  } catch (e) {
    console.error('[save-purge-inactive]', e.message);
    res.status(500).json({ error: e.message || 'Prune failed' });
  }
});

// Copy the full save DB from one server to another (destination must be stopped;
// its old .save is kept as .save.pre-copy.<ts> on the box). Runs detached — the
// UI polls the status route below with the returned jobId.
router.post('/api/shop/admin/save-copy-db', requireAdmin, async (req, res) => {
  const { from, to, confirm } = req.body || {};
  if (!isSaveServerId(from) || !isSaveServerId(to)) return res.status(400).json({ error: 'Pick valid servers.' });
  if (from === to) return res.status(400).json({ error: 'Source and destination must differ.' });
  if (confirm !== to) return res.status(400).json({ error: 'Confirmation mismatch — type the destination server id.' });
  try {
    res.json(await startSaveDbCopy(from, to));
  } catch (e) {
    if (e.code === 'destination_running') return res.status(409).json({ error: 'Destination server is RUNNING — stop it in the panel first.' });
    console.error('[save-copy-db]', e.message);
    res.status(500).json({ error: e.message || 'Copy failed to start' });
  }
});

router.get('/api/shop/admin/save-copy-db-status', requireAdmin, async (req, res) => {
  const job = String(req.query.job || '');
  if (!/^[a-z0-9]{6,40}$/.test(job)) return res.status(400).json({ error: 'Bad job id.' });
  try {
    res.json(await getSaveDbCopyStatus(job));
  } catch (e) {
    console.error('[save-copy-db-status]', e.message);
    res.status(500).json({ error: e.message || 'Status check failed' });
  }
});

router.get('/api/shop/admin/save-collection', requireAdmin, async (req, res) => {
  const { server, category } = req.query;
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json(await listCollectionRecords(server, category || 'Item'));
  } catch (e) {
    console.error('[save-collection]', e.message);
    res.status(500).json({ error: e.message || 'Collection load failed' });
  }
});

router.get('/api/shop/admin/save-collection-stats', requireAdmin, async (req, res) => {
  const { server, category } = req.query;
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json(await getCollectionStats(server, category || 'Item'));
  } catch (e) {
    console.error('[save-collection-stats]', e.message);
    res.status(500).json({ error: e.message || 'Composition load failed' });
  }
});

router.get('/api/shop/admin/save-extra-stats', requireAdmin, async (req, res) => {
  const { server } = req.query;
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json(await getExtraStats(server));
  } catch (e) {
    console.error('[save-extra-stats]', e.message);
    res.status(500).json({ error: e.message || 'Stats failed' });
  }
});

router.get('/api/shop/admin/save-players', requireAdmin, async (req, res) => {
  const { server } = req.query;
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json(await listPlayers(server));
  } catch (e) {
    console.error('[save-players]', e.message);
    res.status(500).json({ error: e.message || 'Player list failed' });
  }
});

router.get('/api/shop/admin/save-scan-dead', requireAdmin, async (req, res) => {
  const { server } = req.query;
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json(await scanDeadCharacters(server));
  } catch (e) {
    console.error('[save-scan-dead]', e.message);
    res.status(500).json({ error: e.message || 'Scan failed' });
  }
});

router.post('/api/shop/admin/save-purge-dead', requireAdmin, async (req, res) => {
  const { server, force } = req.body || {};
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    const r = await purgeDeadCharacters(server, force === true);
    if (!r.ok && r.error === 'server_running') return res.status(409).json({ error: 'Server is running — stop it first.' });
    res.json(r);
  } catch (e) {
    console.error('[save-purge-dead]', e.message);
    res.status(500).json({ error: e.message || 'Purge failed' });
  }
});

router.get('/api/shop/admin/save-record', requireAdmin, async (req, res) => {
  const { server, id } = req.query;
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json(await getSaveRecord(server, id));
  } catch (e) {
    console.error('[save-record]', e.message);
    res.status(500).json({ error: e.message || 'Lookup failed' });
  }
});

router.get('/api/shop/admin/save-categories', requireAdmin, async (req, res) => {
  const { server } = req.query;
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json(await listSaveCategories(server));
  } catch (e) {
    console.error('[save-categories]', e.message);
    res.status(500).json({ error: e.message || 'Failed to list categories' });
  }
});

// Streams a .tar.gz of a folder/record under the save root. GET (with the admin
// session cookie) so it can be triggered as a plain browser download.
router.get('/api/shop/admin/save-download', requireAdmin, async (req, res) => {
  const { server, path: relPath } = req.query;
  if (!isSaveServerId(server)) return res.status(400).json({ error: 'Invalid server' });
  let dl;
  try {
    dl = await openSaveDownloadStream(server, relPath);
  } catch (e) {
    console.error('[save-download]', e.message);
    return res.status(500).json({ error: e.message || 'Download failed' });
  }
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${dl.filename}"`);
  let done = false;
  const cleanup = () => { if (done) return; done = true; try { dl.conn.end(); } catch {} };
  dl.stream.on('error', () => { cleanup(); try { res.destroy(); } catch {} });
  dl.stream.on('close', cleanup);
  res.on('close', cleanup);
  dl.stream.pipe(res);
});

const BI_UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cleanGuid(s) {
  if (typeof s !== 'string') return null;
  const cleaned = s.trim().toLowerCase();
  return BI_UID_RE.test(cleaned) ? cleaned : null;
}

// List all priority-queue holders with their per-server presence
router.get('/api/shop/admin/priority-queue', requireAdmin, (req, res) => {
  res.json({
    servers: priorityQueueServers(),
    entries: buildPriorityQueueList()
  });
});

// Staff grants, per-server toggles, extensions and grant deletion are retired: the
// owner's rule is that priority queue comes only from a paid order. A player is
// moved by changing their order's server (the switch route below) and loses
// priority queue by a revoke. The old URLs answer 410 for one release, so the admin
// page gets a clear answer until it drops them.
function retiredGrantRoute(req, res) {
  res.status(410).json({
    code: 'retired',
    error: 'Staff priority queue grants are retired: priority queue now comes only from a paid order. To put a paying player on another server, move their order. To take priority queue away, revoke the order.'
  });
}

router.post('/api/shop/admin/priority-queue', requireAdmin, retiredGrantRoute);
router.post('/api/shop/admin/priority-queue/toggle', requireAdmin, retiredGrantRoute);
router.post('/api/shop/admin/priority-queue/extend', requireAdmin, retiredGrantRoute);
router.delete('/api/shop/admin/priority-queue/:guid', requireAdmin, retiredGrantRoute);

// Refreshed list entry for a guid (or a stub when it holds priority queue nowhere).
function pqEntryFor(guid) {
  const g = String(guid || '').toLowerCase();
  const entry = buildPriorityQueueList().find(e => String(e.guid).toLowerCase() === g);
  return entry || { guid, displayName: '', presence: Object.fromEntries(SERVER_IDS.map(id => [id, false])), sources: Object.fromEntries(SERVER_IDS.map(id => [id, null])) };
}

// Move a paying holder's priority queue to another server. A move is a change to
// the subscription (pqEntitlement.moveSubscriptionServer): the order's server
// changes on every row of its subscription, so the paid period carries over and
// renewals pay for the new server; nothing else is written.
//
// Body { guid, from, to } plus optional orderId and reason; from may be left out
// when orderId says which order. Refused with 409 when the destination has no free
// slot (destination_full), the order has lapsed or was refunded (not_live), the ID
// has more than one order to choose from and no orderId (ambiguous), or the ID
// already holds priority queue there (already_on_destination); 400 for the server
// it is already on. Recorded in admin_audit, then synced, with one card.
router.post('/api/shop/admin/priority-queue/switch', requireAdmin, (req, res) => {
  const { guid: rawGuid, from, to, orderId: rawOrderId, reason } = req.body || {};
  const guid = cleanGuid(rawGuid);
  if (!guid) return res.status(400).json({ error: 'Invalid GUID' });
  let orderId = null;
  if (rawOrderId !== undefined && rawOrderId !== null && rawOrderId !== '') {
    orderId = Number(rawOrderId);
    if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ code: 'bad_request', error: 'Invalid orderId' });
  }
  const why = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : null;
  const actor = adminActor(req);

  let result;
  try {
    result = pqEntitlement.moveSubscriptionServer(db, {
      guid, from: from || null, to, orderId, actor, reason: why, ip: req.ip, now: Math.floor(Date.now() / 1000)
    });
  } catch (e) {
    console.error(`[pq-move] move failed: ${e.message}`);
    return res.status(500).json({ error: 'Move failed: ' + e.message });
  }
  if (!result.ok) {
    const { ok, status, ...body } = result;
    return res.status(status).json(body);
  }

  console.log(`[pq-move] ${actor} moved order #${result.orderId} (${result.updated} row(s)) from ${result.from} to ${result.to}`);
  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
  sendCard(() => cards.staffQueueMoveCard({
    order: getOrderWithContext(result.orderId), from: result.from, to: result.to, orderIds: result.orderIds, reason: why
  }));
  res.json({
    ok: true, from: result.from, to: result.to,
    orderId: result.orderId, isSubscription: !!result.subscriptionId, orderIds: result.orderIds,
    entry: pqEntryFor(guid)
  });
});

// ============================================================
//  Finances (Stripe balance + expenses + revenue rollups)
// ============================================================

async function fetchProviderBalance() {
  // PayPal balance via the reporting API. Live unless only sandbox is set up.
  const useTest = !paypal.isConfigured(false);
  const bal = await paypal.getBalance(useTest);
  // Normalize to the same { available, pending } shape the finances UI used
  // for Stripe (array of { amount, currency }).
  const available = [];
  const pending = [];
  for (const b of bal.balances || []) {
    const total = b.total_balance || b.available_balance || {};
    const avail = b.available_balance || {};
    const withheld = b.withheld_balance || {};
    if (avail.value != null) available.push({ amount: Math.round(parseFloat(avail.value) * 100), currency: (avail.currency_code || 'USD').toLowerCase() });
    if (withheld.value != null && parseFloat(withheld.value) > 0) pending.push({ amount: Math.round(parseFloat(withheld.value) * 100), currency: (withheld.currency_code || 'USD').toLowerCase() });
  }
  return {
    mode: bal.mode,
    error: bal.error || undefined,
    available,
    pending,
    instantAvailable: [],
    connectReserved: []
  };
}

function startOfMonthUnix() {
  const d = new Date();
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
}
function startOfYearUnix() {
  const d = new Date();
  return Math.floor(new Date(d.getFullYear(), 0, 1).getTime() / 1000);
}

// All revenue queries filter out orders we've marked as test_mode so historical
// sandbox runs don't pollute the rollups. New orders are tagged at checkout.
// "Refunded" money leaves out orders staff revoked without returning anything
// (revoked_without_refund_at): their status is 'refunded' so they grant nothing,
// but no money went back.
function revenueSummary() {
  const lifetime = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount_cents), 0) cents FROM orders WHERE status = 'completed' AND test_mode = 0`).get();
  const refunded = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount_cents), 0) cents FROM orders WHERE status = 'refunded' AND test_mode = 0 AND revoked_without_refund_at IS NULL`).get();
  const thisMonth = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount_cents), 0) cents FROM orders WHERE status = 'completed' AND test_mode = 0 AND completed_at >= ?`).get(startOfMonthUnix());
  const thisYear = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount_cents), 0) cents FROM orders WHERE status = 'completed' AND test_mode = 0 AND completed_at >= ?`).get(startOfYearUnix());
  return {
    lifetimeCount: lifetime.c, lifetimeCents: lifetime.cents,
    refundedCount: refunded.c, refundedCents: refunded.cents,
    netCents: lifetime.cents - refunded.cents,
    monthCount: thisMonth.c, monthCents: thisMonth.cents,
    yearCount: thisYear.c, yearCents: thisYear.cents
  };
}

// Estimate Monthly Recurring Revenue. Combines two sources:
//   1) Legacy Stripe subs still tracked in our orders table (kept so historical
//      MRR from before the PayPal cutover still counts until those subs end).
//   2) Active PayPal subscriptions pulled live from the Billing Plans API
//      (priority-queue subs etc. that aren't created via our checkout flow).
// Per-day intervals normalize to a 30-day month; monthly subs at face value.
async function mrrEstimate() {
  const rows = db.prepare(`
    SELECT o.amount_cents, p.type, p.interval_days, o.stripe_subscription_id
    FROM orders o
    JOIN products p ON o.product_id = p.id
    WHERE o.status = 'completed' AND o.test_mode = 0 AND o.stripe_subscription_id IS NOT NULL
    GROUP BY o.stripe_subscription_id
    HAVING o.id = MAX(o.id)
  `).all();
  let cents = 0;
  let count = 0;
  for (const r of rows) {
    let monthly = 0;
    if (r.type === 'subscription') monthly = r.amount_cents;
    else if (r.type === 'recurring_custom' && r.interval_days) monthly = Math.round(r.amount_cents * 30 / r.interval_days);
    if (monthly > 0) { cents += monthly; count += 1; }
  }

  let paypalSubs = [];
  let paypalError = null;
  try {
    const live = await paypal.listActiveSubscriptions(false);
    if (live.error) paypalError = live.error;
    paypalSubs = live.subscriptions || [];
  } catch (e) {
    paypalError = e.message;
  }
  for (const s of paypalSubs) {
    if (s.monthlyCents > 0) { cents += s.monthlyCents; count += 1; }
  }

  // Classic PayPal "Subscribe" button payments (Priority Queue, Supporter, etc.)
  // don't surface on the Billing Plans API. They DO flow through Transaction
  // Search though, so derive MRR from the last 30 days of transactions that
  // are not matched to one of our one-time orders.
  let legacySubMrrCents = 0;
  let legacySubPayers = 0;
  let legacyError = null;
  try {
    const txns = await paypal.listTransactions(false, { days: 31 });
    if (Array.isArray(txns) && txns.length) {
      const ourCaptureIds = new Set(
        db.prepare(`SELECT paypal_capture_id FROM orders WHERE paypal_capture_id IS NOT NULL AND test_mode = 0`)
          .all()
          .map(r => r.paypal_capture_id)
      );
      // Only count txns that look like recurring-subscription payments — must
      // have a positive amount, a subject matching a known recurring product,
      // and not already be tracked as one of our one-time orders. The subject
      // gate matters because Transaction Search also surfaces payouts, refunds
      // and ad-hoc captures (e.g. test payments) with null subjects.
      const SUB_SUBJECT_RE = /priority\s*queue|supporter|subscr|recurring/i;
      const byPayer = new Map();
      for (const t of txns) {
        if (!t || !t.id || !t.grossCents || t.grossCents <= 0) continue;
        if (!t.subject || !SUB_SUBJECT_RE.test(t.subject)) continue;
        if (ourCaptureIds.has(t.id)) continue; // one-time order we already fulfilled
        const key = (t.payerEmail || t.id).toLowerCase();
        const prev = byPayer.get(key);
        if (!prev || (t.date && (!prev.date || t.date > prev.date))) {
          byPayer.set(key, t);
        }
      }
      for (const t of byPayer.values()) {
        legacySubMrrCents += t.grossCents;
        legacySubPayers += 1;
      }
    } else if (txns && txns.error) {
      legacyError = txns.error;
    }
  } catch (e) {
    legacyError = e.message;
  }
  cents += legacySubMrrCents;
  count += legacySubPayers;

  return {
    activeSubs: count,
    mrrCents: cents,
    paypalSubs: paypalSubs.length,
    paypalError,
    legacySubPayers,
    legacySubMrrCents,
    legacyError
  };
}

function topProductsByRevenue(limit = 10) {
  return db.prepare(`
    SELECT p.id, p.title, p.type,
      COUNT(o.id) FILTER (WHERE o.status = 'completed' AND o.test_mode = 0) AS sales,
      COALESCE(SUM(o.amount_cents) FILTER (WHERE o.status = 'completed' AND o.test_mode = 0), 0) AS cents
    FROM products p
    LEFT JOIN orders o ON o.product_id = p.id
    GROUP BY p.id
    HAVING sales > 0
    ORDER BY cents DESC
    LIMIT ?
  `).all(limit);
}

function refundsByProduct(limit = 10) {
  return db.prepare(`
    SELECT p.id, p.title, p.type,
      COUNT(o.id) AS refunds,
      COALESCE(SUM(o.amount_cents), 0) AS cents
    FROM products p
    JOIN orders o ON o.product_id = p.id
    WHERE o.status = 'refunded' AND o.test_mode = 0 AND o.revoked_without_refund_at IS NULL
    GROUP BY p.id
    HAVING refunds > 0
    ORDER BY cents DESC
    LIMIT ?
  `).all(limit);
}

function topBuyers(limit = 10) {
  return db.prepare(`
    SELECT
      u.steam_id,
      COALESCE(u.gamertag, u.persona) AS name,
      u.platform,
      COUNT(o.id) AS orders,
      COALESCE(SUM(o.amount_cents), 0) AS cents
    FROM users u
    JOIN orders o ON o.steam_id = u.steam_id
    WHERE o.status = 'completed' AND o.test_mode = 0
    GROUP BY u.steam_id
    ORDER BY cents DESC
    LIMIT ?
  `).all(limit);
}

// Daily revenue series for the chart, last N days. Returns an array of
// { day: 'YYYY-MM-DD', cents } including zero days so the chart x-axis
// is continuous.
function dailyRevenue(days = 90) {
  const sinceUnix = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = db.prepare(`
    SELECT date(completed_at, 'unixepoch') AS day, COALESCE(SUM(amount_cents), 0) AS cents
    FROM orders
    WHERE status = 'completed' AND test_mode = 0 AND completed_at >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(sinceUnix);
  const map = new Map(rows.map(r => [r.day, r.cents]));
  const out = [];
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, cents: map.get(key) || 0 });
  }
  return out;
}

// Per-product per-month grid for the last 6 months across the top 5 products
function perProductPerMonth(productLimit = 5, monthCount = 6) {
  const top = db.prepare(`
    SELECT p.id, p.title
    FROM products p
    JOIN orders o ON o.product_id = p.id
    WHERE o.status = 'completed' AND o.test_mode = 0
    GROUP BY p.id
    ORDER BY SUM(o.amount_cents) DESC
    LIMIT ?
  `).all(productLimit);

  const months = [];
  const d = new Date();
  for (let i = monthCount - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const key = m.toISOString().slice(0, 7); // YYYY-MM
    months.push(key);
  }

  const rows = db.prepare(`
    SELECT product_id, strftime('%Y-%m', completed_at, 'unixepoch') AS m, COALESCE(SUM(amount_cents), 0) AS cents
    FROM orders
    WHERE status = 'completed' AND test_mode = 0 AND completed_at IS NOT NULL
    GROUP BY product_id, m
  `).all();
  const lookup = new Map();
  for (const r of rows) lookup.set(`${r.product_id}|${r.m}`, r.cents);

  return {
    months,
    products: top.map(p => ({
      id: p.id,
      title: p.title,
      cellsCents: months.map(m => lookup.get(`${p.id}|${m}`) || 0)
    }))
  };
}

// PayPal fees. We store the actual paypal_fee per order (fee_cents) at capture
// time, so sum those for accuracy. Orders captured before fee tracking (or
// legacy Stripe orders) fall back to PayPal's standard 2.99% + $0.49 estimate.
function feesEstimate() {
  const live = db.prepare(`
    SELECT COUNT(*) c, COALESCE(SUM(amount_cents), 0) cents,
           COALESCE(SUM(CASE WHEN fee_cents IS NOT NULL THEN fee_cents ELSE 0 END), 0) knownFees,
           COALESCE(SUM(CASE WHEN fee_cents IS NULL THEN 1 ELSE 0 END), 0) unknownCount,
           COALESCE(SUM(CASE WHEN fee_cents IS NULL THEN amount_cents ELSE 0 END), 0) unknownCents
    FROM orders
    WHERE status IN ('completed', 'refunded') AND test_mode = 0 AND amount_cents > 0
  `).get();
  const charges = live.c || 0;
  const grossCents = live.cents || 0;
  // Estimate the fee for orders where we don't have the real number.
  const estPercent = Math.round((live.unknownCents || 0) * 0.0299);
  const estFixed = (live.unknownCount || 0) * 49;
  const totalCents = (live.knownFees || 0) + estPercent + estFixed;
  return { charges, grossCents, knownFeesCents: live.knownFees || 0, estimatedCents: estPercent + estFixed, totalCents };
}

function listExpenses(kind) {
  if (kind) {
    return db.prepare(`SELECT id, label, amount_cents, tax_cents, note, kind, incurred_at, created_at, updated_at FROM monthly_expenses WHERE kind = ? ORDER BY COALESCE(incurred_at, created_at) DESC, amount_cents DESC, id ASC`).all(kind);
  }
  return db.prepare(`SELECT id, label, amount_cents, tax_cents, note, kind, incurred_at, created_at, updated_at FROM monthly_expenses ORDER BY kind ASC, amount_cents DESC, id ASC`).all();
}

// Recent PayPal transactions (last 31 days — the Transaction Search cap).
// Surfaced where the Stripe payouts list used to be. PayPal doesn't model
// bank "payouts" the same way; these are the actual money movements.
async function recentTransactions() {
  const useTest = !paypal.isConfigured(false);
  const txns = await paypal.listTransactions(useTest, { days: 31 });
  if (txns && txns.error) return { error: txns.error };
  return (txns || []).map(t => ({
    id: t.id,
    amount: t.grossCents,
    feeCents: t.feeCents,
    currency: (t.currency || 'USD').toLowerCase(),
    status: t.status,
    created: t.date ? Math.floor(new Date(t.date).getTime() / 1000) : null,
    type: t.subject || 'transaction'
  }));
}

function runway(paypalUsdCents, mrrCents, monthlyBurnCents) {
  const netMonthly = (mrrCents || 0) - (monthlyBurnCents || 0);
  if (netMonthly >= 0) return { profitable: true, monthsRemaining: null, netMonthlyCents: netMonthly };
  const months = paypalUsdCents > 0 ? paypalUsdCents / Math.abs(netMonthly) : 0;
  return { profitable: false, monthsRemaining: months, netMonthlyCents: netMonthly };
}

router.get('/api/shop/admin/finances', requireAdmin, async (req, res) => {
  const [balance, payouts, mrr] = await Promise.all([fetchProviderBalance(), recentTransactions(), mrrEstimate()]);
  const revenue = revenueSummary();
  const top = topProductsByRevenue(10);
  const refundsByProd = refundsByProduct(10);
  const buyers = topBuyers(10);
  const fees = feesEstimate();
  const chart = dailyRevenue(90);
  const grid = perProductPerMonth(5, 6);
  const monthlyExpenses = listExpenses('monthly');
  const oneOffExpenses = listExpenses('one_off');
  const monthlyTotal = monthlyExpenses.reduce((s, e) => s + (e.amount_cents || 0) + (e.tax_cents || 0), 0);
  const oneOffTotal = oneOffExpenses.reduce((s, e) => s + (e.amount_cents || 0) + (e.tax_cents || 0), 0);

  // Net position uses USD entries of available + pending minus monthly expenses
  // (one-offs are one-time and don't recur, so they hit only this period).
  const usdAvailable = (balance.available || []).filter(e => e.currency === 'usd').reduce((s, e) => s + (e.amount || 0), 0);
  const usdPending = (balance.pending || []).filter(e => e.currency === 'usd').reduce((s, e) => s + (e.amount || 0), 0);
  const paypalUsdCents = usdAvailable + usdPending;
  const run = runway(paypalUsdCents, mrr.mrrCents, monthlyTotal);

  res.json({
    balance,
    revenue,
    mrr,
    fees,
    topProducts: top,
    refundsByProduct: refundsByProd,
    topBuyers: buyers,
    chart,
    perProductPerMonth: grid,
    payouts,
    monthlyExpenses,
    oneOffExpenses,
    monthlyExpensesTotalCents: monthlyTotal,
    oneOffExpensesTotalCents: oneOffTotal,
    runway: run
  });
});

const EXPENSE_COLUMNS = `id, label, amount_cents, tax_cents, note, kind, incurred_at, created_at, updated_at`;

router.post('/api/shop/admin/expenses', requireAdmin, (req, res) => {
  const { label, amountCents, taxCents, note, kind, incurredAt } = req.body || {};
  if (!label || typeof label !== 'string' || !label.trim()) return res.status(400).json({ error: 'Label is required' });
  const cents = parseInt(amountCents, 10);
  if (!Number.isFinite(cents) || cents < 0) return res.status(400).json({ error: 'amountCents must be a non-negative integer' });
  const tax = taxCents !== undefined && taxCents !== null && taxCents !== '' ? parseInt(taxCents, 10) : 0;
  if (!Number.isFinite(tax) || tax < 0) return res.status(400).json({ error: 'taxCents must be a non-negative integer' });
  const kindVal = kind === 'one_off' ? 'one_off' : 'monthly';
  const incurred = kindVal === 'one_off' ? (parseInt(incurredAt, 10) || Math.floor(Date.now() / 1000)) : null;
  const r = db.prepare(`
    INSERT INTO monthly_expenses (label, amount_cents, tax_cents, note, kind, incurred_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(label.trim(), cents, tax, note ? String(note).trim() : null, kindVal, incurred);
  const row = db.prepare(`SELECT ${EXPENSE_COLUMNS} FROM monthly_expenses WHERE id = ?`).get(r.lastInsertRowid);
  res.json({ ok: true, expense: row });
});

router.put('/api/shop/admin/expenses/:id', requireAdmin, (req, res) => {
  const { label, amountCents, taxCents, note, kind, incurredAt } = req.body || {};
  const existing = db.prepare(`SELECT * FROM monthly_expenses WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Expense not found' });
  let centsVal = null;
  if (amountCents !== undefined) {
    const n = parseInt(amountCents, 10);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'amountCents must be a non-negative integer' });
    centsVal = n;
  }
  let taxVal = null;
  if (taxCents !== undefined) {
    const n = taxCents === null || taxCents === '' ? 0 : parseInt(taxCents, 10);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'taxCents must be a non-negative integer' });
    taxVal = n;
  }
  let kindVal = null;
  if (kind !== undefined) kindVal = kind === 'one_off' ? 'one_off' : 'monthly';
  let incurredVal = null;
  let incurredWasSent = incurredAt !== undefined;
  if (incurredWasSent) incurredVal = parseInt(incurredAt, 10) || null;
  db.prepare(`
    UPDATE monthly_expenses SET
      label = COALESCE(?, label),
      amount_cents = COALESCE(?, amount_cents),
      tax_cents = COALESCE(?, tax_cents),
      note = CASE WHEN ? THEN ? ELSE note END,
      kind = COALESCE(?, kind),
      incurred_at = CASE WHEN ? THEN ? ELSE incurred_at END,
      updated_at = unixepoch()
    WHERE id = ?
  `).run(
    label !== undefined ? String(label).trim() : null,
    centsVal,
    taxVal,
    note !== undefined ? 1 : 0,
    note !== undefined ? (note ? String(note).trim() : null) : null,
    kindVal,
    incurredWasSent ? 1 : 0,
    incurredVal,
    req.params.id
  );
  const row = db.prepare(`SELECT ${EXPENSE_COLUMNS} FROM monthly_expenses WHERE id = ?`).get(req.params.id);
  res.json({ ok: true, expense: row });
});

router.delete('/api/shop/admin/expenses/:id', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM monthly_expenses WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// Admin marks/unmarks an order as test-mode so it stops polluting revenue rollups
router.put('/api/shop/admin/orders/:id/test-mode', requireAdmin, (req, res) => {
  const { testMode } = req.body || {};
  const existing = db.prepare(`SELECT id, status FROM orders WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Order not found' });
  db.prepare(`UPDATE orders SET test_mode = ? WHERE id = ?`).run(testMode ? 1 : 0, req.params.id);
  res.json({ ok: true, id: existing.id, testMode: !!testMode });
});

// ============================================================
//  Discord role management
// ============================================================

router.get('/api/shop/admin/discord-roles', requireAdmin, async (req, res) => {
  try {
    const data = await discord.fetchAssignableRoles();
    res.json(data);
  } catch (e) {
    console.error('[discord] fetch roles failed:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// User links / updates their Discord ID. We verify they're in the guild,
// store the ID, then back-sync any role grants they were owed from past
// completed orders that hadn't fired (because we didn't have the ID then).
router.post('/api/shop/set-discord-id', requireAuth, async (req, res) => {
  const { discordId: raw } = req.body || {};
  if (raw == null || raw === '') {
    // Clear linkage; also strip any roles the shop had assigned (best-effort)
    const existing = db.prepare('SELECT discord_id FROM users WHERE steam_id = ?').get(req.user.steam_id);
    if (existing && existing.discord_id) {
      const roles = db.prepare(`
        SELECT DISTINCT p.discord_role_id AS role_id
        FROM orders o JOIN products p ON o.product_id = p.id
        WHERE o.steam_id = ? AND o.status = 'completed' AND p.discord_role_id IS NOT NULL
      `).all(req.user.steam_id);
      for (const r of roles) {
        try { await discord.removeRole(existing.discord_id, r.role_id, `discord-unlink:${req.user.steam_id}`); }
        catch (e) { console.error('[discord] remove on unlink failed:', e.message); }
      }
    }
    db.prepare('UPDATE users SET discord_id = NULL, discord_linked_via = NULL WHERE steam_id = ?').run(req.user.steam_id);
    req.user.discord_id = null;
    return res.json({ ok: true, discord_id: null });
  }

  const cleaned = String(raw).trim();
  if (!/^\d{15,25}$/.test(cleaned)) {
    return res.status(400).json({ error: 'Invalid Discord ID. Use Discord Developer Mode → right-click your name → Copy User ID.' });
  }
  const result = await linkDiscordAccount(req.user, cleaned, { source: 'paste' });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, discord_id: cleaned, displayName: result.displayName, rolesAssigned: result.rolesAssigned });
});

// One way to link a Discord account, shared by the paste box and the OAuth
// callback, so both refuse the same things and grant the same roles.
//
// A Discord account already on another ReforgedZ account is refused, never
// moved: shared consoles and resold accounts produce that pattern
// legitimately, so staff sort it out in a ticket (owner's call, 2026-08-25).
async function linkDiscordAccount(user, discordId, { source = 'paste', displayName = null } = {}) {
  const other = db.prepare('SELECT steam_id, persona FROM users WHERE discord_id = ? AND steam_id != ?').get(discordId, user.steam_id);
  if (other) {
    console.warn('[discord-link] refused: %s already linked to %s (%s), asked by %s via %s', discordId, other.steam_id, other.persona, user.steam_id, source);
    return { ok: false, status: 409, code: 'taken', error: 'That Discord account is already linked to another ReforgedZ account. Open a Shop Support ticket in Discord and we will sort it out.' };
  }

  let member;
  try { member = await discord.verifyMember(discordId); }
  catch (e) { return { ok: false, status: 502, code: 'lookup', error: 'Discord lookup failed: ' + e.message }; }
  if (!member) return { ok: false, status: 404, code: 'notmember', error: "You're not a member of the ReforgedZ Discord. Join first, then come back." };

  // How it was linked is kept: only a Discord sign-in proves the account is the
  // player's, so only that link counts as proof of a staff role (sync.js).
  db.prepare('UPDATE users SET discord_id = ?, discord_linked_via = ? WHERE steam_id = ?')
    .run(discordId, source === 'oauth' ? 'oauth' : 'paste', user.steam_id);
  user.discord_id = discordId;

  // Back-fill any role grants this user is owed.
  //
  // The expiry filter matters: without it, linking Discord re-granted every
  // role the account had EVER bought, including subscriptions that lapsed
  // months ago -- and the reconciler only sweeps when a cycle just lapsed, so
  // the role would stick around indefinitely. Same entitlement rule as
  // entitledRolePairKeys() (pqEntitlement.perksLiveSql).
  const owed = db.prepare(`
    SELECT DISTINCT p.discord_role_id AS role_id
    FROM orders o JOIN products p ON o.product_id = p.id
    WHERE o.steam_id = @steamId
      AND p.discord_role_id IS NOT NULL
      AND ${pqEntitlement.perksLiveSql('o', 'p')}
  `).all({ steamId: user.steam_id, now: Math.floor(Date.now() / 1000) });
  let assigned = 0;
  for (const r of owed) {
    try { await discord.assignRole(discordId, r.role_id, `discord-link-backfill:${user.steam_id}`); assigned++; }
    catch (e) { console.error('[discord] back-fill assign failed:', e.message); }
  }
  console.log('[discord-link] %s linked %s via %s (%d roles)', user.steam_id, discordId, source, assigned);
  return { ok: true, status: 200, displayName: displayName || member.globalName || member.username, rolesAssigned: assigned };
}

// ---- Connect Discord (OAuth2) ----------------------------------------------
// Linking used to mean turning on Developer Mode, copying a user id and
// pasting it; the single biggest source of "where is my role" tickets. With
// DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET set (the bot application, with
// BASE_URL/auth/discord/callback added to its redirects), a button signs the
// player in with Discord instead. The paste box stays as the fallback.
const DISCORD_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const discordOAuthLimiter = require('express-rate-limit')({ windowMs: 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false });

function discordOAuthConfigured() {
  return !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
}

function discordRedirectUri() {
  return `${BASE_URL.replace(/\/+$/, '')}/auth/discord/callback`;
}

// Same rules as server.js's safeReturnTo: a path on this site, nothing else.
function safeNextPath(raw) {
  const s = String(raw || '');
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\') || s.length > 200 || /[\r\n]/.test(s)) return null;
  return s;
}

router.get('/auth/discord/link', discordOAuthLimiter, (req, res) => {
  const next = safeNextPath(req.query.next) || '/account';
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.redirect('/shop?next=' + encodeURIComponent('/auth/discord/link?next=' + next));
  }
  if (!discordOAuthConfigured()) return res.redirect(next + (next.includes('?') ? '&' : '?') + 'discord=unavailable');
  const state = crypto.randomBytes(24).toString('hex');
  // steamId is what the callback checks the returning session against, so a
  // different account finishing this flow fails closed instead of stealing it.
  req.session.discordLink = { state, next, at: Date.now(), steamId: req.user.steam_id };
  // No `prompt` parameter on purpose, so Discord uses its default and always
  // shows the approval screen. `prompt=none` only skips that screen for a user
  // who has ALREADY approved this application; a first-time linker -- which is
  // every player, since this application is new -- comes straight back with an
  // error instead of a code. A returning player seeing the screen again is a
  // far smaller cost than nobody being able to link at all.
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: discordRedirectUri(),
    scope: 'identify',
    state
  });
  res.redirect('https://discord.com/oauth2/authorize?' + params.toString());
});

router.get('/auth/discord/callback', discordOAuthLimiter, async (req, res) => {
  const pending = req.session.discordLink || null;
  const next = (pending && pending.next) || '/account';
  const back = (code) => res.redirect(next + (next.includes('?') ? '&' : '?') + 'discord=' + code);
  if (!req.isAuthenticated || !req.isAuthenticated()) return res.redirect('/shop?next=/account');
  // The pending record must also belong to the account that is signed in NOW.
  // The session survives a Steam re-login (keepSessionInfo, needed for
  // returnTo), so without this a second person signing in on the same browser
  // mid-flow would have the first person's Discord linked onto THEIR account,
  // taking the roles with it and locking the real owner out permanently.
  if (!pending || !req.query.state || req.query.state !== pending.state
      || pending.steamId !== req.user.steam_id
      || Date.now() - pending.at > DISCORD_OAUTH_STATE_TTL_MS) {
    return back('expired');
  }
  // Consume only a record that passed validation. Deleting it first let any
  // third-party page bounce the victim through this route with no state and
  // silently destroy a genuine in-flight link (the cookie is SameSite=Lax, so
  // it rides top-level cross-site GETs), holding their linking broken.
  delete req.session.discordLink;
  if (req.query.error || !req.query.code) return back('denied');
  if (!discordOAuthConfigured()) return back('unavailable');
  try {
    const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(req.query.code),
        redirect_uri: discordRedirectUri()
      })
    });
    if (!tokenRes.ok) {
      console.error('[discord-oauth] token exchange %s', tokenRes.status);
      return back('failed');
    }
    const token = await tokenRes.json();
    const meRes = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!meRes.ok) return back('failed');
    const me = await meRes.json();
    if (!me || !/^\d{15,25}$/.test(String(me.id || ''))) return back('failed');
    const result = await linkDiscordAccount(req.user, String(me.id), { source: 'oauth', displayName: me.global_name || me.username });
    if (!result.ok) return back(result.code || 'failed');
    return back('linked');
  } catch (e) {
    console.error('[discord-oauth] callback failed:', e.message);
    return back('failed');
  }
});

// Fire-and-forget helper used by the order lifecycle. Looks up the role
// the product grants and the user's linked Discord ID, then assigns.
function tryAssignDiscordRoleForOrder(orderId) {
  try {
    const row = db.prepare(`
      SELECT p.discord_role_id AS role_id, u.discord_id AS user_id
      FROM orders o JOIN products p ON o.product_id = p.id JOIN users u ON o.steam_id = u.steam_id
      WHERE o.id = ?
    `).get(orderId);
    if (!row || !row.role_id || !row.user_id) return;
    discord.assignRole(row.user_id, row.role_id, `order-fulfilled:${orderId}`)
      .catch(e => console.error('[discord] assign role for order %s failed: %s', orderId, e.message));
  } catch (e) {
    console.error('[discord] assign helper failed:', e.message);
  }
}

// Mirror of the above: remove a role only when the user has no OTHER
// completed order still granting it (so a user with two active subscriptions
// to role-granting products doesn't lose the role when one is revoked).
// includeSelf counts the order itself as well: a subscription ended for
// non-payment keeps its role while the period it already paid for still runs.
function tryRemoveDiscordRoleForOrder(orderId, { includeSelf = false } = {}) {
  try {
    const row = db.prepare(`
      SELECT o.steam_id, p.discord_role_id AS role_id, u.discord_id AS user_id
      FROM orders o JOIN products p ON o.product_id = p.id JOIN users u ON o.steam_id = u.steam_id
      WHERE o.id = ?
    `).get(orderId);
    if (!row || !row.role_id || !row.user_id) return;
    // "Still owed" has to mean a LIVE entitlement. Counting lapsed orders here
    // meant revoking someone's current subscription left the role in place
    // because they had bought the same thing a year ago.
    const stillOwed = db.prepare(`
      SELECT 1 FROM orders o JOIN products p ON o.product_id = p.id
      WHERE o.steam_id = @steamId AND (@includeSelf = 1 OR o.id != @orderId) AND p.discord_role_id = @roleId
        AND ${pqEntitlement.perksLiveSql('o', 'p')}
      LIMIT 1
    `).get({ steamId: row.steam_id, orderId, roleId: row.role_id, includeSelf: includeSelf ? 1 : 0, now: Math.floor(Date.now() / 1000) });
    if (stillOwed) return;
    discord.removeRole(row.user_id, row.role_id, `order-revoked:${orderId}`)
      .catch(e => console.error('[discord] remove role for order %s failed: %s', orderId, e.message));
  } catch (e) {
    console.error('[discord] remove helper failed:', e.message);
  }
}

// ============================================================
//  Subscription migration — invite existing one-time buyers
//  of recurring-typed products to switch onto auto-renew.
// ============================================================

// Builds the list of buyers eligible to migrate to a real subscription:
// completed orders on type='subscription' products in the last `windowDays`,
// payer_email present, no existing paypal_subscription_id, deduped to the
// most-recent order per (steam_id, product_id).
function findSubscriptionMigrationCandidates({ windowDays = 60 } = {}) {
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
  return db.prepare(`
    SELECT o.id AS order_id, o.steam_id, o.product_id, o.server_id, o.payer_email,
           o.amount_cents, o.completed_at, o.test_mode,
           u.persona AS display_name,
           p.title AS product_title, p.currency, p.type AS product_type
    FROM orders o
    JOIN users u    ON o.steam_id = u.steam_id
    JOIN products p ON o.product_id = p.id
    WHERE o.status = 'completed'
      AND o.test_mode = 0
      AND p.type = 'subscription'
      AND o.payer_email IS NOT NULL
      AND o.paypal_subscription_id IS NULL
      AND o.completed_at >= ?
      AND NOT EXISTS (
        SELECT 1 FROM orders o2
        WHERE o2.steam_id = o.steam_id
          AND o2.product_id = o.product_id
          AND o2.paypal_subscription_id IS NOT NULL
          AND o2.status IN ('completed','pending')
      )
      AND o.id = (
        SELECT MAX(id) FROM orders o3
        WHERE o3.steam_id = o.steam_id AND o3.product_id = o.product_id
          AND o3.status = 'completed'
      )
    ORDER BY o.completed_at DESC
  `).all(since);
}

// Preview the migration list without sending anything.
router.get('/api/shop/admin/subscriptions/migration-candidates', requireAdmin, (req, res) => {
  const windowDays = Math.max(1, Math.min(365, parseInt(req.query.windowDays || '60', 10) || 60));
  const rows = findSubscriptionMigrationCandidates({ windowDays });
  res.json({
    windowDays,
    count: rows.length,
    candidates: rows.map(r => ({
      orderId: r.order_id,
      payerEmail: r.payer_email,
      displayName: r.display_name,
      productTitle: r.product_title,
      amountCents: r.amount_cents,
      currency: r.currency,
      completedAt: r.completed_at,
      serverId: r.server_id
    }))
  });
});

// Send the auto-renew invite email to every candidate (or a single one when
// `onlyEmail` is set, useful for testing). The deep link bounces them to the
// shop in subscribe-this-product mode so checkout uses the new sub flow.
router.post('/api/shop/admin/subscriptions/send-migration-emails', requireAdmin, async (req, res) => {
  const { onlyEmail, windowDays } = req.body || {};
  const win = Math.max(1, Math.min(365, parseInt(windowDays || '60', 10) || 60));
  let rows = findSubscriptionMigrationCandidates({ windowDays: win });
  if (onlyEmail) {
    const e = String(onlyEmail).toLowerCase();
    rows = rows.filter(r => (r.payer_email || '').toLowerCase() === e);
  }
  const results = [];
  for (const r of rows) {
    const deepLink = `${BASE_URL}/shop?subscribe=${r.product_id}${r.server_id ? `&server=${encodeURIComponent(r.server_id)}` : ''}`;
    const out = await sendSubscriptionInvite({
      to: r.payer_email,
      displayName: r.display_name,
      productTitle: r.product_title,
      priceCents: r.amount_cents,
      currency: r.currency,
      deepLink
    });
    results.push({ to: r.payer_email, productTitle: r.product_title, ok: !!out.ok, error: out.error || out.skipped || null });
  }
  res.json({ sent: results.filter(r => r.ok).length, total: results.length, results });
});

// ============================================================
//  Subscription billing issues
// ============================================================
//  PayPal holds a subscription at status ACTIVE while its payments fail, so a
//  failure is otherwise silent. The owner's rule (2026-09-15) is no payment, no
//  priority queue: a failed renewal ends the subscription at once
//  (paymentEvents.endUnpaidSubscription), and subscription_billing_issues keeps
//  the record of each one for the Billing Issues tab.

// PayPal money values are decimal strings ("30.0"); we store integer cents.
function ppValueToCents(v) {
  if (v == null) return 0;
  const n = parseFloat(v);
  return isFinite(n) ? Math.round(n * 100) : 0;
}

// Everything a card or an email about a subscription needs, from its id alone
// (paymentEvents.subscriptionContext). undefined when the sub isn't one of ours.
function getBillingIssueContext(subId) {
  return paymentEvents.subscriptionContext(db, subId);
}

// Closes an open billing record. Called when a cycle bills and when PayPal
// reports the agreement dead.
function resolveBillingIssue(subId, reason) {
  if (!subId) return;
  try {
    if (paymentEvents.resolveBillingIssue(db, subId)) {
      console.log('[billing] issue resolved for %s (%s)', subId, reason || 'recovered');
    }
  } catch (e) {
    console.error('[billing] resolve failed:', e.message);
  }
}

// A card about a subscription ended for non-payment, into #Payment-Processor.
// Through the "ReforgedZ Payments" webhook like every other card, and posted as
// the bot when the webhook is unset or broken: a card about lost revenue is worth
// a second attempt. Best-effort: a Discord outage must not break webhook
// processing, so this never throws.
async function postBillingCard(specFn) {
  if (!DISCORD_WEBHOOK_URL && !PAYMENT_PROCESSOR_CHANNEL_ID) return false;
  let body;
  try {
    body = buildCard(specFn());
  } catch (e) {
    console.error('[billing] card not built:', e.message);
    return false;
  }
  if (DISCORD_WEBHOOK_URL) {
    const posted = await postCard(body);
    if (posted.ok) return true;
    console.error('[billing] webhook card failed: HTTP %s', posted.status);
  }
  try {
    await discord.postToChannel(PAYMENT_PROCESSOR_CHANNEL_ID, body);
    return true;
  } catch (e) {
    console.error('[billing] channel card failed:', e.message);
    return false;
  }
}

// Ends one subscription whose renewal PayPal could not take
// (paymentEvents.endUnpaidSubscription): from the PAYMENT.FAILED webhook, the
// daily PayPal check (server.js hands this to tools/reconcile.js) and the billing
// rescan. input: { subscriptionId, billingInfo, paypalStatus, source, now }.
function endUnpaid(input) {
  return paymentEvents.endUnpaidSubscription(db, input, {
    ...paymentEffects(),
    sendCard: (specFn) => { postBillingCard(specFn); },
    sendEmail: ({ to, ctx, accessUntil, billingStopped = true }) => {
      sendPaymentFailed({
        to,
        displayName: playerNameOf(ctx),
        productTitle: ctx.product_title,
        serverLabel: ctx.server_specific && ctx.server_id ? (SERVER_LABELS[ctx.server_id] || ctx.server_id) : null,
        priorityQueue: !!ctx.grants_priority_queue,
        accessEndsAt: accessUntil,
        billingStopped
      }).catch(e => console.error('[billing] player email failed:', e.message));
    }
  });
}

// Asks PayPal about every subscription the shop believes is live, the same check as
// the daily PayPal reconciliation (reconcile.endFailingSubscriptions). By default it
// only looks: it counts the ACTIVE agreements with failed payments and ends nothing,
// so a caller that has always treated a rescan as a harmless check (the Discord
// /billing command) stays one. With end: true (the admin panel's button, after a
// confirm) it ends each of them the way the webhook does, cancel and player email
// included, and refuses to end anything when a lookup failed. Open billing records
// the walk can never reach are resolved first: the agreement has since ended, or the
// shop holds no order for it. Sequential on purpose: PayPal rate-limits and this runs
// detached.
async function rescanBillingIssues({ end = false } = {}) {
  const summary = { scanned: 0, failing: 0, newIssues: 0, resolved: 0, errors: 0, ended: 0, refused: false, dryRun: !end };
  const unreachable = db.prepare(`
    SELECT b.paypal_subscription_id AS sub_id,
           EXISTS (SELECT 1 FROM orders o WHERE o.paypal_subscription_id = b.paypal_subscription_id
                     AND o.subscription_cancelled_at IS NOT NULL) AS ended,
           EXISTS (SELECT 1 FROM orders o WHERE o.paypal_subscription_id = b.paypal_subscription_id) AS has_orders
    FROM subscription_billing_issues b
    WHERE b.resolved_at IS NULL
  `).all();
  for (const u of unreachable) {
    if (u.ended) { resolveBillingIssue(u.sub_id, 'rescan: agreement already ended'); summary.resolved++; }
    else if (!u.has_orders) { resolveBillingIssue(u.sub_id, 'rescan: no orders for this agreement'); summary.resolved++; }
  }

  const out = await reconcile.endFailingSubscriptions({ db, paypal, end: end ? endUnpaid : null, dryRun: !end, source: 'rescan' });
  summary.scanned = out.checked;
  summary.failing = out.failing.length;
  summary.errors = out.lookupErrors.length;
  summary.ended = out.ended.length;
  summary.newIssues = out.ended.length;
  summary.refused = !out.ok;
  if (out.ok) {
    for (const n of out.notFailing) {
      if (paymentEvents.resolveBillingIssue(db, n.subscriptionId)) summary.resolved++;
    }
  }
  return summary;
}

// Guard so two rescans can't overlap (the button and the Discord command can
// both start one, and each run makes ~100 sequential PayPal calls).
let rescanState = { running: false, startedAt: null, finishedAt: null, summary: null, error: null };

function startBillingRescan(opts) {
  if (rescanState.running) return { started: false, state: rescanState };
  rescanState = { running: true, startedAt: Date.now(), finishedAt: null, summary: null, error: null };
  rescanBillingIssues(opts)
    .then((summary) => {
      rescanState = { running: false, startedAt: rescanState.startedAt, finishedAt: Date.now(), summary, error: null };
      console.log('[billing] rescan complete: %j', summary);
    })
    .catch((e) => {
      rescanState = { running: false, startedAt: rescanState.startedAt, finishedAt: Date.now(), summary: null, error: e.message };
      console.error('[billing] rescan failed:', e.message);
    });
  return { started: true, state: rescanState };
}

// ---- Billing issues: admin API ---------------------------------------------

// Pure DB read so the admin page stays instant; PayPal is only consulted by
// the rescan below.
router.get('/api/shop/admin/billing-issues', requireAdmin, (req, res) => {
  const includeResolved = String(req.query.include || '') === 'all';
  const rows = db.prepare(`
    SELECT b.paypal_subscription_id, b.order_id, b.steam_id, b.paypal_status,
           b.failed_count, b.outstanding_cents, b.currency,
           b.last_payment_at, b.next_billing_at, b.first_seen_at, b.last_seen_at,
           b.notified_at, b.player_emailed_at, b.resolved_at, b.source,
           u.persona, u.platform, u.gamertag, u.discord_id, u.bi_uid,
           o.server_id, o.amount_cents, o.effective_until, o.payer_email,
           p.title AS product_title, p.discord_role_id
    FROM subscription_billing_issues b
    LEFT JOIN orders   o ON o.id = b.order_id
    LEFT JOIN users    u ON u.steam_id = b.steam_id
    LEFT JOIN products p ON p.id = o.product_id
    ${includeResolved ? '' : 'WHERE b.resolved_at IS NULL'}
    ORDER BY b.failed_count DESC, b.last_seen_at DESC
  `).all();

  const openRows = rows.filter(r => r.resolved_at == null);
  res.json({
    issues: rows,
    openCount: openRows.length,
    outstandingCents: openRows.reduce((n, r) => n + (r.outstanding_cents || 0), 0),
    rescan: {
      running: rescanState.running,
      startedAt: rescanState.startedAt,
      finishedAt: rescanState.finishedAt,
      summary: rescanState.summary,
      error: rescanState.error
    }
  });
});

// Kicks the PayPal sweep off in the background and returns immediately --
// it makes ~100 sequential PayPal calls and cannot finish inside a request.
// Poll GET /api/shop/admin/billing-issues for progress.
// Body { end: true } ends the failing subscriptions it finds (rescanBillingIssues);
// anything else is a check that ends nothing and emails nobody. The old emailPlayers
// body flag is ignored. emailPlayers in the answer says whether players can be emailed.
router.post('/api/shop/admin/billing-issues/rescan', requireAdmin, (req, res) => {
  const end = !!(req.body && req.body.end === true);
  const { started, state } = startBillingRescan({ end });
  if (!started) {
    return res.status(409).json({ error: 'A rescan is already running', startedAt: state.startedAt });
  }
  res.json({ ok: true, started: true, end, emailPlayers: end });
});

// ---- Doctor -----------------------------------------------------------------

// Every integration checked read-only (tools/doctor.js). ?deep=1 also compares
// each server's purchases.json and game.admins with the database and walks the
// owed Discord roles, which takes about a minute. Single-flight: a second call
// while one runs gets the same report.
let doctorInFlight = null;
router.get('/api/shop/admin/doctor', requireAdmin, async (req, res) => {
  const deep = String(req.query.deep || '') === '1';
  try {
    if (!doctorInFlight) {
      doctorInFlight = require('../tools/doctor').runDoctor({ deep }).finally(() => { doctorInFlight = null; });
    }
    res.json(await doctorInFlight);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Health check on request ------------------------------------------------

// The morning health card, built now and handed back instead of posted, for the
// Discord /health command (tools/healthReport.js startManualHealthCheck). Changes
// nothing. It takes about a minute, so the POST only starts a check (or joins the
// one already running) and the GET answers { running, startedAt, finishedAt, body,
// error }, body being the Discord message that carries the card.
router.post('/api/shop/admin/health-check', requireAdmin, (req, res) => {
  const { started, state } = require('../tools/healthReport').startManualHealthCheck();
  res.status(started ? 202 : 200).json({ started, ...state });
});

router.get('/api/shop/admin/health-check', requireAdmin, (req, res) => {
  res.json(require('../tools/healthReport').manualHealthState());
});

// ---- Player account summary -------------------------------------------------

// Everything the account page needs in one round trip: who you are, what is
// linked, the health of each subscription, and full purchase history. DB-only
// so it stays fast; subscription health comes from the billing-issues table
// rather than a live PayPal call.
router.get('/api/shop/account/summary', requireAuth, (req, res) => {
  const me = db.prepare(`
    SELECT steam_id, persona, avatar_url, platform, gamertag, bm_player_id,
           bi_uid, bi_uid_name, bi_uid_proof, bi_uid_set_at, discord_id, role, created_at, email, email_verified_at,
           password_hash IS NOT NULL AS has_password
    FROM users WHERE steam_id = ?
  `).get(req.user.steam_id);
  if (!me) return res.status(404).json({ error: 'Account not found' });

  const orders = db.prepare(`
    SELECT o.id, o.product_id, o.status, o.amount_cents, o.created_at, o.completed_at,
           o.paypal_subscription_id, o.subscription_cancelled_at, o.subscription_ended_reason,
           o.effective_until, o.server_id, o.test_mode,
           p.title, p.type, p.currency, p.server_specific, p.discord_role_id, p.grants_priority_queue
    FROM orders o JOIN products p ON o.product_id = p.id
    WHERE o.steam_id = ?
    ORDER BY o.created_at DESC
  `).all(req.user.steam_id);

  const issues = db.prepare(`
    SELECT paypal_subscription_id, failed_count, outstanding_cents, currency,
           last_payment_at, next_billing_at, resolved_at
    FROM subscription_billing_issues
    WHERE steam_id = ? AND resolved_at IS NULL
  `).all(req.user.steam_id);
  const issueBySub = new Map(issues.map(i => [i.paypal_subscription_id, i]));

  // One entry per subscription, newest cycle first, so a sub billed monthly
  // for six months is one card rather than six history rows.
  //
  // Only subscriptions that actually took a payment get a card. An abandoned
  // checkout leaves a 'pending' row with its own subscription id and no
  // effective_until, which would otherwise render as a second, identical
  // product card reading "no longer active" for something that was never
  // active in the first place.
  const subs = [];
  const seen = new Set();
  const now = Math.floor(Date.now() / 1000);
  for (const o of orders) {
    if (!o.paypal_subscription_id || seen.has(o.paypal_subscription_id)) continue;
    if (o.status !== 'completed') {
      const everPaid = orders.some(x =>
        x.paypal_subscription_id === o.paypal_subscription_id && x.status === 'completed');
      if (!everPaid) continue;
      // A newer pending cycle on a subscription that has paid before is just
      // the next renewal in flight; the completed row below carries the state.
      continue;
    }
    seen.add(o.paypal_subscription_id);
    const issue = issueBySub.get(o.paypal_subscription_id) || null;
    const active = !!(o.effective_until && o.effective_until > now);
    subs.push({
      subscriptionId: o.paypal_subscription_id,
      orderId: o.id,
      productId: o.product_id,
      grantsPriorityQueue: !!o.grants_priority_queue,
      // Kept for older pages: the self-service move is retired, so always null.
      pq: null,
      title: o.title,
      currency: o.currency,
      amountCents: o.amount_cents,
      serverId: o.server_id,
      effectiveUntil: o.effective_until,
      cancelledAt: o.subscription_cancelled_at,
      roleId: o.discord_role_id,
      active,
      // The distinction the whole feature exists for: PayPal says ACTIVE, but
      // the payments are failing and access has already stopped. And an ended
      // agreement is 'cancelled' | 'suspended' | 'expired' — three different
      // messages to the player, never one.
      state: o.subscription_cancelled_at ? (o.subscription_ended_reason || 'cancelled')
        : issue ? 'payment_failing'
        : active ? 'active'
        : 'lapsed',
      endedReason: o.subscription_ended_reason || null,
      billingIssue: issue ? {
        failedCount: issue.failed_count,
        outstandingCents: issue.outstanding_cents,
        currency: issue.currency,
        lastPaymentAt: issue.last_payment_at,
        nextRetryAt: issue.next_billing_at
      } : null
    });
  }

  res.json({
    profile: {
      steamId: me.steam_id,
      persona: me.persona,
      avatarUrl: me.avatar_url,
      platform: me.platform,
      gamertag: me.gamertag,
      bmPlayerId: me.bm_player_id,
      biUid: me.bi_uid,
      // Who that ID belongs to by name, how it was chosen (inGameId.js PROOFS) and
      // when, so a wrong or planted ID is visible. Null when not known.
      biUidName: me.bi_uid_name || null,
      biUidProof: me.bi_uid_proof || null,
      biUidSetAt: me.bi_uid_set_at || null,
      discordId: me.discord_id,
      // From the per-request user, which derives admin from ADMIN_STEAM_IDS -- not the
      // stored row, which still says 'admin' for someone removed from that list.
      isAdmin: req.user.role === 'admin',
      createdAt: me.created_at,
      email: me.email || null,
      hasPassword: !!me.has_password,
      // Anyone can change their in-game id, except a console account whose email
      // sign-in is not confirmed yet (see /api/shop/set-bi-uid).
      canEditBiUid: (me.platform !== 'psn' && me.platform !== 'xbox') || !!me.email_verified_at,
      // Whether "add email sign-in" is offered here, and if not, what to do instead.
      addLogin: (() => {
        const refusal = webAuth.addLoginRefusal(me, { relinkedAt: req.session && req.session.relinkedAt });
        if (!refusal) return { allowed: true };
        return { allowed: false, code: refusal.code, help: refusal.code === 'has_login' ? null : refusal.error };
      })()
    },
    subscriptions: subs,
    orders
  });
});

// ---- Buy-flow counters and expiry reminders (plan J5) ------------------------
// funnel.js says why the shop counts steps and why it stores no player data.

// Steps only the page can see. No sign-in, because most of them happen before
// one. Only funnel.CLIENT_STEPS are accepted, so this cannot write anything else.
// The step comes in the JSON body or as ?step=, so the page can use
// navigator.sendBeacon, which cannot send a JSON content type. Its own cap per
// address, in memory only; server.js leaves it out of the /api write cap.
//
// A real page sends each of the five steps at most once per load, so one address
// gets 10 posts a minute, and each step counts at most 3 times an hour from one
// address. A buyer who reloads or comes back from PayPal still counts; a script
// cannot drown out the handful of real buyers the owner decides from. Past the
// hourly cap the post still answers 204, uncounted, so a reloading player's
// console shows no errors.
const funnelBeaconLimit = windowLimit({ limit: 10, windowMs: 60 * 1000 });
const funnelStepLimit = windowLimit({ limit: 3, windowMs: 60 * 60 * 1000 });

router.post('/api/shop/funnel', (req, res) => {
  if (!funnelBeaconLimit(req.ip)) return res.status(429).json({ error: 'Too many requests.' });
  const fromBody = req.body && typeof req.body.step === 'string' ? req.body.step : null;
  const step = fromBody || (typeof req.query.step === 'string' ? req.query.step : '');
  if (!funnel.CLIENT_STEPS.includes(step)) return res.status(400).json({ error: 'Unknown step.' });
  if (funnelStepLimit(`${req.ip}|${step}`)) funnel.countStep(db, step);
  res.status(204).end();
});

// Daily counts for the last ?days= days (1 to 366, default 30), newest first.
router.get('/api/shop/admin/funnel', requireAdmin, (req, res) => {
  try {
    res.json(funnel.readFunnel(db, { days: req.query.days }));
  } catch (e) {
    console.error('[funnel] read failed:', e.message);
    res.status(500).json({ error: 'Could not read the counts.' });
  }
});

// What the next 15:00 UTC reminder run would send (?at=now: a run right now),
// without sending or recording anything. Order ids, dates and skip reasons only,
// never an email address.
router.get('/api/shop/admin/reminders/preview', requireAdmin, async (req, res) => {
  try {
    const at = req.query.at === 'now' ? Math.floor(Date.now() / 1000) : reminders.nextRunAt();
    const out = await reminders.runExpiryReminders({ db, now: at, dryRun: true });
    res.json({
      runAt: at,
      enabled: !reminders.remindersOff(),
      windowStart: out.windowStart,
      windowEnd: out.windowEnd,
      due: out.due,
      wouldSend: out.items,
      skipped: out.skipped,
      counts: out.counts,
      maxPerRun: reminders.MAX_PER_RUN
    });
  } catch (e) {
    console.error('[reminders] preview failed:', e.message);
    res.status(500).json({ error: 'Could not build the reminder preview.' });
  }
});

// What the 08:30 UTC PayPal reconciliation would report right now
// (tools/reconcile.js): payments PayPal took in the last three days that nothing in
// the shop accounts for, and the ones already reported. Nothing is posted or
// recorded, and PayPal is asked for no payer details. Single-flight, like the
// doctor, because it pages through PayPal.
//
// ?failing=1 also lists the ACTIVE subscriptions failing at PayPal that the daily run
// would end now (reconcile.endFailingSubscriptions as a dry run): each is ended unless
// it never took a payment. Nothing is cancelled, posted or sent. It asks PayPal about
// every live subscription, so it takes a while; run it before trusting the first
// daily run on a new deploy.
let reconcilePreviewInFlight = null;
router.get('/api/shop/admin/reconcile/preview', requireAdmin, async (req, res) => {
  try {
    if (!reconcilePreviewInFlight) {
      reconcilePreviewInFlight = reconcile.runReconcile({ db, paypal, dryRun: true })
        .finally(() => { reconcilePreviewInFlight = null; });
    }
    const out = await reconcilePreviewInFlight;
    let failing = null;
    if (String(req.query.failing || '') === '1') {
      const f = await reconcile.endFailingSubscriptions({ db, paypal, dryRun: true });
      failing = {
        ok: f.ok, error: f.error, checked: f.checked, skipped: f.skipped,
        failingAtPayPal: f.failing.map(x => ({ subscriptionId: x.subscriptionId, failedCount: x.failedCount })),
        lookupErrors: f.lookupErrors
      };
    }
    res.status(out.error ? 502 : 200).json({
      enabled: !reconcile.reconcileOff(),
      nextRunAt: reconcile.nextRunAt(),
      lastRun: reconcile.lastReconcileRun(),
      ...reconcile.previewOf(out),
      ...(failing ? { failing } : {})
    });
  } catch (e) {
    console.error('[reconcile] preview failed:', e.message);
    res.status(500).json({ error: 'Could not build the reconciliation preview.' });
  }
});

// ---- Discord role reconciliation -------------------------------------------
//  Roles were granted on fulfilment and removed on revoke/refund/hard-delete,
//  but nothing removed one when a subscription simply LAPSED -- expiry is the
//  passage of time, not an event. sweepExpiredEntitlements already re-synced
//  in-game priority queue on lapse; the Discord role was left behind.

// A pair is entitled while any order for that role still gives its perks
// (pqEntitlement.perksLiveSql). The Priority Queue role follows the one priority
// queue rule, renewal window included, so a renewer keeps it through the renewal
// morning and an unpaid or sandbox order never holds it. Any other product counts
// while completed and unexpired, and one with no end date (e.g. Supporter) never lapses.
function entitledRolePairKeys(now = Math.floor(Date.now() / 1000)) {
  const rows = db.prepare(`
    SELECT DISTINCT u.discord_id AS user_id, p.discord_role_id AS role_id
    FROM orders o
    JOIN products p ON p.id = o.product_id
    JOIN users u    ON u.steam_id = o.steam_id
    WHERE p.discord_role_id IS NOT NULL
      AND u.discord_id IS NOT NULL
      AND ${pqEntitlement.perksLiveSql('o', 'p')}
  `).all({ now });
  return new Set(rows.map(r => r.user_id + ':' + r.role_id));
}

// Every pair the shop has ever granted. Anyone NOT here is untouched, so a
// role staff applied by hand to someone with no matching order is never
// stripped by this.
function everGrantedRolePairs() {
  return db.prepare(`
    SELECT DISTINCT u.discord_id AS user_id, p.discord_role_id AS role_id,
           u.persona, p.title AS product_title
    FROM orders o
    JOIN products p ON p.id = o.product_id
    JOIN users u    ON u.steam_id = o.steam_id
    WHERE o.status = 'completed'
      AND p.discord_role_id IS NOT NULL
      AND u.discord_id IS NOT NULL
  `).all();
}

async function reconcileLapsedDiscordRoles(opts) {
  const { dryRun = false } = opts || {};
  const entitled = entitledRolePairKeys();
  const stale = everGrantedRolePairs()
    .filter(r => !entitled.has(r.user_id + ':' + r.role_id));

  const summary = { candidates: stale.length, removed: 0, notInGuild: 0, alreadyGone: 0, errors: 0, details: [] };

  // Group by user so a member with two lapsed roles costs one lookup.
  const byUser = new Map();
  for (const r of stale) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }

  for (const [userId, rows] of byUser) {
    let held;
    try {
      held = await discord.getMemberRoleIds(userId);
    } catch (e) {
      summary.errors++;
      console.error('[roles] lookup failed for %s: %s', userId, e.message);
      continue;
    }
    if (held === null) { summary.notInGuild += rows.length; continue; }

    for (const r of rows) {
      if (!held.includes(r.role_id)) { summary.alreadyGone++; continue; }
      summary.details.push({
        userId, roleId: r.role_id, persona: r.persona, product: r.product_title
      });
      if (dryRun) continue;
      try {
        await discord.removeRole(userId, r.role_id, `lapsed-reconcile:${r.product_title || r.role_id}`);
        summary.removed++;
        console.log('[roles] removed lapsed %s from %s (%s)', r.product_title, r.persona || userId, userId);
      } catch (e) {
        summary.errors++;
        console.error('[roles] remove failed for %s/%s: %s', userId, r.role_id, e.message);
      }
      // Discord rate-limits role writes to roughly 1/sec.
      await new Promise(res => setTimeout(res, 1100));
    }
  }
  return summary;
}

// The grant side. Reconcile above only ever removes, so a role deleted by hand,
// or lost when the guild's roles were recreated (2026-08-19), stayed missing
// until a player opened a ticket. This gives it back to anyone who is entitled,
// linked and still in the guild. Unlinked players and those who left are the
// owner's reactive policy and are not chased. Capped per run so a bad day
// cannot become a role storm; every grant lands in discord_role_events.
async function healMissingDiscordRoles(opts) {
  const { dryRun = false, max = 25 } = opts || {};
  const rows = db.prepare(`
    SELECT DISTINCT u.discord_id AS user_id, p.discord_role_id AS role_id,
           u.persona, p.title AS product_title
    FROM orders o
    JOIN products p ON p.id = o.product_id
    JOIN users u    ON u.steam_id = o.steam_id
    WHERE p.discord_role_id IS NOT NULL
      AND u.discord_id IS NOT NULL AND u.discord_id != ''
      AND ${pqEntitlement.perksLiveSql('o', 'p')}
  `).all({ now: Math.floor(Date.now() / 1000) });
  const summary = { entitled: rows.length, held: 0, missing: 0, granted: 0, notInGuild: 0, skipped: 0, errors: 0, dryRun, details: [] };
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }
  for (const [userId, pairs] of byUser) {
    let held;
    try {
      held = await discord.getMemberRoleIds(userId);
    } catch (e) {
      summary.errors++;
      console.error('[roles-heal] lookup failed for %s: %s', userId, e.message);
      continue;
    }
    if (held === null) { summary.notInGuild += pairs.length; continue; }
    for (const r of pairs) {
      if (held.includes(String(r.role_id))) { summary.held++; continue; }
      summary.missing++;
      summary.details.push({ userId, roleId: r.role_id, persona: r.persona, product: r.product_title });
      if (dryRun) continue;
      if (summary.granted >= max) { summary.skipped++; continue; }
      try {
        await discord.assignRole(userId, r.role_id, `daily-heal:${r.product_title || r.role_id}`);
        summary.granted++;
        console.log('[roles-heal] granted %s to %s (%s)', r.product_title, r.persona || userId, userId);
      } catch (e) {
        summary.errors++;
        console.error('[roles-heal] grant failed for %s/%s: %s', userId, r.role_id, e.message);
      }
      await new Promise(res => setTimeout(res, 1100));
    }
    await new Promise(res => setTimeout(res, 120));
  }
  return summary;
}

router.get('/api/shop/admin/role-heal', requireAdmin, async (req, res) => {
  try {
    res.json({ preview: await healMissingDiscordRoles({ dryRun: true }) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/api/shop/admin/role-heal', requireAdmin, async (req, res) => {
  const max = Math.min(100, Math.max(1, parseInt(req.body && req.body.max, 10) || 25));
  try {
    res.json({ result: await healMissingDiscordRoles({ dryRun: false, max }) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// What the next game.admins sync would add, strip, keep for staff and release,
// per server, without writing. Read this before trusting a change to the
// ownership rules in sync.js.
// Runs the game server sync now. The admin page calls this after a game master is added
// or removed on the GM tab: priority queue stock subtracts each server's game master
// count, which the shop learns from its own sync, so a GM change counts within the sync
// rather than at the next 10-minute pass. Overlapping requests coalesce into one more
// pass (sync.js), so a burst of GM changes costs little.
router.post('/api/shop/admin/admins-sync/run', requireAdmin, (req, res) => {
  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
  res.json({ ok: true, started: true });
});

router.get('/api/shop/admin/admins-sync/preview', requireAdmin, async (req, res) => {
  try {
    res.json({ servers: await require('../sync').previewAdminsSync() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

let roleReconcileState = { running: false, startedAt: null, finishedAt: null, summary: null, error: null };

function startRoleReconcile(opts) {
  if (roleReconcileState.running) return { started: false, state: roleReconcileState };
  roleReconcileState = { running: true, startedAt: Date.now(), finishedAt: null, summary: null, error: null };
  reconcileLapsedDiscordRoles(opts)
    .then((summary) => {
      roleReconcileState = { running: false, startedAt: roleReconcileState.startedAt, finishedAt: Date.now(), summary, error: null };
      console.log('[roles] reconcile complete: %j', { ...summary, details: summary.details.length });
    })
    .catch((e) => {
      roleReconcileState = { running: false, startedAt: roleReconcileState.startedAt, finishedAt: Date.now(), summary: null, error: e.message };
      console.error('[roles] reconcile failed:', e.message);
    });
  return { started: true, state: roleReconcileState };
}

router.get('/api/shop/admin/role-reconcile', requireAdmin, async (req, res) => {
  // Always safe to call: reports what WOULD be removed without touching Discord.
  try {
    const preview = await reconcileLapsedDiscordRoles({ dryRun: true });
    res.json({ preview, state: roleReconcileState });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/api/shop/admin/role-reconcile', requireAdmin, (req, res) => {
  const { started, state } = startRoleReconcile({ dryRun: req.body && req.body.dryRun === true });
  if (!started) return res.status(409).json({ error: 'A reconcile is already running', startedAt: state.startedAt });
  res.json({ ok: true, started: true });
});

// ============================================================
//  PayPal webhook handler (exported separately for raw body)
// ============================================================

// Register (or reuse) our webhooks with PayPal on boot. Called from server.js.
// Stores the resolved webhook ids so verifyWebhook can validate inbound events.
async function registerPayPalWebhooks() {
  const url = `${BASE_URL}/api/shop/paypal/webhook`;
  for (const testMode of [false, true]) {
    if (!paypal.isConfigured(testMode)) continue;
    try {
      const id = await paypal.ensureWebhook(testMode, url);
      if (id) {
        setWebhookId(testMode, id);
        console.log(`[paypal] webhook ready (${testMode ? 'sandbox' : 'live'}): ${id}`);
      }
    } catch (e) {
      console.error(`[paypal] webhook register failed (${testMode ? 'sandbox' : 'live'}):`, e.message);
    }
  }
}

// PayPal signs webhooks with a cert served from its own domain; the transmission
// id/sig/time headers are always present on a genuine event. Requiring them (and
// pinning the cert host) lets us reject junk BEFORE spending any outbound
// verify round-trips to PayPal — the amplification/DoS guard.
const PAYPAL_CERT_HOST = /^https:\/\/api(-m)?\.(sandbox\.)?paypal\.com\//i;
function hasPlausiblePayPalHeaders(h) {
  const certUrl = h['paypal-cert-url'];
  return !!(h['paypal-transmission-id'] &&
            h['paypal-transmission-sig'] &&
            h['paypal-transmission-time'] &&
            certUrl && PAYPAL_CERT_HOST.test(certUrl));
}

async function webhookHandler(req, res) {
  // Cheap rejection first: anything without well-formed PayPal signature
  // headers can't possibly verify, so drop it without calling PayPal.
  if (!hasPlausiblePayPalHeaders(req.headers)) {
    return res.sendStatus(400);
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }

  // The event doesn't tell us which environment it came from, so try live
  // first then sandbox — whichever webhook id verifies the signature wins.
  let verified = false;
  let verifiedTestMode = false;
  for (const testMode of [false, true]) {
    const wid = getWebhookId(testMode);
    if (!wid) continue;
    if (await paypal.verifyWebhook(testMode, req.headers, event, wid)) { verified = true; verifiedTestMode = testMode; break; }
  }
  if (!verified) {
    console.error('[paypal] webhook signature verification failed:', event.event_type);
    return res.sendStatus(400);
  }

  const resource = event.resource || {};
  const orderId = parseInt(resource.custom_id, 10);

  try {
    // testMode is which webhook verified the event: the only way to mark a card
    // [TEST] when no order row says so.
    await dispatchPayPalEvent(event, resource, orderId, { testMode: verifiedTestMode });
  } catch (e) {
    if (e && e.retryLater) {
      // Expected, not a bug: answered 500 on purpose so PayPal delivers the event
      // again later (a refund webhook that lands while staff are revoking the order).
      console.warn(`[paypal] ${event.event_type} left for PayPal to deliver again: ${e.message}`);
      return res.sendStatus(500);
    }
    // Never let a webhook bug crash the process — PayPal aggressively
    // retries on non-2xx, so a single bad event would loop-kill the box.
    console.error(`[paypal] webhook handler threw on ${event.event_type}:`, e.stack || e.message);
    return res.sendStatus(500);
  }
  return res.sendStatus(200);
}

// A subscription payment for a subscription the shop holds no order rows for at
// all (paymentEvents.recordUnmatchedSale). Grants nothing; records the sale once
// and posts a red card. The webhook still answers 200.
function reportUnmatchedSale(subId, resource, { amountCents = null, testMode = false, now = Math.floor(Date.now() / 1000) } = {}) {
  const currency = String((resource.amount && resource.amount.currency) || 'usd').toUpperCase();
  const named = parseInt(resource.custom != null ? resource.custom : resource.custom_id, 10);
  const customId = Number.isInteger(named) && named > 0 ? named : null;
  let recorded;
  try {
    recorded = paymentEvents.recordUnmatchedSale(db, { saleId: resource.id, subscriptionId: subId, amountCents, currency, customId, now });
  } catch (e) {
    // Not recorded, but staff still hear about the money.
    console.error(`[billing] payment ${resource.id} on subscription ${subId}: not recorded: ${e.message}`);
    recorded = true;
  }
  if (!recorded) return;
  const money = Number.isFinite(amountCents) ? `$${(amountCents / 100).toFixed(2)} ${currency}` : 'amount not given';
  console.error(`[billing] payment ${resource.id} (${money}${testMode ? ', sandbox' : ''}) on subscription ${subId} matches no order at all; nothing granted`);
  sendCard(() => cards.unmatchedSaleCard({ subId, saleId: resource.id, amountCents, currency, customId, testMode }));
}

// A renewal PayPal took on a subscription whose orders were all revoked or
// refunded (pqGuards.recordRevokedRenewal says how that happens). Grants nothing;
// records the sale once and tells staff, who decide whether to cancel and refund.
// A subscription with no order rows at all goes to reportUnmatchedSale instead.
function reportRevokedRenewal(subId, resource, { testMode = false } = {}) {
  const amountCents = resource.amount && resource.amount.total != null ? ppValueToCents(resource.amount.total) : null;
  const now = Math.floor(Date.now() / 1000);
  const recorded = pqGuards.recordRevokedRenewal(db, {
    saleId: resource.id, subscriptionId: subId, amountCents, now
  });
  if (recorded === null) {
    reportUnmatchedSale(subId, resource, { amountCents, testMode, now });
    return;
  }
  if (!recorded) return;
  const { orders } = recorded;
  const currency = String((resource.amount && resource.amount.currency) || 'usd').toUpperCase();
  const money = amountCents != null ? `$${(amountCents / 100).toFixed(2)} ${currency}` : 'amount not given';
  const sandbox = orders.every(o => o.test_mode);
  const orderList = orders.map(o => `#${o.id} ${o.status}`).join(', ');
  console.error(`[billing] renewal ${resource.id} (${money}${sandbox ? ', sandbox' : ''}) on subscription ${subId} matched no live order (${orderList}); nothing granted. Cancel it in PayPal and refund if the player should not be billed.`);
  // The newest order names the product, server and player on the card.
  let context = null;
  try {
    context = getOrderWithContext(orders[orders.length - 1].id) || null;
  } catch (e) {
    console.error(`[billing] renewal ${resource.id}: order context not loaded: ${e.message}`);
  }
  sendCard(() => cards.revokedRenewalCard({ subId, saleId: resource.id, orders, amountCents, currency, context }));
}

// A renewal booked on a subscription whose newest cycle had been revoked, with or
// without a refund (pqGuards.refundedLatestCycle says why it is still booked). Once
// per sale: the caller only gets here after inserting the new cycle, which PayPal's
// retries skip. This is the sale's only card; the caller posts no renewed card.
function reportRenewalAfterRefund(subId, resource, { refundedOrderId, newOrderId, original, amountCents, noRefund = false, nextCharge = null }) {
  const money = Number.isFinite(amountCents)
    ? `$${(amountCents / 100).toFixed(2)} ${String(original.currency || 'usd').toUpperCase()}`
    : 'amount not given';
  const sandbox = !!original.test_mode;
  console.error(`[billing] renewal ${resource.id} (${money}${sandbox ? ', sandbox' : ''}) on subscription ${subId} came after order #${refundedOrderId} was ${noRefund ? 'revoked without a refund' : 'refunded'}; booked as order #${newOrderId}. Revoke it with a refund if the subscription was meant to end.`);
  sendCard(() => cards.renewalAfterRefundCard({
    subId, saleId: resource.id, refundedOrderId, newOrderId, original: { ...original, id: newOrderId }, amountCents, noRefund, nextCharge
  }));
}

// A second live priority queue subscription for the same account and server,
// found when a subscription activates (pqGuards.duplicateLiveSubscription). Card
// only: both payments are taken, and staff decide which one to cancel and refund.
// Never throws: it runs in the webhook after the order is already fulfilled.
function reportDuplicateSubscription(orderId) {
  try {
    const other = pqGuards.duplicateLiveSubscription(db, { orderId, now: Math.floor(Date.now() / 1000) });
    if (!other) return;
    const order = getOrderWithContext(orderId);
    if (!order) return;
    const where = order.server_specific && order.server_id ? (SERVER_LABELS[order.server_id] || order.server_id) : 'every server';
    console.error(`[pq-guard] order #${order.id}: ${order.steam_id} now has two live priority queue subscriptions for ${where} (order #${other.id} already live); nothing cancelled`);
    sendCard(() => cards.duplicateSubscriptionCard(order, other));
  } catch (e) {
    console.error(`[pq-guard] order #${orderId}: duplicate subscription check failed: ${e.message}`);
  }
}

// The effects the handlers in paymentEvents.js use: PayPal, the order lookup, the
// Discord role, the game-server sync, the card poster and the refund email.
function paymentEffects() {
  return {
    paypal,
    getOrderWithContext: (id) => getOrderWithContext(id),
    removeRole: (id) => tryRemoveDiscordRoleForOrder(id),
    removeLapsedRole: (id) => tryRemoveDiscordRoleForOrder(id, { includeSelf: true }),
    sync: () => syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message)),
    sendCard: (specFn) => sendCard(specFn),
    sendRefundEmail: ({ order, amountCents, resource }) => {
      const to = order.payer_email || (resource && resource.payer && resource.payer.email_address) || null;
      if (!to) return;
      sendRefundConfirmation({
        to,
        displayName: playerNameOf(order),
        productTitle: order.product_title,
        amountCents,
        currency: order.currency,
        captureId: order.paypal_capture_id,
        orderId: order.id,
        dateMs: Date.now()
      }).catch(e => console.error('[refund-mail] send failed:', e.message));
    }
  };
}

// paymentEffects plus the player's email about a payment the shop refused, or a
// subscription it did not start (paymentEvents.refuseSale, reportRefusedActivation).
function refusalEffects() {
  return {
    ...paymentEffects(),
    sendEmail: ({ to, ctx, reason, amountCents = null, currency = null, billingStopped = true }) => {
      sendPaymentRefused({
        to,
        displayName: playerNameOf(ctx),
        productTitle: ctx.product_title,
        serverLabel: ctx.server_id ? (SERVER_LABELS[ctx.server_id] || ctx.server_id) : null,
        priorityQueue: !!ctx.grants_priority_queue,
        amountCents,
        currency: currency || ctx.currency,
        reason,
        billingStopped
      }).catch(e => console.error('[billing] refused payment email failed:', e.message));
    }
  };
}

// Pins a subscription's first cycle to PayPal's first billing date, so a mid-cycle
// cancellation still honours the period the buyer paid for and the priority queue
// holds its slot from now (pqEntitlement.js needs the end date). Only ever on a
// completed order: writing a future entitlement onto a cancelled row is what
// produced orders that looked paid-up but granted nothing, because every reader
// filters on status = 'completed'. Only ever later: a retried ACTIVATED still
// carries the first billing date, which must not undo a later cycle. Used by the
// ACTIVATED webhook and the subscription return page, whichever comes first.
function pinFirstBillingDate(orderId, nextBillingTime, subId = null) {
  if (!nextBillingTime) return false;
  const untilUnix = Math.floor(new Date(nextBillingTime).getTime() / 1000);
  if (!isFinite(untilUnix) || untilUnix <= 0) return false;
  const current = db.prepare("SELECT effective_until FROM orders WHERE id = ? AND status = 'completed'").get(orderId);
  if (!current) {
    console.error(`[paypal] sub ${subId} activated but order ${orderId} is not completed, so its entitlement was NOT set. The buyer has paid; investigate.`);
    return false;
  }
  const dated = db.prepare(
    "UPDATE orders SET effective_until = ? WHERE id = ? AND status = 'completed' AND (effective_until IS NULL OR effective_until < ?)"
  ).run(untilUnix, orderId, untilUnix).changes;
  // fulfillOrder started its sync before the date was stored, so sync again now that it is.
  if (dated) syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
  return dated > 0;
}

async function dispatchPayPalEvent(event, resource, orderId, { testMode = false } = {}) {
  switch (event.event_type) {
    case 'PAYMENT.CAPTURE.COMPLETED': {
      if (orderId) {
        const breakdown = resource.seller_receivable_breakdown || {};
        const feeCents = breakdown.paypal_fee?.value != null
          ? Math.round(parseFloat(breakdown.paypal_fee.value) * 100) : null;
        // fulfillOrder is idempotent — the return handler usually got here
        // first; this is the safety net if the buyer closed the tab.
        fulfillOrder(orderId, {
          captureId: resource.id || null,
          payerEmail: resource.payer?.email_address || null,
          feeCents
        });
      }
      break;
    }

    case 'PAYMENT.CAPTURE.DENIED': {
      if (orderId) {
        db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(orderId);
        const order = getOrderWithContext(orderId);
        if (order) {
          sendCard(() => cards.orderEventCard('payment_declined', order));
        }
      }
      break;
    }

    case 'BILLING.SUBSCRIPTION.ACTIVATED': {
      // First payment succeeded — fulfill the pending order we created at
      // checkout. Also catches any sub that activated late.
      const subId = resource.id;
      const found = orderId
        ? db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)
        : (subId ? db.prepare('SELECT * FROM orders WHERE paypal_subscription_id = ?').get(subId) : null);
      if (found) {
        // A priority queue subscription starts only while its server has a slot for
        // it (paymentEvents.claimActivation), checked and fulfilled with nothing
        // awaited in between. A refused one is cancelled at PayPal, and its first
        // payment is refunded when PayPal sends it.
        const verdict = paymentEvents.claimActivation(db, { orderId: found.id });
        if (verdict.refuse) {
          if (verdict.claimed) {
            await paymentEvents.reportRefusedActivation(db, { verdict, payerEmail: resource.subscriber?.email_address || null }, refusalEffects());
          }
          break;
        }
        // Don't set a capture_id here — the matching PAYMENT.SALE.COMPLETED
        // event carries the real transaction id and will fill it in. (Older
        // code passed subId as a placeholder, which then caused a duplicate
        // row when SALE.COMPLETED inserted a "real" cycle on top.)
        const firstCompletion = fulfillOrder(found.id, {
          captureId: null,
          payerEmail: resource.subscriber?.email_address || null,
          feeCents: null
        });
        // Pin the entitlement end-date to PayPal's next billing time
        // (pinFirstBillingDate), then sync, since priority queue needs the date.
        pinFirstBillingDate(found.id, resource.billing_info?.next_billing_time, subId);
        // Look again now the subscription is paid: two approvals made close together
        // both pass the checkout check. Only on the order's first completion, so a
        // PayPal retry of this event posts nothing twice.
        if (firstCompletion) reportDuplicateSubscription(found.id);
      }
      break;
    }

    case 'PAYMENT.SALE.COMPLETED': {
      // Each recurring billing cycle on a subscription fires this. Find the
      // owning subscription and book a renewal order row so MRR + the
      // buyer's order history both reflect the new cycle.
      const subId = resource.billing_agreement_id;
      if (!subId) break;
      // Idempotency guard: PayPal retrying a sale already booked.
      const alreadyBooked = () => !!(resource.id && db.prepare('SELECT 1 FROM orders WHERE paypal_capture_id = ?').get(resource.id));
      if (alreadyBooked()) break;
      const original = db.prepare(`
        SELECT o.*, p.title AS product_title, p.currency,
               u.persona, u.platform, u.gamertag, u.bm_player_id, u.bi_uid
        FROM orders o
        JOIN products p ON o.product_id = p.id
        JOIN users u    ON o.steam_id   = u.steam_id
        WHERE o.paypal_subscription_id = ? AND o.status IN ('completed','pending')
        ORDER BY o.id ASC LIMIT 1
      `).get(subId);
      const endedByShop = paymentEvents.shopEndedReason(db, subId);
      if (!original && !endedByShop) {
        // No completed or pending order: the subscription was revoked, or the
        // shop has no order for it at all, yet PayPal billed it. One the shop itself
        // ended gives nothing, so the payment is refunded and the subscription
        // cancelled (paymentEvents.saleBookingDecision, reason revoked). Anything
        // else is reported to staff. Still 200, so PayPal does not retry.
        const early = paymentEvents.saleBookingDecision(db, { subscriptionId: subId, resource, now: Math.floor(Date.now() / 1000) });
        if (early.book === false && resource.id) {
          await paymentEvents.refuseSale(db, { subscriptionId: subId, resource, decision: early, testMode }, refusalEffects());
          break;
        }
        reportRevokedRenewal(subId, resource, { testMode });
        break;
      }
      // PAYMENT.SALE.COMPLETED doesn't include next_billing_time, but
      // the sub does — one extra API call gets us the cycle end so
      // mid-cycle cancellations honour the paid period. When PayPal gives
      // none (a failed lookup, or a sale arriving after the agreement ended),
      // the sale time plus one billing period stands in: a completed row
      // with no date would never expire (paymentEvents.renewalCycleEnd).
      const cycleEnd = original && !endedByShop
        ? await paymentEvents.renewalCycleEnd({ paypal, testMode: !!original.test_mode, subscriptionId: subId, resource })
        : null;
      if (alreadyBooked()) break;
      // Whether the shop can honour this payment (paymentEvents.saleBookingDecision):
      // a subscription it has not ended, whose payment takes no priority queue slot
      // from anyone. Asked after the lookup above and before any write, with nothing
      // awaited in between, so no other payment, activation or checkout can take the
      // slot between the answer and the booking. A payment it cannot honour is
      // refunded at once and the subscription cancelled.
      const verdict = paymentEvents.saleBookingDecision(db, { subscriptionId: subId, resource, now: Math.floor(Date.now() / 1000) });
      if (verdict.book === false && resource.id) {
        await paymentEvents.refuseSale(db, { subscriptionId: subId, resource, decision: verdict, testMode }, refusalEffects());
        break;
      }
      if (verdict.book !== true) {
        reportRevokedRenewal(subId, resource, { testMode });
        break;
      }
      if (!cycleEnd) {
        // Only when PayPal brought the agreement back while its billing date was
        // being looked up. Not booked; the daily PayPal check lists the payment.
        console.error(`[paypal] sale ${resource.id} on ${subId} was not booked: the subscription changed while its billing date was looked up`);
        break;
      }
      // A cycle billed, so any open failure on this subscription is over.
      resolveBillingIssue(subId, 'payment_recovered');
      const cycleAmount = resource.amount?.total
        ? Math.round(parseFloat(resource.amount.total) * 100)
        : original.amount_cents;
      const feeCents = resource.transaction_fee?.value != null
        ? Math.round(parseFloat(resource.transaction_fee.value) * 100) : null;
      const effectiveUntil = cycleEnd.effectiveUntil;
      const nextBillingAt = cycleEnd.nextBillingAt;
      // First-cycle case: BILLING.SUBSCRIPTION.ACTIVATED already
      // promoted the buyer's pending order to completed with no
      // capture id (or a legacy capture_id == subId placeholder). Fill
      // it in here instead of inserting a duplicate row, but only for a
      // sale in the first billing cycle (paymentEvents.isFirstCycleSale).
      // A later sale finding that row unpaid is a renewal whose first sale
      // never arrived: it gets its own row, card and invoice.
      const unpaidFirst = paymentEvents.unpaidFirstCycleRow(db, subId);
      const placeholder = unpaidFirst && paymentEvents.isFirstCycleSale(unpaidFirst, paymentEvents.saleTimeOf(resource))
        ? unpaidFirst : null;
      if (unpaidFirst && !placeholder) {
        console.warn(`[paypal] sale ${resource.id} on ${subId} is outside the first cycle of order #${unpaidFirst.id}, which has no payment booked; booked as a renewal`);
      }
      let newOrderId;
      let refundedBefore = null;
      if (placeholder) {
        // effective_until only moves later here, to PayPal's own date; the
        // stand-in date only fills a row that has none.
        db.prepare(`
          UPDATE orders SET
            paypal_capture_id = ?,
            payer_email = COALESCE(?, payer_email),
            fee_cents = ?,
            effective_until = CASE WHEN ? IS NOT NULL AND (effective_until IS NULL OR effective_until < ?)
                                   THEN ?
                                   WHEN effective_until IS NULL THEN ?
                                   ELSE effective_until END,
            amount_cents = ?
          WHERE id = ?
        `).run(
          resource.id,
          resource.payer?.email_address || null,
          feeCents,
          nextBillingAt, nextBillingAt, nextBillingAt, effectiveUntil,
          cycleAmount,
          placeholder.id
        );
        newOrderId = placeholder.id;
        // A first cycle that activated with no billing date gets its date only
        // here, and priority queue needs one (pqEntitlement.js): sync now rather
        // than at the next timer.
        if (placeholder.effective_until == null) {
          syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
        }
      } else {
        // True renewal cycle — buyer's been on the sub for ≥1 month and
        // this is a fresh billing. Insert a new row. Asked first, while the
        // new row is not yet the newest: was the latest cycle revoked?
        refundedBefore = pqGuards.refundedLatestCycle(db, subId);
        const ins = db.prepare(`
          INSERT INTO orders (steam_id, product_id, server_id, status, amount_cents, test_mode,
                              paypal_subscription_id, paypal_capture_id, payer_email, fee_cents,
                              effective_until, completed_at, created_at)
          VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
        `).run(
          original.steam_id, original.product_id, original.server_id,
          cycleAmount, original.test_mode,
          subId, resource.id, resource.payer?.email_address || original.payer_email || null,
          feeCents, effectiveUntil
        );
        newOrderId = ins.lastInsertRowid;
        if (refundedBefore) {
          reportRenewalAfterRefund(subId, resource, {
            refundedOrderId: refundedBefore.id, newOrderId, original, amountCents: cycleAmount,
            noRefund: !!refundedBefore.noRefund, nextCharge: nextBillingAt
          });
        }
      }
      // Side effects (Discord notif, invoice, role grant, sync) only
      // fire on TRUE renewals. The first cycle already went through
      // fulfillOrder during BILLING.SUBSCRIPTION.ACTIVATED — re-firing
      // here would mean two notifications and two invoice emails for
      // a single payment.
      if (!placeholder) {
        // The card is about the new cycle's row, so its link and footer
        // point at that order, not the subscription's first one. A renewal
        // after a revoked cycle already has its red card, which carries these
        // facts: one sale, one card.
        if (!refundedBefore) {
          sendCard(() => cards.orderEventCard('subscription_renewed',
            { ...original, id: newOrderId, amount_cents: cycleAmount, paypal_subscription_id: subId },
            { nextCharge: nextBillingAt }));
        }
        syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
        tryAssignDiscordRoleForOrder(newOrderId);
        if (resource.payer?.email_address || original.payer_email) {
          sendInvoice({
            to: resource.payer?.email_address || original.payer_email,
            orderId: newOrderId,
            captureId: resource.id,
            productTitle: original.product_title,
            amountCents: cycleAmount,
            currency: original.currency,
            feeCents,
            serverLabel: SERVER_LABELS[original.server_id] || original.server_id,
            dateMs: Date.now()
          }).catch(e => console.error('[invoice] send failed:', e.message));
        }
      }
      break;
    }

    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
    case 'BILLING.SUBSCRIPTION.EXPIRED': {
      const subId = resource.id;
      if (!subId) break;

      // Buyer paid for the current cycle, so they keep their entitlement
      // through the end of it, and a cancel, suspension or expiry never cuts it
      // short: dates only move later (paymentEvents.applyPaidThroughFloor). When
      // PayPal shows the last payment, access runs at least to that payment plus
      // one billing interval of the plan. Future cycles stop by cancelling any
      // pending row. Status on completed cycles stays 'completed' so sync.js's
      // effective_until check is what eventually removes them.
      const newestRow = db.prepare('SELECT test_mode FROM orders WHERE paypal_subscription_id = ? ORDER BY id DESC LIMIT 1').get(subId);
      const endedTestMode = newestRow ? !!newestRow.test_mode : testMode;
      const hasPaidCycle = !!db.prepare("SELECT 1 FROM orders WHERE paypal_subscription_id = ? AND status = 'completed' LIMIT 1").get(subId);
      let billingInfo = resource.billing_info || null;
      let planId = resource.plan_id || null;
      if (hasPaidCycle && !(billingInfo && billingInfo.last_payment)) {
        // The event is a snapshot and can leave billing_info out.
        try {
          const sub = await paypal.getSubscription(endedTestMode, subId);
          if (sub && sub.billing_info) billingInfo = sub.billing_info;
          planId = planId || (sub && sub.plan_id) || null;
        } catch (e) {
          console.warn(`[paypal] ${subId} ended: subscription lookup failed, so access stays where it is: ${e.message}`);
        }
      }
      let floor = null;
      let lastPaymentAt = null;
      if (hasPaidCycle && billingInfo && billingInfo.last_payment) {
        const interval = await paymentEvents.planInterval(paypal, { testMode: endedTestMode, planId });
        floor = paymentEvents.paidThroughOf(billingInfo, interval);
        lastPaymentAt = paymentEvents.unixOf(billingInfo.last_payment.time);
      }

      // Drop any pending cycle (buyer abandoned approval or sub never activated)
      db.prepare(`UPDATE orders SET status = 'cancelled' WHERE paypal_subscription_id = ? AND status = 'pending'`).run(subId);

      const access = paymentEvents.applyPaidThroughFloor(db, { subscriptionId: subId, floor, lastPaymentAt });
      if (access.raised) {
        console.log(`[paypal] ${subId} ended: order #${access.raised.id} keeps access until ${new Date(access.raised.to * 1000).toISOString()} (the last payment plus one billing period)`);
      }
      if (access.skipped) {
        const why = access.skipped === 'ended_by_shop'
          ? 'the shop had already ended it (payment not received, or no slot for a payment)'
          : 'its newest cycle was revoked';
        console.log(`[paypal] ${subId} ended: ${why}, so access was not extended`);
      }
      const until = access.accessUntil;
      // This is the authoritative "PayPal says this billing agreement is
      // dead" signal — separate from effective_until, which only tracks how
      // long the buyer keeps access. Without this, the order row stays
      // status='completed' forever (by design) and the frontend has no way
      // to tell a still-active subscription from a cancelled one, so the
      // Cancel button never goes away.
      // 'cancelled' | 'suspended' | 'expired'. Three different things happened
      // to the player, and the card, the email and the account page each need
      // to say which. They all used to say "cancelled".
      const endedReason = event.event_type.replace('BILLING.SUBSCRIPTION.', '').toLowerCase();
      markSubscriptionCancelledLocally(subId, endedReason);
      // The agreement is dead, so a pending failure is no longer actionable.
      resolveBillingIssue(subId, event.event_type);
      syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));

      // Notify Discord + email the buyer.
      const ctx = db.prepare(`
        SELECT o.*, u.persona, u.platform, u.gamertag, u.bm_player_id, u.bi_uid,
               p.title AS product_title, p.currency
        FROM orders o
        JOIN users u    ON o.steam_id = u.steam_id
        JOIN products p ON o.product_id = p.id
        WHERE o.paypal_subscription_id = ?
        ORDER BY o.id DESC LIMIT 1
      `).get(subId);
      // A cancel the shop itself asked PayPal for (a staff revoke, closing a
      // suspended agreement, deleting a product) was reported by that action, so
      // this webhook still changes the state above but posts no card and sends no
      // email. Keyed on the marker the shop wrote when it cancelled, never on
      // subscription_ended_reason: the player's own cancel sets that first too,
      // and this webhook is what emails that player.
      const shopCancel = endedReason === 'cancelled' ? paymentEvents.shopCancelFor(db, subId) : null;
      // A subscription the shop's billing rules ended (payment not received, no slot)
      // was reported when it ended, even if PayPal refused that cancel and it ends only
      // now: nothing goes out for it here, cancel, suspension or expiry.
      const shopEnded = paymentEvents.shopEndedReason(db, subId);
      // Which notices go out (paymentEvents.endedNotices): a staff revoke that
      // returned no money still emails the player, with no promise about access.
      const notices = paymentEvents.endedNotices({ shopCancel, shopEnded });
      if (ctx && !notices.card) {
        const by = shopEnded === 'unpaid' || shopEnded === 'no_slot' ? `the shop ended it earlier (${shopEnded})` : `cancelled by the shop itself (${shopCancel.source})`;
        console.log(`[paypal] ${subId} ${endedReason}: ${by}; that was already reported, so no card${notices.email ? '' : ' or email'}`);
      }
      if (ctx) {
        const bi = resource.billing_info || billingInfo || {};
        const failedCount = bi.failed_payments_count || 0;
        const outstandingCents = ppValueToCents(bi.outstanding_balance && bi.outstanding_balance.value);
        // No Amount on an ended card: nothing was paid or returned. Access until
        // shows what the player keeps; "Cancelled via" is PayPal's note on who
        // ended it (paymentCards.subscriptionEndedCard).
        if (notices.card) {
          sendCard(() => cards.subscriptionEndedCard(endedReason, ctx, {
            accessUntil: until, note: resource.status_change_note || null, failedCount, outstandingCents
          }));
        }
        const to = notices.email ? (resource.subscriber?.email_address || ctx.payer_email) : null;
        // After a no-refund revoke, only access an older cycle still gives is mentioned.
        const showAccess = notices.claimAccess || (until != null && until > Math.floor(Date.now() / 1000));
        if (to) {
          const displayName = playerNameOf(ctx);
          const mail = endedReason === 'suspended'
            ? sendSubscriptionSuspended({
                to, displayName,
                productTitle: ctx.product_title,
                accessEndsAtMs: until ? until * 1000 : null,
                failedCount, outstandingCents,
                currency: ctx.currency
              })
            : sendSubscriptionCancelled({
                to, displayName,
                productTitle: ctx.product_title,
                accessEndsAtMs: showAccess && until ? until * 1000 : null,
                priceCents: ctx.amount_cents,
                currency: ctx.currency,
                showAccess
              });
          mail.catch(e => console.error('[cancel-mail] send failed:', e.message));
        }
      }

      // A suspended agreement is limbo. PayPal has stopped billing it, but the
      // agreement still exists and only the merchant could ever revive it --
      // which contradicts what the card, the email and the account page all
      // tell the player: this one cannot be restarted, start a new one. Close
      // it at PayPal so the state matches the promise, nothing can quietly
      // resume billing months later, and "suspended" stops being a state
      // anyone has to reason about. No money is given up: PayPal does not
      // collect an outstanding balance on a suspended agreement either.
      if (endedReason === 'suspended') {
        // Marked as the shop's own close before PayPal is asked
        // (paymentEvents.cancelAtPayPal), so the CANCELLED webhook it causes posts
        // no second card and sends no second email: the suspended card and email
        // above are the report.
        paymentEvents.cancelAtPayPal({
          db, paypal, testMode: endedTestMode, subscriptionId: subId,
          reason: 'Closed automatically after PayPal stopped retrying failed payments', source: 'auto_close_suspended'
        })
          .then((r) => {
            if (r.outcome === 'failed' || r.outcome === 'unknown') {
              // The Suspended card said the shop is closing it; staff must hear it did not.
              console.error(`[paypal] could not close suspended agreement ${subId} (${r.outcome === 'unknown' ? 'no answer from PayPal' : 'refused'}): ${r.error}`);
              sendCard(() => cards.closeSuspendedFailedCard({ subId, ctx: ctx || null, cancel: r }));
            } else {
              console.log(`[paypal] suspended agreement ${subId} ${r.outcome === 'cancelled' ? 'closed' : 'was already closed'}`);
            }
          })
          .catch(e => console.error(`[paypal] could not close suspended agreement ${subId}: ${e.message}`));
      }
      break;
    }

    case 'BILLING.SUBSCRIPTION.RE-ACTIVATED': {
      // A suspended agreement PayPal brought back. Access itself returns when
      // the next PAYMENT.SALE.COMPLETED books a cycle; what has to happen here
      // is un-marking it as ended, or the account page keeps calling it
      // stopped and the Cancel button never comes back.
      const subId = resource.id;
      if (!subId) break;
      clearSubscriptionEndedLocally(subId);
      const ctx = getBillingIssueContext(subId);
      if (ctx) {
        // No Amount: bringing an agreement back moves no money.
        sendCard(() => cards.orderEventCard('subscription_reactivated', ctx, { subscriptionId: subId, amountCents: null }));
      }
      break;
    }

    case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': {
      // PayPal could not take a renewal. It would leave the agreement ACTIVE and
      // retry for weeks, so the shop ends the subscription at once: no payment, no
      // priority queue (paymentEvents.endUnpaidSubscription). A retry of this event,
      // or a later failure notice, finds it already ended and does nothing.
      if (resource.id) {
        await endUnpaid({
          subscriptionId: resource.id,
          billingInfo: resource.billing_info,
          paypalStatus: (resource.status || 'ACTIVE').toUpperCase(),
          source: 'webhook'
        });
      }
      break;
    }

    // Money going back: a refund (by staff here, or in PayPal) or a reversal. The
    // order is found by the refunded payment's own id, never by custom_id, which
    // for a subscription names its FIRST order. Each refund is recorded once, so a
    // retry or the echo of a staff refund posts nothing. A partial refund leaves the
    // order as it is, and a reversal never changes it. paymentEvents.js has the rules.
    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED':
    case 'PAYMENT.SALE.REFUNDED':
    case 'PAYMENT.SALE.REVERSED': {
      await paymentEvents.handleRefundEvent(db, {
        eventType: event.event_type,
        event,
        resource,
        customId: orderId,
        testMode,
        inFlight: (id) => revokesInFlight.has(id)
      }, paymentEffects());
      break;
    }

    // A refund PayPal accepted and then could not complete: the money never reached
    // the buyer. Recorded and carded; the order is not changed.
    case 'PAYMENT.REFUND.FAILED': {
      await paymentEvents.handleRefundFailure(db, { event, resource, testMode }, paymentEffects());
      break;
    }

    // Disputes and chargebacks: recorded, and staff get a card when one opens,
    // moves or closes. Nothing changes on the order or its perks automatically.
    case 'CUSTOMER.DISPUTE.CREATED':
    case 'CUSTOMER.DISPUTE.UPDATED':
    case 'CUSTOMER.DISPUTE.RESOLVED': {
      await paymentEvents.handleDisputeEvent(db, { eventType: event.event_type, resource, testMode }, paymentEffects());
      break;
    }
  }
}

module.exports = {
  router, webhookHandler, registerPayPalWebhooks, requireAdmin, healMissingDiscordRoles,
  // Exposed for tools/ and tests; not routes. endUnpaidSubscription is how the daily
  // PayPal check ends a failing subscription (server.js hands it to tools/reconcile.js).
  purchaseNextSteps, getOrderWithContext, linkDiscordAccount, discordOAuthConfigured,
  endUnpaidSubscription: endUnpaid
};

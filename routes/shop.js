const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { syncPurchasesToServers, buildPriorityQueueGuidsPerServer, searchSaveFiles, listSaveCategories, openSaveDownloadStream, getSaveRecord, getServerRunning, updateSaveRecord, deleteSaveRecords, scanOrphans, purgeOrphans, scanDeadCharacters, purgeDeadCharacters, listPlayers, getExtraStats, listCollectionRecords } = require('../sync');
const { SERVER_IDS, SERVER_LABELS, isValidServerId } = require('../gameServers');
const discord = require('../discord');

// ---- PayPal setup ----
const paypal = require('../paypal');
const { sendInvoice, sendSubscriptionInvite, sendSubscriptionCancelled, sendRefundConfirmation, sendCustomFlagConfirmation } = require('../invoiceMail');
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
const CUSTOM_FLAG_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'custom-flags');
fs.mkdirSync(CUSTOM_FLAG_UPLOAD_DIR, { recursive: true });
const CUSTOM_FLAG_MAX_BYTES = 16 * 1024 * 1024;
const CUSTOM_FLAG_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg' };
// The #shop support-ticket channel, linked from the confirmation email/
// onscreen message so buyers know where to follow up with their design.
const CUSTOM_FLAG_TICKET_URL = 'https://discord.com/channels/1352364195211120660/1361079415324410026';

const customFlagUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CUSTOM_FLAG_MAX_BYTES },
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

const PLATFORM_LABELS = { steam: 'Steam', xbox: 'Xbox', psn: 'PlayStation' };

function sendDiscordNotification({ eventType, user, biUid, productTitle, amountCents, currency, status, serverId }) {
  if (!DISCORD_WEBHOOK_URL) return;

  const colors = {
    pending: 0xfbbf24,
    completed: 0x4ade80,
    cancelled: 0xf87171,
    failed: 0xf87171,
    refunded: 0xc084fc
  };

  const titles = {
    'payment_completed': 'Payment Completed',
    'payment_failed': 'Payment Failed',
    'subscription_started': 'Subscription Started',
    'subscription_renewed': 'Subscription Renewed',
    'subscription_cancelled': 'Subscription Cancelled',
    'order_revoked': 'Order Revoked'
  };

  const amount = amountCents ? `$${(amountCents / 100).toFixed(2)} ${(currency || 'usd').toUpperCase()}` : 'N/A';
  const platform = (user && user.platform) || 'steam';
  const platformLabel = PLATFORM_LABELS[platform] || platform;

  const fields = [];
  if (platform === 'steam') {
    fields.push({ name: 'Player', value: (user && user.persona) || 'Unknown', inline: true });
    fields.push({ name: 'Steam ID', value: (user && user.steam_id) || 'Unknown', inline: true });
  } else {
    fields.push({ name: 'Gamertag', value: (user && user.gamertag) || 'Unknown', inline: true });
    fields.push({ name: 'BM Player ID', value: (user && user.bm_player_id) || 'Unknown', inline: true });
  }
  fields.push({ name: 'Platform', value: platformLabel, inline: true });
  fields.push({ name: 'BI UID', value: biUid || 'SET LATER', inline: false });
  fields.push({ name: 'Product', value: productTitle || 'Unknown', inline: false });
  if (serverId) {
    fields.push({ name: 'Server', value: SERVER_LABELS[serverId] || String(serverId).toUpperCase(), inline: true });
  }
  fields.push(
    { name: 'Amount', value: amount, inline: true },
    { name: 'Status', value: status || 'unknown', inline: true }
  );

  const embed = {
    title: titles[eventType] || eventType,
    color: colors[status] || 0x888888,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: 'ReforgedZ Shop' }
  };

  fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] })
  }).catch(err => console.error('Discord webhook error:', err.message));
}

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

function perServerStockUsed(productId) {
  const out = Object.fromEntries(SERVER_IDS.map(id => [id, 0]));
  for (const row of perServerStockUsedStmt.all(productId)) {
    if (row.server_id in out) out[row.server_id] = row.used;
  }
  return out;
}

// Per-server stock cap for a server_specific product. Honours the optional
// stock_limit_overrides JSON map ({serverId: limit}); falls back to the shared
// stock_limit when a server isn't listed there.
function effectiveStockLimit(product, serverId) {
  const raw = product.stock_limit_overrides;
  if (raw) {
    let ov = raw;
    if (typeof raw === 'string') { try { ov = JSON.parse(raw); } catch { ov = null; } }
    if (ov && ov[serverId] != null) return ov[serverId];
  }
  return product.stock_limit;
}

// For priority-queue products the meaningful "used" count is the actual set of
// GUIDs written into each server's game.admins — i.e. effective purchases PLUS
// manual grants, deduped — NOT the raw purchase count. Counting that set keeps
// the per-server cap honest: "40 / 40" means 40 entries in game.admins, so the
// 50-admin config ceiling can't be blown by manual grants slipping past the cap.
function pqUsedPerServer() {
  const sets = buildPriorityQueueGuidsPerServer();
  const out = {};
  for (const id of SERVER_IDS) out[id] = sets[id] ? sets[id].size : 0;
  return out;
}

// Hard cap on entries in a server's game.admins before Reforger errors on the
// config. Priority-queue stock is squeezed so that PQ + GMs never exceeds it.
const ADMIN_CEILING = parseInt(process.env.ADMIN_CEILING || '50', 10);

// Non-PQ admins (GMs + owner) per server, recorded by sync.js on each run.
function gmCountPerServer() {
  const out = Object.fromEntries(SERVER_IDS.map(id => [id, 0]));
  for (const row of db.prepare('SELECT server_id, non_shop_admin_count FROM config_admin_sync_state').all()) {
    if (row.server_id in out) out[row.server_id] = row.non_shop_admin_count || 0;
  }
  return out;
}

function attachStock(product) {
  if (!product) return product;
  if (product.server_specific) {
    const isPq = !!product.grants_priority_queue;
    product.per_server_used = isPq ? pqUsedPerServer() : perServerStockUsed(product.id);
    const gm = isPq ? gmCountPerServer() : {};
    product.per_server_limit = {};      // the configured cap (display denominator)
    product.per_server_available = {};  // how many can still be sold (numerator)
    for (const id of SERVER_IDS) {
      const cap = effectiveStockLimit(product, id);
      product.per_server_limit[id] = cap;
      if (cap == null) { product.per_server_available[id] = null; continue; }
      const used = product.per_server_used[id] || 0;
      // For PQ the real ceiling is min(cap, ADMIN_CEILING - GMs), so PQ + GMs
      // can never push game.admins past the limit. e.g. cap 40, 15 GMs -> 25/40.
      const effective = isPq ? Math.min(cap, ADMIN_CEILING - (gm[id] || 0)) : cap;
      product.per_server_available[id] = Math.max(0, effective - used);
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
// If a user pays after the order is auto-cancelled, the
// `checkout.session.completed` webhook still flips it back to completed
// without a status check, so payments are not lost.
const PENDING_TIMEOUT_SECONDS = 5 * 60;
const SWEEPER_INTERVAL_MS = 5 * 60 * 1000;

const sweepStmt = db.prepare(`
  UPDATE orders SET status = 'cancelled'
  WHERE status = 'pending' AND created_at < ?
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

// Whenever a subscription cycle's effective_until just crossed into the past,
// re-run the purchase sync so the GUID drops out of game.admins. No state
// change to the order row — sync.js's effective_until check handles the
// entitlement filter; status stays 'completed' so revenue stats still see it.
let lastEffectiveSweepUnix = Math.floor(Date.now() / 1000);
function sweepExpiredEntitlements() {
  const now = Math.floor(Date.now() / 1000);
  const just = db.prepare(`
    SELECT COUNT(*) AS c FROM orders
    WHERE status = 'completed'
      AND effective_until IS NOT NULL
      AND effective_until <= ?
      AND effective_until > ?
  `).get(now, lastEffectiveSweepUnix).c;
  lastEffectiveSweepUnix = now;
  if (just > 0) {
    console.log(`[orders] ${just} subscription cycle(s) just lapsed — re-syncing`);
    syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
  }
}
setInterval(sweepExpiredEntitlements, 5 * 60 * 1000);

// Periodic re-sync so each server's recorded GM count (which the PQ stock math
// subtracts from the admin ceiling) stays fresh even with no purchase activity.
setInterval(() => syncPurchasesToServers().catch(e => console.error('[sync periodic] Error:', e.message)), 10 * 60 * 1000);

// ---- Middleware helpers ----
function requireAuth(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Sign in required' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.isAuthenticated() && req.user.role === 'admin') return next();
  // Shared-secret fallback used by the reforgedz admin page backend.
  const apiKey = req.headers['x-shop-admin-key'];
  if (apiKey && process.env.SHOP_ADMIN_API_KEY && apiKey === process.env.SHOP_ADMIN_API_KEY) return next();
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
  res.json(products.map(p => attachStock(attachImages(p))));
});

// Payment provider config (PayPal). The redirect flow means the browser
// doesn't need a client token — it just follows the approve URL we return
// from /checkout. Kept for the frontend to know the provider + env.
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
    customFlagTicketUrl: CUSTOM_FLAG_TICKET_URL
  });
});

// Create a PayPal checkout order and return the approve URL to redirect to.
router.post('/api/shop/checkout', requireAuth, async (req, res) => {
  const { productId, testMode, serverId, customAmountCents } = req.body;
  if (!productId) return res.status(400).json({ error: 'Missing productId' });

  // Only admins can use test mode (sandbox).
  const useTest = testMode && req.user.role === 'admin';
  if (!paypal.isConfigured(useTest)) {
    return res.status(503).json({ error: `PayPal ${useTest ? 'sandbox' : 'live'} is not configured.` });
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  // Custom Flag needs extra fields + an image upload that this plain-JSON
  // endpoint can't carry — it has its own multipart checkout below.
  if (product.type === 'custom_flag') {
    return res.status(400).json({ error: 'This product needs additional details — use the Custom Flag checkout form.' });
  }

  let orderServerId = null;
  if (product.server_specific) {
    if (!isValidServerId(serverId)) {
      return res.status(400).json({ error: 'Pick a server for this purchase.' });
    }
    orderServerId = serverId;
    const effLimit = effectiveStockLimit(product, serverId);
    if (effLimit != null) {
      let used, alreadyHas, limit = effLimit;
      if (product.grants_priority_queue) {
        // Gate against the real reserved set (effective purchases + manual
        // grants, deduped by GUID) so manual grants can't push game.admins
        // past the cap. A buyer whose GUID is already reserved here is a
        // renewal — let them through (they don't add a new slot). The cap is
        // also squeezed by the server's GM count so PQ + GMs <= ADMIN_CEILING.
        const set = buildPriorityQueueGuidsPerServer()[serverId] || new Set();
        used = set.size;
        alreadyHas = !!(req.user.bi_uid && set.has(req.user.bi_uid));
        const gm = gmCountPerServer()[serverId] || 0;
        limit = Math.min(effLimit, ADMIN_CEILING - gm);
      } else {
        used = perServerStockUsed(product.id)[serverId] || 0;
        alreadyHas = !!db.prepare(`
          SELECT 1 FROM orders WHERE product_id = ? AND server_id = ? AND steam_id = ? AND status = 'completed' LIMIT 1
        `).get(product.id, serverId, req.user.steam_id);
      }
      if (used >= limit && !alreadyHas) {
        return res.status(409).json({ error: `Sold out on ${SERVER_LABELS[serverId] || serverId.toUpperCase()}.` });
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

  // Create the pending order row up-front so the customId we hand to PayPal
  // can map back to our DB even before they approve.
  const order = db.prepare(`
    INSERT INTO orders (steam_id, product_id, server_id, status, amount_cents, test_mode) VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(req.user.steam_id, product.id, orderServerId, amountCents, useTest ? 1 : 0);
  const orderId = order.lastInsertRowid;

  const isRecurring = product.type === 'subscription' || product.type === 'recurring_custom';

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
        cancelUrl: `${BASE_URL}/shop?cancelled=1`
      });
      if (!approveUrl) throw new Error('PayPal did not return a subscription approve URL');
      db.prepare('UPDATE orders SET paypal_subscription_id = ? WHERE id = ?').run(subscriptionId, orderId);
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
  const ext = CUSTOM_FLAG_MIME_EXT[req.file.mimetype];
  const fileName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const diskPath = path.join(CUSTOM_FLAG_UPLOAD_DIR, fileName);

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
function fulfillOrder(orderId, cap) {
  const order = db.prepare(`
    SELECT o.*, u.persona, u.bi_uid, u.platform, u.gamertag, u.bm_player_id,
           p.title AS product_title, p.type, p.currency
    FROM orders o JOIN users u ON o.steam_id = u.steam_id JOIN products p ON o.product_id = p.id
    WHERE o.id = ?
  `).get(orderId);
  if (!order) return false;
  if (order.status === 'completed' || order.status === 'refunded') return false; // already done

  db.prepare(`
    UPDATE orders SET status = 'completed', completed_at = unixepoch(),
      paypal_capture_id = ?, payer_email = ?, fee_cents = ?
    WHERE id = ? AND status = 'pending'
  `).run(cap.captureId || null, cap.payerEmail || null, cap.feeCents ?? null, orderId);

  sendDiscordNotification({
    eventType: 'payment_completed',
    user: { platform: order.platform, persona: order.persona, steam_id: order.steam_id, gamertag: order.gamertag, bm_player_id: order.bm_player_id },
    biUid: order.bi_uid,
    productTitle: order.product_title,
    amountCents: order.amount_cents,
    currency: order.currency,
    status: 'completed',
    serverId: order.server_id
  });

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
      buyerName: cap.payerName || order.persona || null,
      dateMs: Date.now()
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

  const embed = {
    title: 'Custom Flag Order',
    color: 0x4ade80,
    fields: [
      { name: 'Player Name', value: customFields.playerName || 'Unknown', inline: true },
      { name: 'In-Game Name', value: customFields.inGameName || 'Unknown', inline: true },
      { name: 'GUID', value: customFields.guid || 'Unknown', inline: false },
      { name: 'Discord ID', value: customFields.discordId || 'Not provided', inline: true },
      { name: 'Receipt', value: `RFGZ-${String(orderId).padStart(6, '0')}`, inline: true },
      { name: 'Amount', value: `$${(order.amount_cents / 100).toFixed(2)} ${(order.currency || 'usd').toUpperCase()}`, inline: true }
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'ReforgedZ Shop' }
  };

  let fileBuffer = null;
  let fileName = null;
  if (order.custom_file_path) {
    try {
      fileName = path.basename(order.custom_file_path);
      fileBuffer = fs.readFileSync(path.join(CUSTOM_FLAG_UPLOAD_DIR, fileName));
      embed.image = { url: `attachment://${fileName}` };
    } catch (e) {
      console.error('[custom-flag] could not read flag image for Discord:', e.message);
    }
  }

  try {
    if (fileBuffer) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ embeds: [embed] }));
      form.append('files[0]', new Blob([fileBuffer]), fileName);
      await fetch(DISCORD_WEBHOOK_URL, { method: 'POST', body: form });
    } else {
      await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
      });
    }
  } catch (e) {
    console.error('[custom-flag] Discord webhook error:', e.message);
  }
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
    return res.redirect(BASE_URL + '/shop?success=1');
  }
  if (order.status !== 'pending') {
    return res.redirect(BASE_URL + '/shop?cancelled=1');
  }
  const useTest = !!order.test_mode;
  try {
    const cap = await paypal.captureOrder(useTest, order.paypal_order_id);
    if (cap.status === 'COMPLETED') {
      fulfillOrder(orderId, cap);
      return res.redirect(BASE_URL + '/shop?success=1');
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
    return res.redirect(BASE_URL + '/shop?success=1');
  }
  if (order.status !== 'pending') {
    return res.redirect(BASE_URL + '/shop?cancelled=1');
  }
  const useTest = !!order.test_mode;
  try {
    const sub = await paypal.getSubscription(useTest, order.paypal_subscription_id);
    const status = (sub?.status || '').toUpperCase();
    if (status === 'ACTIVE') {
      fulfillOrder(orderId, {
        captureId: sub.id,
        payerEmail: sub.subscriber?.email_address || null,
        feeCents: null
      });
      return res.redirect(BASE_URL + '/shop?success=1');
    }
    if (status === 'APPROVED') {
      // First payment not yet captured. Webhook will activate within seconds.
      return res.redirect(BASE_URL + '/shop?processing=1');
    }
    return res.redirect(BASE_URL + '/shop?cancelled=1');
  } catch (err) {
    console.error('PayPal subscription (return) error:', err.message);
    return res.redirect(BASE_URL + '/shop?error=1');
  }
});

// Get current user's orders
router.get('/api/shop/orders', requireAuth, (req, res) => {
  const orders = db.prepare(`
    SELECT o.id, o.product_id, o.status, o.amount_cents, o.created_at, o.completed_at,
           o.stripe_subscription_id, o.paypal_subscription_id, o.server_id, p.title, p.type, p.currency, p.server_specific
    FROM orders o JOIN products p ON o.product_id = p.id
    WHERE o.steam_id = ? ORDER BY o.created_at DESC
  `).all(req.user.steam_id);
  res.json(orders);
});

// Set own BI UID. Steam-OpenID users are trusted to enter their own UID
// because Steam doesn't expose it for us. Console (PSN/Xbox) users had
// their UID resolved from BattleMetrics during signup — we don't let them
// change it from the web, because an attacker who hijacked their session
// would otherwise redirect their entitlements (priority queue etc.) onto
// the attacker's own GUID. Console-account UID changes go through admin
// support via /api/shop/admin/users/:steamId/bi-uid.
router.post('/api/shop/set-bi-uid', requireAuth, (req, res) => {
  if (req.user.platform === 'psn' || req.user.platform === 'xbox') {
    return res.status(403).json({
      error: 'Console accounts have their UID set automatically from BattleMetrics. To change it, open a ticket in our Discord.'
    });
  }

  const { biUid } = req.body;
  if (!biUid || typeof biUid !== 'string') return res.status(400).json({ error: 'Missing BI UID' });

  const cleaned = biUid.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cleaned)) {
    return res.status(400).json({ error: 'Invalid BI UID format. Expected: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' });
  }

  db.prepare('UPDATE users SET bi_uid = ? WHERE steam_id = ?').run(cleaned, req.user.steam_id);
  req.user.bi_uid = cleaned;
  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
  res.json({ ok: true, bi_uid: cleaned });
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
      return res.json({ ok: true, alreadyCancelled: true });
    }
    await paypal.cancelSubscription(useTest, order.paypal_subscription_id, 'Cancelled by customer');
    res.json({ ok: true });
  } catch (e) {
    console.error('[cancel-subscription] PayPal cancel failed:', e.message);
    res.status(502).json({ error: 'Failed to cancel subscription: ' + e.message });
  }
});

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

// Set BI UID for a user (admin only)
router.put('/api/shop/admin/users/:steamId/bi-uid', requireAdmin, (req, res) => {
  const { biUid } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE steam_id = ?').get(req.params.steamId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET bi_uid = ? WHERE steam_id = ?').run(biUid || null, req.params.steamId);
  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
  res.json({ ok: true });
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

  let cancelledSubs = 0;
  for (const s of subsToCancel) {
    try {
      await paypal.cancelSubscription(!!s.test_mode, s.subId, 'Product deleted by admin');
      cancelledSubs++;
    } catch (e) {
      console.error('[hard-delete] Failed to cancel PayPal subscription %s: %s', s.subId, e.message);
    }
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
    discord.removeRole(r.user_id, r.role_id)
      .catch(e => console.error('[discord] hard-delete role remove %s/%s: %s', r.user_id, r.role_id, e.message));
  }

  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));

  res.json({ ok: true, deletedOrders, cancelledSubs });
});

// Refund a PayPal capture for an order. Returns the refunded amount in cents.
async function refundCaptureForOrder(order) {
  const useTest = !!order.test_mode;
  let captureId = order.paypal_capture_id;
  // Backfill the capture id from PayPal if we only stored the order id.
  if (!captureId && order.paypal_order_id) {
    const pp = await paypal.getOrder(useTest, order.paypal_order_id);
    const norm = paypal.normalizeCapture(pp);
    captureId = norm.captureId;
  }
  if (!captureId) throw new Error('Order has no PayPal capture to refund');
  const { refundedCents } = await paypal.refundCapture(useTest, captureId, {
    amountCents: order.amount_cents,
    currency: order.currency || 'USD'
  });
  return refundedCents;
}

// Revoke an order (admin only). With { refund: true } also issues a PayPal
// refund of the original capture.
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

  let refundedCents = 0;
  if (refund) {
    if (!order.paypal_capture_id && !order.paypal_order_id) {
      return res.status(400).json({ error: 'This is a legacy (Stripe) order — refund it from the PayPal/Stripe dashboard manually.' });
    }
    try {
      refundedCents = await refundCaptureForOrder(order);
    } catch (e) {
      const msg = String(e && e.message || '');
      console.error('Refund failed:', msg);
      return res.status(502).json({ error: 'Refund failed: ' + msg });
    }
  }

  db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(orderId);

  // If this order came from a recurring PayPal subscription, cancel the
  // billing agreement too — otherwise PayPal keeps auto-billing the buyer
  // on the next cycle even though we've already pulled their access.
  let subscriptionCancelled = false;
  let subscriptionCancelError = null;
  if (order.paypal_subscription_id) {
    try {
      await paypal.cancelSubscription(!!order.test_mode, order.paypal_subscription_id,
        refund ? 'Revoked with refund by admin' : 'Revoked by admin');
      subscriptionCancelled = true;
    } catch (e) {
      subscriptionCancelError = e.message;
      console.error('[revoke] Failed to cancel PayPal subscription %s: %s', order.paypal_subscription_id, e.message);
    }
  }

  sendDiscordNotification({
    eventType: 'order_revoked',
    user: { platform: order.platform, persona: order.persona, steam_id: order.steam_id, gamertag: order.gamertag, bm_player_id: order.bm_player_id },
    biUid: order.bi_uid,
    productTitle: order.product_title,
    amountCents: refundedCents || order.amount_cents,
    currency: order.currency,
    status: 'refunded',
    serverId: order.server_id
  });

  // Refund confirmation email. Sent from the admin path because the PayPal
  // webhook handler short-circuits once status flips to 'refunded' — and
  // admin-initiated refunds beat the webhook there.
  if (refund && order.payer_email) {
    sendRefundConfirmation({
      to: order.payer_email,
      displayName: order.persona || order.gamertag || null,
      productTitle: order.product_title,
      amountCents: refundedCents || order.amount_cents,
      currency: order.currency,
      captureId: order.paypal_capture_id,
      orderId: order.id,
      dateMs: Date.now()
    }).catch(e => console.error('[refund-mail] send failed:', e.message));
  }

  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
  tryRemoveDiscordRoleForOrder(orderId);

  res.json({ ok: true, refundedCents, subscriptionCancelled, subscriptionCancelError });
});

// ============================================================
//  Priority Queue management (used by reforgedz admin page)
// ============================================================

function buildPriorityQueueList() {
  // Only current holders (expired purchases/manual grants are excluded, matching sync).
  const orderRows = db.prepare(`
    SELECT
      u.bi_uid AS guid,
      COALESCE(u.gamertag, u.persona) AS display_name,
      p.server_specific,
      o.server_id,
      o.effective_until
    FROM orders o
    JOIN users u ON o.steam_id = u.steam_id
    JOIN products p ON o.product_id = p.id
    WHERE o.status = 'completed'
      AND p.grants_priority_queue = 1
      AND u.bi_uid IS NOT NULL AND u.bi_uid != ''
      AND (o.effective_until IS NULL OR o.effective_until > unixepoch())
  `).all();

  const manualRows = db.prepare(`SELECT guid, server_id, display_name, expires_at, removed FROM priority_queue_grants WHERE removed = 1 OR expires_at IS NULL OR expires_at > unixepoch()`).all();

  const byGuid = new Map();
  const blank = () => Object.fromEntries(SERVER_IDS.map(id => [id, false]));
  const blankSrc = () => Object.fromEntries(SERVER_IDS.map(id => [id, null]));
  const blankExp = () => Object.fromEntries(SERVER_IDS.map(id => [id, -Infinity]));

  function ensureEntry(guid, displayName) {
    let e = byGuid.get(guid);
    if (!e) {
      e = { guid, displayName: displayName || '', presence: blank(), sources: blankSrc(), _exp: blankExp() };
      byGuid.set(guid, e);
    } else if (!e.displayName && displayName) {
      e.displayName = displayName;
    }
    return e;
  }

  // expiry: null = permanent (always wins). Otherwise keep the LATEST date the
  // holder keeps access on that server (so they only drop when the last source lapses).
  function mark(entry, serverId, source, expiry) {
    if (!SERVER_IDS.includes(serverId)) return;
    entry.presence[serverId] = true;
    const cur = entry.sources[serverId];
    entry.sources[serverId] = cur && cur !== source ? 'both' : source;
    const d = (expiry == null) ? Infinity : Number(expiry);
    if (d > entry._exp[serverId]) entry._exp[serverId] = d;
  }

  for (const r of orderRows) {
    const e = ensureEntry(r.guid, r.display_name);
    if (!r.server_specific) {
      for (const id of SERVER_IDS) mark(e, id, 'purchase', r.effective_until);
    } else if (r.server_id) {
      mark(e, r.server_id, 'purchase', r.effective_until);
    }
  }

  for (const r of manualRows) {
    if (!r.server_id || !SERVER_IDS.includes(r.server_id)) continue;
    if (r.removed) {
      // Deny: hide this server even if purchased. Only affects an existing holder.
      const e = byGuid.get(r.guid);
      if (!e) continue;
      e.presence[r.server_id] = false;
      e.sources[r.server_id] = null;
      e._exp[r.server_id] = -Infinity;
    } else {
      const e = ensureEntry(r.guid, r.display_name);
      mark(e, r.server_id, 'manual', r.expires_at);
    }
  }

  const out = Array.from(byGuid.values()).map(e => {
    const expiry = {};        // per-server: unix ts, or null = permanent / not present
    let expiresAt = null;     // soonest dated expiry across servers held (null = all permanent)
    for (const id of SERVER_IDS) {
      if (!e.presence[id]) { expiry[id] = null; continue; }
      const v = e._exp[id];
      if (!isFinite(v)) { expiry[id] = null; }
      else { expiry[id] = v; expiresAt = (expiresAt == null || v < expiresAt) ? v : expiresAt; }
    }
    return { guid: e.guid, displayName: e.displayName, presence: e.presence, sources: e.sources, expiry, expiresAt };
  });

  return out.sort((a, b) =>
    (a.displayName || '').toLowerCase().localeCompare((b.displayName || '').toLowerCase())
  );
}

function priorityQueueServers() {
  return SERVER_IDS.map(id => ({ id, label: SERVER_LABELS[id] || id.toUpperCase() }));
}

// ============================================================
//  Save Inspector — freetext search over a server's persistence
//  (the .save JSON files), since Pterodactyl's file browser can't.
// ============================================================
router.get('/api/shop/admin/save-servers', requireAdmin, (req, res) => {
  res.json(priorityQueueServers());
});

router.get('/api/shop/admin/save-search', requireAdmin, async (req, res) => {
  const { server, q, limit } = req.query;
  if (!isValidServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
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
  if (!isValidServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json({ running: await getServerRunning(server) });
  } catch (e) {
    console.error('[save-status]', e.message);
    res.status(500).json({ error: e.message || 'Status check failed' });
  }
});

router.post('/api/shop/admin/save-update', requireAdmin, async (req, res) => {
  const { server, id, json, force } = req.body || {};
  if (!isValidServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
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
  if (!isValidServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
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
  if (!isValidServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json(await scanOrphans(server, category || 'Item'));
  } catch (e) {
    console.error('[save-orphans]', e.message);
    res.status(500).json({ error: e.message || 'Scan failed' });
  }
});

router.post('/api/shop/admin/save-purge-orphans', requireAdmin, async (req, res) => {
  const { server, category, force } = req.body || {};
  if (!isValidServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    const r = await purgeOrphans(server, category || 'Item', force === true);
    if (!r.ok && r.error === 'server_running') return res.status(409).json({ error: 'Server is running — stop it first.' });
    res.json(r);
  } catch (e) {
    console.error('[save-purge-orphans]', e.message);
    res.status(500).json({ error: e.message || 'Purge failed' });
  }
});

router.get('/api/shop/admin/save-collection', requireAdmin, async (req, res) => {
  const { server, category } = req.query;
  if (!isValidServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json(await listCollectionRecords(server, category || 'Item'));
  } catch (e) {
    console.error('[save-collection]', e.message);
    res.status(500).json({ error: e.message || 'Collection load failed' });
  }
});

router.get('/api/shop/admin/save-extra-stats', requireAdmin, async (req, res) => {
  const { server } = req.query;
  if (!isValidServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json(await getExtraStats(server));
  } catch (e) {
    console.error('[save-extra-stats]', e.message);
    res.status(500).json({ error: e.message || 'Stats failed' });
  }
});

router.get('/api/shop/admin/save-players', requireAdmin, async (req, res) => {
  const { server } = req.query;
  if (!isValidServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json(await listPlayers(server));
  } catch (e) {
    console.error('[save-players]', e.message);
    res.status(500).json({ error: e.message || 'Player list failed' });
  }
});

router.get('/api/shop/admin/save-scan-dead', requireAdmin, async (req, res) => {
  const { server } = req.query;
  if (!isValidServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json(await scanDeadCharacters(server));
  } catch (e) {
    console.error('[save-scan-dead]', e.message);
    res.status(500).json({ error: e.message || 'Scan failed' });
  }
});

router.post('/api/shop/admin/save-purge-dead', requireAdmin, async (req, res) => {
  const { server, force } = req.body || {};
  if (!isValidServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
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
  if (!isValidServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
  try {
    res.json(await getSaveRecord(server, id));
  } catch (e) {
    console.error('[save-record]', e.message);
    res.status(500).json({ error: e.message || 'Lookup failed' });
  }
});

router.get('/api/shop/admin/save-categories', requireAdmin, async (req, res) => {
  const { server } = req.query;
  if (!isValidServerId(server)) return res.status(400).json({ error: 'Pick a valid server.' });
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
  if (!isValidServerId(server)) return res.status(400).json({ error: 'Invalid server' });
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

// Manual add: create or rename a manual grant for a guid (without setting any server yet)
router.post('/api/shop/admin/priority-queue', requireAdmin, (req, res) => {
  const { guid: rawGuid, displayName, serverId, expiresAt } = req.body || {};
  const guid = cleanGuid(rawGuid);
  if (!guid) return res.status(400).json({ error: 'Invalid GUID format' });
  const name = (typeof displayName === 'string' ? displayName.trim() : '') || null;

  if (serverId !== undefined && serverId !== null && !SERVER_IDS.includes(serverId)) {
    return res.status(400).json({ error: 'Invalid server ID' });
  }

  if (serverId) {
    db.prepare(`
      INSERT INTO priority_queue_grants (guid, server_id, display_name, removed, granted_by, granted_at)
      VALUES (?, ?, ?, 0, ?, unixepoch())
      ON CONFLICT(guid, server_id) DO UPDATE SET
        removed = 0,
        display_name = COALESCE(excluded.display_name, display_name)
    `).run(guid, serverId, name, req.user && req.user.steam_id ? req.user.steam_id : 'api');
  } else if (name) {
    // No serverId given but a name was — propagate the name to any existing rows for this guid
    db.prepare(`UPDATE priority_queue_grants SET display_name = ? WHERE guid = ? AND (display_name IS NULL OR display_name = '')`).run(name, guid);
  }

  // Optional expiry. Provide a unix timestamp to set one, or null to make it permanent.
  // Omit the field entirely to leave any existing expiry untouched.
  if (expiresAt !== undefined) {
    const n = (expiresAt === null || expiresAt === '') ? null : Math.round(Number(expiresAt));
    const expVal = Number.isFinite(n) ? n : null;
    if (serverId) db.prepare('UPDATE priority_queue_grants SET expires_at = ? WHERE guid = ? AND server_id = ?').run(expVal, guid, serverId);
    else db.prepare('UPDATE priority_queue_grants SET expires_at = ? WHERE guid = ?').run(expVal, guid);
  }

  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));

  const entries = buildPriorityQueueList();
  const entry = entries.find(e => e.guid === guid) || { guid, displayName: name || '', presence: Object.fromEntries(SERVER_IDS.map(id => [id, false])), sources: Object.fromEntries(SERVER_IDS.map(id => [id, null])), expiry: Object.fromEntries(SERVER_IDS.map(id => [id, null])), expiresAt: null };
  res.json({ ok: true, entry });
});

// Toggle priority queue on/off for a given (guid, serverId).
// Only affects manual grants. Purchase-derived presence is untouched.
router.post('/api/shop/admin/priority-queue/toggle', requireAdmin, (req, res) => {
  const { guid: rawGuid, serverId, present, displayName } = req.body || {};
  const guid = cleanGuid(rawGuid);
  if (!guid) return res.status(400).json({ error: 'Invalid GUID' });
  if (!SERVER_IDS.includes(serverId)) return res.status(400).json({ error: 'Invalid server ID' });

  if (present) {
    // Grant this server (and clear any deny on it).
    const name = (typeof displayName === 'string' ? displayName.trim() : '') || null;
    db.prepare(`
      INSERT INTO priority_queue_grants (guid, server_id, display_name, removed, granted_by, granted_at)
      VALUES (?, ?, ?, 0, ?, unixepoch())
      ON CONFLICT(guid, server_id) DO UPDATE SET
        removed = 0,
        display_name = COALESCE(excluded.display_name, display_name)
    `).run(guid, serverId, name, req.user && req.user.steam_id ? req.user.steam_id : 'api');
  } else {
    // Hide this server. A deny row (removed=1) keeps a PURCHASE-driven server off too,
    // and turns a plain manual grant off — sync ignores denied rows.
    db.prepare(`
      INSERT INTO priority_queue_grants (guid, server_id, display_name, removed, granted_by, granted_at)
      VALUES (?, ?, NULL, 1, ?, unixepoch())
      ON CONFLICT(guid, server_id) DO UPDATE SET removed = 1
    `).run(guid, serverId, req.user && req.user.steam_id ? req.user.steam_id : 'api');
  }

  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));

  // Return refreshed entry (or stub if no presence remains)
  const entries = buildPriorityQueueList();
  const entry = entries.find(e => e.guid === guid) || { guid, displayName: '', presence: Object.fromEntries(SERVER_IDS.map(id => [id, false])), sources: Object.fromEntries(SERVER_IDS.map(id => [id, null])) };
  res.json({ ok: true, entry });
});

// Remove all manual grants for a guid (purchase-driven presence is unaffected)
router.delete('/api/shop/admin/priority-queue/:guid', requireAdmin, (req, res) => {
  const guid = cleanGuid(req.params.guid);
  if (!guid) return res.status(400).json({ error: 'Invalid GUID' });
  const result = db.prepare('DELETE FROM priority_queue_grants WHERE guid = ?').run(guid);
  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
  res.json({ ok: true, removed: result.changes });
});

// Extend a holder's priority-queue expiry by N days. Bumps expiring purchase
// subscriptions (orders.effective_until) and any DATED manual grants for this guid.
// Permanent grants (NULL expiry) are intentionally left permanent.
router.post('/api/shop/admin/priority-queue/extend', requireAdmin, (req, res) => {
  const guid = cleanGuid(req.body && req.body.guid);
  if (!guid) return res.status(400).json({ error: 'Invalid GUID' });

  const hasUntil = req.body && req.body.until !== undefined && req.body.until !== null && req.body.until !== '';
  const pqIds = db.prepare('SELECT id FROM products WHERE grants_priority_queue = 1').all().map(r => r.id);
  const inList = pqIds.length ? pqIds.join(',') : '0';
  let purchaseChanges = 0;
  let manualChanges = 0;
  let until = null;

  if (hasUntil) {
    // Set the holder's PQ expiry to an absolute date (from the calendar picker).
    until = Math.round(Number(req.body.until));
    if (!Number.isFinite(until) || until <= 0) return res.status(400).json({ error: 'invalid until timestamp' });
    if (pqIds.length) {
      purchaseChanges = db.prepare(`
        UPDATE orders SET effective_until = ?
        WHERE status = 'completed' AND product_id IN (${inList})
          AND steam_id IN (SELECT steam_id FROM users WHERE bi_uid = ?)
          AND (effective_until IS NULL OR effective_until > unixepoch())
      `).run(until, guid).changes;
    }
    manualChanges = db.prepare(`
      UPDATE priority_queue_grants SET expires_at = ?
      WHERE guid = ? AND removed = 0
    `).run(until, guid).changes;
  } else {
    // Relative bump by N days.
    const days = Number(req.body && req.body.days);
    if (!Number.isFinite(days) || days === 0) return res.status(400).json({ error: 'days must be a non-zero number, or pass until' });
    const secs = Math.round(days * 86400);
    if (pqIds.length) {
      purchaseChanges = db.prepare(`
        UPDATE orders SET effective_until = effective_until + ?
        WHERE status = 'completed' AND effective_until IS NOT NULL
          AND product_id IN (${inList})
          AND steam_id IN (SELECT steam_id FROM users WHERE bi_uid = ?)
      `).run(secs, guid).changes;
    }
    manualChanges = db.prepare(`
      UPDATE priority_queue_grants SET expires_at = expires_at + ?
      WHERE guid = ? AND expires_at IS NOT NULL
    `).run(secs, guid).changes;
  }

  if (purchaseChanges || manualChanges) {
    syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
  }
  const entry = buildPriorityQueueList().find(e => e.guid === guid) || null;
  res.json({ ok: true, until, purchaseChanges, manualChanges, entry });
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
function revenueSummary() {
  const lifetime = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount_cents), 0) cents FROM orders WHERE status = 'completed' AND test_mode = 0`).get();
  const refunded = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount_cents), 0) cents FROM orders WHERE status = 'refunded' AND test_mode = 0`).get();
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
    WHERE o.status = 'refunded' AND o.test_mode = 0
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

function runway(stripeUsdCents, mrrCents, monthlyBurnCents) {
  const netMonthly = (mrrCents || 0) - (monthlyBurnCents || 0);
  if (netMonthly >= 0) return { profitable: true, monthsRemaining: null, netMonthlyCents: netMonthly };
  const months = stripeUsdCents > 0 ? stripeUsdCents / Math.abs(netMonthly) : 0;
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
  const stripeUsdCents = usdAvailable + usdPending;
  const run = runway(stripeUsdCents, mrr.mrrCents, monthlyTotal);

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
        try { await discord.removeRole(existing.discord_id, r.role_id); }
        catch (e) { console.error('[discord] remove on unlink failed:', e.message); }
      }
    }
    db.prepare('UPDATE users SET discord_id = NULL WHERE steam_id = ?').run(req.user.steam_id);
    req.user.discord_id = null;
    return res.json({ ok: true, discord_id: null });
  }

  const cleaned = String(raw).trim();
  if (!/^\d{15,25}$/.test(cleaned)) {
    return res.status(400).json({ error: 'Invalid Discord ID. Use Discord Developer Mode → right-click your name → Copy User ID.' });
  }

  let member;
  try { member = await discord.verifyMember(cleaned); }
  catch (e) { return res.status(502).json({ error: 'Discord lookup failed: ' + e.message }); }
  if (!member) return res.status(404).json({ error: "You're not a member of the ReforgedZ Discord. Join first, then come back." });

  db.prepare('UPDATE users SET discord_id = ? WHERE steam_id = ?').run(cleaned, req.user.steam_id);
  req.user.discord_id = cleaned;

  // Back-fill any role grants this user was owed.
  const owed = db.prepare(`
    SELECT DISTINCT p.discord_role_id AS role_id
    FROM orders o JOIN products p ON o.product_id = p.id
    WHERE o.steam_id = ? AND o.status = 'completed' AND p.discord_role_id IS NOT NULL
  `).all(req.user.steam_id);
  let assigned = 0;
  for (const r of owed) {
    try { await discord.assignRole(cleaned, r.role_id); assigned++; }
    catch (e) { console.error('[discord] back-fill assign failed:', e.message); }
  }

  res.json({ ok: true, discord_id: cleaned, displayName: member.globalName || member.username, rolesAssigned: assigned });
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
    discord.assignRole(row.user_id, row.role_id)
      .catch(e => console.error('[discord] assign role for order %s failed: %s', orderId, e.message));
  } catch (e) {
    console.error('[discord] assign helper failed:', e.message);
  }
}

// Mirror of the above: remove a role only when the user has no OTHER
// completed order still granting it (so a user with two active subscriptions
// to role-granting products doesn't lose the role when one is revoked).
function tryRemoveDiscordRoleForOrder(orderId) {
  try {
    const row = db.prepare(`
      SELECT o.steam_id, p.discord_role_id AS role_id, u.discord_id AS user_id
      FROM orders o JOIN products p ON o.product_id = p.id JOIN users u ON o.steam_id = u.steam_id
      WHERE o.id = ?
    `).get(orderId);
    if (!row || !row.role_id || !row.user_id) return;
    const stillOwed = db.prepare(`
      SELECT 1 FROM orders o JOIN products p ON o.product_id = p.id
      WHERE o.steam_id = ? AND o.id != ? AND o.status = 'completed' AND p.discord_role_id = ?
      LIMIT 1
    `).get(row.steam_id, orderId, row.role_id);
    if (stillOwed) return;
    discord.removeRole(row.user_id, row.role_id)
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

async function webhookHandler(req, res) {
  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }

  // The event doesn't tell us which environment it came from, so try live
  // first then sandbox — whichever webhook id verifies the signature wins.
  let verified = false;
  for (const testMode of [false, true]) {
    const wid = getWebhookId(testMode);
    if (!wid) continue;
    if (await paypal.verifyWebhook(testMode, req.headers, event, wid)) { verified = true; break; }
  }
  if (!verified) {
    console.error('[paypal] webhook signature verification failed:', event.event_type);
    return res.sendStatus(400);
  }

  const resource = event.resource || {};
  const orderId = parseInt(resource.custom_id, 10);

  try {
    await dispatchPayPalEvent(event, resource, orderId);
  } catch (e) {
    // Never let a webhook bug crash the process — PayPal aggressively
    // retries on non-2xx, so a single bad event would loop-kill the box.
    console.error(`[paypal] webhook handler threw on ${event.event_type}:`, e.stack || e.message);
    return res.sendStatus(500);
  }
  return res.sendStatus(200);
}

async function dispatchPayPalEvent(event, resource, orderId) {
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
        const order = db.prepare(`
          SELECT o.*, u.persona, u.bi_uid, u.platform, u.gamertag, u.bm_player_id,
                 p.title as product_title, p.currency
          FROM orders o JOIN users u ON o.steam_id = u.steam_id JOIN products p ON o.product_id = p.id
          WHERE o.id = ?
        `).get(orderId);
        if (order) {
          sendDiscordNotification({
            eventType: 'payment_failed',
            user: { platform: order.platform, persona: order.persona, steam_id: order.steam_id, gamertag: order.gamertag, bm_player_id: order.bm_player_id },
            biUid: order.bi_uid, productTitle: order.product_title,
            amountCents: order.amount_cents, currency: order.currency,
            status: 'failed', serverId: order.server_id
          });
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
        // Don't set a capture_id here — the matching PAYMENT.SALE.COMPLETED
        // event carries the real transaction id and will fill it in. (Older
        // code passed subId as a placeholder, which then caused a duplicate
        // row when SALE.COMPLETED inserted a "real" cycle on top.)
        fulfillOrder(found.id, {
          captureId: null,
          payerEmail: resource.subscriber?.email_address || null,
          feeCents: null
        });
        // Pin the entitlement end-date to PayPal's next billing time so a
        // mid-cycle cancellation still honours the period the buyer paid for.
        const nextBilling = resource.billing_info?.next_billing_time;
        if (nextBilling) {
          const untilUnix = Math.floor(new Date(nextBilling).getTime() / 1000);
          if (isFinite(untilUnix) && untilUnix > 0) {
            db.prepare('UPDATE orders SET effective_until = ? WHERE id = ?').run(untilUnix, found.id);
          }
        }
      }
      break;
    }

    case 'PAYMENT.SALE.COMPLETED': {
      // Each recurring billing cycle on a subscription fires this. Find the
      // owning subscription and book a renewal order row so MRR + the
      // buyer's order history both reflect the new cycle.
      const subId = resource.billing_agreement_id;
      if (subId) {
        const original = db.prepare(`
          SELECT o.*, p.title AS product_title, p.currency,
                 u.persona, u.platform, u.gamertag, u.bm_player_id, u.bi_uid
          FROM orders o
          JOIN products p ON o.product_id = p.id
          JOIN users u    ON o.steam_id   = u.steam_id
          WHERE o.paypal_subscription_id = ? AND o.status IN ('completed','pending')
          ORDER BY o.id ASC LIMIT 1
        `).get(subId);
        if (original) {
          const cycleAmount = resource.amount?.total
            ? Math.round(parseFloat(resource.amount.total) * 100)
            : original.amount_cents;
          const feeCents = resource.transaction_fee?.value != null
            ? Math.round(parseFloat(resource.transaction_fee.value) * 100) : null;
          // Idempotency guard — if we've already booked a row for this
          // transaction id, skip.
          const existing = db.prepare('SELECT id FROM orders WHERE paypal_capture_id = ?').get(resource.id);
          if (!existing) {
            // PAYMENT.SALE.COMPLETED doesn't include next_billing_time, but
            // the sub does — one extra API call gets us the cycle end so
            // mid-cycle cancellations honour the paid period.
            let effectiveUntil = null;
            try {
              const sub = await paypal.getSubscription(!!original.test_mode, subId);
              const next = sub?.billing_info?.next_billing_time;
              if (next) {
                const u = Math.floor(new Date(next).getTime() / 1000);
                if (isFinite(u) && u > 0) effectiveUntil = u;
              }
            } catch (e) {
              console.warn('[paypal] renewal next_billing_time lookup failed:', e.message);
            }
            // First-cycle case: BILLING.SUBSCRIPTION.ACTIVATED already
            // promoted the buyer's pending order to completed with no
            // capture id (or a legacy capture_id == subId placeholder). Fill
            // it in here instead of inserting a duplicate row.
            const placeholder = db.prepare(`
              SELECT id FROM orders
              WHERE paypal_subscription_id = ? AND status = 'completed'
                AND (paypal_capture_id IS NULL OR paypal_capture_id = paypal_subscription_id)
              ORDER BY id ASC LIMIT 1
            `).get(subId);
            let newOrderId;
            if (placeholder) {
              db.prepare(`
                UPDATE orders SET
                  paypal_capture_id = ?,
                  payer_email = COALESCE(?, payer_email),
                  fee_cents = ?,
                  effective_until = COALESCE(?, effective_until),
                  amount_cents = ?
                WHERE id = ?
              `).run(
                resource.id,
                resource.payer?.email_address || null,
                feeCents,
                effectiveUntil,
                cycleAmount,
                placeholder.id
              );
              newOrderId = placeholder.id;
            } else {
              // True renewal cycle — buyer's been on the sub for ≥1 month and
              // this is a fresh billing. Insert a new row.
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
            }
            // Side effects (Discord notif, invoice, role grant, sync) only
            // fire on TRUE renewals. The first cycle already went through
            // fulfillOrder during BILLING.SUBSCRIPTION.ACTIVATED — re-firing
            // here would mean two notifications and two invoice emails for
            // a single payment.
            if (!placeholder) {
              sendDiscordNotification({
                eventType: 'subscription_renewed',
                user: {
                  platform: original.platform,
                  persona: original.persona,
                  steam_id: original.steam_id,
                  gamertag: original.gamertag,
                  bm_player_id: original.bm_player_id
                },
                biUid: original.bi_uid,
                productTitle: original.product_title,
                amountCents: cycleAmount,
                currency: original.currency,
                status: 'completed',
                serverId: original.server_id
              });
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
          }
        }
      }
      break;
    }

    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
    case 'BILLING.SUBSCRIPTION.EXPIRED': {
      const subId = resource.id;
      if (!subId) break;

      // Buyer paid for the current cycle — they keep their entitlement
      // through the end of it. Pin effective_until on the most recent
      // completed cycle to PayPal's next_billing_time (or the event-supplied
      // next billing date), and stop accepting future cycles by cancelling
      // any pending row. Status on completed cycles stays 'completed' so
      // sync.js's effective_until check is what eventually removes them.
      const next = resource.billing_info?.next_billing_time;
      let until = null;
      if (next) {
        const u = Math.floor(new Date(next).getTime() / 1000);
        if (isFinite(u) && u > 0) until = u;
      }
      // Fallback: most recent cycle's completed_at + 31 days (approx monthly).
      if (!until) {
        const last = db.prepare(`
          SELECT completed_at FROM orders
          WHERE paypal_subscription_id = ? AND status = 'completed'
          ORDER BY id DESC LIMIT 1
        `).get(subId);
        if (last?.completed_at) until = last.completed_at + 31 * 86400;
      }

      // Drop any pending cycle (buyer abandoned approval or sub never activated)
      db.prepare(`UPDATE orders SET status = 'cancelled' WHERE paypal_subscription_id = ? AND status = 'pending'`).run(subId);

      if (until) {
        db.prepare(`
          UPDATE orders SET effective_until = ?
          WHERE paypal_subscription_id = ? AND status = 'completed'
            AND (effective_until IS NULL OR effective_until > ?)
        `).run(until, subId, until);
      }
      syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));

      // Notify Discord + email the buyer.
      const ctx = db.prepare(`
        SELECT o.*, u.persona, u.platform, u.gamertag, u.bm_player_id, u.bi_uid,
               p.title AS product_title, p.currency, p.price_cents
        FROM orders o
        JOIN users u    ON o.steam_id = u.steam_id
        JOIN products p ON o.product_id = p.id
        WHERE o.paypal_subscription_id = ?
        ORDER BY o.id DESC LIMIT 1
      `).get(subId);
      if (ctx) {
        sendDiscordNotification({
          eventType: 'subscription_cancelled',
          user: { platform: ctx.platform, persona: ctx.persona, steam_id: ctx.steam_id, gamertag: ctx.gamertag, bm_player_id: ctx.bm_player_id },
          biUid: ctx.bi_uid, productTitle: ctx.product_title,
          amountCents: ctx.price_cents, currency: ctx.currency,
          status: event.event_type.replace('BILLING.SUBSCRIPTION.', '').toLowerCase(),
          serverId: ctx.server_id
        });
        const to = resource.subscriber?.email_address || ctx.payer_email;
        if (to) {
          sendSubscriptionCancelled({
            to,
            displayName: ctx.persona || ctx.gamertag || null,
            productTitle: ctx.product_title,
            accessEndsAtMs: until ? until * 1000 : null,
            priceCents: ctx.price_cents,
            currency: ctx.currency
          }).catch(e => console.error('[cancel-mail] send failed:', e.message));
        }
      }
      break;
    }

    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED': {
      // The refunded capture id is in resource.links / supplementary; match
      // by our stored capture id when custom_id isn't present on refunds.
      const capId = resource.id || null;
      let order = orderId
        ? db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)
        : null;
      if (!order && capId) {
        order = db.prepare('SELECT * FROM orders WHERE paypal_capture_id = ?').get(capId);
      }
      if (order && order.status === 'completed') {
        db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(order.id);
        tryRemoveDiscordRoleForOrder(order.id);
        syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
        const full = db.prepare(`
          SELECT o.*, u.persona, u.bi_uid, u.platform, u.gamertag, u.bm_player_id,
                 p.title as product_title, p.currency
          FROM orders o JOIN users u ON o.steam_id = u.steam_id JOIN products p ON o.product_id = p.id
          WHERE o.id = ?
        `).get(order.id);
        if (full) {
          sendDiscordNotification({
            eventType: 'order_revoked',
            user: { platform: full.platform, persona: full.persona, steam_id: full.steam_id, gamertag: full.gamertag, bm_player_id: full.bm_player_id },
            biUid: full.bi_uid, productTitle: full.product_title,
            amountCents: full.amount_cents, currency: full.currency,
            status: 'refunded', serverId: full.server_id
          });
          const to = full.payer_email || resource.payer?.email_address || null;
          if (to) {
            sendRefundConfirmation({
              to,
              displayName: full.persona || full.gamertag || null,
              productTitle: full.product_title,
              amountCents: full.amount_cents,
              currency: full.currency,
              captureId: full.paypal_capture_id,
              orderId: full.id,
              dateMs: Date.now()
            }).catch(e => console.error('[refund-mail] send failed:', e.message));
          }
        }
      }
      break;
    }
  }
}

module.exports = { router, webhookHandler, registerPayPalWebhooks };

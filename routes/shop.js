const express = require('express');
const router = express.Router();
const db = require('../db');
const { syncPurchasesToServers } = require('../sync');
const { SERVER_IDS, SERVER_LABELS, isValidServerId } = require('../gameServers');
const discord = require('../discord');

// ---- Stripe setup ----
const Stripe = require('stripe');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function getStripe(testMode) {
  const key = testMode ? process.env.STRIPE_TEST_SECRET_KEY : process.env.STRIPE_SECRET_KEY;
  return new Stripe(key);
}

// ---- Discord webhook ----
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

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

function attachStock(product) {
  if (!product) return product;
  if (product.server_specific) {
    product.per_server_used = perServerStockUsed(product.id);
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
    SELECT id, title, description, price_cents, currency, type, image_url, images_json, interval_days, stock_limit, server_specific, grants_priority_queue, custom_price, price_min_cents, price_max_cents, discord_role_id, active
    FROM products WHERE active = 1 ORDER BY created_at DESC
  `).all();
  res.json(products.map(p => attachStock(attachImages(p))));
});

// Get Stripe publishable key
router.get('/api/shop/config', (req, res) => {
  const testMode = req.query.test === '1';
  res.json({
    publishableKey: testMode ? process.env.STRIPE_TEST_PUBLISHABLE_KEY : process.env.STRIPE_PUBLISHABLE_KEY
  });
});

// Create checkout session
router.post('/api/shop/checkout', requireAuth, (req, res) => {
  const { productId, testMode, serverId, customAmountCents } = req.body;
  if (!productId) return res.status(400).json({ error: 'Missing productId' });

  // Only admins can use test mode
  const useTest = testMode && req.user.role === 'admin';
  const stripe = getStripe(useTest);

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  let orderServerId = null;
  if (product.server_specific) {
    if (!isValidServerId(serverId)) {
      return res.status(400).json({ error: 'Pick a server for this purchase.' });
    }
    orderServerId = serverId;
    if (product.stock_limit != null) {
      const used = perServerStockUsed(product.id)[serverId] || 0;
      if (used >= product.stock_limit) {
        const buyerOnServer = db.prepare(`
          SELECT 1 FROM orders WHERE product_id = ? AND server_id = ? AND steam_id = ? AND status = 'completed' LIMIT 1
        `).get(product.id, serverId, req.user.steam_id);
        if (!buyerOnServer) {
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
    if (requested < 50) {
      return res.status(400).json({ error: 'Minimum charge is $0.50 (Stripe).' });
    }
    amountCents = requested;
  }

  // Create pending order
  const order = db.prepare(`
    INSERT INTO orders (steam_id, product_id, server_id, status, amount_cents) VALUES (?, ?, ?, 'pending', ?)
  `).run(req.user.steam_id, product.id, orderServerId, amountCents);

  const orderId = order.lastInsertRowid;
  const isRecurring = product.type === 'subscription' || product.type === 'recurring_custom';

  let recurring = null;
  if (product.type === 'subscription') {
    recurring = { interval: 'month' };
  } else if (product.type === 'recurring_custom') {
    const days = parseInt(product.interval_days, 10);
    if (!days || days < 1 || days > 365) {
      db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
      return res.status(400).json({ error: 'Product has invalid interval_days' });
    }
    recurring = { interval: 'day', interval_count: days };
  }

  const sessionParams = {
    mode: isRecurring ? 'subscription' : 'payment',
    line_items: [{
      price_data: {
        currency: product.currency,
        product_data: {
          name: product.title,
          description: product.description || undefined,
        },
        unit_amount: amountCents,
        ...(recurring ? { recurring } : {})
      },
      quantity: 1
    }],
    metadata: {
      order_id: String(orderId),
      steam_id: req.user.steam_id,
      product_id: String(product.id),
      test_mode: useTest ? '1' : '0'
    },
    success_url: BASE_URL + '/shop?success=1&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: BASE_URL + '/shop?cancelled=1',
  };

  // Stripe Price ID is only honored for one_time / subscription types AND
  // when the buyer isn't picking their own amount (custom_price needs inline
  // price_data with unit_amount each time).
  if (product.stripe_price_id && product.type !== 'recurring_custom' && !product.custom_price) {
    sessionParams.line_items = [{
      price: product.stripe_price_id,
      quantity: 1
    }];
  }

  stripe.checkout.sessions.create(sessionParams).then(session => {
    db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, orderId);
    res.json({ url: session.url });
  }).catch(err => {
    console.error('Stripe checkout error:', err.message);
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
    res.status(500).json({ error: 'Failed to create checkout session' });
  });
});

// Get current user's orders
router.get('/api/shop/orders', requireAuth, (req, res) => {
  const orders = db.prepare(`
    SELECT o.id, o.product_id, o.status, o.amount_cents, o.created_at, o.completed_at,
           o.stripe_subscription_id, o.server_id, p.title, p.type, p.currency, p.server_specific
    FROM orders o JOIN products p ON o.product_id = p.id
    WHERE o.steam_id = ? ORDER BY o.created_at DESC
  `).all(req.user.steam_id);
  res.json(orders);
});

// Set own BI UID
router.post('/api/shop/set-bi-uid', requireAuth, (req, res) => {
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

// Verify a checkout session (fallback when webhooks don't arrive)
router.post('/api/shop/verify-session', requireAuth, (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  const order = db.prepare(`
    SELECT * FROM orders WHERE stripe_session_id = ? AND steam_id = ? AND status = 'pending'
  `).get(sessionId, req.user.steam_id);

  if (!order) return res.json({ ok: true, status: 'already_processed' });

  // Check if this was a test mode order
  const useTest = order.amount_cents === 0 || false;

  // Try live Stripe first, then test
  const tryVerify = (stripe) => stripe.checkout.sessions.retrieve(sessionId);

  tryVerify(getStripe(false))
    .catch(() => tryVerify(getStripe(true)))
    .then(session => {
      if (session.payment_status === 'paid') {
        db.prepare(`
          UPDATE orders SET status = 'completed', completed_at = unixepoch(),
            stripe_subscription_id = ?
          WHERE id = ?
        `).run(session.subscription || null, order.id);

        const details = db.prepare(`
          SELECT o.*, u.persona, u.bi_uid, u.platform, u.gamertag, u.bm_player_id,
                 p.title as product_title, p.type, p.currency
          FROM orders o JOIN users u ON o.steam_id = u.steam_id JOIN products p ON o.product_id = p.id
          WHERE o.id = ?
        `).get(order.id);
        if (details) {
          sendDiscordNotification({
            eventType: session.subscription ? 'subscription_started' : 'payment_completed',
            user: { platform: details.platform, persona: details.persona, steam_id: details.steam_id, gamertag: details.gamertag, bm_player_id: details.bm_player_id },
            biUid: details.bi_uid,
            productTitle: details.product_title,
            amountCents: details.amount_cents,
            currency: details.currency,
            status: 'completed',
            serverId: details.server_id
          });
        }

        syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
        tryAssignDiscordRoleForOrder(order.id);
        return res.json({ ok: true, status: 'completed' });
      }
      res.json({ ok: true, status: session.payment_status });
    })
    .catch(err => {
      console.error('Verify session error:', err.message);
      res.status(500).json({ error: 'Failed to verify session' });
    });
});

// Get subscription info (period end date)
router.get('/api/shop/subscription-info/:orderId', requireAuth, (req, res) => {
  const order = db.prepare(`
    SELECT o.stripe_subscription_id FROM orders o
    WHERE o.id = ? AND o.steam_id = ? AND o.status = 'completed' AND o.stripe_subscription_id IS NOT NULL
  `).get(req.params.orderId, req.user.steam_id);

  if (!order) return res.status(404).json({ error: 'Active subscription not found' });

  const stripe = getStripe(false);
  const stripeTest = getStripe(true);

  stripe.subscriptions.retrieve(order.stripe_subscription_id)
    .catch(() => stripeTest.subscriptions.retrieve(order.stripe_subscription_id))
    .then(sub => {
      res.json({
        periodEnd: sub.current_period_end,
        cancelAtPeriodEnd: sub.cancel_at_period_end
      });
    })
    .catch(err => {
      console.error('Subscription info error:', err.message);
      res.status(500).json({ error: 'Failed to fetch subscription info' });
    });
});

// Cancel a subscription
router.post('/api/shop/cancel-subscription', requireAuth, (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

  const order = db.prepare(`
    SELECT o.*, p.type, p.title as product_title, p.currency FROM orders o JOIN products p ON o.product_id = p.id
    WHERE o.id = ? AND o.steam_id = ? AND o.status = 'completed' AND o.stripe_subscription_id IS NOT NULL
  `).get(orderId, req.user.steam_id);

  if (!order) return res.status(404).json({ error: 'Active subscription not found' });

  const stripe = getStripe(false);
  const stripeTest = getStripe(true);

  // Try live first, then test
  stripe.subscriptions.update(order.stripe_subscription_id, { cancel_at_period_end: true })
    .catch(() => stripeTest.subscriptions.update(order.stripe_subscription_id, { cancel_at_period_end: true }))
    .then(() => {
      db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);

      sendDiscordNotification({
        eventType: 'subscription_cancelled',
        user: req.user,
        biUid: req.user.bi_uid,
        productTitle: order.product_title,
        amountCents: order.amount_cents,
        currency: order.currency,
        status: 'cancelled',
        serverId: order.server_id
      });

      tryRemoveDiscordRoleForOrder(orderId);

      res.json({ ok: true });
    })
    .catch(err => {
      console.error('Cancel subscription error:', err.message);
      res.status(500).json({ error: 'Failed to cancel subscription' });
    });
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
    SELECT o.id, o.status, o.amount_cents, o.created_at, o.completed_at,
           o.stripe_session_id, o.stripe_subscription_id,
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

// Set BI UID for a user (admin only)
router.put('/api/shop/admin/users/:steamId/bi-uid', requireAdmin, (req, res) => {
  const { biUid } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE steam_id = ?').get(req.params.steamId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET bi_uid = ? WHERE steam_id = ?').run(biUid || null, req.params.steamId);
  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
  res.json({ ok: true });
});

const VALID_PRODUCT_TYPES = ['one_time', 'subscription', 'recurring_custom'];

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
  const { title, description, priceCents, type, imageUrl, intervalDays, imagesExtra, stockLimit, serverSpecific, grantsPriorityQueue, customPrice, priceMinCents, priceMaxCents, discordRoleId } = req.body;

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return res.status(400).json({ error: 'Title is required' });
  }
  if (!priceCents || typeof priceCents !== 'number' || priceCents < 1) {
    return res.status(400).json({ error: 'Price must be a positive number (in cents)' });
  }
  if (!type || !VALID_PRODUCT_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Type must be one_time, subscription, or recurring_custom' });
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
  const serverSpecificVal = serverSpecific ? 1 : 0;
  const grantsPqVal = grantsPriorityQueue ? 1 : 0;

  const customCheck = validateCustomPricing({ customPrice, priceMinCents, priceMaxCents, type });
  if (!customCheck.ok) return res.status(400).json({ error: customCheck.error });
  const customPriceVal = customPrice ? 1 : 0;
  const discordRoleIdVal = normalizeDiscordRoleId(discordRoleId);

  const result = db.prepare(`
    INSERT INTO products (title, description, price_cents, type, image_url, interval_days, images_json, stock_limit, server_specific, grants_priority_queue, custom_price, price_min_cents, price_max_cents, discord_role_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title.trim(), (description || '').trim(), priceCents, type, imageUrl || null, intervalDaysVal, imagesJson, stockLimitVal === undefined ? null : stockLimitVal, serverSpecificVal, grantsPqVal, customPriceVal, customCheck.min, customCheck.max, discordRoleIdVal || null);

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
  res.json(attachStock(attachImages(product)));
});

// Update product
router.put('/api/shop/admin/products/:id', requireAdmin, (req, res) => {
  const { title, description, priceCents, imageUrl, active, type, intervalDays, imagesExtra, stockLimit, serverSpecific, grantsPriorityQueue, customPrice, priceMinCents, priceMaxCents, discordRoleId } = req.body;
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

// Hard delete: nukes the product, its orders, and cancels any active Stripe subs
router.delete('/api/shop/admin/products/:id/hard', requireAdmin, async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const subRows = db.prepare(`
    SELECT DISTINCT stripe_subscription_id FROM orders
    WHERE product_id = ? AND status = 'completed' AND stripe_subscription_id IS NOT NULL
  `).all(req.params.id);

  let cancelledSubs = 0;
  for (const row of subRows) {
    try {
      await getStripe(false).subscriptions.cancel(row.stripe_subscription_id);
      cancelledSubs++;
    } catch (e) {
      try {
        await getStripe(true).subscriptions.cancel(row.stripe_subscription_id);
        cancelledSubs++;
      } catch (e2) {
        console.error(`[hard-delete] Failed to cancel sub ${row.stripe_subscription_id}: ${e2.message}`);
      }
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
      .catch(e => console.error(`[discord] hard-delete role remove ${r.user_id}/${r.role_id}:`, e.message));
  }

  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));

  res.json({ ok: true, deletedOrders, cancelledSubs });
});

// Refund the latest charge for an order (recurring → latest invoice; one-time → checkout charge)
async function refundLatestChargeForOrder(order, useTest) {
  const stripe = getStripe(useTest);
  let refundParams = null;

  if (order.stripe_subscription_id) {
    const invoices = await stripe.invoices.list({ subscription: order.stripe_subscription_id, limit: 1 });
    const invoice = invoices.data && invoices.data[0];
    if (!invoice) throw new Error('No invoice on subscription');
    if (invoice.charge) refundParams = { charge: invoice.charge };
    else if (invoice.payment_intent) refundParams = { payment_intent: invoice.payment_intent };
    else throw new Error('Latest invoice has no charge or payment intent');
  } else if (order.stripe_session_id) {
    const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
    if (session.payment_intent) refundParams = { payment_intent: session.payment_intent };
    else throw new Error('Checkout session has no payment intent');
  } else {
    throw new Error('Order has no Stripe session or subscription to refund');
  }

  const refund = await stripe.refunds.create(refundParams);
  return refund.amount;
}

// Revoke an order (admin only). With { refund: true } also issues a Stripe refund:
//   - Recurring: refunds only the latest invoice
//   - One-time:  refunds the original charge
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
    try {
      refundedCents = await refundLatestChargeForOrder(order, false);
    } catch (e) {
      const msg = String(e && e.message || '');
      if (/no such|resource_missing/i.test(msg)) {
        return res.status(400).json({ error: 'This order is not a live Stripe charge — refunds only work on live orders.' });
      }
      console.error('Refund failed:', msg);
      return res.status(502).json({ error: 'Refund failed: ' + msg });
    }
  }

  // Cancel any active subscription
  if (order.stripe_subscription_id) {
    try {
      await getStripe(false).subscriptions.cancel(order.stripe_subscription_id);
    } catch (e) {
      try {
        await getStripe(true).subscriptions.cancel(order.stripe_subscription_id);
      } catch (e2) {
        console.error('Failed to cancel subscription in Stripe:', e2.message);
      }
    }
  }

  db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(orderId);

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

  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
  tryRemoveDiscordRoleForOrder(orderId);

  res.json({ ok: true, refundedCents });
});

// ============================================================
//  Priority Queue management (used by reforgedz admin page)
// ============================================================

function buildPriorityQueueList() {
  const orderRows = db.prepare(`
    SELECT
      u.bi_uid AS guid,
      COALESCE(u.gamertag, u.persona) AS display_name,
      p.server_specific,
      o.server_id
    FROM orders o
    JOIN users u ON o.steam_id = u.steam_id
    JOIN products p ON o.product_id = p.id
    WHERE o.status = 'completed'
      AND p.grants_priority_queue = 1
      AND u.bi_uid IS NOT NULL AND u.bi_uid != ''
  `).all();

  const manualRows = db.prepare(`SELECT guid, server_id, display_name FROM priority_queue_grants`).all();

  const byGuid = new Map();
  const blank = () => Object.fromEntries(SERVER_IDS.map(id => [id, false]));
  const blankSrc = () => Object.fromEntries(SERVER_IDS.map(id => [id, null]));

  function ensureEntry(guid, displayName) {
    let e = byGuid.get(guid);
    if (!e) {
      e = { guid, displayName: displayName || '', presence: blank(), sources: blankSrc() };
      byGuid.set(guid, e);
    } else if (!e.displayName && displayName) {
      e.displayName = displayName;
    }
    return e;
  }

  function mark(entry, serverId, source) {
    if (!SERVER_IDS.includes(serverId)) return;
    entry.presence[serverId] = true;
    const cur = entry.sources[serverId];
    entry.sources[serverId] = cur && cur !== source ? 'both' : source;
  }

  for (const r of orderRows) {
    const e = ensureEntry(r.guid, r.display_name);
    if (!r.server_specific) {
      for (const id of SERVER_IDS) mark(e, id, 'purchase');
    } else if (r.server_id) {
      mark(e, r.server_id, 'purchase');
    }
  }

  for (const r of manualRows) {
    const e = ensureEntry(r.guid, r.display_name);
    if (r.server_id) mark(e, r.server_id, 'manual');
  }

  return Array.from(byGuid.values()).sort((a, b) =>
    (a.displayName || '').toLowerCase().localeCompare((b.displayName || '').toLowerCase())
  );
}

function priorityQueueServers() {
  return SERVER_IDS.map(id => ({ id, label: SERVER_LABELS[id] || id.toUpperCase() }));
}

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
  const { guid: rawGuid, displayName, serverId } = req.body || {};
  const guid = cleanGuid(rawGuid);
  if (!guid) return res.status(400).json({ error: 'Invalid GUID format' });
  const name = (typeof displayName === 'string' ? displayName.trim() : '') || null;

  if (serverId !== undefined && serverId !== null && !SERVER_IDS.includes(serverId)) {
    return res.status(400).json({ error: 'Invalid server ID' });
  }

  if (serverId) {
    db.prepare(`
      INSERT INTO priority_queue_grants (guid, server_id, display_name, granted_by, granted_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(guid, server_id) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, display_name)
    `).run(guid, serverId, name, req.user && req.user.steam_id ? req.user.steam_id : 'api');
  } else if (name) {
    // No serverId given but a name was — propagate the name to any existing rows for this guid
    db.prepare(`UPDATE priority_queue_grants SET display_name = ? WHERE guid = ? AND (display_name IS NULL OR display_name = '')`).run(name, guid);
  }

  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));

  const entries = buildPriorityQueueList();
  const entry = entries.find(e => e.guid === guid) || { guid, displayName: name || '', presence: Object.fromEntries(SERVER_IDS.map(id => [id, false])), sources: Object.fromEntries(SERVER_IDS.map(id => [id, null])) };
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
    const name = (typeof displayName === 'string' ? displayName.trim() : '') || null;
    db.prepare(`
      INSERT INTO priority_queue_grants (guid, server_id, display_name, granted_by, granted_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(guid, server_id) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, display_name)
    `).run(guid, serverId, name, req.user && req.user.steam_id ? req.user.steam_id : 'api');
  } else {
    db.prepare('DELETE FROM priority_queue_grants WHERE guid = ? AND server_id = ?').run(guid, serverId);
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
      .catch(e => console.error(`[discord] assign role for order ${orderId} failed:`, e.message));
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
      .catch(e => console.error(`[discord] remove role for order ${orderId} failed:`, e.message));
  } catch (e) {
    console.error('[discord] remove helper failed:', e.message);
  }
}

// ============================================================
//  Stripe webhook handler (exported separately for raw body)
// ============================================================

function webhookHandler(req, res) {
  const sig = req.headers['stripe-signature'];

  // Try both live and test webhook secrets
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_TEST_WEBHOOK_SECRET].filter(Boolean);
  let event = null;

  for (const secret of secrets) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
      break;
    } catch (e) {
      continue;
    }
  }

  if (!event) {
    console.error('Webhook signature verification failed');
    return res.sendStatus(400);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const orderId = session.metadata && session.metadata.order_id;
      if (orderId) {
        db.prepare(`
          UPDATE orders SET status = 'completed', completed_at = unixepoch(),
            stripe_session_id = ?, stripe_subscription_id = ?
          WHERE id = ?
        `).run(session.id, session.subscription || null, orderId);

        const order = db.prepare(`
          SELECT o.*, u.persona, u.bi_uid, u.platform, u.gamertag, u.bm_player_id,
                 p.title as product_title, p.type, p.currency
          FROM orders o JOIN users u ON o.steam_id = u.steam_id JOIN products p ON o.product_id = p.id
          WHERE o.id = ?
        `).get(orderId);
        if (order) {
          sendDiscordNotification({
            eventType: session.subscription ? 'subscription_started' : 'payment_completed',
            user: { platform: order.platform, persona: order.persona, steam_id: order.steam_id, gamertag: order.gamertag, bm_player_id: order.bm_player_id },
            biUid: order.bi_uid,
            productTitle: order.product_title,
            amountCents: order.amount_cents,
            currency: order.currency,
            status: 'completed',
            serverId: order.server_id
          });
        }
        syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
        tryAssignDiscordRoleForOrder(orderId);
      }
      break;
    }

    case 'checkout.session.expired': {
      const session = event.data.object;
      const orderId = session.metadata && session.metadata.order_id;
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
            biUid: order.bi_uid,
            productTitle: order.product_title,
            amountCents: order.amount_cents,
            currency: order.currency,
            status: 'failed',
            serverId: order.server_id
          });
        }
      }
      break;
    }

    case 'invoice.paid': {
      const invoice = event.data.object;
      const subId = invoice.subscription;
      if (subId) {
        const existing = db.prepare('SELECT * FROM orders WHERE stripe_subscription_id = ? AND status = ?').get(subId, 'completed');
        if (existing) {
          const renewal = db.prepare(`
            INSERT INTO orders (steam_id, product_id, server_id, stripe_subscription_id, status, amount_cents, completed_at)
            VALUES (?, ?, ?, ?, 'completed', ?, unixepoch())
          `).run(existing.steam_id, existing.product_id, existing.server_id, subId, invoice.amount_paid);
          tryAssignDiscordRoleForOrder(renewal.lastInsertRowid);

          const user = db.prepare('SELECT persona, bi_uid, platform, gamertag, bm_player_id FROM users WHERE steam_id = ?').get(existing.steam_id);
          const product = db.prepare('SELECT title, currency FROM products WHERE id = ?').get(existing.product_id);
          sendDiscordNotification({
            eventType: 'subscription_renewed',
            user: { platform: user ? user.platform : 'steam', persona: user ? user.persona : existing.steam_id, steam_id: existing.steam_id, gamertag: user ? user.gamertag : null, bm_player_id: user ? user.bm_player_id : null },
            biUid: user ? user.bi_uid : null,
            productTitle: product ? product.title : 'Unknown',
            amountCents: invoice.amount_paid,
            currency: product ? product.currency : 'usd',
            status: 'completed',
            serverId: existing.server_id
          });
        }
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const existing = db.prepare(`
        SELECT o.steam_id, o.amount_cents, o.server_id, u.persona, u.bi_uid, u.platform, u.gamertag, u.bm_player_id,
               p.title as product_title, p.currency
        FROM orders o JOIN users u ON o.steam_id = u.steam_id JOIN products p ON o.product_id = p.id
        WHERE o.stripe_subscription_id = ? AND o.status = 'completed' LIMIT 1
      `).get(sub.id);

      const cancelledIds = db.prepare(`
        SELECT id FROM orders WHERE stripe_subscription_id = ? AND status = 'completed'
      `).all(sub.id).map(r => r.id);

      db.prepare(`
        UPDATE orders SET status = 'cancelled' WHERE stripe_subscription_id = ? AND status = 'completed'
      `).run(sub.id);

      for (const id of cancelledIds) tryRemoveDiscordRoleForOrder(id);

      if (existing) {
        sendDiscordNotification({
          eventType: 'subscription_cancelled',
          user: { platform: existing.platform, persona: existing.persona, steam_id: existing.steam_id, gamertag: existing.gamertag, bm_player_id: existing.bm_player_id },
          biUid: existing.bi_uid,
          productTitle: existing.product_title,
          amountCents: existing.amount_cents,
          currency: existing.currency,
          status: 'cancelled',
          serverId: existing.server_id
        });
      }
      syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
      break;
    }
  }

  res.sendStatus(200);
}

module.exports = { router, webhookHandler };

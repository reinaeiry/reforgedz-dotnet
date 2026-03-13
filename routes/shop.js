const express = require('express');
const router = express.Router();
const db = require('../db');
const { syncPurchasesToServers } = require('../sync');

// ---- Stripe setup ----
const Stripe = require('stripe');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function getStripe(testMode) {
  const key = testMode ? process.env.STRIPE_TEST_SECRET_KEY : process.env.STRIPE_SECRET_KEY;
  return new Stripe(key);
}

// ---- Discord webhook ----
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

function sendDiscordNotification({ eventType, steamName, steamId, biUid, productTitle, amountCents, currency, status }) {
  if (!DISCORD_WEBHOOK_URL) return;

  const colors = {
    pending: 0xfbbf24,   // yellow
    completed: 0x4ade80, // green
    cancelled: 0xf87171, // red
    failed: 0xf87171,    // red
    refunded: 0xc084fc   // purple
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

  const fields = [
    { name: 'Player', value: steamName || 'Unknown', inline: true },
    { name: 'Steam ID', value: steamId || 'Unknown', inline: true },
  ];
  fields.push({ name: 'BI UID', value: biUid || 'SET LATER', inline: false });
  fields.push(
    { name: 'Product', value: productTitle || 'Unknown', inline: false },
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

// ---- Middleware helpers ----
function requireAuth(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Sign in required' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.isAuthenticated() || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ============================================================
//  Public endpoints
// ============================================================

// Get active products
router.get('/api/shop/products', (req, res) => {
  const products = db.prepare(`
    SELECT id, title, description, price_cents, currency, type, image_url
    FROM products WHERE active = 1 ORDER BY created_at DESC
  `).all();
  res.json(products);
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
  const { productId, testMode } = req.body;
  if (!productId) return res.status(400).json({ error: 'Missing productId' });

  // Only admins can use test mode
  const useTest = testMode && req.user.role === 'admin';
  const stripe = getStripe(useTest);

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  // Create pending order
  const order = db.prepare(`
    INSERT INTO orders (steam_id, product_id, status, amount_cents) VALUES (?, ?, 'pending', ?)
  `).run(req.user.steam_id, product.id, product.price_cents);

  const orderId = order.lastInsertRowid;
  const isSubscription = product.type === 'subscription';

  const sessionParams = {
    mode: isSubscription ? 'subscription' : 'payment',
    line_items: [{
      price_data: {
        currency: product.currency,
        product_data: {
          name: product.title,
          description: product.description || undefined,
        },
        unit_amount: product.price_cents,
        ...(isSubscription ? { recurring: { interval: 'month' } } : {})
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

  // Use Stripe Price ID if available instead of price_data
  if (product.stripe_price_id) {
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
           o.stripe_subscription_id, p.title, p.type, p.currency
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
          SELECT o.*, u.persona, u.bi_uid, p.title as product_title, p.type, p.currency
          FROM orders o JOIN users u ON o.steam_id = u.steam_id JOIN products p ON o.product_id = p.id
          WHERE o.id = ?
        `).get(order.id);
        if (details) {
          sendDiscordNotification({
            eventType: session.subscription ? 'subscription_started' : 'payment_completed',
            steamName: details.persona,
            steamId: details.steam_id,
            biUid: details.bi_uid,
            productTitle: details.product_title,
            amountCents: details.amount_cents,
            currency: details.currency,
            status: 'completed'
          });
        }

        syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
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
        steamName: req.user.persona,
        steamId: req.user.steam_id,
        biUid: req.user.bi_uid,
        productTitle: order.product_title,
        amountCents: order.amount_cents,
        currency: order.currency,
        status: 'cancelled'
      });

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
  res.json(products);
});

// Get all orders (admin view with steam names + BI UIDs)
router.get('/api/shop/admin/orders', requireAdmin, (req, res) => {
  const orders = db.prepare(`
    SELECT o.id, o.status, o.amount_cents, o.created_at, o.completed_at,
           o.stripe_session_id, o.stripe_subscription_id,
           o.steam_id, u.persona, u.avatar_url, u.bi_uid,
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
  res.json({ ok: true });
});

// Create product
router.post('/api/shop/admin/products', requireAdmin, (req, res) => {
  const { title, description, priceCents, type, imageUrl } = req.body;

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return res.status(400).json({ error: 'Title is required' });
  }
  if (!priceCents || typeof priceCents !== 'number' || priceCents < 1) {
    return res.status(400).json({ error: 'Price must be a positive number (in cents)' });
  }
  if (!type || !['one_time', 'subscription'].includes(type)) {
    return res.status(400).json({ error: 'Type must be one_time or subscription' });
  }

  const result = db.prepare(`
    INSERT INTO products (title, description, price_cents, type, image_url)
    VALUES (?, ?, ?, ?, ?)
  `).run(title.trim(), (description || '').trim(), priceCents, type, imageUrl || null);

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
  res.json(product);
});

// Update product
router.put('/api/shop/admin/products/:id', requireAdmin, (req, res) => {
  const { title, description, priceCents, imageUrl, active } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  db.prepare(`
    UPDATE products SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      price_cents = COALESCE(?, price_cents),
      image_url = COALESCE(?, image_url),
      active = COALESCE(?, active),
      updated_at = unixepoch()
    WHERE id = ?
  `).run(
    title !== undefined ? title.trim() : null,
    description !== undefined ? description.trim() : null,
    priceCents !== undefined ? priceCents : null,
    imageUrl !== undefined ? imageUrl : null,
    active !== undefined ? (active ? 1 : 0) : null,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json(updated);
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
    return res.status(400).json({ error: `Cannot delete — ${orderCount} order(s) reference this product. Deactivate it instead.` });
  }

  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Revoke an order (admin only — does NOT issue Stripe refund)
router.post('/api/shop/admin/revoke', requireAdmin, async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

  const order = db.prepare(`
    SELECT o.*, u.persona, u.bi_uid, p.title as product_title, p.type, p.currency
    FROM orders o JOIN users u ON o.steam_id = u.steam_id JOIN products p ON o.product_id = p.id
    WHERE o.id = ? AND o.status = 'completed'
  `).get(orderId);

  if (!order) return res.status(404).json({ error: 'Completed order not found' });

  // If subscription, cancel it immediately in Stripe
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
    steamName: order.persona,
    steamId: order.steam_id,
    biUid: order.bi_uid,
    productTitle: order.product_title,
    amountCents: order.amount_cents,
    currency: order.currency,
    status: 'refunded'
  });

  syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));

  res.json({ ok: true });
});

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
          SELECT o.*, u.persona, u.bi_uid, p.title as product_title, p.type, p.currency
          FROM orders o JOIN users u ON o.steam_id = u.steam_id JOIN products p ON o.product_id = p.id
          WHERE o.id = ?
        `).get(orderId);
        if (order) {
          sendDiscordNotification({
            eventType: session.subscription ? 'subscription_started' : 'payment_completed',
            steamName: order.persona,
            steamId: order.steam_id,
            biUid: order.bi_uid,
            productTitle: order.product_title,
            amountCents: order.amount_cents,
            currency: order.currency,
            status: 'completed'
          });
        }
        syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
      }
      break;
    }

    case 'checkout.session.expired': {
      const session = event.data.object;
      const orderId = session.metadata && session.metadata.order_id;
      if (orderId) {
        db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(orderId);

        const order = db.prepare(`
          SELECT o.*, u.persona, u.bi_uid, p.title as product_title, p.currency
          FROM orders o JOIN users u ON o.steam_id = u.steam_id JOIN products p ON o.product_id = p.id
          WHERE o.id = ?
        `).get(orderId);
        if (order) {
          sendDiscordNotification({
            eventType: 'payment_failed',
            steamName: order.persona,
            steamId: order.steam_id,
            biUid: order.bi_uid,
            productTitle: order.product_title,
            amountCents: order.amount_cents,
            currency: order.currency,
            status: 'failed'
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
          db.prepare(`
            INSERT INTO orders (steam_id, product_id, stripe_subscription_id, status, amount_cents, completed_at)
            VALUES (?, ?, ?, 'completed', ?, unixepoch())
          `).run(existing.steam_id, existing.product_id, subId, invoice.amount_paid);

          const user = db.prepare('SELECT persona, bi_uid FROM users WHERE steam_id = ?').get(existing.steam_id);
          const product = db.prepare('SELECT title, currency FROM products WHERE id = ?').get(existing.product_id);
          sendDiscordNotification({
            eventType: 'subscription_renewed',
            steamName: user ? user.persona : existing.steam_id,
            steamId: existing.steam_id,
            biUid: user ? user.bi_uid : null,
            productTitle: product ? product.title : 'Unknown',
            amountCents: invoice.amount_paid,
            currency: product ? product.currency : 'usd',
            status: 'completed'
          });
        }
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const existing = db.prepare(`
        SELECT o.steam_id, o.amount_cents, u.persona, u.bi_uid, p.title as product_title, p.currency
        FROM orders o JOIN users u ON o.steam_id = u.steam_id JOIN products p ON o.product_id = p.id
        WHERE o.stripe_subscription_id = ? AND o.status = 'completed' LIMIT 1
      `).get(sub.id);

      db.prepare(`
        UPDATE orders SET status = 'cancelled' WHERE stripe_subscription_id = ? AND status = 'completed'
      `).run(sub.id);

      if (existing) {
        sendDiscordNotification({
          eventType: 'subscription_cancelled',
          steamName: existing.persona,
          steamId: existing.steam_id,
          biUid: existing.bi_uid,
          productTitle: existing.product_title,
          amountCents: existing.amount_cents,
          currency: existing.currency,
          status: 'cancelled'
        });
      }
      syncPurchasesToServers().catch(e => console.error('[sync] Error:', e.message));
      break;
    }
  }

  res.sendStatus(200);
}

module.exports = { router, webhookHandler };

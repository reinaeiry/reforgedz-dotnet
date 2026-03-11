const express = require('express');
const router = express.Router();
const db = require('../db');

// ---- Stripe setup ----
const Stripe = require('stripe');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function getStripe(testMode) {
  const key = testMode ? process.env.STRIPE_TEST_SECRET_KEY : process.env.STRIPE_SECRET_KEY;
  return new Stripe(key);
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
    success_url: BASE_URL + '/shop?success=1',
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
    SELECT o.id, o.status, o.amount_cents, o.created_at, o.completed_at,
           o.stripe_subscription_id, p.title, p.type, p.currency
    FROM orders o JOIN products p ON o.product_id = p.id
    WHERE o.steam_id = ? ORDER BY o.created_at DESC
  `).all(req.user.steam_id);
  res.json(orders);
});

// Cancel a subscription
router.post('/api/shop/cancel-subscription', requireAuth, (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

  const order = db.prepare(`
    SELECT o.*, p.type FROM orders o JOIN products p ON o.product_id = p.id
    WHERE o.id = ? AND o.steam_id = ? AND o.status = 'completed' AND o.stripe_subscription_id IS NOT NULL
  `).get(orderId, req.user.steam_id);

  if (!order) return res.status(404).json({ error: 'Active subscription not found' });

  // Determine if this was a test mode subscription by checking if the sub ID starts with sub_
  // We cancel at period end so user keeps access until billing cycle ends
  const stripe = getStripe(false);
  const stripeTest = getStripe(true);

  // Try live first, then test
  stripe.subscriptions.update(order.stripe_subscription_id, { cancel_at_period_end: true })
    .catch(() => stripeTest.subscriptions.update(order.stripe_subscription_id, { cancel_at_period_end: true }))
    .then(() => {
      db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
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

// Soft-delete product
router.delete('/api/shop/admin/products/:id', requireAdmin, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  db.prepare('UPDATE products SET active = 0, updated_at = unixepoch() WHERE id = ?').run(req.params.id);
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
      }
      break;
    }

    case 'checkout.session.expired': {
      const session = event.data.object;
      const orderId = session.metadata && session.metadata.order_id;
      if (orderId) {
        db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(orderId);
      }
      break;
    }

    case 'invoice.paid': {
      const invoice = event.data.object;
      const subId = invoice.subscription;
      if (subId) {
        // Mark subscription renewals
        const existing = db.prepare('SELECT * FROM orders WHERE stripe_subscription_id = ? AND status = ?').get(subId, 'completed');
        if (existing) {
          db.prepare(`
            INSERT INTO orders (steam_id, product_id, stripe_subscription_id, status, amount_cents, completed_at)
            VALUES (?, ?, ?, 'completed', ?, unixepoch())
          `).run(existing.steam_id, existing.product_id, subId, invoice.amount_paid);
        }
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      db.prepare(`
        UPDATE orders SET status = 'cancelled' WHERE stripe_subscription_id = ? AND status = 'completed'
      `).run(sub.id);
      break;
    }
  }

  res.sendStatus(200);
}

module.exports = { router, webhookHandler };

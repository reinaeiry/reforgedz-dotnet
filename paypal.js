// PayPal REST client (Orders v2 + payments + reporting + webhooks).
// Replaces the Stripe integration. testMode === true uses the sandbox
// credentials + sandbox API host; otherwise live.
//
// Env:
//   PAYPAL_CLIENT_ID / PAYPAL_SECRET            — live app credentials
//   PAYPAL_TEST_CLIENT_ID / PAYPAL_TEST_SECRET  — sandbox app credentials
//   PAYPAL_WEBHOOK_ID / PAYPAL_TEST_WEBHOOK_ID  — set by ensureWebhook() on boot
//   BASE_URL                                    — public origin for webhook URL

const LIVE_BASE = 'https://api-m.paypal.com';
const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

function apiBase(testMode) { return testMode ? SANDBOX_BASE : LIVE_BASE; }

function creds(testMode) {
  if (testMode) {
    return { id: process.env.PAYPAL_TEST_CLIENT_ID || '', secret: process.env.PAYPAL_TEST_SECRET || '' };
  }
  return { id: process.env.PAYPAL_CLIENT_ID || '', secret: process.env.PAYPAL_SECRET || '' };
}

function isConfigured(testMode) {
  const c = creds(testMode);
  return !!(c.id && c.secret);
}

// ─── OAuth token cache (per environment) ────────────────────────────────────
const tokenCache = { live: null, sandbox: null };

async function getAccessToken(testMode) {
  const envKey = testMode ? 'sandbox' : 'live';
  const cached = tokenCache[envKey];
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const c = creds(testMode);
  if (!c.id || !c.secret) throw new Error(`PayPal ${envKey} credentials not configured`);
  const auth = Buffer.from(`${c.id}:${c.secret}`).toString('base64');
  const res = await fetch(`${apiBase(testMode)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`PayPal token ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  tokenCache[envKey] = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3000) * 1000
  };
  return data.access_token;
}

async function ppFetch(testMode, path, { method = 'GET', body, headers } = {}) {
  const token = await getAccessToken(testMode);
  const res = await fetch(`${apiBase(testMode)}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(headers || {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  if (!res.ok) {
    const detail = json?.message || json?.details?.[0]?.description || text.slice(0, 200);
    const err = new Error(`paypal ${res.status}: ${detail}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ─── Orders v2 ──────────────────────────────────────────────────────────────

// Create a one-time CAPTURE order. amountCents in the smallest currency unit.
// Returns { id, approveUrl }.
async function createOrder(testMode, { amountCents, currency = 'USD', description, customId, brandName, returnUrl, cancelUrl }) {
  const value = (amountCents / 100).toFixed(2);
  const order = await ppFetch(testMode, '/v2/checkout/orders', {
    method: 'POST',
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        custom_id: customId ? String(customId) : undefined,
        description: description ? String(description).slice(0, 127) : undefined,
        amount: {
          currency_code: String(currency).toUpperCase(),
          value
        }
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: brandName || 'ReforgedZ',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: returnUrl,
            cancel_url: cancelUrl
          }
        }
      }
    }
  });
  const approve = (order.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  return { id: order.id, approveUrl: approve ? approve.href : null, raw: order };
}

async function getOrder(testMode, orderId) {
  return ppFetch(testMode, `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

// Capture an approved order. Returns { captureId, status, payerEmail, grossCents,
// feeCents, netCents, currency }.
async function captureOrder(testMode, orderId) {
  const res = await ppFetch(testMode, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST' });
  return normalizeCapture(res);
}

function normalizeCapture(orderRes) {
  const pu = orderRes?.purchase_units?.[0] || {};
  const cap = pu?.payments?.captures?.[0] || {};
  const breakdown = cap?.seller_receivable_breakdown || {};
  const gross = breakdown.gross_amount || cap.amount || {};
  const fee = breakdown.paypal_fee || {};
  const net = breakdown.net_amount || {};
  const toCents = (m) => m && m.value != null ? Math.round(parseFloat(m.value) * 100) : 0;
  return {
    orderId: orderRes.id,
    captureId: cap.id || null,
    status: cap.status || orderRes.status || null,
    payerEmail: orderRes?.payer?.email_address || orderRes?.payment_source?.paypal?.email_address || null,
    payerName: [orderRes?.payer?.name?.given_name, orderRes?.payer?.name?.surname].filter(Boolean).join(' ') || null,
    customId: cap.custom_id || pu.custom_id || null,
    grossCents: toCents(gross),
    feeCents: toCents(fee),
    netCents: toCents(net),
    currency: (gross.currency_code || 'USD')
  };
}

// ─── Refunds ─────────────────────────────────────────────────────────────────
// Full refund of a capture. amountCents optional (partial). Returns refunded cents.
async function refundCapture(testMode, captureId, { amountCents, currency = 'USD' } = {}) {
  const body = {};
  if (amountCents != null) {
    body.amount = { value: (amountCents / 100).toFixed(2), currency_code: String(currency).toUpperCase() };
  }
  const res = await ppFetch(testMode, `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    method: 'POST',
    body: Object.keys(body).length ? body : undefined
  });
  const amt = res?.amount?.value != null ? Math.round(parseFloat(res.amount.value) * 100) : (amountCents || 0);
  return { refundId: res.id, refundedCents: amt, status: res.status };
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

// Verify an incoming webhook against PayPal. headers = req.headers, rawBody is
// the parsed JSON object of the event.
async function verifyWebhook(testMode, headers, eventBody, webhookId) {
  if (!webhookId) return false;
  try {
    const res = await ppFetch(testMode, '/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: {
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: webhookId,
        webhook_event: eventBody
      }
    });
    return res?.verification_status === 'SUCCESS';
  } catch (e) {
    console.error('[paypal] webhook verify failed:', e.message);
    return false;
  }
}

// Ensure a webhook exists for our URL listening to the events we care about.
// Returns the webhook id. Idempotent: reuses an existing webhook on the same URL.
const WEBHOOK_EVENTS = [
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  'CHECKOUT.ORDER.APPROVED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.COMPLETED'
];

async function syncWebhookEvents(testMode, webhookId, desired) {
  if (!webhookId) return;
  try {
    const cur = await ppFetch(testMode, `/v1/notifications/webhooks/${webhookId}`);
    const have = new Set((cur?.event_types || []).map((e) => e.name));
    const want = desired.filter((n) => !have.has(n));
    if (!want.length) return;
    await ppFetch(testMode, `/v1/notifications/webhooks/${webhookId}`, {
      method: 'PATCH',
      body: [{
        op: 'replace',
        path: '/event_types',
        value: desired.map((name) => ({ name }))
      }]
    });
  } catch (e) {
    console.error(`[paypal] syncWebhookEvents (${testMode ? 'sandbox' : 'live'}) failed:`, e.message);
  }
}

async function ensureWebhook(testMode, url) {
  if (!isConfigured(testMode)) return null;
  const list = await ppFetch(testMode, '/v1/notifications/webhooks').catch(() => null);
  const existing = (list?.webhooks || []).find((w) => w.url === url);
  if (existing) {
    // Ensure any newly-added event types are subscribed on the existing hook.
    await syncWebhookEvents(testMode, existing.id, WEBHOOK_EVENTS);
    return existing.id;
  }
  try {
    const created = await ppFetch(testMode, '/v1/notifications/webhooks', {
      method: 'POST',
      body: {
        url,
        event_types: WEBHOOK_EVENTS.map((name) => ({ name }))
      }
    });
    return created.id;
  } catch (e) {
    // 400 "webhook url already exists" — relist and match.
    const relist = await ppFetch(testMode, '/v1/notifications/webhooks').catch(() => null);
    const match = (relist?.webhooks || []).find((w) => w.url === url);
    if (match) {
      await syncWebhookEvents(testMode, match.id, WEBHOOK_EVENTS);
      return match.id;
    }
    console.error(`[paypal] ensureWebhook (${testMode ? 'sandbox' : 'live'}) failed:`, e.message);
    return null;
  }
}

// ─── Reporting (finances) ────────────────────────────────────────────────────

async function getBalance(testMode) {
  // /v1/reporting/balances — requires the "Transaction Search" / reporting
  // feature on the app. Falls back gracefully.
  try {
    const res = await ppFetch(testMode, '/v1/reporting/balances?currency_code=USD');
    return { mode: testMode ? 'sandbox' : 'live', raw: res, balances: res?.balances || [] };
  } catch (e) {
    return { mode: testMode ? 'sandbox' : 'live', error: e.message, balances: [] };
  }
}

// Transaction Search — last `days` of completed transactions. PayPal caps the
// window at 31 days per call and has a ~3h reporting delay.
async function listTransactions(testMode, { days = 31 } = {}) {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - Math.min(days, 31) * 86400_000);
    const fmt = (d) => d.toISOString().replace(/\.\d+Z$/, '-0000');
    const qs = new URLSearchParams({
      start_date: fmt(start),
      end_date: fmt(end),
      fields: 'transaction_info,payer_info',
      page_size: '100'
    });
    const res = await ppFetch(testMode, `/v1/reporting/transactions?${qs}`);
    return (res?.transaction_details || []).map((t) => {
      const info = t.transaction_info || {};
      const amt = info.transaction_amount || {};
      const fee = info.fee_amount || {};
      return {
        id: info.transaction_id,
        date: info.transaction_initiation_date,
        status: info.transaction_status,
        grossCents: amt.value != null ? Math.round(parseFloat(amt.value) * 100) : 0,
        feeCents: fee.value != null ? Math.round(parseFloat(fee.value) * 100) : 0,
        currency: amt.currency_code || 'USD',
        payerEmail: t.payer_info?.email_address || null,
        subject: info.transaction_subject || null
      };
    });
  } catch (e) {
    return { error: e.message, transactions: [] };
  }
}

// ─── Subscriptions (Billing Plans v1) ───────────────────────────────────────

// Normalize a price + billing-cycle frequency to a monthly amount in cents.
function cycleToMonthlyCents(priceValue, freq) {
  if (priceValue == null || !freq) return 0;
  const price = Math.round(parseFloat(priceValue) * 100);
  if (!isFinite(price) || price <= 0) return 0;
  const n = Math.max(1, parseInt(freq.interval_count || 1, 10));
  switch ((freq.interval_unit || '').toUpperCase()) {
    case 'DAY':   return Math.round((price * 30) / n);
    case 'WEEK':  return Math.round((price * 30) / (7 * n));
    case 'MONTH': return Math.round(price / n);
    case 'YEAR':  return Math.round(price / (12 * n));
    default:      return 0;
  }
}

// Pick the REGULAR (non-trial) billing cycle from a plan detail response.
function planRegularCycle(plan) {
  const cycles = plan?.billing_cycles || [];
  return cycles.find(c => (c.tenure_type || '').toUpperCase() === 'REGULAR') || cycles[0] || null;
}

async function listActivePlans(testMode) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const qs = new URLSearchParams({
      page: String(page), page_size: '20', total_required: 'true'
    });
    const res = await ppFetch(testMode, `/v1/billing/plans?${qs}`);
    const plans = res?.plans || [];
    for (const p of plans) {
      if ((p.status || '').toUpperCase() === 'ACTIVE') out.push({ id: p.id, name: p.name });
    }
    if (plans.length < 20) break;
  }
  return out;
}

async function listSubscriptionsForPlan(testMode, planId) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const qs = new URLSearchParams({
      plan_id: planId, page: String(page), page_size: '20', total_required: 'true'
    });
    const res = await ppFetch(testMode, `/v1/billing/subscriptions?${qs}`);
    const subs = res?.subscriptions || [];
    for (const s of subs) out.push(s);
    if (subs.length < 20) break;
  }
  return out;
}

// Returns a flat list of ACTIVE subscriptions with each one's normalized
// monthly amount in cents. { id, planId, payerEmail, status, monthlyCents,
// currency }. Returns { error } on failure (never throws) so callers can
// fall through to zero gracefully.
async function listActiveSubscriptions(testMode) {
  try {
    const plans = await listActivePlans(testMode);
    const out = [];
    for (const planRef of plans) {
      const plan = await ppFetch(testMode, `/v1/billing/plans/${planRef.id}`);
      const cycle = planRegularCycle(plan);
      if (!cycle) continue;
      const planPriceValue = cycle.pricing_scheme?.fixed_price?.value;
      const planCurrency = cycle.pricing_scheme?.fixed_price?.currency_code || 'USD';
      const subs = await listSubscriptionsForPlan(testMode, planRef.id);
      for (const s of subs) {
        if ((s.status || '').toUpperCase() !== 'ACTIVE') continue;
        const lastAmt = s.billing_info?.last_payment?.amount?.value;
        const monthlyCents = cycleToMonthlyCents(lastAmt != null ? lastAmt : planPriceValue, cycle.frequency);
        out.push({
          id: s.id,
          planId: planRef.id,
          planName: planRef.name || plan.name || null,
          payerEmail: s.subscriber?.email_address || null,
          status: s.status,
          monthlyCents,
          currency: s.billing_info?.last_payment?.amount?.currency_code || planCurrency
        });
      }
    }
    return { subscriptions: out };
  } catch (e) {
    return { error: e.message, subscriptions: [] };
  }
}

// ─── Catalog Products + Plans + Subscriptions (create/manage) ───────────────

// Create a PayPal Catalog Product. Returns its id. Used as the parent for a
// Billing Plan. Idempotent per call (callers cache the resulting id).
async function createCatalogProduct(testMode, { name, description, category = 'SOFTWARE' }) {
  // Catalog product allows up to 256 chars on description and 127 on name.
  const prodName = String(name || '').slice(0, 127);
  const prodDesc = String(description || name || '').replace(/\s+/g, ' ').slice(0, 256);
  const res = await ppFetch(testMode, '/v1/catalogs/products', {
    method: 'POST',
    headers: { 'PayPal-Request-Id': `rfgz-prod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    body: {
      name: prodName,
      description: prodDesc,
      type: 'SERVICE',
      category
    }
  });
  return res.id;
}

// Create a monthly REGULAR-tenure Billing Plan against a catalog product.
// Returns the plan id, ready to attach subscriptions to.
async function createPlan(testMode, {
  catalogProductId, name, description, priceCents, currency = 'USD',
  intervalUnit = 'MONTH', intervalCount = 1
}) {
  // PayPal caps plan name at 127 and description at 127 chars. Catalog product
  // description allows more but plan does not. Truncate aggressively.
  const planName = String(name || '').slice(0, 127);
  const planDesc = String(description || name || '').replace(/\s+/g, ' ').slice(0, 127);
  const body = {
    product_id: catalogProductId,
    name: planName,
    description: planDesc,
    billing_cycles: [{
      frequency: { interval_unit: intervalUnit, interval_count: intervalCount },
      tenure_type: 'REGULAR',
      sequence: 1,
      total_cycles: 0, // bill forever until cancelled
      pricing_scheme: {
        fixed_price: { value: (priceCents / 100).toFixed(2), currency_code: currency.toUpperCase() }
      }
    }],
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee: { value: '0', currency_code: currency.toUpperCase() },
      setup_fee_failure_action: 'CONTINUE',
      payment_failure_threshold: 3
    }
  };
  const res = await ppFetch(testMode, '/v1/billing/plans', {
    method: 'POST',
    headers: {
      'PayPal-Request-Id': `rfgz-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      'Prefer': 'return=representation'
    },
    body
  });
  // Plans are created in CREATED state. Activate so subscriptions can attach.
  if ((res.status || '').toUpperCase() !== 'ACTIVE') {
    await ppFetch(testMode, `/v1/billing/plans/${res.id}/activate`, { method: 'POST' });
  }
  return res.id;
}

// Create a Subscription against an existing plan. Returns { id, approveUrl }.
// `customId` is echoed back on every billing event so we can map cycles to
// our orders.
async function createSubscription(testMode, {
  planId, customId, brandName = 'ReforgedZ', returnUrl, cancelUrl
}) {
  const body = {
    plan_id: planId,
    custom_id: customId != null ? String(customId) : undefined,
    application_context: {
      brand_name: brandName,
      shipping_preference: 'NO_SHIPPING',
      user_action: 'SUBSCRIBE_NOW',
      payment_method: { payer_selected: 'PAYPAL', payee_preferred: 'IMMEDIATE_PAYMENT_REQUIRED' },
      return_url: returnUrl,
      cancel_url: cancelUrl
    }
  };
  const res = await ppFetch(testMode, '/v1/billing/subscriptions', { method: 'POST', body });
  const approveUrl = (res.links || []).find(l => l.rel === 'approve')?.href || null;
  return { id: res.id, approveUrl, status: res.status };
}

async function getSubscription(testMode, subscriptionId) {
  return ppFetch(testMode, `/v1/billing/subscriptions/${subscriptionId}`);
}

async function cancelSubscription(testMode, subscriptionId, reason = 'Cancelled by user') {
  await ppFetch(testMode, `/v1/billing/subscriptions/${subscriptionId}/cancel`, {
    method: 'POST',
    body: { reason }
  });
  return { ok: true };
}

module.exports = {
  isConfigured,
  createOrder,
  getOrder,
  captureOrder,
  normalizeCapture,
  refundCapture,
  verifyWebhook,
  ensureWebhook,
  getBalance,
  listTransactions,
  listActiveSubscriptions,
  createCatalogProduct,
  createPlan,
  createSubscription,
  getSubscription,
  cancelSubscription
};

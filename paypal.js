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
  'CHECKOUT.ORDER.APPROVED'
];

async function ensureWebhook(testMode, url) {
  if (!isConfigured(testMode)) return null;
  const list = await ppFetch(testMode, '/v1/notifications/webhooks').catch(() => null);
  const existing = (list?.webhooks || []).find((w) => w.url === url);
  if (existing) return existing.id;
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
    if (match) return match.id;
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
    const bal = res?.balances?.[0] || (res?.balances && res.balances) || null;
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
  listTransactions
};

// Invoice emails sent from billing@reforgedz.net via the mailcow SMTP
// server on the EU box. Mirrors the nodemailer pattern in reforgedz-auth.
//
// Env:
//   SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS
//   INVOICE_FROM   e.g. "ReforgedZ Billing <billing@reforgedz.net>"
//   BASE_URL       for links back to the shop

const nodemailer = require('nodemailer');

// Shown in the Custom Flag confirmation email whenever CUSTOM_FLAG_TUTORIAL_URL
// isn't set — never hardcode a real link here.
const YOUTUBE_PLACEHOLDER = '[YOUTUBE_TUTORIAL_LINK_HERE]';

let transporter = null;
function getTransport() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined
  });
  return transporter;
}

function fromAddress() {
  return process.env.INVOICE_FROM || 'ReforgedZ Billing <billing@reforgedz.net>';
}

function money(cents, currency) {
  return `${(cents / 100).toFixed(2)} ${String(currency || 'USD').toUpperCase()}`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Build + send the invoice. Returns { ok, skipped?, error? }. Never throws.
async function sendInvoice({ to, orderId, captureId, productTitle, amountCents, currency, feeCents, serverLabel, buyerName, dateMs }) {
  const tx = getTransport();
  if (!tx) return { ok: false, skipped: 'smtp_not_configured' };
  if (!to) return { ok: false, skipped: 'no_recipient' };

  const base = (process.env.BASE_URL || 'https://reforgedz.net').replace(/\/+$/, '');
  const dateStr = new Date(dateMs || Date.now()).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'long', timeStyle: 'short' }) + ' UTC';
  const invoiceNo = `RFGZ-${String(orderId).padStart(6, '0')}`;
  const itemName = productTitle || 'Purchase';
  const amount = money(amountCents, currency);
  const billedTo = buyerName ? `${buyerName} (${to})` : to;

  // Real-invoice layout: dark brand header band, light invoice body, a
  // line-item table, a bold total, a PAID stamp, and a contact footer.
  // Table-based + inline styles for email-client compatibility.
  const lineItem = `
    <tr>
      <td style="padding:14px 24px;border-bottom:1px solid #ecedf0;font-size:14px;color:#1a1a1a">
        <div style="font-weight:600">${esc(itemName)}</div>
        ${serverLabel ? `<div style="color:#6b7280;font-size:12px;margin-top:2px">Server: ${esc(serverLabel)}</div>` : ''}
      </td><!--li-->
      <td style="padding:14px 24px;border-bottom:1px solid #ecedf0;font-size:14px;color:#1a1a1a;text-align:right;white-space:nowrap">${esc(amount)}</td>
    </tr>`;

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">

        <!-- Brand header -->
        <tr><td style="background:#0d0f12;padding:28px 24px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:.5px">ReforgedZ</td>
              <td style="text-align:right">
                <div style="font-size:18px;font-weight:600;color:#ffffff;letter-spacing:2px">RECEIPT</div>
                <div style="font-size:12px;color:#9aa0a6;margin-top:2px">${esc(invoiceNo)}</div>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Meta -->
        <tr><td style="padding:24px 24px 8px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#374151">
            <tr>
              <td style="vertical-align:top;width:50%">
                <div style="color:#9ca3af;text-transform:uppercase;font-size:11px;letter-spacing:1px;margin-bottom:4px">Billed to</div>
                <div style="font-weight:600;color:#1a1a1a">${esc(billedTo)}</div>
              </td>
              <td style="vertical-align:top;text-align:right">
                <div style="color:#9ca3af;text-transform:uppercase;font-size:11px;letter-spacing:1px;margin-bottom:4px">Date issued</div>
                <div style="color:#1a1a1a">${esc(dateStr)}</div>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Status -->
        <tr><td style="padding:8px 24px 16px">
          <span style="display:inline-block;background:#dcfce7;color:#15803d;font-size:12px;font-weight:700;letter-spacing:1px;padding:4px 12px;border-radius:999px">PAID</span>
          <span style="color:#6b7280;font-size:12px;margin-left:8px">Payment method: PayPal</span>
        </td></tr>

        <!-- Line items -->
        <tr><td style="padding:0 0 4px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:10px 24px;background:#f9fafb;border-top:1px solid #ecedf0;border-bottom:1px solid #ecedf0;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#9ca3af">Description</td>
              <td style="padding:10px 24px;background:#f9fafb;border-top:1px solid #ecedf0;border-bottom:1px solid #ecedf0;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#9ca3af;text-align:right">Amount</td>
            </tr>
            ${lineItem}
            <tr>
              <td style="padding:16px 24px;font-size:15px;font-weight:700;color:#1a1a1a">Total paid</td>
              <td style="padding:16px 24px;font-size:18px;font-weight:700;color:#0d0f12;text-align:right;white-space:nowrap">${esc(amount)}</td>
            </tr>
          </table>
        </td></tr>

        ${captureId ? `<tr><td style="padding:0 24px 16px">
          <div style="font-size:11px;color:#9ca3af">PayPal transaction ID: <span style="color:#6b7280">${esc(captureId)}</span></div>
        </td></tr>` : ''}

        <!-- Note -->
        <tr><td style="padding:8px 24px 24px">
          <div style="font-size:13px;color:#4b5563;line-height:1.5;border-top:1px solid #ecedf0;padding-top:16px">
            Your purchase is applied to the server automatically. If you set your in-game UID after buying, it syncs within a few minutes.
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:20px 24px;border-top:1px solid #ecedf0">
          <div style="font-size:12px;color:#6b7280;line-height:1.6">
            Questions about this receipt? Email <a href="mailto:contact@reforgedz.net" style="color:#2563eb;text-decoration:none">contact@reforgedz.net</a> or open a ticket in our Discord.<br>
            ReforgedZ &middot; <a href="${base}/shop" style="color:#2563eb;text-decoration:none">reforgedz.net/shop</a>
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    'ReforgedZ - Payment Receipt',
    '',
    `Receipt: ${invoiceNo}`,
    `Date issued: ${dateStr}`,
    `Billed to: ${billedTo}`,
    'Status: PAID (PayPal)',
    '',
    `Item: ${itemName}`,
    serverLabel ? `Server: ${serverLabel}` : null,
    `Total paid: ${amount}`,
    captureId ? `PayPal transaction ID: ${captureId}` : null,
    '',
    'Your purchase is applied to the server automatically. If you set your',
    'in-game UID after buying, it syncs within a few minutes.',
    '',
    'Questions about this receipt? Email contact@reforgedz.net or open a',
    'ticket in our Discord.',
    `${base}/shop`
  ].filter((l) => l !== null).join('\n');

  try {
    await tx.sendMail({
      from: fromAddress(),
      to,
      replyTo: 'contact@reforgedz.net',
      subject: `ReforgedZ receipt ${invoiceNo} - ${itemName}`,
      text,
      html
    });
    return { ok: true };
  } catch (e) {
    console.error('[invoiceMail] send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// One-shot invite asking an existing one-time buyer to switch their purchase
// over to a real auto-renewing subscription. Sent during the bulk migration
// run after subscription products were rewired to PayPal Subscriptions API.
// `deepLink` is a URL on our shop that takes them straight to the Subscribe
// flow for the same product (no log-in friction beyond the usual Steam SSO).
async function sendSubscriptionInvite({ to, displayName, productTitle, priceCents, currency, deepLink }) {
  const tx = getTransport();
  if (!tx) return { ok: false, skipped: 'smtp_not_configured' };
  if (!to) return { ok: false, skipped: 'no_recipient' };

  const base = (process.env.BASE_URL || 'https://reforgedz.net').replace(/\/+$/, '');
  const price = money(priceCents, currency);
  const item = productTitle || 'your purchase';
  const name = displayName || 'there';

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
        <tr><td style="background:#0d0f12;padding:24px;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.5px">ReforgedZ</td></tr>
        <tr><td style="padding:28px 24px;font-size:15px;color:#1a1a1a;line-height:1.55">
          <p style="margin:0 0 12px">Hey ${esc(name)},</p>
          <p style="margin:0 0 12px">${esc(item)} is set up as a recurring monthly product, but your most recent purchase went through our one-time checkout (a quirk of our PayPal cutover). That means it won't auto-renew when the cycle ends and you'd have to buy it again.</p>
          <p style="margin:0 0 12px">Switch your purchase to auto-renew so you never lose your spot. Same price, ${esc(price)}/month, cancel anytime from your PayPal account.</p>
          <p style="margin:24px 0">
            <a href="${esc(deepLink)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600">Set up auto-renew</a>
          </p>
          <p style="margin:0 0 12px;color:#4b5563;font-size:13px">No charge happens until you confirm the subscription on PayPal's page. Your existing one-time purchase stays active through its current cycle.</p>
        </td></tr>
        <tr><td style="background:#f9fafb;padding:16px 24px;border-top:1px solid #ecedf0;font-size:12px;color:#6b7280">
          Questions? <a href="mailto:contact@reforgedz.net" style="color:#2563eb;text-decoration:none">contact@reforgedz.net</a> &middot; <a href="${base}/shop" style="color:#2563eb;text-decoration:none">reforgedz.net/shop</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Hey ${name},`,
    '',
    `${item} is set up as a monthly recurring product, but your most recent`,
    `purchase went through our one-time checkout. It won't auto-renew when`,
    `the cycle ends and you'd have to buy it again.`,
    '',
    `Set up auto-renew here so you never lose your spot:`,
    deepLink,
    '',
    `Same price, ${price}/month. Cancel anytime from your PayPal account.`,
    `No charge happens until you confirm on PayPal. Your existing one-time`,
    `purchase stays active through its current cycle.`,
    '',
    'Questions? contact@reforgedz.net',
    `${base}/shop`
  ].join('\n');

  try {
    await tx.sendMail({
      from: fromAddress(),
      to,
      replyTo: 'contact@reforgedz.net',
      subject: `Switch your ${item} to auto-renew`,
      text,
      html
    });
    return { ok: true };
  } catch (e) {
    console.error('[invoiceMail] sub invite send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Confirmation that an auto-renewing subscription was cancelled. The buyer
// keeps their entitlement through the end of the current paid cycle — the
// email surfaces that end date so they don't think they lost access.
async function sendSubscriptionCancelled({ to, displayName, productTitle, accessEndsAtMs, priceCents, currency }) {
  const tx = getTransport();
  if (!tx) return { ok: false, skipped: 'smtp_not_configured' };
  if (!to) return { ok: false, skipped: 'no_recipient' };

  const base = (process.env.BASE_URL || 'https://reforgedz.net').replace(/\/+$/, '');
  const item = productTitle || 'your subscription';
  const name = displayName || 'there';
  const endsStr = accessEndsAtMs
    ? new Date(accessEndsAtMs).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'long', timeStyle: 'short' }) + ' UTC'
    : 'the end of your current paid period';
  const priceLine = priceCents ? ` (${money(priceCents, currency)}/month)` : '';

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
        <tr><td style="background:#0d0f12;padding:24px;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.5px">ReforgedZ</td></tr>
        <tr><td style="padding:28px 24px;font-size:15px;color:#1a1a1a;line-height:1.55">
          <p style="margin:0 0 12px">Hi ${esc(name)},</p>
          <p style="margin:0 0 12px">Your <strong>${esc(item)}</strong>${esc(priceLine)} subscription has been cancelled. You won't be charged again.</p>
          <p style="margin:0 0 12px">You keep your access through <strong>${esc(endsStr)}</strong> — that's the end of the period you already paid for.</p>
          <p style="margin:24px 0">
            <a href="${esc(base)}/shop" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600">Re-subscribe anytime</a>
          </p>
          <p style="margin:0 0 12px;color:#4b5563;font-size:13px">Changed your mind, or cancelled by accident? Email <a href="mailto:contact@reforgedz.net" style="color:#2563eb;text-decoration:none">contact@reforgedz.net</a> and we'll sort it.</p>
        </td></tr>
        <tr><td style="background:#f9fafb;padding:16px 24px;border-top:1px solid #ecedf0;font-size:12px;color:#6b7280">
          ReforgedZ &middot; <a href="${esc(base)}/shop" style="color:#2563eb;text-decoration:none">reforgedz.net/shop</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Hi ${name},`,
    '',
    `Your ${item}${priceLine} subscription has been cancelled. You won't be`,
    'charged again.',
    '',
    `You keep your access through ${endsStr} — that's the end of the period`,
    'you already paid for.',
    '',
    `Re-subscribe anytime: ${base}/shop`,
    '',
    'Changed your mind, or cancelled by accident? Email contact@reforgedz.net',
    'and we\'ll sort it.'
  ].join('\n');

  try {
    await tx.sendMail({
      from: fromAddress(),
      to,
      replyTo: 'contact@reforgedz.net',
      subject: `Your ${item} subscription has been cancelled`,
      text,
      html
    });
    return { ok: true };
  } catch (e) {
    console.error('[invoiceMail] cancel send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Confirmation that a refund was processed. Mirrors the invoice template's
// structure but with a red "REFUNDED" badge in place of the green PAID one.
async function sendRefundConfirmation({ to, displayName, productTitle, amountCents, currency, captureId, orderId, dateMs }) {
  const tx = getTransport();
  if (!tx) return { ok: false, skipped: 'smtp_not_configured' };
  if (!to) return { ok: false, skipped: 'no_recipient' };

  const base = (process.env.BASE_URL || 'https://reforgedz.net').replace(/\/+$/, '');
  const item = productTitle || 'Purchase';
  const name = displayName || 'there';
  const amount = money(amountCents, currency);
  const invoiceNo = orderId ? `RFGZ-${String(orderId).padStart(6, '0')}` : '';
  const dateStr = new Date(dateMs || Date.now()).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'long', timeStyle: 'short' }) + ' UTC';

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
        <tr><td style="background:#0d0f12;padding:28px 24px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:.5px">ReforgedZ</td>
              <td style="text-align:right">
                <div style="font-size:18px;font-weight:600;color:#ffffff;letter-spacing:2px">REFUND</div>
                <div style="font-size:12px;color:#9aa0a6;margin-top:2px">${esc(invoiceNo)}</div>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:24px 24px 8px;font-size:15px;color:#1a1a1a;line-height:1.55">
          <p style="margin:0 0 12px">Hi ${esc(name)},</p>
          <p style="margin:0 0 12px">We've processed a refund of <strong>${esc(amount)}</strong> for your <strong>${esc(item)}</strong> purchase.</p>
          <p style="margin:0 0 12px;font-size:13px;color:#4b5563">It will appear in your PayPal balance immediately, and on your linked card / bank within 3-5 business days depending on your bank.</p>
        </td></tr>
        <tr><td style="padding:8px 24px 16px">
          <span style="display:inline-block;background:#fee2e2;color:#b91c1c;font-size:12px;font-weight:700;letter-spacing:1px;padding:4px 12px;border-radius:999px">REFUNDED</span>
          <span style="color:#6b7280;font-size:12px;margin-left:8px">${esc(dateStr)}</span>
        </td></tr>
        ${captureId ? `<tr><td style="padding:0 24px 16px">
          <div style="font-size:11px;color:#9ca3af">Original PayPal transaction ID: <span style="color:#6b7280">${esc(captureId)}</span></div>
        </td></tr>` : ''}
        <tr><td style="padding:8px 24px 24px">
          <div style="font-size:13px;color:#4b5563;line-height:1.5;border-top:1px solid #ecedf0;padding-top:16px">
            Any associated server access (priority queue, roles, etc.) has been removed.
          </div>
        </td></tr>
        <tr><td style="background:#f9fafb;padding:20px 24px;border-top:1px solid #ecedf0">
          <div style="font-size:12px;color:#6b7280;line-height:1.6">
            Questions about this refund? Email <a href="mailto:contact@reforgedz.net" style="color:#2563eb;text-decoration:none">contact@reforgedz.net</a>.<br>
            ReforgedZ &middot; <a href="${esc(base)}/shop" style="color:#2563eb;text-decoration:none">reforgedz.net/shop</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Hi ${name},`,
    '',
    `We've processed a refund of ${amount} for your ${item} purchase.`,
    '',
    'It will appear in your PayPal balance immediately, and on your linked',
    'card or bank within 3-5 business days depending on your bank.',
    '',
    captureId ? `Original PayPal transaction ID: ${captureId}` : null,
    `Refunded on: ${dateStr}`,
    '',
    'Any associated server access (priority queue, roles, etc.) has been removed.',
    '',
    'Questions about this refund? Email contact@reforgedz.net',
    `${base}/shop`
  ].filter((l) => l !== null).join('\n');

  try {
    await tx.sendMail({
      from: fromAddress(),
      to,
      replyTo: 'contact@reforgedz.net',
      subject: `ReforgedZ refund ${invoiceNo ? invoiceNo + ' ' : ''}- ${item}`,
      text,
      html
    });
    return { ok: true };
  } catch (e) {
    console.error('[invoiceMail] refund send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Combined receipt + "what happens next" email for a completed Custom Flag
// order — replaces the plain sendInvoice for this product type since the
// buyer needs the submission details + instructions alongside the receipt,
// not two separate emails. tutorialUrl is never hardcoded: pass null to
// show the placeholder string until a real video link is set.
async function sendCustomFlagConfirmation({ to, orderId, productTitle, amountCents, currency, customFields, tutorialUrl, dateMs }) {
  const tx = getTransport();
  if (!tx) return { ok: false, skipped: 'smtp_not_configured' };
  if (!to) return { ok: false, skipped: 'no_recipient' };

  const base = (process.env.BASE_URL || 'https://reforgedz.net').replace(/\/+$/, '');
  const item = productTitle || 'Custom Flag';
  const amount = money(amountCents, currency);
  const invoiceNo = `RFGZ-${String(orderId).padStart(6, '0')}`;
  const dateStr = new Date(dateMs || Date.now()).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'long', timeStyle: 'short' }) + ' UTC';
  const tutorialHtml = tutorialUrl
    ? `<a href="${esc(tutorialUrl)}" style="color:#2563eb;text-decoration:none">Watch the flag-prep tutorial</a>`
    : esc(YOUTUBE_PLACEHOLDER);
  const tutorialText = tutorialUrl || YOUTUBE_PLACEHOLDER;
  const cf = customFields || {};

  const detailRow = (label, value) => `
    <tr>
      <td style="padding:6px 0;color:#9ca3af;font-size:12px;text-transform:uppercase;letter-spacing:.5px;width:140px">${esc(label)}</td>
      <td style="padding:6px 0;color:#1a1a1a;font-size:14px">${esc(value || '-')}</td>
    </tr>`;

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
        <tr><td style="background:#0d0f12;padding:28px 24px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:.5px">ReforgedZ</td>
              <td style="text-align:right">
                <div style="font-size:18px;font-weight:600;color:#ffffff;letter-spacing:2px">RECEIPT</div>
                <div style="font-size:12px;color:#9aa0a6;margin-top:2px">${esc(invoiceNo)}</div>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:24px 24px 8px;font-size:15px;color:#1a1a1a;line-height:1.55">
          <p style="margin:0 0 12px">Thanks for your <strong>${esc(item)}</strong> order!</p>
          <p style="margin:0 0 12px">Our team will review your submitted design and get it set up at your in-game base.</p>
        </td></tr>
        <tr><td style="padding:8px 24px 16px">
          <span style="display:inline-block;background:#dcfce7;color:#15803d;font-size:12px;font-weight:700;letter-spacing:1px;padding:4px 12px;border-radius:999px">PAID</span>
          <span style="color:#6b7280;font-size:12px;margin-left:8px">${esc(amount)} &middot; ${esc(dateStr)}</span>
        </td></tr>
        <tr><td style="padding:0 24px 8px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #ecedf0;padding-top:8px">
            ${detailRow('Player Name', cf.playerName)}
            ${detailRow('Player Alias', cf.playerAlias)}
            ${detailRow('GUID', cf.guid)}
            ${detailRow('Discord ID', cf.discordId || 'Not provided')}
          </table>
        </td></tr>
        <tr><td style="padding:8px 24px 24px">
          <div style="font-size:13px;color:#4b5563;line-height:1.6;border-top:1px solid #ecedf0;padding-top:16px">
            <strong style="color:#1a1a1a">What happens next</strong><br>
            Staff review submitted flag designs and apply them to your base — this usually takes 1-3 days.
            If your image needs resizing or cleanup first, ${tutorialHtml} walks through preparing it.
            You'll be contacted via Discord (if linked) once it's live.
          </div>
        </td></tr>
        <tr><td style="background:#f9fafb;padding:20px 24px;border-top:1px solid #ecedf0">
          <div style="font-size:12px;color:#6b7280;line-height:1.6">
            Questions? Email <a href="mailto:contact@reforgedz.net" style="color:#2563eb;text-decoration:none">contact@reforgedz.net</a> or open a ticket in our Discord.<br>
            ReforgedZ &middot; <a href="${esc(base)}/shop" style="color:#2563eb;text-decoration:none">reforgedz.net/shop</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Thanks for your ${item} order!`,
    '',
    `Order: ${invoiceNo}`,
    `Total paid: ${amount}`,
    `Date: ${dateStr}`,
    '',
    'Submitted details:',
    `  Player Name: ${cf.playerName || '-'}`,
    `  Player Alias: ${cf.playerAlias || '-'}`,
    `  GUID: ${cf.guid || '-'}`,
    `  Discord ID: ${cf.discordId || 'Not provided'}`,
    '',
    'What happens next:',
    'Staff review submitted flag designs and apply them to your base - this',
    'usually takes 1-3 days. If your image needs resizing or cleanup first,',
    `here's a tutorial: ${tutorialText}`,
    "You'll be contacted via Discord (if linked) once it's live.",
    '',
    'Questions? Email contact@reforgedz.net',
    `${base}/shop`
  ].join('\n');

  try {
    await tx.sendMail({
      from: fromAddress(),
      to,
      replyTo: 'contact@reforgedz.net',
      subject: `ReforgedZ receipt ${invoiceNo} - ${item}`,
      text,
      html
    });
    return { ok: true };
  } catch (e) {
    console.error('[invoiceMail] custom flag confirmation send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { sendInvoice, sendSubscriptionInvite, sendSubscriptionCancelled, sendRefundConfirmation, sendCustomFlagConfirmation };

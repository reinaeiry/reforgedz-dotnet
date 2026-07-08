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
// not two separate emails. Styled to match reforgedz.net itself (dark,
// Oswald/Inter, red accent) rather than the light "invoice" look the other
// templates use, per how this one gets read: it's a to-do list before the
// buyer's next step (watch tutorial → open ticket), not just a receipt.
// tutorialUrl is never hardcoded: pass null to show the placeholder string
// until a real video link is set.
async function sendCustomFlagConfirmation({ to, orderId, productTitle, amountCents, currency, customFields, tutorialUrl, ticketUrl, dateMs }) {
  const tx = getTransport();
  if (!tx) return { ok: false, skipped: 'smtp_not_configured' };
  if (!to) return { ok: false, skipped: 'no_recipient' };

  const base = (process.env.BASE_URL || 'https://reforgedz.net').replace(/\/+$/, '');
  const item = productTitle || 'Custom Flag';
  const amount = money(amountCents, currency);
  const invoiceNo = `RFGZ-${String(orderId).padStart(6, '0')}`;
  const dateStr = new Date(dateMs || Date.now()).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'long', timeStyle: 'short' }) + ' UTC';
  const tutorialHtml = tutorialUrl
    ? `<a href="${esc(tutorialUrl)}" style="color:#e02525;text-decoration:none;font-weight:600">Watch the tutorial</a>`
    : `<span style="color:#777">${esc(YOUTUBE_PLACEHOLDER)}</span>`;
  const tutorialText = tutorialUrl || YOUTUBE_PLACEHOLDER;
  const cf = customFields || {};
  const ticketMessage = "Hello, I'm looking to get started on my Custom Flag! I have watched the tutorial video and here is my custom flag request:";

  const detailRow = (label, value) => `
    <tr>
      <td style="padding:6px 0;color:#777;font-size:11px;text-transform:uppercase;letter-spacing:.5px;width:130px;vertical-align:top">${esc(label)}</td>
      <td style="padding:6px 0;color:#f0f0f0;font-size:14px">${esc(value || '-')}</td>
    </tr>`;

  const stepRow = (n, title, bodyHtml) => `
    <tr>
      <td style="padding:14px 0;border-top:1px solid rgba(255,255,255,0.07)">
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="width:28px;height:28px;background:#cc1f1f;border-radius:50%;text-align:center;vertical-align:middle;font-family:'Oswald',Impact,'Arial Narrow',sans-serif;font-weight:700;color:#fff;font-size:13px">${n}</td>
            <td style="padding-left:12px">
              <div style="font-family:'Oswald',Impact,'Arial Narrow',sans-serif;font-weight:600;letter-spacing:0.5px;color:#fff;font-size:14px;text-transform:uppercase">${esc(title)}</div>
              <div style="color:#aaa;font-size:13px;line-height:1.6;margin-top:4px">${bodyHtml}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;

  const html = `<!doctype html>
<html>
<head>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@600;700&family=Inter:wght@400;500;600&display=swap');
  </style>
</head>
<body style="margin:0;padding:0;background:#0c0c0c;font-family:'Inter',-apple-system,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0c0c0c;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#181818;border:1px solid rgba(255,255,255,0.07);border-radius:10px;overflow:hidden">

        <!-- Brand header -->
        <tr><td style="background:#0c0c0c;padding:26px 24px;border-bottom:2px solid #cc1f1f">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-family:'Oswald',Impact,'Arial Narrow',sans-serif;font-size:20px;font-weight:700;letter-spacing:2px;color:#f0f0f0;text-transform:uppercase">REFORGED<span style="color:#cc1f1f">Z</span></td>
              <td style="text-align:right">
                <div style="font-family:'Oswald',Impact,'Arial Narrow',sans-serif;font-size:16px;font-weight:600;color:#f0f0f0;letter-spacing:2px">RECEIPT</div>
                <div style="font-size:12px;color:#777;margin-top:2px">${esc(invoiceNo)}</div>
              </td>
            </tr>
          </table>
        </td></tr>

        <tr><td style="padding:24px 24px 8px">
          <p style="margin:0 0 10px;font-size:15px;color:#f0f0f0;line-height:1.55">Thanks for your <strong>${esc(item)}</strong> order!</p>
          <p style="margin:0 0 4px;font-size:13px;color:#aaa;line-height:1.55">Follow the steps below to get your design in front of the team — this was also sent to the email you used at checkout, so it's safe to keep for reference.</p>
        </td></tr>

        <tr><td style="padding:8px 24px 16px">
          <span style="display:inline-block;background:rgba(74,222,128,0.12);color:#4ade80;font-size:11px;font-weight:700;letter-spacing:1px;padding:4px 12px;border-radius:999px;text-transform:uppercase">Paid</span>
          <span style="color:#777;font-size:12px;margin-left:8px">${esc(amount)} &middot; ${esc(dateStr)}</span>
        </td></tr>

        <tr><td style="padding:0 24px 8px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid rgba(255,255,255,0.07);padding-top:8px">
            ${detailRow('Player Name', cf.playerName)}
            ${detailRow('In-Game Name', cf.inGameName)}
            ${detailRow('GUID', cf.guid)}
            ${detailRow('Discord ID', cf.discordId || 'Not provided')}
          </table>
        </td></tr>

        <!-- Next steps -->
        <tr><td style="padding:8px 24px 8px">
          <div style="font-family:'Oswald',Impact,'Arial Narrow',sans-serif;font-size:13px;font-weight:600;letter-spacing:1.5px;color:#cc1f1f;text-transform:uppercase;margin-top:8px">Next Steps</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${stepRow(1, 'Watch the tutorial', `${tutorialHtml} covers how to prepare your flag design.`)}
            ${stepRow(2, 'Open a support ticket', `Head to <a href="${esc(ticketUrl)}" style="color:#e02525;text-decoration:none;font-weight:600">our Discord ticket channel</a>, click <strong style="color:#f0f0f0">Open Support Ticket</strong>, and choose <strong style="color:#f0f0f0">Shop</strong> from the dropdown.`)}
            ${stepRow(3, 'Send us your request', `In the ticket, include your receipt number <strong style="color:#f0f0f0">${esc(invoiceNo)}</strong> and this message (attach your flag design to it):`)}
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 4px 40px;width:calc(100% - 40px)">
            <tr><td style="background:#0c0c0c;border:1px solid rgba(255,255,255,0.07);border-left:3px solid #cc1f1f;border-radius:4px;padding:12px 14px;color:#ccc;font-size:13px;font-style:italic;line-height:1.6">${esc(ticketMessage)}</td></tr>
          </table>
        </td></tr>

        <tr><td style="background:#0c0c0c;padding:20px 24px;border-top:1px solid rgba(255,255,255,0.07)">
          <div style="font-size:12px;color:#777;line-height:1.6">
            Questions? Email <a href="mailto:contact@reforgedz.net" style="color:#e02525;text-decoration:none">contact@reforgedz.net</a> or open a ticket in our Discord.<br>
            ReforgedZ &middot; <a href="${esc(base)}/shop" style="color:#e02525;text-decoration:none">reforgedz.net/shop</a>
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
    `Receipt: ${invoiceNo}`,
    `Total paid: ${amount}`,
    `Date: ${dateStr}`,
    '',
    'Submitted details:',
    `  Player Name: ${cf.playerName || '-'}`,
    `  In-Game Name: ${cf.inGameName || '-'}`,
    `  GUID: ${cf.guid || '-'}`,
    `  Discord ID: ${cf.discordId || 'Not provided'}`,
    '',
    'Next steps:',
    `1. Watch the tutorial: ${tutorialText}`,
    `2. Open a support ticket in Discord (${ticketUrl}) - click "Open Support`,
    '   Ticket" and choose "Shop" from the dropdown.',
    `3. In the ticket, include your receipt number (${invoiceNo}) and this`,
    '   message (attach your flag design to it):',
    `   "${ticketMessage}"`,
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

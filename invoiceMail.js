// Invoice emails sent from billing@reforgedz.net via the mailcow SMTP
// server on the EU box. Mirrors the nodemailer pattern in reforgedz-auth.
//
// Env:
//   SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS
//   INVOICE_FROM   — e.g. "ReforgedZ Billing <billing@reforgedz.net>"
//   BASE_URL       — for links back to the shop

const nodemailer = require('nodemailer');

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

  const rows = [
    ['Invoice', invoiceNo],
    ['Date', dateStr],
    ['Item', productTitle || 'Purchase'],
    serverLabel ? ['Server', serverLabel] : null,
    ['Amount', money(amountCents, currency)],
    captureId ? ['PayPal transaction', captureId] : null
  ].filter(Boolean);

  const html = `<!doctype html><html><body style="margin:0;background:#0d0f12;color:#e6e6e6;font-family:Segoe UI,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <h1 style="font-size:20px;margin:0 0 4px;color:#fff">ReforgedZ — Payment Receipt</h1>
    <p style="color:#9aa0a6;margin:0 0 24px;font-size:14px">Thank you${buyerName ? `, ${esc(buyerName)}` : ''}! Your payment has been received.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      ${rows.map(([k, v]) => `<tr>
        <td style="padding:8px 0;color:#9aa0a6;border-bottom:1px solid #23262b;width:40%">${esc(k)}</td>
        <td style="padding:8px 0;color:#e6e6e6;border-bottom:1px solid #23262b">${esc(v)}</td>
      </tr>`).join('')}
    </table>
    <p style="color:#9aa0a6;font-size:13px;margin:24px 0 0">Your purchase is being applied to the server automatically. If you set your in-game UID after purchase, it'll sync within a few minutes.</p>
    <p style="color:#6b7177;font-size:12px;margin:24px 0 0">Questions? Reply to this email or open a ticket in our Discord.<br>ReforgedZ · <a href="${base}/shop" style="color:#4cade6">reforgedz.net/shop</a></p>
  </div></body></html>`;

  const text = [
    `ReforgedZ — Payment Receipt`,
    ``,
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ``,
    `Your purchase is being applied to the server automatically.`,
    `Questions? Reply to this email or open a ticket in our Discord.`,
    `${base}/shop`
  ].join('\n');

  try {
    await tx.sendMail({
      from: fromAddress(),
      to,
      subject: `ReforgedZ receipt ${invoiceNo} — ${productTitle || 'Purchase'}`,
      text,
      html
    });
    return { ok: true };
  } catch (e) {
    console.error('[invoiceMail] send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { sendInvoice };

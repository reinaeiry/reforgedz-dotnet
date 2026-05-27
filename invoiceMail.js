// Invoice emails sent from billing@reforgedz.net via the mailcow SMTP
// server on the EU box. Mirrors the nodemailer pattern in reforgedz-auth.
//
// Env:
//   SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS
//   INVOICE_FROM   e.g. "ReforgedZ Billing <billing@reforgedz.net>"
//   BASE_URL       for links back to the shop

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

module.exports = { sendInvoice };

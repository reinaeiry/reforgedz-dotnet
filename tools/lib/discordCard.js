// Staff cards in #Payment-Processor. Every card about orders, money,
// subscriptions, billing, backups or shop health is built by buildCard and
// posted by postCard, so the whole channel shares one layout, one colour key and
// one rule for who gets notified. Staff read the channel at a glance and follow
// the title link to the order; nothing a card says should need a second look.
//
// No timers and no work on require: routes/shop.js, the tools and the tests all
// load this file.

const { SERVER_LABELS } = require('../../gameServers');

// The colour key. Semantic, and the same on every card in the channel:
//   money_in    green   #4ade80  money arrived: a purchase or a renewal
//   info        grey    #6b7280  for the record, nothing to do
//   attention   amber   #f59e0b  at risk or worth a look: a failed payment, a purchase a block hides
//   action      red     #f87171  someone must act; the only kind that may mention the alert role
//   ended       blue    #60a5fa  a subscription stopped; the player keeps what they paid for
//   refund_out  purple  #c084fc  money went back to a buyer
// ended and refund_out are deliberately not red: neither asks anyone to act, and
// red on every cancellation taught staff to ignore red.
const KIND_COLORS = Object.freeze({
  money_in: 0x4ade80,
  info: 0x6b7280,
  attention: 0xf59e0b,
  action: 0xf87171,
  ended: 0x60a5fa,
  refund_out: 0xc084fc
});
const KINDS = Object.freeze(Object.keys(KIND_COLORS));

// Discord message flag: the card arrives without a push or unread ping.
const SUPPRESS_NOTIFICATIONS = 1 << 12;

// Discord's embed limits (developers/resources/message, Embed Limits).
const LIMITS = Object.freeze({ title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024, footer: 2048, total: 6000 });

const POST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 5000;

function clip(s, n) {
  const str = String(s);
  return str.length > n ? str.slice(0, n - 3) + '...' : str;
}

// A Discord channel is no place for customer emails or full in-game IDs, however
// few people can see it. Call sites pass short IDs already; this is the net under
// them, applied to every piece of text a card carries.
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const UUID_RE = /\{?\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b\}?/gi;
function scrubText(s) {
  return String(s)
    .replace(EMAIL_RE, '[email hidden]')
    .replace(UUID_RE, (m) => m.replace(/[{}]/g, '').slice(0, 8) + '...');
}

// ---- Formatting helpers, shared by every card ---------------------------------

// "$15.00" for dollars, "12.50 EUR" for anything else. Null when there is no amount.
function money(cents, currency = 'usd') {
  const n = Number(cents);
  if (cents == null || cents === '' || !Number.isFinite(n)) return null;
  const code = String(currency || 'usd').toUpperCase();
  const abs = (Math.abs(n) / 100).toFixed(2);
  const sign = n < 0 ? '-' : '';
  return code === 'USD' ? `${sign}$${abs}` : `${sign}${abs} ${code}`;
}

// A Discord timestamp from unix seconds, shown in each reader's own time zone.
function discordDate(unix, style = 'D') {
  const n = Number(unix);
  if (unix == null || unix === '' || !Number.isFinite(n) || n <= 0) return null;
  return `<t:${Math.floor(n)}:${style}>`;
}

// The first characters of an identifier: enough to match it in the admin page,
// not enough to copy someone's in-game ID out of a staff channel.
function shortId(id, n = 8) {
  if (id == null || id === '') return null;
  const s = String(id).replace(/[{}]/g, '');
  return s.length > n ? s.slice(0, n) + '...' : s;
}

function serverLabel(id) {
  if (id == null || id === '') return null;
  return SERVER_LABELS[id] || String(id);
}

function baseUrl() {
  return String(process.env.BASE_URL || 'https://reforgedz.net').replace(/\/+$/, '');
}

function validOrderId(orderId) {
  const n = Number(orderId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The admin orders page, searched for this one order. Admin-only: it 404s for
// anyone else, so the link is safe in any channel.
function adminOrderUrl(orderId) {
  const id = validOrderId(orderId);
  return id ? `${baseUrl()}/admin/orders?q=%23${id}` : null;
}

// An alert role id from the environment, or null. Read per card, so a changed
// .env takes effect on restart without anything cached at require time.
function alertRoleId() {
  const id = String(process.env.PAYMENTS_ALERT_ROLE_ID || '').trim();
  return /^\d{15,25}$/.test(id) ? id : null;
}

function isRoutine(kind, byStaff) {
  return kind === 'money_in' || kind === 'info' || kind === 'ended' || (kind === 'refund_out' && !!byStaff);
}

function embedLength(e) {
  let n = (e.title || '').length + (e.description || '').length + (e.footer ? e.footer.text.length : 0);
  for (const f of e.fields || []) n += f.name.length + f.value.length;
  return n;
}

// ---- The card ------------------------------------------------------------------

// Returns the webhook JSON body for one card. Pure: no I/O.
//   kind         one of KINDS (colour and notifications)
//   what         what happened, first part of the title ("Subscription renewed")
//   product      product title; server is a server id (labelled) or a label
//   orderId      links the title to the order and puts "Order #id" in the footer
//   testMode     sandbox: "[TEST] " title prefix, "TEST" in the footer, never notifies
//   amountCents, currency, accessUntil, nextCharge (unix seconds): the standard money row
//   fields       [{name, value, inline}] after the money row
//   footerExtra  text after the order number in the footer
//   byStaff      a refund_out staff made themselves is routine (silent)
//   imageUrl     an embed image, e.g. attachment://flag.png with postCard's files
function buildCard(spec) {
  const {
    kind, what, product, server, orderId, testMode, description, fields = [],
    accessUntil, nextCharge, amountCents, currency, footerExtra, byStaff, imageUrl, now
  } = spec || {};
  if (!Object.prototype.hasOwnProperty.call(KIND_COLORS, kind)) throw new TypeError(`unknown card kind "${kind}"`);

  const titleParts = [what, product, serverLabel(server)].filter(p => p != null && String(p).trim() !== '').map(String);
  const title = clip(scrubText((testMode ? '[TEST] ' : '') + (titleParts.join(' · ') || 'Shop event')), LIMITS.title);

  const standard = [];
  const amount = money(amountCents, currency);
  if (amount) standard.push({ name: 'Amount', value: amount, inline: true });
  if (discordDate(accessUntil)) standard.push({ name: 'Access until', value: discordDate(accessUntil), inline: true });
  if (discordDate(nextCharge)) standard.push({ name: 'Next charge', value: discordDate(nextCharge), inline: true });

  const allFields = [...standard, ...(Array.isArray(fields) ? fields : [])]
    .filter(f => f && f.name != null && String(f.name).trim() !== '')
    .slice(0, LIMITS.fields)
    .map(f => {
      const value = f.value == null || String(f.value).trim() === '' ? '-' : String(f.value);
      return { name: clip(scrubText(f.name), LIMITS.fieldName), value: clip(scrubText(value), LIMITS.fieldValue), inline: !!f.inline };
    });

  const id = validOrderId(orderId);
  const footerParts = [id ? `Order #${id}` : null, testMode ? 'TEST' : null, footerExtra ? String(footerExtra) : null].filter(Boolean);

  const embed = {
    title,
    color: KIND_COLORS[kind],
    fields: allFields,
    timestamp: new Date(now != null ? now : Date.now()).toISOString()
  };
  const url = adminOrderUrl(id);
  if (url) embed.url = url;
  if (description != null && String(description).trim() !== '') embed.description = clip(scrubText(description), LIMITS.description);
  if (footerParts.length) embed.footer = { text: clip(scrubText(footerParts.join(' · ')), LIMITS.footer) };
  if (imageUrl) embed.image = { url: String(imageUrl) };

  // Discord refuses the whole message past 6000 characters: shorten the
  // description first, then drop fields from the end.
  let over = embedLength(embed) - LIMITS.total;
  if (over > 0 && embed.description) {
    const keep = Math.max(0, embed.description.length - over);
    if (keep > 0) embed.description = clip(embed.description, keep); else delete embed.description;
    over = embedLength(embed) - LIMITS.total;
  }
  while (over > 0 && embed.fields.length) {
    embed.fields.pop();
    over = embedLength(embed) - LIMITS.total;
  }

  const body = { embeds: [embed] };
  const role = kind === 'action' && !testMode ? alertRoleId() : null;
  if (role) {
    body.content = `<@&${role}> Action needed`;
    body.allowed_mentions = { roles: [role] };
  } else {
    // Nothing in any card may ping anyone, whatever a player name contains.
    body.allowed_mentions = { parse: [] };
  }
  if (testMode || isRoutine(kind, byStaff)) body.flags = SUPPRESS_NOTIFICATIONS;
  return body;
}

// ---- Posting -------------------------------------------------------------------

// ?wait=true makes Discord confirm the message was saved; without it a rejected
// card is dropped with no error.
function withWait(raw) {
  try {
    const u = new URL(String(raw));
    u.searchParams.set('wait', 'true');
    return u.toString();
  } catch {
    return null;
  }
}

function requestInit(body, files, signal) {
  if (Array.isArray(files) && files.length) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(body));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data]), String(f.name)));
    return { method: 'POST', body: form, signal };
  }
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal };
}

function retryWaitMs(res, json) {
  let secs = json && Number(json.retry_after);
  if (!Number.isFinite(secs)) {
    const h = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
    secs = Number(h);
  }
  if (!Number.isFinite(secs) || secs < 0) secs = 1;
  return Math.min(Math.ceil(secs * 1000), MAX_RETRY_WAIT_MS);
}

const defaultSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Posts one card body to the webhook. Best-effort: never throws, because a
// Discord outage must not fail the payment, sync or job that wanted to report.
// Returns { ok, status, messageId }. A failure is logged with the HTTP status
// only: the webhook URL carries its token and never goes in a log.
//   fetchImpl, url (default DISCORD_WEBHOOK_URL), files [{name, data}] for an
//   attachment, timeoutMs, sleep and logger exist for tests.
async function postCard(body, opts = {}) {
  const {
    fetchImpl = globalThis.fetch, files = null, timeoutMs = POST_TIMEOUT_MS,
    sleep = defaultSleep, logger = console
  } = opts;
  const url = Object.prototype.hasOwnProperty.call(opts, 'url') ? opts.url : process.env.DISCORD_WEBHOOK_URL;
  if (!url) return { ok: false, status: 0, messageId: null, skipped: 'no webhook' };
  const target = withWait(url);
  if (!target) {
    logger.error('[discord-card] card not posted: the webhook URL is not a valid URL');
    return { ok: false, status: 0, messageId: null };
  }
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    let json = null;
    try {
      res = await fetchImpl(target, requestInit(body, files, ctrl.signal));
      // A missing or unreadable body still counts: the status decides.
      try { json = await res.json(); } catch { json = null; }
    } catch {
      // Only the request itself lands here. Its error text can name the host,
      // so it is not logged.
      logger.error(`[discord-card] card not posted: HTTP 0 (${ctrl.signal.aborted ? 'timed out' : 'network error'})`);
      return { ok: false, status: 0, messageId: null };
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await sleep(retryWaitMs(res, json));
      continue;
    }
    if (!res.ok) {
      logger.error(`[discord-card] card not posted: HTTP ${res.status}`);
      return { ok: false, status: res.status, messageId: null };
    }
    return { ok: true, status: res.status, messageId: json && json.id != null ? String(json.id) : null };
  }
}

// Build and post in one call. Takes a spec, or a function returning one, so a
// mistake while assembling a card is logged here instead of throwing into a
// webhook handler. Never throws.
async function sendCard(specOrFn, opts = {}) {
  let body;
  try {
    body = buildCard(typeof specOrFn === 'function' ? specOrFn() : specOrFn);
  } catch (e) {
    (opts.logger || console).error(`[discord-card] card not built: ${e.message}`);
    return { ok: false, status: 0, messageId: null };
  }
  return postCard(body, opts);
}

module.exports = {
  buildCard, postCard, sendCard,
  money, discordDate, shortId, serverLabel, adminOrderUrl, scrubText,
  KINDS, KIND_COLORS, SUPPRESS_NOTIFICATIONS, LIMITS, MAX_RETRIES, MAX_RETRY_WAIT_MS
};

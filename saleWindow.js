// A product's sale window (decision B7, 2026-10-20): products.available_from and
// products.available_until, unix seconds, both optional. Outside the window the
// shop does not list the product and checkout refuses it with a plain sentence;
// inside it, or with no dates at all, nothing changes. What a player already bought
// is never touched by the window: entitlements and the cosmetics sync read orders,
// not the product's dates. The first use is the Winter Armband, on sale from
// 2026-12-17 00:00 UTC to 2027-01-04 23:59 UTC.
//
// Takes plain values and does nothing on require (test/saleWindow.test.js).

const nowS = () => Math.floor(Date.now() / 1000);

function windowOf(product) {
  const from = product && product.available_from != null ? Number(product.available_from) : null;
  const until = product && product.available_until != null ? Number(product.available_until) : null;
  return {
    from: Number.isFinite(from) ? from : null,
    until: Number.isFinite(until) ? until : null
  };
}

// Whether the product can be bought now. No dates: always.
function onSale(product, now = nowS()) {
  const { from, until } = windowOf(product);
  if (from != null && now < from) return false;
  if (until != null && now > until) return false;
  return true;
}

// The same rule in SQL, for the public listing. `alias` is the products table's
// alias in the query; `nowParam` the placeholder that carries the time.
function onSaleSql(alias, nowParam) {
  return `((${alias}.available_from IS NULL OR ${alias}.available_from <= ${nowParam})`
    + ` AND (${alias}.available_until IS NULL OR ${alias}.available_until >= ${nowParam}))`;
}

const utcDate = (unix) => new Date(Number(unix) * 1000).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'long', timeStyle: 'short' }) + ' UTC';

// Why the product cannot be bought now, in one plain sentence; null while it can.
function refusal(product, now = nowS()) {
  const { from, until } = windowOf(product);
  if (from != null && now < from) return `This item goes on sale on ${utcDate(from)}.`;
  if (until != null && now > until) return 'This item is no longer on sale.';
  return null;
}

// The admin form's values: '' or null clears a date, otherwise a whole number of
// unix seconds. Returns { ok, from, until, error }; a missing field is reported as
// undefined so an update can leave it as it is.
function normalizeWindow({ availableFrom, availableUntil } = {}) {
  const one = (v) => {
    if (v === undefined) return { sent: false, value: null };
    if (v === null || v === '') return { sent: true, value: null };
    if (typeof v !== 'number' && typeof v !== 'string') return { sent: true, value: null, bad: true };
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!Number.isInteger(n) || n < 0 || n > 4102444800) return { sent: true, value: null, bad: true };
    return { sent: true, value: n };
  };
  const from = one(availableFrom);
  const until = one(availableUntil);
  if (from.bad || until.bad) return { ok: false, error: 'Sale dates must be unix seconds (whole numbers), or empty.' };
  if (from.value != null && until.value != null && until.value < from.value) {
    return { ok: false, error: 'The sale must end after it starts.' };
  }
  return {
    ok: true,
    from: from.sent ? from.value : undefined,
    until: until.sent ? until.value : undefined
  };
}

module.exports = { onSale, onSaleSql, refusal, normalizeWindow, windowOf, utcDate };

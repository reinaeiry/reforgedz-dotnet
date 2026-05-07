const FX_URL = 'https://api.frankfurter.app/latest?from=USD&to=GBP,EUR';
const TTL_MS = 24 * 60 * 60 * 1000;

let cache = null;
let inflight = null;

async function fetchRates() {
  const res = await fetch(FX_URL);
  if (!res.ok) throw new Error(`FX HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.rates) throw new Error('FX response missing rates');
  return {
    rates: { USD: 1, GBP: data.rates.GBP, EUR: data.rates.EUR },
    fetchedAt: Date.now()
  };
}

async function getRates() {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) return cache;
  if (inflight) return inflight;

  inflight = fetchRates()
    .then(fresh => { cache = fresh; return fresh; })
    .catch(err => {
      console.error('[fx] Refresh failed:', err.message);
      if (cache) return cache;
      return { rates: { USD: 1 }, fetchedAt: now };
    })
    .finally(() => { inflight = null; });

  return inflight;
}

module.exports = { getRates };

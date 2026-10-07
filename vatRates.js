// Standard VAT rates for digital services sold to consumers, by ISO country code.
//
// The shop sells to players in the EU and the UK, and a seller outside the EU owes
// VAT on those sales from the first one (the EU's non-Union One Stop Shop; UK VAT
// for a business based abroad). Game items and memberships take the standard rate.
//
// These rates are an estimate aid, not a filing source: rates change (Finland,
// Estonia, Romania and Slovakia all moved in 2024-2025). Check every rate against
// the European Commission's tax database (TEDB) and GOV.UK before a return is
// filed, then update RATES_CHECKED. Special territories (the Canary Islands, Aland,
// Mount Athos and others) are outside EU VAT and are not modelled here.

const RATES_CHECKED = '2026-10-07';

// Percent. Greece is GR here (ISO, what PayPal and Cloudflare send), EL in VAT forms.
const EU_STANDARD = Object.freeze({
  AT: 20, BE: 21, BG: 20, HR: 25, CY: 19, CZ: 21, DK: 25, EE: 24, FI: 25.5, FR: 20,
  DE: 19, GR: 24, HU: 27, IE: 23, IT: 22, LV: 21, LT: 21, LU: 17, MT: 18, NL: 21,
  PL: 23, PT: 23, RO: 21, SK: 23, SI: 22, ES: 21, SE: 25
});
const UK_STANDARD = 20;

// Territories inside another country's VAT area: Monaco is in French VAT, the Isle
// of Man in UK VAT.
const VAT_AREA_OF = Object.freeze({ MC: 'FR', IM: 'GB' });

// { scheme, rate } for a country: 'EU-OSS' (filed through the One Stop Shop),
// 'UK' (filed with HMRC), or 'none' (no VAT registration covers it; rate null).
function vatFor(country) {
  const raw = String(country || '').toUpperCase();
  const c = VAT_AREA_OF[raw] || raw;
  if (Object.prototype.hasOwnProperty.call(EU_STANDARD, c)) return { scheme: 'EU-OSS', rate: EU_STANDARD[c] };
  if (c === 'GB') return { scheme: 'UK', rate: UK_STANDARD };
  return { scheme: 'none', rate: null };
}

// The VAT inside a price that already includes it, in cents, rounded half up.
// 1500 cents at 20% holds 250 cents of VAT.
function vatIncludedCents(grossCents, ratePercent) {
  if (!ratePercent) return 0;
  return Math.round((grossCents * ratePercent) / (100 + ratePercent));
}

module.exports = { RATES_CHECKED, EU_STANDARD, UK_STANDARD, vatFor, vatIncludedCents };

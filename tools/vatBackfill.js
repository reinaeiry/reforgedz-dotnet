#!/usr/bin/env node
// Fill orders.payer_country for past payments, for the VAT estimate of sales made
// before the shop recorded countries (vatEvidence.js). Reads PayPal Transaction
// Search one 31-day window at a time, oldest first, and writes only the two-letter
// country code of each payer onto the order that holds that payment.
//
//   npm run vat-backfill -- --from 2026-05-01            count what WOULD be filled, write nothing
//   npm run vat-backfill -- --from 2026-05-01 --apply    fill them
//
// Stops at the first window PayPal does not answer and says which; the windows
// before it stay filled, because each row is true on its own, so a re-run picks up
// where it stopped. Live PayPal only; sandbox rows are never touched.
const path = require('path');
if (require.main === module) require('dotenv').config({ path: process.env.ENV_FILE || path.join(__dirname, '..', '.env'), quiet: true });

const PAUSE_MS = 1500;   // between windows, well inside PayPal's rate limit
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { from: null, apply: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--from') args.from = argv[++i];
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(args.from || ''));
  args.fromUnix = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000 : null;
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.fromUnix) {
    console.error('usage: npm run vat-backfill -- --from YYYY-MM-DD [--apply]');
    process.exit(2);
  }
  const db = require('../db');
  const paypal = require('../paypal');
  const vat = require('../vatEvidence');
  // Transaction Search lags a few hours; the daily run covers the newest payments.
  const end = Math.floor(Date.now() / 1000) - 6 * 3600;
  const windows = vat.windowsBetween(args.fromUnix, end);
  const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  console.log(`${args.apply ? 'Filling' : 'Dry run (nothing is written)'}: ${windows.length} window(s) from ${day(args.fromUnix)} to ${day(end)}`);
  let total = 0;
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const out = await vat.fillPayerCountries({ db, paypal, start: w.start, end: w.end, dryRun: !args.apply });
    if (out.skipped) { console.error(`Stopped: ${out.skipped}.`); process.exit(1); }
    if (out.error) {
      console.error(`Stopped at ${day(w.start)} to ${day(w.end)}: ${out.error}. Windows before it are ${args.apply ? 'filled' : 'counted'}; run again to continue.`);
      process.exit(1);
    }
    total += out.filled;
    console.log(`  ${day(w.start)} to ${day(w.end)}: ${out.rows} PayPal row(s), ${out.withCountry} with a country, ${out.filled} order(s) ${args.apply ? 'filled' : 'would be filled'}`);
    if (i < windows.length - 1) await sleep(PAUSE_MS);
  }
  console.log(`${args.apply ? 'Filled' : 'Would fill'} ${total} order(s).`);
}

if (require.main === module) {
  main().catch((e) => { console.error('vat-backfill failed:', e.message); process.exit(1); });
}

module.exports = { parseArgs };

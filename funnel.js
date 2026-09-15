// Daily counts of each step of the buy flow (plan J5): how many, never who.
//
// Most priority queue buyers pay soon after making their account, and nothing
// before PayPal was counted, so nobody could say where the other buyers gave up
// or whether a checkout change helped. Each
// step is one row per UTC day in funnel_counts. No account, email, in-game ID or
// IP is stored, so the table can be read or shared without a privacy question.
//
// Takes the database handle as a parameter and does nothing on require, so the
// tests run it against a throwaway copy of the real schema (test/funnel.test.js).

// Counted by the server where the step happens.
const SERVER_STEPS = [
  'account_created',            // POST /api/auth/register made a new account
  'signed_in',                  // POST /api/auth/login, email and password
  'id_saved_find',              // in-game ID saved from a Find me pick
  'id_saved_paste',             // in-game ID saved from a pasted ID
  'checkout_started',           // PayPal handed back an approval link (order or subscription)
  'checkout_blocked_duplicate', // either duplicate priority queue refusal at checkout
  'payment_completed'           // an order completed for the first time (fulfillOrder)
];

// Only the page can see these; it reports them to POST /api/shop/funnel. Nothing
// else is accepted there, so the beacon cannot be used to write arbitrary rows.
const CLIENT_STEPS = [
  'buy_clicked',
  'signin_shown',
  'id_prompt_shown',
  'discord_prompt_shown',
  'checkout_cancelled_seen'
];

// Every step, in the order a buyer meets them, for the admin view.
const STEPS = [
  'buy_clicked', 'signin_shown', 'account_created', 'signed_in', 'id_prompt_shown',
  'id_saved_find', 'id_saved_paste', 'discord_prompt_shown', 'checkout_started',
  'checkout_blocked_duplicate', 'checkout_cancelled_seen', 'payment_completed'
];

const DAY_S = 86400;

// YYYY-MM-DD in UTC for unix seconds, or null.
function dayOf(unix) {
  const d = new Date(Number(unix) * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

// Add one to today's count for this step. Never throws: a counter must never be
// the reason a sign-in, a saved ID or a payment fails, so any problem is logged
// and the request carries on. Returns whether the count was stored.
function countStep(db, step, now = Math.floor(Date.now() / 1000)) {
  try {
    if (!STEPS.includes(step)) throw new Error(`unknown step ${JSON.stringify(String(step).slice(0, 40))}`);
    const day = dayOf(now);
    if (!day) throw new Error('no usable time');
    db.prepare(`
      INSERT INTO funnel_counts (day, step, n) VALUES (?, ?, 1)
      ON CONFLICT(day, step) DO UPDATE SET n = n + 1
    `).run(day, step);
    return true;
  } catch (e) {
    console.error(`[funnel] could not count a step: ${e.message}`);
    return false;
  }
}

// The counts for the last `days` UTC days, today included (1 to 366, default 30).
function readFunnel(db, { days, now = Math.floor(Date.now() / 1000) } = {}) {
  const asked = parseInt(days, 10);
  const n = Number.isFinite(asked) ? Math.min(366, Math.max(1, asked)) : 30;
  const since = dayOf(now - (n - 1) * DAY_S);
  const rows = db.prepare(`
    SELECT day, step, n FROM funnel_counts
    WHERE day >= ?
    ORDER BY day DESC, step ASC
  `).all(since);
  return { days: n, since, steps: STEPS, rows };
}

module.exports = { SERVER_STEPS, CLIENT_STEPS, STEPS, dayOf, countStep, readFunnel };

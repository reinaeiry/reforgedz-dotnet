// When the game servers restart. The in-game MOD_RestartComponent restarts
// every server on 4-hour boundaries (00, 04, 08, 12, 16, 20 UTC); Reforger
// reads game.admins only at start, so queue priority bought at 13:05 begins
// at 16:00. The confirmation page, the receipt and the account page all
// compute "when" from here, so the answer is the same everywhere.
const RESTART_EVERY_HOURS = 4;
const RESTART_UTC_HOURS = Array.from({ length: 24 / RESTART_EVERY_HOURS }, (_, i) => i * RESTART_EVERY_HOURS);

// The next boundary strictly after `nowMs`. Anchored at UTC midnight, which is
// what the epoch is, so a plain floor works.
function nextScheduledRestart(nowMs = Date.now()) {
  const step = RESTART_EVERY_HOURS * 3600 * 1000;
  return new Date(Math.floor(nowMs / step) * step + step);
}

// "16:00 UTC (in 2 h 55 min)" for the copy that names the moment.
function describeNextRestart(nowMs = Date.now()) {
  const next = nextScheduledRestart(nowMs);
  const mins = Math.max(1, Math.round((next - nowMs) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const inText = h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
  const sameDay = next.toISOString().slice(0, 10) === new Date(nowMs).toISOString().slice(0, 10);
  const when = `${next.toISOString().slice(11, 16)} UTC${sameDay ? '' : ` on ${next.toISOString().slice(0, 10)}`}`;
  return { next, when, inText, text: `${when} (in ${inText})` };
}

module.exports = { RESTART_EVERY_HOURS, RESTART_UTC_HOURS, nextScheduledRestart, describeNextRestart };

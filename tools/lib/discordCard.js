// One embed into #Payment-Processor through the "ReforgedZ Payments" webhook,
// the same identity every purchase card uses. Best-effort: a Discord outage
// must never fail the job that wanted to report.
async function postCard({ title, description, color, fields = [], footer }) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return { ok: false, skipped: 'no webhook' };
  const embed = {
    title: String(title).slice(0, 256),
    description: description ? String(description).slice(0, 4000) : undefined,
    color,
    fields: fields.slice(0, 25).map(f => ({ name: String(f.name).slice(0, 256), value: String(f.value || '-').slice(0, 1024), inline: !!f.inline })),
    footer: footer ? { text: String(footer).slice(0, 2048) } : undefined,
    timestamp: new Date().toISOString()
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }), signal: ctrl.signal
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

const COLORS = { green: 0x4ade80, amber: 0xf59e0b, red: 0xf87171, grey: 0x6b7280 };

module.exports = { postCard, COLORS };

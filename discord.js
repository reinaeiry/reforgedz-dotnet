const DISCORD_API = 'https://discord.com/api/v10';

function botToken() {
  return process.env.DISCORD_BOT_TOKEN || '';
}

function guildId() {
  return process.env.DISCORD_GUILD_ID || '1352364195211120660'; // ReforgedZ
}

async function discordFetch(path, opts = {}) {
  const tk = botToken();
  if (!tk) throw new Error('DISCORD_BOT_TOKEN not set');
  const res = await fetch(`${DISCORD_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bot ${tk}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  return res;
}

// In-memory cache: role list + bot's hierarchy position. 5-minute TTL.
let cache = null;
const CACHE_TTL_MS = 5 * 60 * 1000;
let inflight = null;

async function loadRolesUncached() {
  const tk = botToken();
  if (!tk) return { roles: [], botPosition: 0, error: 'DISCORD_BOT_TOKEN not set' };

  // Get all roles in the guild
  const rolesRes = await discordFetch(`/guilds/${guildId()}/roles`);
  if (!rolesRes.ok) return { roles: [], botPosition: 0, error: `roles ${rolesRes.status}` };
  const allRoles = await rolesRes.json();

  // Get bot's own user id, then look up its member record to find its highest role position
  const meRes = await discordFetch('/users/@me');
  if (!meRes.ok) return { roles: [], botPosition: 0, error: `me ${meRes.status}` };
  const me = await meRes.json();
  const memberRes = await discordFetch(`/guilds/${guildId()}/members/${me.id}`);
  if (!memberRes.ok) return { roles: [], botPosition: 0, error: `member ${memberRes.status}` };
  const member = await memberRes.json();

  const memberRoleIds = new Set(member.roles || []);
  let botPosition = 0;
  for (const r of allRoles) {
    if (memberRoleIds.has(r.id) && (r.position || 0) > botPosition) botPosition = r.position;
  }

  // Filter: not @everyone, not managed, position strictly below bot's top role
  const assignable = allRoles
    .filter(r => r.id !== guildId() && !r.managed && (r.position || 0) < botPosition)
    .sort((a, b) => b.position - a.position)
    .map(r => ({ id: r.id, name: r.name, position: r.position, color: r.color }));

  return { roles: assignable, botPosition };
}

async function fetchAssignableRoles() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  if (inflight) return inflight;
  inflight = loadRolesUncached()
    .then(v => { cache = { value: v, at: Date.now() }; return v; })
    .finally(() => { inflight = null; });
  return inflight;
}

function invalidateRolesCache() {
  cache = null;
}

async function verifyMember(userId) {
  if (!/^\d{15,25}$/.test(String(userId || ''))) return null;
  const res = await discordFetch(`/guilds/${guildId()}/members/${userId}`);
  if (!res.ok) return null;
  const member = await res.json();
  return {
    id: userId,
    username: member.user ? member.user.username : null,
    globalName: member.user ? (member.user.global_name || member.user.username) : null,
    nick: member.nick || null
  };
}

async function assignRole(userId, roleId) {
  const res = await discordFetch(
    `/guilds/${guildId()}/members/${userId}/roles/${roleId}`,
    { method: 'PUT' }
  );
  if (!res.ok && res.status !== 204) {
    const body = await res.text().catch(() => '');
    throw new Error(`Assign role failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

async function removeRole(userId, roleId) {
  const res = await discordFetch(
    `/guilds/${guildId()}/members/${userId}/roles/${roleId}`,
    { method: 'DELETE' }
  );
  if (!res.ok && res.status !== 204 && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`Remove role failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

module.exports = {
  fetchAssignableRoles,
  invalidateRolesCache,
  verifyMember,
  assignRole,
  removeRole,
  guildId
};

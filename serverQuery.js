// Player counts for the homepage, asked of the game servers themselves (A2S, a2s.js). Each server's
// query port is in its own config.json, read over the sync's SSH path once an hour; it is never
// guessed from the game port, because EU1 and EU2 do not use the ports their order suggests.
const { listServers, SELLABLE_SERVER_IDS } = require('./gameServers');
const { queryInfo } = require('./a2s');

const PORTS_TTL_MS = 60 * 60 * 1000;      // a query port changes only when someone edits config.json
const PORTS_RETRY_MS = 5 * 60 * 1000;     // after a failed read, try again sooner

let ports = new Map();                    // volume uuid -> query port
let portsAt = 0;
let portsTriedAt = 0;
let portsInFlight = null;

// The volume uuid in a server path (/var/lib/pterodactyl/volumes/<uuid>/...), which is the
// panel's server uuid: how a homepage server finds its entry in gameServers.js.
function volumeUuidFromPath(p) {
  const m = String(p || '').match(/\/volumes\/([0-9a-f-]{36})\//i);
  return m ? m[1].toLowerCase() : null;
}

// Query ports from parsed configs ({ serverId: config }), keyed by volume uuid.
function portsFromConfigs(servers, configs) {
  const out = new Map();
  for (const s of servers) {
    const port = Number(configs[s.id] && configs[s.id].a2s && configs[s.id].a2s.port);
    const vol = volumeUuidFromPath(s.configPath);
    if (vol && Number.isInteger(port) && port > 0 && port < 65536) out.set(vol, port);
  }
  return out;
}

async function queryPorts({ now = Date.now(), readConfigs } = {}) {
  const fresh = ports.size > 0 && now - portsAt < PORTS_TTL_MS;
  if (fresh || now - portsTriedAt < PORTS_RETRY_MS) return ports;
  if (!portsInFlight) {
    portsTriedAt = now;
    portsInFlight = (async () => {
      try {
        const servers = listServers().filter((s) => SELLABLE_SERVER_IDS.includes(s.id));
        const read = readConfigs || require('./sync').readServerConfigs;
        const next = portsFromConfigs(servers, await read(servers));
        if (next.size) { ports = next; portsAt = Date.now(); }
      } catch (e) {
        console.warn(`[status] could not read the servers' query ports: ${e.message}`);
      } finally {
        portsInFlight = null;
      }
    })();
  }
  await portsInFlight;
  return ports;
}

// { players, max } for one panel server, or null when it cannot be asked just now (the homepage
// then shows no number rather than a wrong one).
async function playerCount(volumeUuid, host, { query = queryInfo } = {}) {
  const port = ports.get(String(volumeUuid || '').toLowerCase());
  if (!port || !host) return null;
  try {
    const info = await query(host, port, 3000);
    return { players: info.players, max: info.maxPlayers };
  } catch {
    return null;
  }
}

module.exports = {
  queryPorts,
  playerCount,
  _test: {
    volumeUuidFromPath,
    portsFromConfigs,
    reset() { ports = new Map(); portsAt = 0; portsTriedAt = 0; portsInFlight = null; },
    setPorts(m) { ports = new Map(m); portsAt = Date.now(); },
  },
};

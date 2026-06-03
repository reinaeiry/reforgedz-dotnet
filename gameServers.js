const SERVER_IDS = ['eu1', 'eu2', 'eu3', 'na1', 'na2'];
const SERVER_LABELS = { eu1: 'EU1 (Chernarus)', eu2: 'EU2 (Chernarus)', eu3: 'EU3 (Everon)', na1: 'NA1 (Chernarus)', na2: 'NA2 (Chernarus)' };

// Given the shop's purchases.json path (which sits deep inside the
// pterodactyl volume), strip back to the volume root and append the
// game server's config.json. Example:
//   /var/lib/pterodactyl/volumes/<uuid>/profile/profile/eiry/reforgedz-dotnet-shop
// becomes
//   /var/lib/pterodactyl/volumes/<uuid>/config.json
function configPathFromShopPath(shopPath) {
  if (!shopPath) return null;
  const i = shopPath.indexOf('/profile/');
  if (i < 0) return null;
  return shopPath.substring(0, i) + '/config.json';
}

function listServers() {
  const eu = (process.env.GAME_SERVER_EU_PATHS || '').split(',').map(s => s.trim()).filter(Boolean);
  const na = (process.env.GAME_SERVER_NA_PATHS || '').split(',').map(s => s.trim()).filter(Boolean);
  const euHost = process.env.GAME_SERVER_EU_HOST;
  const naHost = process.env.GAME_SERVER_NA_HOST;
  const euPort = parseInt(process.env.GAME_SERVER_EU_PORT) || 22;
  const naPort = parseInt(process.env.GAME_SERVER_NA_PORT) || 22;
  const euUser = process.env.GAME_SERVER_EU_USER || 'root';
  const naUser = process.env.GAME_SERVER_NA_USER || 'root';

  // EU3 lives on its own host (a separate node), so it is reached the same way
  // as the NA servers: a nested SSH hop from the EU entry host. Its distinct
  // region ('eu3') is what makes sync.js wrap commands in that hop rather than
  // running them directly on the entry host.
  const eu3 = (process.env.GAME_SERVER_EU3_PATHS || '').split(',').map(s => s.trim()).filter(Boolean);
  const eu3Host = process.env.GAME_SERVER_EU3_HOST;
  const eu3Port = parseInt(process.env.GAME_SERVER_EU3_PORT) || 22;
  const eu3User = process.env.GAME_SERVER_EU3_USER || 'root';

  const all = [
    { id: 'eu1', region: 'eu', host: euHost, port: euPort, user: euUser, path: eu[0] || null },
    { id: 'eu2', region: 'eu', host: euHost, port: euPort, user: euUser, path: eu[1] || null },
    { id: 'eu3', region: 'eu3', host: eu3Host, port: eu3Port, user: eu3User, path: eu3[0] || null },
    { id: 'na1', region: 'na', host: naHost, port: naPort, user: naUser, path: na[0] || null },
    { id: 'na2', region: 'na', host: naHost, port: naPort, user: naUser, path: na[1] || null },
  ];
  return all.filter(s => s.host && s.path).map(s => ({
    ...s,
    configPath: configPathFromShopPath(s.path)
  }));
}

function getServer(id) {
  return listServers().find(s => s.id === id) || null;
}

function isValidServerId(id) {
  return SERVER_IDS.includes(id);
}

module.exports = { SERVER_IDS, SERVER_LABELS, listServers, getServer, isValidServerId };

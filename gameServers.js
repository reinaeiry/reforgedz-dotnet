// EU3 became the EU dev server and its Everon role moved to EU2 (NA2 is Everon
// too). 'eu3' is deliberately absent from SERVER_IDS so it can't be sold or
// synced, but its label is kept so historical eu3 orders still render a name.
const SERVER_IDS = ['eu1', 'eu2', 'na1', 'na2', 'dev1'];
const SERVER_LABELS = { eu1: 'EU1 (Chernarus)', eu2: 'EU2 (Everon)', eu3: 'EU3 (now EU Dev)', na1: 'NA1 (Chernarus)', na2: 'NA2 (Everon)', dev1: 'NA Dev' };

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

// The ReforgedZ persistence save root for a server, derived the same way:
//   <volume>/profile/profile/eiry/reforgedz-dotnet-shop
// becomes
//   <volume>/profile/profile/.save/game   (holds <world>/gamemode/<category>/*.json)
function saveGamePathFromShopPath(shopPath) {
  if (!shopPath) return null;
  const i = shopPath.indexOf('/profile/');
  if (i < 0) return null;
  return shopPath.substring(0, i) + '/profile/profile/.save/game';
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

  // EU3 is now the EU dev server — its Everon role moved to EU2, so it is no
  // longer synced. The GAME_SERVER_EU3_* env vars are unread; leaving them set
  // in .env is harmless.

  // The [DEV] Chernarus server lives on the NA box, so it reuses the NA host/creds
  // and the same nested-SSH hop (region 'na'). Its own path var keeps it independent
  // of NA list ordering. Set GAME_SERVER_NA_DEV_PATH to its volume shop path
  // (e.g. /var/lib/pterodactyl/volumes/<dev-uuid>/profile/profile/eiry/reforgedz-dotnet-shop).
  const naDev = (process.env.GAME_SERVER_NA_DEV_PATH || '').trim();

  const all = [
    { id: 'eu1', region: 'eu', host: euHost, port: euPort, user: euUser, path: eu[0] || null },
    { id: 'eu2', region: 'eu', host: euHost, port: euPort, user: euUser, path: eu[1] || null },
    { id: 'na1', region: 'na', host: naHost, port: naPort, user: naUser, path: na[0] || null },
    { id: 'na2', region: 'na', host: naHost, port: naPort, user: naUser, path: na[1] || null },
    { id: 'dev1', region: 'na', host: naHost, port: naPort, user: naUser, path: naDev || null },
  ];
  return all.filter(s => s.host && s.path).map(s => ({
    ...s,
    configPath: configPathFromShopPath(s.path),
    savePath: saveGamePathFromShopPath(s.path)
  }));
}

function getServer(id) {
  return listServers().find(s => s.id === id) || null;
}

function isValidServerId(id) {
  return SERVER_IDS.includes(id);
}

module.exports = { SERVER_IDS, SERVER_LABELS, listServers, getServer, isValidServerId, configPathFromShopPath, saveGamePathFromShopPath };

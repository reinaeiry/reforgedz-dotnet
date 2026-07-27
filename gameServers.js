// EU3 became the EU dev server and its Everon role moved to EU2 (NA2 is Everon
// too). 'eu3' is deliberately absent from SERVER_IDS so it can't be sold or
// synced, but its label is kept so historical eu3 orders still render a name.
//
// Two lists on purpose: SERVER_IDS is what the shop SELLS and SYNCS, while
// ALL_SERVER_IDS is every server we can still reach for admin tooling. The save
// inspector needs the second — dropping eu3 from the first must not take its
// saves away with it.
const SERVER_IDS = ['eu1', 'eu2', 'na1', 'na2', 'dev1'];
const ALL_SERVER_IDS = ['eu1', 'eu2', 'eu3', 'na1', 'na2', 'dev1'];
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

// Every server we can still reach over SSH, including ones no longer sold or
// synced. Admin tooling (the save inspector) works from this list.
function listAllServers() {
  const eu = (process.env.GAME_SERVER_EU_PATHS || '').split(',').map(s => s.trim()).filter(Boolean);
  const na = (process.env.GAME_SERVER_NA_PATHS || '').split(',').map(s => s.trim()).filter(Boolean);
  const euHost = process.env.GAME_SERVER_EU_HOST;
  const naHost = process.env.GAME_SERVER_NA_HOST;
  const euPort = parseInt(process.env.GAME_SERVER_EU_PORT) || 22;
  const naPort = parseInt(process.env.GAME_SERVER_NA_PORT) || 22;
  const euUser = process.env.GAME_SERVER_EU_USER || 'root';
  const naUser = process.env.GAME_SERVER_NA_USER || 'root';

  // EU3 is now the EU dev server: no longer sold or synced, but still reachable
  // so its saves can be inspected. It sits on its own region tag ('eu3') so any
  // command for it is wrapped in the nested SSH hop, as before.
  const eu3 = (process.env.GAME_SERVER_EU3_PATHS || '').split(',').map(s => s.trim()).filter(Boolean);
  const eu3Host = process.env.GAME_SERVER_EU3_HOST;
  const eu3Port = parseInt(process.env.GAME_SERVER_EU3_PORT) || 22;
  const eu3User = process.env.GAME_SERVER_EU3_USER || 'root';

  // The [DEV] Chernarus server lives on the NA box, so it reuses the NA host/creds
  // and the same nested-SSH hop (region 'na'). Its own path var keeps it independent
  // of NA list ordering. Set GAME_SERVER_NA_DEV_PATH to its volume shop path
  // (e.g. /var/lib/pterodactyl/volumes/<dev-uuid>/profile/profile/eiry/reforgedz-dotnet-shop).
  const naDev = (process.env.GAME_SERVER_NA_DEV_PATH || '').trim();

  const all = [
    { id: 'eu1', region: 'eu', host: euHost, port: euPort, user: euUser, path: eu[0] || null },
    { id: 'eu2', region: 'eu', host: euHost, port: euPort, user: euUser, path: eu[1] || null },
    { id: 'eu3', region: 'eu3', host: eu3Host, port: eu3Port, user: eu3User, path: eu3[0] || null },
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

// Servers the shop sells and syncs to. Sync must NOT touch eu3 any more, so it
// stays filtered to SERVER_IDS.
function listServers() {
  return listAllServers().filter(s => SERVER_IDS.includes(s.id));
}

// Resolves against every reachable server so admin tooling can still act on eu3.
function getServer(id) {
  return listAllServers().find(s => s.id === id) || null;
}

// Purchase / priority-queue validation: only sellable servers.
function isValidServerId(id) {
  return SERVER_IDS.includes(id);
}

// Admin save-tooling validation: any reachable server, eu3 included.
function isSaveServerId(id) {
  return ALL_SERVER_IDS.includes(id);
}

// Save-inspector targets: everything reachable, labelled.
function listSaveServers() {
  return listAllServers().map(s => ({ id: s.id, label: SERVER_LABELS[s.id] || s.id.toUpperCase() }));
}

module.exports = { SERVER_IDS, ALL_SERVER_IDS, SERVER_LABELS, listServers, listAllServers, listSaveServers, getServer, isValidServerId, isSaveServerId, configPathFromShopPath, saveGamePathFromShopPath };

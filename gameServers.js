const SERVER_IDS = ['eu1', 'eu2', 'na1', 'na2'];
const SERVER_LABELS = { eu1: 'EU1', eu2: 'EU2', na1: 'NA1', na2: 'NA2' };

function listServers() {
  const eu = (process.env.GAME_SERVER_EU_PATHS || '').split(',').map(s => s.trim()).filter(Boolean);
  const na = (process.env.GAME_SERVER_NA_PATHS || '').split(',').map(s => s.trim()).filter(Boolean);
  const euHost = process.env.GAME_SERVER_EU_HOST;
  const naHost = process.env.GAME_SERVER_NA_HOST;
  const euPort = parseInt(process.env.GAME_SERVER_EU_PORT) || 22;
  const naPort = parseInt(process.env.GAME_SERVER_NA_PORT) || 22;
  const euUser = process.env.GAME_SERVER_EU_USER || 'root';
  const naUser = process.env.GAME_SERVER_NA_USER || 'root';

  const all = [
    { id: 'eu1', region: 'eu', host: euHost, port: euPort, user: euUser, path: eu[0] || null },
    { id: 'eu2', region: 'eu', host: euHost, port: euPort, user: euUser, path: eu[1] || null },
    { id: 'na1', region: 'na', host: naHost, port: naPort, user: naUser, path: na[0] || null },
    { id: 'na2', region: 'na', host: naHost, port: naPort, user: naUser, path: na[1] || null },
  ];
  return all.filter(s => s.host && s.path);
}

function getServer(id) {
  return listServers().find(s => s.id === id) || null;
}

function isValidServerId(id) {
  return SERVER_IDS.includes(id);
}

module.exports = { SERVER_IDS, SERVER_LABELS, listServers, getServer, isValidServerId };

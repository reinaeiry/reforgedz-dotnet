// A2S_INFO: the Steam query every Reforger server answers on its query port (config.json "a2s").
// One UDP packet each way (two when the server asks for a challenge), so the homepage's player
// counts come straight from the servers - the number the in-game server browser shows - with no
// third party in between.
const dgram = require('dgram');

const REQUEST = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from('Source Engine Query\0', 'latin1')]);

function parseInfo(buf) {
  if (buf.length < 6 || buf.readInt32LE(0) !== -1 || buf[4] !== 0x49) throw new Error('a2s_not_an_info_reply');
  let o = 6; // header (4) + type (1) + protocol (1)
  const str = () => {
    const end = buf.indexOf(0, o);
    if (end === -1) throw new Error('a2s_truncated');
    const s = buf.toString('utf8', o, end);
    o = end + 1;
    return s;
  };
  const name = str();
  const map = str();
  str(); // folder
  str(); // game
  o += 2; // app id
  if (o + 3 > buf.length) throw new Error('a2s_truncated');
  return { name, map, players: buf[o], maxPlayers: buf[o + 1], bots: buf[o + 2] };
}

function queryInfo(host, port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => done(new Error('a2s_timeout')), timeoutMs);
    sock.on('error', (e) => done(e));
    sock.on('message', (msg) => {
      if (msg.length >= 9 && msg.readInt32LE(0) === -1 && msg[4] === 0x41) {
        // a challenge: repeat the request with its 4 bytes appended
        sock.send(Buffer.concat([REQUEST, msg.subarray(5, 9)]), port, host);
        return;
      }
      try { done(null, parseInfo(msg)); } catch (e) { done(e); }
    });
    sock.send(REQUEST, port, host, (e) => { if (e) done(e); });
  });
}

module.exports = { parseInfo, queryInfo };

// Upload a local file by piping base64 through an SSH exec stdin (no SFTP, no
// arg-length limit). RZ_HOST/RZ_PORT/RZ_USER/RZ_PASS + RZ_LOCAL + RZ_REMOTE.
const { Client } = require('ssh2');
const fs = require('fs');
const b64 = fs.readFileSync(process.env.RZ_LOCAL).toString('base64');
const remote = process.env.RZ_REMOTE;
console.log('local b64 chars:', b64.length, '-> connecting...');
const conn = new Client();
conn.on('ready', () => {
  console.log('SSH ready, exec base64 decode...');
  conn.exec(`base64 -d > '${remote}'`, (err, stream) => {
    if (err) { console.error('EXEC_ERR ' + err.message); process.exit(3); }
    let errOut = '';
    stream.stderr.on('data', d => errOut += d.toString());
    stream.on('close', (code) => {
      if (code === 0) console.error(`[uploaded ${b64.length} b64 chars -> ${remote}]`);
      else console.error('REMOTE_EXIT ' + code + ' ' + errOut.trim());
      conn.end();
      process.exit(code === 0 ? 0 : 5);
    });
    stream.end(b64);
  });
});
conn.on('error', e => { console.error('CONN_ERR ' + e.message); process.exit(2); });
conn.connect({
  host: process.env.RZ_HOST, port: parseInt(process.env.RZ_PORT || '22', 10),
  username: process.env.RZ_USER || 'root', password: process.env.RZ_PASS,
  readyTimeout: 15000, hostVerifier: () => true,
});

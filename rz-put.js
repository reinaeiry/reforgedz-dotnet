// Scratch SFTP uploader. Reads RZ_HOST/RZ_PORT/RZ_USER/RZ_PASS + RZ_LOCAL + RZ_REMOTE.
const { Client } = require('ssh2');
const fs = require('fs');
const conn = new Client();
conn.on('ready', () => {
  let data;
  try { data = fs.readFileSync(process.env.RZ_LOCAL); }
  catch (e) { console.error('LOCAL_READ_ERR ' + e.message); conn.end(); process.exit(4); }
  conn.sftp((err, sftp) => {
    if (err) { console.error('SFTP_ERR ' + err.message); process.exit(2); }
    const ws = sftp.createWriteStream(process.env.RZ_REMOTE);
    ws.on('error', (e) => { console.error('PUT_ERR ' + e.message); conn.end(); process.exit(3); });
    ws.on('close', () => {
      console.error(`[uploaded ${data.length} bytes -> ${process.env.RZ_REMOTE}]`);
      conn.end();
      process.exit(0);
    });
    ws.end(data);
  });
});
conn.on('error', e => { console.error('CONN_ERR ' + e.message); process.exit(2); });
conn.connect({
  host: process.env.RZ_HOST,
  port: parseInt(process.env.RZ_PORT || '22', 10),
  username: process.env.RZ_USER || 'root',
  password: process.env.RZ_PASS,
  readyTimeout: 15000,
  hostVerifier: () => true,
});

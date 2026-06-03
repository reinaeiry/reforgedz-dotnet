// Upload a local file by appending base64 chunks via small exec commands over
// one SSH connection (no large stdin, no SFTP). base64 alphabet has no quotes,
// so single-quoting each chunk is safe. RZ_HOST/RZ_USER/RZ_PASS/RZ_LOCAL/RZ_REMOTE.
const { Client } = require('ssh2');
const fs = require('fs');
const b64 = fs.readFileSync(process.env.RZ_LOCAL).toString('base64');
const remote = process.env.RZ_REMOTE;
const CHUNK = 20000;
const chunks = [];
for (let i = 0; i < b64.length; i += CHUNK) chunks.push(b64.slice(i, i + CHUNK));

const conn = new Client();
function run(cmd) {
  return new Promise((res, rej) => {
    conn.exec(cmd, (e, s) => {
      if (e) return rej(e);
      let err = '';
      s.stderr.on('data', d => err += d.toString());
      s.on('close', c => c === 0 ? res() : rej(new Error('exit ' + c + ' ' + err.trim())));
      s.resume();
    });
  });
}
conn.on('ready', async () => {
  try {
    await run(`rm -f '${remote}.b64'`);
    for (let i = 0; i < chunks.length; i++) {
      await run(`printf '%s' '${chunks[i]}' >> '${remote}.b64'`);
      console.log('chunk', i + 1, '/', chunks.length);
    }
    await run(`base64 -d '${remote}.b64' > '${remote}' && rm -f '${remote}.b64'`);
    console.log('DONE ->', remote);
    conn.end(); process.exit(0);
  } catch (e) { console.error('ERR ' + e.message); conn.end(); process.exit(5); }
});
conn.on('error', e => { console.error('CONN_ERR ' + e.message); process.exit(2); });
conn.connect({ host: process.env.RZ_HOST, port: 22, username: 'root', password: process.env.RZ_PASS, readyTimeout: 15000, hostVerifier: () => true });

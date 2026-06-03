// Scratch SSH driver for new-box setup. NOT part of the app. Safe to delete.
// Reads connection + command from env so secrets never hit argv/shell history.
//   RZ_HOST, RZ_PORT(=22), RZ_USER, RZ_PASS or RZ_KEY(path), RZ_CMD
//   RZ_EXPECT_FP = comma-separated base64 SHA256 host-key fingerprints to require
//   RZ_TIMEOUT_MS (default 30000 for command, 15000 for connect)
const { Client } = require('ssh2');
const crypto = require('crypto');
const fs = require('fs');

const host = process.env.RZ_HOST;
const port = parseInt(process.env.RZ_PORT || '22', 10);
const username = process.env.RZ_USER || 'root';
const password = process.env.RZ_PASS || undefined;
const keyPath = process.env.RZ_KEY || undefined;
const cmd = process.env.RZ_CMD || 'echo no-cmd';
const expectFp = (process.env.RZ_EXPECT_FP || '').split(',').map(s => s.trim()).filter(Boolean);
const cmdTimeout = parseInt(process.env.RZ_TIMEOUT_MS || '30000', 10);

function fp(keyBuf) {
  // SSH-style: base64(sha256(key)) with trailing '=' stripped
  return crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}

const conn = new Client();
let verified = expectFp.length === 0; // if no expectation given, accept (but report fp)

conn.on('ready', () => {
  conn.exec(cmd, (err, stream) => {
    if (err) { console.error('EXEC_ERR ' + err.message); process.exit(3); }
    let out = '', errOut = '';
    const t = setTimeout(() => { console.error('CMD_TIMEOUT'); conn.end(); process.exit(4); }, cmdTimeout);
    stream.on('close', (code) => {
      clearTimeout(t);
      process.stdout.write(out);
      if (errOut) process.stderr.write('\n[stderr]\n' + errOut);
      console.error('\n[exit ' + code + ']');
      conn.end();
      process.exit(code === 0 ? 0 : 10);
    });
    stream.on('data', d => out += d.toString());
    stream.stderr.on('data', d => errOut += d.toString());
  });
});

conn.on('error', e => { console.error('CONN_ERR ' + e.message); process.exit(2); });

const cfg = {
  host, port, username,
  readyTimeout: 15000,
  hostVerifier: (keyBuf) => {
    const got = fp(keyBuf);
    console.error('[host-key SHA256] ' + got);
    if (expectFp.length === 0) return true;
    const ok = expectFp.includes(got);
    if (!ok) console.error('[host-key MISMATCH] expected one of: ' + expectFp.join(', '));
    verified = ok;
    return ok;
  }
};
if (keyPath) cfg.privateKey = fs.readFileSync(keyPath);
else if (password) cfg.password = password;

conn.connect(cfg);

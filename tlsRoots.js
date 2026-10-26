// Which certificate authorities this process trusts, set before anything connects anywhere.
//
// In October 2026 the private keys of eight eMudhra issuing CAs leaked. Node 25 is past end of life and still trusts
// "emSign ECC Root CA - G3", which vouches for those CAs through a cross-signed certificate, so anyone who can sit on
// the network path to PayPal, Discord, Steam, the panel, R2 or the mail server could pass as that site with a
// certificate made from the leaked keys. The fixed Node lines (24.22.1, 22.23.4, 26.12.1, Mozilla NSS 3.131.1) stop
// trusting that root and two more emSign roots that eMudhra itself retired in the same release (Root CA - C1 and ECC
// Root CA - C3). This removes the same three here until the shop runs on a fixed Node line, where it finds none of
// them and changes nothing. emSign Root CA - G1 stays trusted, as it does there.
//
// tls.setDefaultCACertificates() replaces the trust list for every later TLS connection in this thread that does not
// name its own CAs: fetch() (PayPal, Discord, the panel, R2, exchange rates), https (Steam sign-in through openid and
// axios) and nodemailer's STARTTLS. Connections opened before it keep the old list, so this is the first require in
// server.js and in the tools that run on their own. Roots are matched by SHA-256 fingerprint, never by name. On a
// Node without the API, or if anything here throws, the shop keeps Node's own list and says so in the log: the filter
// must never stop the shop from starting.
const tls = require('tls');
const { X509Certificate } = require('crypto');

// SHA-256 fingerprint (hex, no colons) -> name, of each root to stop trusting.
const DISTRUSTED = new Map([
  ['86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B', 'emSign ECC Root CA - G3'],
  ['125609AA301DA0A249B97A8239CB6A34216F44DCAC9F3954B14292F2E8C8608F', 'emSign Root CA - C1'],
  ['BC4D809B15189D78DB3E1D8CF4F9726A795DA1643CA5F1358E1DDB0EDC0D7EB3', 'emSign ECC Root CA - C3'],
]);

function fingerprint(pem) {
  try {
    return new X509Certificate(pem).fingerprint256.replace(/:/g, '').toUpperCase();
  } catch {
    return null; // a certificate we cannot read is kept, never dropped by guesswork
  }
}

function distrustedIn(list) {
  return list.filter((pem) => DISTRUSTED.has(fingerprint(pem))).length;
}

// Removes the distrusted roots from this thread's default trust list and logs one line. Never throws.
// Returns { applied, before, after, removed, left } for the tests and the doctor.
function applyRootFilter() {
  if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') {
    console.warn(`[tls] Node ${process.version} cannot change its trusted roots; all of Node's own roots stay trusted`);
    return { applied: false, removed: [] };
  }
  let before;
  const kept = [];
  const removed = [];
  try {
    before = tls.getCACertificates('default');
    for (const pem of before) {
      const name = DISTRUSTED.get(fingerprint(pem));
      if (name) removed.push(name);
      else kept.push(pem);
    }
    if (!removed.length) {
      console.log(`[tls] trusted roots ${before.length}: none of the distrusted emSign roots is among them, nothing removed`);
      return { applied: false, before: before.length, after: before.length, removed, left: 0 };
    }
    if (!kept.length) throw new Error('no other root would be left to trust');
    tls.setDefaultCACertificates(kept);
  } catch (e) {
    console.error(`[tls] could not remove the distrusted emSign roots (${e && e.message}); all of Node's own roots stay trusted`);
    return { applied: false, removed: [], error: e && e.message };
  }
  // Read the list back: the count in the log is what Node will use, not what we asked for.
  let after = null;
  let left = null;
  try {
    const now = tls.getCACertificates('default');
    after = now.length;
    left = distrustedIn(now);
  } catch { /* reported below as unknown */ }
  const applied = after === kept.length && left === 0;
  const line = `[tls] trusted roots ${before.length} -> ${after === null ? '?' : after}: removed ${removed.join(', ')}`;
  if (applied) console.log(line);
  else console.error(`${line}; WARNING the read-back shows ${left === null ? 'an unknown number of' : left} distrusted root(s) still trusted`);
  return { applied, before: before.length, after, removed, left };
}

const result = applyRootFilter();

module.exports = { DISTRUSTED, applyRootFilter, result };

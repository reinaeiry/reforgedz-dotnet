// Passphrase encryption for the .env inside a pack. AES-256-GCM with a scrypt
// key; nothing here needs a dependency, and the output is a small JSON document
// that restore.js can open with the same passphrase on any machine.
const crypto = require('crypto');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, SCRYPT);
}

function encrypt(plaintext, passphrase) {
  if (!passphrase || String(passphrase).length < 12) throw new Error('Passphrase must be at least 12 characters');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1, alg: 'aes-256-gcm', kdf: 'scrypt', n: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64')
  };
}

function decrypt(box, passphrase) {
  if (!box || box.v !== 1 || box.alg !== 'aes-256-gcm') throw new Error('Unrecognised secret box');
  const salt = Buffer.from(box.salt, 'base64');
  const key = crypto.scryptSync(String(passphrase), salt, 32, { N: box.n, r: box.r, p: box.p, maxmem: SCRYPT.maxmem });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]);
  } catch {
    throw new Error('Wrong passphrase, or the pack was altered');
  }
}

// A passphrase the owner can read back from a password manager: six words
// from a fixed list plus digits is memorable; here we favour strength and
// keep it typeable: 28 characters of unambiguous base32.
function generatePassphrase() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(28);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i % 7 === 6 && i < bytes.length - 1) out += '-';
  }
  return out;
}

module.exports = { encrypt, decrypt, generatePassphrase };

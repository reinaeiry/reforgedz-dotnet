// Cloudflare R2 through its S3-compatible API, with a hand-rolled SigV4 so the
// shop does not take on the AWS SDK for three calls (put, list, delete). Region
// is always "auto" on R2; the endpoint is <account>.r2.cloudflarestorage.com.
const crypto = require('crypto');

function cfg() {
  const accountId = process.env.R2_ACCOUNT_ID || '';
  const bucket = process.env.R2_BUCKET || '';
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
  const prefix = (process.env.R2_PREFIX || 'shop/').replace(/^\/+/, '');
  return { accountId, bucket, accessKeyId, secretAccessKey, prefix, host: `${accountId}.r2.cloudflarestorage.com` };
}

function isConfigured() {
  const c = cfg();
  return !!(c.accountId && c.bucket && c.accessKeyId && c.secretAccessKey);
}

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// RFC 3986 encoding of a key path, keeping "/" as a separator.
function encodeKey(key) {
  return key.split('/').map(seg => encodeURIComponent(seg).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

function amzDates(d = new Date()) {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

async function signedFetch(method, key, { body = null, query = '', contentType = null, timeoutMs = 60000 } = {}) {
  const c = cfg();
  if (!isConfigured()) throw new Error('R2 not configured (R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
  const { amzDate, dateStamp } = amzDates();
  const path = `/${c.bucket}${key ? '/' + encodeKey(key) : ''}`;
  const payloadHash = sha256hex(body || Buffer.alloc(0));
  const headers = {
    host: c.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  };
  if (contentType) headers['content-type'] = contentType;
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map(h => `${h}:${headers[h]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + c.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, 'auto');
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${c.host}${path}${query ? '?' + query : ''}`, {
      method, headers, body: body || undefined, signal: ctrl.signal
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`R2 ${method} ${key || ''} -> ${res.status}: ${text.slice(0, 200)}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function putObject(key, body, contentType = 'application/octet-stream') {
  const c = cfg();
  await signedFetch('PUT', c.prefix + key, { body, contentType });
  return c.prefix + key;
}

async function deleteObject(fullKey) {
  await signedFetch('DELETE', fullKey);
}

// Objects under the prefix, newest first: [{ key, size, lastModified }].
async function listObjects() {
  const c = cfg();
  const query = `list-type=2&prefix=${encodeURIComponent(c.prefix).replace(/%2F/g, '%2F')}`;
  const xml = await signedFetch('GET', '', { query });
  const out = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const key = (block.match(/<Key>([^<]+)<\/Key>/) || [])[1];
    const size = parseInt((block.match(/<Size>(\d+)<\/Size>/) || [])[1] || '0', 10);
    const lastModified = (block.match(/<LastModified>([^<]+)<\/LastModified>/) || [])[1];
    if (key) out.push({ key: key.replace(/&amp;/g, '&'), size, lastModified: lastModified ? new Date(lastModified) : null });
  }
  out.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
  return out;
}

module.exports = { isConfigured, putObject, deleteObject, listObjects, cfg };

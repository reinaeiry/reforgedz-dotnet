// Tests for Steam sign-in (lib/steam-signin.js): the account, and admin rights, come only from the SteamID in Steam's
// verified OpenID identifier; the persona name and avatar only from an HTTPS Web API answer about that same SteamID;
// passport-steam's own profile lookup (steam-web: plain HTTP to port 80, the key in the query string) never runs.
// Against the REAL schema: db.js is loaded with DATA_DIR pointed at a throwaway folder. Every sign-in goes through the
// passport-steam strategy server.js registers. Only Steam's confirmation of the assertion is stood in for (the
// relying party reports the identifier as verified, which is what Steam does for a real login); fetch is replaced,
// and so is plain http, which answers the way someone on the network path would: with an admin's SteamID.
// Needs better-sqlite3, so run it where the shop's node_modules are.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-steam-'));
process.env.DATA_DIR = dataDir;

const logged = [];
const quiet = { error: console.error, warn: console.warn, log: console.log };
console.log = (...a) => { logged.push(a.map(String).join(' ')); };
console.warn = console.log;
console.error = console.log;
const db = require('../db');
const SteamWeb = require('steam-web');
const { DEFAULT_PERSONA } = require('../webAuth');
const signin = require('../lib/steam-signin');

const KEY = 'test-steam-key-0123456789abcdef';
const ADMIN = '76561198000000999';
const idUrl = (id) => `https://steamcommunity.com/openid/id/${id}`;
let seq = 100;
const newId = () => `765611980000${String(++seq).padStart(5, '0')}`;
const row = (id) => db.prepare('SELECT * FROM users WHERE steam_id = ?').get(id);

// Plain HTTP answers as an attacker on the path would: a profile for the admin, whoever asked.
const plainHttp = [];
const realHttp = { get: http.get, request: http.request };
function onPath(options, cb) {
  plainHttp.push(typeof options === 'string' ? options : `${options.host || options.hostname}:${options.port}${options.path || ''}`);
  const res = new PassThrough();
  res.statusCode = 200;
  const req = new EventEmitter();
  req.end = () => req;
  req.write = () => true;
  req.setTimeout = () => req;
  req.destroy = () => req;
  process.nextTick(() => {
    if (cb) cb(res);
    res.end(JSON.stringify({ response: { players: [{ steamid: ADMIN, personaname: 'Not the one who signed in', avatarfull: 'https://avatars.example/admin.jpg' }] } }));
  });
  return req;
}
http.get = onPath;
http.request = onPath;

const steamWebCalls = [];
const realMakeRequest = SteamWeb.prototype.makeRequest;
SteamWeb.prototype.makeRequest = function (obj) {
  steamWebCalls.push(String(obj && obj.path));
  return realMakeRequest.call(this, obj);
};

const fetchCalls = [];
const realFetch = global.fetch;
let webApi = async () => { throw new Error('no Web API answer set'); };
global.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), opts: opts || {} });
  return webApi(String(url), opts || {});
};

function answer(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function summary(id, over = {}) {
  return {
    steamid: id, personaname: `Player ${id.slice(-3)}`,
    avatar: `https://avatars.example/${id}.jpg`,
    avatarmedium: `https://avatars.example/${id}_medium.jpg`,
    avatarfull: `https://avatars.example/${id}_full.jpg`,
    ...over
  };
}
// The Web API answering, over HTTPS, about whichever SteamID it was asked for.
const genuine = (over = {}) => async (url) => answer(200, { response: { players: [summary(new URL(url).searchParams.get('steamids'), over)] } });

function strategy(opts = {}) {
  return signin.steamStrategy({ baseUrl: 'https://shop.test', db, adminIds: [ADMIN], apiKey: KEY, ...opts });
}

// One Steam callback through the strategy, resolved with what passport would be told.
function signIn(strat, identifier) {
  return new Promise((resolve) => {
    strat._relyingParty.verifyAssertion = (url, cb) => cb(null, { authenticated: true, claimedIdentifier: identifier });
    strat.success = (user) => resolve({ user });
    strat.fail = (info) => resolve({ fail: info || {} });
    strat.error = (err) => resolve({ error: err });
    strat.redirect = (url) => resolve({ redirect: url });
    const query = {
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'id_res',
      'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
      'openid.claimed_id': identifier,
      'openid.identity': identifier,
      'openid.return_to': 'https://shop.test/auth/steam/callback'
    };
    strat.authenticate({ method: 'GET', headers: {}, query, url: '/auth/steam/callback?' + new URLSearchParams(query) });
  });
}

test.beforeEach(() => {
  logged.length = 0;
  plainHttp.length = 0;
  steamWebCalls.length = 0;
  fetchCalls.length = 0;
  webApi = async () => { throw new Error('no Web API answer set'); };
});

test.after(() => {
  Object.assign(console, quiet);
  http.get = realHttp.get;
  http.request = realHttp.request;
  SteamWeb.prototype.makeRequest = realMakeRequest;
  global.fetch = realFetch;
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('steamIdFromIdentifier takes the 17 digits of an https Steam ID URL and nothing else', () => {
  const f = signin.steamIdFromIdentifier;
  const ID = '76561198000000101';
  assert.equal(f(`https://steamcommunity.com/openid/id/${ID}`), ID);
  // passport-steam refuses an http:// claimed_id before the callback; this refuses it too.
  assert.equal(f(`http://steamcommunity.com/openid/id/${ID}`), null);
  const arabicDigits = ID.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
  for (const bad of [
    `https://steamcommunity.com.evil.example/openid/id/${ID}`,
    `https://evil.example/openid/id/${ID}`,
    `https://evil.example/?https://steamcommunity.com/openid/id/${ID}`,
    `https://user@steamcommunity.com/openid/id/${ID}`,
    `https://steamcommunity.com:8443/openid/id/${ID}`,
    `https://STEAMCOMMUNITY.COM/openid/id/${ID}`,
    `HTTPS://steamcommunity.com/openid/id/${ID}`,
    `https://steamcommunity.com/openid/id/${ID.slice(1)}`,
    `https://steamcommunity.com/openid/id/${ID}0`,
    'https://steamcommunity.com/openid/id/',
    `https://steamcommunity.com/openid/id/${ID}/`,
    `https://steamcommunity.com/openid/id/${ID}?x=1`,
    `https://steamcommunity.com/openid/id/${ID}#x`,
    `https://steamcommunity.com/openid/id/${ID}\n`,
    `https://steamcommunity.com/openid/id/${ID} `,
    ` https://steamcommunity.com/openid/id/${ID}`,
    `https://steamcommunity.com/openid/id/${ID}/../${ADMIN}`,
    `https://steamcommunity.com/openid/id//${ID}`,
    `https://steamcommunity.com/openid/ID/${ID}`,
    `https://steamcommunity.com/openid/id/${arabicDigits}`,
    ''
  ]) assert.equal(f(bad), null, JSON.stringify(bad));
  for (const bad of [undefined, null, 76561198000000101, [`https://steamcommunity.com/openid/id/${ID}`], { toString: () => `https://steamcommunity.com/openid/id/${ID}` }]) {
    assert.equal(f(bad), null, String(bad));
  }
});

test('passport-steam runs without its own profile lookup', () => {
  const s = strategy();
  assert.equal(s.name, 'steam');
  // passport-openid keeps the profile option and asks Steam for SREG/AX fields only when it is on.
  assert.equal(s._profile, false);
  assert.deepEqual(s._relyingParty.extensions, []);
});

test('the account is the identifier\'s SteamID, plain HTTP and steam-web are never used', async () => {
  const id = newId();
  webApi = genuine();
  const r = await signIn(strategy(), idUrl(id));
  assert.ok(r.user, JSON.stringify(r));
  assert.equal(r.user.steam_id, id);
  assert.equal(r.user.role, 'user');
  assert.equal(r.user.persona, `Player ${id.slice(-3)}`);
  assert.equal(r.user.avatar_url, `https://avatars.example/${id}_full.jpg`);
  assert.deepEqual(plainHttp, []);
  assert.deepEqual(steamWebCalls, []);
});

test('the Web API is asked once, over HTTPS, for exactly that SteamID, with a timeout', async () => {
  const id = newId();
  webApi = genuine();
  await signIn(strategy(), idUrl(id));
  assert.equal(fetchCalls.length, 1);
  const u = new URL(fetchCalls[0].url);
  assert.equal(u.protocol, 'https:');
  assert.equal(u.host, 'api.steampowered.com');
  assert.equal(u.pathname, '/ISteamUser/GetPlayerSummaries/v2/');
  assert.equal(u.searchParams.get('steamids'), id);
  assert.equal(u.searchParams.get('key'), KEY);
  assert.ok(fetchCalls[0].opts.signal instanceof AbortSignal);
  assert.equal(fetchCalls[0].opts.redirect, 'error');
  assert.ok(signin.PROFILE_TIMEOUT_MS > 0 && signin.PROFILE_TIMEOUT_MS <= 5000);
});

test('an answer about another SteamID is never used: not as the account, not for admin, not for the name', async () => {
  const id = newId();
  const adminBefore = row(ADMIN);
  webApi = async () => answer(200, { response: { players: [summary(ADMIN, { personaname: 'Admin' })] } });
  const r = await signIn(strategy(), idUrl(id));
  assert.equal(r.user.steam_id, id);
  assert.equal(r.user.role, 'user');
  assert.equal(r.user.persona, DEFAULT_PERSONA);
  assert.equal(r.user.avatar_url, null);
  assert.deepEqual(row(ADMIN), adminBefore);
  assert.ok(logged.includes(`[auth] Steam sign-in ${id}: Steam profile not used (the answer was about another SteamID); new account starts as ${DEFAULT_PERSONA}`), logged.join(' | '));
  // An account that already has a name keeps it.
  webApi = genuine({ personaname: 'Kept' });
  await signIn(strategy(), idUrl(id));
  webApi = async () => answer(200, { response: { players: [summary(ADMIN, { personaname: 'Admin' })] } });
  const again = await signIn(strategy(), idUrl(id));
  assert.equal(again.user.persona, 'Kept');
  assert.equal(again.user.avatar_url, `https://avatars.example/${id}_full.jpg`);
});

test('admin rights come only from the identifier\'s SteamID', async () => {
  webApi = genuine();
  const asAdmin = await signIn(strategy(), idUrl(ADMIN));
  assert.equal(asAdmin.user.steam_id, ADMIN);
  assert.equal(asAdmin.user.role, 'admin');
  // Someone else, while both answers name the admin: plain HTTP (never asked) and the Web API (ignored).
  const id = newId();
  webApi = async () => answer(200, { response: { players: [summary(ADMIN)] } });
  const other = await signIn(strategy(), idUrl(id));
  assert.equal(other.user.steam_id, id);
  assert.equal(other.user.role, 'user');
  assert.deepEqual(plainHttp, []);
  // The admin stays admin while the Web API is down.
  webApi = async () => { throw new TypeError('fetch failed'); };
  const again = await signIn(strategy(), idUrl(ADMIN));
  assert.equal(again.user.role, 'admin');
  // Someone taken off ADMIN_STEAM_IDS is written back as a user at the next sign-in, as before.
  webApi = genuine();
  const removed = await signIn(strategy({ adminIds: [] }), idUrl(ADMIN));
  assert.equal(removed.user.role, 'user');
});

test('the Web API down, refusing or unreadable: sign-in completes, stored name and avatar kept', async () => {
  const id = newId();
  webApi = genuine({ personaname: 'Stored Name' });
  await signIn(strategy(), idUrl(id));
  const cases = [
    ['down', async () => { throw new TypeError('fetch failed'); }, 'Web API unreachable or unreadable'],
    ['503', async () => answer(503, { error: 'busy' }), 'Web API answered 503'],
    ['403', async () => answer(403, {}), 'Web API answered 403'],
    ['not JSON', async () => new Response('<html>busy</html>', { status: 200 }), 'Web API unreachable or unreadable'],
    ['no players', async () => answer(200, { response: { players: [] } }), 'no such player in the answer'],
    ['no response', async () => answer(200, {}), 'unreadable answer'],
    ['no name', async (url) => answer(200, { response: { players: [summary(new URL(url).searchParams.get('steamids'), { personaname: ' ' })] } }), 'no persona name in the answer']
  ];
  for (const [name, handler, reason] of cases) {
    webApi = handler;
    logged.length = 0;
    const r = await signIn(strategy(), idUrl(id));
    assert.equal(r.user && r.user.steam_id, id, name);
    assert.equal(r.user.persona, 'Stored Name', name);
    assert.equal(r.user.avatar_url, `https://avatars.example/${id}_full.jpg`, name);
    assert.ok(logged.includes(`[auth] Steam sign-in ${id}: Steam profile not used (${reason}); stored name and avatar kept`), `${name}: ${logged.join(' | ')}`);
  }
  // A new account while the Web API is down starts as Player, without an avatar.
  const fresh = newId();
  webApi = async () => { throw new TypeError('fetch failed'); };
  const r = await signIn(strategy(), idUrl(fresh));
  assert.equal(r.user.steam_id, fresh);
  assert.equal(r.user.persona, DEFAULT_PERSONA);
  assert.equal(r.user.avatar_url, null);
});

test('a Web API that never answers costs at most the timeout', async () => {
  const id = newId();
  webApi = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
  });
  const t0 = Date.now();
  const r = await signIn(strategy({ timeoutMs: 50 }), idUrl(id));
  const ms = Date.now() - t0;
  assert.equal(r.user && r.user.steam_id, id);
  assert.equal(r.user.persona, DEFAULT_PERSONA);
  assert.ok(ms < 2000, `took ${ms} ms`);
  assert.ok(logged.some((l) => l.includes('(no answer in 50 ms)')), logged.join(' | '));
});

test('no STEAM_API_KEY: no request at all, and sign-in still completes', async () => {
  const id = newId();
  const r = await signIn(strategy({ apiKey: undefined }), idUrl(id));
  assert.equal(r.user && r.user.steam_id, id);
  assert.equal(fetchCalls.length, 0);
  assert.deepEqual(plainHttp, []);
  assert.ok(logged.includes(`[auth] Steam sign-in ${id}: Steam profile not used (STEAM_API_KEY not set); new account starts as ${DEFAULT_PERSONA}`), logged.join(' | '));
});

test('a confirmed identifier that is not exactly a Steam ID signs nobody in', async () => {
  // passport-steam's own pattern takes any number of digits; the account needs 17.
  const r = await signIn(strategy(), 'https://steamcommunity.com/openid/id/123');
  assert.ok(r.fail, JSON.stringify(r));
  assert.equal(row('123'), undefined);
  // An http:// claimed_id is refused by passport-steam before the callback runs.
  const h = await signIn(strategy(), `http://steamcommunity.com/openid/id/${newId()}`);
  assert.ok(h.fail, JSON.stringify(h));
  // The verify callback on its own, for what passport-steam would never pass it.
  const verify = signin.makeSteamVerify({ db, adminIds: [ADMIN], apiKey: KEY });
  for (const bad of [undefined, `https://evil.example/openid/id/${ADMIN}`, `http://steamcommunity.com/openid/id/${ADMIN}`]) {
    const out = await new Promise((resolve) => verify(bad, {}, (err, user, info) => resolve({ err, user, info })));
    assert.equal(out.err, null);
    assert.equal(out.user, false);
  }
  assert.equal(fetchCalls.length, 0);
  assert.deepEqual(plainHttp, []);
});

test('the sign-in log line names the SteamID and where the name came from, never the key, the URL or the name', async () => {
  const id = newId();
  webApi = genuine({ personaname: 'Visible<Name>' });
  await signIn(strategy(), idUrl(id));
  assert.deepEqual(logged, [`[auth] Steam sign-in ${id}: name and avatar from Steam`]);
  webApi = async () => answer(403, {});
  await signIn(strategy(), idUrl(id));
  assert.equal(logged.length, 2);
  for (const l of logged) {
    assert.ok(!l.includes(KEY), l);
    assert.ok(!l.includes('key='), l);
    assert.ok(!l.includes('api.steampowered.com'), l);
    assert.ok(!l.includes('Visible'), l);
  }
});

test('what an answer about the right SteamID may set: a clean name and an https avatar', async () => {
  const id = newId();
  webApi = genuine({ personaname: '  Na\u0000me\n\u001b[31m\u0085\u009b  ', avatarfull: 'http://avatars.example/x.jpg' });
  assert.deepEqual(await signin.fetchSteamProfile(id, { apiKey: KEY }), { ok: true, persona: 'Name[31m', avatar: `https://avatars.example/${id}_medium.jpg` });
  webApi = genuine({ personaname: '\u{1F600}'.repeat(70), avatar: undefined, avatarmedium: undefined, avatarfull: undefined });
  const long = await signin.fetchSteamProfile(id, { apiKey: KEY });
  assert.equal(Array.from(long.persona).length, 64);
  assert.ok(long.persona.isWellFormed());
  assert.equal(long.avatar, null);
  for (const personaname of ['', '   ', 42, null]) {
    webApi = genuine({ personaname });
    assert.deepEqual(await signin.fetchSteamProfile(id, { apiKey: KEY }), { ok: false, reason: 'no persona name in the answer' });
  }
  // A steamid that is a number, not Steam's string, is not "the same SteamID".
  webApi = async () => answer(200, { response: { players: [summary(id, { steamid: Number(id) })] } });
  assert.deepEqual(await signin.fetchSteamProfile(id, { apiKey: KEY }), { ok: false, reason: 'the answer was about another SteamID' });
});

test('only lib/steam-signin.js loads passport-steam, nothing loads steam-web, and server.js registers it', () => {
  const root = path.join(__dirname, '..');
  const files = [];
  for (const dir of ['.', 'lib', 'routes', 'tools', 'tools/lib']) {
    for (const f of fs.readdirSync(path.join(root, dir))) if (f.endsWith('.js')) files.push(path.join(dir, f));
  }
  assert.ok(files.length > 20, `only ${files.length} files scanned`);
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    if (path.normalize(f) !== path.normalize('lib/steam-signin.js')) assert.ok(!/require\(['"]passport-steam['"]\)/.test(src), f);
    assert.ok(!/require\(['"]steam-web['"]\)/.test(src), f);
  }
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /passport\.use\(steamStrategy\(\{ baseUrl: BASE_URL, db, adminIds: ADMIN_IDS, apiKey: process\.env\.STEAM_API_KEY \}\)\);/);
});

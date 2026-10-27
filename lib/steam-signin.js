// Steam sign-in: the account is the SteamID in Steam's verified OpenID answer, never one from a profile lookup.
//
// passport-steam looks up a profile by default (profile: true) through steam-web, and steam-web 0.4.0 sends that
// GetPlayerSummaries request over plain HTTP to api.steampowered.com:80 with STEAM_API_KEY in the query string. The
// verify callback then took the account, and the ADMIN_STEAM_IDS check, from the steamid in that unauthenticated
// answer: anyone on the network path could read the key and, after one real Steam login of their own, answer with
// any SteamID, an admin's included.
//
// steamStrategy() runs passport-steam with profile: false, so it never calls steam-web and never holds the key. The
// account is the SteamID64 at the end of the identifier, https://steamcommunity.com/openid/id/<17 digits>, which
// node-openid has had confirmed by Steam over HTTPS (lib/steam-openid-gate.js keeps those requests on Steam). Only the
// persona name and avatar come from the Web API, over HTTPS with a short timeout, and only from an answer about that
// same SteamID. When the Web API is slow, down or answers about someone else, the sign-in still completes: an existing
// account keeps the name and avatar it has, a new one starts as webAuth.DEFAULT_PERSONA ("Player", which the cards and
// emails already treat as no name) without an avatar, and the next sign-in fills them in.
const SteamStrategy = require('passport-steam').Strategy;
const { DEFAULT_PERSONA } = require('../webAuth');

const PLAYER_SUMMARIES_URL = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';
const PROFILE_TIMEOUT_MS = 4000;
// A Steam ID URL with the SteamID64 captured. https only: passport-steam itself refuses a claimed_id that does not start
// with https://steamcommunity.com/openid/id/, so an http:// one never gets this far, and this check need not allow it.
const STEAM_ID_URL = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

// The SteamID64 of a verified identifier, or null for anything that is not exactly a Steam ID URL.
function steamIdFromIdentifier(identifier) {
  if (typeof identifier !== 'string') return null;
  const m = STEAM_ID_URL.exec(identifier);
  return m ? m[1] : null;
}

// Steam caps a persona at 32 characters; control characters never belong in one and could split a log line.
function cleanPersona(v) {
  if (typeof v !== 'string') return null;
  const s = Array.from(v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()).slice(0, 64).join('');
  return s || null;
}

function httpsUrl(v) {
  return typeof v === 'string' && v.length <= 512 && v.startsWith('https://') ? v : null;
}

// { ok: true, persona, avatar } from GetPlayerSummaries over HTTPS, or { ok: false, reason }. The reason is short and
// fixed, so it is safe to log: never the URL, which carries the key, and never text from the answer.
async function fetchSteamProfile(steamId, { apiKey, timeoutMs = PROFILE_TIMEOUT_MS } = {}) {
  if (!apiKey) return { ok: false, reason: 'STEAM_API_KEY not set' };
  const url = `${PLAYER_SUMMARIES_URL}?key=${encodeURIComponent(apiKey)}&steamids=${steamId}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let body;
  try {
    // redirect: 'error' so the answer can only come from this HTTPS URL.
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'error', headers: { Accept: 'application/json' } });
    if (!res.ok) {
      if (res.body) res.body.cancel().catch(() => {}); // unread, it would hold the connection
      return { ok: false, reason: `Web API answered ${res.status}` };
    }
    body = await res.json();
  } catch (e) {
    return { ok: false, reason: ctrl.signal.aborted ? `no answer in ${timeoutMs} ms` : 'Web API unreachable or unreadable' };
  } finally {
    clearTimeout(timer);
  }
  const players = body && body.response && Array.isArray(body.response.players) ? body.response.players : null;
  if (!players) return { ok: false, reason: 'unreadable answer' };
  const mine = players.find((p) => p && p.steamid === steamId);
  if (!mine) return { ok: false, reason: players.length ? 'the answer was about another SteamID' : 'no such player in the answer' };
  const persona = cleanPersona(mine.personaname);
  if (!persona) return { ok: false, reason: 'no persona name in the answer' };
  return { ok: true, persona, avatar: httpsUrl(mine.avatarfull) || httpsUrl(mine.avatarmedium) || httpsUrl(mine.avatar) };
}

// The verify callback: (identifier, profile, done). profile is ignored: with profile: false it is only passport-openid's
// empty extension fields, and nothing about who signed in may come from it.
function makeSteamVerify({ db, adminIds, apiKey, timeoutMs = PROFILE_TIMEOUT_MS, log = console }) {
  async function signIn(steamId) {
    const found = await fetchSteamProfile(steamId, { apiKey, timeoutMs });
    const role = adminIds.includes(steamId) ? 'admin' : 'user';
    if (found.ok) {
      db.prepare(`
        INSERT INTO users (steam_id, persona, avatar_url, role) VALUES (?, ?, ?, ?)
        ON CONFLICT(steam_id) DO UPDATE SET persona = excluded.persona, avatar_url = excluded.avatar_url, role = ?
      `).run(steamId, found.persona, found.avatar, role, role);
      log.log(`[auth] Steam sign-in ${steamId}: name and avatar from Steam`);
    } else {
      const existed = !!db.prepare('SELECT 1 FROM users WHERE steam_id = ?').get(steamId);
      db.prepare(`
        INSERT INTO users (steam_id, persona, avatar_url, role) VALUES (?, ?, NULL, ?)
        ON CONFLICT(steam_id) DO UPDATE SET role = ?
      `).run(steamId, DEFAULT_PERSONA, role, role);
      const kept = existed ? 'stored name and avatar kept' : `new account starts as ${DEFAULT_PERSONA}`;
      log.warn(`[auth] Steam sign-in ${steamId}: Steam profile not used (${found.reason}); ${kept}`);
    }
    return db.prepare('SELECT * FROM users WHERE steam_id = ?').get(steamId);
  }

  return (identifier, profile, done) => {
    const steamId = steamIdFromIdentifier(identifier);
    if (!steamId) {
      log.warn('[auth] Steam sign-in refused: the verified identifier is not a Steam ID');
      return done(null, false, { message: 'Claimed identity is invalid.' });
    }
    // done runs exactly once. A throw from inside done(null, user) is not passed back to done as a failed sign-in; it
    // reaches server.js's unhandledRejection logger.
    signIn(steamId).then((user) => done(null, user), (err) => done(err));
  };
}

// What server.js registers. The key goes to makeSteamVerify only: passport-steam never sees it.
function steamStrategy({ baseUrl, db, adminIds, apiKey, timeoutMs }) {
  return new SteamStrategy({
    returnURL: baseUrl + '/auth/steam/callback',
    realm: baseUrl + '/',
    profile: false
  }, makeSteamVerify({ db, adminIds, apiKey, timeoutMs }));
}

module.exports = {
  steamStrategy, makeSteamVerify, fetchSteamProfile, steamIdFromIdentifier, PLAYER_SUMMARIES_URL, PROFILE_TIMEOUT_MS
};

// Steam sign-in talks to Steam and to nothing else.
//
// passport-steam is passport-openid with Steam's provider URL as a default, not as the only choice. Left alone, the
// request could pick the provider: /auth/steam?openid_identifier=<any URL> made this process fetch that URL and send
// the visitor to whatever login page it advertised (a phishing page behind a genuine reforgedz.net link), and a forged
// callback made it fetch openid.claimed_id and POST to openid.op_endpoint. passport-steam's own Steam checks run only
// in its verify step, after those requests have gone out, so they stopped the login but not the fetches.
//
// steamOpenidProblem(req) runs before passport on both Steam routes. It refuses any openid_identifier, and when the
// request carries an assertion (openid.mode other than cancel) it requires Steam's endpoint and Steam ID URLs, read
// the way node-openid reads them, so every request the library makes goes to steamcommunity.com.
const querystring = require('querystring');

const STEAM_OP_ENDPOINT = 'https://steamcommunity.com/openid/login';
const OPENID2_NS = 'http://specs.openid.net/auth/2.0';
// The same shape passport-steam accepts, with the host fixed and the ID a SteamID64.
const STEAM_ID_URL = /^https?:\/\/steamcommunity\.com\/openid\/id\/\d{17}$/;

// The query as node-openid sees it. It calls url.parse(req.url, true), which is querystring.parse of the text
// between the first '?' and a following '#'; Express's req.query comes from qs, which can read the same text
// differently, so the checks below use this parse, not req.query.
function assertionParams(url) {
  const s = String(url || '');
  const q = s.indexOf('?');
  if (q < 0) return {};
  let search = s.slice(q + 1);
  const h = search.indexOf('#');
  if (h >= 0) search = search.slice(0, h);
  return querystring.parse(search);
}

function isSteamIdUrl(v) {
  return typeof v === 'string' && STEAM_ID_URL.test(v);
}

// null when passport may handle the request; otherwise a short fixed reason (safe to log: it never echoes input).
function steamOpenidProblem(req) {
  const query = req.query || {};
  const body = req.body;
  if (query.openid_identifier !== undefined) return 'openid_identifier in the query';
  if (body && typeof body === 'object' && body.openid_identifier !== undefined) return 'openid_identifier in the body';

  // passport-openid decides on req.query['openid.mode']: absent starts a sign-in at Steam's provider URL, and
  // 'cancel' fails without any request. Anything else goes to node-openid's assertion check, which fetches.
  const mode = query['openid.mode'];
  if (!mode || mode === 'cancel') return null;

  const p = assertionParams(req.url);
  if (p['openid.ns'] !== OPENID2_NS) return 'openid.ns is not OpenID 2.0';
  if (p['openid.op_endpoint'] !== STEAM_OP_ENDPOINT) return 'openid.op_endpoint is not Steam';
  if (!isSteamIdUrl(p['openid.claimed_id'])) return 'openid.claimed_id is not a Steam ID';
  if (!isSteamIdUrl(p['openid.identity'])) return 'openid.identity is not a Steam ID';
  return null;
}

module.exports = { steamOpenidProblem, STEAM_OP_ENDPOINT };

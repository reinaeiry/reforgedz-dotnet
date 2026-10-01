// Tests for the gate in front of Steam sign-in (lib/steam-openid-gate.js): only Steam may be the OpenID provider.
// Needs no database or network.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const qs = require('qs');
const { steamOpenidProblem } = require('../lib/steam-openid-gate');

// A request as Express hands it to the route: req.url as sent, req.query parsed by qs the way Express 4 does.
function req(url, body = {}) {
  const i = url.indexOf('?');
  return { url, query: i < 0 ? {} : qs.parse(url.slice(i + 1)), body };
}

const ID = 'https://steamcommunity.com/openid/id/76561198000000000';
function steamCallback(over = {}) {
  const p = {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': ID,
    'openid.identity': ID,
    'openid.return_to': 'https://reforgedz.net/auth/steam/callback',
    'openid.response_nonce': '2026-10-01T12:00:00Zabc',
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'c2ln',
    ...over
  };
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  return '/auth/steam/callback?' + new URLSearchParams(p).toString();
}

test('a plain sign-in start and a ?next= pass', () => {
  assert.equal(steamOpenidProblem(req('/auth/steam')), null);
  assert.equal(steamOpenidProblem(req('/auth/steam?next=%2Faccount')), null);
});

test('a genuine Steam callback passes, and so does a cancel', () => {
  assert.equal(steamOpenidProblem(req(steamCallback())), null);
  assert.equal(steamOpenidProblem(req('/auth/steam/callback?openid.mode=cancel&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0')), null);
});

test('openid_identifier is refused in the query and in a JSON body', () => {
  assert.ok(steamOpenidProblem(req('/auth/steam?openid_identifier=https%3A%2F%2Fevil.example%2F')));
  assert.ok(steamOpenidProblem(req('/auth/steam?openid_identifier[a]=x')));
  assert.ok(steamOpenidProblem(req('/auth/steam', { openid_identifier: 'https://evil.example/' })));
  assert.ok(steamOpenidProblem(req(steamCallback({ openid_identifier: 'https://evil.example/' }))));
});

test('a callback naming another provider or identity is refused', () => {
  assert.ok(steamOpenidProblem(req(steamCallback({ 'openid.op_endpoint': 'https://evil.example/login' }))));
  assert.ok(steamOpenidProblem(req(steamCallback({ 'openid.op_endpoint': undefined }))));
  assert.ok(steamOpenidProblem(req(steamCallback({ 'openid.claimed_id': 'http://172.18.0.1:8090/' }))));
  assert.ok(steamOpenidProblem(req(steamCallback({ 'openid.claimed_id': 'https://steamcommunity.com.evil.example/openid/id/76561198000000000' }))));
  assert.ok(steamOpenidProblem(req(steamCallback({ 'openid.identity': 'https://evil.example/' }))));
  assert.ok(steamOpenidProblem(req(steamCallback({ 'openid.ns': undefined }))));
  assert.ok(steamOpenidProblem(req(steamCallback({ 'openid.claimed_id': ID + '0' }))));
});

test('an assertion on the start route is checked the same way', () => {
  const url = steamCallback({ 'openid.claimed_id': 'http://172.18.0.1:3001/' }).replace('/auth/steam/callback', '/auth/steam');
  assert.ok(steamOpenidProblem(req(url)));
});

test('a duplicated parameter is refused, whichever copy is genuine', () => {
  const url = steamCallback() + '&openid.op_endpoint=' + encodeURIComponent('https://evil.example/login');
  assert.ok(steamOpenidProblem(req(url)));
  const url2 = steamCallback() + '&openid.claimed_id=' + encodeURIComponent('http://172.18.0.1:8090/');
  assert.ok(steamOpenidProblem(req(url2)));
});

test('the checks read the URL the way node-openid does, not req.query', () => {
  // Express parses the query with qs and node-openid with querystring. Where the two could read the same URL
  // differently, only what node-openid reads counts, even when req.query looks like Steam.
  const r = req(steamCallback());
  r.query = { ...r.query };
  r.url = steamCallback({ 'openid.claimed_id': 'http://172.18.0.1:8090/' });
  assert.ok(steamOpenidProblem(r));
});

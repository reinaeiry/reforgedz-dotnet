// wiki.reforgedz.net -> the new wiki at reforgedz.net/wiki. The old MediaWiki is retired, so every request, any
// method, gets a 301: an old title that matches a page goes to that page, and the root, Main_Page and anything
// unknown go to the wiki home.
//
// Everything after https://reforgedz.net/wiki/ comes from wiki-aliases.json, never from the request, so this can
// never become an open redirect or carry an injected header. The table and the normalize rule are copied here from
// the ReforgedZ-Wiki repo (redirect/aliases.json, redirect/normalize.js) by that repo's deploy script; edit them there.
const aliases = require('./wiki-aliases.json');

const HOME = 'https://reforgedz.net/wiki/';
// MediaWiki titles are at most 255 bytes, so a URL far longer than that is not an old wiki link.
const MAX_URL = 2048;
// Only well-formed page paths are used, even from our own table.
const PAGE_PATH = /^\/wiki\/[a-z0-9-]+\/[a-z0-9-]+\/$/;

// Case is ignored; underscores, hyphens, plus signs and spaces count as one separator; any other punctuation is
// dropped. "Traders_and_Caps", "traders and caps" and "Traders-and-Caps" all become "traders-and-caps".
function normalize(title) {
  return String(title)
    .toLowerCase()
    .replace(/[\s_+-]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const byKey = new Map();
const byPath = new Map();
for (const [key, page] of Object.entries(aliases)) {
  if (!PAGE_PATH.test(page)) continue;
  byKey.set(key, page);
  byPath.set(page, page);
}

const locationOf = (page) => HOME + page.slice('/wiki/'.length);

// Bad percent-encoding keeps the raw text instead of throwing; its % signs are then dropped as punctuation.
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// The old title in any MediaWiki shape: /index.php?title=X, /index.php/X, /wiki/X or /X.
function oldTitle(url) {
  const p = url.pathname;
  if (/^\/index\.php$/i.test(p)) return url.searchParams.get('title') || '';
  if (/^\/index\.php\//i.test(p)) return safeDecode(p.slice('/index.php/'.length));
  if (/^\/wiki\//i.test(p)) return safeDecode(p.slice('/wiki/'.length));
  return safeDecode(p.slice(1));
}

// The full Location for a request URL. Pure, so it can be tested without a server.
function locationFor(requestUrl) {
  let url;
  try { url = new URL(requestUrl); } catch { return HOME; }
  if (url.pathname.length + url.search.length > MAX_URL) return HOME;
  // Already a new page path, with or without the trailing slash. The table's own string is used, not the request's.
  const samePage = byPath.get(url.pathname.toLowerCase().replace(/\/?$/, '/'));
  if (samePage) return locationOf(samePage);
  const page = byKey.get(normalize(oldTitle(url)));
  return page ? locationOf(page) : HOME;
}

module.exports = { HOME, locationFor, normalize };

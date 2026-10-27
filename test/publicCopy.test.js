// What the shop and account pages say to players, read from the files as served
// (decisions F3, F7 and G12 of 2026-10-19). These are the texts a buyer sees around
// money, so they are pinned here word for word, and the checks a reviewer would
// otherwise do by eye are done by the suite:
//   - F7: the purchase terms line sits above every button that can lead to PayPal
//     (each product card, the product box, the in-game ID box, the Custom Flag form);
//   - F3: the costs meter shows one whole-dollar total and a percentage, and names
//     no host or tool anywhere a player can see;
//   - G12: the news box exists at sign-up and on the account page with the agreed
//     wording, unticked, and no checkbox anywhere is pre-ticked in the markup.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pub = (name) => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');
const shopHtml = pub('shop.html');
const shopJs = pub('shop.js');
const accountHtml = pub('account.html');
const indexHtml = pub('index.html');
const webAuth = require('../webAuth');

const BUY_TERMS = 'By buying you accept the server rules. A ban for breaking them ends paid perks without a refund.';
const NEWS_TEXT = 'Email me ReforgedZ news (you can stop any time)';

// Count non-overlapping occurrences of `needle` in `text`.
const count = (text, needle) => text.split(needle).length - 1;

// ---- F7: the purchase terms line ----------------------------------------------

test('F7: the terms line is one constant in shop.js and goes into every product card above the buy button', () => {
  assert.equal(count(shopJs, BUY_TERMS), 1, 'the wording lives in one place');
  assert.match(shopJs, /const BUY_TERMS_TEXT = '[^']+';/);
  // The card template: terms, then the footer that holds the price and the button.
  const card = shopJs.slice(shopJs.indexOf('<div class="shop-card${inactiveClass}'), shopJs.indexOf('${adminHtml}'));
  const terms = card.indexOf('${buyTermsHtml()}');
  const footer = card.indexOf('<div class="shop-card-footer">');
  const button = card.indexOf('${buyBtnHtml}');
  assert.ok(terms > 0 && footer > terms && button > footer, 'terms sit right above the card footer with the buy button');
  // Every static copy in shop.html is filled from the same constant.
  assert.match(shopJs, /querySelectorAll\('\[data-buy-terms\]'\)/);
});

test('F7: the product box, the in-game ID box and the Custom Flag form each carry the line right above their buttons', () => {
  const placeholder = '<p class="buy-terms" data-buy-terms></p>';
  assert.equal(count(shopHtml, placeholder), 3);
  // Product box: directly before the footer with #detailBuy.
  const detail = shopHtml.indexOf('<div class="detail-footer">');
  assert.ok(detail > 0);
  assert.ok(shopHtml.lastIndexOf(placeholder, detail) > detail - 120, 'product box: the line is right above the buy footer');
  const detailBuy = shopHtml.indexOf('id="detailBuy"', detail);
  assert.ok(detailBuy > detail && detailBuy - detail < 200, 'the buy button is inside that footer');
  // In-game ID box: directly before its actions row.
  const biuid = shopHtml.indexOf('<button class="biuid-cancel" id="biuidCancel">');
  assert.ok(shopHtml.lastIndexOf(placeholder, biuid) > biuid - 160, 'in-game ID box: the line is right above the actions');
  // Custom Flag form: directly before its actions row.
  const flag = shopHtml.indexOf('<button class="biuid-cancel" id="customFlagCancel">');
  assert.ok(shopHtml.lastIndexOf(placeholder, flag) > flag - 160, 'Custom Flag form: the line is right above the actions');
  // The line is the whole wording, nothing added, no emoji.
  assert.doesNotMatch(BUY_TERMS, /[^\x20-\x7E]/);
});

// ---- F3: the costs meter ---------------------------------------------------------

test('F3: the meter shows one whole-dollar total and the percentage, from costsDollars and coveredPct only', () => {
  assert.match(shopHtml, /Server costs: <strong id="fundingCosts"><\/strong> a month/);
  assert.match(shopHtml, /id="fundingPct"/);
  const meter = shopJs.slice(shopJs.indexOf('async function loadFunding'), shopJs.indexOf('})();', shopJs.indexOf('async function loadFunding')));
  assert.match(meter, /typeof f\.costsDollars !== 'number'/, 'no total, no meter');
  assert.match(meter, /Math\.round\(f\.costsDollars\)/, 'whole dollars');
  assert.match(meter, /\$\{pct\}% covered/);
  // Nothing from the response other than the two numbers and the status is shown.
  assert.doesNotMatch(meter, /f\.(label|labels|lines|items|expenses|gross|kept|fee|vat)/);
});

test('F3: no host, tool or vendor is named anywhere a player sees', () => {
  const names = /\b(OVH|Hetzner|BattleMetrics|Pterodactyl|Cloudflare|Claude|Anthropic|Discord Nitro|RISE)\b/;
  for (const [name, text] of [['shop.html', shopHtml], ['shop.js', shopJs], ['account.html', accountHtml], ['index.html', indexHtml]]) {
    // Comments in the files are not shown; the check is on what reaches the screen,
    // so strip HTML comments and JS line comments first.
    const shown = text.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(shown, names, name);
  }
});

// ---- G12: the news box -------------------------------------------------------------

test('G12: the sign-up box has the agreed wording, shows only on the Create account tab, and is not ticked', () => {
  assert.equal(webAuth.MARKETING_TEXT, NEWS_TEXT);
  const start = shopHtml.indexOf('<label class="auth-check" id="authMarketingRow"');
  assert.ok(start > 0, 'the row exists');
  const rowHtml = shopHtml.slice(start, shopHtml.indexOf('</label>', start));
  assert.ok(rowHtml.includes(`<span>${NEWS_TEXT}</span>`), 'the exact wording');
  assert.match(rowHtml, /<input type="checkbox" id="authMarketing">/, 'a bare checkbox: no checked attribute');
  assert.doesNotMatch(rowHtml, /checked/);
  // Sign-in and the sign-in-link tab never show it; opening the box clears it.
  assert.match(shopJs, /authMarketingRow'\)\.style\.display = register \? '' : 'none'/);
  assert.match(shopJs, /authMarketing'\)\.checked = false/);
  // Sent as a boolean, and only from the sign-up.
  assert.match(shopJs, /mode === 'register' \? document\.getElementById\('authMarketing'\)\.checked === true : undefined/);
});

test('G12: the account page shows the saved choice with the same wording, ticked only when the account chose it', () => {
  assert.equal(count(accountHtml, `const NEWS_TEXT = '${NEWS_TEXT}';`), 1);
  const card = accountHtml.slice(accountHtml.indexOf('<div class="link-label">News by email</div>'), accountHtml.indexOf('id="newsHint"'));
  assert.match(card, /<input type="checkbox" id="newsOptIn"\$\{p\.marketingOptIn === true \? ' checked' : ''\} onchange="saveNewsOptIn\(this\)">/);
  assert.match(accountHtml, /fetch\('\/api\/shop\/account\/marketing'/);
  assert.match(accountHtml, /JSON\.stringify\(\{ optIn: wanted \}\)/);
});

// ---- A2, A5 and B7 (2026-10-20) ----------------------------------------------------

test('A2: subscription products say they are paid through a PayPal account, under the terms line; one-time products do not', () => {
  const line = 'Subscriptions are paid through a PayPal account.';
  assert.equal(count(shopJs, line), 1, 'one constant');
  assert.match(shopJs, /const SUB_PAYPAL_TEXT = 'Subscriptions are paid through a PayPal account\.';/);
  assert.match(shopJs, /return isSubscriptionProduct\(p\) \? `<p class="buy-terms">\$\{SUB_PAYPAL_TEXT\}<\/p>` : '';/);
  assert.match(shopJs, /p\.type === 'subscription' \|\| p\.type === 'recurring_custom'/);
  const card = shopJs.slice(shopJs.indexOf('<div class="shop-card${inactiveClass}'), shopJs.indexOf('${adminHtml}'));
  const terms = card.indexOf('${buyTermsHtml()}');
  const sub = card.indexOf('${subPaypalHtml(p)}');
  const footer = card.indexOf('<div class="shop-card-footer">');
  assert.ok(terms > 0 && sub > terms && footer > sub, 'card: terms, then the subscription line, then the button');
  // The product box: a second line right under the terms, shown for subscriptions only.
  assert.match(shopHtml, /<p class="buy-terms" data-buy-terms><\/p>\s*<p class="buy-terms" id="detailSubNote" hidden><\/p>\s*<div class="detail-footer">/);
  assert.match(shopJs, /subNote\.hidden = !isSubscriptionProduct\(product\);/);
});

test('A5: the page counts paypal_redirected right before it leaves for PayPal, in both checkouts', () => {
  const leaves = [...shopJs.matchAll(/funnelStep\('paypal_redirected'\);\s*(?:\/\/[^\n]*\n\s*)?window\.location\.href = data\.url;/g)];
  assert.equal(leaves.length, 2, 'the plain checkout and the Custom Flag checkout');
  assert.equal(count(shopJs, 'window.location.href = data.url;'), 2, 'no other way out to PayPal');
});

test('B7: the admin form has the two sale-window fields, in UTC, and the shop marks a product off sale for staff only', () => {
  assert.match(shopHtml, /<input type="text" id="formAvailableFrom" placeholder="2026-12-17 00:00"/);
  assert.match(shopHtml, /<input type="text" id="formAvailableUntil" placeholder="2027-01-04 23:59"/);
  assert.equal((shopHtml.match(/YYYY-MM-DD HH:MM in UTC/g) || []).length, 2);
  assert.match(shopJs, /body\.availableFrom = fromField\.value;\s*body\.availableUntil = untilField\.value;/);
  assert.match(shopJs, /isAdmin && !onSaleNow\(p\) \? '<span class="stock-badge">Not on sale now<\/span>' : ''/);
  // A refused checkout shows the server's sentence in the notice box, not a browser alert.
  assert.match(shopJs, /if \(e\.code === 'not_on_sale'\) \{\s*showCheckoutNotice\(\{ title: 'Not on sale right now', text: e\.message \}\);/);
});

// ---- NattiiGuard on the homepage (2026-10-26) ----------------------------------------

test('NattiiGuard: the homepage download, version and size match the update manifest and the installer', () => {
  // A release swaps the installer and the manifest in one commit; the homepage must say the same thing.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'nattiiguard-version.json'), 'utf8'));
  assert.ok(indexHtml.includes(`<a href="/downloads/${manifest.file}" class="btn-filled ng-dl" download>`),
    'the button downloads the version the updater offers');
  assert.ok(indexHtml.includes(`<p class="ng-meta">Version ${manifest.version} &middot; `), 'the line under it names that version');
  const bytes = fs.statSync(path.join(__dirname, '..', 'public', 'downloads', manifest.file)).size;
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  assert.ok(indexHtml.includes(` &middot; ${mb}&nbsp;MB &middot; `), `the size shown is the installer's (${mb} MB)`);
});

test('the WiFi Room Tester is gone: no link, no page, no speed-test endpoints, and its host redirects to the site', () => {
  assert.doesNotMatch(indexHtml, /wifi\.reforgedz\.net|WiFi Room/i);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'public', 'wifi')), false, 'no page left to serve at /wifi/');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /blob-\d+m\.bin|ping\.bin|wifiChunk|WIFI_/);
  assert.match(server, /if \(tunnelHost\(req\) !== 'wifi\.reforgedz\.net'\) return next\(\);\s*res\.writeHead\(301, \{\s*Location: 'https:\/\/reforgedz\.net\/'/);
});

test('no checkbox in the served markup is pre-ticked', () => {
  for (const [name, text] of [['shop.html', shopHtml], ['account.html', accountHtml], ['index.html', indexHtml], ['monetization.html', pub('monetization.html')]]) {
    for (const m of text.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)) {
      // The one allowed form is the account page's own saved choice, a template
      // expression that is only 'checked' when the account ticked it.
      const ok = !/\schecked(\s|>|=)/.test(m[0]) || m[0].includes("${p.marketingOptIn === true ? ' checked' : ''}");
      assert.ok(ok, `${name}: ${m[0]}`);
    }
  }
});

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
  assert.ok(shopHtml.indexOf('id="detailBuy"', detail) - detail < 200);
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

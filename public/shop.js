// ---- State ----
let currentUser = null;
let currentProducts = [];
let userOrders = [];
let isTestMode = false;
let editingProductId = null;
let dropdownOpen = false;
let signinOpen = false;

let fxRates = { USD: 1 };
let currentCurrency = (localStorage.getItem('rz_currency') || 'USD').toUpperCase();
if (!['USD', 'GBP', 'EUR'].includes(currentCurrency)) currentCurrency = 'USD';
const CURRENCY_SYMBOLS = { USD: '$', GBP: '£', EUR: '€' };
const PLATFORM_LABELS = { steam: 'Steam', xbox: 'Xbox', psn: 'PlayStation' };
// EU3 is now the EU dev server. EU2 and NA2 run Faircroft (was Everon). 'eu3' stays out of
// SERVER_IDS so it isn't offered for purchase; its label is kept for historical
// order display.
const SERVER_IDS = ['eu1', 'eu2', 'na1', 'na2'];
const SERVER_LABELS = { eu1: 'EU1 (Chernarus)', eu2: 'EU2 (Faircroft)', eu3: 'EU3 (now EU Dev)', na1: 'NA1 (Chernarus)', na2: 'NA2 (Faircroft)' };

// ---- DOM refs (static elements only — re-queried as needed for dynamic ones) ----
const navAuth = document.getElementById('navAuth');
const testBanner = document.getElementById('testBanner');
const testModeToggle = document.getElementById('testModeToggle');
const alertSuccess = document.getElementById('alertSuccess');
const alertCancelled = document.getElementById('alertCancelled');
const adminPanel = document.getElementById('adminPanel');
const productForm = document.getElementById('productForm');
const productGrid = document.getElementById('productGrid');
const formTitle = document.getElementById('formTitle');
const formType = document.getElementById('formType');
const formDesc = document.getElementById('formDesc');
const formPrice = document.getElementById('formPrice');
const formImage = document.getElementById('formImage');
const formImagesExtra = document.getElementById('formImagesExtra');
const formIntervalDays = document.getElementById('formIntervalDays');
const formIntervalRow = document.getElementById('formIntervalRow');
const formStockLimited = document.getElementById('formStockLimited');
const formStockLimit = document.getElementById('formStockLimit');
const formStockRow = document.getElementById('formStockRow');
const formStockLimitLabel = document.getElementById('formStockLimitLabel');
const formServerSpecific = document.getElementById('formServerSpecific');
const formGrantsPriorityQueue = document.getElementById('formGrantsPriorityQueue');
const formCustomPrice = document.getElementById('formCustomPrice');
const formPriceMin = document.getElementById('formPriceMin');
const formPriceMax = document.getElementById('formPriceMax');
const formPriceMinRow = document.getElementById('formPriceMinRow');
const formPriceMaxRow = document.getElementById('formPriceMaxRow');
const formPriceLabel = document.getElementById('formPriceLabel');
const formAssignDiscordRole = document.getElementById('formAssignDiscordRole');
const formDiscordRoleId = document.getElementById('formDiscordRoleId');
const formDiscordRoleRow = document.getElementById('formDiscordRoleRow');
const formEditId = document.getElementById('formEditId');

let discordRolesCache = null;
async function ensureDiscordRolesLoaded() {
  if (discordRolesCache) return discordRolesCache;
  try {
    const data = await api('/api/shop/admin/discord-roles');
    discordRolesCache = data;
  } catch (e) {
    discordRolesCache = { roles: [], error: e.message };
  }
  return discordRolesCache;
}

async function populateDiscordRoleSelect(selectedId) {
  const data = await ensureDiscordRolesLoaded();
  const roles = (data && data.roles) || [];
  const opts = ['<option value="">Pick a role…</option>'];
  for (const r of roles) {
    const sel = r.id === selectedId ? ' selected' : '';
    opts.push(`<option value="${r.id}"${sel}>${escHtml(r.name)}</option>`);
  }
  formDiscordRoleId.innerHTML = opts.join('');
  if (data && data.error) {
    const optErr = document.createElement('option');
    optErr.value = '';
    optErr.textContent = `Couldn't load roles: ${data.error}`;
    optErr.disabled = true;
    formDiscordRoleId.appendChild(optErr);
  }
}

function refreshDiscordRoleUi() {
  const on = formAssignDiscordRole.checked;
  formDiscordRoleRow.style.display = on ? 'block' : 'none';
  if (on) populateDiscordRoleSelect(formDiscordRoleId.value || '');
}
formAssignDiscordRole.addEventListener('change', refreshDiscordRoleUi);
const formSubmitBtn = document.getElementById('formSubmitBtn');
const formCancelBtn = document.getElementById('formCancelBtn');

// ---- Helpers ----
function formatPrice(cents, _currency, type, intervalDays) {
  const baseUSD = (cents || 0) / 100;
  const cur = currentCurrency;
  const rate = fxRates[cur] || (cur === 'USD' ? 1 : null);
  const amount = rate ? (baseUSD * rate).toFixed(2) : baseUSD.toFixed(2);
  const symbol = CURRENCY_SYMBOLS[rate ? cur : 'USD'] || '$';
  let suffix = '';
  if (type === 'subscription') suffix = '<span class="per">/mo</span>';
  else if (type === 'recurring_custom' && intervalDays) {
    suffix = `<span class="per">/${intervalDays}d</span>`;
  }
  return symbol + amount + suffix;
}

function formatPriceRange(p) {
  // Used for custom-price products on cards and the detail header.
  const min = p.price_min_cents;
  const max = p.price_max_cents;
  if (min != null && max != null) {
    return `${formatPrice(min, p.currency, 'one_time')} to ${formatPrice(max, p.currency, 'one_time')}`;
  }
  if (min != null) {
    return `${formatPrice(min, p.currency, 'one_time')}+`;
  }
  return 'Pay what you want';
}

function formatTypeLabel(type, intervalDays) {
  if (type === 'subscription') return 'Subscription';
  if (type === 'recurring_custom') return `Renewable · every ${intervalDays || '?'} day${intervalDays === 1 ? '' : 's'}`;
  if (type === 'custom_flag') return 'Custom Flag';
  return 'One-Time';
}

function stockBadgeHtml(p) {
  if (p.stock_limit == null) return '';
  const used = p.stock_used || 0;
  // Only the servers this page sells: the API also reports servers nobody can buy
  // (dev1), which inflated the card to "133 / 200 left".
  const sumSold = (byServer) => SERVER_IDS.reduce((a, id) => a + (byServer[id] || 0), 0);
  const totalCap = p.server_specific
    ? (p.per_server_limit ? sumSold(p.per_server_limit) : p.stock_limit * SERVER_IDS.length)
    : p.stock_limit;
  const remaining = (p.server_specific && p.per_server_available)
    ? sumSold(p.per_server_available)
    : Math.max(0, totalCap - used);
  if (remaining === 0) return '<span class="stock-badge sold-out">Sold out</span>';
  const cls = remaining <= Math.max(1, Math.floor(totalCap * 0.2)) ? 'low' : 'available';
  return `<span class="stock-badge ${cls}">${remaining} / ${totalCap} left</span>`;
}

function formatDate(unix) {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  // textContent→innerHTML escapes & < > but NOT quotes; escape them too so the
  // result is safe inside attribute and CSS url('…') contexts, not just text.
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `Request failed (${res.status})`);
    // Some refusals carry a code the page acts on (needs_in_game_id, needs_email, ...).
    err.code = data.code || null;
    err.data = data;
    err.status = res.status;
    throw err;
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return null;
  return res.json();
}

// ---- Buy-flow counters ----
// Tells the shop a step of the buy flow happened (POST /api/shop/funnel). The
// server keeps daily counts only, never who (funnel.js says why). Each step goes
// at most once per page load, so opening the same box twice counts once, and a
// failed or blocked request never stops or slows the page.
const funnelSent = new Set();
function funnelStep(step) {
  if (funnelSent.has(step)) return;
  funnelSent.add(step);
  try {
    fetch('/api/shop/funnel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step }),
      keepalive: true
    }).catch(() => {});
  } catch (e) {}
}

// ---- FX ----
async function loadFx() {
  try {
    const data = await api('/api/shop/fx');
    if (data && data.rates) fxRates = data.rates;
  } catch (e) {
    fxRates = { USD: 1 };
  }
}

// ---- Currency picker ----
function bindCurrencyPills() {
  document.querySelectorAll('.currency-pill').forEach(pill => {
    pill.classList.toggle('active', pill.dataset.cur === currentCurrency);
    pill.addEventListener('click', () => {
      currentCurrency = pill.dataset.cur;
      localStorage.setItem('rz_currency', currentCurrency);
      document.querySelectorAll('.currency-pill').forEach(p => p.classList.toggle('active', p === pill));
      renderProducts(currentProducts);
      const dropdownOrders = document.getElementById('dropdownOrders');
      if (dropdownOrders) renderOrders(userOrders, dropdownOrders);
      if (detailProduct) refreshDetailPrice();
    });
  });
}

// ---- Sign-in dropdown ----

// /shop?next=/account : where to go once signed in. Set by pages that send a
// signed-out player here to sign in (the account page does). Same-origin
// paths only — the server applies the same rule for the Steam round-trip.
const returnTo = (() => {
  const raw = new URLSearchParams(location.search).get('next') || '';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.length > 200) return null;
  return raw;
})();

function bindSigninDropdown() {
  const btn = document.getElementById('signinBtn');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openAuthModal('signin');
  });
}

document.addEventListener('click', (e) => {
  if (signinOpen) {
    const wrap = document.getElementById('signinWrap');
    if (wrap && !wrap.contains(e.target)) {
      signinOpen = false;
      wrap.classList.remove('open');
    }
  }
});

// ---- Auth ----
async function loadUser() {
  try {
    currentUser = await api('/api/auth/me');
  } catch (e) {
    currentUser = null;
  }
  renderAuth();
}

function renderAuth() {
  const currencyHtml = `
    <div class="currency-pills" id="currencyPills" role="group" aria-label="Currency">
      <button type="button" class="currency-pill" data-cur="USD">$ USD</button>
      <button type="button" class="currency-pill" data-cur="GBP">£ GBP</button>
      <button type="button" class="currency-pill" data-cur="EUR">€ EUR</button>
    </div>
  `;

  if (currentUser) {
    const platform = currentUser.platform || 'steam';
    const platformLabel = platform === 'web' ? 'ReforgedZ account' : (PLATFORM_LABELS[platform] || 'Steam');
    const isSteam = platform === 'steam';
    // A website account goes by its in-game name once one is set, its email until then.
    const displayName = platform === 'web'
      ? ((currentUser.persona && currentUser.persona !== 'Player') ? currentUser.persona : (currentUser.email || 'My account'))
      : isSteam ? currentUser.persona : (currentUser.gamertag || currentUser.persona);

    const avatarHtml = isSteam && currentUser.avatar_url
      ? `<img src="${escHtml(currentUser.avatar_url)}" alt="" class="nav-avatar" onerror="this.style.display='none'">`
      : `<span class="platform-mark ${platform}-mark" style="width:32px;height:32px;border-radius:6px;font-size:0.7rem">${platform === 'xbox' ? 'X' : platform === 'psn' ? 'PS' : 'RZ'}</span>`;

    const headerImgHtml = isSteam && currentUser.avatar_url
      ? `<img src="${escHtml(currentUser.avatar_url)}" alt="" onerror="this.style.display='none'">`
      : `<span class="platform-mark ${platform}-mark" style="width:40px;height:40px;border-radius:8px;font-size:0.78rem">${platform === 'xbox' ? 'X' : platform === 'psn' ? 'PS' : 'RZ'}</span>`;

    // The dropdown is for getting around, not for editing. Everything a
    // player manages — in-game ID, Discord, subscriptions, purchase history —
    // lives on /account, where it fits on a phone and has room to explain
    // itself. Two things still need saying up here, because they decide
    // whether a purchase can actually be delivered.
    const attention = [];
    if (!currentUser.bi_uid) attention.push('In-game ID not set');
    if (!currentUser.discord_id) attention.push('Discord not linked');
    const attentionHtml = attention.length
      ? `<a class="dropdown-attention" href="/account">${attention.map(escHtml).join(' · ')}. Fix this on your account page.</a>`
      : '';

    navAuth.innerHTML = `
      ${currencyHtml}
      <button class="account-toggle" id="accountToggle">
        ${avatarHtml}
        <span class="persona">${escHtml(displayName)}</span>
        <span class="chevron"></span>
      </button>
      <div class="account-dropdown" id="accountDropdown">
        <div class="dropdown-header">
          ${headerImgHtml}
          <div class="dropdown-header-info">
            <div class="dropdown-header-name">${escHtml(displayName)}</div>
            <div class="dropdown-header-role ${currentUser.role === 'admin' ? 'admin' : ''}">
              ${currentUser.role === 'admin' ? 'Admin' : platformLabel}
            </div>
          </div>
        </div>
        ${attentionHtml}
        <nav class="dropdown-nav" aria-label="Account">
          <a href="/account">Manage account<span>Subscriptions, linked accounts, purchase history</span></a>
          ${currentUser.role === 'admin' ? `<a href="/admin/orders">Admin: orders &amp; billing<span>Revenue, billing issues, priority queue</span></a>` : ''}
        </nav>
        <div class="dropdown-footer">
          <a href="/auth/logout">Sign out</a>
        </div>
      </div>
    `;

    const toggle = document.getElementById('accountToggle');
    const dropdown = document.getElementById('accountDropdown');
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdownOpen = !dropdownOpen;
      toggle.classList.toggle('open', dropdownOpen);
      dropdown.classList.toggle('open', dropdownOpen);
    });

    if (currentUser.role === 'admin') {
      adminPanel.style.display = 'block';
      testBanner.style.display = 'flex';
      isTestMode = sessionStorage.getItem('rz_test_mode') === '1';
      testModeToggle.checked = isTestMode;
    } else {
      adminPanel.style.display = 'none';
      testBanner.style.display = 'none';
    }

    loadOrders();
  } else {
    navAuth.innerHTML = `
      ${currencyHtml}
      <div class="signin-wrap" id="signinWrap">
        <button type="button" class="signin-btn" id="signinBtn">Sign in</button>
      </div>
    `;
    bindSigninDropdown();
    adminPanel.style.display = 'none';
    testBanner.style.display = 'none';
  }

  bindCurrencyPills();
}

document.addEventListener('click', (e) => {
  if (!dropdownOpen) return;
  const dropdown = document.getElementById('accountDropdown');
  if (dropdown && dropdown.contains(e.target)) return;
  dropdownOpen = false;
  const toggle = document.getElementById('accountToggle');
  if (toggle) toggle.classList.remove('open');
  if (dropdown) dropdown.classList.remove('open');
});

// ---- Test mode ----
testModeToggle.addEventListener('change', () => {
  isTestMode = testModeToggle.checked;
  sessionStorage.setItem('rz_test_mode', isTestMode ? '1' : '0');
});

// ---- Identity finder (the in-game ID box) ----
// The player types a gamertag, an in-game name or their in-game ID, and picks
// themselves from what the shop finds. Nothing has to be exact.
function lastPlayedText(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return 'played today';
  if (days === 1) return 'played yesterday';
  if (days < 14) return `played ${days} days ago`;
  if (days < 60) return `played ${Math.round(days / 7)} weeks ago`;
  return `played ${Math.max(2, Math.round(days / 30))} months ago`;
}

async function findIdentity(query, wide) {
  const data = await api('/api/identity/find', { method: 'POST', body: JSON.stringify({ query, wide: !!wide }) });
  return Array.isArray(data.candidates) ? data.candidates : [];
}

// Draw the matches as buttons; clicking one picks it.
function renderMatches(box, candidates, selectedRef, onPick) {
  box.innerHTML = '';
  for (const c of candidates) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'finder-item' + (c.ref === selectedRef ? ' selected' : '');
    btn.setAttribute('aria-pressed', c.ref === selectedRef ? 'true' : 'false');
    const name = document.createElement('span');
    name.className = 'finder-name';
    name.textContent = c.name;
    const meta = document.createElement('span');
    meta.className = 'finder-meta';
    meta.textContent = [lastPlayedText(c.lastSeen), c.previousName ? `was ${c.previousName}` : ''].filter(Boolean).join(' · ');
    btn.append(name, meta);
    btn.addEventListener('click', () => onPick(c));
    box.appendChild(btn);
  }
  box.style.display = candidates.length ? 'flex' : 'none';
}

// ---- A purchase started while signed out ----
// A signed-out buyer who picked a product (and a server or an amount) used to land
// back on the product list after signing in, with nothing selected, and had to
// start again. The choice is kept in this tab for 30 minutes and carries on after
// an email sign-in or new account in the sign-in box, or on the page load that
// follows the Steam round trip. sessionStorage, not localStorage, so a buy never
// reappears in another tab or days later.
const PENDING_BUY_KEY = 'rz_pending_buy';
const PENDING_BUY_MAX_AGE_MS = 30 * 60 * 1000;

function savePendingBuy(productId, serverId, customAmountCents) {
  try {
    sessionStorage.setItem(PENDING_BUY_KEY, JSON.stringify({
      productId,
      serverId: serverId || null,
      customAmountCents: customAmountCents != null ? customAmountCents : null,
      at: Date.now()
    }));
  } catch (e) {}
}

// The saved buy, or null when there is none, it is too old, or it is not one this page wrote.
function readPendingBuy() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(PENDING_BUY_KEY) || 'null'); } catch (e) { return null; }
  if (!saved || typeof saved !== 'object' || !Number.isInteger(saved.productId)) return null;
  const age = Date.now() - Number(saved.at);
  if (!(age >= 0 && age <= PENDING_BUY_MAX_AGE_MS)) return null;
  return {
    productId: saved.productId,
    serverId: SERVER_IDS.includes(saved.serverId) ? saved.serverId : null,
    customAmountCents: Number.isInteger(saved.customAmountCents) && saved.customAmountCents > 0 ? saved.customAmountCents : null
  };
}

function clearPendingBuy() {
  try { sessionStorage.removeItem(PENDING_BUY_KEY); } catch (e) {}
}

// Read and forget: a saved buy carries on once, however the page got here.
function takePendingBuy() {
  const pending = readPendingBuy();
  clearPendingBuy();
  return pending;
}

// Carry on through the normal gates: the server or amount picker when one is
// missing, the in-game ID prompt, and the checks at checkout. A product no longer
// on sale is dropped quietly.
function resumePendingBuy(pending) {
  if (!pending || !currentUser) return;
  if (!currentProducts.some(p => p.id === pending.productId)) return;
  buyProduct(pending.productId, pending.serverId, pending.customAmountCents);
}

// ---- Sign-in modal (email and password) ----
// The one way into the shop. Steam stays as a small link for staff and for Steam
// customers who have not added an email yet. Xbox and PlayStation customers move
// over with "Forgot password", which emails the address they
// paid with and sets up sign-in on the account they already have.
let authMode = 'signin';
// Set once this box sent an email (a new account's link or a password reset).
// Closing the box after that keeps a saved buy: the player may set a password
// from the email and come back to sign in here.
let authEmailSent = false;

function setAuthMode(mode) {
  authMode = mode;
  const forgot = mode === 'forgot';
  const register = mode === 'register';
  document.getElementById('authTitle').textContent = register ? 'Create your account' : forgot ? 'Get a sign-in link' : 'Sign in';
  document.getElementById('authTabSignin').classList.toggle('active', mode === 'signin');
  document.getElementById('authTabRegister').classList.toggle('active', register);
  const pw = document.getElementById('authPassword');
  const pwLabel = document.getElementById('authPasswordLabel');
  pw.style.display = forgot ? 'none' : '';
  pwLabel.style.display = forgot ? 'none' : '';
  pw.setAttribute('autocomplete', register ? 'new-password' : 'current-password');
  pwLabel.textContent = register ? 'Password (at least 8 characters)' : 'Password';
  document.getElementById('authSubmit').textContent = register ? 'Create account' : forgot ? 'Email me a link' : 'Sign in';
  document.getElementById('authForgot').style.display = forgot ? 'none' : '';
  document.getElementById('authError').textContent = '';
  const notice = document.getElementById('authNotice');
  // Signing in to buy: the product is out of sight now, so say the purchase is kept.
  const buyNote = !forgot && readPendingBuy() ? 'Sign in or create an account, and your purchase carries on from where you left it.' : '';
  notice.textContent = forgot
    ? 'Enter your email and we will send you a link. Bought from us before on Xbox or PlayStation? Use the email you paid with: the link sets up sign-in on that account, so your purchases come with you. Bought with Steam? Use Sign in with Steam below.'
    : buyNote;
  notice.style.display = forgot || buyNote ? 'block' : 'none';
}

function openAuthModal(mode) {
  authEmailSent = false;
  setAuthMode(mode || 'signin');
  document.getElementById('authPassword').value = '';
  // Steam comes back to the shop while a buy is waiting, so it can carry on there;
  // otherwise to the page that sent the player here to sign in.
  const back = readPendingBuy() ? '/shop' : returnTo;
  document.getElementById('authSteamLink').href = '/auth/steam' + (back ? '?next=' + encodeURIComponent(back) : '');
  document.getElementById('authOverlay').classList.add('open');
  setTimeout(() => document.getElementById('authEmail').focus(), 50);
}

function closeAuthModal() {
  document.getElementById('authOverlay').classList.remove('open');
}

// Closed without signing in: forget a saved buy, so a later sign-in does not
// start a purchase the player walked away from. Kept once an email went out.
function dismissAuthModal() {
  if (!authEmailSent) clearPendingBuy();
  closeAuthModal();
}

// The emailed link opens a new tab, and a saved buy lives only in this one, so a
// player who sets a password from it has to come back here to carry on.
function withBuyReminder(message) {
  const text = String(message || '');
  return readPendingBuy()
    ? `${text} When you have set your password, come back to this tab and sign in to carry on with your purchase.`
    : text;
}

async function submitAuth(e) {
  e.preventDefault();
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const errBox = document.getElementById('authError');
  const notice = document.getElementById('authNotice');
  const btn = document.getElementById('authSubmit');
  errBox.textContent = '';
  if (!email) { errBox.textContent = 'Enter your email.'; return; }
  if (authMode !== 'forgot' && !password) { errBox.textContent = 'Enter your password.'; return; }

  const mode = authMode;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = mode === 'forgot' ? 'Sending...' : 'One moment...';
  let errorText = '';
  try {
    if (mode === 'forgot') {
      const data = await api('/api/auth/reset/request', { method: 'POST', body: JSON.stringify({ email }) });
      notice.textContent = withBuyReminder(data.message || 'If that email has an account or has bought from us, an email is on its way.');
      notice.style.display = 'block';
      authEmailSent = true;
      return;
    }
    const data = await api(mode === 'register' ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    if (data.linkSent) {
      // Registering with an email ReforgedZ already knows: no second account,
      // and the email itself gets the next step. A saved buy waits for that sign-in.
      notice.textContent = withBuyReminder(data.message);
      notice.style.display = 'block';
      authEmailSent = true;
      return;
    }
    closeAuthModal();
    // A buy started before signing in carries on right here. Without one, a player
    // sent here from another page to sign in goes back there, signed in.
    const pending = takePendingBuy();
    if (returnTo && !pending) { location.href = returnTo; return; }
    if (returnTo) window.history.replaceState({}, '', '/shop');
    await loadUser();
    await loadProducts();
    resumePendingBuy(pending);
  } catch (err) {
    errorText = err.message || 'That did not work. Try again.';
    if (err.code === 'email_taken') setAuthMode('signin');
  } finally {
    btn.disabled = false;
    // setAuthMode already labelled the button if the mode changed.
    if (authMode === mode) btn.textContent = label;
    if (errorText) errBox.textContent = errorText;
  }
}

document.getElementById('authCancel').addEventListener('click', dismissAuthModal);
document.getElementById('authTabSignin').addEventListener('click', () => setAuthMode('signin'));
document.getElementById('authTabRegister').addEventListener('click', () => setAuthMode('register'));
document.getElementById('authForgot').addEventListener('click', () => setAuthMode('forgot'));
document.getElementById('authForm').addEventListener('submit', submitAuth);
// Escape closes the sign-in box, like the product box. A click outside it does not,
// so a half-typed password is not lost to a stray tap.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('authOverlay').classList.contains('open')) dismissAuthModal();
});

// ---- Products ----
async function loadProducts() {
  try {
    const isAdmin = currentUser && currentUser.role === 'admin';
    const url = isAdmin ? '/api/shop/admin/products' : '/api/shop/products';
    const products = await api(url);
    currentProducts = Array.isArray(products) ? products : [];
    renderProducts(currentProducts);
  } catch (e) {
    productGrid.innerHTML = '<div class="shop-empty">Failed to load products.</div>';
  }
}

function renderProducts(products) {
  if (!products || products.length === 0) {
    productGrid.innerHTML = '<div class="shop-empty">No items available yet. Check back soon.</div>';
    return;
  }

  const isAdmin = currentUser && currentUser.role === 'admin';

  productGrid.innerHTML = products.map(p => {
    const imgHtml = p.image_url
      ? `<div class="shop-card-img" style="background-image: url('${escHtml(p.image_url)}')"></div>`
      : '';

    const hardDeleteBtn = isAdmin && (p.order_count || 0) > 0
      ? `<button class="card-delete-btn card-hard-delete-btn" onclick="event.stopPropagation(); hardDeleteProduct(${p.id}, ${p.order_count}, ${p.active_sub_count || 0})">Hard Delete</button>`
      : '';

    const adminHtml = isAdmin ? `
      <div class="shop-card-admin" style="display: flex" onclick="event.stopPropagation()">
        <button class="card-edit-btn" onclick="event.stopPropagation(); editProduct(${p.id})">Edit</button>
        <button class="card-toggle-btn" onclick="event.stopPropagation(); toggleProduct(${p.id}, ${p.active ? 0 : 1})">
          ${p.active ? 'Deactivate' : 'Activate'}
        </button>
        <button class="card-delete-btn" onclick="event.stopPropagation(); deleteProduct(${p.id})">Delete</button>
        ${hardDeleteBtn}
      </div>
    ` : '';

    const inactiveClass = (!p.active && isAdmin) ? ' inactive' : '';
    const soldOut = p.sold_out === true;
    const soldOutClass = soldOut ? ' sold-out' : '';

    const buyLabel = p.server_specific ? 'Select Server' : (p.custom_price ? 'Choose Amount' : 'Purchase');
    const buyBtnHtml = currentUser
      ? (soldOut
          ? `<button class="shop-buy-btn" disabled onclick="event.stopPropagation()">Sold out</button>`
          : `<button class="shop-buy-btn" ${p.active ? '' : 'disabled'} onclick="event.stopPropagation(); startBuy(${p.id})">${buyLabel}</button>`)
      : `<button class="shop-buy-btn" onclick="event.stopPropagation(); startBuy(${p.id})">Sign in to buy</button>`;

    const typeLabel = formatTypeLabel(p.type, p.interval_days);
    const typeClass = p.type === 'one_time' ? 'one_time' : 'subscription';

    return `
      <div class="shop-card${inactiveClass}${soldOutClass}" data-id="${p.id}" onclick="openProductDetail(${p.id})">
        ${imgHtml}
        <div class="shop-card-body">
          <div class="shop-card-type ${typeClass}">${escHtml(typeLabel)}${stockBadgeHtml(p)}</div>
          <h3>${escHtml(p.title)}</h3>
          <p>${escHtml(p.description || '')}</p>
          <div class="shop-card-footer">
            <span class="shop-card-price">${p.custom_price ? escHtml(formatPriceRange(p)) : formatPrice(p.price_cents, p.currency || 'usd', p.type, p.interval_days)}</span>
            ${buyBtnHtml}
          </div>
          ${adminHtml}
        </div>
      </div>
    `;
  }).join('');
}

function openSigninFromCard() {
  openAuthModal('signin');
}

// ---- Detail modal ----
let detailProduct = null;
let detailImages = [];
let detailImageIndex = 0;
let selectedServerId = null;
let selectedCustomAmountCents = null;

function renderServerPicker(product) {
  const wrap = document.getElementById('detailServerPicker');
  const grid = document.getElementById('detailServerGrid');
  if (!product.server_specific) {
    wrap.style.display = 'none';
    grid.innerHTML = '';
    return;
  }
  wrap.style.display = '';
  const used = product.per_server_used || {};
  const limits = product.per_server_limit || {};
  const avail = product.per_server_available || {};
  grid.innerHTML = SERVER_IDS.map(id => {
    const u = used[id] || 0;
    const limit = (limits[id] != null) ? limits[id] : product.stock_limit;
    const available = (avail[id] != null) ? avail[id] : ((limit != null) ? Math.max(0, limit - u) : null);
    const stock = (limit != null) ? `${available} / ${limit}` : 'Unlimited';
    const isFull = limit != null && available <= 0;
    const selected = id === selectedServerId ? ' selected' : '';
    return `
      <button type="button" class="detail-server-btn${selected}" data-server-id="${id}" ${isFull ? 'disabled' : ''}>
        <span class="server-id">${SERVER_LABELS[id]}</span>
        <span class="server-stock">${isFull ? 'Sold out' : stock}</span>
      </button>
    `;
  }).join('');
  grid.querySelectorAll('.detail-server-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      selectedServerId = btn.dataset.serverId;
      renderServerPicker(detailProduct);
      updateDetailBuyButton();
    });
  });
}

function renderCustomAmountPicker(product) {
  const wrap = document.getElementById('detailCustomAmount');
  const input = document.getElementById('detailAmountInput');
  const bounds = document.getElementById('detailAmountBounds');
  if (!product.custom_price) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  const minDollars = (product.price_min_cents != null ? product.price_min_cents : 50) / 100;
  const maxDollars = product.price_max_cents != null ? product.price_max_cents / 100 : null;
  input.min = minDollars.toFixed(2);
  if (maxDollars != null) input.max = maxDollars.toFixed(2);
  if (selectedCustomAmountCents == null) {
    // Default to the product's suggested price if it sits inside the range,
    // otherwise default to the min.
    const suggestion = product.price_cents;
    const inRange = suggestion >= (product.price_min_cents || 50) && (product.price_max_cents == null || suggestion <= product.price_max_cents);
    selectedCustomAmountCents = inRange ? suggestion : (product.price_min_cents || 50);
    input.value = (selectedCustomAmountCents / 100).toFixed(2);
  }
  bounds.textContent = maxDollars != null
    ? `Minimum $${minDollars.toFixed(2)}, maximum $${maxDollars.toFixed(2)}`
    : `Minimum $${minDollars.toFixed(2)}`;
}

function onCustomAmountChange() {
  if (!detailProduct || !detailProduct.custom_price) return;
  const v = parseFloat(document.getElementById('detailAmountInput').value);
  selectedCustomAmountCents = Number.isFinite(v) ? Math.round(v * 100) : null;
  updateDetailBuyButton();
}

function isCustomAmountValid(product) {
  if (!product.custom_price) return true;
  if (selectedCustomAmountCents == null) return false;
  if (product.price_min_cents != null && selectedCustomAmountCents < product.price_min_cents) return false;
  if (product.price_max_cents != null && selectedCustomAmountCents > product.price_max_cents) return false;
  if (selectedCustomAmountCents < 50) return false;
  return true;
}

function updateDetailBuyButton() {
  const buyBtn = document.getElementById('detailBuy');
  const product = detailProduct;
  if (!product) return;
  if (!currentUser) {
    // The server and amount picked so far go with the sign-in, so the buy carries
    // on after it (startBuy). Without a server the picker opens again then.
    const sid = product.server_specific ? selectedServerId : null;
    buyBtn.textContent = sid ? `Sign in to buy for ${SERVER_LABELS[sid]}` : 'Sign in to buy';
    buyBtn.disabled = false;
    buyBtn.onclick = () => {
      const amt = product.custom_price && isCustomAmountValid(product) ? selectedCustomAmountCents : null;
      closeDetail();
      startBuy(product.id, sid, amt);
    };
    return;
  }

  // Custom-price always needs a valid amount before buying, regardless of server-specific.
  if (product.custom_price && !isCustomAmountValid(product)) {
    const min = (product.price_min_cents || 50) / 100;
    const max = product.price_max_cents != null ? product.price_max_cents / 100 : null;
    buyBtn.textContent = max != null
      ? `Pick between $${min.toFixed(2)} and $${max.toFixed(2)}`
      : `Minimum $${min.toFixed(2)}`;
    buyBtn.disabled = true;
    buyBtn.onclick = null;
    return;
  }

  if (product.server_specific) {
    if (!selectedServerId) {
      buyBtn.textContent = 'Pick a server';
      buyBtn.disabled = true;
      buyBtn.onclick = null;
      return;
    }
    const used = (product.per_server_used || {})[selectedServerId] || 0;
    const limit = (product.per_server_limit && product.per_server_limit[selectedServerId] != null) ? product.per_server_limit[selectedServerId] : product.stock_limit;
    const availMap = product.per_server_available || {};
    const available = (availMap[selectedServerId] != null) ? availMap[selectedServerId] : ((limit != null) ? Math.max(0, limit - used) : null);
    if (available != null && available <= 0) {
      buyBtn.textContent = `Sold out on ${SERVER_LABELS[selectedServerId]}`;
      buyBtn.disabled = true;
      buyBtn.onclick = null;
      return;
    }
    const amountLabel = product.custom_price ? `$${(selectedCustomAmountCents / 100).toFixed(2)} for ${SERVER_LABELS[selectedServerId]}` : `Purchase for ${SERVER_LABELS[selectedServerId]}`;
    buyBtn.textContent = product.active ? (product.custom_price ? `Pay ${amountLabel}` : amountLabel) : 'Unavailable';
    buyBtn.disabled = !product.active;
    buyBtn.onclick = () => {
      const sid = selectedServerId;
      const amt = product.custom_price ? selectedCustomAmountCents : null;
      closeDetail();
      startBuy(product.id, sid, amt);
    };
    return;
  }

  // Non-server-specific
  const soldOut = product.sold_out === true;
  if (soldOut) {
    buyBtn.textContent = 'Sold out';
    buyBtn.disabled = true;
    buyBtn.onclick = null;
  } else {
    const label = product.custom_price
      ? `Pay $${(selectedCustomAmountCents / 100).toFixed(2)}`
      : 'Purchase';
    buyBtn.textContent = product.active ? label : 'Unavailable';
    buyBtn.disabled = !product.active;
    buyBtn.onclick = () => {
      const amt = product.custom_price ? selectedCustomAmountCents : null;
      closeDetail();
      startBuy(product.id, null, amt);
    };
  }
}

document.getElementById('detailAmountInput').addEventListener('input', onCustomAmountChange);

function openProductDetail(productId) {
  const product = currentProducts.find(p => p.id === productId);
  if (!product) return;
  detailProduct = product;
  detailImageIndex = 0;
  detailImages = [];
  selectedServerId = null;
  selectedCustomAmountCents = null;
  if (product.image_url) detailImages.push(product.image_url);
  for (const u of (product.images || [])) {
    if (u && u !== product.image_url) detailImages.push(u);
  }

  const detailType = document.getElementById('detailType');
  detailType.innerHTML = escHtml(formatTypeLabel(product.type, product.interval_days)) + stockBadgeHtml(product);
  document.getElementById('detailTitle').textContent = product.title;
  document.getElementById('detailDesc').textContent = product.description || '';
  renderServerPicker(product);
  renderCustomAmountPicker(product);
  refreshDetailPrice();
  renderDetailImage();
  updateDetailBuyButton();

  document.getElementById('detailOverlay').classList.add('open');
}

function refreshDetailPrice() {
  if (!detailProduct) return;
  const priceEl = document.getElementById('detailPrice');
  if (detailProduct.custom_price) {
    priceEl.innerHTML = escHtml(formatPriceRange(detailProduct));
  } else {
    priceEl.innerHTML = formatPrice(detailProduct.price_cents, detailProduct.currency || 'usd', detailProduct.type, detailProduct.interval_days);
  }
  const note = document.getElementById('detailCurrencyNote');
  note.textContent = currentCurrency === 'USD' ? '' : 'Charged in USD; your bank handles any conversion.';
}

function renderDetailImage() {
  const img = document.getElementById('detailImg');
  const dots = document.getElementById('detailDots');
  const prev = document.getElementById('detailPrev');
  const next = document.getElementById('detailNext');
  const frame = document.querySelector('.detail-img-frame');

  if (detailImages.length === 0) {
    img.style.display = 'none';
    img.src = '';
    if (frame) frame.style.display = 'none';
    prev.hidden = true;
    next.hidden = true;
    dots.innerHTML = '';
    return;
  }
  if (frame) frame.style.display = '';
  img.style.display = '';
  img.src = detailImages[detailImageIndex] || '';
  prev.hidden = detailImages.length < 2;
  next.hidden = detailImages.length < 2;

  if (detailImages.length < 2) {
    dots.innerHTML = '';
  } else {
    dots.innerHTML = detailImages.map((_, i) => `<button class="detail-dot ${i === detailImageIndex ? 'active' : ''}" data-i="${i}" aria-label="Image ${i + 1}"></button>`).join('');
    dots.querySelectorAll('.detail-dot').forEach(d => {
      d.addEventListener('click', (e) => {
        e.stopPropagation();
        detailImageIndex = parseInt(d.dataset.i, 10) || 0;
        renderDetailImage();
      });
    });
  }
}

function closeDetail() {
  document.getElementById('detailOverlay').classList.remove('open');
  detailProduct = null;
  detailImages = [];
  detailImageIndex = 0;
  selectedCustomAmountCents = null;
}

document.getElementById('detailClose').addEventListener('click', closeDetail);
document.getElementById('detailOverlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('detailOverlay')) closeDetail();
});
document.getElementById('detailPrev').addEventListener('click', (e) => {
  e.stopPropagation();
  if (detailImages.length < 2) return;
  detailImageIndex = (detailImageIndex - 1 + detailImages.length) % detailImages.length;
  renderDetailImage();
});
document.getElementById('detailNext').addEventListener('click', (e) => {
  e.stopPropagation();
  if (detailImages.length < 2) return;
  detailImageIndex = (detailImageIndex + 1) % detailImages.length;
  renderDetailImage();
});
document.addEventListener('keydown', (e) => {
  if (!document.getElementById('detailOverlay').classList.contains('open')) return;
  if (e.key === 'Escape') closeDetail();
  else if (e.key === 'ArrowLeft') document.getElementById('detailPrev').click();
  else if (e.key === 'ArrowRight') document.getElementById('detailNext').click();
});

// ---- In-game ID modal (before a checkout that needs one) ----
let pendingProductId = null;
let pendingServerId = null;
let pendingCustomAmountCents = null;
const biuidState = { candidates: [], pick: null, query: '' };

// An Xbox or PlayStation account without confirmed email sign-in: console
// sign-in never proved who was typing, so its in-game ID waits for that.
function needsEmailSignInForId() {
  return !!currentUser && (currentUser.platform === 'xbox' || currentUser.platform === 'psn') && !currentUser.email_verified;
}

function showBiUidModal(productId, serverId, customAmountCents) {
  pendingProductId = productId;
  pendingServerId = serverId || null;
  pendingCustomAmountCents = customAmountCents != null ? customAmountCents : null;
  biuidState.candidates = [];
  biuidState.pick = null;
  biuidState.query = '';
  const product = currentProducts.find(p => p.id === productId);
  // Queue priority has nowhere to go without the ID, so it cannot be skipped.
  const required = !!(product && product.grants_priority_queue);
  const locked = needsEmailSignInForId();
  const input = document.getElementById('biuidInput');
  input.value = '';
  input.style.display = locked ? 'none' : '';
  document.getElementById('biuidError').textContent = '';
  const matches = document.getElementById('biuidMatches');
  matches.innerHTML = '';
  matches.style.display = 'none';
  document.getElementById('biuidLead').textContent = locked
    ? 'Your perks go to your in-game ID. To set it on an Xbox or PlayStation account, first set up email sign-in, so nobody else can change it. Your account page shows how.'
    : 'Your perks go to your in-game ID. Type the name you play under and pick yourself, or paste the ID.';
  document.getElementById('biuidFind').style.display = locked ? 'none' : '';
  document.getElementById('biuidSkip').style.display = required || locked ? 'none' : '';
  document.getElementById('biuidSubmit').textContent = locked ? 'Go to my account' : 'Save and continue';
  document.getElementById('biuidOverlay').classList.add('open');
  funnelStep('id_prompt_shown');
  if (!locked) input.focus();
}

function hideBiUidModal() {
  document.getElementById('biuidOverlay').classList.remove('open');
  pendingProductId = null;
  pendingServerId = null;
  pendingCustomAmountCents = null;
}

document.getElementById('biuidCancel').addEventListener('click', () => {
  const pid = pendingProductId;
  hideBiUidModal();
  if (pid) {
    const btn = document.querySelector(`.shop-card[data-id="${pid}"] .shop-buy-btn`);
    if (btn) { btn.disabled = false; btn.textContent = 'Purchase'; }
  }
});

document.getElementById('biuidSkip').addEventListener('click', () => {
  const pid = pendingProductId;
  const sid = pendingServerId;
  const amt = pendingCustomAmountCents;
  hideBiUidModal();
  if (pid) proceedCheckout(pid, sid, amt);
});

function pickBiuidCandidate(c) {
  biuidState.pick = c;
  renderMatches(document.getElementById('biuidMatches'), biuidState.candidates, c.ref, pickBiuidCandidate);
  document.getElementById('biuidError').textContent = '';
}

async function biuidFind() {
  const input = document.getElementById('biuidInput');
  const error = document.getElementById('biuidError');
  const btn = document.getElementById('biuidFind');
  const query = input.value.trim();
  if (!query) { error.textContent = 'Type the name you play under, or paste your in-game ID.'; return; }
  biuidState.pick = null;
  biuidState.candidates = [];
  biuidState.query = query;
  error.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Searching...';
  try {
    const candidates = await findIdentity(query, false);
    biuidState.candidates = candidates;
    if (!candidates.length) {
      renderMatches(document.getElementById('biuidMatches'), [], null, pickBiuidCandidate);
      error.textContent = 'No ReforgedZ player matches that. Check the spelling, or paste your in-game ID.';
      return;
    }
    if (candidates.length === 1 && candidates[0].exact) pickBiuidCandidate(candidates[0]);
    else renderMatches(document.getElementById('biuidMatches'), candidates, null, pickBiuidCandidate);
  } catch (e) {
    error.textContent = e.message || 'Search failed';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find me';
  }
}

document.getElementById('biuidFind').addEventListener('click', biuidFind);

document.getElementById('biuidSubmit').addEventListener('click', async () => {
  const input = document.getElementById('biuidInput');
  const error = document.getElementById('biuidError');
  const submitBtn = document.getElementById('biuidSubmit');
  const typed = input.value.trim();
  // Braces, spaces and capitals are the usual noise around a correct id.
  const tidy = typed.replace(/[{}\s]/g, '').toLowerCase();
  const looksLikeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tidy);

  if (needsEmailSignInForId()) {
    location.href = '/account';
    return;
  }
  let body;
  if (biuidState.pick && typed === biuidState.query) {
    body = { ref: biuidState.pick.ref };
  } else if (looksLikeId) {
    body = { biUid: tidy };
  } else {
    // A name with no pick yet: search, and let them choose.
    await biuidFind();
    if (!biuidState.pick) {
      if (biuidState.candidates.length) error.textContent = 'Select yourself from the list.';
      return;
    }
    body = { ref: biuidState.pick.ref };
  }

  const label = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving...';
  error.textContent = '';
  try {
    const data = await api('/api/shop/set-bi-uid', { method: 'POST', body: JSON.stringify(body) });
    currentUser.bi_uid = data.bi_uid;
    const pid = pendingProductId;
    const sid = pendingServerId;
    const amt = pendingCustomAmountCents;
    hideBiUidModal();
    renderAuth();
    // Back through the normal gates (already-owned check, checkout refusals) now the ID is set.
    if (pid) buyProduct(pid, sid, amt);
  } catch (e) {
    error.textContent = e.code === 'pick_expired'
      ? 'That took a while, so search again and pick yourself.'
      : (e.message || 'Could not save your in-game ID');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = label;
  }
});

document.getElementById('biuidInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  document.getElementById('biuidSubmit').click();
});

// ---- Discord, after payment ----
// Role products used to stop for a Discord box before PayPal: one more step
// between a buyer and paying, for something that can be linked at any time. The
// payment confirmation offers Connect Discord instead (showNextSteps), and the
// role is applied whenever the account links it.

// Whether the server can run the Connect Discord flow; fetched once, lazily.
let discordOAuthAvailable = null;
async function loadDiscordOAuthFlag() {
  if (discordOAuthAvailable !== null) return discordOAuthAvailable;
  try { discordOAuthAvailable = !!(await api('/api/shop/config')).discordOAuth; } catch (e) { discordOAuthAvailable = false; }
  return discordOAuthAvailable;
}

// In-game ID and Discord are edited on /account now, not in the nav dropdown.
// The checkout-time in-game ID overlay (biuidOverlay) still collects the ID when
// a purchase needs one and the account is missing it.

// ---- Custom Flag checkout (player details + image upload) ----
let pendingFlagProductId = null;

function showCustomFlagModal(productId) {
  pendingFlagProductId = productId;
  const overlay = document.getElementById('customFlagOverlay');
  const error = document.getElementById('customFlagError');
  error.textContent = '';
  document.getElementById('customFlagName').value = currentUser.persona || currentUser.gamertag || '';
  document.getElementById('customFlagIgn').value = '';
  document.getElementById('customFlagGuid').value = currentUser.bi_uid || '';
  document.getElementById('customFlagImage').value = '';

  // Discord ID: if the account already has one linked, it's the source of
  // truth — pre-fill and lock it. Otherwise the buyer must supply one so
  // staff have a way to reach them about the order.
  const discordInput = document.getElementById('customFlagDiscordId');
  const discordHint = document.getElementById('customFlagDiscordHint');
  if (currentUser.discord_id) {
    discordInput.value = currentUser.discord_id;
    discordInput.disabled = true;
    discordHint.textContent = '(linked to your account)';
  } else {
    discordInput.value = '';
    discordInput.disabled = false;
    discordHint.textContent = '(required)';
  }

  const submitBtn = document.getElementById('customFlagSubmit');
  submitBtn.disabled = false;
  submitBtn.textContent = 'Submit & Continue';
  overlay.classList.add('open');
}

function hideCustomFlagModal() {
  document.getElementById('customFlagOverlay').classList.remove('open');
  pendingFlagProductId = null;
}

document.getElementById('customFlagCancel').addEventListener('click', hideCustomFlagModal);

document.getElementById('customFlagSubmit').addEventListener('click', async () => {
  const error = document.getElementById('customFlagError');
  const submitBtn = document.getElementById('customFlagSubmit');
  const name = document.getElementById('customFlagName').value.trim();
  const ign = document.getElementById('customFlagIgn').value.trim();
  const guid = document.getElementById('customFlagGuid').value.trim().toLowerCase();
  const discordId = document.getElementById('customFlagDiscordId').value.trim();
  const fileInput = document.getElementById('customFlagImage');
  const file = fileInput.files[0];

  if (!name) { error.textContent = 'Player Name is required.'; return; }
  if (!ign) { error.textContent = 'In Game Name is required.'; return; }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(guid)) {
    error.textContent = 'Enter a valid Arma Reforger GUID (format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).';
    return;
  }
  // Only enforce format/required-ness for a Discord ID the buyer typed in —
  // one already linked to the account is pre-filled and locked, so it's
  // always valid.
  if (!currentUser.discord_id) {
    if (!discordId) { error.textContent = 'Discord ID is required.'; return; }
    if (!/^\d{15,25}$/.test(discordId)) {
      error.textContent = 'Discord ID should be a numeric Discord user ID.';
      return;
    }
  }
  if (!file) { error.textContent = 'Please upload your flag image (PNG or JPG).'; return; }
  if (!['image/png', 'image/jpeg'].includes(file.type)) {
    error.textContent = 'Flag image must be a PNG or JPG.';
    return;
  }
  if (file.size > 16 * 1024 * 1024) {
    error.textContent = 'Flag image is too large (max 16MB).';
    return;
  }

  error.textContent = '';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting...';

  const form = new FormData();
  form.append('productId', pendingFlagProductId);
  form.append('testMode', isTestMode ? '1' : '0');
  form.append('playerName', name);
  form.append('inGameName', ign);
  form.append('guid', guid);
  form.append('discordId', discordId);
  form.append('flagImage', file);

  try {
    // Raw fetch (not the api() helper) — it must NOT set a JSON Content-Type
    // so the browser can attach its own multipart boundary.
    const res = await fetch('/api/shop/checkout-custom-flag', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    if (data.url) window.location.href = data.url;
  } catch (e) {
    error.textContent = e.message || 'Checkout failed';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit & Continue';
  }
});

// ---- Buy flow ----
async function buyProduct(productId, serverId, customAmountCents) {
  if (!currentUser) return;

  const product = currentProducts.find(p => p.id === productId);

  // Custom Flag always needs its own form (player details + image upload)
  // instead of the plain checkout — it has its own submission + PayPal
  // kickoff, so it skips the generic bi_uid/Discord gates below entirely.
  if (product && product.type === 'custom_flag') {
    showCustomFlagModal(productId);
    return;
  }

  // Server-specific or custom-priced products need a picker → route through
  // the detail modal whenever the caller didn't already collect the inputs.
  const needsServer = product && product.server_specific && !serverId;
  const needsAmount = product && product.custom_price && (customAmountCents == null);
  if (needsServer || needsAmount) {
    openProductDetail(productId);
    return;
  }

  // Every perk is delivered to an in-game ID, so ask for it before PayPal on
  // any platform. Console players used to get an alert and a dead end here.
  // Discord is not asked for here: the payment confirmation offers it.
  if (!currentUser.bi_uid) {
    showBiUidModal(productId, serverId, customAmountCents);
    return;
  }

  const alreadyOwned = userOrders.find(o =>
    o.product_id === productId
    && o.status === 'completed'
    && o.type === 'one_time'
    && (!serverId || o.server_id === serverId)
  );
  if (alreadyOwned) {
    if (!confirm('You already own this item. Purchase again?')) return;
  }

  proceedCheckout(productId, serverId, customAmountCents);
}

// Every buy button comes through here (product cards, the detail box, ?buy=
// links). Signed out, the choice is saved and the sign-in box opens; the buy
// carries on once the buyer is signed in (resumePendingBuy).
function startBuy(productId, serverId, customAmountCents) {
  funnelStep('buy_clicked');
  if (currentUser) {
    buyProduct(productId, serverId, customAmountCents);
    return;
  }
  savePendingBuy(productId, serverId, customAmountCents);
  funnelStep('signin_shown');
  openAuthModal('signin');
}

// ---- Checkout refusals that need more than an alert ----
// A link to the account page, or a second button, which alert() cannot hold.
// Filled with textContent: the message comes from the server.
//   link: { label, href }, a way out shown between Close and the main action.
function showCheckoutNotice({ title, text, closeLabel, action, link }) {
  document.getElementById('checkoutNoticeTitle').textContent = title;
  document.getElementById('checkoutNoticeText').textContent = text;
  const actions = document.getElementById('checkoutNoticeActions');
  actions.textContent = '';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'biuid-cancel';
  close.textContent = closeLabel || 'Close';
  close.addEventListener('click', hideCheckoutNotice);
  actions.appendChild(close);
  if (link) {
    const a = document.createElement('a');
    a.className = 'biuid-cancel';
    a.href = link.href;
    a.textContent = link.label;
    actions.appendChild(a);
  }
  if (action) {
    const main = document.createElement(action.href ? 'a' : 'button');
    main.className = 'biuid-submit';
    main.textContent = action.label;
    if (action.href) {
      main.href = action.href;
    } else {
      main.type = 'button';
      // Once only, so a double click cannot start two checkouts.
      main.addEventListener('click', () => { hideCheckoutNotice(); action.onClick(); }, { once: true });
    }
    actions.appendChild(main);
  }
  document.getElementById('checkoutNoticeOverlay').classList.add('open');
  close.focus();
}

function hideCheckoutNotice() {
  document.getElementById('checkoutNoticeOverlay').classList.remove('open');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('checkoutNoticeOverlay').classList.contains('open')) hideCheckoutNotice();
});

// opts.confirmSharedId: the buyer answered "It is mine, buy anyway" to the shared in-game ID question.
async function proceedCheckout(productId, serverId, customAmountCents, opts = {}) {
  const btn = document.querySelector(`.shop-card[data-id="${productId}"] .shop-buy-btn`);
  if (btn) { btn.disabled = true; btn.textContent = 'Redirecting...'; }

  try {
    const data = await api('/api/shop/checkout', {
      method: 'POST',
      body: JSON.stringify({
        productId,
        testMode: isTestMode,
        serverId: serverId || null,
        customAmountCents: customAmountCents != null ? customAmountCents : undefined,
        confirmSharedId: opts.confirmSharedId === true ? true : undefined
      })
    });
    if (data.url) {
      window.location.href = data.url;
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Purchase'; }
    if (e.code === 'needs_in_game_id') {
      showBiUidModal(productId, serverId, customAmountCents);
      return;
    }
    // A second priority queue subscription for a server this account already has.
    if (e.code === 'already_subscribed') {
      showCheckoutNotice({
        title: 'You already have this',
        text: e.message,
        action: { label: 'Go to my account', href: '/account' }
      });
      return;
    }
    // The in-game ID has priority queue on another account. The server only asks,
    // since the ID may be this buyer's own on a second account. The buyer's own
    // player name is shown (their own account's data), so someone who picked the
    // wrong player in Find me sees it and changes the ID instead of paying for
    // another player's queue.
    if (e.code === 'id_has_priority_elsewhere' && e.data && e.data.needsConfirm) {
      const name = currentUser && currentUser.bi_uid_name;
      showCheckoutNotice({
        title: 'Is this in-game ID yours?',
        text: name ? `Your in-game ID is the player ${name}. ${e.message}` : e.message,
        closeLabel: 'Cancel',
        link: { label: 'Change my in-game ID', href: '/account' },
        action: { label: 'It is mine, buy anyway', onClick: () => proceedCheckout(productId, serverId, customAmountCents, { confirmSharedId: true }) }
      });
      return;
    }
    alert(e.message || 'Checkout failed');
  }
}

// ---- Admin: type-change toggles interval days field ----
formType.addEventListener('change', () => {
  formIntervalRow.style.display = formType.value === 'recurring_custom' ? 'block' : 'none';
});

formStockLimited.addEventListener('change', () => {
  formStockRow.style.display = formStockLimited.checked ? 'block' : 'none';
  if (!formStockLimited.checked) formStockLimit.value = '';
  refreshStockLabel();
});

const formStockOverridesRow = document.getElementById('formStockOverridesRow');

function renderStockOverrideInputs(values) {
  const grid = document.getElementById('formStockOverridesGrid');
  if (!grid) return;
  grid.innerHTML = SERVER_IDS.map(id => `
    <label style="display:flex;flex-direction:column;font-size:0.7rem;color:var(--text-ghost);gap:3px">
      ${SERVER_LABELS[id]}
      <input type="number" min="0" id="formStockOv_${id}" placeholder="default" value="${values && values[id] != null ? values[id] : ''}">
    </label>`).join('');
}

function refreshStockLabel() {
  formStockLimitLabel.textContent = formServerSpecific.checked
    ? 'Max active buyers per server (default)'
    : 'Max active buyers / subscribers';
  if (formStockOverridesRow) {
    formStockOverridesRow.style.display = (formServerSpecific.checked && formStockLimited.checked) ? 'block' : 'none';
  }
}

formServerSpecific.addEventListener('change', refreshStockLabel);
renderStockOverrideInputs({});
refreshStockLabel();

function refreshCustomPriceUi() {
  const on = formCustomPrice.checked;
  formPriceMinRow.style.display = on ? 'block' : 'none';
  formPriceMaxRow.style.display = on ? 'block' : 'none';
  formPriceLabel.textContent = on ? 'Suggested price (USD)' : 'Price (USD)';
}
formCustomPrice.addEventListener('change', refreshCustomPriceUi);
refreshCustomPriceUi();

productForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const price = parseFloat(formPrice.value);
  if (!price || price < 0.50) return alert('Minimum price is $0.50');

  const type = formType.value;
  let intervalDays = null;
  if (type === 'recurring_custom') {
    intervalDays = parseInt(formIntervalDays.value, 10);
    if (!intervalDays || intervalDays < 1 || intervalDays > 365) {
      return alert('Renewal interval must be between 1 and 365 days');
    }
  }

  const imagesExtra = (formImagesExtra.value || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  let stockLimit = null;
  if (formStockLimited.checked) {
    const n = parseInt(formStockLimit.value, 10);
    if (!Number.isFinite(n) || n < 0) {
      return alert('Stock limit must be a non-negative number');
    }
    stockLimit = n;
  }

  let customPrice = formCustomPrice.checked;
  let priceMinCents = null;
  let priceMaxCents = null;
  if (customPrice) {
    if (type !== 'one_time') {
      return alert('Pay-what-you-want is only supported for One-Time products.');
    }
    const minVal = parseFloat(formPriceMin.value);
    if (!Number.isFinite(minVal) || minVal < 0.50) {
      return alert('Minimum amount must be at least $0.50');
    }
    priceMinCents = Math.round(minVal * 100);
    const maxRaw = formPriceMax.value.trim();
    if (maxRaw !== '') {
      const maxVal = parseFloat(maxRaw);
      if (!Number.isFinite(maxVal) || maxVal < minVal) {
        return alert('Maximum amount must be greater than or equal to the minimum.');
      }
      priceMaxCents = Math.round(maxVal * 100);
    }
  }

  const assignDiscordRole = formAssignDiscordRole.checked;
  let discordRoleId = null;
  if (assignDiscordRole) {
    discordRoleId = formDiscordRoleId.value || null;
    if (!discordRoleId) {
      return alert('Pick a Discord role, or untick "Assign Discord role on purchase".');
    }
  }

  // Per-server stock caps (only when server-specific + limited). Blank = default.
  let stockLimitOverrides = null;
  if (formServerSpecific.checked && formStockLimited.checked) {
    const ov = {};
    for (const id of SERVER_IDS) {
      const el = document.getElementById('formStockOv_' + id);
      if (el && el.value.trim() !== '') {
        const n = parseInt(el.value, 10);
        if (Number.isFinite(n) && n >= 0) ov[id] = n;
      }
    }
    stockLimitOverrides = Object.keys(ov).length ? ov : null;
  }

  const body = {
    title: formTitle.value.trim(),
    description: formDesc.value.trim(),
    priceCents: Math.round(price * 100),
    type,
    imageUrl: formImage.value.trim() || null,
    intervalDays,
    imagesExtra,
    stockLimit,
    stockLimitOverrides,
    serverSpecific: formServerSpecific.checked,
    grantsPriorityQueue: formGrantsPriorityQueue.checked,
    customPrice,
    priceMinCents,
    priceMaxCents,
    discordRoleId
  };

  try {
    if (editingProductId) {
      await api(`/api/shop/admin/products/${editingProductId}`, {
        method: 'PUT',
        body: JSON.stringify(body)
      });
    } else {
      await api('/api/shop/admin/products', {
        method: 'POST',
        body: JSON.stringify(body)
      });
    }
    clearForm();
    loadProducts();
  } catch (e) {
    alert(e.message || 'Failed to save product');
  }
});

function editProduct(id) {
  api(`/api/shop/admin/products`).then(products => {
    const p = products.find(x => x.id === id);
    if (!p) return;

    formTitle.value = p.title;
    formType.value = p.type;
    formDesc.value = p.description || '';
    formPrice.value = (p.price_cents / 100).toFixed(2);
    formImage.value = p.image_url || '';
    formImagesExtra.value = (p.images || []).join('\n');
    formIntervalDays.value = p.interval_days || '';
    formIntervalRow.style.display = p.type === 'recurring_custom' ? 'block' : 'none';
    const limited = p.stock_limit != null;
    formStockLimited.checked = limited;
    formStockLimit.value = limited ? p.stock_limit : '';
    formStockRow.style.display = limited ? 'block' : 'none';
    formServerSpecific.checked = !!p.server_specific;
    formGrantsPriorityQueue.checked = !!p.grants_priority_queue;
    let ovVals = {};
    if (p.stock_limit_overrides) {
      try { ovVals = typeof p.stock_limit_overrides === 'string' ? JSON.parse(p.stock_limit_overrides) : p.stock_limit_overrides; } catch (e) {}
    }
    renderStockOverrideInputs(ovVals);
    formCustomPrice.checked = !!p.custom_price;
    formPriceMin.value = p.price_min_cents != null ? (p.price_min_cents / 100).toFixed(2) : '';
    formPriceMax.value = p.price_max_cents != null ? (p.price_max_cents / 100).toFixed(2) : '';
    formAssignDiscordRole.checked = !!p.discord_role_id;
    formDiscordRoleId.innerHTML = p.discord_role_id ? `<option value="${escHtml(p.discord_role_id)}" selected>Loading…</option>` : '<option value="">Loading…</option>';
    if (p.discord_role_id) populateDiscordRoleSelect(p.discord_role_id);
    refreshStockLabel();
    refreshCustomPriceUi();
    refreshDiscordRoleUi();
    formEditId.value = id;
    editingProductId = id;
    formSubmitBtn.textContent = 'Update Listing';
    formCancelBtn.style.display = 'inline-block';
    adminPanel.scrollIntoView({ behavior: 'smooth' });
  });
}

formCancelBtn.addEventListener('click', clearForm);

function clearForm() {
  productForm.reset();
  formImagesExtra.value = '';
  formIntervalDays.value = '';
  formIntervalRow.style.display = 'none';
  formStockLimited.checked = false;
  formStockLimit.value = '';
  formStockRow.style.display = 'none';
  formServerSpecific.checked = false;
  formGrantsPriorityQueue.checked = false;
  renderStockOverrideInputs({});
  formCustomPrice.checked = false;
  formPriceMin.value = '';
  formPriceMax.value = '';
  formAssignDiscordRole.checked = false;
  formDiscordRoleId.innerHTML = '<option value="">Pick a role…</option>';
  refreshStockLabel();
  refreshCustomPriceUi();
  refreshDiscordRoleUi();
  formEditId.value = '';
  editingProductId = null;
  formSubmitBtn.textContent = 'Create Listing';
  formCancelBtn.style.display = 'none';
}

async function deleteProduct(id) {
  if (!confirm('Permanently delete this product? This cannot be undone.')) return;
  try {
    await api(`/api/shop/admin/products/${id}/permanent`, { method: 'DELETE' });
    loadProducts();
  } catch (e) {
    alert(e.message || 'Failed to delete product');
  }
}

async function hardDeleteProduct(id, orderCount, subCount) {
  const subWarning = subCount > 0
    ? `\n\nNote: ${subCount} old Stripe subscription order(s) reference this product. Hard Delete cancels every live PayPal subscription for this product, so those players stop being billed and lose what it gives them. It cannot cancel Stripe subscriptions: check the Stripe dashboard for those.`
    : '';
  const typed = prompt(
    `HARD DELETE\n\nThis permanently deletes the product AND ${orderCount} order(s) referencing it. This cannot be undone.${subWarning}\n\nType DELETE to confirm:`
  );
  if (typed !== 'DELETE') return;
  try {
    const result = await api(`/api/shop/admin/products/${id}/hard`, { method: 'DELETE' });
    alert(`Hard delete complete. Removed ${result.deletedOrders} order(s); cancelled ${result.cancelledSubs} subscription(s).`);
    loadProducts();
  } catch (e) {
    alert(e.message || 'Hard delete failed');
  }
}

async function toggleProduct(id, active) {
  try {
    if (active) {
      await api(`/api/shop/admin/products/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ active: true })
      });
    } else {
      await api(`/api/shop/admin/products/${id}`, { method: 'DELETE' });
    }
    loadProducts();
  } catch (e) {
    alert(e.message || 'Failed to update product');
  }
}

// ---- Orders (dropdown) ----
async function loadOrders() {
  if (!currentUser) return;
  const container = document.getElementById('dropdownOrders');
  if (!container) return;

  try {
    const orders = await api('/api/shop/orders');
    userOrders = orders || [];
    renderOrders(orders, container);
  } catch (e) {
    container.innerHTML = '<div class="dropdown-empty">Failed to load orders.</div>';
  }
}

function renderOrders(orders, container) {
  const visible = orders || [];
  if (visible.length === 0) {
    container.innerHTML = '<div class="dropdown-empty">No purchases yet.</div>';
    return;
  }

  // Renewals insert a new order row per billing cycle, so several rows can
  // share the same paypal_subscription_id. Only the most recent one gets a
  // cancel button — cancelling any of them would cancel the same PayPal
  // subscription, so showing it on every past cycle would just be clutter.
  const latestSubOrderId = new Map();
  for (const o of visible) {
    if (!o.paypal_subscription_id) continue;
    const prev = latestSubOrderId.get(o.paypal_subscription_id);
    if (prev === undefined || o.id > prev) latestSubOrderId.set(o.paypal_subscription_id, o.id);
  }

  container.innerHTML = visible.map(o => {
    const isActiveSub = o.paypal_subscription_id
      && o.status === 'completed'
      && !o.subscription_cancelled_at
      && latestSubOrderId.get(o.paypal_subscription_id) === o.id;
    const cancelBtn = isActiveSub
      ? `<button class="cancel-sub-btn" onclick="cancelSubscription(${o.id}, event)">Cancel</button>`
      : '';
    const serverTag = o.server_id ? ` <span style="color:var(--text-ghost);font-weight:500"> · ${escHtml(SERVER_LABELS[o.server_id] || o.server_id)}</span>` : '';

    return `
      <div class="dropdown-order">
        <div class="dropdown-order-info">
          <div class="dropdown-order-title">${escHtml(o.title)}${serverTag}</div>
          <div class="dropdown-order-meta">
            <span class="status-dot ${o.status}"></span>
            <span class="dropdown-order-meta-text">${o.status} &middot; ${formatDate(o.created_at)} &middot; ${formatPrice(o.amount_cents, o.currency || 'usd', o.type)}</span>
          </div>
        </div>
        ${cancelBtn}
      </div>
    `;
  }).join('');
}

// ---- Cancel subscription ----
let pendingCancelOrderId = null;

async function cancelSubscription(orderId, e) {
  if (e) e.stopPropagation();
  pendingCancelOrderId = orderId;

  const overlay = document.getElementById('cancelOverlay');
  const text = document.getElementById('cancelModalText');
  const confirmBtn = document.getElementById('cancelModalConfirm');
  confirmBtn.disabled = true;
  text.textContent = 'Loading billing info...';
  overlay.classList.add('open');

  try {
    const info = await api(`/api/shop/subscription-info/${orderId}`);
    const endDate = new Date(info.periodEnd * 1000);
    const formatted = endDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
    text.innerHTML = `Recurring billing will end on <span class="cancel-date">${escHtml(formatted)}</span>. If you cancel now, you will lose access to your benefits on <span class="cancel-date">${escHtml(formatted)}</span>.<br><br>Are you sure you want to cancel?`;
    confirmBtn.disabled = false;
  } catch (err) {
    text.textContent = 'If you cancel now, your subscription will end at the end of the current billing period. Are you sure?';
    confirmBtn.disabled = false;
  }
}

document.getElementById('cancelModalBack').addEventListener('click', () => {
  document.getElementById('cancelOverlay').classList.remove('open');
  pendingCancelOrderId = null;
});

document.getElementById('cancelModalConfirm').addEventListener('click', async () => {
  if (!pendingCancelOrderId) return;
  const confirmBtn = document.getElementById('cancelModalConfirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Cancelling...';

  try {
    await api('/api/shop/cancel-subscription', {
      method: 'POST',
      body: JSON.stringify({ orderId: pendingCancelOrderId })
    });
    document.getElementById('cancelOverlay').classList.remove('open');
    pendingCancelOrderId = null;
    confirmBtn.textContent = 'Yes, Cancel';
    confirmBtn.disabled = false;
    loadOrders();
  } catch (err) {
    alert(err.message || 'Failed to cancel subscription');
    confirmBtn.textContent = 'Yes, Cancel';
    confirmBtn.disabled = false;
  }
});

// ---- URL alerts + session verification ----
// The moment queue priority actually begins. Mirrors restartSchedule.js on
// the server: every 4 hours on UTC boundaries, read by the game at start.
function nextRestartText(now = Date.now()) {
  const step = 4 * 3600 * 1000;
  const next = new Date(Math.floor(now / step) * step + step);
  const mins = Math.max(1, Math.round((next - now) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const local = next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${next.toISOString().slice(11, 16)} UTC (${local} your time, in ${h ? h + ' h ' : ''}${m} min)`;
}

// What just happened and what happens next, so nobody has to guess whether
// the purchase "worked". Entitlement was decided server-side already.
// opts.discordOAuth: the server can run Connect Discord, so offer it as a button.
function nextStepsHtml(order, opts = {}) {
  const items = [];
  const label = order.server_id ? (SERVER_LABELS[order.server_id] || String(order.server_id).toUpperCase()) : 'your server';
  if (order.grants_priority_queue) {
    items.push(`Queue priority on <strong>${escHtml(label)}</strong> starts at the next scheduled restart, <strong>${escHtml(nextRestartText())}</strong>. Servers restart every 4 hours.`);
    if (currentUser && !currentUser.bi_uid) items.push('Set your in-game id on your <a href="/account">account page</a> first, or the priority has nowhere to go.');
    // Who it goes to, so a mistyped or planted in-game ID is noticed now rather than in the queue.
    else if (currentUser && currentUser.bi_uid_name) items.push(`Priority queue goes to <strong>${escHtml(currentUser.bi_uid_name)}</strong>, the player on your in-game ID. If that is not you, change your in-game ID on your <a href="/account">account page</a>.`);
  }
  if (order.discord_role_id) {
    if (currentUser && currentUser.discord_id) {
      items.push('Your Discord role is applied automatically, usually within a minute.');
    } else if (opts.discordOAuth) {
      // Asked here, after payment, rather than in a box before PayPal.
      items.push('Connect your Discord to receive your role. It is applied as soon as Discord is linked.<br><a class="alert-action" href="/auth/discord/link?next=/account">Connect Discord</a>');
    } else {
      items.push('Link your Discord on your <a href="/account">account page</a> to receive your role. It is applied as soon as Discord is linked.');
    }
  }
  items.push('See or change any of this on your <a href="/account">account page</a>.');
  return `<strong>Payment successful. Thanks for supporting ReforgedZ.</strong><ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
}

// The confirmation for an order, offering Connect Discord when the product gives a
// Discord role and the account has none linked.
async function showNextSteps(order) {
  const wantsDiscord = !!order.discord_role_id && !(currentUser && currentUser.discord_id);
  const discordOAuth = wantsDiscord ? await loadDiscordOAuthFlag() : false;
  alertSuccess.innerHTML = nextStepsHtml(order, { discordOAuth });
  if (wantsDiscord) funnelStep('discord_prompt_shown');
}

async function findOwnOrder(orderId) {
  try {
    const orders = await api('/api/shop/orders');
    return orders.find(o => String(o.id) === String(orderId)) || null;
  } catch (e) {
    return null;
  }
}

async function checkAlerts() {
  const params = new URLSearchParams(window.location.search);
  const orderId = params.get('order');
  if (params.get('processing') === '1') {
    // The agreement is approved at PayPal but the activation webhook has not
    // landed yet. Usually seconds; poll the order before giving up on it.
    alertSuccess.style.display = 'block';
    alertSuccess.textContent = 'PayPal is confirming your subscription. This usually takes a few seconds.';
    window.history.replaceState({}, '', '/shop');
    for (let i = 0; i < 10 && orderId; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const order = await findOwnOrder(orderId);
      if (order && order.status === 'completed') {
        await showNextSteps(order);
        loadOrders();
        return;
      }
    }
    alertSuccess.innerHTML = 'PayPal is still confirming your subscription. It appears on your <a href="/account">account page</a> as soon as the first payment clears; if it is not there within an hour, open a ticket in Discord.';
    return;
  }
  if (params.get('success') === '1') {
    alertSuccess.style.display = 'block';
    // PayPal captures + fulfills server-side on the return redirect; this is
    // just a safety re-verify in case the buyer landed here via the webhook
    // path before the capture completed.
    if (orderId) {
      try {
        await api('/api/shop/verify-session', {
          method: 'POST',
          body: JSON.stringify({ orderId })
        });
      } catch (e) {}
      // Custom Flag orders get richer instructions in place of the generic
      // "thanks" line — look up the order's product type to tell.
      try {
        const order = await findOwnOrder(orderId);
        if (order && order.type !== 'custom_flag') {
          await showNextSteps(order);
        } else if (order && order.type === 'custom_flag') {
          const cfg = await api('/api/shop/config').catch(() => ({}));
          const tutorial = cfg.customFlagTutorialUrl
            ? `<a href="${escHtml(cfg.customFlagTutorialUrl)}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;font-weight:600">Watch the tutorial</a>`
            : '[YOUTUBE_TUTORIAL_LINK_HERE]';
          const receiptNo = `RFGZ-${String(orderId).padStart(6, '0')}`;
          const ticketLink = cfg.customFlagTicketUrl
            ? `<a href="${escHtml(cfg.customFlagTicketUrl)}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;font-weight:600">our Discord ticket channel</a>`
            : 'our Discord ticket channel';
          alertSuccess.innerHTML = `
            <strong>Thanks for your Custom Flag order!</strong>
            The same steps below were also emailed to the address you used at checkout (PayPal).<br><br>
            1. ${tutorial} on preparing your flag design.<br>
            2. Open a ticket at ${ticketLink} — click <strong>Open Support Ticket</strong> and choose <strong>Shop</strong> from the dropdown.<br>
            3. In the ticket, include your receipt number <strong>${escHtml(receiptNo)}</strong> and attach your flag design.
          `;
        }
      } catch (e) {}
    }
    window.history.replaceState({}, '', '/shop');
  }
  if (params.get('cancelled') === '1') {
    alertCancelled.style.display = 'block';
    funnelStep('checkout_cancelled_seen');
    window.history.replaceState({}, '', '/shop');
  }
  if (params.get('error') === '1') {
    if (typeof alertCancelled !== 'undefined' && alertCancelled) {
      alertCancelled.textContent = 'Payment could not be completed. You were not charged.';
      alertCancelled.style.display = 'block';
    }
    window.history.replaceState({}, '', '/shop');
  }
}

// ---- Init ----
async function init() {
  bindCurrencyPills();
  bindSigninDropdown();
  await loadFx();
  await loadUser();
  await loadProducts();
  // After the user, so the confirmation can say whether Discord is linked.
  checkAlerts();
  // /shop?buy=<product>&server=<id>: the account page's "Start again", the expiry
  // reminder email and any link that should land straight in checkout. Signed out,
  // startBuy keeps the choice and opens sign-in on this page, and the buy carries
  // on after it.
  const params = new URLSearchParams(location.search);
  const buyId = parseInt(params.get('buy'), 10);
  if (buyId) {
    const server = SERVER_IDS.includes(params.get('server')) ? params.get('server') : null;
    window.history.replaceState({}, '', '/shop');
    // This link is the buy now, not anything saved earlier in the tab.
    clearPendingBuy();
    startBuy(buyId, server);
    return;
  }
  // Signed in with a buy saved before signing in: back from the Steam round
  // trip, or a reload. It carries on, ahead of any page that asked for the sign-in.
  if (currentUser) {
    const pending = takePendingBuy();
    if (pending) {
      if (returnTo) window.history.replaceState({}, '', '/shop');
      resumePendingBuy(pending);
      return;
    }
  }
  // Arrived here to sign in and still signed out: open the sign-in menu so
  // the next step is obvious. Already signed in: they only wanted the page
  // they came from.
  if (returnTo) {
    if (currentUser) location.href = returnTo;
    else openSigninFromCard();
  }
}

window.buyProduct = buyProduct;
window.startBuy = startBuy;
window.editProduct = editProduct;
window.toggleProduct = toggleProduct;
window.deleteProduct = deleteProduct;
window.cancelSubscription = cancelSubscription;
window.openProductDetail = openProductDetail;
window.openSigninFromCard = openSigninFromCard;
window.hardDeleteProduct = hardDeleteProduct;

init();

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
const SERVER_IDS = ['eu1', 'eu2', 'na1', 'na2'];
const SERVER_LABELS = { eu1: 'EU1', eu2: 'EU2', na1: 'NA1', na2: 'NA2' };

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
const formEditId = document.getElementById('formEditId');
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
  return 'One-Time';
}

function stockBadgeHtml(p) {
  if (p.stock_limit == null) return '';
  const used = p.stock_used || 0;
  const totalCap = p.server_specific ? p.stock_limit * SERVER_IDS.length : p.stock_limit;
  const remaining = Math.max(0, totalCap - used);
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
  return d.innerHTML;
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return null;
  return res.json();
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
function bindSigninDropdown() {
  const wrap = document.getElementById('signinWrap');
  const btn = document.getElementById('signinBtn');
  if (!wrap || !btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    signinOpen = !signinOpen;
    wrap.classList.toggle('open', signinOpen);
  });
  wrap.querySelectorAll('[data-platform]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      signinOpen = false;
      wrap.classList.remove('open');
      openConsoleModal(item.dataset.platform);
    });
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
    const platformLabel = PLATFORM_LABELS[platform] || 'Steam';
    const isSteam = platform === 'steam';
    const displayName = isSteam ? currentUser.persona : (currentUser.gamertag || currentUser.persona);

    const avatarHtml = isSteam && currentUser.avatar_url
      ? `<img src="${escHtml(currentUser.avatar_url)}" alt="" class="nav-avatar" onerror="this.style.display='none'">`
      : `<span class="platform-mark ${platform}-mark" style="width:32px;height:32px;border-radius:6px;font-size:0.7rem">${platform === 'xbox' ? 'X' : platform === 'psn' ? 'PS' : '?'}</span>`;

    const headerImgHtml = isSteam && currentUser.avatar_url
      ? `<img src="${escHtml(currentUser.avatar_url)}" alt="" onerror="this.style.display='none'">`
      : `<span class="platform-mark ${platform}-mark" style="width:40px;height:40px;border-radius:8px;font-size:0.78rem">${platform === 'xbox' ? 'X' : platform === 'psn' ? 'PS' : '?'}</span>`;

    const biuidEditableHtml = isSteam ? `
      <div class="dropdown-biuid-row">
        <input type="text" id="dropdownBiUidInput" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${escHtml(currentUser.bi_uid || '')}" spellcheck="false" autocomplete="off">
        <button onclick="saveBiUidFromDropdown()">Save</button>
      </div>
    ` : `
      <div style="font-size:0.7rem;color:var(--text-ghost);margin-top:4px">Auto-linked from BattleMetrics. Open a Discord ticket if this looks wrong.</div>
    `;

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
        <div class="dropdown-biuid">
          <div class="dropdown-biuid-label">Bohemia Identity ID</div>
          ${currentUser.bi_uid
            ? `<div class="dropdown-biuid-value">${escHtml(currentUser.bi_uid)}</div>`
            : `<div class="dropdown-biuid-value empty">Not set</div>`
          }
          ${biuidEditableHtml}
        </div>
        <div class="dropdown-section-label">Purchase History</div>
        <div class="dropdown-orders" id="dropdownOrders">
          <div class="dropdown-empty">Loading...</div>
        </div>
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
        <button type="button" class="signin-btn" id="signinBtn">
          Sign in <span class="chevron"></span>
        </button>
        <div class="signin-menu" id="signinMenu">
          <a href="/auth/steam" class="signin-item">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.04 2 11.04c0 3.15 1.73 5.92 4.33 7.5l2.6-3.76c-.14-.04-.28-.1-.41-.17a2.5 2.5 0 1 1 3.45-.91l2.58 3.73C18.16 16.99 22 14.36 22 11.04 22 6.04 17.52 2 12 2zm4.5 9.54a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>
            Steam
          </a>
          <button type="button" class="signin-item" data-platform="xbox">
            <span class="platform-mark xbox-mark">X</span>
            Xbox
          </button>
          <button type="button" class="signin-item" data-platform="psn">
            <span class="platform-mark psn-mark">PS</span>
            PlayStation
          </button>
        </div>
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

// ---- Console sign-in modal ----
const consoleState = { platform: null, gamertag: '', bmPlayerId: null, biUid: null, displayName: null };

function openConsoleModal(platform) {
  consoleState.platform = platform;
  consoleState.gamertag = '';
  consoleState.bmPlayerId = null;
  consoleState.biUid = null;
  consoleState.displayName = null;

  const overlay = document.getElementById('consoleOverlay');
  const label = platform === 'xbox' ? 'Xbox' : 'PlayStation';
  document.getElementById('consoleModalTitle').textContent = `Sign in with ${label}`;
  document.getElementById('consolePlatformLabel').textContent = label;
  const input = document.getElementById('consoleGamertagInput');
  input.value = '';
  document.getElementById('consoleResult').style.display = 'none';
  document.getElementById('consoleResult').innerHTML = '';
  document.getElementById('consoleError').textContent = '';
  document.getElementById('consoleLookup').style.display = '';
  document.getElementById('consoleLookup').disabled = false;
  document.getElementById('consoleLookup').textContent = 'Look up';
  document.getElementById('consoleConfirm').style.display = 'none';
  document.getElementById('consoleConfirm').disabled = false;
  document.getElementById('consoleConfirm').textContent = 'Confirm & Sign in';
  overlay.classList.add('open');
  setTimeout(() => input.focus(), 50);
}

function closeConsoleModal() {
  document.getElementById('consoleOverlay').classList.remove('open');
}

async function consoleLookup() {
  const input = document.getElementById('consoleGamertagInput');
  const errBox = document.getElementById('consoleError');
  const resultBox = document.getElementById('consoleResult');
  const lookupBtn = document.getElementById('consoleLookup');
  const confirmBtn = document.getElementById('consoleConfirm');

  const tag = input.value.trim();
  if (!tag) { errBox.textContent = 'Enter a gamertag.'; return; }

  errBox.textContent = '';
  lookupBtn.disabled = true;
  lookupBtn.textContent = 'Searching...';

  try {
    const data = await api('/api/auth/console/lookup', {
      method: 'POST',
      body: JSON.stringify({ platform: consoleState.platform, gamertag: tag })
    });
    consoleState.gamertag = tag;
    consoleState.bmPlayerId = data.bmPlayerId;
    consoleState.biUid = data.biUid;
    consoleState.displayName = data.displayName;

    const biLine = data.biUid
      ? `BI UID: <code>${escHtml(data.biUid)}</code>`
      : `BI UID: <em style="color:var(--text-ghost)">not yet linked — you'll need to play on a tracked server first</em>`;
    resultBox.innerHTML = `Found <strong>${escHtml(data.displayName)}</strong> on BattleMetrics.<br>${biLine}`;
    resultBox.style.display = 'block';
    lookupBtn.style.display = 'none';
    confirmBtn.style.display = '';
  } catch (e) {
    errBox.textContent = e.message || 'Lookup failed';
  } finally {
    lookupBtn.disabled = false;
    lookupBtn.textContent = 'Look up';
  }
}

async function consoleConfirm() {
  const confirmBtn = document.getElementById('consoleConfirm');
  const errBox = document.getElementById('consoleError');
  errBox.textContent = '';
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Signing in...';
  try {
    await api('/api/auth/console/confirm', {
      method: 'POST',
      body: JSON.stringify({ platform: consoleState.platform, gamertag: consoleState.gamertag })
    });
    closeConsoleModal();
    await loadUser();
    await loadProducts();
  } catch (e) {
    errBox.textContent = e.message || 'Sign in failed';
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Confirm & Sign in';
  }
}

document.getElementById('consoleCancel').addEventListener('click', closeConsoleModal);
document.getElementById('consoleLookup').addEventListener('click', consoleLookup);
document.getElementById('consoleConfirm').addEventListener('click', consoleConfirm);
document.getElementById('consoleGamertagInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (document.getElementById('consoleConfirm').style.display !== 'none') consoleConfirm();
    else consoleLookup();
  }
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
          : `<button class="shop-buy-btn" ${p.active ? '' : 'disabled'} onclick="event.stopPropagation(); buyProduct(${p.id})">${buyLabel}</button>`)
      : `<button class="shop-buy-btn" onclick="event.stopPropagation(); openSigninFromCard()">Sign in to buy</button>`;

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
  const wrap = document.getElementById('signinWrap');
  if (wrap) {
    signinOpen = true;
    wrap.classList.add('open');
    wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    window.location.href = '/auth/steam';
  }
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
  const limit = product.stock_limit;
  grid.innerHTML = SERVER_IDS.map(id => {
    const u = used[id] || 0;
    const stock = (limit != null) ? `${Math.max(0, limit - u)} / ${limit}` : 'Unlimited';
    const isFull = limit != null && u >= limit;
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
    buyBtn.textContent = 'Sign in to buy';
    buyBtn.disabled = false;
    buyBtn.onclick = () => { closeDetail(); openSigninFromCard(); };
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
    if (product.stock_limit != null && used >= product.stock_limit) {
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
      buyProduct(product.id, sid, amt);
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
      buyProduct(product.id, null, amt);
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

// ---- BI UID modal (Steam users only) ----
let pendingProductId = null;
let pendingServerId = null;
let pendingCustomAmountCents = null;

function showBiUidModal(productId, serverId, customAmountCents) {
  pendingProductId = productId;
  pendingServerId = serverId || null;
  pendingCustomAmountCents = customAmountCents != null ? customAmountCents : null;
  const overlay = document.getElementById('biuidOverlay');
  const input = document.getElementById('biuidInput');
  const error = document.getElementById('biuidError');
  input.value = '';
  error.textContent = '';
  overlay.classList.add('open');
  input.focus();
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

document.getElementById('biuidSubmit').addEventListener('click', async () => {
  const input = document.getElementById('biuidInput');
  const error = document.getElementById('biuidError');
  const submitBtn = document.getElementById('biuidSubmit');

  const raw = input.value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)) {
    error.textContent = 'Invalid format. Expected: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving...';
  error.textContent = '';

  try {
    await api('/api/shop/set-bi-uid', {
      method: 'POST',
      body: JSON.stringify({ biUid: raw })
    });
    currentUser.bi_uid = raw;
    const pid = pendingProductId;
    const sid = pendingServerId;
    const amt = pendingCustomAmountCents;
    hideBiUidModal();
    renderAuth();
    if (pid) proceedCheckout(pid, sid, amt);
  } catch (e) {
    error.textContent = e.message || 'Failed to save BI UID';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save & Continue';
  }
});

async function saveBiUidFromDropdown() {
  const input = document.getElementById('dropdownBiUidInput');
  const raw = input.value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)) {
    alert('Invalid format. Expected: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx');
    return;
  }
  try {
    await api('/api/shop/set-bi-uid', {
      method: 'POST',
      body: JSON.stringify({ biUid: raw })
    });
    currentUser.bi_uid = raw;
    renderAuth();
  } catch (e) {
    alert(e.message || 'Failed to save BI UID');
  }
}

// ---- Buy flow ----
async function buyProduct(productId, serverId, customAmountCents) {
  if (!currentUser) return;

  const product = currentProducts.find(p => p.id === productId);
  // Server-specific or custom-priced products need a picker → route through
  // the detail modal whenever the caller didn't already collect the inputs.
  const needsServer = product && product.server_specific && !serverId;
  const needsAmount = product && product.custom_price && (customAmountCents == null);
  if (needsServer || needsAmount) {
    openProductDetail(productId);
    return;
  }

  const isSteam = (currentUser.platform || 'steam') === 'steam';
  if (isSteam && !currentUser.bi_uid) {
    showBiUidModal(productId, serverId, customAmountCents);
    return;
  }
  if (!isSteam && !currentUser.bi_uid) {
    alert("We couldn't find your BI UID via BattleMetrics yet. Play one round on a tracked ReforgedZ server, then come back.");
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

async function proceedCheckout(productId, serverId, customAmountCents) {
  const btn = document.querySelector(`.shop-card[data-id="${productId}"] .shop-buy-btn`);
  if (btn) { btn.disabled = true; btn.textContent = 'Redirecting...'; }

  try {
    const data = await api('/api/shop/checkout', {
      method: 'POST',
      body: JSON.stringify({
        productId,
        testMode: isTestMode,
        serverId: serverId || null,
        customAmountCents: customAmountCents != null ? customAmountCents : undefined
      })
    });
    if (data.url) {
      window.location.href = data.url;
    }
  } catch (e) {
    alert(e.message || 'Checkout failed');
    if (btn) { btn.disabled = false; btn.textContent = 'Purchase'; }
  }
}

// ---- Admin: type-change toggles interval days field ----
formType.addEventListener('change', () => {
  formIntervalRow.style.display = formType.value === 'recurring_custom' ? 'block' : 'none';
});

formStockLimited.addEventListener('change', () => {
  formStockRow.style.display = formStockLimited.checked ? 'block' : 'none';
  if (!formStockLimited.checked) formStockLimit.value = '';
});

function refreshStockLabel() {
  formStockLimitLabel.textContent = formServerSpecific.checked
    ? 'Max active buyers per server'
    : 'Max active buyers / subscribers';
}

formServerSpecific.addEventListener('change', refreshStockLabel);
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

  const body = {
    title: formTitle.value.trim(),
    description: formDesc.value.trim(),
    priceCents: Math.round(price * 100),
    type,
    imageUrl: formImage.value.trim() || null,
    intervalDays,
    imagesExtra,
    stockLimit,
    serverSpecific: formServerSpecific.checked,
    grantsPriorityQueue: formGrantsPriorityQueue.checked,
    customPrice,
    priceMinCents,
    priceMaxCents
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
    formCustomPrice.checked = !!p.custom_price;
    formPriceMin.value = p.price_min_cents != null ? (p.price_min_cents / 100).toFixed(2) : '';
    formPriceMax.value = p.price_max_cents != null ? (p.price_max_cents / 100).toFixed(2) : '';
    refreshStockLabel();
    refreshCustomPriceUi();
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
  formCustomPrice.checked = false;
  formPriceMin.value = '';
  formPriceMax.value = '';
  refreshStockLabel();
  refreshCustomPriceUi();
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
    ? `\n\nThis will also CANCEL ${subCount} active Stripe subscription(s) — affected users stop being billed immediately.`
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

  container.innerHTML = visible.map(o => {
    const isActiveSub = (o.type === 'subscription' || o.type === 'recurring_custom') && o.status === 'completed' && o.stripe_subscription_id;
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
            ${o.status} &middot; ${formatDate(o.created_at)} &middot; ${formatPrice(o.amount_cents, o.currency || 'usd', o.type)}
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
async function checkAlerts() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('success') === '1') {
    alertSuccess.style.display = 'block';
    const sessionId = params.get('session_id');
    if (sessionId) {
      try {
        await api('/api/shop/verify-session', {
          method: 'POST',
          body: JSON.stringify({ sessionId })
        });
      } catch (e) {}
    }
    window.history.replaceState({}, '', '/shop');
  }
  if (params.get('cancelled') === '1') {
    alertCancelled.style.display = 'block';
    window.history.replaceState({}, '', '/shop');
  }
}

// ---- Init ----
async function init() {
  bindCurrencyPills();
  bindSigninDropdown();
  await loadFx();
  checkAlerts();
  await loadUser();
  await loadProducts();
}

window.buyProduct = buyProduct;
window.editProduct = editProduct;
window.toggleProduct = toggleProduct;
window.deleteProduct = deleteProduct;
window.cancelSubscription = cancelSubscription;
window.saveBiUidFromDropdown = saveBiUidFromDropdown;
window.openProductDetail = openProductDetail;
window.openSigninFromCard = openSigninFromCard;
window.hardDeleteProduct = hardDeleteProduct;

init();

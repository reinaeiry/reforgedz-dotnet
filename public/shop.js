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

function formatTypeLabel(type, intervalDays) {
  if (type === 'subscription') return 'Subscription';
  if (type === 'recurring_custom') return `Renewable · every ${intervalDays || '?'} day${intervalDays === 1 ? '' : 's'}`;
  return 'One-Time';
}

function stockBadgeHtml(p) {
  if (p.stock_limit == null) return '';
  const used = p.stock_used || 0;
  const limit = p.stock_limit;
  const remaining = Math.max(0, limit - used);
  if (remaining === 0) return '<span class="stock-badge sold-out">Sold out</span>';
  const cls = remaining <= Math.max(1, Math.floor(limit * 0.2)) ? 'low' : 'available';
  return `<span class="stock-badge ${cls}">${remaining} / ${limit} left</span>`;
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

    const adminHtml = isAdmin ? `
      <div class="shop-card-admin" style="display: flex" onclick="event.stopPropagation()">
        <button class="card-edit-btn" onclick="event.stopPropagation(); editProduct(${p.id})">Edit</button>
        <button class="card-toggle-btn" onclick="event.stopPropagation(); toggleProduct(${p.id}, ${p.active ? 0 : 1})">
          ${p.active ? 'Deactivate' : 'Activate'}
        </button>
        <button class="card-delete-btn" onclick="event.stopPropagation(); deleteProduct(${p.id})">Delete</button>
      </div>
    ` : '';

    const inactiveClass = (!p.active && isAdmin) ? ' inactive' : '';
    const soldOut = p.sold_out === true;
    const soldOutClass = soldOut ? ' sold-out' : '';

    const buyBtnHtml = currentUser
      ? (soldOut
          ? `<button class="shop-buy-btn" disabled onclick="event.stopPropagation()">Sold out</button>`
          : `<button class="shop-buy-btn" ${p.active ? '' : 'disabled'} onclick="event.stopPropagation(); buyProduct(${p.id})">Purchase</button>`)
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
            <span class="shop-card-price">${formatPrice(p.price_cents, p.currency || 'usd', p.type, p.interval_days)}</span>
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

function openProductDetail(productId) {
  const product = currentProducts.find(p => p.id === productId);
  if (!product) return;
  detailProduct = product;
  detailImageIndex = 0;
  detailImages = [];
  if (product.image_url) detailImages.push(product.image_url);
  for (const u of (product.images || [])) {
    if (u && u !== product.image_url) detailImages.push(u);
  }

  const detailType = document.getElementById('detailType');
  detailType.innerHTML = escHtml(formatTypeLabel(product.type, product.interval_days)) + stockBadgeHtml(product);
  document.getElementById('detailTitle').textContent = product.title;
  document.getElementById('detailDesc').textContent = product.description || '';
  refreshDetailPrice();
  renderDetailImage();

  const buyBtn = document.getElementById('detailBuy');
  const soldOut = product.sold_out === true;
  if (currentUser) {
    if (soldOut) {
      buyBtn.textContent = 'Sold out';
      buyBtn.disabled = true;
      buyBtn.onclick = null;
    } else {
      buyBtn.textContent = product.active ? 'Purchase' : 'Unavailable';
      buyBtn.disabled = !product.active;
      buyBtn.onclick = () => { closeDetail(); buyProduct(product.id); };
    }
  } else {
    buyBtn.textContent = 'Sign in to buy';
    buyBtn.disabled = false;
    buyBtn.onclick = () => { closeDetail(); openSigninFromCard(); };
  }

  document.getElementById('detailOverlay').classList.add('open');
}

function refreshDetailPrice() {
  if (!detailProduct) return;
  document.getElementById('detailPrice').innerHTML = formatPrice(detailProduct.price_cents, detailProduct.currency || 'usd', detailProduct.type, detailProduct.interval_days);
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

function showBiUidModal(productId) {
  pendingProductId = productId;
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
  hideBiUidModal();
  if (pid) proceedCheckout(pid);
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
    hideBiUidModal();
    renderAuth();
    if (pid) proceedCheckout(pid);
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
async function buyProduct(productId) {
  if (!currentUser) return;

  const isSteam = (currentUser.platform || 'steam') === 'steam';
  if (isSteam && !currentUser.bi_uid) {
    showBiUidModal(productId);
    return;
  }
  if (!isSteam && !currentUser.bi_uid) {
    alert("We couldn't find your BI UID via BattleMetrics yet. Play one round on a tracked ReforgedZ server, then come back.");
    return;
  }

  const alreadyOwned = userOrders.find(o => o.product_id === productId && o.status === 'completed' && o.type === 'one_time');
  if (alreadyOwned) {
    if (!confirm('You already own this item. Purchase again?')) return;
  }

  proceedCheckout(productId);
}

async function proceedCheckout(productId) {
  const btn = document.querySelector(`.shop-card[data-id="${productId}"] .shop-buy-btn`);
  if (btn) { btn.disabled = true; btn.textContent = 'Redirecting...'; }

  try {
    const data = await api('/api/shop/checkout', {
      method: 'POST',
      body: JSON.stringify({ productId, testMode: isTestMode })
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

  const body = {
    title: formTitle.value.trim(),
    description: formDesc.value.trim(),
    priceCents: Math.round(price * 100),
    type,
    imageUrl: formImage.value.trim() || null,
    intervalDays,
    imagesExtra,
    stockLimit
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
  const visible = (orders || []).filter(o => o.status !== 'refunded');
  if (visible.length === 0) {
    container.innerHTML = '<div class="dropdown-empty">No purchases yet.</div>';
    return;
  }

  container.innerHTML = visible.map(o => {
    const isActiveSub = (o.type === 'subscription' || o.type === 'recurring_custom') && o.status === 'completed' && o.stripe_subscription_id;
    const cancelBtn = isActiveSub
      ? `<button class="cancel-sub-btn" onclick="cancelSubscription(${o.id}, event)">Cancel</button>`
      : '';

    return `
      <div class="dropdown-order">
        <div class="dropdown-order-info">
          <div class="dropdown-order-title">${escHtml(o.title)}</div>
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

init();

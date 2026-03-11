// ---- State ----
let currentUser = null;
let isTestMode = false;
let editingProductId = null;
let dropdownOpen = false;

// ---- DOM refs ----
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
const formEditId = document.getElementById('formEditId');
const formSubmitBtn = document.getElementById('formSubmitBtn');
const formCancelBtn = document.getElementById('formCancelBtn');

// ---- Helpers ----
function formatPrice(cents, currency, type) {
  const amount = (cents / 100).toFixed(2);
  const symbol = currency === 'usd' ? '$' : currency.toUpperCase() + ' ';
  const suffix = type === 'subscription' ? '<span class="per">/mo</span>' : '';
  return symbol + amount + suffix;
}

function formatDate(unix) {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
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
  if (currentUser) {
    navAuth.innerHTML = `
      <button class="account-toggle" id="accountToggle">
        <img src="${currentUser.avatar_url || ''}" alt="" class="nav-avatar" onerror="this.style.display='none'">
        <span class="persona">${escHtml(currentUser.persona)}</span>
        <span class="chevron"></span>
      </button>
      <div class="account-dropdown" id="accountDropdown">
        <div class="dropdown-header">
          <img src="${currentUser.avatar_url || ''}" alt="" onerror="this.style.display='none'">
          <div class="dropdown-header-info">
            <div class="dropdown-header-name">${escHtml(currentUser.persona)}</div>
            <div class="dropdown-header-role ${currentUser.role === 'admin' ? 'admin' : ''}">${currentUser.role === 'admin' ? 'Admin' : 'Member'}</div>
          </div>
        </div>
        <div class="dropdown-biuid">
          <div class="dropdown-biuid-label">Bohemia Identity ID</div>
          ${currentUser.bi_uid
            ? `<div class="dropdown-biuid-value">${escHtml(currentUser.bi_uid)}</div>`
            : `<div class="dropdown-biuid-value empty">Not set</div>`
          }
          <div class="dropdown-biuid-row">
            <input type="text" id="dropdownBiUidInput" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${currentUser.bi_uid || ''}" spellcheck="false" autocomplete="off">
            <button onclick="saveBiUidFromDropdown()">Save</button>
          </div>
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

    // Bind dropdown toggle
    const toggle = document.getElementById('accountToggle');
    const dropdown = document.getElementById('accountDropdown');
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdownOpen = !dropdownOpen;
      toggle.classList.toggle('open', dropdownOpen);
      dropdown.classList.toggle('open', dropdownOpen);
    });

    // Admin UI
    if (currentUser.role === 'admin') {
      adminPanel.style.display = 'block';
      testBanner.style.display = 'flex';
      isTestMode = sessionStorage.getItem('rz_test_mode') === '1';
      testModeToggle.checked = isTestMode;
    }

    loadOrders();
  } else {
    navAuth.innerHTML = `
      <a href="/auth/steam" class="steam-btn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.04 2 11.04c0 3.15 1.73 5.92 4.33 7.5l2.6-3.76c-.14-.04-.28-.1-.41-.17a2.5 2.5 0 1 1 3.45-.91l2.58 3.73C18.16 16.99 22 14.36 22 11.04 22 6.04 17.52 2 12 2zm4.5 9.54a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>
        Sign in with Steam
      </a>
    `;
  }
}

// Close dropdown on outside click
document.addEventListener('click', () => {
  if (!dropdownOpen) return;
  dropdownOpen = false;
  const toggle = document.getElementById('accountToggle');
  const dropdown = document.getElementById('accountDropdown');
  if (toggle) toggle.classList.remove('open');
  if (dropdown) dropdown.classList.remove('open');
});

// ---- Test mode ----
testModeToggle.addEventListener('change', () => {
  isTestMode = testModeToggle.checked;
  sessionStorage.setItem('rz_test_mode', isTestMode ? '1' : '0');
});

// ---- Products ----
async function loadProducts() {
  try {
    const isAdmin = currentUser && currentUser.role === 'admin';
    const url = isAdmin ? '/api/shop/admin/products' : '/api/shop/products';
    const products = await api(url);
    renderProducts(products);
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
      <div class="shop-card-admin" style="display: flex">
        <button class="card-edit-btn" onclick="editProduct(${p.id})">Edit</button>
        <button class="card-toggle-btn" onclick="toggleProduct(${p.id}, ${p.active ? 0 : 1})">
          ${p.active ? 'Deactivate' : 'Activate'}
        </button>
        <button class="card-delete-btn" onclick="deleteProduct(${p.id})">Delete</button>
      </div>
    ` : '';

    const inactiveClass = (!p.active && isAdmin) ? ' inactive' : '';
    const canBuy = currentUser && p.active;

    return `
      <div class="shop-card${inactiveClass}" data-id="${p.id}">
        ${imgHtml}
        <div class="shop-card-body">
          <div class="shop-card-type ${p.type}">${p.type === 'subscription' ? 'Subscription' : 'One-Time'}</div>
          <h3>${escHtml(p.title)}</h3>
          <p>${escHtml(p.description || '')}</p>
          <div class="shop-card-footer">
            <span class="shop-card-price">${formatPrice(p.price_cents, p.currency || 'usd', p.type)}</span>
            <button class="shop-buy-btn" ${canBuy ? '' : 'disabled'} onclick="buyProduct(${p.id})">
              ${currentUser ? 'Purchase' : 'Sign in to buy'}
            </button>
          </div>
          ${adminHtml}
        </div>
      </div>
    `;
  }).join('');
}

// ---- BI UID modal ----
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
  // Re-enable the buy button
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

  if (!currentUser.bi_uid) {
    showBiUidModal(productId);
    return;
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

// ---- Admin: Create/Edit ----
productForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const price = parseFloat(formPrice.value);
  if (!price || price < 0.50) return alert('Minimum price is $0.50');

  const body = {
    title: formTitle.value.trim(),
    description: formDesc.value.trim(),
    priceCents: Math.round(price * 100),
    type: formType.value,
    imageUrl: formImage.value.trim() || null
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
    renderOrders(orders, container);
  } catch (e) {
    container.innerHTML = '<div class="dropdown-empty">Failed to load orders.</div>';
  }
}

function renderOrders(orders, container) {
  if (!orders || orders.length === 0) {
    container.innerHTML = '<div class="dropdown-empty">No purchases yet.</div>';
    return;
  }

  container.innerHTML = orders.map(o => {
    const isActiveSub = o.type === 'subscription' && o.status === 'completed' && o.stripe_subscription_id;
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
async function cancelSubscription(orderId, e) {
  if (e) e.stopPropagation();

  if (!confirm('Cancel this subscription? It will remain active until the end of the current billing period.')) return;

  const btn = e && e.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Cancelling...'; }

  try {
    await api('/api/shop/cancel-subscription', {
      method: 'POST',
      body: JSON.stringify({ orderId })
    });
    loadOrders();
  } catch (err) {
    alert(err.message || 'Failed to cancel subscription');
    if (btn) { btn.disabled = false; btn.textContent = 'Cancel'; }
  }
}

// ---- URL alerts + session verification ----
async function checkAlerts() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('success') === '1') {
    alertSuccess.style.display = 'block';

    // Verify the checkout session so orders don't stay pending if webhooks fail
    const sessionId = params.get('session_id');
    if (sessionId) {
      try {
        await api('/api/shop/verify-session', {
          method: 'POST',
          body: JSON.stringify({ sessionId })
        });
      } catch (e) {
        // Silent — webhook may still handle it
      }
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
  checkAlerts();
  await loadUser();
  await loadProducts();
}

// Make functions available globally for onclick handlers
window.buyProduct = buyProduct;
window.editProduct = editProduct;
window.toggleProduct = toggleProduct;
window.deleteProduct = deleteProduct;
window.cancelSubscription = cancelSubscription;
window.saveBiUidFromDropdown = saveBiUidFromDropdown;

init();

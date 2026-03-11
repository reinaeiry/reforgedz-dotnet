// ---- State ----
let currentUser = null;
let isTestMode = false;
let editingProductId = null;

// ---- DOM refs ----
const navAuth = document.getElementById('navAuth');
const steamLoginBtn = document.getElementById('steamLoginBtn');
const testBanner = document.getElementById('testBanner');
const testModeToggle = document.getElementById('testModeToggle');
const alertSuccess = document.getElementById('alertSuccess');
const alertCancelled = document.getElementById('alertCancelled');
const adminPanel = document.getElementById('adminPanel');
const productForm = document.getElementById('productForm');
const productGrid = document.getElementById('productGrid');
const purchaseHistory = document.getElementById('purchaseHistory');
const orderList = document.getElementById('orderList');
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
      <img src="${currentUser.avatar_url || ''}" alt="" class="nav-avatar" onerror="this.style.display='none'">
      <span class="nav-persona">${escHtml(currentUser.persona)}</span>
      <a href="/auth/logout" class="logout-link">Sign out</a>
    `;

    // Admin UI
    if (currentUser.role === 'admin') {
      adminPanel.style.display = 'block';
      testBanner.style.display = 'flex';
      // Restore test mode from session
      isTestMode = sessionStorage.getItem('rz_test_mode') === '1';
      testModeToggle.checked = isTestMode;
    }

    purchaseHistory.style.display = 'block';
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

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

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

// ---- Buy flow ----
async function buyProduct(productId) {
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
  // Find the product data by fetching again (simple approach)
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

// ---- Orders ----
async function loadOrders() {
  if (!currentUser) return;

  try {
    const orders = await api('/api/shop/orders');
    renderOrders(orders);
  } catch (e) {
    orderList.innerHTML = '<div class="order-empty">Failed to load orders.</div>';
  }
}

function renderOrders(orders) {
  if (!orders || orders.length === 0) {
    orderList.innerHTML = '<div class="order-empty">No purchases yet.</div>';
    return;
  }

  const header = `
    <div class="order-row order-row-header">
      <span>Item</span>
      <span>Amount</span>
      <span>Date</span>
      <span>Status</span>
    </div>
  `;

  const rows = orders.map(o => `
    <div class="order-row">
      <span class="order-title">${escHtml(o.title)}</span>
      <span class="order-amount">${formatPrice(o.amount_cents, o.currency || 'usd', o.type)}</span>
      <span class="order-date">${formatDate(o.created_at)}</span>
      <span><span class="order-status ${o.status}">${o.status}</span></span>
    </div>
  `).join('');

  orderList.innerHTML = header + rows;
}

// ---- URL alerts ----
function checkAlerts() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('success') === '1') {
    alertSuccess.style.display = 'block';
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

init();

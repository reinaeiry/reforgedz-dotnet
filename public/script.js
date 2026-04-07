// ---- Tab switching ----
const navLinks = document.querySelectorAll('.nav-link[data-tab]');
const sections = document.querySelectorAll('.tab-content');

function switchTab(tabId) {
  navLinks.forEach(l => l.classList.remove('active'));
  sections.forEach(s => s.classList.remove('active'));

  document.querySelectorAll(`[data-tab="${tabId}"]`).forEach(el => {
    if (el.tagName !== 'A') el.classList.add('active');
  });

  const section = document.getElementById('tab-' + tabId);
  if (section) {
    section.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'instant' });
    section.querySelectorAll('.reveal:not(.visible)').forEach(el => revealObserver.observe(el));
  }
}

navLinks.forEach(link => {
  link.addEventListener('click', () => {
    switchTab(link.dataset.tab);
    // Close mobile menu on nav
    document.getElementById('navLinks')?.classList.remove('open');
    document.getElementById('navHamburger')?.classList.remove('open');
  });
});

// ---- Mobile hamburger menu ----
const hamburger = document.getElementById('navHamburger');
const navLinksEl = document.getElementById('navLinks');
if (hamburger && navLinksEl) {
  hamburger.addEventListener('click', () => {
    hamburger.classList.toggle('open');
    navLinksEl.classList.toggle('open');
  });
}

// Nav brand also goes to home
document.querySelector('.nav-brand')?.addEventListener('click', (e) => {
  e.preventDefault();
  switchTab('home');
});

// ---- Nav background on scroll ----
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 40);
}, { passive: true });

// ---- Hero image slow zoom ----
window.addEventListener('load', () => {
  document.querySelector('.hero-bg')?.classList.add('loaded');
});

// ---- Scroll reveal ----
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const siblings = entry.target.parentElement.querySelectorAll('.reveal');
      const idx = Array.from(siblings).indexOf(entry.target);
      entry.target.style.transitionDelay = (idx * 0.08) + 's';
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.08 });

document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

// ---- Counter animation ----
const counterObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const el = entry.target;
      const target = parseInt(el.dataset.count);
      if (!target) return;
      let current = 0;
      const step = Math.ceil(target / 40);
      const interval = setInterval(() => {
        current = Math.min(current + step, target);
        el.textContent = current + '+';
        if (current >= target) clearInterval(interval);
      }, 28);
      counterObserver.unobserve(el);
    }
  });
}, { threshold: 0.5 });

document.querySelectorAll('[data-count]').forEach(el => counterObserver.observe(el));

// ---- Server Status ----
const serversGrid = document.getElementById('serversGrid');
const serversUpdated = document.getElementById('serversUpdated');

function stateLabel(s) {
  const map = { running: 'Online', offline: 'Offline', starting: 'Starting', stopping: 'Stopping' };
  return map[s] || 'Unknown';
}

function renderServers(data) {
  if (!serversGrid) return;
  if (!data.servers || data.servers.length === 0) {
    serversGrid.innerHTML = '<div class="server-card server-placeholder"><span class="server-placeholder-text">No servers found</span></div>';
    return;
  }

  serversGrid.innerHTML = data.servers.map(srv => `
    <div class="server-card">
      <div class="server-top">
        <span class="server-status-dot ${srv.state}"></span>
        <span class="server-state ${srv.state}">${stateLabel(srv.state)}</span>
        <span class="server-region">${srv.region}</span>
      </div>
      <div class="server-name">${srv.name}</div>
      <div class="server-meta">
        ${srv.ip ? `<span class="server-ip" title="Click to copy" onclick="navigator.clipboard.writeText('${srv.ip}')">${srv.ip}</span>` : ''}
        ${srv.uptime ? `<span class="server-uptime">Up ${srv.uptime}</span>` : ''}
      </div>
    </div>
  `).join('');

  if (serversUpdated && data.lastUpdate) {
    const ago = Math.round((Date.now() - new Date(data.lastUpdate).getTime()) / 1000);
    serversUpdated.textContent = ago < 5 ? 'Just updated' : `Updated ${ago}s ago`;
  }
}

function fetchServerStatus() {
  fetch('/api/servers/status')
    .then(r => r.json())
    .then(renderServers)
    .catch(() => {});
}

fetchServerStatus();
setInterval(fetchServerStatus, 30000);

// ---- URL-based tab routing ----
const pathTab = window.location.pathname.replace(/^\/+|\/+$/g, '');
if (pathTab && document.getElementById('tab-' + pathTab)) {
  switchTab(pathTab);
}

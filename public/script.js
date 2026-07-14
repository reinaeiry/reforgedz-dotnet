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

// Honor a #about / #radio / #contact hash on load (used by the other pages
// that link back to a specific homepage tab).
(function initFromHash() {
  const validTabs = Array.from(sections).map(s => s.id.replace(/^tab-/, ''));
  const raw = (location.hash || '').replace(/^#/, '');
  if (raw && validTabs.includes(raw)) switchTab(raw);
})();
window.addEventListener('hashchange', () => {
  const validTabs = Array.from(sections).map(s => s.id.replace(/^tab-/, ''));
  const raw = (location.hash || '').replace(/^#/, '');
  if (raw && validTabs.includes(raw)) switchTab(raw);
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

function shortName(name) {
  const m = name.match(/\[([^\]]+)\]/);
  return m ? m[1] : name;
}

function mapName(name) {
  // Derive the map from the server's own name so it stays correct as servers
  // change (e.g. "[EU3] Official ReforgedZ Everon"). Defaults to Chernarus.
  if (/everon/i.test(name)) return 'Everon';
  return 'Chernarus';
}

const REGION_ORDER = ['EU', 'NA', '??'];
const REGION_LABELS = { EU: 'Europe', NA: 'North America', '??': 'Other' };

function renderServers(data) {
  if (!serversGrid) return;
  if (!data.servers || data.servers.length === 0) {
    serversGrid.innerHTML = '<div class="status-placeholder"><span class="status-placeholder-text">No servers found</span></div>';
    return;
  }

  const groups = {};
  for (const srv of data.servers) {
    const region = srv.region || '??';
    (groups[region] = groups[region] || []).push(srv);
  }

  const regionKeys = REGION_ORDER.filter(r => groups[r]);
  for (const k of Object.keys(groups)) {
    if (!regionKeys.includes(k)) regionKeys.push(k);
  }

  serversGrid.innerHTML = regionKeys.map(region => {
    const list = groups[region].slice().sort((a, b) => shortName(a.name).localeCompare(shortName(b.name)));
    const tiles = list.map(srv => {
      const tag = shortName(srv.name);
      const map = mapName(srv.name);
      const hasCount = srv.players != null && srv.max != null && srv.max > 0;
      const players = hasCount ? srv.players : null;
      const max = hasCount ? srv.max : null;
      const pct = hasCount ? Math.max(0, Math.min(100, Math.round((players / max) * 100))) : 0;
      const countText = hasCount ? `${players}/${max}` : '--/--';
      return `<div class="status-tile ${srv.state} reveal visible">
        <div class="status-head">
          <span class="status-dot ${srv.state}"></span>
          <span class="status-tag">${tag}</span>
          <span class="status-spacer"></span>
          <span class="status-info ${srv.state}">${stateLabel(srv.state)}</span>
        </div>
        <div class="status-players">
          <div class="status-bar"><div class="status-bar-fill" style="width:${pct}%"></div></div>
          <div class="status-bar-text">${countText}</div>
        </div>
        <div class="status-map">${map}</div>
      </div>`;
    }).join('');
    const label = REGION_LABELS[region] || region;
    return `<div class="status-region">
      <div class="status-region-head">
        <span class="status-region-label">${label}</span>
        <span class="status-region-count">${list.length} server${list.length === 1 ? '' : 's'}</span>
      </div>
      <div class="status-tiles">${tiles}</div>
    </div>`;
  }).join('');

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

// ---- Deep links to a section INSIDE the home tab (e.g. /#nattiiguard, via /nattiiguard) ----
// The tab router owns scrolling, so a hash that isn't a tab needs its own handling. Without
// this, the browser's native anchor jump races the reveal animations and image loading, and
// the viewport ends up stranded partway down the hero with the nav shoved off the top.
(function () {
  function scrollToHashSection() {
    const raw = (location.hash || '').replace(/^#/, '');
    if (!raw) return;
    const el = document.getElementById(raw);
    if (!el || el.classList.contains('tab-content')) return;   // tabs are the router's business
    switchTab('home');
    // reveal immediately -- arriving at a section that then fades in around you feels broken
    el.querySelectorAll('.reveal').forEach(r => r.classList.add('visible'));
    // 'instant', explicitly: the page sets scroll-behavior:smooth globally, and 'auto' defers
    // to it -- turning a deep link into a multi-second lurch from the hero to the section.
    requestAnimationFrame(() => el.scrollIntoView({ behavior: 'instant', block: 'start' }));
  }
  // once now, again when images have sized the page (layout shifts in between)
  scrollToHashSection();
  window.addEventListener('load', scrollToHashSection);
  window.addEventListener('hashchange', scrollToHashSection);
})();

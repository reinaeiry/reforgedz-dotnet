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
  link.addEventListener('click', () => switchTab(link.dataset.tab));
});

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

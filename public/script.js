// ---- Tabs ----
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // Re-observe reveals on new tab
    document.querySelectorAll('.reveal:not(.visible)').forEach(el => revealObserver.observe(el));
  });
});

// ---- Particles ----
(function() {
  const c = document.getElementById('particles');
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDuration = (18 + Math.random() * 22) + 's';
    p.style.animationDelay = (Math.random() * 18) + 's';
    const size = 1 + Math.random() * 2;
    p.style.width = size + 'px';
    p.style.height = size + 'px';
    c.appendChild(p);
  }
})();

// ---- Smooth cursor glow ----
const glow = document.getElementById('cursorGlow');
let mx = 0, my = 0, gx = 0, gy = 0;
document.addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; });
(function chase() {
  gx += (mx - gx) * 0.06;
  gy += (my - gy) * 0.06;
  glow.style.left = gx + 'px';
  glow.style.top = gy + 'px';
  requestAnimationFrame(chase);
})();

// ---- Scroll reveals ----
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry, i) => {
    if (entry.isIntersecting) {
      // Stagger based on position in grid
      const siblings = entry.target.parentElement.querySelectorAll('.reveal');
      const idx = Array.from(siblings).indexOf(entry.target);
      entry.target.style.transitionDelay = (idx * 0.08) + 's';
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.05 });

document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

// ---- Nav scroll ----
const nav = document.getElementById('mainNav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 50);
}, { passive: true });

// ---- Card tilt ----
document.querySelectorAll('.glow-border').forEach(card => {
  card.addEventListener('mousemove', e => {
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const tiltX = (x - 0.5) * 6;
    const tiltY = (y - 0.5) * -6;
    card.style.transform = `perspective(600px) rotateY(${tiltX}deg) rotateX(${tiltY}deg) scale(1.01)`;
    // Move inner glow
    card.style.setProperty('--mx', (x * 100) + '%');
    card.style.setProperty('--my', (y * 100) + '%');
  });
  card.addEventListener('mouseleave', () => {
    card.style.transform = '';
    card.style.transition = 'transform 0.5s cubic-bezier(0.4,0,0.2,1)';
    setTimeout(() => { card.style.transition = ''; }, 500);
  });
});

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
        current += step;
        if (current >= target) {
          current = target;
          clearInterval(interval);
        }
        el.textContent = current + '+';
      }, 30);
      counterObserver.unobserve(el);
    }
  });
}, { threshold: 0.5 });

document.querySelectorAll('[data-count]').forEach(el => counterObserver.observe(el));

// ---- Magnetic buttons ----
document.querySelectorAll('.btn-primary, .btn-join').forEach(btn => {
  btn.addEventListener('mousemove', e => {
    const r = btn.getBoundingClientRect();
    const x = e.clientX - r.left - r.width / 2;
    const y = e.clientY - r.top - r.height / 2;
    btn.style.transform = `translate(${x * 0.15}px, ${y * 0.25}px)`;
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.transform = '';
    btn.style.transition = 'transform 0.4s cubic-bezier(0.4,0,0.2,1)';
    setTimeout(() => { btn.style.transition = ''; }, 400);
  });
});

// ---- Hero title entrance ----
window.addEventListener('load', () => {
  const title = document.querySelector('.hero-title');
  const badge = document.querySelector('.hero-badge');
  const line = document.querySelector('.hero-line');
  const sub = document.querySelector('.hero-subtitle');
  const desc = document.querySelector('.hero-desc');
  const btns = document.querySelector('.hero-buttons');

  [badge, title, line, sub, desc, btns].forEach((el, i) => {
    if (!el) return;
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = `opacity 0.8s cubic-bezier(0.4,0,0.2,1) ${0.1 + i * 0.12}s, transform 0.8s cubic-bezier(0.4,0,0.2,1) ${0.1 + i * 0.12}s`;
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });
  });
});

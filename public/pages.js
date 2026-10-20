// Shared behaviour of the document pages (/official, /join, /privacy, /terms, /changes).
// The homepage keeps script.js; these pages have no tabs, no server status and no radio.

// ---- Mobile menu ----
(function () {
  const burger = document.getElementById('navHamburger');
  const links = document.getElementById('navLinks');
  if (!burger || !links) return;
  burger.addEventListener('click', () => {
    const open = !links.classList.contains('open');
    links.classList.toggle('open', open);
    burger.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  // A link press closes the menu; so does Escape.
  links.addEventListener('click', (e) => {
    if (e.target.closest('a')) { links.classList.remove('open'); burger.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && links.classList.contains('open')) {
      links.classList.remove('open'); burger.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); burger.focus();
    }
  });
})();

// ---- What's changed: render public/changes.json ----
// Each entry is { date: "YYYY-MM-DD", title, line, proof }. proof is a sentence or a URL
// saying how the change was checked on the live servers. Everything is inserted as text,
// never as HTML, so a bad entry cannot run on the page.
(function () {
  const list = document.getElementById('changesList');
  if (!list) return;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function showEmpty(msg) {
    list.replaceChildren(el('p', 'changes-empty', msg));
  }

  function prettyDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  fetch('/changes.json', { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(entries => {
      if (!Array.isArray(entries) || entries.length === 0) {
        showEmpty('Nothing listed yet. Entries appear here once each change has been checked on the live servers.');
        return;
      }
      const sorted = entries.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      const ul = el('ul', 'changes-list');
      for (const e of sorted) {
        const li = el('li', 'changes-item');
        const time = el('time', 'changes-date', prettyDate(e.date));
        if (/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) time.setAttribute('datetime', e.date);
        li.appendChild(time);
        const body = el('div');
        body.appendChild(el('h3', 'changes-title', String(e.title || '')));
        if (e.line) body.appendChild(el('p', 'changes-line', String(e.line)));
        if (e.proof) {
          const p = el('p', 'changes-proof', 'How we checked: ');
          const proof = String(e.proof);
          if (/^https?:\/\//.test(proof)) {
            const a = el('a', 'inline', proof);
            a.href = proof; a.rel = 'noopener'; a.target = '_blank';
            p.appendChild(a);
          } else {
            p.appendChild(document.createTextNode(proof));
          }
          body.appendChild(p);
        }
        li.appendChild(body);
        ul.appendChild(li);
      }
      list.replaceChildren(ul);
    })
    .catch(() => showEmpty('The list could not be loaded just now. Try again in a moment.'));
})();

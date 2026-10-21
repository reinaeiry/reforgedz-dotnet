// Shared behaviour of the document pages (/join, /privacy, /terms, /changes).
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
// The full change log. Each entry is { date: "YYYY-MM-DD", title, items: [..], source }:
// a dated heading, the items as a bulleted list, the source as a small line. Newest
// first. Everything is inserted as text, never as HTML, so a bad entry cannot run on
// the page.
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
    list.setAttribute('aria-busy', 'false');
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
        showEmpty('Nothing listed yet.');
        return;
      }
      const sorted = entries.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      // An entry with `coming: true` is the team's preview of the next update: shown apart
      // from the dated log, so nothing reads as live before it is. Its log entry follows
      // when it ships.
      const coming = sorted.filter(e => e && e.coming === true);
      const shipped = sorted.filter(e => !(e && e.coming === true));
      const out = [];

      function itemsOf(e) {
        const items = Array.isArray(e.items) ? e.items : [];
        if (!items.length) return null;
        const il = el('ul', 'changes-items');
        for (const it of items) il.appendChild(el('li', null, String(it)));
        return il;
      }

      if (coming.length) {
        const sec = el('section', 'changes-coming');
        sec.id = 'coming';
        sec.appendChild(el('h2', 'changes-section-title', 'Coming soon'));
        sec.appendChild(el('p', 'changes-coming-note', 'What the team has shown but not yet shipped. The change log below follows when it goes live.'));
        for (const e of coming) {
          const box = el('div', 'changes-coming-entry');
          box.appendChild(el('h3', 'changes-title', String(e.title || '')));
          const il = itemsOf(e);
          if (il) box.appendChild(il);
          if (e.source) box.appendChild(el('p', 'changes-proof', 'Source: ' + String(e.source)));
          sec.appendChild(box);
        }
        out.push(sec);
        out.push(el('h2', 'changes-section-title', 'Live on the servers'));
      }

      const ul = el('ul', 'changes-list');
      for (const e of shipped) {
        const li = el('li', 'changes-item');
        const time = el('time', 'changes-date', prettyDate(e.date));
        if (/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) time.setAttribute('datetime', e.date);
        li.appendChild(time);
        const body = el('div');
        // h1 is the page title; entries sit under the section heading when there is one
        body.appendChild(el(coming.length ? 'h3' : 'h2', 'changes-title', String(e.title || '')));
        const il = itemsOf(e);
        if (il) body.appendChild(il);
        if (e.source) body.appendChild(el('p', 'changes-proof', 'Source: ' + String(e.source)));
        li.appendChild(body);
        ul.appendChild(li);
      }
      out.push(ul);
      list.replaceChildren(...out);
      list.setAttribute('aria-busy', 'false');
    })
    .catch(() => showEmpty('The list could not be loaded just now. Try again in a moment.'));
})();

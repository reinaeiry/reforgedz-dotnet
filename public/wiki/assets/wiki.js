// ReforgedZ Wiki: navigation drawer, search, checklists, phone page contents.
// Runs on the real site (one HTML file per page) and in the single-file review copy,
// where window.WK_BUNDLE carries every page and the search index.
(function () {
  'use strict';
  var BUNDLE = window.WK_BUNDLE || null;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  /* ---------- Navigation drawer (phones) ---------- */
  var menuBtn = $('[data-menu]');
  function setDrawer(open) {
    document.body.classList.toggle('wk-side-open', open);
    if (menuBtn) menuBtn.setAttribute('aria-expanded', String(open));
  }
  if (menuBtn) menuBtn.addEventListener('click', function () {
    setDrawer(!document.body.classList.contains('wk-side-open'));
  });
  document.addEventListener('click', function (e) {
    if (document.body.classList.contains('wk-side-open') && !e.target.closest('#wk-side') && !e.target.closest('[data-menu]')) setDrawer(false);
    // Phone "On this page" menu: close it once a heading is picked.
    var tocLink = e.target.closest('.wk-toc-mobile a');
    if (tocLink) tocLink.closest('details').open = false;
  });

  /* ---------- Checklists: list items that start with "[ ]" become tick boxes ---------- */
  function enhanceTasks(root, pageUrl) {
    var key = 'wk-tasks:' + pageUrl;
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { saved = {}; }
    Array.prototype.forEach.call(root.querySelectorAll('li'), function (li, i) {
      var host = li.firstChild && li.firstChild.nodeType === 3 ? li : li.firstElementChild;
      var textNode = host && host.firstChild;
      if (!textNode || textNode.nodeType !== 3) return;
      var m = textNode.nodeValue.match(/^\s*\[( |x)\]\s*/i);
      if (!m) return;
      textNode.nodeValue = textNode.nodeValue.slice(m[0].length);
      var id = 't' + i;
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = id in saved ? !!saved[id] : m[1].toLowerCase() === 'x';
      box.setAttribute('aria-label', 'Done');
      var span = document.createElement('span');
      while (li.firstChild) span.appendChild(li.firstChild);
      li.classList.add('wk-task');
      li.classList.toggle('done', box.checked);
      li.appendChild(box);
      li.appendChild(span);
      box.addEventListener('change', function () {
        saved[id] = box.checked;
        li.classList.toggle('done', box.checked);
        try { localStorage.setItem(key, JSON.stringify(saved)); } catch (e) { /* storage blocked: ticks last for this visit */ }
      });
    });
  }

  /* ---------- Search ---------- */
  // Plural-insensitive terms, so "plank" finds "planks". Must stay identical to stem() in build.mjs.
  function stem(term) {
    var t = String(term).toLowerCase();
    if (t.length > 3 && /s$/.test(t) && !/(ss|us|is)$/.test(t)) t = t.slice(0, -1);
    return t;
  }
  var OPTIONS = {
    fields: ['title', 'heading', 'text', 'keywords'],
    storeFields: ['title', 'heading', 'url', 'section', 'snippet'],
    processTerm: stem,
    // Word-start matching only from 4 letters, so "log" finds logs and not "logging".
    searchOptions: { boost: { title: 4, heading: 3, keywords: 3 }, prefix: function (term) { return term.length > 3; }, fuzzy: 0.2, processTerm: stem }
  };
  var index = null;
  var loading = null;
  function loadIndex() {
    if (index) return Promise.resolve(index);
    if (!loading) {
      loading = (BUNDLE ? Promise.resolve(BUNDLE.index) : fetch('/wiki/search-index.json').then(function (r) {
        if (!r.ok) throw new Error('index ' + r.status);
        return r.text();
      })).then(function (json) {
        if (!window.MiniSearch) throw new Error('search library missing');
        index = window.MiniSearch.loadJSON(json, OPTIONS);
        return index;
      });
      loading.catch(function () { loading = null; });
    }
    return loading;
  }

  var panel = $('#wk-search');
  var input = $('#wk-search-input');
  var results = $('#wk-search-results');
  var items = [];
  var sel = -1;
  var lastQuery = null;

  // Phones: size the search panel to the part of the screen the keyboard leaves visible.
  function fitViewport() {
    var vv = window.visualViewport;
    var root = document.documentElement.style;
    root.setProperty('--wk-vvh', Math.round(vv ? vv.height : window.innerHeight) + 'px');
    root.setProperty('--wk-vvtop', Math.round(vv ? vv.offsetTop : 0) + 'px');
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitViewport);
    window.visualViewport.addEventListener('scroll', fitViewport);
  }
  window.addEventListener('resize', fitViewport);
  fitViewport();

  function openSearch() {
    if (!panel) return;
    panel.hidden = false;
    document.body.classList.add('wk-search-on');
    input.value = '';
    results.innerHTML = '';
    items = [];
    lastQuery = '';
    fitViewport();
    input.focus();
    loadIndex().catch(function () {
      results.innerHTML = '<p class="wk-sr-empty">Search didn’t load. Reload the page and try again.</p>';
    });
  }
  function closeSearch() {
    if (!panel) return;
    panel.hidden = true;
    document.body.classList.remove('wk-search-on');
  }

  function select(i) {
    var links = results.querySelectorAll('.wk-sr');
    if (!links.length) return;
    sel = (i + links.length) % links.length;
    Array.prototype.forEach.call(links, function (a, j) { a.setAttribute('aria-selected', j === sel ? 'true' : 'false'); });
    links[sel].scrollIntoView({ block: 'nearest' });
  }

  function runSearch(q) {
    q = q.trim();
    // A phone keyboard can fire an input event with no change when it closes. Rebuilding the list then would pull
    // the result out from under the user's finger, so only rebuild when the query really changed.
    if (q === lastQuery) return;
    lastQuery = q;
    if (!q) { results.innerHTML = ''; items = []; return; }
    loadIndex().then(function (ix) {
      if (input.value.trim() !== q) return;
      var hits = ix.search(q, OPTIONS.searchOptions).slice(0, 30);
      var groups = [];
      var byName = {};
      hits.forEach(function (h) {
        if (!byName[h.section]) { byName[h.section] = []; groups.push(h.section); }
        if (byName[h.section].length < 6) byName[h.section].push(h);
      });
      items = [];
      var html = '';
      groups.forEach(function (g) {
        html += '<p class="wk-sr-group">' + esc(g) + '</p>';
        byName[g].forEach(function (h) {
          var i = items.push(h) - 1;
          var title = h.heading ? h.title + ' › ' + h.heading : h.title;
          html += '<a class="wk-sr" role="option" aria-selected="false" data-i="' + i + '" href="' + esc(h.url) + '">'
            + '<span class="wk-sr-title">' + esc(title) + '</span>'
            + (h.snippet ? '<span class="wk-sr-sub">' + esc(h.snippet) + '</span>' : '') + '</a>';
        });
      });
      results.innerHTML = html || '<p class="wk-sr-empty">Nothing matches “' + esc(q) + '”. Try a shorter word.</p>';
      results.scrollTop = 0;
      sel = -1;
    });
  }

  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-search-open]');
    if (opener) { e.preventDefault(); openSearch(); return; }
    if (e.target.closest('[data-search-close]') || e.target === panel) closeSearch();
  });
  document.addEventListener('keydown', function (e) {
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (e.key === '/' && panel && panel.hidden && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) { e.preventDefault(); openSearch(); }
    else if (e.key === 'Escape' && panel && !panel.hidden) closeSearch();
  });
  if (input) {
    input.addEventListener('input', function () { runSearch(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); select(sel + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); select(sel - 1); }
      else if (e.key === 'Enter') {
        var hit = items[sel >= 0 ? sel : 0];
        if (hit) { e.preventDefault(); go(hit.url); }
      }
    });
  }
  if (results) {
    // With a mouse, keep the field focused while a result is pressed so nothing moves before the click lands.
    results.addEventListener('mousedown', function (e) { if (e.target.closest('.wk-sr')) e.preventDefault(); });
    results.addEventListener('click', function (e) {
      var a = e.target.closest('.wk-sr');
      if (!a) return;
      // Always close the search: a result on the page you're already on only scrolls, and an open panel would hide that.
      e.preventDefault();
      go(a.getAttribute('href'));
    });
  }

  function go(url) {
    closeSearch();
    if (BUNDLE) { navigate(url); return; }
    var here = location.pathname;
    var path = url.split('#')[0];
    var hash = url.indexOf('#') >= 0 ? url.slice(url.indexOf('#') + 1) : '';
    if (path === here && hash) {
      var el = document.getElementById(hash);
      if (el) { history.replaceState(null, '', '#' + hash); el.scrollIntoView(); return; }
    }
    location.href = url;
  }

  /* ---------- Review copy: one file, hash routing ---------- */
  function currentTarget() {
    var h = decodeURIComponent(location.hash.slice(1));
    return h.indexOf('/wiki/') === 0 ? h : '/wiki/';
  }
  function navigate(url) {
    if (location.hash.slice(1) === url) render(url); else location.hash = url;
  }
  function render(target) {
    var parts = target.split('#');
    var path = parts[0];
    var page = BUNDLE.pages[path] || BUNDLE.pages['/wiki/404/'];
    $('#wk-main').innerHTML = page.main;
    var toc = $('.wk-toc, .wk-toc-empty');
    if (toc) toc.outerHTML = page.toc;
    document.body.className = page.home ? 'wk-is-home' : 'wk-is-page';
    Array.prototype.forEach.call(document.querySelectorAll('#wk-side a'), function (a) {
      if (a.getAttribute('href') === path) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = page.docTitle;
    enhanceTasks($('#wk-main'), path);
    var anchor = parts[1] && document.getElementById(parts[1]);
    if (anchor) anchor.scrollIntoView(); else window.scrollTo(0, 0);
  }

  if (BUNDLE) {
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented) return;
      var a = e.target.closest('a[href]');
      if (!a) return;
      var href = a.getAttribute('href');
      if (href.charAt(0) === '#') {
        e.preventDefault();
        var el = document.getElementById(href.slice(1));
        var gentle = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (el) el.scrollIntoView({ behavior: gentle ? 'auto' : 'smooth' });
      } else if (href.indexOf('/wiki/') === 0) {
        e.preventDefault();
        setDrawer(false);
        navigate(href);
      }
    });
    window.addEventListener('hashchange', function () { render(currentTarget()); });
    render(currentTarget());
  } else {
    var body = $('.wk-body');
    if (body) enhanceTasks(body, location.pathname);
  }
})();

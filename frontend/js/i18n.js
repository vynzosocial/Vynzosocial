(function () {
  'use strict';

  var KEY = 'vynzo_lang';
  var LANGS = [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Español' },
    { code: 'de', name: 'Deutsch' },
    { code: 'nl', name: 'Nederlands' },
    { code: 'hi', name: 'हिन्दी' },
    { code: 'ar', name: 'العربية', rtl: true },
    { code: 'fr', name: 'Français' },
    { code: 'pt', name: 'Português' },
    { code: 'ru', name: 'Русский' },
    { code: 'ur', name: 'اردو', rtl: true }
  ];
  var DICTS = window.VynzoI18nDicts = window.VynzoI18nDicts || {};
  var root = document.documentElement;
  var lang = readLang();
  var DICT = {};

  function langInfo(code) {
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code === code) return LANGS[i];
    return LANGS[0];
  }

  function readLang() {
    try {
      var saved = localStorage.getItem(KEY);
      for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code === saved) return saved;
    } catch (e) { /* storage unavailable */ }
    return 'en';
  }

  function loadDict(code, done) {
    if (code === 'en') { DICT = {}; done(); return; }
    if (DICTS[code]) { DICT = DICTS[code]; done(); return; }
    var s = document.createElement('script');
    s.src = baseUrl + 'i18n-' + code + '.js?v=2';
    s.onload = function () { DICT = DICTS[code] || {}; done(); };
    s.onerror = function () { DICT = {}; done(); };
    document.head.appendChild(s);
  }

  var baseUrl = (function () {
    var me = document.currentScript && document.currentScript.src;
    return me ? me.replace(/[^\/]*(\?.*)?$/, '') : '';
  })();

  // Parser-blocking load so the saved language is translated before first paint.
  if (lang !== 'en' && document.readyState === 'loading') {
    document.write('<script src="' + baseUrl + 'i18n-' + lang + '.js?v=2"><\/script>');
  }
  if (DICTS[lang]) DICT = DICTS[lang];

  function applyRoot() {
    root.setAttribute('lang', lang);
    root.setAttribute('dir', langInfo(lang).rtl ? 'rtl' : 'ltr');
  }
  applyRoot();

  /* ---------- translation lookup ---------- */
  var EDGE = /^([^\p{L}\p{N}]*)([\s\S]*?)([^\p{L}\p{N}]*)$/u;
  var PATTERNS = [
    [/^(\d+) min ago$/, '@min', ['n']],
    [/^(\d+) hours? ago$/, '@hours', ['n']],
    [/^(\d+) days? ago$/, '@days', ['n']],
    [/^Logged in as (.+)$/, '@loggedin', ['name']],
    [/^View (.+)'s profile$/, '@viewprofile', ['name']],
    [/^Watch (.+) live$/, '@watchlive', ['name']],
    [/^Post by (.+)$/, '@postby', ['name']]
  ];
  var countriesLang = null;

  function has(key) { return Object.prototype.hasOwnProperty.call(DICT, key); }
  function norm(s) {
    return s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, ' ');
  }
  function arPunct(s) {
    return (lang === 'ar' || lang === 'ur') ? s.replace(/\?/g, '؟').replace(/,/g, '،') : s;
  }

  function addCountryNames() {
    if (countriesLang === lang) return;
    countriesLang = lang;
    try {
      var en = new Intl.DisplayNames(['en'], { type: 'region' });
      var loc = new Intl.DisplayNames([lang], { type: 'region' });
      var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      for (var i = 0; i < 26; i++) {
        for (var j = 0; j < 26; j++) {
          var code = A[i] + A[j];
          var name = en.of(code);
          if (name && name !== code && !has(name)) DICT[name] = loc.of(code);
        }
      }
    } catch (e) { /* Intl.DisplayNames unsupported */ }
  }

  function tr(text) {
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    var body = norm(m[2]);
    if (!body) return null;
    var out = null;
    if (has(body)) {
      out = DICT[body];
    } else {
      var e = EDGE.exec(body);
      if (e[2] && has(e[2])) out = arPunct(e[1]) + DICT[e[2]] + arPunct(e[3]);
    }
    if (out === null) {
      for (var i = 0; i < PATTERNS.length; i++) {
        var pm = PATTERNS[i][0].exec(body);
        if (pm && has(PATTERNS[i][1])) {
          out = DICT[PATTERNS[i][1]];
          for (var k = 0; k < PATTERNS[i][2].length; k++) out = out.replace('{' + PATTERNS[i][2][k] + '}', pm[k + 1]);
          break;
        }
      }
    }
    if (out === null && body.indexOf(' — ') > 0) {
      var changed = false;
      var parts = body.split(' — ').map(function (p) {
        var t = tr(p);
        if (t === null) return p;
        changed = true;
        return t;
      });
      if (changed) out = parts.join(' — ');
    }
    return out === null ? null : m[1] + out + m[3];
  }

  /* ---------- DOM translation ---------- */
  var SKIP_SELECTOR = 'script,style,noscript,textarea,code,pre,[data-no-i18n],[contenteditable="true"],.bl-body,.bl-article';
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  var textState = new WeakMap();
  var attrState = new WeakMap();

  function processText(node) {
    var st = textState.get(node);
    if (lang !== 'en') {
      if (st && node.data === st.ar) return;
      var en = node.data;
      if (!/[A-Za-z]/.test(en)) { textState.delete(node); return; }
      var parent = node.parentElement;
      if (!parent || parent.closest(SKIP_SELECTOR)) return;
      var ar = tr(en);
      if (ar === null) { textState.delete(node); return; }
      textState.set(node, { en: en, ar: ar });
      node.data = ar;
    } else {
      if (st && node.data === st.ar) node.data = st.en;
      textState.delete(node);
    }
  }

  function processAttr(el, name) {
    var states = attrState.get(el);
    var st = states && states[name];
    var value = el.getAttribute(name);
    if (value === null) return;
    if (lang !== 'en') {
      if (st && value === st.ar) return;
      if (!/[A-Za-z]/.test(value) || el.closest(SKIP_SELECTOR)) return;
      var ar = tr(value);
      if (ar === null) { if (st) delete states[name]; return; }
      if (!states) { states = {}; attrState.set(el, states); }
      states[name] = { en: value, ar: ar };
      el.setAttribute(name, ar);
    } else if (st) {
      if (value === st.ar) el.setAttribute(name, st.en);
      delete states[name];
    }
  }

  function processAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      if (el.hasAttribute(ATTRS[i])) processAttr(el, ATTRS[i]);
    }
  }

  function walk(rootNode) {
    if (!rootNode) return;
    if (rootNode.nodeType === 3) { processText(rootNode); return; }
    if (rootNode.nodeType === 1) {
      if (/^(SCRIPT|STYLE)$/.test(rootNode.nodeName)) return;
      processAttrs(rootNode);
    } else if (rootNode.nodeType !== 9 && rootNode.nodeType !== 11) {
      return;
    }
    var walker = document.createTreeWalker(rootNode, 5, {
      acceptNode: function (n) {
        return n.nodeType === 1 && /^(SCRIPT|STYLE)$/.test(n.nodeName) ? 2 : 1;
      }
    });
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) processText(n); else processAttrs(n);
    }
  }

  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var mu = mutations[i];
      if (mu.type === 'characterData') processText(mu.target);
      else if (mu.type === 'attributes') processAttr(mu.target, mu.attributeName);
      else for (var j = 0; j < mu.addedNodes.length; j++) walk(mu.addedNodes[j]);
    }
  });

  function observe() {
    observer.observe(document, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ATTRS
    });
  }

  function translatePage() {
    observer.disconnect();
    if (lang !== 'en') addCountryNames();
    walk(document);
    if (lang !== 'en') observe();
  }

  /* ---------- language selector ---------- */
  var buttons = [];
  var menu = null;

  function refreshButtons() {
    var info = langInfo(lang);
    buttons.forEach(function (b) {
      b.querySelector('.vi-label').textContent = info.name;
      b.setAttribute('aria-label', 'Language: ' + info.name);
    });
    if (menu) {
      menu.querySelectorAll('button').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-code') === lang);
      });
    }
  }

  function closeMenu() { if (menu) menu.hidden = true; }

  function buildMenu() {
    menu = document.createElement('div');
    menu.className = 'vynzo-lang-menu';
    menu.setAttribute('data-no-i18n', '');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    LANGS.forEach(function (l) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.setAttribute('data-code', l.code);
      b.setAttribute('lang', l.code);
      b.textContent = l.name;
      b.addEventListener('click', function () { closeMenu(); setLang(l.code); });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    document.addEventListener('click', function (e) {
      if (!menu.hidden && !e.target.closest('.vynzo-lang-btn, .vynzo-lang-menu')) closeMenu();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
    window.addEventListener('resize', closeMenu);
  }

  function openMenu(anchor) {
    if (!menu) buildMenu();
    refreshButtons();
    menu.hidden = false;
    var r = anchor.getBoundingClientRect();
    var h = menu.offsetHeight;
    var w = menu.offsetWidth;
    var top = r.top > window.innerHeight / 2 ? r.top - h - 6 : r.bottom + 6;
    top = Math.max(6, Math.min(top, window.innerHeight - h - 6));
    var left = Math.max(6, Math.min(r.left, window.innerWidth - w - 6));
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
  }

  function makeButton(kind) {
    var el = document.createElement('a');
    el.href = '#';
    el.setAttribute('role', 'button');
    el.setAttribute('aria-haspopup', 'menu');
    el.setAttribute('data-no-i18n', '');
    el.className = 'vynzo-lang-btn ' + kind;
    var icon = document.createElement('span');
    icon.className = kind === 'mob-item' ? 'mob-icon' : 'vi-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '🌐';
    var label = document.createElement('span');
    label.className = 'vi-label';
    el.appendChild(icon);
    el.appendChild(label);
    el.addEventListener('click', function (event) {
      event.preventDefault();
      if (menu && !menu.hidden) closeMenu(); else openMenu(el);
    });
    buttons.push(el);
    return el;
  }

  function mountButtons() {
    var placed = false;
    var welcomeNav = document.querySelector('.welcome-nav');
    if (welcomeNav) { welcomeNav.insertBefore(makeButton('vi-pill'), welcomeNav.firstChild); placed = true; }
    document.querySelectorAll('.sidebar nav').forEach(function (nav) {
      nav.appendChild(makeButton('nav-item')); placed = true;
    });
    document.querySelectorAll('.mobile-nav').forEach(function (nav) {
      nav.appendChild(makeButton('mob-item')); placed = true;
    });
    if (!placed) document.body.appendChild(makeButton('vi-pill vi-float'));
    refreshButtons();
  }

  function setLang(next) {
    if (!LANGS.some(function (l) { return l.code === next; })) return;
    if (next === lang) return;
    loadDict(next, function () {
      observer.disconnect();
      if (lang !== 'en') { lang = 'en'; walk(document); }
      lang = next;
      try { localStorage.setItem(KEY, lang); } catch (e) { /* ignore */ }
      applyRoot();
      translatePage();
      refreshButtons();
      window.dispatchEvent(new CustomEvent('vynzo-lang', { detail: lang }));
    });
  }

  window.VynzoI18n = {
    get: function () { return lang; },
    set: setLang,
    languages: LANGS,
    toggle: function () { setLang(lang === 'ar' ? 'en' : 'ar'); },
    tr: function (s) { var out = tr(String(s)); return out === null ? s : out; }
  };

  window.addEventListener('storage', function (e) {
    if (e.key !== KEY) return;
    var v = readLang();
    if (v !== lang) setLang(v);
  });

  /* ---------- styles ---------- */
  var style = document.createElement('style');
  style.textContent = [
    '.vynzo-lang-btn{cursor:pointer;text-decoration:none}',
    '.vynzo-lang-btn.nav-item{display:flex;align-items:center;gap:8px}',
    '.vynzo-lang-btn.vi-pill{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:999px;',
    'border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.08);color:inherit;font-size:13px;font-weight:600}',
    'html[data-theme="daylight"] .vynzo-lang-btn.vi-pill{border-color:rgba(0,0,0,.2);background:rgba(0,0,0,.05)}',
    '.vynzo-lang-btn.vi-float{position:fixed;top:10px;inset-inline-end:10px;z-index:2000;backdrop-filter:blur(6px)}',
    '.mobile-nav .vynzo-lang-btn .vi-label{font-size:inherit}',

    'html[dir="rtl"] body{font-family:"Segoe UI",Tahoma,"Noto Sans Arabic","Noto Naskh Arabic",Arial,sans-serif}',
    'html[dir="rtl"] .account-search,html[dir="rtl"] .account-search-link,html[dir="rtl"] .story-privacy-select,',
    'html[dir="rtl"] .insta-card .post-header .post-time,html[dir="rtl"] .home-page .reel-feed .insta-card .post-privacy-select,',
    'html[dir="rtl"] .post-delete-btn,html[dir="rtl"] .send-btn,html[dir="rtl"] .conversation-item>.unread-badge,',
    'html[dir="rtl"] .chat-call-actions{margin-left:0;margin-right:auto}',
    'html[dir="rtl"] #story-viewer-author{margin-right:0;margin-left:auto}',
    'html[dir="rtl"] .story-time,html[dir="rtl"] .post-time{margin-left:0;margin-right:8px}',
    'html[dir="rtl"] .sidebar{border-right:0;border-left:1px solid var(--border-color)}',
    'html[dir="rtl"] .conversations-sidebar{border-right:0;border-left:1px solid rgba(189,130,255,.2)}',
    'html[dir="rtl"] .live-chat-panel{border-right:0;border-left:1px solid rgba(171,120,255,.26)}',
    'html[dir="rtl"] .live-sidebar{border-left:0;border-right:1px solid var(--border-color)}',
    'html[dir="rtl"] .reply-quote,html[dir="rtl"] .reply-bar{border-left:0;border-right:3px solid #ffb84d}',
    'html[dir="rtl"] .home-friend-card,html[dir="rtl"] .live-host-chip,html[dir="rtl"] .live-viewer-row{text-align:right}',
    'html[dir="rtl"] .voice-time{text-align:left}',
    'html[dir="rtl"] .post-viewer-close,html[dir="rtl"] .account-profile-close{right:auto;left:12px}',
    'html[dir="rtl"] .account-profile-header{padding-right:0;padding-left:34px}',
    'html[dir="rtl"] .protected-badge{left:auto;right:8px}',
    'html[dir="rtl"] input[type="email"],html[dir="rtl"] input[type="tel"],html[dir="rtl"] input[type="password"],',
    'html[dir="rtl"] input[type="url"]{direction:ltr;text-align:right}',
    'html[lang="ur"] body{font-family:"Noto Nastaliq Urdu","Segoe UI",Tahoma,Arial,sans-serif;line-height:1.8}',
    '.vynzo-lang-menu{position:fixed;z-index:3000;min-width:150px;max-height:70vh;overflow:auto;padding:6px;border-radius:12px;',
    'background:#1b1530;border:1px solid rgba(255,255,255,.2);box-shadow:0 10px 30px rgba(0,0,0,.45)}',
    '.vynzo-lang-menu[hidden]{display:none}',
    '.vynzo-lang-menu button{display:block;width:100%;text-align:start;padding:9px 12px;border:0;border-radius:8px;',
    'background:transparent;color:#fff;font:inherit;font-size:14px;cursor:pointer}',
    '.vynzo-lang-menu button:hover{background:rgba(255,255,255,.12)}',
    '.vynzo-lang-menu button.active{background:rgba(189,130,255,.3);font-weight:700}',
    'html[data-theme="daylight"] .vynzo-lang-menu{background:#fff;border-color:rgba(0,0,0,.15)}',
    'html[data-theme="daylight"] .vynzo-lang-menu button{color:#111}'
  ].join('');
  (document.head || root).appendChild(style);

  /* ---------- start ---------- */
  function start() {
    mountButtons();
    if (lang === 'en') return;
    if (Object.keys(DICT).length) translatePage();
    else loadDict(lang, translatePage);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

(function () {
  var KEY = 'vynzo_theme_mode';
  var root = document.documentElement;

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      if (v === 'daylight' || v === 'dark') return v;
      // Migrate the legacy home-page toggle value.
      return localStorage.getItem('vynzo_theme') === 'light-theme' ? 'daylight' : 'dark';
    } catch (e) {
      return 'dark';
    }
  }

  function apply(mode) {
    root.setAttribute('data-theme', mode);
    root.style.colorScheme = mode === 'daylight' ? 'light' : 'dark';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'daylight' ? '#f6f2ff' : '#0f1015');
  }

  window.VynzoTheme = {
    get: read,
    set: function (mode) {
      mode = mode === 'daylight' ? 'daylight' : 'dark';
      try { localStorage.setItem(KEY, mode); } catch (e) {}
      apply(mode);
      window.dispatchEvent(new CustomEvent('vynzo-theme', { detail: mode }));
    },
    toggle: function () {
      this.set(read() === 'daylight' ? 'dark' : 'daylight');
    }
  };

  apply(read());
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) apply(read());
  });
})();

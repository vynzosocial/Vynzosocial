// Best-effort protection: blocks save/drag/context menu in the page and, in the
// Android app, blocks screenshots while protected media is visible.
let watching = false;

export function protectMedia(root) {
  if (!root) return;
  root.dataset.protected = 'true';
  root.classList.add('is-protected-media');
  root.addEventListener('contextmenu', e => e.preventDefault());
  root.addEventListener('dragstart', e => e.preventDefault());
  root.querySelectorAll('img, video').forEach(el => {
    el.draggable = false;
    if (el.tagName === 'VIDEO') {
      el.setAttribute('controlslist', 'nodownload noplaybackrate');
      el.disablePictureInPicture = true;
    }
  });
  startWatching();
}

function startWatching() {
  if (watching) return;
  watching = true;
  let secure = null;
  const update = () => {
    const visible = [...document.querySelectorAll('[data-protected="true"]')].some(el => {
      if (!el.isConnected) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
    });
    if (visible !== secure) {
      secure = visible;
      window.Capacitor?.Plugins?.ScreenGuard?.setSecure({ enabled: visible }).catch(() => {});
    }
  };
  setInterval(update, 500);
}

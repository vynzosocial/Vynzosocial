import { initAndroidUpdate } from './android-update.mjs';

const WEB_CHECK_MS = 60_000;
const APP_CHECK_MS = 30 * 60_000;
const APP_STATUS_MS = 5_000;
export function createUpdateController({ view, nativePlugin, webVersion, fetchVersion, reload, androidBinaryUpdate = false, openAndroidDownload, now = () => Date.now() }) {
  let lastAppCheck = 0;
  let checking = false;
  let available = false;

  async function check() {
    if (checking) return;
    checking = true;
    try {
      if (androidBinaryUpdate) {
        available = true;
        view.setAvailable(true, 'android');
        return;
      }
      if (nativePlugin) {
        let info = await nativePlugin.getInfo();
        if (now() - lastAppCheck >= APP_CHECK_MS) {
          lastAppCheck = now();
          const checked = await nativePlugin.checkNow();
          if (checked.status !== 'busy') info = checked;
          if (checked.status === 'error' || checked.status === 'rejected') {
            console.error('Android update check failed:', checked.status);
          }
        }
        available = Number(info.stagedVersion) > Number(info.version);
      } else {
        if (!webVersion || webVersion === 'development') return;
        const latest = await fetchVersion();
        if (typeof latest !== 'string' || !latest) throw new Error('Invalid web update version.');
        available = latest !== webVersion;
      }
      view.setAvailable(available);
    } catch (error) {
      console.error('Could not check for updates:', error);
    } finally {
      checking = false;
    }
  }

  async function apply() {
    if (!available) return;
    view.setBusy(true);
    try {
      if (androidBinaryUpdate) {
        openAndroidDownload();
      } else if (!nativePlugin) {
        reload();
      } else if (typeof nativePlugin.applyUpdate === 'function') {
        await nativePlugin.applyUpdate();
        available = false;
        view.setAvailable(false);
      } else {
        view.setStatus('Close and reopen the app to finish the update.');
      }
    } catch (error) {
      if (nativePlugin && error?.code === 'UNIMPLEMENTED') {
        view.setStatus('Close and reopen the app to finish the update.');
        return;
      }
      console.error('Could not apply update:', error);
      view.setStatus('Could not apply the update. Please try again.');
    } finally {
      view.setBusy(false);
    }
  }
  return { check, apply };
}

function init() {
  const container = document.getElementById('home-update');
  const button = document.getElementById('home-update-button');
  const status = document.getElementById('home-update-status');
  if (!container || !button || !status) return;
  const capacitor = window.Capacitor;
  const native = Boolean(capacitor?.isNativePlatform?.());
  if (!native) return;
  const plugin = capacitor.Plugins?.Ota;
  if (!plugin) {
    console.error('Android update plugin is unavailable.');
    return;
  }
  initAndroidUpdate(capacitor, plugin);
  const translate = text => window.VynzoI18n?.tr(text) || text;
  const controller = createUpdateController({
    nativePlugin: plugin,
    androidBinaryUpdate: false,
    openAndroidDownload: () => {},
    webVersion: document.querySelector('meta[name="vynzo-web-version"]')?.content,
    async fetchVersion() {
      const response = await fetch(new URL('../web-version.json', import.meta.url), { cache: 'no-store' });
      if (!response.ok) throw new Error(`Update check failed (HTTP ${response.status}).`);
      return (await response.json()).version;
    },
    reload: () => window.location.reload(),
    view: {
      setAvailable(value, kind) {
        container.hidden = !value;
        button.textContent = translate(kind === 'android' ? 'Download Android update' : 'Update available');
        if (!value) status.textContent = '';
      },
      setBusy(value) { button.disabled = value; },
      setStatus(value) { status.textContent = translate(value); }
    }
  });
  button.addEventListener('click', controller.apply);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void controller.check(); });
  void controller.check();
  window.setInterval(controller.check, native ? APP_STATUS_MS : WEB_CHECK_MS);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}

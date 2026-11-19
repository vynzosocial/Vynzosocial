export function validateAndroidRelease(release) {
  if (!release || typeof release.version !== 'string' || !/^\d+\.\d+$/.test(release.version)
    || !Number.isSafeInteger(release.build) || release.build < 1
    || release.url !== `https://vynzo-app-download.vynzolive.workers.dev/vynzo-android-${release.version}.apk`
    || typeof release.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(release.sha256)) {
    throw new Error('Invalid Android release information.');
  }
  return release;
}

export function createAndroidUpdateController({ ota, installer, loadRelease, view, openDownload }) {
  let release;
  let busy = false;
  let checking = false;
  let prompted = false;

  async function check() {
    if (checking) return;
    checking = true;
    try {
      const latest = validateAndroidRelease(await loadRelease());
      let installed;
      try {
        installed = (await ota.getInfo()).appBuild;
      } catch (error) {
        if (error?.code !== 'UNIMPLEMENTED') throw error;
      }
      if (installed !== undefined && (!Number.isSafeInteger(installed) || installed < 1)) {
        throw new Error('Could not read the installed Android version.');
      }
      if (installed !== undefined && installed >= latest.build) {
        release = undefined;
        view.setAvailable(false);
        return;
      }
      release = latest;
      view.setAvailable(true);
      if (!prompted) {
        prompted = true;
        view.prompt(latest.version, !installer);
      }
    } catch (error) {
      console.error('Could not check the Android app update:', error);
      view.error('Could not check for Android app updates. Please try again later.');
    } finally {
      checking = false;
    }
  }

  async function install() {
    if (!release || busy) return;
    busy = true;
    view.setBusy(true);
    try {
      if (installer) {
        view.status('Downloading update...');
        await installer.install(release);
        view.status('Review and approve the installation in Android.');
      } else {
        openDownload(release.url);
        view.status('Open the downloaded APK to install it. Future versions can update inside the app.');
      }
    } catch (error) {
      console.error('Could not install Android app update:', error);
      view.status(error?.message || 'Could not install the update. Please try again.');
    } finally {
      busy = false;
      view.setBusy(false);
    }
  }

  return { check, install };
}

export function initAndroidUpdate(capacitor, ota) {
  if (capacitor.getPlatform?.() !== 'android') return;
  const container = document.getElementById('android-update');
  const button = document.getElementById('android-update-button');
  const dialog = document.getElementById('android-update-dialog');
  const description = document.getElementById('android-update-description');
  const status = document.getElementById('android-update-dialog-status');
  const checkStatus = document.getElementById('android-update-status');
  const later = document.getElementById('android-update-later');
  const confirm = document.getElementById('android-update-confirm');
  if (!container || !button || !dialog || !description || !status || !checkStatus || !later || !confirm) return;
  const translate = text => window.VynzoI18n?.tr(text) || text;
  const installer = capacitor.isPluginAvailable?.('AppUpdate') ? capacitor.Plugins.AppUpdate : null;
  let checkFailed = false;
  const view = {
    setAvailable(value) {
      checkFailed = false;
      container.hidden = !value;
      button.textContent = translate('Android app update available');
      checkStatus.textContent = '';
    },
    prompt(version, manual) {
      description.textContent = translate(`Version ${version} is available.`)
        + (manual ? ' ' + translate('This version needs a one-time manual installation.') : '');
      status.textContent = '';
      if (!dialog.open) dialog.showModal();
    },
    setBusy(value) { confirm.disabled = value; later.disabled = value; },
    status(message) { status.textContent = translate(message); },
    error(message) {
      checkFailed = true;
      container.hidden = false;
      button.textContent = translate('Retry Android update check');
      checkStatus.textContent = translate(message);
    }
  };
  const controller = createAndroidUpdateController({
    ota, installer, view,
    async loadRelease() {
      const response = await fetch(new URL('../android-release.json', import.meta.url));
      if (!response.ok) throw new Error(`Android release check failed (HTTP ${response.status}).`);
      return response.json();
    },
    openDownload(url) { window.location.href = url; }
  });
  if (installer) {
    Promise.resolve(installer.addListener('progress', ({ percent }) => {
      if (Number.isFinite(percent)) view.status(`Downloading update: ${percent}%`);
    })).catch(error => console.error('Could not listen for Android update progress:', error));
  }
  button.addEventListener('click', () => {
    if (checkFailed) {
      checkStatus.textContent = '';
      void controller.check();
    } else if (!dialog.open) dialog.showModal();
  });
  later.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (confirm.disabled) event.preventDefault(); });
  confirm.addEventListener('click', controller.install);
  void controller.check();
}

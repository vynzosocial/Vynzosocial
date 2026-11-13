function createUpdates({ updater, enabled, notify, confirmRestart, log, onChange }) {
  let state = enabled ? 'idle' : 'disabled';
  let detail = enabled ? 'Updates have not been checked yet.' : 'Desktop update hosting is not configured for this build. Website changes still appear when the app loads.';
  let progress = null;
  let restartPromptOpen = false;

  function setState(next, message, percent = null) {
    state = next;
    detail = message;
    progress = percent;
    onChange();
  }

  function fail(error) {
    log('Desktop update failed', error);
    setState('error', `Could not update VynzoSocial: ${error.message}`);
  }

  async function install() {
    if (state !== 'downloaded' || restartPromptOpen) return;
    restartPromptOpen = true;
    try {
      if (await confirmRestart()) {
        setState('installing', 'Installing the desktop update. VynzoSocial will restart.');
        updater.quitAndInstall(false, true);
      }
    } catch (error) {
      log('Could not restart to install the desktop update', error);
      setState('downloaded', `The update is still ready. Could not restart to install: ${error.message}`);
      notify('Could not install update', error.message);
    } finally {
      restartPromptOpen = false;
    }
  }

  if (enabled) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.disableWebInstaller = true;
    updater.allowPrerelease = false;
    updater.on('checking-for-update', () => setState('checking', 'Checking for desktop updates...'));
    updater.on('update-available', info => setState('downloading', `Downloading VynzoSocial ${info.version}...`));
    updater.on('download-progress', progress => {
      const percent = Math.max(0, Math.min(100, Math.floor(progress.percent)));
      setState('downloading', `Downloading desktop update: ${percent}%`, percent);
    });
    updater.on('update-not-available', () => setState('current', 'You have the latest desktop version.'));
    updater.on('error', fail);
    updater.on('update-downloaded', info => {
      if (state === 'installing') return;
      setState('downloaded', `VynzoSocial ${info.version} is ready. Restart to install; finish any call or unsaved work first.`);
      void install();
    });
  }

  async function check(manual = false) {
    if (!enabled || ['checking', 'downloading', 'installing'].includes(state)) {
      if (manual) notify('Desktop updates', detail);
      return;
    }
    if (state === 'downloaded') {
      if (manual) await install();
      return;
    }
    setState('checking', 'Checking for desktop updates...');
    try {
      const result = await updater.checkForUpdates();
      await result?.downloadPromise;
      if (manual && ['current', 'error'].includes(state)) notify('Desktop updates', detail);
    } catch (error) {
      if (state !== 'error') fail(error);
      if (manual) notify('Desktop updates', detail);
    }
  }

  return { check, install, status: () => ({ state, detail, progress }) };
}

module.exports = { createUpdates };

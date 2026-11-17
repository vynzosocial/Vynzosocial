export async function getApplicationInfo({ userAgent, capacitor, webVersion }) {
  const desktop = userAgent.match(/\bVynzoSocialDesktop\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/);
  if (desktop) return { platform: 'Windows desktop', version: desktop[1] };
  if (capacitor?.isNativePlatform?.()) {
    const plugin = capacitor.Plugins?.Ota;
    if (!plugin) throw new Error('Application version is unavailable. Update the installed app.');
    const info = await plugin.getInfo();
    if (typeof info.appVersion !== 'string' || !info.appVersion.trim()
      || !Number.isSafeInteger(info.appBuild) || info.appBuild < 1) {
      throw new Error('Application version is unavailable. Update the installed app.');
    }
    return {
      platform: 'Android',
      version: info.appVersion,
      build: info.appBuild,
      webUpdate: info.version > 0 ? String(info.version) : 'Bundled'
    };
  }
  if (/\bElectron\//.test(userAgent)) {
    throw new Error('Desktop version is unavailable. Update the installed desktop app.');
  }
  return { platform: 'Web app', version: webVersion === 'development' || !webVersion ? 'Development' : webVersion };
}

export async function showApplicationInfo({ document, navigator, window }) {
  const version = document.getElementById('application-version');
  const details = document.getElementById('application-build');
  if (!version || !details) return;
  try {
    const info = await getApplicationInfo({
      userAgent: navigator.userAgent,
      capacitor: window.Capacitor,
      webVersion: document.querySelector('meta[name="vynzo-web-version"]')?.content
    });
    const mobileApp = info.platform === 'Android';
    const description = document.getElementById('application-description');
    if (description) description.hidden = mobileApp;
    const translate = text => window.VynzoI18n?.tr(text) || text;
    version.textContent = mobileApp ? info.version : `${translate(info.platform)}: ${info.version}`;
    details.hidden = mobileApp;
    details.textContent = !mobileApp && info.build
      ? `${translate('Build')}: ${info.build} | ${translate('Web update')}: ${info.webUpdate}`
      : '';
  } catch (error) {
    console.error('Could not read application version:', error);
    version.textContent = error.message || 'Could not read the installed application version.';
    version.classList.add('error');
  }
}

if (typeof document !== 'undefined') {
  void showApplicationInfo({ document, navigator, window });
}

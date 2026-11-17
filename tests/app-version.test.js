const assert = require('node:assert/strict');
const test = require('node:test');

const load = () => import('../frontend/js/app-version.mjs');

test('desktop version comes from the running installer, not the website build', async () => {
  const { getApplicationInfo } = await load();
  const info = await getApplicationInfo({
    userAgent: 'Chrome/134 Electron/45.3.1 VynzoSocialDesktop/1.2.3',
    webVersion: 'newer-website-build'
  });
  assert.deepEqual(info, { platform: 'Windows desktop', version: '1.2.3' });
});

test('Android separates installed APK version and build from its active web update', async () => {
  const { getApplicationInfo } = await load();
  const info = await getApplicationInfo({
    userAgent: 'Android Chrome/134',
    capacitor: {
      isNativePlatform: () => true,
      Plugins: { Ota: { getInfo: async () => ({ appVersion: '1.6', appBuild: 7, version: 1794569880345 }) } }
    }
  });
  assert.deepEqual(info, { platform: 'Android', version: '1.6', build: 7, webUpdate: '1794569880345' });
});

test('older native bridges and desktop installers do not claim the website version is installed', async () => {
  const { getApplicationInfo } = await load();
  await assert.rejects(getApplicationInfo({
    userAgent: 'Android',
    capacitor: { isNativePlatform: () => true, Plugins: { Ota: { getInfo: async () => ({ version: 123 }) } } },
    webVersion: 'latest'
  }), /Update the installed app/);
  await assert.rejects(getApplicationInfo({
    userAgent: 'Electron/45.3.1',
    webVersion: 'latest'
  }), /Update the installed desktop app/);
});

test('a bundled Android app and a mobile browser report their actual running builds', async () => {
  const { getApplicationInfo } = await load();
  const bundled = await getApplicationInfo({
    userAgent: 'Android',
    capacitor: {
      isNativePlatform: () => true,
      Plugins: { Ota: { getInfo: async () => ({ appVersion: '1.7', appBuild: 8, version: 0 }) } }
    }
  });
  assert.equal(bundled.webUpdate, 'Bundled');
  assert.deepEqual(await getApplicationInfo({ userAgent: 'Android Chrome/134', webVersion: 'loaded-web-build' }),
    { platform: 'Web app', version: 'loaded-web-build' });
});

test('Settings renders native version details without waiting for profile or network requests', async () => {
  const { showApplicationInfo } = await load();
  const version = {};
  const details = {};
  await showApplicationInfo({
    document: {
      getElementById: id => id === 'application-version' ? version : details,
      querySelector: () => ({ content: 'web-build' })
    },
    navigator: { userAgent: 'VynzoSocialDesktop/1.2.3' },
    window: {}
  });
  assert.equal(version.textContent, 'Windows desktop: 1.2.3');
  assert.equal(details.textContent, '');
});

test('Android Settings shows only the installed version number, with or without a web update', async () => {
  const { showApplicationInfo } = await load();
  for (const webUpdate of [0, 1794586452243]) {
    const elements = {
      'application-version': {},
      'application-build': { textContent: 'Previous build details' },
      'application-description': {}
    };
    await showApplicationInfo({
      document: {
        getElementById: id => elements[id],
        querySelector: () => ({ content: 'website-build' })
      },
      navigator: { userAgent: 'Android Chrome/134' },
      window: { Capacitor: {
        isNativePlatform: () => true,
        Plugins: { Ota: { getInfo: async () => ({ appVersion: '1.7', appBuild: 8, version: webUpdate }) } }
      } }
    });
    assert.equal(elements['application-version'].textContent, '1.7');
    assert.equal(elements['application-build'].textContent, '');
    assert.equal(elements['application-build'].hidden, true);
    assert.equal(elements['application-description'].hidden, true);
  }
});

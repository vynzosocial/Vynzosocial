const test = require('node:test');
const assert = require('node:assert/strict');

const release = {
  version: '1.9',
  build: 10,
  url: 'https://vynzo-app-download.vynzolive.workers.dev/vynzo-android-1.9.apk',
  sha256: 'a'.repeat(64)
};

async function setup({ installed = 9, installer, loadRelease = async () => release } = {}) {
  const { createAndroidUpdateController } = await import('../frontend/js/android-update.mjs');
  const state = { prompts: 0, downloads: [] };
  const view = {
    setAvailable(value) { state.available = value; },
    prompt(version, manual) { state.prompts++; state.version = version; state.manual = manual; },
    setBusy(value) { state.busy = value; },
    status(message) { state.status = message; },
    error(message) { state.error = message; }
  };
  const controller = createAndroidUpdateController({
    ota: { getInfo: async () => ({ appBuild: installed }) },
    installer, loadRelease, view,
    openDownload(url) { state.downloads.push(url); }
  });
  return { controller, state };
}

test('only newer Android versions prompt, and declining does not start a download', async () => {
  const calls = [];
  const { controller, state } = await setup({ installer: { install: async value => calls.push(value) } });
  await controller.check();
  await controller.check();
  assert.equal(state.available, true);
  assert.equal(state.prompts, 1);
  assert.deepEqual(calls, []);
  await controller.install();
  assert.deepEqual(calls, [release]);
  assert.match(state.status, /approve/);
  const current = await setup({ installed: 10 });
  await current.controller.check();
  assert.equal(current.state.available, false);
  assert.equal(current.state.prompts, 0);
});

test('older apps offer a direct manual download and native installation failures can be retried', async () => {
  const old = await setup();
  await old.controller.check();
  assert.equal(old.state.manual, true);
  await old.controller.install();
  assert.deepEqual(old.state.downloads, [release.url]);
  assert.match(old.state.status, /one|Open/);

  let attempts = 0;
  const current = await setup({ installer: {
    async install() { if (++attempts === 1) throw new Error('Allow installs in Android settings'); }
  } });
  await current.controller.check();
  await current.controller.install();
  assert.match(current.state.status, /Allow installs/);
  assert.equal(current.state.busy, false);
  await current.controller.install();
  assert.equal(attempts, 2);
  assert.match(current.state.status, /approve/);
});

test('rejects invalid release metadata rather than offering an untrusted installer', async () => {
  for (const invalid of [
    { ...release, url: 'https://example.com/vynzo-android-1.9.apk' },
    { ...release, url: release.url.replace('1.9', '1.8') },
    { ...release, sha256: 'bad' },
    { ...release, build: 0 }
  ]) {
    const { controller, state } = await setup({ loadRelease: async () => invalid });
    await controller.check();
    assert.equal(state.prompts, 0);
    assert.match(state.error, /Could not check/);
  }
});

test('initializes with Capacitor listeners that return a synchronous handle', async () => {
  const { initAndroidUpdate } = await import('../frontend/js/android-update.mjs');
  const originals = { document: global.document, window: global.window, fetch: global.fetch };
  const elements = new Map();
  for (const id of ['android-update', 'android-update-button', 'android-update-dialog',
    'android-update-description', 'android-update-dialog-status', 'android-update-status',
    'android-update-later', 'android-update-confirm']) {
    elements.set(id, {
      hidden: true, open: false, textContent: '', disabled: false,
      addEventListener() {}, showModal() { this.open = true; }, close() { this.open = false; }
    });
  }
  try {
    global.document = { getElementById: id => elements.get(id) };
    global.window = {};
    global.fetch = async () => ({ ok: true, json: async () => release });
    const installer = { addListener() { return { remove() {} }; } };
    initAndroidUpdate({
      getPlatform: () => 'android', isPluginAvailable: () => true, Plugins: { AppUpdate: installer }
    }, { getInfo: async () => ({ appBuild: 9 }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(elements.get('android-update-dialog').open, true);
    assert.equal(elements.get('android-update').hidden, false);
  } finally {
    global.document = originals.document;
    global.window = originals.window;
    global.fetch = originals.fetch;
  }
});

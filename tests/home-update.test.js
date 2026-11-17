const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const writeWebBuildVersion = require('../scripts/web-build-version');

async function controller(overrides = {}) {
  const { createUpdateController } = await import('../frontend/js/home-update.mjs');
  const state = {};
  const options = {
    view: {
      setAvailable(value) { state.available = value; },
      setBusy(value) { state.busy = value; },
      setStatus(value) { state.status = value; }
    },
    webVersion: 'old',
    fetchVersion: async () => 'new',
    reload() { state.reloaded = true; },
    ...overrides
  };
  return { instance: createUpdateController(options), state };
}

test('web detects a new build, reloads on update, and hides for the current build', async () => {
  let version = 'new';
  const { instance, state } = await controller({ fetchVersion: async () => version });
  await instance.check();
  assert.equal(state.available, true);
  await instance.apply();
  assert.equal(state.reloaded, true);
  version = 'old';
  await instance.check();
  assert.equal(state.available, false);
});

test('Android shows only staged updates and invokes the native apply operation', async () => {
  let stagedVersion = 2;
  let applied = 0;
  const plugin = {
    async getInfo() { return { version: 1, stagedVersion }; },
    async checkNow() { return { status: 'busy' }; },
    async applyUpdate() { applied++; }
  };
  const { instance, state } = await controller({ nativePlugin: plugin, now: () => 10_000_000 });
  await instance.check();
  assert.equal(state.available, true);
  await instance.apply();
  assert.equal(applied, 1);
  stagedVersion = 1;
  await instance.check();
  assert.equal(state.available, false);
});

test('older Android versions instruct the user to reopen instead of hiding the update', async () => {
  const plugin = {
    async getInfo() { return { version: 1, stagedVersion: 2 }; },
    async checkNow() { return { status: 'busy' }; },
    async applyUpdate() { throw Object.assign(new Error('Unavailable'), { code: 'UNIMPLEMENTED' }); }
  };
  const { instance, state } = await controller({ nativePlugin: plugin, now: () => 10_000_000 });
  await instance.check();
  await instance.apply();
  assert.equal(state.available, true);
  assert.match(state.status, /Close and reopen/);
});

test('older Android binaries offer the APK even if no web update is staged', async () => {
  let downloaded = false;
  const { instance, state } = await controller({
    nativePlugin: { async getInfo() { throw new Error('Should not check OTA'); } },
    androidBinaryUpdate: true,
    openAndroidDownload() { downloaded = true; }
  });
  await instance.check();
  assert.equal(state.available, true);
  await instance.apply();
  assert.equal(downloaded, true);
});

test('failed update checks retain the current visible state', async () => {
  let fail = false;
  const { instance, state } = await controller({
    fetchVersion: async () => { if (fail) throw new Error('offline'); return 'new'; }
  });
  await instance.check();
  fail = true;
  await instance.check();
  assert.equal(state.available, true);
});

test('web build embeds the same unique version in Home, Settings and the version endpoint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vynzo-web-version-'));
  try {
    const home = path.join(dir, 'index.html');
    fs.mkdirSync(path.join(dir, 'pages'));
    const settings = path.join(dir, 'pages', 'settings.html');
    const marker = '<meta name="vynzo-web-version" content="development">';
    fs.writeFileSync(home, marker);
    fs.writeFileSync(settings, marker);
    writeWebBuildVersion(dir);
    const first = JSON.parse(fs.readFileSync(path.join(dir, 'web-version.json')));
    assert.match(fs.readFileSync(home, 'utf8'), new RegExp(first.version));
    assert.match(fs.readFileSync(settings, 'utf8'), new RegExp(first.version));
    fs.writeFileSync(home, marker);
    fs.writeFileSync(settings, marker);
    writeWebBuildVersion(dir);
    const second = JSON.parse(fs.readFileSync(path.join(dir, 'web-version.json')));
    assert.notEqual(first.version, second.version);
    assert.match(fs.readFileSync(settings, 'utf8'), new RegExp(second.version));
    fs.writeFileSync(home, 'no marker');
    assert.throws(() => writeWebBuildVersion(dir), /marker is missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

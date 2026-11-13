const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdates } = require('../lib/updates.cjs');

function setup({ enabled = true, consent = false, check } = {}) {
  const updater = new EventEmitter();
  const notices = [];
  const errors = [];
  let installs = 0;
  let checks = 0;
  let prompts = 0;
  updater.checkForUpdates = async () => {
    checks++;
    if (check) return check(updater);
    updater.emit('update-not-available');
  };
  updater.quitAndInstall = (silent, runAfter) => {
    assert.equal(silent, false);
    assert.equal(runAfter, true);
    installs++;
  };
  const updates = createUpdates({
    updater, enabled,
    notify: (...args) => notices.push(args),
    confirmRestart: async () => { prompts++; return consent; },
    log: (...args) => errors.push(args),
    onChange() {}
  });
  return { updater, updates, notices, errors, installs: () => installs, checks: () => checks, prompts: () => prompts };
}

test('unconfigured hosting does not contact an update server and explains the limitation', async () => {
  const instance = setup({ enabled: false });
  await instance.updates.check();
  assert.equal(instance.checks(), 0);
  await instance.updates.check(true);
  assert.equal(instance.notices.length, 1);
  assert.match(instance.notices[0][1], /not configured/);
});

test('downloads automatically but never installs on normal app quit', async () => {
  const instance = setup();
  assert.equal(instance.updater.autoDownload, true);
  assert.equal(instance.updater.autoInstallOnAppQuit, false);
  await instance.updates.check();
  assert.equal(instance.updates.status().state, 'current');
});

test('Later leaves the update staged and manual check offers restart again', async () => {
  const instance = setup();
  instance.updater.emit('update-downloaded', { version: '1.1.0' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instance.installs(), 0);
  assert.equal(instance.updates.status().state, 'downloaded');
  await instance.updates.check(true);
  assert.equal(instance.prompts(), 2);
  assert.equal(instance.checks(), 0);
});

test('installs only after explicit restart consent', async () => {
  const instance = setup({ consent: true });
  instance.updater.emit('update-downloaded', { version: '1.1.0' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instance.installs(), 1);
  assert.equal(instance.updates.status().state, 'installing');
  await instance.updates.check(true);
  assert.equal(instance.checks(), 0);
  assert.equal(instance.installs(), 1);
});

test('repeated update clicks cannot open multiple restart permission prompts', async () => {
  let answer;
  const instance = setup({ consent: new Promise(resolve => { answer = resolve; }) });
  instance.updater.emit('update-downloaded', { version: '1.2.0' });
  await instance.updates.check(true);
  await instance.updates.install();
  assert.equal(instance.prompts(), 1);
  assert.equal(instance.installs(), 0);
  answer(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instance.updates.status().state, 'downloaded');
});

test('download progress is visible and duplicate checks do not start another download', async () => {
  const instance = setup();
  instance.updater.emit('download-progress', { percent: 43.8 });
  assert.match(instance.updates.status().detail, /43%/);
  assert.equal(instance.updates.status().progress, 43);
  await instance.updates.check();
  assert.equal(instance.checks(), 0);
});

test('a failed installation keeps the downloaded update available to retry', async () => {
  const instance = setup({ consent: true });
  instance.updater.quitAndInstall = () => { throw new Error('installer unavailable'); };
  instance.updater.emit('update-downloaded', { version: '1.2.0' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instance.updates.status().state, 'downloaded');
  assert.match(instance.updates.status().detail, /installer unavailable/);
  assert.equal(instance.errors.length, 1);
  assert.equal(instance.notices.length, 1);
});

test('update failures are logged and exposed rather than reported as current', async () => {
  const instance = setup({ check: async updater => {
    const error = new Error('network unavailable');
    updater.emit('error', error);
    throw error;
  } });
  await instance.updates.check(true);
  assert.equal(instance.updates.status().state, 'error');
  assert.equal(instance.errors.length, 1);
  assert.match(instance.notices[0][1], /network unavailable/);
});

test('asynchronous download failures are handled instead of becoming unhandled rejections', async () => {
  const instance = setup({ check: async updater => {
    updater.emit('update-available', { version: '1.2.1' });
    return { downloadPromise: Promise.reject(new Error('download interrupted')) };
  } });
  await instance.updates.check(true);
  assert.equal(instance.updates.status().state, 'error');
  assert.equal(instance.errors.length, 1);
  assert.match(instance.notices[0][1], /download interrupted/);
});

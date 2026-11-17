const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/calls.js'), 'utf8')
  .replace(/^\uFEFF?import .*;\r?\n/gm, '')
  .replaceAll('import.meta.url', "'https://www.vynzosocial.com/js/calls.js'")
  .replace(/^export /gm, '');
const cameraSource = fs.readFileSync(path.join(__dirname, '../frontend/js/camera-devices.js'), 'utf8').replace(/^export /gm, '');

function setup(getSession) {
  const handlers = new Map();
  const toasts = [];
  const errors = [];
  let connections = 0;
  let groups = 0;
  let synchronized;
  const context = {
    localStorage: { getItem: () => null },
    supabase: { auth: { getSession } },
    syncLegacySession(session) { synchronized = session; },
    createAudioDevices: () => ({}),
    createRealtimeSocket() {
      connections++;
      return { on(name, callback) { handlers.set(name, callback); } };
    },
    createGroupCallUI() { groups++; return {}; },
    toasts,
    console: { error(...args) { errors.push(args); } }
  };
  vm.runInNewContext(`${cameraSource}\n${source}
    ensureStyles = () => {};
    showToast = message => toasts.push(message);
    this.initCalls = initCalls;`, context);
  return {
    init: () => context.initCalls(), handlers, toasts, errors,
    connections: () => connections, groups: () => groups,
    synchronized: () => synchronized
  };
}

test('calls restore the authenticated session even without a cached legacy token', async () => {
  const session = { access_token: 'test-token', user: { id: 'viewer' } };
  const calls = setup(async () => ({ data: { session }, error: null }));
  await calls.init();
  assert.equal(calls.synchronized(), session);
  assert.equal(calls.connections(), 1);
  assert.equal(calls.groups(), 1);
  assert.equal(typeof calls.handlers.get('call_incoming'), 'function');
  await calls.init();
  assert.equal(calls.connections(), 1);
});

test('simultaneous page and notification initialization share one session restoration', async () => {
  let complete;
  let reads = 0;
  const calls = setup(() => {
    reads++;
    return new Promise(resolve => { complete = resolve; });
  });
  const first = calls.init();
  const second = calls.init();
  assert.equal(reads, 1);
  assert.equal(calls.connections(), 0);
  complete({ data: { session: { user: { id: 'viewer' } } }, error: null });
  await Promise.all([first, second]);
  assert.equal(calls.connections(), 1);
  assert.equal(calls.groups(), 1);
});

test('session errors are visible and do not permanently disable call initialization', async () => {
  let fails = true;
  const calls = setup(async () => fails
    ? { data: { session: null }, error: new Error('Session restoration failed') }
    : { data: { session: { user: { id: 'viewer' } } }, error: null });
  await calls.init();
  assert.equal(calls.connections(), 0);
  assert.equal(calls.toasts[0], 'Session restoration failed');
  assert.equal(calls.errors.length, 1);
  fails = false;
  await calls.init();
  assert.equal(calls.connections(), 1);
});

test('signed-out pages do not start calls and can initialize after sign-in', async () => {
  let session = null;
  const calls = setup(async () => ({ data: { session }, error: null }));
  await calls.init();
  assert.equal(calls.connections(), 0);
  assert.deepEqual(calls.toasts, []);
  session = { user: { id: 'viewer' } };
  await calls.init();
  assert.equal(calls.connections(), 1);
});

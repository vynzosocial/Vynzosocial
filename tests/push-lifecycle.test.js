const test = require('node:test');
const assert = require('node:assert/strict');

async function setup() {
  const { createPushLifecycle } = await import('../frontend/js/push-lifecycle.mjs');
  const operations = [];
  const listeners = {};
  const plugin = {
    async setOwner({ userId }) { operations.push(['owner', userId]); },
    async getRegistration() { return { enabled: true, deviceId: 'device', deviceSecret: 'secret', installationId: 'installation' }; },
    async register() { operations.push(['register']); },
    async addListener(name, callback) { listeners[name] = callback; }
  };
  const lifecycle = createPushLifecycle({
    plugin,
    async request(method, token) { operations.push([method, token]); },
    onOpen() {},
    reportError(error) { operations.push(['error', error.message]); }
  });
  await lifecycle.start();
  return { lifecycle, operations, listeners };
}

test('registers the authenticated installation before enabling native display', async () => {
  const { lifecycle, operations } = await setup();
  await lifecycle.setSession({ user: { id: 'alice' }, access_token: 'alice-token' });
  assert.deepEqual(operations, [['owner', null], ['POST', 'alice-token'], ['owner', 'alice']]);
});

test('sign out disables native notifications before removing the server registration', async () => {
  const { lifecycle, operations } = await setup();
  const session = { user: { id: 'alice' }, access_token: 'alice-token' };
  await lifecycle.setSession(session);
  operations.length = 0;
  await lifecycle.unregister(session);
  assert.deepEqual(operations, [['owner', null], ['DELETE', 'alice-token']]);
});

test('account switch cancels obsolete queued registration', async () => {
  const { lifecycle, operations } = await setup();
  const alice = lifecycle.setSession({ user: { id: 'alice' }, access_token: 'alice-token' });
  const bob = lifecycle.setSession({ user: { id: 'bob' }, access_token: 'bob-token' });
  await Promise.all([alice, bob]);
  assert.deepEqual(operations, [['owner', null], ['POST', 'bob-token'], ['owner', 'bob']]);
});

test('a sign out that races with registration cannot reactivate notifications', async () => {
  const { createPushLifecycle } = await import('../frontend/js/push-lifecycle.mjs');
  const operations = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let started;
  const posting = new Promise(resolve => { started = resolve; });
  const lifecycle = createPushLifecycle({
    plugin: {
      async setOwner({ userId }) { operations.push(['owner', userId]); },
      async getRegistration() { return { enabled: true, deviceId: 'device', deviceSecret: 'secret', installationId: 'installation' }; }
    },
    async request(method) {
      operations.push([method]);
      if (method === 'POST') { started(); await pending; }
    },
    onOpen() {},
    reportError() {}
  });
  const session = { user: { id: 'alice' }, access_token: 'token' };
  const register = lifecycle.setSession(session);
  await posting;
  const logout = lifecycle.unregister(session);
  release();
  await Promise.all([register, logout]);
  assert.deepEqual(operations, [['owner', null], ['POST'], ['owner', null], ['DELETE']]);
});

test('failed server cleanup leaves native notifications disabled and reports the failure', async () => {
  const { createPushLifecycle } = await import('../frontend/js/push-lifecycle.mjs');
  const operations = [];
  const lifecycle = createPushLifecycle({
    plugin: {
      async setOwner({ userId }) { operations.push(['owner', userId]); },
      async getRegistration() { return { deviceId: 'device', deviceSecret: 'secret' }; }
    },
    async request() { throw new Error('offline'); },
    onOpen() {},
    reportError(error) { operations.push(['error', error.message]); }
  });
  await assert.rejects(lifecycle.unregister({ access_token: 'token' }), /offline/);
  assert.deepEqual(operations, [['owner', null], ['error', 'offline']]);
});

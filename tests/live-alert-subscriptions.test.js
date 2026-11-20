const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const userSource = fs.readFileSync(path.join(__dirname, '../frontend/js/users.js'), 'utf8');
const controlSource = userSource.slice(
  userSource.indexOf('function createLiveNotificationControl('),
  userSource.indexOf('\nfunction renderUserProfile(')
);

class Element {
  constructor() { this.children = []; this.events = {}; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { this.events[name] = callback; }
}

function control(profile, apiRequest) {
  const context = { document: { createElement: () => new Element() }, apiRequest, console, profile };
  vm.runInNewContext(`${controlSource}\nthis.control = createLiveNotificationControl(profile);`, context);
  return context.control.children;
}

test('profile setting is opt-in and can be turned on or off', async () => {
  const requests = [];
  const profile = { id: 'friend', live_notifications_enabled: false };
  const [input, text] = control(profile, async (url, options) => {
    requests.push({ url, method: options.method });
    return { live_notifications_enabled: options.method === 'POST' };
  });
  assert.equal(input.checked, false);
  assert.match(text.textContent, /this friend goes live/);
  input.checked = true;
  await input.events.change();
  assert.equal(profile.live_notifications_enabled, true);
  input.checked = false;
  await input.events.change();
  assert.equal(profile.live_notifications_enabled, false);
  assert.deepEqual(requests, [
    { url: '/users/friend/live-notifications', method: 'POST' },
    { url: '/users/friend/live-notifications', method: 'DELETE' }
  ]);
});

test('failed or unavailable settings do not appear enabled', async () => {
  const profile = { id: 'friend', live_notifications_enabled: false };
  const [input, , status] = control(profile, async () => { throw new Error('offline'); });
  input.checked = true;
  await input.events.change();
  assert.equal(input.checked, false);
  assert.equal(input.disabled, false);
  assert.match(status.textContent, /Could not update/);
  const [unavailable, , message] = control({ id: 'friend' }, async () => {});
  assert.equal(unavailable.disabled, true);
  assert.match(message.textContent, /unavailable/);
});

test('live notification labels are available in every supported language', () => {
  const labels = [
    'Notify me when this friend goes live',
    'Live notifications are temporarily unavailable',
    'Could not update live notifications. Please try again'
  ];
  for (const language of ['ar', 'de', 'es', 'fr', 'hi', 'nl', 'pt', 'ru', 'ur']) {
    const context = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../frontend/js/i18n-${language}.js`), 'utf8'), context);
    for (const label of labels) assert.ok(context.window.VynzoI18nDicts[language][label], `${language}: ${label}`);
  }
});

const apiSource = fs.readFileSync(path.join(__dirname, '../supabase/functions/vynzo-api/index.ts'), 'utf8');
const routeSource = apiSource.slice(
  apiSource.indexOf('  const liveNotificationMatch ='),
  apiSource.indexOf('  const profileMatch =')
);
const VIEWER = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';

async function route({ method = 'POST', target = HOST, friend = true, blocked = false, inactive = false, error = null } = {}) {
  const writes = [];
  const query = {
    delete() { writes.push(['delete']); return this; },
    eq(field, value) { writes.push([field, value]); return this; },
    then(resolve) { resolve({ error }); },
    async upsert(row) { writes.push(['upsert', row.subscriber_id, row.host_id]); return { error }; }
  };
  const context = {
    route: `/users/${target}/live-notifications`, method, viewerId: VIEWER, headers: {},
    admin: { from: table => { assert.equal(table, 'live_alert_subscriptions'); return query; } },
    getLiveMutualFriendIds: async () => new Set(friend ? [target] : []),
    getBlockRelation: async () => ({ blockedMe: blocked, blockedByMe: false }),
    restrictedAccountIds: async () => new Set(inactive ? [target] : []),
    throwOnError: value => { if (value) throw value; },
    jsonResponse: (status, body) => ({ status, body })
  };
  return { response: await vm.runInNewContext(`(async () => { ${routeSource} })()`, context), writes };
}

test('API allows only the viewer to subscribe to current, unblocked friends', async () => {
  const allowed = await route();
  assert.equal(allowed.response.status, 200);
  assert.deepEqual(allowed.writes[0], ['upsert', VIEWER, HOST]);
  for (const options of [{ friend: false }, { blocked: true }, { inactive: true }]) {
    const denied = await route(options);
    assert.equal(denied.response.status, 403);
    assert.equal(denied.writes.length, 0);
  }
  assert.equal((await route({ target: VIEWER })).response.status, 400);
  assert.equal((await route({ target: 'invalid' })).response.status, 400);
  assert.equal((await route({ error: { code: '23503' } })).response.status, 409);
});

test('unsubscribe remains available after friendship ends and is scoped to the viewer', async () => {
  const result = await route({ method: 'DELETE', friend: false });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.writes, [['delete'], ['subscriber_id', VIEWER], ['host_id', HOST]]);
});

test('the profile setting is routed to the Supabase API', () => {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/js/api.js'), 'utf8');
  const declaration = source.slice(source.indexOf('  const useSupabaseUserApi ='), source.indexOf('  const useSupabaseAccountApi ='));
  const routed = vm.runInNewContext(`${declaration}\nuseSupabaseUserApi`, { apiPath: `/users/${HOST}/live-notifications` });
  assert.equal(routed, true);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/api.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replaceAll('export async function ', 'async function ');

function setup(responses) {
  let calls = 0;
  const context = {
    AbortController, FormData, TypeError,
    API_ORIGIN: 'https://api.example', API_BASE_URL: 'https://api.example',
    window: { setTimeout, clearTimeout },
    localStorage: { getItem: () => null },
    supabase: null,
    async fetch() {
      const result = responses[calls++];
      if (result instanceof Error) throw result;
      return result;
    }
  };
  vm.runInNewContext(source, context);
  return { request: context.apiRequest, calls: () => calls };
}

test('recovers content reads after a brief disconnect or gateway error', async () => {
  for (const failure of [new TypeError('Network error'), new Response(null, { status: 503 })]) {
    const { request, calls } = setup([failure, Response.json({ posts: [] })]);
    assert.deepEqual(await request('/posts/feed'), { posts: [] });
    assert.equal(calls(), 2);
  }
});

test('does not retry mutations or permanent read errors', async () => {
  const mutation = setup([new TypeError('Network error')]);
  await assert.rejects(mutation.request('/posts/new', { method: 'POST' }), /Cannot reach/);
  assert.equal(mutation.calls(), 1);
  const read = setup([Response.json({ error: 'Not found' }, { status: 404 })]);
  await assert.rejects(read.request('/users/not-found/profile'), /Not found/);
  assert.equal(read.calls(), 1);
});

test('session restore does not wait for notification-device registration', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/js/supabase-client.js'), 'utf8');
  const restore = source.slice(source.indexOf('export async function restoreSupabaseSession()'),
    source.indexOf('\nif (supabase) {')).replace('export ', '');
  const session = { access_token: 'session' };
  let synced;
  let registered;
  const context = {
    supabase: { auth: { getSession: async () => ({ data: { session } }) } },
    syncLegacySession: value => { synced = value; },
    syncPushSession: value => { registered = value; return new Promise(() => {}); }
  };
  vm.runInNewContext(restore, context);
  const result = await Promise.race([
    context.restoreSupabaseSession().then(() => 'restored'),
    new Promise(resolve => setImmediate(() => resolve('waiting')))
  ]);
  assert.equal(result, 'restored');
  assert.equal(synced, session);
  assert.equal(registered, session);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/page-memory.js'), 'utf8')
  .replaceAll('export function ', 'function ');

function setup(native = true) {
  const session = new Map();
  const local = new Map([['vynzo_token', 'token'], ['vynzo_user', '{"id":"one"}']]);
  let now = 1000000;
  const context = {
    Capacitor: { isNativePlatform: () => native },
    Date: { now: () => now },
    console,
    localStorage: { getItem: key => local.get(key) || null },
    sessionStorage: {
      getItem: key => session.get(key) || null,
      setItem: (key, value) => session.set(key, value),
      removeItem: key => session.delete(key)
    }
  };
  vm.runInNewContext(source, context);
  return { context, local, session, advance: ms => { now += ms; } };
}

test('native snapshots survive a page reload but expire after two minutes', () => {
  const { context, advance } = setup();
  context.writePageMemory('settings-profile', { id: 'one', followers_count: 7 });
  const reloaded = { ...context };
  vm.runInNewContext(source, reloaded);
  assert.equal(reloaded.readPageMemory('settings-profile').followers_count, 7);
  advance(120000);
  assert.equal(reloaded.readPageMemory('settings-profile'), null);
});

test('page memory is native-only, account-scoped, cleared on logout and rejects late writes', () => {
  const web = setup(false);
  web.context.writePageMemory('feed:all', { posts: [] });
  assert.equal(web.session.size, 0);
  const { context, local } = setup();
  context.writePageMemory('settings-profile', { id: 'one' });
  local.set('vynzo_user', '{"id":"two"}');
  assert.equal(context.readPageMemory('settings-profile'), null);
  context.writePageMemory('settings-profile', { id: 'one' }, 'one');
  assert.equal(context.readPageMemory('settings-profile'), null);
  context.writePageMemory('settings-profile', { id: 'two' });
  context.clearPageMemory();
  assert.equal(context.readPageMemory('settings-profile'), null);
});

test('device snapshots stay bounded and oversize responses do not prevent smaller saves', () => {
  const { context, session } = setup();
  for (let i = 0; i < 10; i++) context.writePageMemory(`feed:${i}`, { caption: 'x'.repeat(50000) });
  assert.ok([...session.values()][0].length * 2 <= 750000);
  context.writePageMemory('huge', 'x'.repeat(750000));
  assert.equal(context.readPageMemory('huge'), null);
  context.writePageMemory('small', { value: 1 });
  assert.equal(context.readPageMemory('small').value, 1);
});

test('feed restores the visible post and video time and ignores refreshed permits and counters when retaining videos', () => {
  const feed = fs.readFileSync(path.join(__dirname, '../frontend/js/feed.js'), 'utf8');
  const source = feed.slice(feed.indexOf('function captureFeedPosition('), feed.indexOf('\nfunction renderFeed('));
  const video = { currentTime: 9, readyState: 1, duration: 12 };
  let restored = false;
  const card = {
    dataset: { postId: 'second' },
    getBoundingClientRect: () => ({ top: 100, bottom: 600 }),
    querySelector: () => video,
    scrollIntoView: () => { restored = true; }
  };
  const container = {
    getBoundingClientRect: () => ({ top: 80, bottom: 1800 }),
    querySelectorAll: () => [card]
  };
  const context = {
    URL, window: { innerHeight: 700, vynzoFeedScope: 'all', location: { href: 'https://example.test/' } },
    pageMemoryAccount: () => 'one'
  };
  vm.runInNewContext(source, context);
  const position = context.captureFeedPosition(container, 'all');
  assert.equal(position.postId, 'second');
  assert.equal(position.time, 9);
  video.currentTime = 0;
  context.restoreFeedPosition(container, position);
  assert.equal(restored, true);
  assert.equal(video.currentTime, 9);
  const old = { id: 'one', media_url: 'https://media.test/post?permit=old', likes_count: 1 };
  const fresh = { ...old, media_url: 'https://media.test/post?permit=fresh', likes_count: 2 };
  assert.equal(context.feedPostVersion(old), context.feedPostVersion(fresh));
  assert.notEqual(context.feedPostVersion(old), context.feedPostVersion({ ...fresh, is_protected: true }));
});

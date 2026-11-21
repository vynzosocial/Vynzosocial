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
    localStorage: {
      getItem: key => local.get(key) || null,
      setItem: (key, value) => local.set(key, value),
      removeItem: key => local.delete(key)
    },
    sessionStorage: {
      getItem: key => session.get(key) || null,
      setItem: (key, value) => session.set(key, value),
      removeItem: key => session.delete(key)
    }
  };
  vm.runInNewContext(source, context);
  return { context, local, session, advance: ms => { now += ms; } };
}

test('native snapshots survive a new session but expire after fifteen minutes', () => {
  const { context, local, advance } = setup();
  context.writePageMemory('settings-profile', { id: 'one', followers_count: 7 });
  const reloaded = { ...context, sessionStorage: { getItem: () => null, removeItem() {} } };
  vm.runInNewContext(source, reloaded);
  assert.equal(reloaded.readPageMemory('settings-profile').followers_count, 7);
  advance(900000);
  assert.equal(reloaded.readPageMemory('settings-profile'), null);
  assert.equal(local.get('vynzo_page_memory_v2').includes('followers_count'), false);
});

test('conversation snapshots exclude message content and reject late account responses', async () => {
  const messages = fs.readFileSync(path.join(__dirname, '../frontend/js/messages.js'), 'utf8');
  const source = messages.slice(messages.indexOf('async function refreshConversations()'), messages.indexOf('\nfunction renderConversations('));
  let resolve;
  let saved;
  let rendered;
  let account = 'one';
  const context = {
    localStorage: { getItem: () => JSON.stringify({ id: account }) },
    pageMemoryAccount: () => account,
    apiRequest: () => new Promise(done => { resolve = done; }),
    writePageMemory: (key, value, owner) => { saved = { key, value, owner }; },
    renderConversations: value => { rendered = value; }
  };
  vm.createContext(context);
  vm.runInContext(`let conversationRefreshRequest = 0;\n${source}`, context);
  let loading = context.refreshConversations();
  resolve({ conversations: [{ id: 'chat', is_group: true, group_name: 'Group',
    last_message: { content: 'private message', created_at: '2026-01-01' } }] });
  await loading;
  assert.equal(saved.owner, 'one');
  assert.equal(saved.value[0].is_group, true);
  assert.equal(JSON.stringify(saved).includes('private message'), false);
  assert.equal(rendered[0].last_message.content, 'private message');
  saved = null;
  rendered = null;
  loading = context.refreshConversations();
  account = 'two';
  resolve({ conversations: [{ id: 'old' }] });
  await loading;
  assert.equal(saved, null);
  assert.equal(rendered, null);
});

test('inbox shows saved conversations immediately and keeps them when refresh fails', async () => {
  const messages = fs.readFileSync(path.join(__dirname, '../frontend/js/messages.js'), 'utf8');
  const source = messages.slice(messages.indexOf('export async function initMessaging()'), messages.indexOf('\nfunction refreshVisibleConversations()'))
    .replace('export async function', 'async function');
  const cached = [{ id: 'chat', cached_preview: true }];
  let rejectRefresh;
  let rendered;
  let error;
  const context = {
    localStorage: { getItem: key => key === 'vynzo_user' ? '{"id":"one"}' : 'token' },
    document: { getElementById: () => ({}), addEventListener() {} },
    window: { location: { search: '' }, setInterval: () => 1 },
    URLSearchParams, console: { error() {} },
    readPageMemory: () => cached,
    renderConversations: value => { rendered = value; },
    initCalls() {},
    createRealtimeSocket: () => ({ on() {} }),
    refreshConversations: () => new Promise((resolve, reject) => { rejectRefresh = reject; }),
    showChatError() {},
    showConversationError: (message, retry, keepSaved) => { error = { message, keepSaved }; }
  };
  vm.createContext(context);
  vm.runInContext(`let socket, conversationRefreshInterval;\n${source}`, context);
  const loading = context.initMessaging();
  assert.equal(rendered, cached);
  rejectRefresh(new Error('Offline'));
  await loading;
  assert.equal(error.message, 'Offline');
  assert.equal(error.keepSaved, true);
});

test('page memory is native-only, account-scoped, cleared on logout and rejects late writes', () => {
  const web = setup(false);
  web.context.writePageMemory('feed:all', { posts: [] });
  assert.equal(web.local.has('vynzo_page_memory_v2'), false);
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
  const { context, local } = setup();
  for (let i = 0; i < 10; i++) context.writePageMemory(`feed:${i}`, { caption: 'x'.repeat(50000) });
  assert.ok(local.get('vynzo_page_memory_v2').length * 2 <= 750000);
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

test('feed videos use their authorized cover and older videos preload a frame', () => {
  const feed = fs.readFileSync(path.join(__dirname, '../frontend/js/feed.js'), 'utf8');
  const start = feed.indexOf("  const media = document.createElement(isVideo ? 'video' : 'img');");
  const end = feed.indexOf('\n  if (isVideo && reel)', start);
  const source = `${feed.slice(start, end)}\nresult = media;`;
  const render = post => {
    const context = {
      document: { createElement: () => ({}) }, isVideo: true, post,
      refreshExpiredMedia() {}, API_ORIGIN: 'https://api.example', result: null
    };
    vm.runInNewContext(source, context);
    return context.result;
  };
  const withCover = render({ media_url: '/video', cover_url: 'https://media.example/cover?permit=signed' });
  assert.equal(withCover.poster, 'https://media.example/cover?permit=signed');
  assert.equal(withCover.preload, 'metadata');
  const older = render({ media_url: '/legacy-video' });
  assert.equal(older.poster, undefined);
  assert.equal(older.preload, 'metadata');
});

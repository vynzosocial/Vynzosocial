const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', name), 'utf8');

test('empty Following feed links to Find People and ignores a late For You response', async () => {
  const source = read('feed.js');
  const feed = source.slice(source.indexOf('const FEED_PAGE'), source.indexOf('function initPostComposer'));
  let resolveForYou;
  const window = { vynzoFeedScope: 'all' };
  const container = {
    classList: { remove() {} },
    querySelector() { return null; }
  };
  const context = {
    window, URLSearchParams, console, container,
    pageMemoryAccount: () => null,
    readPageMemory: () => null,
    writePageMemory() {},
    reelObserver: { disconnect() {} },
    apiRequest: url => url.includes('scope=all')
      ? new Promise(resolve => { resolveForYou = resolve; })
      : Promise.resolve({ posts: [] })
  };
  const run = () => vm.runInContext('loadFeed(container)', context);
  vm.createContext(context);
  vm.runInContext(feed, context);
  const previous = run();
  window.vynzoFeedScope = 'following';
  await run();
  assert.match(container.innerHTML, /href="\.\/pages\/users\.html">Find people/);
  resolveForYou({ posts: [] });
  await previous;
  assert.match(container.innerHTML, /Posts from people you follow/);
});

test('the homepage highlights only friends with a live session and clears ended streams', () => {
  const source = read('home-friends.js');
  const section = {};
  const list = { replaceChildren(...cards) { this.cards = cards; } };
  const context = {
    document: { getElementById: id => id === 'home-live-friends' ? section : list },
    createFriendCard: friend => friend.live_session_id
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function renderLiveFriends'), source.indexOf('async function loadRequests')), context);
  vm.runInContext("renderLiveFriends([{ is_live: true, live_session_id: 'stream' }, { is_live: true }, { is_live: false }]);", context);
  assert.deepEqual(list.cards, ['stream']);
  assert.equal(section.hidden, false);
  vm.runInContext('renderLiveFriends([{ is_live: false }]);', context);
  assert.deepEqual(list.cards, []);
  assert.equal(section.hidden, true);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..', 'frontend');
const users = fs.readFileSync(path.join(root, 'js', 'users.js'), 'utf8');
const functions = users.slice(users.indexOf('function createLiveIndicator('), users.indexOf('\nexport async function openUserProfile('));
const sortFunction = users.slice(users.indexOf('function liveFirst('), users.indexOf('\nfunction initConnections('));

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.events = {};
    this.style = {};
    this.attributes = {};
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.events[name] = callback; }
}

function render(user, isConnection) {
  const opened = [];
  const context = {
    document: { createElement: tag => new Element(tag) },
    window: { location: { pathname: '/pages/users.html' } },
    MEDIA_BASE_URL: '',
    openUserProfile: id => opened.push(id),
    updateFollowButton() {},
    encodeURIComponent
  };
  const sandbox = { ...context, user, isConnection };
  vm.runInNewContext(`${functions}\nresult = createAccountResult(user, isConnection);`, sandbox);
  return { row: sandbox.result, opened };
}

test('connection names open profiles and live indicators retain the stream link', () => {
  const { row, opened } = render({ id: '42', username: 'averylongusername', is_live: true, live_session_id: 'live 1' }, true);
  const [avatar, identity, view] = row.children;
  assert.match(row.className, /account-connection/);
  assert.match(avatar.className, /is-live/);
  assert.equal(identity.children[1].textContent, '@averylongusername');
  identity.events.click();
  assert.deepEqual(opened, ['42']);
  const indicator = identity.children[0].children[1];
  assert.equal(indicator.href, 'live.html?sessionId=live%201');
  assert.equal(indicator.attributes['aria-label'], 'Watch averylongusername live');
  assert.equal(identity.children.length, 4);
  assert.equal(view.className, 'account-profile-button');
});

test('live users are first and original ordering returns when the stream ends', () => {
  const sandbox = {};
  vm.runInNewContext(`${sortFunction}\nthis.sort = liveFirst;`, sandbox);
  const users = [
    { id: 'a', is_live: false },
    { id: 'b', is_live: false },
    { id: 'c', is_live: true },
    { id: 'd', is_live: true }
  ];
  assert.equal(Array.from(sandbox.sort(users), user => user.id).join(''), 'cdab');
  users[2].is_live = false;
  users[3].is_live = false;
  assert.equal(Array.from(sandbox.sort(users), user => user.id).join(''), 'abcd');
  assert.equal(users.map(user => user.id).join(''), 'abcd');
});

test('search results and offline users do not receive connection or live styling', () => {
  const { row } = render({ id: '7', username: 'offline', is_live: false }, false);
  assert.equal(row.className, 'account-search-result');
  assert.equal(row.children[0].className, 'account-search-avatar');
  assert.equal(row.children[1].children.length, 3);
});

test('Find People preserves full usernames for both search results and connections', () => {
  for (const isConnection of [false, true]) {
    for (const username of ['vynzo_team', 'VynzoSocial', 'a'.repeat(50)]) {
      const { row } = render({ id: '7', username }, isConnection);
      assert.equal(row.children[1].children[1].textContent, `@${username}`);
    }
  }
  const css = fs.readFileSync(path.join(root, 'css', 'people-glow.css'), 'utf8');
  assert.match(css, /\.people-page \.account-search-identity strong,\s*\.people-page \.account-search-identity small\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /grid-template-columns: 40px repeat\(2, minmax\(0, 1fr\)\)/);
});

test('connection cards identify friends, outgoing follows, and followers separately', () => {
  const friend = render({ id: '1', username: 'friend', is_friend: true, is_following: true }, true);
  const following = render({ id: '2', username: 'following', is_following: true }, true);
  const follower = render({ id: '3', username: 'follower', is_following: false }, true);
  assert.equal(friend.row.children[1].children[3].textContent, 'Friend (you follow each other)');
  assert.equal(following.row.children[1].children[3].textContent, "Following (doesn't follow you back)");
  assert.equal(follower.row.children[1].children[3].textContent, "Follows you (you don't follow back)");
});

test('two connection groups combine outgoing follows and exclude mutual friends from followers', async () => {
  const rows = [];
  const requests = [];
  const data = [
    { id: 'friend', is_friend: true, is_following: true },
    { id: 'following', is_following: true },
    { id: 'follower', is_following: false }
  ];
  const tabs = ['following', 'followers'].map(type => ({
    dataset: { type }, events: {}, classList: { toggle() {} }, setAttribute() {},
    addEventListener(name, callback) { this.events[name] = callback; }
  }));
  const list = {
    replaceChildren() { rows.length = 0; },
    appendChild(row) { rows.push(row); },
    contains() { return false; }
  };
  const sandbox = {
    document: { hidden: false, getElementById: () => list, querySelectorAll: () => tabs },
    window: { setInterval() {} },
    pageMemoryAccount: () => null,
    readPageMemory: () => null,
    writePageMemory() {},
    apiRequest: async url => {
      requests.push(url);
      return { users: url.endsWith('type=following') ? data.filter(user => user.is_following) : data.filter(user => user.id !== 'following') };
    },
    createAccountResult: (user, _connection, onFollowChanged) => ({ ...user, onFollowChanged }),
    renderSearchMessage() {},
    console
  };
  const code = users.slice(users.indexOf('function liveFirst('), users.indexOf('\nasync function searchAccounts('));
  vm.runInNewContext(`${code}\ninitConnections();`, sandbox);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(rows.map(user => user.id), ['friend', 'following']);
  await tabs[1].events.click();
  assert.deepEqual(rows.map(user => user.id), ['follower']);
  data[2].is_following = true;
  await rows[0].onFollowChanged();
  assert.deepEqual(rows, []);
  await tabs[0].events.click();
  assert.deepEqual(rows.map(user => user.id), ['friend', 'following', 'follower']);
  assert.deepEqual(requests, [
    '/users/connections?type=following',
    '/users/connections?type=followers',
    '/users/connections?type=followers',
    '/users/connections?type=following'
  ]);
});

test('connection refresh moves live users and restores their original positions', async () => {
  const timers = [];
  const rows = [];
  const tab = { dataset: { type: 'following' }, classList: { toggle() {} }, setAttribute() {}, addEventListener() {} };
  const list = {
    replaceChildren() { rows.length = 0; },
    appendChild(row) { rows.push(row); },
    contains() { return false; }
  };
  const values = [{ id: 'a', is_live: false }, { id: 'b', is_live: false }];
  const sandbox = {
    document: {
      hidden: false,
      getElementById: () => list,
      querySelectorAll: () => [tab]
    },
    window: { setInterval(callback) { timers.push(callback); } },
    pageMemoryAccount: () => null,
    readPageMemory: () => null,
    writePageMemory() {},
    apiRequest: async () => ({ users: values.map(user => ({ ...user })) }),
    createAccountResult: user => user,
    renderSearchMessage() {},
    console
  };
  const code = users.slice(users.indexOf('function liveFirst('), users.indexOf('\nasync function searchAccounts('));
  vm.runInNewContext(`${code}\ninitConnections();`, sandbox);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rows.map(user => user.id).join(''), 'ab');
  values[1].is_live = true;
  timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rows.map(user => user.id).join(''), 'ba');
  values[1].is_live = false;
  timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rows.map(user => user.id).join(''), 'ab');
});

test('Find restores the selected connection list before refreshing and rejects a late account response', async () => {
  const rows = [];
  let resolveRequest;
  let account = 'one';
  const saved = new Map([
    ['find:tab', 'followers'],
    ['find:connections:followers', [{ id: 'saved', is_following: false }]]
  ]);
  const tabs = ['following', 'followers'].map(type => ({
    dataset: { type }, classList: { toggle() {} }, setAttribute() {}, addEventListener() {}
  }));
  const list = { replaceChildren() { rows.length = 0; }, appendChild(row) { rows.push(row); }, contains() { return false; } };
  const sandbox = {
    document: { hidden: false, getElementById: () => list, querySelectorAll: () => tabs },
    window: { setInterval() {} },
    pageMemoryAccount: () => account,
    readPageMemory: key => saved.get(key) || null,
    writePageMemory: (key, value) => saved.set(key, value),
    apiRequest: () => new Promise(resolve => { resolveRequest = resolve; }),
    createAccountResult: user => user,
    renderSearchMessage() {},
    console
  };
  const code = users.slice(users.indexOf('function liveFirst('), users.indexOf('\nasync function searchAccounts('));
  vm.runInNewContext(`${code}\ninitConnections();`, sandbox);
  assert.equal(rows[0].id, 'saved');
  account = 'two';
  resolveRequest({ users: [{ id: 'wrong-account', is_following: false }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rows[0].id, 'saved');
  assert.equal(saved.get('find:connections:followers')[0].id, 'saved');
});

test('Find restores the previous search immediately and refreshes it', () => {
  const controls = {
    'account-search-form': { addEventListener() {} },
    'account-search-input': { addEventListener() {} },
    'account-search-results': {}
  };
  const saved = { query: 'friend', users: [{ id: 'one' }] };
  let rendered;
  let refreshed;
  const sandbox = {
    document: { getElementById: id => controls[id], addEventListener() {} },
    window: { setInterval() {} },
    readPageMemory: () => saved,
    renderAccounts: (_container, users) => { rendered = users; },
    searchAccounts: async (query, _container, _current, refresh) => { refreshed = { query, refresh }; },
    initConnections() {}
  };
  const code = users.slice(users.indexOf('export function initAccountSearch()'), users.indexOf('\nfunction liveFirst('))
    .replace('export function', 'function');
  vm.runInNewContext(`${code}\ninitAccountSearch();`, sandbox);
  assert.equal(controls['account-search-input'].value, 'friend');
  assert.equal(rendered, saved.users);
  assert.equal(refreshed.query, 'friend');
  assert.equal(refreshed.refresh, true);
});

test('Find paints saved lists and search results while network requests are pending', {
  skip: !['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].some(fs.existsSync)
}, () => {
  const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(fs.existsSync);
  const memory = fs.readFileSync(path.join(root, 'js', 'page-memory.js'), 'utf8').replaceAll('export function ', 'function ');
  const code = users.slice(users.indexOf('export function initAccountSearch()'), users.indexOf('\nlet profileRequest'))
    .replace('export function', 'function');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vynzo-find-cache-'));
  try {
    const fixture = path.join(directory, 'fixture.html');
    fs.writeFileSync(fixture, `<!doctype html><body>
      <form id="account-search-form"><input id="account-search-input"></form>
      <button class="people-tab" data-type="following"></button>
      <button class="people-tab" data-type="followers"></button>
      <section id="connections-list"></section><section id="account-search-results"></section>
      <script>
        window.Capacitor = {isNativePlatform: () => true};
        const MEDIA_BASE_URL = '';
        const apiRequest = () => new Promise(() => {});
        const openUserProfile = () => {};
        const updateFollowButton = () => {};
        const renderSearchMessage = (element, text) => { element.textContent = text; };
        ${memory}
        ${code}
        localStorage.setItem('vynzo_token','token');
        localStorage.setItem('vynzo_user',JSON.stringify({id:'one'}));
        writePageMemory('find:tab','followers');
        writePageMemory('find:connections:followers',[{id:'one',username:'savedfriend'}]);
        writePageMemory('find:search',{query:'saved',users:[{id:'two',username:'savedresult'}]});
        initAccountSearch();
        const list = document.getElementById('connections-list').textContent;
        const results = document.getElementById('account-search-results').textContent;
        document.body.dataset.result = JSON.stringify({
          friend: list.includes('@savedfriend'), result: results.includes('@savedresult'),
          query: document.getElementById('account-search-input').value,
          selected: document.querySelector('[data-type=followers]').getAttribute('aria-selected')
        });
      </script></body>`);
    const result = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-first-run',
      `--user-data-dir=${directory}`, '--dump-dom', pathToFileURL(fixture).href],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const match = result.stdout.match(/data-result="([^"]+)"/);
    assert.ok(match, 'Browser did not finish Find cache checks.');
    assert.deepEqual(JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')),
      { friend: true, result: true, query: 'saved', selected: 'true' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

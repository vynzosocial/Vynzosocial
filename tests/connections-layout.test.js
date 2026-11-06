const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  assert.equal(identity.children.length, 3);
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

test('connection refresh moves live users and restores their original positions', async () => {
  const timers = [];
  const rows = [];
  const tab = { dataset: { type: 'friends' }, classList: { toggle() {} }, setAttribute() {}, addEventListener() {} };
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

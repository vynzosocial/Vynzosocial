const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..', 'frontend');
const users = fs.readFileSync(path.join(root, 'js', 'users.js'), 'utf8');
const functions = users.slice(users.indexOf('function createLiveBadge('), users.indexOf('\nexport async function openUserProfile('));

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

test('connection names open profiles and live badges retain the stream link', () => {
  const { row, opened } = render({ id: '42', username: 'averylongusername', is_live: true, live_session_id: 'live 1' }, true);
  const [avatar, identity, view] = row.children;
  assert.match(row.className, /account-connection/);
  assert.match(avatar.className, /is-live/);
  assert.equal(identity.children[1].textContent, '@averylongusername');
  identity.events.click();
  assert.deepEqual(opened, ['42']);
  assert.equal(identity.children[3].href, 'live.html?sessionId=live%201');
  assert.equal(view.className, 'account-profile-button');
});

test('search results and offline users do not receive connection or live styling', () => {
  const { row } = render({ id: '7', username: 'offline', is_live: false }, false);
  assert.equal(row.className, 'account-search-result');
  assert.equal(row.children[0].className, 'account-search-avatar');
  assert.equal(row.children[1].children.length, 3);
});

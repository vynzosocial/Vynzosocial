const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/settings-page.js'), 'utf8');
const code = source.slice(source.indexOf('function setupConnectionDropdowns('), source.indexOf('\nfunction formatStat('));

class Element {
  constructor() { this.events = {}; this.attributes = {}; this.children = []; this.dataset = {}; }
  addEventListener(name, callback) { this.events[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  replaceChildren() { this.children = []; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); }
  focus() { this.focused = true; }
  contains(target) { return this === target || this.children.some(child => child.contains(target)); }
}

function setup(apiRequest, user = { id: 'viewer' }) {
  const buttons = ['friends', 'followers', 'following'].map(type => {
    const button = new Element();
    button.dataset.connectionType = type;
    return button;
  });
  const elements = new Map(['settings-connections', 'settings-connections-heading', 'settings-connections-status', 'settings-connections-list'].map(id => [id, new Element()]));
  elements.get('settings-connections').hidden = true;
  const documentEvents = {};
  const context = {
    user, apiRequest, console: { error() {} },
    document: {
      addEventListener(name, callback) { documentEvents[name] = callback; },
      querySelectorAll: () => buttons,
      getElementById: id => elements.get(id),
      createElement: () => new Element()
    },
    setStatus(element, message, type) { element.textContent = message; element.statusType = type; }
  };
  vm.runInNewContext(`${code}\nsetupConnectionDropdowns(user);`, context);
  const panel = elements.get('settings-connections');
  panel.appendChild(elements.get('settings-connections-list'));
  return { buttons, panel, documentEvents, list: elements.get('settings-connections-list'), status: elements.get('settings-connections-status') };
}

test('each Settings stat opens the matching list and clicking again closes it', async () => {
  const urls = [];
  const ui = setup(async url => {
    urls.push(url);
    return { users: [{ id: 'other', display_name: 'Other User', username: 'full_username' }] };
  });
  for (const button of ui.buttons) {
    await button.events.click();
    assert.equal(ui.panel.hidden, false);
    assert.equal(button.attributes['aria-expanded'], 'true');
    assert.equal(ui.list.children[0].children[1].textContent, '@full_username');
    assert.equal(urls.at(-1), `/users/connections?type=${button.dataset.connectionType}`);
    await button.events.click();
    assert.equal(ui.panel.hidden, true);
    assert.equal(button.attributes['aria-expanded'], 'false');
  }
});

test('switching lists ignores stale responses and Escape closes with focus restored', async () => {
  let resolveFirst;
  const ui = setup(url => url.endsWith('friends')
    ? new Promise(resolve => { resolveFirst = resolve; })
    : Promise.resolve({ users: [] }));
  const first = ui.buttons[0].events.click();
  await ui.buttons[1].events.click();
  resolveFirst({ users: [{ username: 'stale' }] });
  await first;
  assert.equal(ui.list.children.length, 0);
  assert.equal(ui.status.textContent, 'No followers yet.');
  ui.panel.events.keydown({ key: 'Escape' });
  assert.equal(ui.panel.hidden, true);
  assert.equal(ui.buttons[1].focused, true);
});

test('load errors are visible and lists can be reopened to retry', async () => {
  let fails = true;
  const ui = setup(async () => {
    if (fails) throw new Error('Connection failed');
    return { users: [] };
  });
  await ui.buttons[0].events.click();
  assert.equal(ui.status.textContent, 'Connection failed');
  assert.equal(ui.status.statusType, 'error');
  await ui.buttons[0].events.click();
  fails = false;
  await ui.buttons[0].events.click();
  assert.equal(ui.status.textContent, 'No friends yet.');
});

test('connection buttons are disabled when logged out and linked to the dropdown', () => {
  const ui = setup(async () => ({ users: [] }), {});
  assert.ok(ui.buttons.every(button => button.disabled));
  const html = fs.readFileSync(path.join(__dirname, '../frontend/pages/settings.html'), 'utf8');
  for (const type of ['friends', 'followers', 'following']) {
    assert.match(html, new RegExp(`data-connection-type="${type}" aria-expanded="false" aria-controls="settings-connections"`));
  }
});

test('outside clicks close the dropdown but list and trigger clicks keep it open', async () => {
  const ui = setup(async () => ({ users: [{ id: 'other', username: 'other' }] }));
  await ui.buttons[0].events.click();
  const label = new Element();
  ui.buttons[0].appendChild(label);
  for (const target of [label, ui.list.children[0].children[1], ui.panel]) {
    ui.documentEvents.click({ target });
    assert.equal(ui.panel.hidden, false);
  }
  ui.documentEvents.click({ target: new Element() });
  assert.equal(ui.panel.hidden, true);
  assert.ok(ui.buttons.every(button => button.attributes['aria-expanded'] === 'false'));
  await ui.buttons[1].events.click();
  assert.equal(ui.panel.hidden, false);
});

test('closing outside while loading prevents a late response from filling the list', async () => {
  let resolve;
  const ui = setup(() => new Promise(done => { resolve = done; }));
  const loading = ui.buttons[0].events.click();
  ui.documentEvents.click({ target: new Element() });
  resolve({ users: [{ id: 'late', username: 'late' }] });
  await loading;
  assert.equal(ui.panel.hidden, true);
  assert.equal(ui.list.children.length, 0);
});

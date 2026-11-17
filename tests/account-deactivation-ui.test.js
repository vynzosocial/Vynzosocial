const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/settings-page.js'), 'utf8');
const handler = source.slice(source.indexOf('function setupAccountDeactivation('));

function setup({ loggedIn = true, confirmed = true, result = { deactivated: true }, requestError, signOutError, enteredPassword = 'current-password' } = {}) {
  const events = [];
  const confirmations = [];
  const nodes = {
    'account-deactivation-form': {
      querySelectorAll: () => [nodes['account-deactivation-password'], nodes['account-deactivation-button']],
      addEventListener(_name, listener) { this.submit = listener; }
    },
    'account-deactivation-password': { value: 'current-password', focus() { this.focused = true; } },
    'account-deactivation-open': {
      disabled: false,
      addEventListener(_name, listener) { this.click = listener; },
      setAttribute(name, value) { this[name] = value; }
    },
    'account-deactivation-details': { hidden: true },
    'account-deactivation-choice': {
      addEventListener(_name, listener) { this.click = listener; },
      setAttribute(name, value) { this[name] = value; },
      focus() { this.focused = true; }
    },
    'account-deactivation-panel': { hidden: true },
    'account-deactivation-button': { disabled: false },
    'account-deactivation-status': {}
  };
  const context = {
    document: { getElementById: id => nodes[id] },
    window: {
      location: { href: '' },
      confirm(message) { confirmations.push(message); return confirmed; },
      addEventListener(name, listener) { this[name] = listener; }
    },
    console: { error() {} },
    async apiRequest(url, options) {
      events.push(['request', url, options.method, JSON.parse(options.body)]);
      if (requestError) throw requestError;
      return result;
    },
    async signOutSupabase(options) {
      events.push(['signout', options.scope, options.unregister]);
      if (signOutError) throw signOutError;
    }
  };
  vm.createContext(context);
  vm.runInContext(handler, context);
  context.setupAccountDeactivation(loggedIn ? { id: 'viewer' } : {});
  assert.equal(nodes['account-deactivation-password'].value, '');
  nodes['account-deactivation-password'].value = enteredPassword;
  return { nodes, events, confirmations, context, submit: () => nodes['account-deactivation-form'].submit({ preventDefault() {} }) };
}

test('deactivation settings are visible and disclose bounded live-connection access', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/pages/settings.html'), 'utf8');
  const section = html.match(/<section\b[^>]*aria-labelledby="account-deactivation-open"[^>]*>/);
  assert.ok(section);
  assert.doesNotMatch(section[0], /\bhidden\b/);
  assert.match(html, /id="account-deactivation-details" hidden/);
  assert.match(html, /aria-expanded="false" aria-controls="account-deactivation-details"/);
  assert.match(html, /Already-connected live updates may remain available until their session token expires/);
});

test('log out remains the last settings section after the account actions', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/pages/settings.html'), 'utf8');
  const main = html.match(/<main\b[^>]*>[\s\S]*?<\/main>/)[0];
  const sections = [...main.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/g)];
  const lastSection = sections.at(-1)[0];
  assert.match(lastSection, /class="settings-card session-settings-card"/);
  assert.match(lastSection, /id="logout-btn"/);
  assert.match(main, /id="logout-btn"[^>]*>Log out<\/button>\s*<\/section>\s*<\/main>/);
});

test('deactivation requires login and confirmation before requesting the API', async () => {
  const loggedOut = setup({ loggedIn: false });
  assert.equal(loggedOut.nodes['account-deactivation-button'].disabled, true);
  assert.match(loggedOut.nodes['account-deactivation-status'].textContent, /Log in/);
  const unconfirmed = setup({ confirmed: false });
  await unconfirmed.submit();
  assert.equal(unconfirmed.events.length, 0);
  assert.equal(unconfirmed.confirmations.length, 1);
  assert.equal(unconfirmed.nodes['account-deactivation-button'].disabled, false);
});

test('one button opens both choices without opening the deactivation password panel', () => {
  const { nodes } = setup();
  const opener = nodes['account-deactivation-open'];
  opener.click();
  assert.equal(nodes['account-deactivation-details'].hidden, false);
  assert.equal(opener['aria-expanded'], 'true');
  assert.equal(opener.hidden, true);
  assert.equal(nodes['account-deactivation-choice'].focused, true);
  assert.equal(nodes['account-deactivation-panel'].hidden, true);
  assert.equal(nodes['account-deactivation-password'].value, '');
  nodes['account-deactivation-password'].value = 'prefilled';
  nodes['account-deactivation-choice'].click();
  assert.equal(nodes['account-deactivation-panel'].hidden, false);
  assert.equal(nodes['account-deactivation-choice']['aria-expanded'], 'true');
  assert.equal(nodes['account-deactivation-password'].focused, true);
  assert.equal(nodes['account-deactivation-password'].value, '');
});

test('deactivation password is empty on entry and after browser history restoration', () => {
  const { nodes, context } = setup({ enteredPassword: '' });
  assert.equal(nodes['account-deactivation-password'].value, '');
  nodes['account-deactivation-password'].value = 'restored-password';
  context.window.pageshow();
  assert.equal(nodes['account-deactivation-password'].value, '');
  const html = fs.readFileSync(path.join(__dirname, '../frontend/pages/settings.html'), 'utf8');
  assert.match(html, /id="account-deactivation-password"[^>]*autocomplete="new-password"/);
});

test('empty password cannot open final confirmation or call the API', async () => {
  const state = setup();
  state.nodes['account-deactivation-password'].value = '';
  await state.submit();
  assert.equal(state.confirmations.length, 0);
  assert.equal(state.events.length, 0);
  assert.match(state.nodes['account-deactivation-status'].textContent, /Enter your current password/);
});

test('confirmed deactivation submits the password, signs out locally, and redirects', async () => {
  const state = setup();
  await state.submit();
  assert.equal(state.confirmations.length, 1);
  assert.match(state.confirmations[0], /Are you sure.*deactivate/);
  assert.deepEqual(state.events, [
    ['request', '/auth/deactivate', 'POST', { password: 'current-password' }],
    ['signout', 'local', false]
  ]);
  assert.equal(state.context.window.location.href, '../index.html');
  assert.equal(state.nodes['account-deactivation-password'].value, '');
  await state.submit();
  assert.equal(state.events.length, 2);
});

test('deactivation failures allow retry without signing out or reporting success', async () => {
  for (const options of [{ requestError: new Error('Incorrect password') }, { result: {} }]) {
    const state = setup(options);
    await state.submit();
    assert.equal(state.events.length, 1);
    assert.equal(state.nodes['account-deactivation-button'].disabled, false);
    assert.equal(state.nodes['account-deactivation-open'].disabled, false);
    assert.equal(state.nodes['account-deactivation-status'].className, 'settings-status is-error');
    assert.equal(state.context.window.location.href, '');
  }
});

test('local sign-out failure explicitly reports that deactivation already succeeded', async () => {
  const state = setup({ signOutError: new Error('Local cleanup failed') });
  await state.submit();
  assert.equal(state.nodes['account-deactivation-button'].disabled, true);
  assert.match(state.nodes['account-deactivation-status'].textContent, /account is deactivated, but this device could not sign out/);
  assert.equal(state.context.window.location.href, '');
});

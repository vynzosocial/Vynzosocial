const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/delete-account.js'), 'utf8');
const handler = source.slice(source.indexOf('function setupAccountDeletion('));

function setup({ loggedIn = true, confirmed = true, requestResult = { otp_sent: true }, confirmResult = { deleted: true }, requestError, confirmError, signOutError, enteredPassword = 'current-password' } = {}) {
  const events = [];
  const nodes = {
    'account-deletion-password-form': {
      hidden: false,
      querySelectorAll: () => [nodes['account-deletion-password'], nodes['account-deletion-request-button']],
      addEventListener(_name, listener) { this.submit = listener; }
    },
    'account-deletion-code-form': {
      hidden: true,
      querySelectorAll: () => [nodes['account-deletion-code'], nodes['account-deletion-confirm-button'], nodes['account-deletion-back-button']],
      addEventListener(_name, listener) { this.submit = listener; }
    },
    'account-deletion-password': { value: 'current-password', focus() { this.focused = true; } },
    'account-deletion-code': { value: '1234', focus() { this.focused = true; } },
    'account-deletion-request-button': { disabled: false },
    'account-deletion-confirm-button': { disabled: false },
    'account-deletion-back-button': {
      disabled: false,
      addEventListener(_name, listener) { this.click = listener; }
    },
    'account-deletion-status': {}
  };
  const context = {
    document: { getElementById: id => nodes[id] },
    window: {
      location: { href: '' },
      confirm: () => confirmed,
      addEventListener(name, listener) { this[name] = listener; }
    },
    console: { error() {} },
    localStorage: { removeItem: key => events.push(['remove', key]) },
    async apiRequest(url, options) {
      events.push(['request', url, options.method, JSON.parse(options.body)]);
      if (url.endsWith('/request-code')) {
        if (requestError) throw requestError;
        return requestResult;
      }
      if (confirmError) throw confirmError;
      return confirmResult;
    },
    async signOutSupabase(options) {
      events.push(['signout', options.scope, options.unregister]);
      if (signOutError) throw signOutError;
    }
  };
  vm.createContext(context);
  vm.runInContext(handler, context);
  context.setupAccountDeletion(loggedIn ? { id: 'viewer' } : {});
  assert.equal(nodes['account-deletion-password'].value, '');
  nodes['account-deletion-password'].value = enteredPassword;
  return {
    nodes,
    events,
    context,
    request: () => nodes['account-deletion-password-form'].submit({ preventDefault() {} }),
    confirm: () => nodes['account-deletion-code-form'].submit({ preventDefault() {} })
  };
}

test('one settings button reveals both options while deletion keeps its own confirmation page', () => {
  const settings = fs.readFileSync(path.join(__dirname, '../frontend/pages/settings.html'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '../frontend/pages/delete-account.html'), 'utf8');
  const section = settings.match(/<section\b[^>]*aria-labelledby="account-deactivation-open"[^>]*>[\s\S]*?<\/section>/);
  assert.ok(section);
  assert.match(section[0], /href="delete-account\.html"/);
  assert.match(section[0], /aria-controls="account-deactivation-details">Deactivate or delete account<\/button>/);
  assert.match(section[0], /id="account-deactivation-details" hidden/);
  assert.match(section[0], /id="account-deactivation-choice"/);
  assert.match(section[0], /id="account-deactivation-panel" hidden/);
  assert.equal(settings.split('href="delete-account.html"').length - 1, 1);
  assert.match(page, /id="account-deletion-password-form"/);
  assert.match(page, /id="account-deletion-code-form"[^>]*hidden/);
  assert.match(page, /pattern="\[0-9\]\{4\}"/);
});

test('deletion password is empty on entry, restored navigation, and requesting a new code', async () => {
  const state = setup({ enteredPassword: '' });
  const input = state.nodes['account-deletion-password'];
  assert.equal(input.value, '');
  await state.request();
  assert.equal(state.events.length, 0);
  assert.match(state.nodes['account-deletion-status'].textContent, /Enter your current password/);
  input.value = 'restored-password';
  state.context.window.pageshow();
  assert.equal(input.value, '');
  input.value = 'prefilled-password';
  state.nodes['account-deletion-back-button'].click();
  assert.equal(input.value, '');
  const page = fs.readFileSync(path.join(__dirname, '../frontend/pages/delete-account.html'), 'utf8');
  assert.match(page, /id="account-deletion-password"[^>]*autocomplete="new-password"/);
  assert.doesNotMatch(page, /id="account-deletion-password"[^>]*\bvalue="[^"]+"/);
});

test('requires login and confirmation before requesting the email code', async () => {
  const loggedOut = setup({ loggedIn: false });
  assert.equal(loggedOut.nodes['account-deletion-request-button'].disabled, true);
  assert.match(loggedOut.nodes['account-deletion-status'].textContent, /Log in/);
  const cancelled = setup({ confirmed: false });
  await cancelled.request();
  assert.equal(cancelled.events.length, 0);
});

test('password verification sends an OTP request and switches to the code form', async () => {
  const state = setup();
  await state.request();
  assert.deepEqual(state.events, [
    ['request', '/auth/delete-account/request-code', 'POST', { password: 'current-password' }]
  ]);
  assert.equal(state.nodes['account-deletion-password-form'].hidden, true);
  assert.equal(state.nodes['account-deletion-code-form'].hidden, false);
  assert.equal(state.nodes['account-deletion-password'].value, '');
  assert.equal(state.nodes['account-deletion-code'].focused, true);
});

test('requires a 4-digit code and only signs out after deletion succeeds', async () => {
  const state = setup();
  state.nodes['account-deletion-code'].value = '12';
  await state.confirm();
  assert.equal(state.events.length, 0);
  assert.match(state.nodes['account-deletion-status'].textContent, /4-digit code/);

  state.nodes['account-deletion-code'].value = '1234';
  await state.confirm();
  assert.deepEqual(state.events, [
    ['request', '/auth/delete-account/confirm', 'POST', { code: '1234' }],
    ['signout', 'local', false]
  ]);
  assert.equal(state.context.window.location.href, '../index.html');
});

test('failed requests keep the user on the page and permit retry', async () => {
  const state = setup({ requestError: new Error('Wrong password') });
  await state.request();
  assert.equal(state.nodes['account-deletion-request-button'].disabled, false);
  assert.equal(state.context.window.location.href, '');
  assert.equal(state.nodes['account-deletion-password-form'].hidden, false);
  assert.equal(state.nodes['account-deletion-status'].className, 'settings-status is-error');
});

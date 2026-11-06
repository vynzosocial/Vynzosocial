const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..', 'frontend');
const manager = fs.readFileSync(path.join(root, 'js', 'password-manager.js'), 'utf8').replace(/export /g, '');
const auth = fs.readFileSync(path.join(root, 'js', 'auth.js'), 'utf8');
const login = auth.slice(auth.indexOf('  if (loginForm) {'), auth.indexOf('\n  if (registerForm) {'));

function managerHarness({ native = false, plugin = false, browser = false } = {}) {
  const calls = [];
  const passwordManager = {
    async save(data) { calls.push(['save', data]); },
    async select() { calls.push(['select']); return { username: 'name', password: 'secret' }; }
  };
  class Credential { constructor(data) { Object.assign(this, data); } }
  const sandbox = {
    window: {
      Capacitor: { isNativePlatform: () => native, isPluginAvailable: () => plugin, Plugins: { PasswordManager: passwordManager } },
      ...(browser ? { PasswordCredential: Credential } : {})
    },
    navigator: { credentials: {
      async store(data) { calls.push(['store', data]); },
      async get(options) { calls.push(['get', options]); return { id: 'name', password: 'secret' }; }
    } }
  };
  vm.runInNewContext(`${manager}\nthis.save = offerToSaveLogin; this.select = selectSavedLogin; this.available = canSelectSavedLogin;`, sandbox);
  return { sandbox, calls };
}

test('uses system password manager on Android and browser manager on web', async () => {
  for (const [options, saveAction, selectAction] of [
    [{ native: true, plugin: true }, 'save', 'select'],
    [{ browser: true }, 'store', 'get']
  ]) {
    const { sandbox, calls } = managerHarness(options);
    assert.equal(sandbox.available(), true);
    await sandbox.save('name', 'secret');
    const selected = await sandbox.select();
    assert.equal(selected.username, 'name');
    assert.equal(selected.password, 'secret');
    assert.equal(calls[0][0], saveAction);
    assert.equal(calls[1][0], selectAction);
  }
});

test('older Android app does not silently store credentials in the WebView', async () => {
  const { sandbox, calls } = managerHarness({ native: true, browser: true });
  assert.equal(sandbox.available(), false);
  await assert.rejects(sandbox.save('name', 'secret'), /not available/);
  assert.equal(calls.length, 0);
});

function loginHarness({ saveChecked = false, failLogin = false, failSave = false } = {}) {
  const elements = {};
  for (const id of ['use-saved-login', 'login-submit', 'login-continue', 'error-message', 'email', 'password', 'save-login']) elements[id] = { hidden: false, value: '', events: {}, addEventListener(name, callback) { this.events[name] = callback; } };
  elements.email.value = 'name';
  elements.password.value = 'secret';
  elements['save-login'].checked = saveChecked;
  const form = { events: {}, addEventListener(name, callback) { this.events[name] = callback; } };
  const saved = [];
  const sandbox = {
    loginForm: form, document: { getElementById: id => elements[id] },
    window: { location: { href: '' } },
    SUPABASE_URL: 'https://example.test', SUPABASE_PUBLISHABLE_KEY: 'public',
    fetch: async () => failLogin
      ? { ok: false, json: async () => ({ error: 'Bad credentials' }) }
      : { ok: true, json: async () => ({ session: {} }) },
    requireSupabase: () => ({ auth: { setSession: async () => ({ data: { session: {}, user: {} } }) } }),
    syncLegacySession() {}, canSelectSavedLogin: () => true,
    selectSavedLogin: async () => ({ username: 'saved', password: 'saved-secret' }),
    offerToSaveLogin: async (...args) => { saved.push(args); if (failSave) throw Error('cancelled'); }
  };
  vm.runInNewContext(login, sandbox);
  return { form, elements, sandbox, saved };
}

test('only offers to save after successful authentication and explicit selection', async () => {
  const noSave = loginHarness();
  await noSave.form.events.submit({ preventDefault() {} });
  assert.equal(noSave.saved.length, 0);
  assert.equal(noSave.sandbox.window.location.href, '../index.html');
  const bad = loginHarness({ saveChecked: true, failLogin: true });
  await bad.form.events.submit({ preventDefault() {} });
  assert.equal(bad.saved.length, 0);
  assert.equal(bad.elements['error-message'].textContent, 'Bad credentials');
  const good = loginHarness({ saveChecked: true });
  await good.form.events.submit({ preventDefault() {} });
  assert.equal(good.saved[0].join(':'), 'name:secret');
  assert.equal(good.sandbox.window.location.href, '../index.html');
});

test('cancelled saving preserves the signed-in session and offers continue', async () => {
  const result = loginHarness({ saveChecked: true, failSave: true });
  await result.form.events.submit({ preventDefault() {} });
  assert.equal(result.elements['login-submit'].hidden, true);
  assert.equal(result.elements['login-continue'].hidden, false);
  assert.match(result.elements['error-message'].textContent, /did not save/);
  assert.equal(result.sandbox.window.location.href, '');
});

test('saved login fills the form without automatically signing in', async () => {
  const result = loginHarness();
  await result.elements['use-saved-login'].events.click();
  assert.equal(result.elements.email.value, 'saved');
  assert.equal(result.elements.password.value, 'saved-secret');
  assert.equal(result.sandbox.window.location.href, '');
});

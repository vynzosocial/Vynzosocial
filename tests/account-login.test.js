const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const userId = 'c86cf40c-d629-4d7a-919f-4d2055498f90';
const user = { id: userId, email: 'person@example.com', email_confirmed_at: '2026-01-01T00:00:00.000Z' };
const session = { user, access_token: 'access', refresh_token: 'refresh' };
let currentLoginEmail, resolveAccountLogin, verifyLoginIdentity;
test.before(async () => {
  global.crypto = webcrypto;
  ({ currentLoginEmail, resolveAccountLogin, verifyLoginIdentity } = await import('../supabase/functions/vynzo-api/account-login.mjs'));
});

test('username and phone logins use the current Auth email, not a stale profile email', async () => {
  const updated = { ...user, email: 'new@example.com' };
  assert.equal(await currentLoginEmail(userId, async id => {
    assert.equal(id, userId);
    return updated;
  }), updated.email);
  assert.equal(await currentLoginEmail(userId, async () => ({ ...updated, email: null })), null);
  await assert.rejects(currentLoginEmail(userId, async () => ({ ...updated, id: 'other' })), /invalid user/);
  await assert.rejects(currentLoginEmail(userId, async () => null), /invalid user/);
  await assert.rejects(currentLoginEmail(userId, async () => { throw new Error('Auth unavailable'); }), /Auth unavailable/);
});

test('a concurrent email reassignment never returns a different account session', async () => {
  const calls = [];
  const signOut = async () => calls.push('signout');
  assert.equal(await verifyLoginIdentity({ user, session }, userId, signOut), true);
  assert.equal(await verifyLoginIdentity({ user, session }, null, signOut), true);
  assert.equal(await verifyLoginIdentity({ user: { id: 'other' }, session }, userId, signOut), false);
  assert.equal(await verifyLoginIdentity({ user, session: { ...session, user: { id: 'other' } } }, userId, signOut), false);
  assert.deepEqual(calls, ['signout', 'signout']);
  await assert.rejects(verifyLoginIdentity({ user: { id: 'other' }, session }, userId, async () => {
    throw new Error('signout failed');
  }), /signout failed/);
});

function setup(state) {
  const calls = [];
  return {
    calls,
    signedIn: { user, session },
    getState: async id => { calls.push(['state', id]); return state; },
    signOut: async () => { calls.push(['signout']); },
    repository: { replaceTokenForDeactivatedAccount: async () => { calls.push(['store']); return true; } },
    sendEmail: async mail => { calls.push(['email', mail]); }
  };
}

test('active login keeps its session without email or revocation', async () => {
  const deps = setup(null);
  assert.deepEqual(await resolveAccountLogin(deps), { status: 'active', session });
  assert.deepEqual(deps.calls, [['state', userId]]);
});

test('deactivated login revokes the temporary session before issuing activation email', async () => {
  const deps = setup('deactivated');
  const result = await resolveAccountLogin(deps);
  assert.deepEqual(result, { status: 'activation_sent' });
  assert.deepEqual(deps.calls.map(call => call[0]), ['state', 'signout', 'store', 'email']);
  assert.equal(deps.calls[3][1].email, user.email);
});

test('deleting accounts cannot reactivate and failures never return a session', async () => {
  const deleting = setup('deleting');
  assert.deepEqual(await resolveAccountLogin(deleting), { status: 'deleting' });
  assert.deepEqual(deleting.calls.map(call => call[0]), ['state', 'signout']);
  const pending = setup('deactivating');
  assert.deepEqual(await resolveAccountLogin(pending), { status: 'deactivating' });
  assert.deepEqual(pending.calls.map(call => call[0]), ['state', 'signout']);
  const failure = setup('deactivated');
  failure.signOut = async () => { throw new Error('revocation failed'); };
  await assert.rejects(resolveAccountLogin(failure), /revocation failed/);
  assert.deepEqual(failure.calls.map(call => call[0]), ['state']);
  const badMail = setup('deactivated');
  badMail.sendEmail = async () => { throw new Error('mail failed'); };
  await assert.rejects(resolveAccountLogin(badMail), /mail failed/);
  const unavailable = setup('deactivated');
  unavailable.getState = async () => { throw new Error('database failed'); };
  await assert.rejects(resolveAccountLogin(unavailable), /database failed/);
  assert.deepEqual(unavailable.calls.map(call => call[0]), ['signout']);
  unavailable.signOut = async () => { throw new Error('signout failed'); };
  await assert.rejects(resolveAccountLogin(unavailable), error =>
    error instanceof AggregateError && error.errors.length === 2);
  const invalidSession = setup(null);
  invalidSession.signedIn = { user, session: { ...session, user: { id: 'other' } } };
  await assert.rejects(resolveAccountLogin(invalidSession), /Invalid authenticated session/);
  assert.deepEqual(invalidSession.calls, [['signout']]);
  invalidSession.signOut = async () => { throw new Error('signout failed'); };
  await assert.rejects(resolveAccountLogin(invalidSession), error =>
    error instanceof AggregateError && error.errors.length === 2);
});

test('activation page removes token from address and requires explicit confirmation', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/js/reactivate-account.js'), 'utf8').replace(/^import .*;\r?\n/m, '');
  const token = 'A'.repeat(43);
  const status = {};
  const button = { addEventListener(_name, fn) { this.click = fn; } };
  const calls = [];
  const context = {
    URLSearchParams,
    SUPABASE_URL: 'https://auth.example',
    SUPABASE_PUBLISHABLE_KEY: 'public',
    location: { hash: `#token=${token}`, pathname: '/pages/reactivate.html', search: '' },
    history: { replaceState: (_state, _title, url) => calls.push(['history', url]) },
    document: { getElementById: id => id === 'activate-account' ? button : status },
    fetch: async (url, options) => {
      calls.push(['fetch', url, options]);
      return { ok: true, json: async () => ({ activated: true }) };
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.deepEqual(calls, [['history', '/pages/reactivate.html']]);
  assert.equal(button.disabled, false);
  await button.click();
  assert.equal(JSON.parse(calls[1][2].body).token, token);
  assert.equal(button.hidden, true);
  assert.match(status.textContent, /active again/i);
});

test('invalid activation links cannot submit and temporary failures allow retry', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/js/reactivate-account.js'), 'utf8').replace(/^import .*;\r?\n/m, '');
  function run(hash) {
    const status = {};
    const button = { addEventListener(_name, fn) { this.click = fn; } };
    const context = {
      URLSearchParams, SUPABASE_URL: 'https://auth.example', SUPABASE_PUBLISHABLE_KEY: 'public',
      location: { hash, pathname: '/pages/reactivate.html', search: '' },
      history: { replaceState() {} },
      document: { getElementById: id => id === 'activate-account' ? button : status },
      fetch: async () => { throw new Error('Network unavailable'); }
    };
    vm.runInNewContext(source, context);
    return { status, button };
  }
  const invalid = run('#token=bad');
  assert.equal(invalid.button.hidden, true);
  assert.equal(invalid.button.click, undefined);
  const valid = run(`#token=${'A'.repeat(43)}`);
  await valid.button.click();
  assert.equal(valid.button.disabled, false);
  assert.match(valid.status.textContent, /Network unavailable/);
});

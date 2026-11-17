const assert = require('node:assert/strict');
const test = require('node:test');

const userId = 'c86cf40c-d629-4d7a-919f-4d2055498f90';
const user = { id: userId, email: 'person@example.com', email_confirmed_at: '2026-01-01T00:00:00.000Z' };
let deactivateAccount;
test.before(async () => {
  ({ deactivateAccount } = await import('../supabase/functions/vynzo-api/account-deactivation.mjs'));
});

function setup() {
  const events = [];
  let state = null;
  const deps = {
    user, password: 'password',
    verifyPassword: async (email, password) => {
      events.push(['verify', email, password]);
      return user;
    },
    repository: {
      async beginDeactivation(id) {
        events.push(['begin', id]);
        if (state !== null) return false;
        state = 'deactivating';
        return true;
      },
      async finishDeactivation(id) {
        events.push(['finish', id]);
        if (state !== 'deactivating') return false;
        state = 'deactivated';
        return true;
      }
    },
    revokeSessions: async id => { events.push(['revoke', id]); }
  };
  return { deps, events, get state() { return state; } };
}

test('requires a verified email and the account owner’s password before any state change', async () => {
  const state = setup();
  assert.deepEqual(await deactivateAccount({ ...state.deps, user: { ...user, email: '123@phone.vynzosocial.com' } }), { status: 'verified_email_required' });
  assert.deepEqual(await deactivateAccount({ ...state.deps, password: '' }), { status: 'password_required' });
  assert.deepEqual(await deactivateAccount({ ...state.deps, verifyPassword: async () => null }), { status: 'invalid_password' });
  assert.deepEqual(await deactivateAccount({ ...state.deps, verifyPassword: async () => ({ id: 'other' }) }), { status: 'invalid_password' });
  assert.deepEqual(state.events, []);
  assert.equal(state.state, null);
});

test('blocks account access before revoking sessions, then completes without touching media', async () => {
  const state = setup();
  assert.deepEqual(await deactivateAccount(state.deps), { status: 'deactivated' });
  assert.equal(state.state, 'deactivated');
  assert.deepEqual(state.events.map(event => event[0]), ['verify', 'begin', 'revoke', 'finish']);
});

test('revocation errors leave a blocked, incomplete state and never report success', async () => {
  const state = setup();
  state.deps.revokeSessions = async () => { throw new Error('revocation unavailable'); };
  await assert.rejects(deactivateAccount(state.deps), /revocation unavailable/);
  assert.equal(state.state, 'deactivating');
  assert.equal(state.events.some(event => event[0] === 'finish'), false);
  assert.deepEqual(await deactivateAccount(state.deps), { status: 'account_unavailable' });
});

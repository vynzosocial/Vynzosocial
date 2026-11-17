const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const test = require('node:test');

global.crypto = webcrypto;

const userId = 'c86cf40c-d629-4d7a-919f-4d2055498f90';
const user = {
  id: userId,
  email: ' person@example.com ',
  email_confirmed_at: '2026-01-01T00:00:00.000Z'
};
const secret = 'account-deletion-test-secret-longer-than-thirty-two-characters';
let requestAccountDeletion, completeAccountDeletion, createAccountLifecycleRepository;
test.before(async () => {
  ({ requestAccountDeletion, completeAccountDeletion } = await import('../supabase/functions/vynzo-api/account-deletion.mjs'));
  ({ createAccountLifecycleRepository } = await import('../supabase/functions/vynzo-api/account-lifecycle-repository.mjs'));
});

function setup() {
  const events = [];
  let codeHash = null;
  const repository = {
    async issueCode(id, hash, expiresAt) {
      events.push(['issue', id, expiresAt]);
      codeHash = hash;
      return true;
    },
    async beginDeletion(id, hash) {
      events.push(['begin', id]);
      return id === userId && hash === codeHash;
    },
    async recordTombstone(id) { events.push(['tombstone', id]); }
  };
  return {
    events,
    repository,
    request: overrides => requestAccountDeletion({
      user,
      password: 'current-password',
      verifyPassword: async (email, password) => {
        events.push(['verify', email, password]);
        return password === 'current-password' ? { id: userId } : null;
      },
      repository,
      sendEmail: async message => { events.push(['email', message]); },
      secret,
      now: Date.parse('2026-11-11T00:00:00Z'),
      createCode: () => '0042',
      ...overrides
    })
  };
}

test('requires a verified email and current password before issuing a code', async () => {
  const state = setup();
  assert.deepEqual(await state.request({
    user: { ...user, email: '123@phone.vynzosocial.com' }
  }), { status: 'verified_email_required' });
  assert.deepEqual(await state.request({ password: '' }), { status: 'password_required' });
  assert.deepEqual(await state.request({
    verifyPassword: async () => null
  }), { status: 'invalid_password' });
  assert.deepEqual(state.events, []);
});

test('stores a keyed code hash and emails the 4-digit code for ten minutes', async () => {
  const state = setup();
  assert.deepEqual(await state.request(), { status: 'code_sent' });
  assert.deepEqual(state.events.map(event => event[0]), ['verify', 'issue', 'email']);
  const email = state.events[2][1];
  assert.equal(email.email, 'person@example.com');
  assert.equal(email.code, '0042');
  assert.equal(Date.parse(email.expiresAt), Date.parse('2026-11-11T00:10:00Z'));
});

test('wrong codes cannot delete anything; a verified code runs cleanup in order', async () => {
  const state = setup();
  await state.request();
  state.events.length = 0;
  const cleanup = {
    deleteMedia: async id => { state.events.push(['media', id]); },
    deleteStorage: async id => { state.events.push(['storage', id]); },
    deleteProfile: async id => { state.events.push(['profile', id]); },
    deleteAuthUser: async id => { state.events.push(['auth', id]); }
  };
  assert.deepEqual(await completeAccountDeletion({
    userId, code: '9999', secret, repository: state.repository, ...cleanup
  }), { status: 'invalid_code' });
  assert.deepEqual(state.events.map(event => event[0]), ['begin']);

  state.events.length = 0;
  assert.deepEqual(await completeAccountDeletion({
    userId, code: '0042', secret, repository: state.repository, ...cleanup
  }), { status: 'deleted' });
  assert.deepEqual(state.events.map(event => event[0]), [
    'begin', 'media', 'storage', 'tombstone', 'profile', 'auth'
  ]);
});

test('invalid codes and cleanup errors never report successful deletion', async () => {
  const state = setup();
  await state.request();
  assert.deepEqual(await completeAccountDeletion({
    userId, code: '42', secret, repository: state.repository,
    deleteMedia: async () => assert.fail('invalid code must not clean media'),
    deleteStorage: async () => {},
    deleteProfile: async () => {},
    deleteAuthUser: async () => {}
  }), { status: 'invalid_code' });
  await assert.rejects(completeAccountDeletion({
    userId, code: '0042', secret, repository: state.repository,
    deleteMedia: async () => { throw new Error('R2 unavailable'); },
    deleteStorage: async () => {},
    deleteProfile: async () => {},
    deleteAuthUser: async () => {}
  }), /R2 unavailable/);
});

test('a later confirmation can resume cleanup after a partial failure', async () => {
  const state = setup();
  await state.request();
  let authDeleteAttempts = 0;
  const cleanup = {
    deleteMedia: async () => {},
    deleteStorage: async () => {},
    deleteProfile: async () => {},
    async deleteAuthUser() {
      authDeleteAttempts++;
      if (authDeleteAttempts === 1) throw new Error('Auth deletion temporarily unavailable');
    }
  };
  await assert.rejects(completeAccountDeletion({
    userId, code: '0042', secret, repository: state.repository, ...cleanup
  }), /Auth deletion temporarily unavailable/);
  assert.deepEqual(await completeAccountDeletion({
    userId, code: '0042', secret, repository: state.repository, ...cleanup
  }), { status: 'deleted' });
  assert.equal(authDeleteAttempts, 2);
});

test('repository uses the OTP lifecycle RPCs and keeps deletion tombstones idempotent', async () => {
  const calls = [];
  const admin = {
    async rpc(name, parameters) {
      calls.push(['rpc', name, parameters]);
      return { data: true, error: null };
    },
    from(table) {
      assert.equal(table, 'account_deletion_tombstones');
      return {
        async upsert(row, options) {
          calls.push(['upsert', table, row, options]);
          return { error: null };
        }
      };
    }
  };
  const repository = createAccountLifecycleRepository(admin);
  assert.equal(await repository.issueCode(userId, 'a'.repeat(64), '2026-11-11T00:10:00.000Z'), true);
  assert.equal(await repository.beginDeletion(userId, 'b'.repeat(64)), true);
  await repository.recordTombstone(userId);
  assert.deepEqual(calls, [
    ['rpc', 'issue_account_deletion_otp', {
      p_user_id: userId, p_code_hash: 'a'.repeat(64), p_expires_at: '2026-11-11T00:10:00.000Z'
    }],
    ['rpc', 'begin_account_deletion', { p_user_id: userId, p_code_hash: 'b'.repeat(64) }],
    ['upsert', 'account_deletion_tombstones', { user_id: userId }, { onConflict: 'user_id' }]
  ]);
});

test('deletion recovery endpoints authenticate directly and remain ahead of lifecycle blocking', () => {
  const api = fs.readFileSync(path.join(__dirname, '../supabase/functions/vynzo-api/index.ts'), 'utf8');
  const requestRoute = api.indexOf("endpointSegments[2] === 'request-code'");
  const confirmRoute = api.indexOf("endpointSegments[2] === 'confirm'");
  const viewerRoute = api.indexOf('const viewer = await getViewer(request)');
  assert.ok(requestRoute >= 0 && confirmRoute > requestRoute && viewerRoute > confirmRoute);
  assert.match(api.slice(requestRoute, viewerRoute), /getAccountForDeletion\(request\)/);
  assert.match(api.slice(requestRoute, viewerRoute), /admin\.auth\.admin\.deleteUser\(userId, false\)/);

  const loginState = api.indexOf('async getState(userId: string)');
  const tombstoneLookup = api.indexOf("from('account_deletion_tombstones')", loginState);
  const lifecycleLookup = api.indexOf("from('account_lifecycle')", loginState);
  assert.ok(loginState >= 0 && tombstoneLookup > loginState && lifecycleLookup > tombstoneLookup);
});

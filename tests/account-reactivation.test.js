const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const test = require('node:test');

const userId = 'c86cf40c-d629-4d7a-919f-4d2055498f90';
const user = { id: userId, email: 'person@example.com', email_confirmed_at: '2026-01-01T00:00:00.000Z' };
const now = Date.parse('2026-11-11T00:00:00.000Z');
let issueReactivation, redeemReactivation, usableActivationEmail, createAccountLifecycleRepository;
test.before(async () => {
  global.crypto = webcrypto;
  ({ issueReactivation, redeemReactivation, usableActivationEmail } = await import('../supabase/functions/vynzo-api/account-reactivation.mjs'));
  ({ createAccountLifecycleRepository } = await import('../supabase/functions/vynzo-api/account-lifecycle-repository.mjs'));
});

function setup() {
  let stored;
  let active = false;
  const sent = [];
  const repository = {
    async replaceTokenForDeactivatedAccount(id, hash, expiresAt) {
      if (active) return false;
      stored = { id, hash, expiresAt };
      return true;
    },
    async consumeTokenAndActivate(hash, at) {
      if (active || !stored || stored.hash !== hash || stored.expiresAt <= at) return false;
      active = true;
      stored = null;
      return true;
    }
  };
  return { repository, sent, get stored() { return stored; }, get active() { return active; },
    sendEmail: async mail => sent.push(mail) };
}

test('requires a verified usable email and rejects phone placeholder addresses', async () => {
  assert.equal(usableActivationEmail(user), true);
  for (const email of ['', 'bad', 'a@b@example.com', 'x@phone.vynzosocial.com', 'x@PHONE.VYNZOSOCIAL.COM', 'x\n@example.com']) {
    assert.equal(usableActivationEmail({ ...user, email }), false);
  }
  assert.equal(usableActivationEmail({ ...user, email_confirmed_at: null }), false);
  const state = setup();
  await assert.rejects(issueReactivation({ ...state, user: { ...user, email_confirmed_at: null }, now }), /verified recovery email/);
  assert.equal(state.sent.length, 0);
  assert.equal(state.stored, undefined);
});

test('stores only a token hash and atomically activates once before expiry', async () => {
  const state = setup();
  await issueReactivation({ ...state, user, now });
  const { token, expiresAt } = state.sent[0];
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(state.stored.hash, token);
  assert.equal(expiresAt, new Date(now + 30 * 60 * 1000).toISOString());
  const results = await Promise.all([
    redeemReactivation({ token, repository: state.repository, now: now + 1 }),
    redeemReactivation({ token, repository: state.repository, now: now + 1 })
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(state.active, true);
  assert.equal(await redeemReactivation({ token, repository: state.repository, now: now + 2 }), false);
});

test('expires tokens and invalidates earlier email links after reissue', async () => {
  const state = setup();
  await issueReactivation({ ...state, user, now });
  const first = state.sent[0].token;
  await issueReactivation({ ...state, user, now: now + 1 });
  const second = state.sent[1].token;
  assert.notEqual(first, second);
  assert.equal(await redeemReactivation({ token: first, repository: state.repository, now: now + 2 }), false);
  assert.equal(await redeemReactivation({ token: second, repository: state.repository, now: now + 30 * 60 * 1000 + 1 }), false);
  assert.equal(state.active, false);
});

test('fails explicitly on repository and email errors and never activates on invalid input', async () => {
  const state = setup();
  await assert.rejects(issueReactivation({ ...state, user, now, sendEmail: async () => { throw new Error('mail unavailable'); } }), /mail unavailable/);
  assert.equal(state.active, false);
  assert.equal(await redeemReactivation({ token: '../invalid', repository: state.repository, now }), false);
  await assert.rejects(issueReactivation({ ...state, user, now, repository: {
    replaceTokenForDeactivatedAccount: async () => { throw new Error('database unavailable'); }
  } }), /database unavailable/);
});

test('repository performs conditional token replacement and single-statement redemption', async () => {
  const calls = [];
  let result = { data: { user_id: userId }, error: null };
  const query = {
    update(value) { calls.push(['update', value]); return this; },
    delete() { calls.push(['delete']); return this; },
    eq(key, value) { calls.push(['eq', key, value]); return this; },
    gt(key, value) { calls.push(['gt', key, value]); return this; },
    select(key) { calls.push(['select', key]); return this; },
    async maybeSingle() { return result; }
  };
  const repository = createAccountLifecycleRepository({
    from(table) { calls.push(['from', table]); return query; }
  });
  assert.equal(await repository.replaceTokenForDeactivatedAccount(userId, 'hash', 'expires'), true);
  assert.deepEqual(calls, [
    ['from', 'account_lifecycle'], ['update', { activation_token_hash: 'hash', activation_expires_at: 'expires' }],
    ['eq', 'user_id', userId], ['eq', 'state', 'deactivated'], ['select', 'user_id']
  ]);
  calls.length = 0;
  assert.equal(await repository.consumeTokenAndActivate('hash', 'now'), true);
  assert.deepEqual(calls, [
    ['from', 'account_lifecycle'], ['delete'], ['eq', 'state', 'deactivated'],
    ['eq', 'activation_token_hash', 'hash'], ['gt', 'activation_expires_at', 'now'], ['select', 'user_id']
  ]);
  result = { data: null, error: null };
  assert.equal(await repository.consumeTokenAndActivate('hash', 'now'), false);
  result = { data: null, error: new Error('database unavailable') };
  await assert.rejects(repository.consumeTokenAndActivate('hash', 'now'), /database unavailable/);
});

test('deactivation start uses the transaction-level barrier and validates its response', async () => {
  const calls = [];
  let result = true;
  const repository = createAccountLifecycleRepository({
    async rpc(name, args) {
      calls.push([name, args]);
      return result === 'error'
        ? { data: null, error: new Error('database unavailable') }
        : { data: result, error: null };
    }
  });
  assert.equal(await repository.beginDeactivation(userId), true);
  assert.deepEqual(calls, [['begin_account_deactivation', { p_user_id: userId }]]);
  result = false;
  assert.equal(await repository.beginDeactivation(userId), false);
  result = null;
  await assert.rejects(repository.beginDeactivation(userId), /Invalid account lifecycle transition response/);
  result = 'error';
  await assert.rejects(repository.beginDeactivation(userId), /database unavailable/);
});

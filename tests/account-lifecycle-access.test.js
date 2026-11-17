const assert = require('node:assert/strict');
const test = require('node:test');

let accountIsActive, inactiveAccountIds;
test.before(async () => {
  ({ accountIsActive, inactiveAccountIds } = await import('../supabase/functions/vynzo-api/account-lifecycle-access.mjs'));
});

test('batch lifecycle lookups deduplicate IDs, paginate and fail closed', async () => {
  const calls = [];
  let mode = 'ok';
  const admin = { from(table) {
    assert.equal(table, 'account_lifecycle');
    return {
      select(field) { assert.equal(field, 'user_id'); return this; },
      async in(field, ids) {
        assert.equal(field, 'user_id');
        calls.push(ids);
        if (mode === 'error') return { data: null, error: new Error('database unavailable') };
        if (mode === 'malformed') return { data: null, error: null };
        if (mode === 'unexpected') return { data: [{ user_id: 'unexpected' }], error: null };
        return { data: ids.filter(id => Number(id) % 2 === 0).map(user_id => ({ user_id })), error: null };
      }
    };
  } };
  const ids = Array.from({ length: 205 }, (_, i) => String(i));
  const inactive = await inactiveAccountIds(admin, [...ids, '0']);
  assert.deepEqual(calls.map(batch => batch.length), [100, 100, 5]);
  assert.equal(inactive.size, 103);
  assert.equal(inactive.has('204'), true);
  assert.equal(inactive.has('203'), false);
  calls.length = 0;
  assert.equal((await inactiveAccountIds(admin, [])).size, 0);
  assert.equal(calls.length, 0);
  for (const [failure, message] of [
    ['error', /database unavailable/], ['malformed', /Invalid account lifecycle response/],
    ['unexpected', /Invalid account lifecycle entry/]
  ]) {
    mode = failure;
    await assert.rejects(inactiveAccountIds(admin, ['0']), message);
  }
});

test('only accounts without a lifecycle restriction are active', async () => {
  let result = { data: null, error: null };
  let deletionResult = { data: null, error: null };
  const admin = { from(table) {
    assert.ok(['account_lifecycle', 'account_deletion_tombstones'].includes(table));
    return {
      select(field) {
        assert.equal(field, table === 'account_lifecycle' ? 'state' : 'user_id');
        return this;
      },
      eq(field, id) { assert.equal(field, 'user_id'); assert.equal(id, 'user'); return this; },
      async maybeSingle() { return table === 'account_lifecycle' ? result : deletionResult; }
    };
  } };
  assert.equal(await accountIsActive(admin, 'user'), true);
  for (const state of ['deactivating', 'deactivated', 'deleting']) {
    result = { data: { state }, error: null };
    assert.equal(await accountIsActive(admin, 'user'), false);
  }
  result = { data: null, error: null };
  deletionResult = { data: { user_id: 'user' }, error: null };
  assert.equal(await accountIsActive(admin, 'user'), false);
  deletionResult = { data: null, error: new Error('tombstone lookup failed') };
  await assert.rejects(accountIsActive(admin, 'user'), /tombstone lookup failed/);
  deletionResult = { data: null, error: null };
  result = { data: null, error: new Error('database unavailable') };
  await assert.rejects(accountIsActive(admin, 'user'), /database unavailable/);
});

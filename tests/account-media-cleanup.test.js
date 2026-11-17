const assert = require('node:assert/strict');
const test = require('node:test');

const userId = 'c86cf40c-d629-4d7a-919f-4d2055498f90';
const otherId = '83ea2611-2df6-49fc-bcbd-f686b1fc2e19';
let deleteAccountMedia;
let worker;
test.before(async () => {
  ({ deleteAccountMedia } = await import('../workers/media/account-cleanup.mjs'));
  ({ default: worker } = await import('../workers/media/index.mjs'));
});

test('account media deletion is available only through the authenticated control operation', async () => {
  const { webcrypto } = require('node:crypto');
  global.crypto = webcrypto;
  const secret = 'test-secret-with-at-least-thirty-two-characters';
  const calls = [];
  const env = {
    MEDIA_CONTROL_SECRET: secret,
    MEDIA: {
      async list(options) { calls.push(options.prefix); return { objects: [], truncated: false }; },
      async delete() { assert.fail('no files should be deleted'); }
    }
  };
  const request = token => new Request('https://media.example/internal/delete-account-media', {
    method: 'POST', headers: { 'X-Media-Control': token }, body: JSON.stringify({ userId })
  });
  assert.equal((await worker.fetch(request('wrong-secret'), env)).status, 401);
  assert.deepEqual(calls, []);
  const result = await worker.fetch(request(secret), env);
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [
    `media/post/${userId}/`, `media/story/${userId}/`,
    `staging/post/${userId}/`, `staging/story/${userId}/`,
    `media/post/${userId}/`, `media/story/${userId}/`,
    `staging/post/${userId}/`, `staging/story/${userId}/`
  ]);
});

test('removes only the specified account media and staged uploads across pages', async () => {
  const keys = new Set([
    `media/post/${userId}/a/original`,
    `media/post/${userId}/b/playback`,
    `media/story/${userId}/c/cover`,
    `staging/post/${userId}/d/original`,
    `staging/story/${userId}/e/original`,
    `media/post/${otherId}/a/original`
  ]);
  const bucket = {
    async list({ prefix, cursor }) {
      const matching = [...keys].filter(key => key.startsWith(prefix) && (!cursor || key > cursor)).sort();
      const objects = matching.slice(0, 1).map(key => ({ key }));
      return { objects, truncated: matching.length > 1, cursor: matching.length > 1 ? objects[0].key : undefined };
    },
    async delete(paths) { for (const path of paths) keys.delete(path); }
  };
  await deleteAccountMedia(bucket, userId);
  assert.deepEqual([...keys], [`media/post/${otherId}/a/original`]);
});

test('rejects invalid identifiers and unrelated listing entries without deleting them', async () => {
  const removed = [];
  const bucket = {
    async list() { return { objects: [{ key: `media/post/${otherId}/a/original` }], truncated: false }; },
    async delete(paths) { removed.push(...paths); }
  };
  await assert.rejects(deleteAccountMedia(bucket, '../other'), /Invalid account identifier/);
  await assert.rejects(deleteAccountMedia(bucket, userId), /unrelated object/);
  assert.deepEqual(removed, []);
});

test('surfaces storage failures and invalid pagination', async () => {
  const bucket = {
    async list() { return { objects: [], truncated: true }; },
    async delete() { assert.fail('invalid pagination must not delete'); }
  };
  await assert.rejects(deleteAccountMedia(bucket, userId), /cursor did not advance/);
  bucket.list = async ({ prefix }) => ({ objects: [{ key: `${prefix}a` }], truncated: false });
  bucket.delete = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(deleteAccountMedia(bucket, userId), /storage unavailable/);
});

test('does not report success when media storage leaves an object behind', async () => {
  const bucket = {
    async list({ prefix }) { return { objects: [{ key: `${prefix}a` }], truncated: false }; },
    async delete() {}
  };
  await assert.rejects(deleteAccountMedia(bucket, userId), /cleanup is incomplete/);
});

test('detects an object appearing in an earlier prefix during cleanup', async () => {
  const keys = new Set();
  const bucket = {
    async list({ prefix }) {
      if (prefix === `staging/story/${userId}/`) keys.add(`media/post/${userId}/late`);
      return {
        objects: [...keys].filter(key => key.startsWith(prefix)).map(key => ({ key })),
        truncated: false
      };
    },
    async delete(paths) { for (const path of paths) keys.delete(path); }
  };
  await assert.rejects(deleteAccountMedia(bucket, userId), /cleanup is incomplete/);
});

test('rejects pagination cycles and repeated object entries', async () => {
  let call = 0;
  const bucket = {
    async list() {
      call++;
      return { objects: [], truncated: true, cursor: call % 2 ? 'one' : 'two' };
    },
    async delete() { assert.fail('no files should be deleted'); }
  };
  await assert.rejects(deleteAccountMedia(bucket, userId), /cursor did not advance/);
  assert.equal(call, 3);
  bucket.list = async ({ prefix }) => ({ objects: [{ key: `${prefix}a` }, { key: `${prefix}a` }], truncated: false });
  await assert.rejects(deleteAccountMedia(bucket, userId), /repeated an object/);
});

const assert = require('node:assert/strict');
const test = require('node:test');

const userId = 'c86cf40c-d629-4d7a-919f-4d2055498f90';
const otherId = '83ea2611-2df6-49fc-bcbd-f686b1fc2e19';
let deleteAccountStorage;
test.before(async () => {
  ({ deleteAccountStorage } = await import('../supabase/functions/vynzo-api/account-storage.mjs'));
});

function fakeStorage(initial) {
  const files = Object.fromEntries(Object.entries(initial).map(([key, value]) => [key, new Set(value)]));
  return {
    files,
    from(name) {
      return {
        async list(folder, { limit, offset }) {
          const children = new Map();
          for (const path of files[name]) {
            if (!path.startsWith(`${folder}/`)) continue;
            const rest = path.slice(folder.length + 1);
            const [child, ...nested] = rest.split('/');
            children.set(child, { name: child, id: nested.length ? null : `id-${child}` });
          }
          return { data: [...children.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(offset, offset + limit), error: null };
        },
        async remove(paths) {
          for (const path of paths) files[name].delete(path);
          return { error: null };
        }
      };
    }
  };
}

test('removes nested uploads, blog assets and view-once files only for the chosen account', async () => {
  const uploads = [
    ...Array.from({ length: 205 }, (_, i) => `${userId}/avatars/${i}.jpg`),
    `${userId}/messages/conversation/audio.m4a`,
    `blogs/${userId}/cover.jpg`,
    `${otherId}/photo.jpg`,
    `blogs/${otherId}/cover.jpg`
  ];
  const storage = fakeStorage({
    uploads,
    'view-once': [`${userId}/conversation/photo.jpg`, `${otherId}/photo.jpg`]
  });
  await deleteAccountStorage(storage, userId);
  assert.deepEqual([...storage.files.uploads].sort(), [`${otherId}/photo.jpg`, `blogs/${otherId}/cover.jpg`].sort());
  assert.deepEqual([...storage.files['view-once']], [`${otherId}/photo.jpg`]);
});

test('rejects invalid accounts and unexpected listing entries', async () => {
  let removed = false;
  const storage = { from: () => ({
    list: async () => ({ data: [{ id: 'id', name: '../other' }], error: null }),
    remove: async () => { removed = true; return { error: null }; }
  }) };
  await assert.rejects(deleteAccountStorage(storage, '../other'), /Invalid account identifier/);
  await assert.rejects(deleteAccountStorage(storage, userId), /Invalid storage object name/);
  assert.equal(removed, false);
});

test('fails explicitly when listing or deletion fails', async () => {
  const storage = { from: () => ({
    list: async () => ({ data: null, error: new Error('listing unavailable') }),
    remove: async () => assert.fail('must not delete on listing failure')
  }) };
  await assert.rejects(deleteAccountStorage(storage, userId), /listing unavailable/);
  storage.from = () => ({
    list: async () => ({ data: [{ id: 'file-id', name: 'file.jpg' }], error: null }),
    remove: async () => ({ error: new Error('delete unavailable') })
  });
  await assert.rejects(deleteAccountStorage(storage, userId), /delete unavailable/);
});

test('does not report success when storage leaves an object behind', async () => {
  const storage = fakeStorage({
    uploads: [`${userId}/photo.jpg`],
    'view-once': []
  });
  const from = storage.from;
  storage.from = name => {
    const bucket = from(name);
    bucket.remove = async () => ({ error: null });
    return bucket;
  };
  await assert.rejects(deleteAccountStorage(storage, userId), /cleanup is incomplete/);
  assert.deepEqual([...storage.files.uploads], [`${userId}/photo.jpg`]);
});

test('detects an object appearing in an earlier root during cleanup', async () => {
  const storage = fakeStorage({ uploads: [], 'view-once': [] });
  const from = storage.from;
  storage.from = name => {
    const bucket = from(name);
    const list = bucket.list;
    bucket.list = async (folder, options) => {
      if (name === 'view-once' && folder === userId) {
        storage.files.uploads.add(`${userId}/late.jpg`);
      }
      return list(folder, options);
    };
    return bucket;
  };
  await assert.rejects(deleteAccountStorage(storage, userId), /cleanup is incomplete/);
});

test('rejects repeated storage pages before deleting anything', async () => {
  let removed = false;
  const storage = { from: () => ({
    list: async () => ({ data: Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}`, name: `${i}.jpg` })), error: null }),
    remove: async () => { removed = true; return { error: null }; }
  }) };
  await assert.rejects(deleteAccountStorage(storage, userId), /repeated an entry/);
  assert.equal(removed, false);
});

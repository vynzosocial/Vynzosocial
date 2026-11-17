const assert = require('node:assert/strict');
const test = require('node:test');

const userId = 'c86cf40c-d629-4d7a-919f-4d2055498f90';
const otherId = '83ea2611-2df6-49fc-bcbd-f686b1fc2e19';
const storageOrigin = 'https://storage.example';
const prefix = `${storageOrigin}/storage/v1/object/public/uploads/`;
let inventoryLegacyRootMedia;
test.before(async () => {
  ({ inventoryLegacyRootMedia } = await import('../supabase/functions/vynzo-api/legacy-storage-inventory.mjs'));
});

test('identifies exclusively referenced and shared legacy root objects', () => {
  const references = [
    { ownerId: userId, url: `${prefix}photo%20one.jpg` },
    { ownerId: userId, url: '/uploads/shared.png' },
    { ownerId: otherId, url: `${prefix}shared.png` },
    { ownerId: otherId, url: `${prefix}other.png` },
    { ownerId: userId, url: `${prefix}${userId}/photo.jpg` },
    { ownerId: userId, url: 'https://other.example/storage/v1/object/public/uploads/external.jpg' }
  ];
  assert.deepEqual(inventoryLegacyRootMedia({ userId, storageOrigin, references }), {
    exclusive: ['photo one.jpg'],
    shared: ['shared.png']
  });
});

test('rejects invalid input and malformed encoding rather than inventing ownership', () => {
  const input = { userId, storageOrigin, references: [] };
  assert.throws(() => inventoryLegacyRootMedia({ ...input, userId: 'invalid' }), /account identifier/);
  assert.throws(() => inventoryLegacyRootMedia({ ...input, storageOrigin: 'https://storage.example/path' }), /storage origin/);
  assert.throws(() => inventoryLegacyRootMedia({ ...input, references: [{ ownerId: 'invalid', url: '/uploads/a.jpg' }] }), /media reference/);
  assert.throws(() => inventoryLegacyRootMedia({ ...input, references: [{ ownerId: userId, url: '/uploads/%zz' }] }), /storage path/);
});

test('does not treat directories, traversal or untrusted hosts as root objects', () => {
  const references = [
    '/uploads/%2e%2e',
    '/uploads/%2fother.jpg',
    '/uploads/%5cother.jpg',
    '/uploads/name%00.jpg',
    `${prefix}blogs%2fother.jpg`,
    `https://storage.example.evil.invalid/storage/v1/object/public/uploads/a.jpg`
  ].map(url => ({ ownerId: userId, url }));
  assert.deepEqual(inventoryLegacyRootMedia({ userId, storageOrigin, references }), { exclusive: [], shared: [] });
});

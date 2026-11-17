const assert = require('node:assert/strict');
const test = require('node:test');

const viewerId = 'c86cf40c-d629-4d7a-919f-4d2055498f90';
const otherId = '69de86de-e2b4-40ed-bff9-27747d20b60c';
const storageOrigin = 'https://storage.example';
const workerUrl = 'https://media.example';
const secret = 'test-secret-with-at-least-thirty-two-characters';

test('saving blog delivery URLs restores durable references even after display permits expire', async () => {
  const { createLegacyFileDeliveryPermit } = await import('../supabase/functions/vynzo-api/media-permits.mjs');
  const { restoreBlogMediaReferences } = await import('../supabase/functions/vynzo-api/legacy-blog-media.mjs');
  const path = `blogs/${viewerId}/image.webp`;
  const permit = await createLegacyFileDeliveryPermit({ viewerId, userId: viewerId, path, scope: 'blog-upload', secret, now: 1 });
  const url = `${workerUrl}/media?permit=${permit}`;
  const canonical = `${storageOrigin}/storage/v1/object/public/uploads/${path}`;
  const config = { viewerId, workerUrl, storageOrigin, secret };
  assert.equal(await restoreBlogMediaReferences(url, config), canonical);
  assert.equal(await restoreBlogMediaReferences(`<img src="${url}">`, config), `<img src="${canonical}">`);
  assert.equal(await restoreBlogMediaReferences(canonical, config), canonical);
  await assert.rejects(restoreBlogMediaReferences(url, { ...config, viewerId: otherId }), /Invalid blog media reference/);
  await assert.rejects(restoreBlogMediaReferences(url, { ...config, secret: 'different-secret-with-at-least-thirty-two-characters' }), /Invalid blog media reference/);
});

test('moderation downloads private blog images without using public or delivery URLs', async () => {
  const { privateBlogImages } = await import('../supabase/functions/vynzo-api/legacy-blog-media.mjs');
  let downloaded;
  const admin = { storage: { from: name => {
    assert.equal(name, 'uploads');
    return { download: async path => {
      downloaded = path;
      return { data: new Blob(['image'], { type: 'image/webp' }), error: null };
    } };
  } } };
  const path = `blogs/${viewerId}/image.webp`;
  assert.deepEqual(await privateBlogImages(admin, [`${storageOrigin}/storage/v1/object/public/uploads/${path}`], storageOrigin),
    [`data:image/webp;base64,${Buffer.from('image').toString('base64')}`]);
  assert.equal(downloaded, path);
  const unavailable = { storage: { from: () => ({ download: async () => ({ error: new Error('Storage unavailable') }) }) } };
  await assert.rejects(privateBlogImages(unavailable, [`${storageOrigin}/storage/v1/object/public/uploads/${path}`], storageOrigin), /Storage unavailable/);
});

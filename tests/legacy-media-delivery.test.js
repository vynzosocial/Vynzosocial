const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const test = require('node:test');

const userId = 'c86cf40c-d629-4d7a-919f-4d2055498f90';
const viewerId = '69de86de-e2b4-40ed-bff9-27747d20b60c';
const itemId = '83ea2611-2df6-49fc-bcbd-f686b1fc2e19';
const origin = 'https://storage.example';
const secret = 'test-secret-with-at-least-thirty-two-characters';
const claims = { storage: 'legacy', kind: 'post', userId, viewerId, itemId, uploadId: itemId, variant: 'playback' };
const item = { id: itemId, user_id: userId, media_type: 'image', media_url: `${origin}/storage/v1/object/public/uploads/${userId}/photo.jpg` };
let legacyStoragePath, readAuthorizedLegacyMedia, createDeliveryPermit, worker;
test.before(async () => {
  global.crypto = webcrypto;
  ({ legacyStoragePath, readAuthorizedLegacyMedia } = await import('../supabase/functions/vynzo-api/legacy-media-delivery.mjs'));
  ({ createDeliveryPermit } = await import('../supabase/functions/vynzo-api/media-permits.mjs'));
  ({ default: worker } = await import('../workers/media/index.mjs'));
});

test('accepts only safe paths on the configured storage origin', () => {
  assert.equal(legacyStoragePath(item.media_url, origin), `${userId}/photo.jpg`);
  assert.equal(legacyStoragePath('/uploads/old%20photo.jpg', origin), 'old photo.jpg');
  for (const url of [
    'https://evil.example/storage/v1/object/public/uploads/photo.jpg',
    `${origin}/storage/v1/object/public/uploads/%2fphoto.jpg`,
    '/uploads/%2e%2e/photo.jpg', '/uploads/%5cphoto.jpg', '/uploads/%zz'
  ]) assert.equal(legacyStoragePath(url, origin), null);
});

test('rechecks item ownership and viewer visibility before issuing a private read', async () => {
  let visible = true;
  let signed = 0;
  const bucket = { async createSignedUrl(path, seconds) {
    signed++;
    assert.equal(path, `${userId}/photo.jpg`);
    assert.equal(seconds, 60);
    return { data: { signedUrl: `${origin}/storage/v1/object/sign/uploads/${path}?token=internal` }, error: null };
  } };
  const options = {
    claims, origin, range: 'bytes=1-2', bucket,
    getPostContext: async (id, viewer) => {
      assert.equal(id, itemId);
      assert.equal(viewer, viewerId);
      return visible ? { post: item } : null;
    },
    getStoryContext: () => assert.fail('wrong kind'),
    fetchMedia: async (_url, init) => {
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.Range, 'bytes=1-2');
      return new Response('bc', { status: 206, headers: { 'Content-Type': 'image/jpeg', 'Content-Range': 'bytes 1-2/3' } });
    }
  };
  const result = await readAuthorizedLegacyMedia(options);
  assert.equal(result.status, 206);
  assert.equal(await result.response.text(), 'bc');
  visible = false;
  assert.equal((await readAuthorizedLegacyMedia(options)).status, 403);
  assert.equal(signed, 1);
  assert.equal((await readAuthorizedLegacyMedia({ ...options, claims: { ...claims, userId: viewerId } })).status, 403);
  assert.equal((await readAuthorizedLegacyMedia({ ...options, claims: { ...claims, variant: 'original' } })).status, 400);
  visible = true;
  assert.equal((await readAuthorizedLegacyMedia({
    ...options, getPostContext: async () => ({ post: { ...item, media_url: `${origin}/storage/v1/object/public/uploads/${viewerId}/other.jpg` } })
  })).status, 403);
  await assert.rejects(readAuthorizedLegacyMedia({
    ...options, getPostContext: async () => ({ post: { ...item, media_type: 'video' } })
  }), /unsupported media type/);
});

test('worker proxies a signed legacy permit, ranges and authorization failures without exposing the storage URL', async () => {
  const token = await createDeliveryPermit({ ...claims, secret });
  const originalFetch = global.fetch;
  const env = {
    MEDIA: {}, DELIVERY_SECRET: secret, MEDIA_AUTH_URL: 'https://api.example/authorize',
    MEDIA_AUTH_KEY: 'public-key', MEDIA_CONTROL_SECRET: secret
  };
  try {
    let allowed = true;
    global.fetch = async (url, init) => {
      assert.equal(url, env.MEDIA_AUTH_URL);
      assert.equal(init.headers.Range, 'bytes=1-2');
      assert.equal(JSON.parse(init.body).storage, 'legacy');
      return allowed
        ? new Response('bc', { status: 206, headers: { 'Content-Type': 'image/jpeg', 'Content-Range': 'bytes 1-2/3', 'Content-Length': '2' } })
        : new Response(null, { status: 403 });
    };
    const request = new Request(`https://media.example/media?permit=${token}`, { headers: { Range: 'bytes=1-2' } });
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('content-range'), 'bytes 1-2/3');
    assert.equal(await response.text(), 'bc');
    allowed = false;
    assert.equal((await worker.fetch(request, env)).status, 403);
    assert.equal((await worker.fetch(new Request(`https://media.example/media?permit=${token}x`), env)).status, 401);
  } finally { global.fetch = originalFetch; }
});

test('legacy file reads validate ownership, reauthorize each request and preserve ranges', async () => {
  const { readAuthorizedLegacyFile } = await import('../supabase/functions/vynzo-api/legacy-media-delivery.mjs');
  const claims = {
    storage: 'legacy-file',
    kind: 'file',
    scope: 'message',
    variant: 'playback',
    viewerId,
    itemId,
    userId,
    uploadId: userId,
    path: `${userId}/messages/${itemId}/voice.webm`
  };
  let allowed = true;
  let signed = 0;
  const bucket = {
    async createSignedUrl(path, expires) {
      signed++;
      assert.equal(path, claims.path);
      assert.equal(expires, 60);
      return {
        data: { signedUrl: `${origin}/storage/v1/object/sign/uploads/${path}?token=internal` },
        error: null
      };
    }
  };
  const options = {
    claims,
    origin,
    bucket,
    range: 'bytes=2-4',
    authorize: async value => {
      assert.equal(value.viewerId, viewerId);
      return allowed;
    },
    fetchMedia: async (_url, init) => {
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.Range, 'bytes=2-4');
      return new Response('ice', { status: 206, headers: { 'Content-Type': 'audio/webm' } });
    }
  };
  const result = await readAuthorizedLegacyFile(options);
  assert.equal(result.status, 206);
  assert.equal(await result.response.text(), 'ice');
  allowed = false;
  assert.equal((await readAuthorizedLegacyFile(options)).status, 403);
  assert.equal(signed, 1);
  assert.equal((await readAuthorizedLegacyFile({
    ...options,
    claims: { ...claims, path: `${viewerId}/messages/${itemId}/voice.webm` }
  })).status, 400);
});

const assert = require('node:assert/strict');
const { webcrypto, createHmac } = require('node:crypto');
const test = require('node:test');

global.crypto = webcrypto;
const secret = 'test-secret-with-at-least-thirty-two-characters';
const userId = 'c86cf40c-d629-4d7a-919f-4d2055498f90';
const uploadId = '83ea2611-2df6-49fc-bcbd-f686b1fc2e19';
const now = () => Math.floor(Date.now() / 1000);
const makeClaims = overrides => ({
  userId, uploadId, kind: 'post', variant: 'original',
  contentType: 'image/jpeg', size: 4, expires: now() + 300, ...overrides
});
function permit(claims) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
function makeRequest(claims, options = {}) {
  return new Request('https://media.example/stage', {
    method: 'PUT',
    headers: {
      'Content-Length': String(claims.size),
      'Content-Type': claims.contentType,
      'X-Upload-Permit': options.token || permit(claims),
      ...(options.headers || {})
    },
    body: 'test'
  });
}
function bucket() {
  const data = new Map();
  return {
    data,
    async put(key, body, options) {
      if (data.has(key)) return null;
      data.set(key, { value: await new Response(body).text(), options });
      return { key };
    },
    async head(key) {
      const item = data.get(key);
      return item && { size: Buffer.byteLength(item.value), httpMetadata: item.options.httpMetadata };
    },
    async get(key, options) {
      const item = data.get(key);
      return item && {
        size: Buffer.byteLength(item.value), httpMetadata: item.options.httpMetadata,
        body: new Response(options?.range
          ? item.value.slice(options.range.offset, options.range.offset + options.range.length)
          : item.value).body
      };
    },
    async delete(keys) {
      for (const key of keys) data.delete(key);
    }
  };
}
let worker;
let reconcileMedia;
let removeExpiredStaging;
let createUploadPermits;
let createDeliveryPermit;
test.before(async () => {
  ({ default: worker, reconcileMedia, removeExpiredStaging } = await import('../workers/media/index.mjs'));
  ({ createUploadPermits, createDeliveryPermit } = await import('../supabase/functions/vynzo-api/media-permits.mjs'));
});

test('stores a permitted upload under its account-scoped staging key and rejects replay', async () => {
  const MEDIA = bucket();
  const env = { MEDIA, UPLOAD_PERMIT_SECRET: secret };
  const claims = makeClaims();
  assert.equal((await worker.fetch(makeRequest(claims), env)).status, 201);
  const stored = MEDIA.data.get(`staging/post/${userId}/${uploadId}/original`);
  assert.equal(stored.value, 'test');
  assert.equal(stored.options.onlyIf.get('if-none-match'), '*');
  assert.equal((await worker.fetch(makeRequest(claims), env)).status, 409);
});

test('rejects tampered, expired, overly long and incorrectly scoped permits', async () => {
  const env = { MEDIA: bucket(), UPLOAD_PERMIT_SECRET: secret };
  const claims = makeClaims();
  const cases = [
    { claims, token: `${permit(claims)}x` },
    { claims: makeClaims({ expires: now() - 1 }) },
    { claims: makeClaims({ expires: now() + 901 }) },
    { claims: makeClaims({ size: 50 * 1024 * 1024 + 1 }) },
    { claims: makeClaims({ userId: '../../other' }) },
    { claims: makeClaims({ variant: 'playback', contentType: 'image/jpeg' }) }
  ];
  for (const item of cases) {
    assert.equal((await worker.fetch(makeRequest(item.claims, item), env)).status, 401);
  }
  assert.equal(env.MEDIA.data.size, 0);
});

test('rejects mismatched request metadata and disallowed origins', async () => {
  const env = { MEDIA: bucket(), UPLOAD_PERMIT_SECRET: secret };
  const claims = makeClaims();
  assert.equal((await worker.fetch(makeRequest(claims, { headers: { 'Content-Type': 'video/mp4' } }), env)).status, 400);
  assert.equal((await worker.fetch(makeRequest(claims, { headers: { 'Content-Length': '5' } }), env)).status, 400);
  assert.equal((await worker.fetch(makeRequest(claims, { headers: { Origin: 'https://evil.example' } }), env)).status, 403);
  assert.equal(env.MEDIA.data.size, 0);
});

test('fails closed without configuration and does not expose a read endpoint', async () => {
  const env = { MEDIA: bucket(), UPLOAD_PERMIT_SECRET: secret };
  assert.equal((await worker.fetch(makeRequest(makeClaims()), {})).status, 503);
  assert.equal((await worker.fetch(new Request('https://media.example/stage'), env)).status, 404);
});

test('permits issued by the API are accepted by the staging Worker', async () => {
  const upload = await createUploadPermits({
    userId, kind: 'post', original: { contentType: 'image/jpeg', size: 4 }, secret
  });
  const claims = makeClaims({ uploadId: upload.uploadId });
  const env = { MEDIA: bucket(), UPLOAD_PERMIT_SECRET: secret };
  assert.equal((await worker.fetch(makeRequest(claims, { token: upload.permits.original }), env)).status, 201);
  assert.equal(env.MEDIA.data.size, 1);
});

test('requires a valid MP4 playback copy for video and no playback copy for images', async () => {
  const base = { userId, kind: 'story', secret };
  const video = { contentType: 'video/webm', size: 4 };
  await assert.rejects(createUploadPermits({ ...base, original: video }), /playback copy/);
  await assert.rejects(createUploadPermits({
    ...base, original: { contentType: 'image/jpeg', size: 4 }, playback: { contentType: 'video/mp4', size: 4 }
  }), /playback copy/);
  const result = await createUploadPermits({
    ...base, original: video, playback: { contentType: 'video/mp4', size: 4 }
  });
  assert.ok(result.permits.original);
  assert.ok(result.permits.playback);
});

test('only trusted control operations can inspect, promote, read and delete staged media', async () => {
  const MEDIA = bucket();
  const env = { MEDIA, UPLOAD_PERMIT_SECRET: secret, MEDIA_CONTROL_SECRET: secret };
  const claims = makeClaims();
  assert.equal((await worker.fetch(makeRequest(claims), env)).status, 201);
  const ref = { kind: 'post', userId, uploadId };
  const control = (action, body, controlSecret = secret) => worker.fetch(new Request(`https://media.example/internal/${action}`, {
    method: 'POST', headers: { 'X-Media-Control': controlSecret }, body: JSON.stringify(body)
  }), env);
  assert.equal((await control('inspect', ref, 'wrong-control-secret-with-thirty-two-characters')).status, 401);
  const inspected = await control('inspect', ref);
  assert.deepEqual(await inspected.json(), { original: { size: 4, contentType: 'image/jpeg' }, playback: null });
  assert.equal((await control('promote', { ...ref, mediaType: 'image' })).status, 200);
  assert.equal(await (await control('read', { ...ref, prefix: 'media', variant: 'original' })).text(), 'test');
  assert.equal((await control('promote', { ...ref, mediaType: 'image' })).status, 409);
  assert.equal((await control('delete', { ...ref, prefix: 'media' })).status, 200);
  assert.equal((await control('read', { ...ref, prefix: 'media', variant: 'original' })).status, 404);
  assert.equal((await control('delete', { ...ref, prefix: '../media' })).status, 400);
});

test('promotion rejects missing variants and mismatched media types', async () => {
  const MEDIA = bucket();
  const env = { MEDIA, UPLOAD_PERMIT_SECRET: secret, MEDIA_CONTROL_SECRET: secret };
  assert.equal((await worker.fetch(makeRequest(makeClaims()), env)).status, 201);
  const ref = { kind: 'post', userId, uploadId };
  async function promote(mediaType) {
    return worker.fetch(new Request('https://media.example/internal/promote', {
      method: 'POST', headers: { 'X-Media-Control': secret }, body: JSON.stringify({ ...ref, mediaType })
    }), env);
  }
  assert.equal((await promote('video')).status, 404);
  assert.equal((await promote('other')).status, 400);
  assert.equal(MEDIA.data.size, 1);
});

test('delivery rechecks authorization, supports byte ranges and fails closed on revocation', async () => {
  const MEDIA = bucket();
  const env = {
    MEDIA, UPLOAD_PERMIT_SECRET: secret, MEDIA_CONTROL_SECRET: secret, DELIVERY_SECRET: secret,
    MEDIA_AUTH_URL: 'https://auth.example/check', MEDIA_AUTH_KEY: 'test-service-token'
  };
  await worker.fetch(makeRequest(makeClaims()), env);
  const ref = { kind: 'post', userId, uploadId };
  await worker.fetch(new Request('https://media.example/internal/promote', {
    method: 'POST', headers: { 'X-Media-Control': secret }, body: JSON.stringify({ ...ref, mediaType: 'image' })
  }), env);
  const token = await createDeliveryPermit({ ...ref, viewerId: userId, itemId: uploadId, variant: 'original', secret });
  let allowed = true;
  const oldFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, env.MEDIA_AUTH_URL);
    assert.equal(options.headers['X-Media-Control'], secret);
    assert.equal(JSON.parse(options.body).viewerId, userId);
    return Response.json({ allowed, objectVariant: 'original' });
  };
  try {
    const url = `https://media.example/media?permit=${token}`;
    const full = await worker.fetch(new Request(url), env);
    assert.equal(full.status, 200);
    assert.equal(await full.text(), 'test');
    assert.equal(full.headers.get('cache-control'), 'private, no-store');
    const partial = await worker.fetch(new Request(url, { headers: { Range: 'bytes=1-2' } }), env);
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), 'bytes 1-2/4');
    assert.equal(await partial.text(), 'es');
    const suffix = await worker.fetch(new Request(url, { headers: { Range: 'bytes=-2' } }), env);
    assert.equal(await suffix.text(), 'st');
    assert.equal((await worker.fetch(new Request(url, { headers: { Range: 'bytes=5-' } }), env)).status, 416);
    allowed = false;
    assert.equal((await worker.fetch(new Request(url), env)).status, 403);
    assert.equal((await worker.fetch(new Request(`${url}x`), env)).status, 401);
  } finally {
    global.fetch = oldFetch;
  }
});

test('scheduled reconciliation deletes only old references confirmed orphaned', async () => {
  const deleted = [];
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const recent = new Date();
  const MEDIA = {
    async list() {
      return {
        objects: [
          { key: `media/post/${userId}/${uploadId}/original`, uploaded: old },
          { key: `media/post/${userId}/${uploadId}/playback`, uploaded: old },
          { key: `media/story/${userId}/${uploadId}/original`, uploaded: recent }
        ],
        truncated: false
      };
    },
    async delete(keys) { deleted.push(...keys); }
  };
  const env = { MEDIA, MEDIA_CONTROL_SECRET: secret, MEDIA_AUTH_KEY: 'test', MEDIA_RECONCILE_URL: 'https://auth.example/reconcile' };
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.refs.length, 1);
    return Response.json({ orphaned: body.refs });
  };
  try {
    await reconcileMedia(env);
    assert.deepEqual(deleted, [`media/post/${userId}/${uploadId}/original`, `media/post/${userId}/${uploadId}/playback`]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('scheduled reconciliation fails closed when the authorization response is invalid', async () => {
  const deleted = [];
  const MEDIA = {
    async list() {
      return { objects: [{ key: `media/post/${userId}/${uploadId}/original`, uploaded: new Date(0) }], truncated: false };
    },
    async delete(keys) { deleted.push(...keys); }
  };
  const env = { MEDIA, MEDIA_CONTROL_SECRET: secret, MEDIA_AUTH_KEY: 'test', MEDIA_RECONCILE_URL: 'https://auth.example/reconcile' };
  const originalFetch = global.fetch;
  global.fetch = async () => Response.json({ orphaned: [{ kind: 'post', userId, uploadId: userId }] });
  try {
    await assert.rejects(reconcileMedia(env), /invalid reference/);
    assert.deepEqual(deleted, []);
  } finally {
    global.fetch = originalFetch;
  }
});

test('scheduled staging cleanup retains recent uploads and deletes abandoned uploads', async () => {
  const deleted = [];
  const now = Date.now();
  const MEDIA = {
    async list() {
      return {
        objects: [
          { key: 'staging/old', uploaded: new Date(now - 25 * 60 * 60 * 1000) },
          { key: 'staging/recent', uploaded: new Date(now - 60 * 1000) }
        ],
        truncated: false
      };
    },
    async delete(keys) { deleted.push(...keys); }
  };
  await removeExpiredStaging({ MEDIA }, now);
  assert.deepEqual(deleted, ['staging/old']);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const id = 'a4e777de-3d68-4f4e-9e7a-843f3229dabc';
const ownerId = 'b4e777de-3d68-4f4e-9e7a-843f3229dabc';
const owner = { is_private: false, posts_privacy: 'everyone' };

test('public media references enforce privacy, expiry, ownership, type and trusted origins', async () => {
  const { publicMediaReference } = await import('../supabase/functions/public-share-media/media-access.mjs');
  const item = { id, user_id: ownerId, media_type: 'video', privacy: 'everyone', is_protected: false,
    media_url: `r2://story/${ownerId}/${id}`, expires_at: new Date(Date.now() + 60000).toISOString() };
  assert.equal(publicMediaReference(item, owner, 'story', id, 'video').variant, 'playback');
  assert.equal(publicMediaReference(item, { ...owner, is_private: true }, 'story', id, 'video'), null);
  assert.equal(publicMediaReference({ ...item, expires_at: new Date(Date.now() - 1).toISOString() }, owner, 'story', id, 'video'), null);
  assert.equal(publicMediaReference({ ...item, privacy: 'friends' }, owner, 'story', id, 'video'), null);
  assert.equal(publicMediaReference({ ...item, is_protected: true }, owner, 'story', id, 'video'), null);
  assert.equal(publicMediaReference(item, owner, 'story', id, 'image'), null);
  assert.equal(publicMediaReference({ ...item, media_url: `r2://story/${id}/${id}` }, owner, 'story', id, 'video'), null);
  const post = { ...item, media_url: `https://qyfphwrmwvnwsklfsbbo.supabase.co/storage/v1/object/public/uploads/${ownerId}/video.mp4` };
  assert.equal(publicMediaReference(post, owner, 'post', id, 'video').legacyPath, `${ownerId}/video.mp4`);
  assert.equal(publicMediaReference(post, { ...owner, posts_privacy: 'friends' }, 'post', id, 'video'), null);
  assert.equal(publicMediaReference({ ...post, media_url: post.media_url.replace(ownerId, id) }, owner, 'post', id, 'video'), null);
  assert.equal(publicMediaReference({ ...post, media_url: 'https://evil.example/secret' }, owner, 'post', id, 'video'), null);
});

test('legacy public preview reads through a short-lived internal signed URL with range support', async () => {
  const { readLegacyPublicMedia } = await import('../supabase/functions/public-share-media/media-access.mjs');
  const origin = 'https://storage.example';
  const file = `${ownerId}/video.mp4`;
  const bucket = {
    async createSignedUrl(path, seconds) {
      assert.equal(path, file);
      assert.equal(seconds, 60);
      return { data: { signedUrl: `${origin}/storage/v1/object/sign/uploads/${file}?token=internal` }, error: null };
    }
  };
  const response = await readLegacyPublicMedia(bucket, file, origin, 'bytes=1-2', async (url, options) => {
    assert.ok(url.startsWith(`${origin}/storage/v1/object/sign/uploads/`));
    assert.equal(options.headers.Range, 'bytes=1-2');
    assert.equal(options.redirect, 'manual');
    return new Response('bc', { status: 206 });
  });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), 'bc');
  bucket.createSignedUrl = async () => ({ data: { signedUrl: 'https://evil.example/storage/v1/object/sign/uploads/x' }, error: null });
  await assert.rejects(readLegacyPublicMedia(bucket, file, origin, null, () => assert.fail('must not fetch untrusted URL')), /invalid signed media URL/);
  bucket.createSignedUrl = async () => ({ data: null, error: new Error('storage unavailable') });
  await assert.rejects(readLegacyPublicMedia(bucket, file, origin, null), /storage unavailable/);
});

test('public preview endpoint authorizes the owner before reading private legacy media', async () => {
  const { publicMediaReference, readLegacyPublicMedia } = await import('../supabase/functions/public-share-media/media-access.mjs');
  const origin = 'https://qyfphwrmwvnwsklfsbbo.supabase.co';
  const item = {
    id, user_id: ownerId, media_type: 'video', privacy: 'everyone', is_protected: false,
    media_url: `${origin}/storage/v1/object/public/uploads/${ownerId}/video.mp4`
  };
  let visibleOwner = owner;
  let signed = 0;
  let handler;
  const admin = {
    from(table) {
      return { select() { return this; }, eq() { return this; }, async maybeSingle() {
        return { data: table === 'users' ? visibleOwner : item, error: null };
      } };
    },
    storage: { from() { return { async createSignedUrl(file, seconds) {
      signed++;
      assert.equal(file, `${ownerId}/video.mp4`);
      assert.equal(seconds, 60);
      return { data: { signedUrl: `${origin}/storage/v1/object/sign/uploads/${file}?token=internal` }, error: null };
    } }; } }
  };
  const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/public-share-media/index.ts'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace('let response: Response', 'let response')
    .replace('supabaseUrl!', 'supabaseUrl');
  const context = {
    URL, Response, Headers, console,
    createClient: () => admin,
    publicMediaReference,
    readLegacyPublicMedia: (bucket, file, storageOrigin, range) => readLegacyPublicMedia(
      bucket, file, storageOrigin, range,
      async (_url, options) => {
        assert.equal(options.headers.Range, 'bytes=1-2');
        return new Response('bc', { status: 206, headers: {
          'Content-Type': 'video/mp4', 'Content-Range': 'bytes 1-2/3', 'Content-Length': '2'
        } });
      }
    ),
    Deno: { env: { get: key => ({ SUPABASE_URL: origin, SUPABASE_SERVICE_ROLE_KEY: 'test-secret' })[key] }, serve: fn => { handler = fn; } }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const request = new Request(`${origin}/functions/v1/public-share-media?kind=post&id=${id}&type=video`, { headers: { Range: 'bytes=1-2' } });
  const response = await handler(request);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 1-2/3');
  assert.equal(await response.text(), 'bc');
  visibleOwner = { ...owner, posts_privacy: 'friends' };
  assert.equal((await handler(request)).status, 404);
  assert.equal(signed, 1);
});

test('internal media reads support bounded ranges and validate control secret', async () => {
  const { default: worker } = await import('../workers/media/index.mjs');
  const oldCrypto = global.crypto;
  global.crypto = webcrypto;
  const secret = 'control-secret-of-more-than-thirty-two-characters';
  const bytes = Buffer.from('abcdefghij');
  const metadata = { size: bytes.length, httpMetadata: { contentType: 'video/mp4' } };
  const env = { MEDIA_CONTROL_SECRET: secret, MEDIA: {
    async head() { return metadata; },
    async get(_key, options) {
      const range = options?.range;
      return { ...metadata, body: range ? bytes.subarray(range.offset, range.offset + range.length) : bytes };
    }
  } };
  const body = JSON.stringify({ kind: 'story', userId: ownerId, uploadId: id, prefix: 'media', variant: 'playback' });
  const req = (range, key = secret) => new Request('https://media.example/internal/read', {
    method: 'POST', headers: { 'X-Media-Control': key, ...(range ? { Range: range } : {}) }, body
  });
  try {
    const partial = await worker.fetch(req('bytes=2-5'), env);
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await partial.text(), 'cdef');
    assert.equal((await worker.fetch(req('bytes=99-'), env)).status, 416);
    assert.equal((await worker.fetch(req(null, 'wrong'), env)).status, 401);
  } finally { global.crypto = oldCrypto; }
});

test('public gateway forwards range and never converts restricted content into success', async () => {
  const { default: site } = await import('../workers/site/index.mjs');
  const original = global.fetch;
  try {
    let forwarded;
    global.fetch = async (_url, options) => {
      forwarded = options.headers.Range;
      return new Response('abc', { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-2/10', 'Content-Length': '3' } });
    };
    const request = new Request(`https://www.vynzosocial.com/shared-public-media?kind=story&id=${id}&type=video`, { headers: { Range: 'bytes=0-2' } });
    const response = await site.fetch(request, { VYNZO_SUPABASE_PUBLISHABLE_KEY: 'test' });
    assert.equal(forwarded, 'bytes=0-2');
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 0-2/10');
    global.fetch = async () => new Response(null, { status: 404 });
    assert.equal((await site.fetch(request, { VYNZO_SUPABASE_PUBLISHABLE_KEY: 'test' })).status, 404);
    const appRequest = new Request(request.url, { headers: { Origin: 'https://localhost' } });
    const unavailable = await site.fetch(appRequest, { VYNZO_SUPABASE_PUBLISHABLE_KEY: 'test' });
    assert.equal(unavailable.headers.get('access-control-allow-origin'), 'https://localhost');
    const preflight = await site.fetch(new Request(request.url, { method: 'OPTIONS', headers: { Origin: 'https://localhost' } }), {});
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://localhost');
    const hostile = await site.fetch(new Request(request.url, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), {});
    assert.equal(hostile.headers.get('access-control-allow-origin'), null);
  } finally { global.fetch = original; }
});

test('guest share page displays public video without authentication and offers login for restricted content', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/js/shared-media.js'), 'utf8').replace(/^import .*;\r?\n/gm, '');
  async function run(statusCode) {
    const status = {}, login = {}, content = { append(value) { this.media = value; } };
    const elements = { 'shared-status': status, 'shared-login': login, 'shared-content': content };
    let restored = false;
    const context = {
      URL, URLSearchParams, console,
      location: new URL(`https://www.vynzosocial.com/pages/shared-media.html?kind=story&id=${id}&type=video`),
      document: { getElementById: name => elements[name], createElement: tag => ({ tag, addEventListener() {} }) },
      fetch: async () => new Response(null, { status: statusCode }),
      restoreSupabaseSession: async () => { restored = true; },
      localStorage: { getItem: () => null }, shareLoginUrl: () => '/login'
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    await new Promise(resolve => setImmediate(resolve));
    return { status, login, content, restored };
  }
  const publicView = await run(206);
  assert.equal(publicView.content.media.tag, 'video');
  assert.equal(publicView.content.media.controls, true);
  assert.equal(publicView.restored, false);
  const restricted = await run(404);
  assert.equal(restricted.restored, true);
  assert.equal(restricted.login.hidden, false);
  assert.equal(restricted.login.href, '/login');
});

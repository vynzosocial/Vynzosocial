const assert = require('node:assert/strict');
const test = require('node:test');

const id = 'a4e777de-3d68-4f4e-9e7a-843f3229dabc';

test('public previews exclude private, protected, expired and nonpublic content', async () => {
  const { isPublicPreview } = await import('../supabase/functions/vynzo-api/public-preview.mjs');
  const owner = { is_private: false, posts_privacy: 'everyone' };
  const item = { privacy: 'everyone', is_protected: false, expires_at: new Date(Date.now() + 60000).toISOString() };
  assert.equal(isPublicPreview(item, owner, 'post'), true);
  assert.equal(isPublicPreview(item, owner, 'story'), true);
  for (const privacy of ['friends', 'only_me']) {
    assert.equal(isPublicPreview({ ...item, privacy }, owner, 'post'), false);
    assert.equal(isPublicPreview({ ...item, privacy }, owner, 'story'), false);
  }
  assert.equal(isPublicPreview({ ...item, is_protected: true }, owner, 'post'), false);
  assert.equal(isPublicPreview(item, { ...owner, posts_privacy: 'friends' }, 'post'), false);
  assert.equal(isPublicPreview(item, { ...owner, is_private: true }, 'story'), false);
  assert.equal(isPublicPreview({ ...item, expires_at: new Date(Date.now() - 1).toISOString() }, owner, 'story'), false);
  assert.equal(isPublicPreview(item, null, 'post'), false);
});

test('share page points crawlers to same-origin privacy checked preview', async () => {
  const { default: site } = await import('../workers/site/index.mjs');
  const env = { ASSETS: { fetch: async () => new Response('<meta property="og:image" content="https://www.vynzosocial.com/assets/logo.png">') } };
  const result = await site.fetch(new Request(`https://www.vynzosocial.com/pages/shared-media.html?kind=post&id=${id}`), env);
  const html = await result.text();
  assert.match(html, /https:\/\/www\.vynzosocial\.com\/share-preview\?kind=post&amp;id=/);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const alternateHost = await site.fetch(new Request(`https://untrusted.example/pages/shared-media.html?kind=post&id=${id}`), env);
  assert.match(await alternateHost.text(), /https:\/\/www\.vynzosocial\.com\/share-preview/);
  const canonical = await site.fetch(new Request(`https://www.vynzosocial.com/pages/shared-media?kind=post&id=${id}`), env);
  assert.match(await canonical.text(), /https:\/\/www\.vynzosocial\.com\/share-preview/);
});

test('unavailable previews use generic image and failures never reveal media', async () => {
  const { default: site } = await import('../workers/site/index.mjs');
  const original = global.fetch;
  const env = { VYNZO_SUPABASE_PUBLISHABLE_KEY: 'test' };
  try {
    global.fetch = async () => new Response(null, { status: 404 });
    const request = new Request(`https://www.vynzosocial.com/share-preview?kind=post&id=${id}`);
    const fallback = await site.fetch(request, env);
    assert.equal(fallback.status, 302);
    assert.equal(fallback.headers.get('location'), 'https://www.vynzosocial.com/assets/logo.png');
    assert.equal(fallback.headers.get('cache-control'), 'no-store');
    global.fetch = async () => new Response(null, { status: 500 });
    assert.equal((await site.fetch(request, env)).status, 503);
    global.fetch = async () => new Response('bad', { headers: { 'content-type': 'text/html' } });
    assert.equal((await site.fetch(request, env)).status, 502);
    global.fetch = async () => new Response('photo', { headers: { 'content-type': 'image/jpeg' } });
    const image = await site.fetch(request, env);
    assert.equal(image.status, 200);
    assert.equal(await image.text(), 'photo');
    assert.equal(image.headers.get('cache-control'), 'no-store');
    const head = await site.fetch(new Request(request.url, { method: 'HEAD' }), env);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('content-type'), 'image/jpeg');
    assert.equal((await site.fetch(new Request(request.url, { method: 'POST' }), env)).status, 405);
    global.fetch = async () => { throw new Error('offline'); };
    assert.equal((await site.fetch(request, env)).status, 503);
  } finally {
    global.fetch = original;
  }
});

const assert = require('node:assert/strict');
const test = require('node:test');

const id = 'a4e777de-3d68-4f4e-9e7a-843f3229dabc';
const author = 'b4e777de-3d68-4f4e-9e7a-843f3229dabc';
const cover = `https://qyfphwrmwvnwsklfsbbo.supabase.co/storage/v1/object/public/uploads/blogs/${author}/cover.jpg`;

test('only published blogs from public authors expose metadata and safe cover paths', async () => {
  const { publicBlogPreview, publicBlogMediaPaths, rewritePublicBlogMedia } = await import('../supabase/functions/blog-preview/public-blog.mjs');
  const article = { status: 'published', title: 'Title', author_id: author, cover_url: cover };
  assert.deepEqual(publicBlogPreview(article, { is_private: false }), {
    title: 'Title',
    coverPath: `blogs/${author}/cover.jpg`,
    mediaPaths: [`blogs/${author}/cover.jpg`]
  });
  for (const status of ['draft', 'pending', 'in_review', 'rejected', 'removed']) {
    assert.equal(publicBlogPreview({ ...article, status }, { is_private: false }), null);
  }
  assert.equal(publicBlogPreview(article, { is_private: true }), null);
  assert.equal(publicBlogPreview(article, null), null);
  for (const url of [cover.replace(author, id), 'https://evil.example/image.jpg', cover + '?secret=1', '/uploads/old.jpg', null]) {
    assert.equal(publicBlogPreview({ ...article, cover_url: url }, { is_private: false }).coverPath, null);
  }
  const embedded = `https://qyfphwrmwvnwsklfsbbo.supabase.co/storage/v1/object/public/uploads/blogs/${author}/inline.webp`;
  const video = `https://qyfphwrmwvnwsklfsbbo.supabase.co/storage/v1/object/public/uploads/blogs/${author}/clip.mp4`;
  const content = `<p>Text</p><img src="${embedded}"><video controls src="${video}"></video><img src="https://evil.example/file.jpg">`;
  const articleWithMedia = { ...article, id, content_html: content };
  assert.deepEqual(publicBlogMediaPaths(articleWithMedia), [
    `blogs/${author}/cover.jpg`,
    `blogs/${author}/inline.webp`,
    `blogs/${author}/clip.mp4`
  ]);
  const rewritten = rewritePublicBlogMedia(content, articleWithMedia,
    'https://qyfphwrmwvnwsklfsbbo.supabase.co', 'https://example.supabase.co/functions/v1/blog-preview?id=old');
  assert.match(rewritten, /blog-preview\?id=a4e777de-3d68-4f4e-9e7a-843f3229dabc&amp;image=1&amp;asset=blogs%2Fb4e777de-3d68-4f4e-9e7a-843f3229dabc%2Finline.webp/);
  assert.match(rewritten, /asset=blogs%2Fb4e777de-3d68-4f4e-9e7a-843f3229dabc%2Fclip.mp4/);
  assert.match(rewritten, /src="https:\/\/evil\.example\/file\.jpg"/);
  assert.doesNotMatch(rewritten, /storage\/v1\/object\/public\/uploads\/blogs\/.*(?:inline\.webp|clip\.mp4)/);
});

test('blog landing page escapes metadata, opens the correct article, and falls back safely', async () => {
  const { default: site } = await import('../workers/site/index.mjs');
  const original = global.fetch;
  const env = { VYNZO_SUPABASE_PUBLISHABLE_KEY: 'test' };
  const request = new Request(`https://www.vynzosocial.com/share-blog?id=${id}`);
  try {
    global.fetch = async () => Response.json({ title: 'A "title" <test> & more', hasCover: true, content: '<p>Hello</p>', language: 'en' });
    const response = await site.fetch(request, env);
    const html = await response.text();
    assert.match(html, /og:title" content="A &quot;title&quot; &lt;test&gt; &amp; more"/);
    assert.match(html, new RegExp(`/share-blog-cover\\?id=${id}`));
    assert.match(html, new RegExp(`/pages/blogs.html#/a/${id}`));
    assert.match(html, /sandbox srcdoc=/);
    assert.match(html, /&lt;p&gt;Hello&lt;\/p&gt;/);
    assert.doesNotMatch(html, /location\.replace/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    global.fetch = async () => new Response(null, { status: 404 });
    const fallback = await (await site.fetch(request, env)).text();
    assert.match(fallback, /Shared on Vynzo/);
    assert.match(fallback, /assets\/logo.png/);
    assert.equal((await site.fetch(new Request('https://www.vynzosocial.com/share-blog?id=bad'), env)).status, 404);
    global.fetch = async () => new Response('error', { status: 500 });
    assert.equal((await site.fetch(request, env)).status, 503);
  } finally { global.fetch = original; }
});

test('blog cover proxy handles fallback, invalid types, and HEAD', async () => {
  const { default: site } = await import('../workers/site/index.mjs');
  const original = global.fetch;
  const env = { VYNZO_SUPABASE_PUBLISHABLE_KEY: 'test' };
  const url = `https://www.vynzosocial.com/share-blog-cover?id=${id}`;
  try {
    global.fetch = async () => new Response(null, { status: 404 });
    assert.equal((await site.fetch(new Request(url), env)).headers.get('location'), 'https://www.vynzosocial.com/assets/logo.png');
    global.fetch = async () => new Response('bad', { headers: { 'content-type': 'text/html' } });
    assert.equal((await site.fetch(new Request(url), env)).status, 502);
    global.fetch = async () => new Response('image', { headers: { 'content-type': 'image/jpeg' } });
    const head = await site.fetch(new Request(url, { method: 'HEAD' }), env);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('content-type'), 'image/jpeg');
    assert.equal((await site.fetch(new Request(url, { method: 'POST' }), env)).status, 405);
  } finally { global.fetch = original; }
});

test('blog embedded media proxy authenticates upstream and preserves ranges and denials', async () => {
  const { default: site } = await import('../workers/site/index.mjs');
  const original = global.fetch;
  const env = { VYNZO_SUPABASE_PUBLISHABLE_KEY: 'test' };
  const asset = `blogs/${author}/clip.mp4`;
  const url = `https://www.vynzosocial.com/share-blog-media?id=${id}&asset=${encodeURIComponent(asset)}`;
  try {
    global.fetch = async (target, options) => {
      assert.equal(target.origin, 'https://qyfphwrmwvnwsklfsbbo.supabase.co');
      assert.equal(target.searchParams.get('asset'), asset);
      assert.equal(target.searchParams.get('image'), '1');
      assert.equal(options.headers.apikey, 'test');
      assert.equal(options.headers.Range, 'bytes=0-4');
      return new Response('video', { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-4/10' } });
    };
    const response = await site.fetch(new Request(url, { headers: { Range: 'bytes=0-4' } }), env);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), 'bytes 0-4/10');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(await response.text(), 'video');
    global.fetch = async () => new Response(null, { status: 404 });
    assert.equal((await site.fetch(new Request(url), env)).status, 404);
    global.fetch = async () => new Response('bad', { headers: { 'Content-Type': 'text/html' } });
    assert.equal((await site.fetch(new Request(url), env)).status, 502);
    global.fetch = async () => new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */5' } });
    assert.equal((await site.fetch(new Request(url), env)).headers.get('Content-Range'), 'bytes */5');
    assert.equal((await site.fetch(new Request(url, { method: 'POST' }), env)).status, 405);
  } finally { global.fetch = original; }
});

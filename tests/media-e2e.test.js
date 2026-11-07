const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const esbuild = require('esbuild');
const path = require('node:path');
const test = require('node:test');

const userId = 'c86cf40c-d629-4d7a-919f-4d2055498f90';
const viewerId = '69de86de-e2b4-40ed-bff9-27747d20b60c';
const secret = 'test-secret-with-at-least-thirty-two-characters';

test('stages, publishes, serves, revokes and deletes a post through the API and Worker', async () => {
  const { default: worker } = await import('../workers/media/index.mjs');
  const media = new Map();
  const bucket = {
    async put(key, body, options) {
      if (media.has(key)) return null;
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      media.set(key, { bytes, httpMetadata: options.httpMetadata });
      return { key };
    },
    async head(key) {
      const item = media.get(key);
      return item && { size: item.bytes.length, httpMetadata: item.httpMetadata };
    },
    async get(key, options) {
      const item = media.get(key);
      if (!item) return null;
      const range = options?.range;
      const bytes = range ? item.bytes.slice(range.offset, range.offset + range.length) : item.bytes;
      return { size: item.bytes.length, httpMetadata: item.httpMetadata, body: new Response(bytes).body };
    },
    async delete(keys) { for (const key of keys) media.delete(key); }
  };
  const rows = {
    users: [
      { id: userId, username: 'owner', is_private: false, posts_privacy: 'everyone' },
      { id: viewerId, username: 'viewer', is_private: false, posts_privacy: 'everyone' }
    ],
    posts: [], stories: [], follows: [], blocks: [], likes: [], story_likes: [], story_comments: []
  };
  function query(table) {
    let filters = [];
    let operation = 'read';
    let inserted;
    const builder = {
      select() { return this; },
      eq(key, value) { filters.push(row => row[key] === value); return this; },
      neq(key, value) { filters.push(row => row[key] !== value); return this; },
      in(key, values) { filters.push(row => values.includes(row[key])); return this; },
      gt(key, value) { filters.push(row => row[key] > value); return this; },
      or() { return this; },
      order() { return this; },
      range() { return this; },
      insert(value) { operation = 'insert'; inserted = value; return this; },
      delete() { operation = 'delete'; return this; },
      async single() { return execute(true); },
      async maybeSingle() { return execute(true); },
      then(resolve, reject) { return Promise.resolve(execute(false)).then(resolve, reject); }
    };
    function execute(single) {
      const tableRows = rows[table];
      if (!tableRows) throw new Error(`Unexpected table ${table}`);
      if (operation === 'insert') {
        const row = { privacy: 'everyone', created_at: new Date().toISOString(), ...inserted };
        if (tableRows.some(existing => existing.id === row.id)) return { data: null, error: { code: '23505', message: 'duplicate' } };
        tableRows.push(row);
        return { data: row, error: null };
      }
      const matched = tableRows.filter(row => filters.every(filter => filter(row)));
      if (operation === 'delete') {
        for (const row of matched) tableRows.splice(tableRows.indexOf(row), 1);
      }
      return { data: single ? matched[0] || null : matched, error: null };
    }
    return builder;
  }
  const original = { crypto: global.crypto, Deno: global.Deno, fetch: global.fetch };
  let handler;
  global.crypto = webcrypto;
  global.Deno = {
    env: { get: key => ({
      SUPABASE_URL: 'https://api.local', SUPABASE_SERVICE_ROLE_KEY: 'test',
      R2_MEDIA_WORKER_URL: 'https://media.example', R2_UPLOAD_PERMIT_SECRET: secret,
      R2_MEDIA_CONTROL_SECRET: secret, R2_DELIVERY_SECRET: secret, R2_UPLOADS_ENABLED: 'true'
    })[key] },
    serve: callback => { handler = callback; }
  };
  global.__mediaTestClient = {
    from: query,
    auth: { getUser: async token => ({ data: { user: { id: token } }, error: null }) }
  };
  const env = {
    MEDIA: bucket, UPLOAD_PERMIT_SECRET: secret, MEDIA_CONTROL_SECRET: secret, DELIVERY_SECRET: secret,
    MEDIA_AUTH_URL: 'https://api.local/functions/v1/vynzo-api/api/media/authorize', MEDIA_AUTH_KEY: 'test'
  };
  try {
    const build = await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'supabase', 'functions', 'vynzo-api', 'index.ts')],
      bundle: true, write: false, platform: 'neutral', format: 'esm',
      plugins: [{
        name: 'test-dependencies',
        setup(build) {
          build.onResolve({ filter: /^npm:@supabase\/supabase-js/ }, () => ({ path: 'supabase', namespace: 'test' }));
          build.onResolve({ filter: /community-rules\.ts$/ }, () => ({ path: 'rules', namespace: 'test' }));
          build.onResolve({ filter: /media-moderation\.ts$/ }, () => ({ path: 'moderation', namespace: 'test' }));
          build.onResolve({ filter: /blogs\.ts$/ }, () => ({ path: 'blogs', namespace: 'test' }));
          build.onResolve({ filter: /blog-autoreview\.ts$/ }, () => ({ path: 'auto', namespace: 'test' }));
          build.onLoad({ filter: /.*/, namespace: 'test' }, args => ({
            contents: {
              supabase: 'export const createClient = () => globalThis.__mediaTestClient;',
              rules: 'export const GUIDELINES_MESSAGE = ""; export const suspensionMessage = async () => null; export const violatesGuidelines = () => false;',
              moderation: 'export const MEDIA_WARNING = ""; export const scanImages = async () => false; export const toDataUrl = () => "";',
              blogs: 'export const handleBlogs = () => {};',
              auto: 'export const startBlogAutoReview = () => {};'
            }[args.path]
          }));
        }
      }]
    });
    await import(`data:text/javascript;base64,${Buffer.from(build.outputFiles[0].contents).toString('base64')}`);
    global.fetch = async (url, options) => {
      const request = new Request(url, options);
      return new URL(request.url).host === 'media.example'
        ? worker.fetch(request, env)
        : handler(request);
    };
    const api = (route, method, user, body) => handler(new Request(`https://api.local/functions/v1/vynzo-api/api${route}`, {
      method, headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    }));
    const staging = await api('/media/stage', 'POST', userId, {
      kind: 'post', original: { contentType: 'image/jpeg', size: 4 }, playback: null
    });
    assert.equal(staging.status, 200);
    const upload = await staging.json();
    const put = await worker.fetch(new Request('https://media.example/stage', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '4', 'X-Upload-Permit': upload.permits.original },
      body: 'test'
    }), env);
    assert.equal(put.status, 201);
    const published = await api('/media/publish', 'POST', userId, {
      kind: 'post', uploadId: upload.uploadId, mediaType: 'image', protected: false, caption: 'hello'
    });
    assert.equal(published.status, 201);
    assert.equal(rows.posts.length, 1);
    assert.equal(media.has(`media/post/${userId}/${upload.uploadId}/original`), true);
    assert.equal([...media.keys()].some(key => key.startsWith('staging/')), false);
    const feed = await api('/posts/feed?scope=all', 'GET', viewerId);
    assert.equal(feed.status, 200);
    const body = await feed.json();
    assert.equal(body.posts.length, 1);
    const url = body.posts[0].media_url;
    const response = await global.fetch(url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'test');
    assert.equal((await api(`/media/playback?kind=post&id=${upload.uploadId}`, 'GET', viewerId)).status, 200);
    rows.posts[0].privacy = 'only_me';
    assert.equal((await global.fetch(url)).status, 403);
    assert.equal((await api(`/media/playback?kind=post&id=${upload.uploadId}`, 'GET', viewerId)).status, 404);
    const deleted = await api(`/posts/${upload.uploadId}`, 'DELETE', userId);
    assert.equal(deleted.status, 200);
    assert.equal(rows.posts.length, 0);
    assert.equal(media.size, 0);

    const videoStage = await api('/media/stage', 'POST', userId, {
      kind: 'story', original: { contentType: 'video/webm', size: 8 },
      playback: { contentType: 'video/mp4', size: 4 }
    });
    const videoUpload = await videoStage.json();
    assert.equal(videoStage.status, 200);
    for (const [variant, type, content] of [['original', 'video/webm', 'original'], ['playback', 'video/mp4', 'play']]) {
      const staged = await worker.fetch(new Request('https://media.example/stage', {
        method: 'PUT',
        headers: { 'Content-Type': type, 'Content-Length': String(content.length), 'X-Upload-Permit': videoUpload.permits[variant] },
        body: content
      }), env);
      assert.equal(staged.status, 201);
    }
    const storyPublished = await api('/media/publish', 'POST', userId, {
      kind: 'story', uploadId: videoUpload.uploadId, mediaType: 'video', protected: false
    });
    assert.equal(storyPublished.status, 201);
    assert.equal(media.size, 2);
    const storyList = await api('/stories?scope=all', 'GET', viewerId);
    assert.equal(storyList.status, 200);
    const storyUrl = (await storyList.json()).usersWithStories[0].stories[0].media_url;
    assert.equal(await (await global.fetch(storyUrl)).text(), 'play');
    const originalDenied = await api(`/media/original?kind=story&id=${videoUpload.uploadId}`, 'GET', viewerId);
    assert.equal(originalDenied.status, 404);
    const originalResponse = await api(`/media/original?kind=story&id=${videoUpload.uploadId}`, 'GET', userId);
    assert.equal(originalResponse.status, 200);
    assert.equal(await (await global.fetch((await originalResponse.json()).url)).text(), 'original');
    rows.stories[0].expires_at = new Date(Date.now() - 1000).toISOString();
    assert.equal((await global.fetch(storyUrl)).status, 403);
    const ref = { kind: 'story', userId, uploadId: videoUpload.uploadId };
    const reconcileRequest = control => handler(new Request('https://api.local/functions/v1/vynzo-api/api/media/reconcile', {
      method: 'POST', headers: { 'X-Media-Control': control }, body: JSON.stringify({ refs: [ref] })
    }));
    assert.equal((await reconcileRequest('wrong-secret')).status, 401);
    const reconciliation = await reconcileRequest(secret);
    assert.deepEqual((await reconciliation.json()).orphaned, [ref]);
    assert.equal((await api(`/stories/${videoUpload.uploadId}`, 'DELETE', userId)).status, 200);
    assert.equal(media.size, 0);

    const legacyPostId = '971c48cc-4358-4ed1-bafe-27571bedb81a';
    const legacyStoryId = 'dc646b7f-69a7-4879-aebb-55191fce642b';
    const legacyUrl = 'https://storage.example/public/legacy.jpg';
    rows.posts.push({ id: legacyPostId, user_id: userId, media_type: 'image', media_url: legacyUrl, privacy: 'everyone' });
    rows.stories.push({ id: legacyStoryId, user_id: userId, media_type: 'image', media_url: legacyUrl, privacy: 'everyone',
      expires_at: new Date(Date.now() + 60000).toISOString() });
    for (const [kind, id] of [['post', legacyPostId], ['story', legacyStoryId]]) {
      const playback = await api(`/media/playback?kind=${kind}&id=${id}`, 'GET', viewerId);
      assert.equal(playback.status, 200);
      assert.equal((await playback.json()).url, legacyUrl);
      assert.equal((await api(`/media/original?kind=${kind}&id=${id}`, 'GET', userId)).status, 404);
    }
    rows.posts[0].privacy = 'only_me';
    rows.stories[0].expires_at = new Date(Date.now() - 1000).toISOString();
    assert.equal((await api(`/media/playback?kind=post&id=${legacyPostId}`, 'GET', viewerId)).status, 404);
    assert.equal((await api(`/media/playback?kind=story&id=${legacyStoryId}`, 'GET', viewerId)).status, 404);
  } finally {
    global.crypto = original.crypto;
    global.Deno = original.Deno;
    global.fetch = original.fetch;
    delete global.__mediaTestClient;
  }
});

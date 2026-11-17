const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const test = require('node:test');

const viewerId = '69de86de-e2b4-40ed-bff9-27747d20b60c';
const authorId = 'c86cf40c-d629-4d7a-919f-4d2055498f90';
const articleId = '83ea2611-2df6-49fc-bcbd-f686b1fc2e19';
const messageId = 'f7bb1e57-22cf-4e8d-aeb7-23e30a332aed';
const origin = 'https://storage.example';
const secret = 'test-secret-with-at-least-thirty-two-characters';

function decodeClaims(token) {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

test('rewrites legacy upload URLs to viewer-bound, resource-scoped Worker permits', async () => {
  global.crypto = webcrypto;
  const { rewriteLegacyMediaResponse } = await import('../supabase/functions/vynzo-api/legacy-media-response.mjs');
  const articleCover = `${origin}/storage/v1/object/public/uploads/blogs/${authorId}/cover.webp`;
  const articleImage = `${origin}/storage/v1/object/public/uploads/blogs/${authorId}/body.webp`;
  const avatar = `${origin}/storage/v1/object/public/uploads/${authorId}/avatars/current.jpg`;
  const messageMedia = `${origin}/storage/v1/object/public/uploads/${authorId}/messages/conversation/audio.webm`;
  const response = Response.json({
    articles: [{
      id: articleId,
      author_id: authorId,
      cover_url: articleCover,
      content_html: `<p><img src="${articleImage}"></p>`,
      author: { id: authorId, avatar_url: avatar }
    }],
    messages: [{
      id: messageId,
      conversation_id: '8978d19d-2770-44ab-b2bb-93122dbf453b',
      sender_id: authorId,
      media_url: messageMedia
    }]
  });
  const rewritten = await rewriteLegacyMediaResponse({
    response,
    request: new Request('https://api.example/functions/v1/vynzo-api/api/blogs'),
    viewerId,
    enabled: true,
    storageOrigin: origin,
    workerUrl: 'https://media.example',
    secret,
    now: 1000
  });
  const body = await rewritten.json();
  const coverPermit = new URL(body.articles[0].cover_url).searchParams.get('permit');
  const imagePermit = new URL(body.articles[0].content_html.match(/src="([^"]+)/)[1])
    .searchParams.get('permit');
  const avatarPermit = new URL(body.articles[0].author.avatar_url).searchParams.get('permit');
  const messagePermit = new URL(body.messages[0].media_url).searchParams.get('permit');

  assert.equal(rewritten.headers.get('cache-control'), 'no-store');
  assert.equal(decodeClaims(coverPermit).scope, 'blog');
  assert.equal(decodeClaims(coverPermit).resourceId, articleId);
  assert.equal(decodeClaims(imagePermit).scope, 'blog');
  assert.equal(decodeClaims(avatarPermit).scope, 'avatar');
  assert.equal(decodeClaims(messagePermit).scope, 'message');
  assert.equal(decodeClaims(messagePermit).resourceId, messageId);
  for (const token of [coverPermit, imagePermit, avatarPermit, messagePermit]) {
    const claims = decodeClaims(token);
    assert.equal(claims.viewerId, viewerId);
    assert.equal(claims.userId, authorId);
    assert.equal(claims.storage, 'legacy-file');
    assert.equal(claims.expires, 1300);
  }
});

test('conversation previews support flat legacy message filenames with message-bound permits', async () => {
  const { rewriteLegacyMediaResponse } = await import('../supabase/functions/vynzo-api/legacy-media-response.mjs');
  for (const mediaUrl of ['/uploads/old%20voice.webm', `${origin}/storage/v1/object/public/uploads/old%20voice.webm`]) {
    const rewritten = await rewriteLegacyMediaResponse({
      response: Response.json({ conversations: [{
        id: '8978d19d-2770-44ab-b2bb-93122dbf453b',
        other_user_id: authorId,
        other_avatar_url: '/uploads/avatar.jpg',
        last_message: {
          id: messageId,
          sender_id: authorId,
          conversation_id: '8978d19d-2770-44ab-b2bb-93122dbf453b',
          media_url: mediaUrl
        }
      }] }),
      request: new Request('https://api.example/api/messages'),
      viewerId, enabled: true, storageOrigin: origin, workerUrl: 'https://media.example', secret
    });
    assert.equal(rewritten.status, 200);
    const { conversations: [conversation] } = await rewritten.json();
    const claims = decodeClaims(new URL(conversation.last_message.media_url).searchParams.get('permit'));
    assert.equal(claims.path, 'old voice.webm');
    assert.equal(claims.scope, 'message');
    assert.equal(claims.resourceId, messageId);
    assert.equal(claims.userId, authorId);
    assert.equal(claims.viewerId, viewerId);
    const avatar = decodeClaims(new URL(conversation.other_avatar_url).searchParams.get('permit'));
    assert.equal(avatar.scope, 'avatar');
    assert.equal(avatar.userId, authorId);
  }
});

test('message bodies and reply snippets keep legacy links without treating them as attachments', async () => {
  const { rewriteLegacyMediaResponse } = await import('../supabase/functions/vynzo-api/legacy-media-response.mjs');
  const postUrl = `${origin}/storage/v1/object/public/uploads/${authorId}/post.jpg`;
  for (const content of [postUrl, `See this post:\n${postUrl}`, `Local link: /uploads/${authorId}/post.jpg`]) {
    const message = {
      id: messageId,
      sender_id: authorId,
      conversation_id: '8978d19d-2770-44ab-b2bb-93122dbf453b',
      content,
      media_url: `/uploads/${authorId}/messages/conversation/audio.webm`,
      sender_avatar_url: `/uploads/${authorId}/avatars/current.jpg`,
      reply_to: { id: articleId, sender_id: authorId, text: `Shared photo: ${postUrl}` }
    };
    for (const [route, body] of [
      ['/messages', { conversations: [{ last_message: message }] }],
      [`/messages/${message.conversation_id}/messages`, { messages: [message] }]
    ]) {
      const rewritten = await rewriteLegacyMediaResponse({
        response: Response.json(body),
        request: new Request(`https://api.example/api${route}`),
        viewerId, enabled: true, storageOrigin: origin, workerUrl: 'https://media.example', secret
      });
      assert.equal(rewritten.status, 200);
      const result = await rewritten.json();
      const actual = result.messages?.[0] || result.conversations[0].last_message;
      assert.equal(actual.content, content);
      assert.deepEqual(actual.reply_to, message.reply_to);
      const attachment = decodeClaims(new URL(actual.media_url).searchParams.get('permit'));
      assert.equal(attachment.scope, 'message');
      assert.equal(attachment.resourceId, messageId);
      const avatar = decodeClaims(new URL(actual.sender_avatar_url).searchParams.get('permit'));
      assert.equal(avatar.scope, 'avatar');
      assert.equal(avatar.userId, authorId);
    }
  }
});

test('flat message media still requires a specific message resource', async () => {
  const { createLegacyFileDeliveryPermit } = await import('../supabase/functions/vynzo-api/media-permits.mjs');
  await assert.rejects(createLegacyFileDeliveryPermit({
    viewerId, userId: authorId, path: 'old-voice.webm', scope: 'message', secret
  }), /Invalid legacy media reference/);
});

test('flat message attachments remain reauthorized through the Worker before Storage is read', async () => {
  const { createLegacyFileDeliveryPermit } = await import('../supabase/functions/vynzo-api/media-permits.mjs');
  const { readAuthorizedLegacyFile } = await import('../supabase/functions/vynzo-api/legacy-media-delivery.mjs');
  const { default: worker } = await import('../workers/media/index.mjs');
  const permit = await createLegacyFileDeliveryPermit({
    viewerId, userId: authorId, path: 'old-voice.webm',
    scope: 'message', resourceId: messageId, secret
  });
  const originalFetch = global.fetch;
  let allowed = true;
  let reads = 0;
  let checks = 0;
  try {
    global.fetch = async (_url, init) => {
      const result = await readAuthorizedLegacyFile({
        claims: JSON.parse(init.body),
        origin,
        bucket: { createSignedUrl: async path => {
          reads++;
          assert.equal(path, 'old-voice.webm');
          return { data: { signedUrl: `${origin}/storage/v1/object/sign/uploads/${path}?token=internal` } };
        } },
        authorize: async claims => {
          checks++;
          assert.equal(claims.resourceId, messageId);
          assert.equal(claims.userId, authorId);
          assert.equal(claims.viewerId, viewerId);
          return allowed;
        },
        fetchMedia: async () => new Response('voice', { headers: { 'Content-Type': 'audio/webm' } })
      });
      return result.response || new Response(null, { status: result.status });
    };
    const env = {
      DELIVERY_SECRET: secret, MEDIA: {}, MEDIA_AUTH_URL: 'https://api.example/media/authorize',
      MEDIA_AUTH_KEY: 'public-key', MEDIA_CONTROL_SECRET: secret
    };
    const request = new Request(`https://media.example/media?permit=${permit}`);
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'voice');
    allowed = false;
    assert.equal((await worker.fetch(request, env)).status, 403);
    assert.equal(checks, 2);
    assert.equal(reads, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('does not rewrite external URLs, disabled responses, or responses without a viewer', async () => {
  const { rewriteLegacyMediaResponse } = await import('../supabase/functions/vynzo-api/legacy-media-response.mjs');
  const response = Response.json({
    external: 'https://images.example/photo.jpg',
    upload: `${origin}/storage/v1/object/public/uploads/${authorId}/avatars/current.jpg`
  });
  const options = {
    response,
    request: new Request('https://api.example/api/users/me'),
    viewerId,
    enabled: false,
    storageOrigin: origin,
    workerUrl: 'https://media.example',
    secret
  };
  assert.strictEqual(await rewriteLegacyMediaResponse(options), response);
  assert.strictEqual(await rewriteLegacyMediaResponse({ ...options, enabled: true, viewerId: null }), response);
});

test('fails closed when a local upload reference has no safe media scope', async () => {
  global.crypto = webcrypto;
  const { rewriteLegacyMediaResponse } = await import('../supabase/functions/vynzo-api/legacy-media-response.mjs');
  await assert.rejects(rewriteLegacyMediaResponse({
    response: Response.json({ url: `${origin}/storage/v1/object/public/uploads/legacy-file.jpg` }),
    request: new Request('https://api.example/api/unknown'),
    viewerId,
    enabled: true,
    storageOrigin: origin,
    workerUrl: 'https://media.example',
    secret
  }), /no verifiable owner/);
});

test('allows an owner to preview a freshly uploaded blog image before publishing it', async () => {
  global.crypto = webcrypto;
  const { rewriteLegacyMediaResponse } = await import('../supabase/functions/vynzo-api/legacy-media-response.mjs');
  const response = Response.json({
    upload: {
      url: `${origin}/storage/v1/object/public/uploads/blogs/${viewerId}/pending.webp`,
      type: 'image'
    }
  });
  const rewritten = await rewriteLegacyMediaResponse({
    response,
    request: new Request('https://api.example/api/blogs/media'),
    viewerId,
    enabled: true,
    storageOrigin: origin,
    workerUrl: 'https://media.example',
    secret,
    now: 1000
  });
  const body = await rewritten.json();
  const claims = decodeClaims(new URL(body.upload.url).searchParams.get('permit'));
  assert.equal(claims.scope, 'blog-upload');
  assert.equal(claims.viewerId, viewerId);
  assert.equal(claims.userId, viewerId);
});

test('rejects malformed or unowned legacy file permits', async () => {
  global.crypto = webcrypto;
  const { createLegacyFileDeliveryPermit } = await import('../supabase/functions/vynzo-api/media-permits.mjs');
  await assert.rejects(createLegacyFileDeliveryPermit({
    viewerId, userId: authorId, path: '../other.jpg', scope: 'avatar', secret
  }), /Invalid legacy media reference/);
  await assert.rejects(createLegacyFileDeliveryPermit({
    viewerId, userId: authorId, path: `${viewerId}/messages/chat/file.jpg`, scope: 'message', secret
  }), /Invalid legacy media reference/);
});

test('post and story responses keep nested avatars separate and use seconds for expiry', async () => {
  const { rewriteLegacyMediaResponse } = await import('../supabase/functions/vynzo-api/legacy-media-response.mjs');
  for (const route of ['posts/feed', 'stories']) {
    const before = Math.floor(Date.now() / 1000);
    const result = await rewriteLegacyMediaResponse({
      response: Response.json({
        id: articleId, user_id: authorId, media_type: 'image',
        media_url: `${origin}/storage/v1/object/public/uploads/${authorId}/post.jpg`,
        avatar_url: `${origin}/storage/v1/object/public/uploads/${authorId}/avatar.jpg`,
        author: { id: authorId, avatar_url: `${origin}/storage/v1/object/public/uploads/${authorId}/avatar.jpg` }
      }),
      request: new Request(`https://api.example/api/${route}`),
      viewerId, enabled: true, storageOrigin: origin, workerUrl: 'https://media.example', secret
    });

    const body = await result.json();
    for (const url of [body.avatar_url, body.author.avatar_url]) {
      const claims = decodeClaims(new URL(url).searchParams.get('permit'));
      assert.equal(claims.scope, 'avatar');
      assert.equal(claims.userId, authorId);
      assert.ok(claims.expires >= before + 300 && claims.expires <= Math.floor(Date.now() / 1000) + 300);
    }
    assert.equal(decodeClaims(new URL(body.media_url).searchParams.get('permit')).storage, 'legacy');
  }
});

test('activity previews bind media to the target and avatars to the actor', async () => {
  const { rewriteLegacyMediaResponse } = await import('../supabase/functions/vynzo-api/legacy-media-response.mjs');
  const result = await rewriteLegacyMediaResponse({
    response: Response.json({ activity: [{
      kind: 'image', target_id: articleId, actor_id: authorId,
      avatar_url: `${origin}/storage/v1/object/public/uploads/avatar.jpg`,
      preview: `${origin}/storage/v1/object/public/uploads/${viewerId}/photo.jpg`
    }] }),
    request: new Request('https://api.example/api/activity'),
    viewerId, enabled: true, storageOrigin: origin, workerUrl: 'https://media.example', secret
  });
  const { activity: [item] } = await result.json();
  const avatar = decodeClaims(new URL(item.avatar_url).searchParams.get('permit'));
  const preview = decodeClaims(new URL(item.preview).searchParams.get('permit'));
  assert.equal(avatar.userId, authorId);
  assert.equal(avatar.scope, 'avatar');
  assert.equal(preview.userId, viewerId);
  assert.equal(preview.itemId, articleId);
  assert.equal(preview.kind, 'post');
});

test('Worker reauthorizes file media and proxies byte ranges without exposing Storage URLs', async () => {
  global.crypto = webcrypto;
  const { createLegacyFileDeliveryPermit } = await import('../supabase/functions/vynzo-api/media-permits.mjs');
  const { default: worker } = await import('../workers/media/index.mjs');
  const permit = await createLegacyFileDeliveryPermit({
    viewerId,
    userId: authorId,
    path: `blogs/${authorId}/cover.webp`,
    scope: 'blog',
    resourceId: articleId,
    secret,
    now: Math.floor(Date.now() / 1000)
  });
  const originalFetch = global.fetch;
  const env = {
    DELIVERY_SECRET: secret,
    MEDIA: {},
    MEDIA_AUTH_URL: 'https://api.example/media/authorize',
    MEDIA_AUTH_KEY: 'public-key',
    MEDIA_CONTROL_SECRET: secret
  };
  try {
    let active = true;
    global.fetch = async (url, init) => {
      assert.equal(url, env.MEDIA_AUTH_URL);
      assert.equal(init.headers.Range, 'bytes=0-2');
      const claims = JSON.parse(init.body);
      assert.equal(claims.storage, 'legacy-file');
      assert.equal(claims.viewerId, viewerId);
      return active
        ? new Response('img', { status: 206, headers: {
          'Content-Type': 'image/webp',
          'Content-Range': 'bytes 0-2/9',
          'Content-Length': '3',
          'Accept-Ranges': 'bytes'
        } })
        : new Response(null, { status: 403 });
    };
    const request = new Request(`https://media.example/media?permit=${permit}`, {
      headers: { Range: 'bytes=0-2' }
    });
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('content-range'), 'bytes 0-2/9');
    assert.equal(await response.text(), 'img');
    active = false;
    assert.equal((await worker.fetch(request, env)).status, 403);
  } finally {
    global.fetch = originalFetch;
  }
});

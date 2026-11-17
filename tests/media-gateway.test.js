const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const test = require('node:test');

test('upload gateway forwards only preflight and staged uploads to the media service', async () => {
  const { default: site } = await import('../workers/site/index.mjs');
  const calls = [];
  const env = {
    MEDIA_UPLOAD: {
      async fetch(request) {
        calls.push(request);
        return new Response('response', { status: 201, headers: { 'Access-Control-Allow-Origin': 'https://localhost' } });
      }
    }
  };
  const request = new Request('https://www.vynzosocial.com/media-stage', {
    method: 'PUT',
    headers: {
      Origin: 'https://localhost',
      'Content-Type': 'image/jpeg',
      'Content-Length': '5',
      'X-Upload-Permit': 'test-permit'
    },
    body: 'photo',
    duplex: 'half'
  });

  const response = await site.fetch(request, env);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://localhost');
  assert.equal(calls[0].url, 'https://media.internal/stage');
  assert.equal(calls[0].headers.get('x-upload-permit'), 'test-permit');
  assert.equal(calls[0].headers.get('content-length'), '5');
  assert.equal(await calls[0].text(), 'photo');
  await site.fetch(new Request('https://www.vynzosocial.com/media-stage', {
    method: 'OPTIONS', headers: { Origin: 'https://localhost' }
  }), env);
  assert.equal(calls[1].method, 'OPTIONS');
  assert.equal((await site.fetch(new Request('https://www.vynzosocial.com/media-stage'), env)).status, 405);
});

test('gateway preserves permit validation and streams a valid upload to R2', async () => {
  const { default: site } = await import('../workers/site/index.mjs');
  const { default: worker } = await import('../workers/media/index.mjs');
  const { createUploadPermits } = await import('../supabase/functions/vynzo-api/media-permits.mjs');
  const originalCrypto = global.crypto;
  global.crypto = webcrypto;
  try {
    const secret = 'test-secret-with-at-least-thirty-two-characters';
    const upload = await createUploadPermits({
      userId: 'c86cf40c-d629-4d7a-919f-4d2055498f90',
      kind: 'story', original: { contentType: 'image/jpeg', size: 5 }, secret
    });
    const stored = [];
    const mediaEnv = {
      UPLOAD_PERMIT_SECRET: secret,
      MEDIA: { async put(key, body) { stored.push([key, await new Response(body).text()]); return {}; } }
    };
    const env = { MEDIA_UPLOAD: { fetch: request => worker.fetch(request, mediaEnv) } };
    const request = permit => new Request('https://www.vynzosocial.com/media-stage', {
      method: 'PUT',
      headers: { Origin: 'https://localhost', 'Content-Type': 'image/jpeg', 'Content-Length': '5', 'X-Upload-Permit': permit },
      body: 'photo', duplex: 'half'
    });
    assert.equal((await site.fetch(request('invalid'), env)).status, 401);
    assert.equal(stored.length, 0);
    assert.equal((await site.fetch(request(upload.permits.original), env)).status, 201);
    assert.equal(stored.length, 1);
    assert.match(stored[0][0], /^staging\/story\//);
    assert.equal(stored[0][1], 'photo');
  } finally {
    global.crypto = originalCrypto;
  }
});

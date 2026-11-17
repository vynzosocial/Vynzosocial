const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
if (!global.crypto) global.crypto = webcrypto;

const userId = '128734a0-0081-4ad9-b128-cad57d48d931';
const callId = '75bb349d-14a4-4a14-85c3-c36710292d43';
const secret = 'a'.repeat(64);
const now = 1_794_000_000_000;

async function setup() {
  const { createCallPushSender } = await import('../workers/calls/push-notifications.mjs');
  const { handleCallPush } = await import('../supabase/functions/vynzo-api/call-push.mjs');
  const sent = [];
  let endpointResult;
  const sender = createCallPushSender({
    url: 'https://example.test/push', secret, publishableKey: 'public', now: () => now,
    fetchImpl: async (url, options) => {
      endpointResult = await handleCallPush({
        request: new Request(url, options), secret, now,
        async getInstallations(user) { assert.equal(user, userId); return ['installation-1']; },
        async send(payload) { sent.push(payload); },
        async removeUnregistered() { throw new Error('Unexpected cleanup'); }
      });
      return Response.json(endpointResult, { status: endpointResult.status });
    }
  });
  return { sender, sent, getResult: () => endpointResult };
}

test('signed coordinator invites and cancellations reach only the requested account', async () => {
  const { sender, sent } = await setup();
  await sender({ type: 'invite', userId, callId, video: true, expiresAt: now + 45_000 });
  await sender({ type: 'end', userId, callId });
  assert.deepEqual(sent, [
    { installationId: 'installation-1', data: { type: 'video_call', id: callId, expires_at: String(now + 45_000), user_id: userId }, ttlSeconds: 45 },
    { installationId: 'installation-1', data: { type: 'call_end', id: callId, user_id: userId }, ttlSeconds: 60 }
  ]);
});

test('expired or forged events never send notifications', async () => {
  const { handleCallPush } = await import('../supabase/functions/vynzo-api/call-push.mjs');
  const { signCallPush } = await import('../supabase/functions/_shared/call-push-auth.mjs');
  const body = JSON.stringify({ type: 'invite', userId, callId, video: false, expiresAt: now - 1 });
  const timestamp = String(now);
  const signature = await signCallPush(secret, timestamp, body);
  let lookups = 0;
  const handle = (request, clock = now) => handleCallPush({
    request, secret, now: clock,
    async getInstallations() { lookups++; return []; },
    async send() { throw new Error('Unexpected send'); },
    async removeUnregistered() {}
  });
  const request = (sig, payload = body) => new Request('https://example.test', {
    method: 'POST', headers: { 'X-Call-Timestamp': timestamp, 'X-Call-Signature': sig }, body: payload
  });
  assert.equal((await handle(request(signature))).expired, true);
  assert.equal((await handle(request('b'.repeat(64)))).status, 401);
  assert.equal((await handle(request(signature, body.replace('false', 'true')))).status, 401);
  assert.equal((await handle(request(signature), now + 30_001)).status, 401);
  assert.equal(lookups, 0);
});

test('delivery failures are surfaced to the coordinator', async () => {
  const { createCallPushSender } = await import('../workers/calls/push-notifications.mjs');
  const sender = createCallPushSender({
    url: 'https://example.test', secret, publishableKey: 'public', now: () => now,
    fetchImpl: async () => new Response(null, { status: 503 })
  });
  await assert.rejects(sender({ type: 'end', userId, callId }), /HTTP 503/);
});

test('rejects oversized call push bodies before authorization or delivery', async () => {
  const { handleCallPush } = await import('../supabase/functions/vynzo-api/call-push.mjs');
  const handle = request => handleCallPush({
    request, secret, now,
    async getInstallations() { throw new Error('Unexpected lookup'); },
    async send() { throw new Error('Unexpected send'); },
    async removeUnregistered() {}
  });
  const declared = new Request('https://example.test', {
    method: 'POST', headers: { 'Content-Length': '1025' }, body: 'small'
  });
  const actual = new Request('https://example.test', {
    method: 'POST', body: 'é'.repeat(513)
  });
  assert.equal((await handle(declared)).status, 413);
  assert.equal((await handle(actual)).status, 413);
});

test('coordinator dispatches only after authorization and stops ringing when the invite is accepted', async () => {
  const { CallCoordinator } = await import('../workers/calls/index.mjs');
  const { handleCallPush } = await import('../supabase/functions/vynzo-api/call-push.mjs');
  const actor = '6befdbde-45f1-426c-92aa-327c305b2885';
  const sent = [];
  const tasks = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (url.endsWith('/auth/v1/user')) {
      return Response.json({ id: options.headers.Authorization.slice(7) });
    }
    if (url.endsWith('/calls/authorize-invite')) {
      return Response.json({ actor: { id: actor }, target: { id: userId } });
    }
    if (url.endsWith('/calls/push')) {
      const result = await handleCallPush({
        request: new Request(url, options), secret,
        async getInstallations(user) { assert.equal(user, userId); return ['installation-1']; },
        async send(payload) { sent.push(payload.data.type); },
        async removeUnregistered() {}
      });
      return Response.json(result, { status: result.status });
    }
    throw new Error('Unexpected request');
  };
  try {
    const coordinator = new CallCoordinator({ waitUntil(task) { tasks.push(task); } }, {
      CALL_PUSH_ENABLED: 'true', CALL_PUSH_SECRET: secret, VYNZO_SUPABASE_PUBLISHABLE_KEY: 'public'
    });
    const device = webcrypto.randomUUID();
    const call = (user, body) => coordinator.fetch(new Request('https://calls.test/call', {
      method: 'POST', headers: { Authorization: `Bearer ${user}` },
      body: JSON.stringify({ ...body, deviceId: device })
    }));
    const created = await call(actor, { action: 'create', targetId: userId, video: false });
    assert.equal(created.status, 200);
    await Promise.all(tasks.splice(0));
    assert.deepEqual(sent, ['voice_call']);
    const id = (await created.json()).callId;
    assert.equal((await call(userId, { action: 'accept', callId: id })).status, 200);
    await Promise.all(tasks.splice(0));
    assert.deepEqual(sent, ['voice_call', 'call_end']);
  } finally {
    global.fetch = originalFetch;
  }
});

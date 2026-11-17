const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const test = require('node:test');

test('coordinator authenticates users and restricts invites and signals to call members', async () => {
  const { CallCoordinator } = await import('../workers/calls/index.mjs');
  const previous = { fetch: global.fetch, crypto: global.crypto };
  global.crypto = webcrypto;
  const friends = new Set(['a:b', 'b:c']);
  global.fetch = async (url, options) => {
    const token = options.headers.Authorization.replace(/^Bearer /, '');
    if (url.endsWith('/auth/v1/user')) return token === 'invalid'
      ? new Response(null, { status: 401 })
      : Response.json({ id: token });
    const target = JSON.parse(options.body).targetId;
    if (!friends.has(`${token}:${target}`)) return new Response(null, { status: 404 });
    return Response.json({ actor: { id: token, display_name: token }, target: { id: target, display_name: target } });
  };
  try {
    const coordinator = new CallCoordinator(null, { VYNZO_SUPABASE_PUBLISHABLE_KEY: 'test' });
    const devices = { a: webcrypto.randomUUID(), b: webcrypto.randomUUID(), c: webcrypto.randomUUID(), invalid: webcrypto.randomUUID() };
    const call = (token, body, origin = 'https://www.vynzosocial.com', deviceId = devices[token]) => coordinator.fetch(new Request('https://calls.example/call', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: origin }, body: JSON.stringify({ ...body, deviceId })
    }));
    assert.equal((await call('invalid', { action: 'poll' })).status, 401);
    assert.equal((await call('a', { action: 'poll' }, 'https://evil.example')).status, 403);
    assert.equal((await call('a', { action: 'poll', padding: 'x'.repeat(21000) })).status, 413);
    assert.equal((await call('a', { action: 'create', targetId: 'c', video: false })).status, 404);
    const created = await call('a', { action: 'create', targetId: 'b', video: true });
    assert.equal(created.status, 200);
    const { callId } = await created.json();
    assert.equal((await call('c', { action: 'accept', callId })).status, 404);
    assert.equal((await call('b', { action: 'accept', callId })).status, 200);
    const otherTab = webcrypto.randomUUID();
    assert.equal((await call('b', { action: 'signal', callId, targetId: 'a', signal: { candidate: 'bad' } }, 'https://www.vynzosocial.com', otherTab)).status, 409);
    assert.deepEqual((await (await call('b', { action: 'poll' }, 'https://www.vynzosocial.com', otherTab)).json()).events, []);
    assert.equal((await call('c', { action: 'signal', callId, targetId: 'a', signal: { candidate: 'bad' } })).status, 403);
    assert.equal((await call('b', { action: 'invite', callId, targetId: 'c' })).status, 200);
    assert.equal((await call('c', { action: 'accept', callId })).status, 200);
    assert.equal((await call('a', { action: 'signal', callId, targetId: 'c', signal: { candidate: 'good' } })).status, 200);
    const inbox = await (await call('c', { action: 'poll' })).json();
    assert.ok(inbox.events.some(event => event.type === 'signal' && event.from === 'a'));
    assert.equal((await call('a', { action: 'leave', callId })).status, 200);
    assert.equal((await call('b', { action: 'leave', callId })).status, 200);
    const remaining = await (await call('c', { action: 'poll' })).json();
    assert.equal(remaining.call, null);
    assert.ok(remaining.events.some(event => event.type === 'ended'));
    assert.equal(coordinator.registry.rooms.size, 0);
  } finally {
    global.fetch = previous.fetch;
    global.crypto = previous.crypto;
  }
});

test('lifecycle-aware calls reject inactive sessions and fail closed on verification errors', async () => {
  const { CallCoordinator } = await import('../workers/calls/index.mjs');
  const previous = { fetch: global.fetch, crypto: global.crypto };
  global.crypto = webcrypto;
  let state = 'active';
  const urls = [];
  global.fetch = async (url, options) => {
    urls.push(url);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'user' });
    assert.ok(url.endsWith('/calls/session'));
    assert.equal(options.headers.Authorization, 'Bearer access');
    if (state === 'inactive') return new Response(null, { status: 401 });
    if (state === 'unavailable') return new Response(null, { status: 503 });
    return Response.json({ userId: state === 'mismatch' ? 'other' : 'user' });
  };
  try {
    const env = { VYNZO_SUPABASE_PUBLISHABLE_KEY: 'test', ACCOUNT_LIFECYCLE_ENABLED: 'true' };
    const coordinator = new CallCoordinator(null, env);
    const request = () => new Request('https://calls.example/call', {
      method: 'POST', headers: { Authorization: 'Bearer access' },
      body: JSON.stringify({ action: 'poll', deviceId: webcrypto.randomUUID() })
    });

    await test('lifecycle-aware calls remove inactive participants and suppress their queued signals', async () => {
      const { CallCoordinator } = await import('../workers/calls/index.mjs');
      const previous = { fetch: global.fetch, crypto: global.crypto };
      global.crypto = webcrypto;
      const [a, b, c] = Array.from({ length: 3 }, () => webcrypto.randomUUID());
      const deviceIds = new Map([a, b, c].map(id => [id, webcrypto.randomUUID()]));
      const secret = 's'.repeat(32);
      let inactive = [];
      let verification = 'ok';
      let mutateRoom;
      global.fetch = async (url, options) => {
        if (url.endsWith('/auth/v1/user')) return Response.json({ id: options.headers.Authorization.slice(7) });
        if (url.endsWith('/calls/session')) return Response.json({ userId: options.headers.Authorization.slice(7) });
        if (url.endsWith('/calls/participant-status')) {
          assert.equal(options.headers['X-Call-Lifecycle'], secret);
          if (verification === 'unavailable') return new Response(null, { status: 503 });
          if (verification === 'invalid') return Response.json({ inactiveIds: [webcrypto.randomUUID()] });
          if (verification === 'changed') mutateRoom();
          const ids = JSON.parse(options.body).userIds;
          return Response.json({ inactiveIds: inactive.filter(id => ids.includes(id)) });
        }
        const target = JSON.parse(options.body).targetId;
        return Response.json({ actor: { id: options.headers.Authorization.slice(7) }, target: { id: target } });
      };
      try {
        const coordinator = new CallCoordinator(null, {
          VYNZO_SUPABASE_PUBLISHABLE_KEY: 'test',
          ACCOUNT_LIFECYCLE_ENABLED: 'true',
          CALL_LIFECYCLE_SECRET: secret
        });
        const call = (id, body) => coordinator.fetch(new Request('https://calls.example/call', {
          method: 'POST',
          headers: { Authorization: ['Bearer', id].join(' ') },
          body: JSON.stringify({ ...body, deviceId: deviceIds.get(id) })
        }));
        const created = await (await call(a, { action: 'create', targetId: b, video: false })).json();
        const callId = created.callId;
        assert.equal((await call(b, { action: 'accept', callId })).status, 200);
        assert.equal((await call(a, { action: 'invite', callId, targetId: c })).status, 200);
        inactive = [c];
        const pendingRemoval = await (await call(a, { action: 'poll' })).json();
        assert.deepEqual(pendingRemoval.call.pending, []);
        assert.ok(pendingRemoval.events.some(event => event.type === 'invitation_ended' && event.userId === c));
        assert.equal(coordinator.registry.memberships.has(c), false);
        inactive = [];
        assert.equal((await call(a, { action: 'invite', callId, targetId: c })).status, 200);
        assert.equal((await call(c, { action: 'accept', callId })).status, 200);
        assert.equal((await call(b, { action: 'signal', callId, targetId: a, signal: { candidate: 'private' } })).status, 200);
        inactive = [b];
        verification = 'unavailable';
        assert.equal((await call(a, { action: 'poll' })).status, 503);
        verification = 'invalid';
        assert.equal((await call(a, { action: 'poll' })).status, 503);
        verification = 'ok';
        const result = await (await call(a, { action: 'poll' })).json();
        assert.deepEqual(result.call.participants.map(user => user.id).sort(), [a, c].sort());
        assert.equal(result.events.some(event => event.type === 'signal' && event.from === b), false);
        assert.equal(result.events.some(event => event.type === 'joined' && event.user.id === b), false);
        assert.ok(result.events.some(event => event.type === 'left' && event.userId === b));
        assert.equal((await call(a, { action: 'signal', callId, targetId: b, signal: {} })).status, 404);
        inactive = [];
        mutateRoom = () => {
          const room = coordinator.registry.rooms.get(callId);
          coordinator.registry.remove(room, c, 'left');
        };
        verification = 'changed';
        assert.equal((await call(a, { action: 'poll' })).status, 503);
      } finally {
        global.fetch = previous.fetch;
        global.crypto = previous.crypto;
      }
    });
    assert.equal((await coordinator.fetch(request())).status, 200);
    state = 'inactive';
    assert.equal((await coordinator.fetch(request())).status, 401);
    state = 'unavailable';
    assert.equal((await coordinator.fetch(request())).status, 503);
    state = 'mismatch';
    assert.equal((await coordinator.fetch(request())).status, 503);
    env.ACCOUNT_LIFECYCLE_ENABLED = 'false';
    urls.length = 0;
    assert.equal((await coordinator.fetch(request())).status, 200);
    assert.equal(urls.length, 1);
  } finally {
    global.fetch = previous.fetch;
    global.crypto = previous.crypto;
  }
});

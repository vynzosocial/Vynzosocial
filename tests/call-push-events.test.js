const test = require('node:test');
const assert = require('node:assert/strict');

async function setup() {
  const { CallRegistry } = await import('../workers/calls/call-registry.mjs');
  let time = 1_000;
  let next = 0;
  const events = [];
  const registry = new CallRegistry({
    now: () => time,
    randomUUID: () => `id-${++next}`,
    onPushEvent: event => events.push(event)
  });
  const room = registry.create({ id: 'alice' }, true);
  return { registry, callId: room.callId, events, advance(ms) { time += ms; } };
}

test('authorized invitations produce a bounded push and acceptance stops ringing on all devices', async () => {
  const { registry, callId, events } = await setup();
  registry.invite('alice', callId, { id: 'bob' });
  assert.deepEqual(events, [{ type: 'invite', userId: 'bob', callId, video: true, expiresAt: 46_000 }]);
  registry.accept('bob', callId, 'bob-device');
  assert.deepEqual(events[1], { type: 'end', userId: 'bob', callId });
});

test('declining, caller leaving, and expiry each cancel pending calls', async () => {
  const first = await setup();
  first.registry.invite('alice', first.callId, { id: 'bob' });
  first.registry.decline('bob', first.callId);
  assert.deepEqual(first.events.at(-1), { type: 'end', userId: 'bob', callId: first.callId });

  const second = await setup();
  second.registry.invite('alice', second.callId, { id: 'bob' });
  second.registry.invite('alice', second.callId, { id: 'carol' });
  second.registry.leave('alice', second.callId);
  assert.deepEqual(second.events.filter(item => item.type === 'end').map(item => item.userId), ['bob', 'carol']);

  const third = await setup();
  third.registry.invite('alice', third.callId, { id: 'bob' });
  third.advance(45_000);
  third.registry.sweep();
  assert.deepEqual(third.events.at(-1), { type: 'end', userId: 'bob', callId: third.callId });
});

test('rejected invitations do not emit push events', async () => {
  const { registry, callId, events } = await setup();
  assert.throws(() => registry.invite('stranger', callId, { id: 'bob' }));
  assert.equal(events.length, 0);
});

const assert = require('node:assert/strict');
const test = require('node:test');

const user = id => ({ id, display_name: id });
let CallRegistry;
test.before(async () => { ({ CallRegistry } = await import('../workers/calls/call-registry.mjs')); });

test('only active participants can invite and the eight-person limit includes pending invitations', () => {
  const registry = new CallRegistry({ randomUUID: () => 'call-1' });
  const room = registry.create(user('one'), true);
  for (let i = 2; i <= 8; i++) registry.invite('one', room.callId, user(String(i)));
  assert.throws(() => registry.invite('one', room.callId, user('nine')), /full/);
  assert.throws(() => registry.invite('2', room.callId, user('nine')), /participant/);
  registry.accept('2', room.callId);
  assert.throws(() => registry.invite('2', room.callId, user('nine')), /full/);
  registry.decline('3', room.callId);
  registry.invite('2', room.callId, user('nine'));
  assert.equal(registry.poll('nine').events[0].from.id, '2');
});

test('voice calls reserve at most six places and release declined invitations and departed participants', () => {
  const registry = new CallRegistry({ randomUUID: () => 'voice-call' });
  registry.create(user('1'), false);
  for (let i = 2; i <= 6; i++) registry.invite('1', 'voice-call', user(String(i)));
  const full = error => error.status === 409 && /full.*6/.test(error.message);
  assert.throws(() => registry.invite('1', 'voice-call', user('7')), full);
  assert.equal(registry.memberships.has('7'), false);
  registry.decline('6', 'voice-call');
  registry.invite('1', 'voice-call', user('7'));
  for (const id of ['2', '3', '4', '5', '7']) registry.accept(id, 'voice-call');
  assert.equal(registry.poll('1').call.participants.length, 6);
  assert.throws(() => registry.invite('2', 'voice-call', user('8')), full);
  registry.leave('3', 'voice-call');
  registry.invite('2', 'voice-call', user('8'));
  assert.equal(registry.accept('8', 'voice-call').participants.length, 6);
});

test('signaling requires accepted participants and is addressed to one recipient', () => {
  const registry = new CallRegistry({ randomUUID: () => 'call-1' });
  registry.create(user('a'), false);
  registry.invite('a', 'call-1', user('b'));
  assert.throws(() => registry.signal('a', 'call-1', 'b', { candidate: 'x' }), /unavailable/);
  assert.throws(() => registry.accept('stranger', 'call-1'), /unavailable/);
  registry.accept('b', 'call-1');
  registry.poll('a');
  const bEvents = registry.poll('b').events;
  assert.throws(() => registry.signal('stranger', 'call-1', 'b', { candidate: 'x' }), /participant/);
  assert.throws(() => registry.signal('a', 'call-1', 'b', { data: 'x'.repeat(17000) }), /Invalid/);
  registry.signal('a', 'call-1', 'b', { candidate: 'candidate' });
  const signals = registry.poll('b', bEvents.at(-1).sequence).events;
  assert.equal(signals.length, 1);
  assert.equal(signals[0].from, 'a');
  assert.equal(signals[0].signal.candidate, 'candidate');
});

test('a group call survives its creator leaving when two participants remain', () => {
  const registry = new CallRegistry({ randomUUID: () => 'call-1' });
  registry.create(user('a'), false);
  registry.invite('a', 'call-1', user('b'));
  registry.accept('b', 'call-1');
  registry.invite('b', 'call-1', user('c'));
  assert.equal(registry.accept('c', 'call-1').participants.length, 3);
  registry.leave('a', 'call-1');
  assert.throws(() => registry.signal('a', 'call-1', 'c', { candidate: 'x' }), /participant/);
  registry.leave('b', 'call-1');
  assert.equal(registry.poll('c').call, null);
  assert.ok(registry.poll('c').events.some(event => event.type === 'ended'));
  assert.equal(registry.rooms.size, 0);
  assert.equal(registry.memberships.size, 0);
});

test('a two-person call ends for the remaining participant when either leaves', () => {
  for (const leaver of ['a', 'b']) {
    const registry = new CallRegistry({ randomUUID: () => 'call-1' });
    registry.create(user('a'), false);
    registry.invite('a', 'call-1', user('b'));
    registry.accept('b', 'call-1');
    registry.leave(leaver, 'call-1');
    const remaining = registry.poll(leaver === 'a' ? 'b' : 'a');
    assert.equal(remaining.call, null);
    assert.ok(remaining.events.some(event => event.type === 'ended'));
    assert.equal(registry.memberships.size, 0);
  }
});

test('pending invitations remain available until answered or expired', () => {
  const registry = new CallRegistry({ randomUUID: () => 'call-1' });
  registry.create(user('a'), false);
  registry.invite('a', 'call-1', user('b'));
  registry.accept('b', 'call-1');
  registry.invite('a', 'call-1', user('c'));
  registry.leave('b', 'call-1');
  assert.equal(registry.poll('a').call.pending[0].id, 'c');
  registry.decline('c', 'call-1');
  assert.equal(registry.poll('a').call, null);
  assert.ok(registry.poll('a').events.some(event => event.type === 'ended'));
});

test('a guest can leave without ending a call for other participants', () => {
  const registry = new CallRegistry({ randomUUID: () => 'call-1' });
  registry.create(user('host'), true);
  registry.invite('host', 'call-1', user('guest'));
  registry.accept('guest', 'call-1');
  registry.invite('host', 'call-1', user('other'));
  registry.accept('other', 'call-1');
  registry.leave('guest', 'call-1');
  const host = registry.poll('host');
  assert.deepEqual(host.call.participants.map(participant => participant.id), ['host', 'other']);
  assert.ok(host.events.some(event => event.type === 'left' && event.userId === 'guest'));
  assert.equal(registry.poll('guest').call, null);
  assert.equal(registry.poll('other').call.callId, 'call-1');
});

test('expired invitations and disconnected participants release their places', () => {
  let time = 0;
  const registry = new CallRegistry({ now: () => time, randomUUID: () => 'call-1' });
  registry.create(user('a'), false);
  registry.invite('a', 'call-1', user('b'));
  time = 46_000;
  assert.equal(registry.poll('a').events[0].reason, 'missed');
  assert.throws(() => registry.accept('b', 'call-1'), /unavailable/);
  registry.invite('a', 'call-1', user('b'));
  registry.accept('b', 'call-1');
  time += 59_000;
  registry.poll('b');
  time += 2_000;
  assert.equal(registry.poll('b').events.some(event => event.reason === 'disconnected'), true);
  assert.equal(registry.memberships.has('a'), false);
  assert.equal(registry.poll('b').call, null);
  assert.equal(registry.memberships.has('b'), false);
});

test('eight accepted participants can exchange individually addressed signals', () => {
  const registry = new CallRegistry({ randomUUID: () => 'call-1' });
  registry.create(user('1'), true);
  for (let i = 2; i <= 8; i++) {
    registry.invite('1', 'call-1', user(String(i)));
    registry.accept(String(i), 'call-1');
  }
  const cursors = new Map();
  for (let i = 1; i <= 8; i++) {
    const events = registry.poll(String(i)).events;
    cursors.set(i, events.length ? events.at(-1).sequence : 0);
  }
  for (let i = 1; i <= 8; i++) {
    for (let j = 1; j <= 8; j++) {
      if (i !== j) registry.signal(String(i), 'call-1', String(j), { candidate: `${i}-${j}` });
    }
  }
  for (let i = 1; i <= 8; i++) {
    const signals = registry.poll(String(i), cursors.get(i)).events;
    assert.equal(signals.length, 7);
    assert.ok(signals.every(event => event.signal.candidate.endsWith(`-${i}`)));
  }
});

test('a full signaling queue is bounded and explicitly reports lost events', () => {
  const registry = new CallRegistry({ randomUUID: () => 'call-1' });
  registry.create(user('a'), false);
  registry.invite('a', 'call-1', user('b'));
  registry.accept('b', 'call-1');
  const events = registry.poll('b').events;
  registry.poll('b', events.at(-1).sequence);
  for (let i = 0; i < 257; i++) registry.signal('a', 'call-1', 'b', { candidate: String(i) });
  const overflow = registry.poll('b').events;
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0].type, 'overflow');
  assert.equal(registry.poll('b').events[0].sequence, overflow[0].sequence);
  assert.equal(registry.poll('b', overflow[0].sequence).events.length, 0);
});

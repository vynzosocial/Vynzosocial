const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'group-call-service.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export class GroupCallService', 'class GroupCallService');

function setup() {
  const calls = [];
  const notifications = [];
  class Mesh {
    constructor(options) { this.peers = []; this.sendSignal = options.sendSignal; this.onState = options.onState; }
    addPeer(id) { this.peers.push(id); }
    async offer(id) { calls.push(['offer', id]); }
    async receive(id, signal) { calls.push(['signal', id, signal]); }
    removePeer(id) { calls.push(['remove', id]); }
    close() { calls.push(['close']); }
  }
  const context = {
    CallMesh: Mesh, setTimeout, clearTimeout, AbortController, crypto: webcrypto,
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'token', user: { id: 'a' } } } }) } },
    fetch: async (_url, options) => {
      const request = JSON.parse(options.body);
      calls.push(request);
      return { ok: true, json: async () => request.action === 'create'
        ? { callId: 'call', participants: [{ id: 'a' }], pending: [{ id: 'b' }] }
        : { ok: true } };
    }
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.Service = GroupCallService;`, context);
  const service = new context.Service({
    rtcConfig: {}, onIncoming: event => notifications.push(event), onChange: () => {},
    onTrack: () => {}, onPeerState: () => {}, onError: error => { throw error; }
  });
  return { service, calls, notifications, context };
}

test('creates a call, signals joined participants and cleans up local media', async () => {
  const { service, calls } = setup();
  let stopped = false;
  const stream = { getTracks: () => [{ stop() { stopped = true; } }] };
  await service.create({ targetId: 'b', video: true, stream });
  service.call.participants.push({ id: 'b' });
  await service.handleEvent({ type: 'joined', callId: 'call', user: { id: 'b' } });
  assert.equal(calls.some(entry => Array.isArray(entry) && entry[0] === 'offer' && entry[1] === 'b'), true);
  await service.leave();
  assert.equal(stopped, true);
  assert.equal(service.call, null);
});

test('ignores incoming and stale participant signals while in another call', async () => {
  const { service, calls, notifications } = setup();
  const stream = { getTracks: () => [] };
  await service.create({ targetId: 'b', stream });
  await service.handleEvent({ type: 'incoming', callId: 'other' });
  await service.handleEvent({ type: 'signal', callId: 'call', from: 'stranger', signal: { candidate: 'bad' } });
  assert.equal(notifications.length, 0);
  assert.equal(calls.some(entry => Array.isArray(entry) && entry[0] === 'signal'), false);
});

test('a guest leaving closes local media and sends a leave request', async () => {
  const { service, calls } = setup();
  let stopped = false;
  service.request = async body => {
    calls.push(body);
    return body.action === 'accept'
      ? { callId: 'call', participants: [{ id: 'guest' }, { id: 'host' }], pending: [] }
      : { ok: true };
  };
  service.userId = 'guest';
  await service.accept('call', { getTracks: () => [{ stop() { stopped = true; } }] });
  await service.leave();
  assert.equal(stopped, true);
  assert.equal(service.call, null);
  assert.ok(calls.some(entry => entry.action === 'leave' && entry.callId === 'call'));
  assert.ok(calls.some(entry => Array.isArray(entry) && entry[0] === 'close'));
});

test('polling preserves the active call object during device changes', async () => {
  const { service } = setup();
  await service.create({ targetId: 'b', stream: { getTracks: () => [] } });
  const active = service.call;
  service.request = async () => ({
    epoch: 'epoch', reset: false, events: [],
    call: { callId: 'call', participants: [{ id: 'a' }, { id: 'b' }], pending: [] }
  });

  await service.poll();
  assert.equal(service.call, active);
  assert.equal(service.call.participants.length, 2);
});

test('call signaling carries each device platform and keeps it across snapshots', async () => {
  const { service, calls } = setup();
  await service.create({ targetId: 'b', stream: { getTracks: () => [] } });
  service.call.participants.push({ id: 'b' });
  await service.mesh.sendSignal('b', { candidate: 'ice' });
  assert.equal(calls.find(entry => entry.action === 'signal').signal.platform, 'web');
  await service.handleEvent({ type: 'signal', callId: 'call', from: 'b', signal: { candidate: 'ice', platform: 'app' } });
  assert.equal(service.call.participants.find(user => user.id === 'a').platform, 'web');
  assert.equal(service.call.participants.find(user => user.id === 'b').platform, 'app');
  service.request = async () => ({
    epoch: 'epoch', reset: false, events: [],
    call: { callId: 'call', participants: [{ id: 'a' }, { id: 'b' }], pending: [] }
  });
  await service.poll();
  assert.equal(service.call.participants.find(user => user.id === 'b').platform, 'app');
  assert.ok(calls.some(entry => Array.isArray(entry) && entry[0] === 'signal'));
});

test('native app identifies itself as app, not website', async () => {
  const { service, calls, context } = setup();
  context.Capacitor = { isNativePlatform: () => true };
  await service.create({ targetId: 'b', stream: { getTracks: () => [] } });
  await service.mesh.sendSignal('b', { candidate: 'ice' });
  assert.equal(service.call.participants[0].platform, 'app');
  assert.equal(calls.find(entry => entry.action === 'signal').signal.platform, 'app');
});

test('polling accelerates while connecting and returns to normal after connection', async () => {
  const { service, context } = setup();
  const scheduled = [];
  context.setTimeout = (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; };
  context.clearTimeout = timer => { if (timer) timer.cleared = true; };
  service.running = true;
  await service.create({ targetId: 'b', stream: { getTracks: () => [] } });
  assert.equal(scheduled.at(-1).delay, 0);
  service.request = async () => ({
    epoch: 'epoch', reset: false, events: [],
    call: { callId: 'call', participants: [{ id: 'a' }, { id: 'b' }], pending: [] }
  });
  await service.poll();
  assert.equal(scheduled.at(-1).delay, 750);
  service.mesh.onState('b', 'connected');
  await service.poll();
  assert.equal(scheduled.at(-1).delay, 3000);
  service.mesh.onState('b', 'disconnected');
  assert.equal(scheduled.at(-1).delay, 0);
  await service.poll();
  assert.equal(scheduled.at(-1).delay, 750);
  service.stopPolling();
});

test('starting a call while a poll is in flight schedules one immediate follow-up', async () => {
  const { service, context } = setup();
  const scheduled = [];
  context.setTimeout = (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; };
  context.clearTimeout = () => {};
  let resolvePoll;
  service.request = body => body.action === 'poll'
    ? new Promise(resolve => { resolvePoll = resolve; })
    : Promise.resolve({ callId: 'call', participants: [{ id: 'a' }], pending: [{ id: 'b' }] });
  service.userId = 'a';
  service.running = true;
  const polling = service.poll();
  await service.create({ targetId: 'b', stream: { getTracks: () => [] } });
  assert.equal(scheduled.length, 0);
  resolvePoll({ epoch: 'epoch', reset: false, events: [], call: null });
  await polling;
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 0);
  assert.equal(service.call.callId, 'call');
  service.stopPolling();
});

test('signals received while acceptance is in flight are delivered after the call starts', async () => {
  const { service, calls } = setup();
  service.userId = 'a';
  let resolveAccept;
  service.request = body => body.action === 'accept'
    ? new Promise(resolve => { resolveAccept = resolve; })
    : Promise.resolve({
      epoch: 'epoch', reset: false,
      call: { callId: 'call', participants: [{ id: 'a' }, { id: 'b' }], pending: [] },
      events: [{ sequence: 1, type: 'signal', callId: 'call', from: 'b', signal: { candidate: 'ice' } }]
    });
  const accepting = service.accept('call', { getTracks: () => [] });
  const polling = service.poll();
  await Promise.resolve();
  assert.equal(service.cursor, 0);
  resolveAccept({ callId: 'call', participants: [{ id: 'a' }, { id: 'b' }], pending: [] });
  await accepting;
  await polling;
  assert.equal(service.cursor, 1);
  assert.ok(calls.some(entry => Array.isArray(entry) && entry[0] === 'signal' && entry[1] === 'b'));
});

test('faster polling is bounded and polling failures retain backoff', async () => {
  const { service, context } = setup();
  const scheduled = [];
  context.setTimeout = (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; };
  context.clearTimeout = () => {};
  service.onError = () => {};
  service.running = true;
  await service.create({ targetId: 'b', stream: { getTracks: () => [] } });
  service.fastPollUntil = 0;
  assert.equal(service.pollDelay(), 3000);
  service.request = async () => { throw new Error('network error'); };
  service.pollSoon();
  await service.poll();
  assert.equal(scheduled.at(-1).delay, 15000);
  service.stopPolling();
});

test('polling a terminated two-person call closes media and the call interface', async () => {
  const { service, calls } = setup();
  let stopped = false;
  let reason;
  service.onChange = (call, message) => { if (!call) reason = message; };
  await service.create({ targetId: 'b', stream: { getTracks: () => [{ stop() { stopped = true; } }] } });
  service.request = async () => ({ epoch: 'epoch', reset: false, events: [{ type: 'ended', callId: 'call', sequence: 1 }], call: null });
  await service.poll();
  assert.equal(service.call, null);
  assert.equal(stopped, true);
  assert.equal(reason, 'Call ended.');
  assert.ok(calls.some(entry => Array.isArray(entry) && entry[0] === 'close'));
});

test('polling ignores stale incoming invitations after a call has ended', async () => {
  const { service, notifications } = setup();
  service.userId = 'a';
  service.request = async () => ({
    epoch: 'epoch', reset: false,
    events: [{ type: 'incoming', callId: 'old', sequence: 1 }],
    call: null
  });
  await service.poll();
  assert.equal(notifications.length, 0);
  assert.equal(service.cursor, 1);
});

test('polling presents only an invitation still pending for this user', async () => {
  const { service, notifications } = setup();
  service.userId = 'a';
  service.request = async () => ({
    epoch: 'epoch', reset: false,
    events: [{ type: 'incoming', callId: 'call', sequence: 1 }],
    call: { callId: 'call', pending: [{ id: 'a' }] }
  });

  await service.poll();
  assert.equal(notifications.length, 1);
});

test('notification joins only the specified pending invitation', async () => {
  const { service } = setup();
  service.userId = 'a';
  service.request = async () => ({
    call: { callId: 'call', video: true, pending: [{ id: 'a' }] }
  });
  assert.equal((await service.pendingInvitation('call')).video, true);
  await assert.rejects(service.pendingInvitation('different'), /invitation has ended/);
  service.userId = 'other';
  await assert.rejects(service.pendingInvitation('call'), /invitation has ended/);
});

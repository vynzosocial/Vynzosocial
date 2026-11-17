const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { webcrypto } = require('node:crypto');

const root = path.join(__dirname, '..');
const serviceSource = fs.readFileSync(path.join(root, 'frontend', 'js', 'group-call-service.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export class GroupCallService', 'class GroupCallService');
const meshSource = fs.readFileSync(path.join(root, 'frontend', 'js', 'call-mesh.js'), 'utf8')
  .replace('export class CallMesh', 'class CallMesh');

async function simulate(video, interval) {
  const { CallRegistry } = await import('../workers/calls/call-registry.mjs');
  let time = 0;
  let timerId = 0;
  const timers = new Map();
  const peers = [];
  const errors = [];
  class Clock extends Date { static now() { return time; } }
  class Peer {
    constructor() { this.remoteDescription = null; this.ice = []; peers.push(this); }
    addTrack() {}
    async createOffer() { return { type: 'offer', sdp: 'offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
    async setLocalDescription(description) {
      this.localDescription = description;
      this.onicecandidate({ candidate: { candidate: description.type } });
    }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    async addIceCandidate(candidate) { this.ice.push(candidate); }
    close() {}
  }
  const context = {
    RTCPeerConnection: Peer, crypto: webcrypto, AbortController, supabase: null, Date: Clock,
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, at: time + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.createContext(context);
  vm.runInContext(`${meshSource}\n${serviceSource.replace('const CONNECTING_POLL_INTERVAL = 750;', `const CONNECTING_POLL_INTERVAL = ${interval};`)}\nthis.Service = GroupCallService;`, context);
  let nextId = 0;
  const registry = new CallRegistry({ now: () => time, randomUUID: () => `id-${++nextId}` });
  const stream = { getTracks: () => [{ kind: 'audio' }, ...(video ? [{ kind: 'video' }] : [])] };
  function client(id) {
    const service = new context.Service({
      rtcConfig: {}, onIncoming() {}, onChange() {}, onTrack() {}, onPeerState() {},
      onError: error => errors.push(error)
    });
    service.userId = id;
    service.request = async body => {
      if (body.action === 'create') {
        const room = registry.create({ id }, body.video);
        return registry.invite(id, room.callId, { id: body.targetId });
      }
      if (body.action === 'accept') return registry.accept(id, body.callId);
      if (body.action === 'signal') return registry.signal(id, body.callId, body.targetId, body.signal);
      if (body.action === 'poll') return { ...registry.poll(id, body.after), reset: false };
      throw new Error(`Unexpected request: ${body.action}`);
    };
    service.running = true;
    return service;
  }
  const caller = client('a');
  const guest = client('b');
  const call = await caller.create({ targetId: 'b', video, stream });
  await guest.accept(call.callId, stream);
  while (time < 15000 && (peers.length < 2 || !peers.every(peer => peer.remoteDescription && peer.ice.length))) {
    assert.ok(timers.size, 'signaling stopped before the exchange completed');
    const [id, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    timers.delete(id);
    time = timer.at;
    await timer.callback();
  }
  caller.stopPolling();
  guest.stopPolling();
  assert.deepEqual(errors, []);
  assert.equal(peers.length, 2);
  assert.ok(peers.every(peer => peer.remoteDescription && peer.ice.length), 'offer, answer and ICE must arrive');
  return time;
}

for (const video of [false, true]) {
  test(`${video ? 'video' : 'voice'} call completes coordinated signaling faster`, async () => {
    const baseline = await simulate(video, 3000);
    const improved = await simulate(video, 750);
    assert.ok(improved <= 2250, `signaling took ${improved}ms`);
    assert.ok(improved <= baseline / 2, `improved ${improved}ms vs baseline ${baseline}ms`);
  });
}

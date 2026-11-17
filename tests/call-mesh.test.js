const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'call-mesh.js'), 'utf8')
  .replace('export class CallMesh', 'class CallMesh');

function setup() {
  const signals = [];
  const errors = [];
  const audio = { kind: 'audio' };
  class Peer {
    constructor() { this.senders = []; this.ice = []; this.remoteDescription = null; }
    addTrack(track) { this.senders.push({ track, async replaceTrack(next) { this.track = next; } }); }
    getSenders() { return this.senders; }
    async createOffer() { return { type: 'offer', sdp: 'offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    async addIceCandidate(candidate) { this.ice.push(candidate); }
    close() { this.closed = true; }
  }
  const context = { RTCPeerConnection: Peer, AggregateError, Promise };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.CallMesh = CallMesh;`, context);
  const tracks = [audio];
  const mesh = new context.CallMesh({
    stream: {
      getTracks: () => tracks,
      removeTrack(track) { tracks.splice(tracks.indexOf(track), 1); },
      addTrack(track) { tracks.push(track); }
    }, rtcConfig: {},
    sendSignal: async (id, signal) => signals.push({ id, signal }),
    onTrack() {}, onState() {}, onError: error => errors.push(error)
  });
  return { mesh, audio, signals, errors };
}

test('peers exchange offers, answers and queued ICE separately', async () => {
  const { mesh, signals } = setup();
  await mesh.offer('a');
  await mesh.receive('b', { candidate: 'first' });
  const peer = mesh.peers.get('b').pc;
  assert.equal(peer.ice.length, 0);
  await mesh.receive('b', { description: { type: 'offer', sdp: 'offer' } });
  assert.deepEqual(peer.ice, ['first']);
  assert.equal(signals[0].signal.description.type, 'offer');
  assert.equal(signals[1].signal.description.type, 'answer');
  mesh.close();
  assert.equal(peer.closed, true);
  assert.equal(mesh.peers.size, 0);
});

test('replaces every microphone sender and rolls back on failure', async () => {
  const { mesh, audio } = setup();
  const first = mesh.addPeer('a').pc.senders[0];
  const second = mesh.addPeer('b').pc.senders[0];
  const newTrack = { kind: 'audio' };
  second.replaceTrack = async () => { throw new Error('device error'); };
  await assert.rejects(mesh.replaceAudioTrack(audio, newTrack), /device error/);
  assert.equal(first.track, audio);
  assert.equal(second.track, audio);
});

test('new participants use the selected microphone after a successful switch', async () => {
  const { mesh, audio } = setup();
  const first = mesh.addPeer('a').pc.senders[0];
  const newTrack = { kind: 'audio' };
  await mesh.replaceAudioTrack(audio, newTrack);
  const next = mesh.addPeer('b').pc.senders[0];
  assert.equal(first.track, newTrack);
  assert.equal(next.track, newTrack);
  assert.equal(mesh.stream.getTracks()[0], newTrack);
});

test('camera switching updates every video sender without replacing microphone tracks', async () => {
  const { mesh, audio } = setup();
  const camera = { kind: 'video' };
  const nextCamera = { kind: 'video' };
  mesh.stream.addTrack(camera);
  const first = mesh.addPeer('a').pc;
  const second = mesh.addPeer('b').pc;
  await mesh.replaceVideoTrack(camera, nextCamera);
  for (const pc of [first, second]) {
    assert.equal(pc.senders[0].track, audio);
    assert.equal(pc.senders[1].track, nextCamera);
  }
  assert.equal(mesh.stream.getTracks()[1], camera);
});

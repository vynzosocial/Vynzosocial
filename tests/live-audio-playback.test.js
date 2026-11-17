const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/live.js'), 'utf8');
const createPeer = source.slice(source.indexOf('function createPeerConnection('), source.indexOf('\nasync function requestPeerNegotiation('));

test('audio-only participants play once even without a video tile', async () => {
  const appended = [];
  const audioElements = {};
  class MediaStream {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    getTracks() { return this.tracks; }
    addTrack(track) { this.tracks.push(track); }
  }
  class RTCPeerConnection {
    addTransceiver() { return { sender: {} }; }
  }
  const context = {
    RTCPeerConnection, MediaStream, rtcConfig: {},
    peerConnections: {}, peerNegotiationState: {}, peerSenders: {}, remoteMediaStreams: {},
    remoteAudioElements: audioElements, socket: { id: 'self' },
    document: {
      createElement: () => ({ play() { this.plays = (this.plays || 0) + 1; return Promise.resolve(); } }),
      body: { append: element => appended.push(element) }
    },
    audioDevices: { applyOutput: async () => {} },
    ensureVideoTile: () => { throw new Error('Audio should not require a video tile'); },
    showLiveError: message => { throw new Error(message); },
    console
  };
  vm.createContext(context);
  vm.runInContext(createPeer, context);
  const pc = context.createPeerConnection('participant');
  const track = { kind: 'audio' };
  pc.ontrack({ track });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(appended.length, 1);
  assert.equal(appended[0].srcObject.getTracks()[0], track);
  assert.equal(appended[0].plays, 1);
  const tile = { video: {}, status: {}, frame: {} };
  context.ensureVideoTile = () => tile;
  const videoTrack = { kind: 'video', muted: true };
  pc.ontrack({ track: videoTrack });
  assert.equal(tile.video.srcObject.getTracks().length, 1);
  assert.equal(tile.video.srcObject.getTracks()[0], videoTrack);
});

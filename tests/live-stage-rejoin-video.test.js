const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/live.js'), 'utf8');
const createPeer = source.slice(source.indexOf('function createPeerConnection('), source.indexOf('\nasync function requestPeerNegotiation('));

test('returning guest video uses the current tile rather than the removed stage tile', async () => {
  const tiles = [];
  let currentTile;
  const track = { kind: 'video', readyState: 'live', muted: false };
  class Stream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    addTrack(item) { this.tracks.push(item); }
  }
  class Peer {
    addTransceiver() { return { sender: {} }; }
  }
  const context = {
    RTCPeerConnection: Peer, rtcConfig: {}, MediaStream: Stream,
    socket: { id: 'host', emit() {} }, peerConnections: {}, peerNegotiationState: {},
    peerSenders: {}, remoteMediaStreams: {}, remoteCameraStates: new Map(),
    canShowTile: () => true,
    ensureVideoTile() { return currentTile; },
    setTileCameraOff(tile, off) { tile.cameraOff = off; },
    setTileVisible(frame, visible) { frame.visible = visible; },
    document: { querySelectorAll: () => [currentTile.frame] },
    showLiveError() {}, console
  };
  function tile() {
    const video = { play: () => Promise.resolve() };
    const frame = { dataset: { peerId: 'guest', stageGuest: '1' }, querySelector: () => video };
    const item = { frame, video, status: {} };
    tiles.push(item);
    return item;
  }
  currentTile = tile();
  vm.createContext(context);
  vm.runInContext(createPeer, context);
  const peer = context.createPeerConnection('guest');
  peer.ontrack({ track });
  assert.equal(tiles[0].video.srcObject.getTracks()[0], track);
  currentTile = tile();
  track.onunmute();
  assert.equal(tiles[1].video.srcObject.getTracks()[0], track);
  assert.equal(tiles[1].frame.visible, true);
  track.onmute();
  assert.equal(tiles[1].frame.visible, true);
  assert.equal(tiles[0].cameraOff, false);
});

test('remote video exposes playback controls if autoplay fails', async () => {
  const track = { kind: 'video', readyState: 'live', muted: false };
  class Stream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    addTrack(item) { this.tracks.push(item); }
  }
  class Peer { addTransceiver() { return { sender: {} }; } }
  const tile = { video: { controls: false, play: () => Promise.reject(new Error('blocked')) }, status: {}, frame: {} };
  const errors = [];
  const context = {
    RTCPeerConnection: Peer, rtcConfig: {}, MediaStream: Stream,
    socket: { id: 'host', emit() {} }, peerConnections: {}, peerNegotiationState: {},
    peerSenders: {}, remoteMediaStreams: {}, remoteCameraStates: new Map(),
    canShowTile: () => true, ensureVideoTile: () => tile,
    setTileCameraOff() {}, setTileVisible() {},
    console: { error: (...args) => errors.push(args) }
  };
  vm.runInNewContext(createPeer, context);
  context.createPeerConnection('guest').ontrack({ track });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tile.video.controls, true);
  assert.equal(tile.status.hidden, false);
  assert.match(tile.status.textContent, /press play/);
  assert.equal(errors.length, 1);
});

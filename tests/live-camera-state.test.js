const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/live.js'), 'utf8');
const handler = source.slice(source.indexOf("  socket.off('live_camera_state');"), source.indexOf("\n  socket.off('live_guest_joined');"));
const publishMedia = source.slice(source.indexOf('async function publishLocalMedia() {'), source.indexOf('\nlet guestOnStage = false;'));
const setCameraOff = source.slice(source.indexOf('function setTileCameraOff('), source.indexOf('\n// Only the host', source.indexOf('function setTileCameraOff(')));

test('camera-off signal shows the profile and ignores our own signal', () => {
  let listener;
  const states = new Map();
  const classes = new Set();
  const tile = {
    frame: { dataset: {}, classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) } },
    video: { srcObject: { getVideoTracks: () => [{ readyState: 'live', muted: false }] } }
  };
  const context = {
    socket: { id: 'self', off() {}, on(_event, fn) { listener = fn; } },
    remoteCameraStates: states, remoteImagePeers: new Set(),
    canShowTile: id => id === 'host',
    ensureVideoTile: () => tile
  };
  vm.runInNewContext(`${setCameraOff}\n${handler}`, context);
  listener({ socketId: 'host', enabled: false });
  assert.equal(states.get('host'), false);
  assert.equal(classes.has('camera-off'), true);
  assert.equal(tile.video.hidden, true);
  listener({ socketId: 'self', enabled: true });
  assert.equal(classes.has('camera-off'), true);
  listener({ socketId: 'host', enabled: true });
  assert.equal(states.get('host'), true);
  assert.equal(classes.has('camera-off'), false);
  assert.equal(tile.video.hidden, false);
  listener({ socketId: 'host', enabled: true, image: true });
  assert.equal(tile.frame.dataset.mediaSource, 'image');
  listener({ socketId: 'host', enabled: true, image: false });
  assert.equal(tile.frame.dataset.mediaSource, 'camera');
  listener({ socketId: 'removed-guest', enabled: false });
  assert.equal(classes.has('camera-off'), false);
});

for (const image of [true, false]) {
  test(`local ${image ? 'image' : 'camera'} preview publishes its display mode`, async () => {
    const events = [];
    const tile = {
      frame: { dataset: {}, classList: { toggle() {} } },
      video: { play: () => Promise.resolve() }, status: {}
    };
    const context = {
      socket: { connected: true, emit: (...args) => events.push(args) },
      activeRoomSessionId: 'live', localVideoTrack: {}, localAudioTrack: null,
      imageStream: image ? {} : null, ensureVideoTile: () => tile,
      MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
      peerConnections: {}, peerSenders: {}, requestPeerNegotiation() {},
      console, showLiveError: error => { throw new Error(error); }
    };
    vm.runInNewContext(`${setCameraOff}\n${publishMedia}`, context);
    await context.publishLocalMedia();
    assert.equal(tile.frame.dataset.mediaSource, image ? 'image' : 'camera');
    assert.equal(events[0][1].image, image);
    assert.equal(events[0][1].enabled, true);
  });
}

for (const isGuest of [false, true]) {
  test(`${isGuest ? 'guest' : 'host'} preview shows profile immediately when the camera stops`, async () => {
    let replaced = false;
    const classes = new Set();
    const video = { srcObject: { frozenFrame: true } };
    const frame = {
      classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
      querySelector: () => video
    };
    const tile = { frame, video };
    const events = [];
    const context = {
      socket: { connected: true, emit: (...args) => events.push(args) },
      activeRoomSessionId: 'live',
      localVideoTrack: null, imageStream: null,
      localAudioTrack: null,
      guestOnStage: isGuest,
      myStageInfo: isGuest ? { name: 'Guest' } : null,
      isGuestRole: () => isGuest,
      ensureVideoTile: () => tile,
      showStageGuestTile: () => { classes.add('camera-off'); },
      ensureHostPlaceholder: () => { classes.add('camera-off'); },
      removeVideoTile: () => { throw new Error('Stage participant tile was removed'); },
      document: { querySelector: () => frame },
      peerConnections: { viewer: { connectionState: 'connected' } },
      peerSenders: { viewer: { video: { replaceTrack: () => { replaced = true; return new Promise(() => {}); } } } },
      requestPeerNegotiation: () => Promise.resolve()
    };
    vm.runInNewContext(`${setCameraOff}\n${publishMedia}`, context);
    context.publishLocalMedia();
    assert.equal(video.srcObject, null);
    assert.equal(classes.has('camera-off'), true);
    assert.equal(video.hidden, true);
    assert.equal(replaced, true);
    assert.equal(events[0][0], 'live_camera_state');
    assert.equal(events[0][1].enabled, false);
  });
}

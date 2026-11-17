const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/live.js'), 'utf8');
const stop = source.slice(source.indexOf('async function stopLocalMedia('), source.indexOf('\nfunction stopImageSource('));
const handler = source.slice(source.indexOf("  socket.off('live_remove_from_stage');"), source.indexOf("  socket.off('live_stage_guest_left');"));
const leftHandler = source.slice(source.indexOf("  socket.off('live_stage_guest_left');"), source.indexOf("  socket.off('live_member_joined');"));
const render = source.slice(source.indexOf('function renderHostGuests()'), source.indexOf('\nfunction ensureVideoTile('));
const ensureTile = source.slice(source.indexOf('function ensureVideoTile('), source.indexOf('\nconst tileInfoCache'));

test('Leave stage stops outgoing media but preserves the live room, chat and incoming peers', async () => {
  const tracks = [{ stop() { this.stopped = true; } }, { stop() { this.stopped = true; } }];
  const events = [], replacements = [], negotiated = [], removed = [];
  const room = 'room', chatInput = { value: 'Unsent chat message' };
  const connection = { connectionState: 'connected', close() { throw new Error('Viewing must remain connected'); } };
  let click;
  const publish = source.slice(source.indexOf('async function publishLocalMedia('), source.indexOf('\nlet guestOnStage'));
  const binding = source.split(/\r?\n/).find(line => line.includes("offButton.addEventListener('click'"));
  const context = {
    offButton: { addEventListener(_event, fn) { click = fn; } },
    socket: { connected: true, emit: (...args) => events.push(args) },
    isGuestRole: () => true, guestOnStage: true, guestStageGeneration: 0, hostMicrophoneGeneration: 0,
    activeRoomSessionId: room, selectedLiveSessionId: room,
    cameraStream: { getTracks: () => tracks }, localVideoTrack: tracks[0], localAudioTrack: tracks[1], guestMuted: true,
    stopCameraFilter() {}, stopImageSource() {}, updateLocalMediaControls() {},
    peerConnections: { host: connection },
    peerSenders: { host: {
      video: { replaceTrack: async track => replacements.push(['video', track]) },
      audio: { replaceTrack: async track => replacements.push(['audio', track]) }
    } },
    requestPeerNegotiation: async id => negotiated.push(id),
    removeVideoTile: id => removed.push(id),
    document: {
      querySelector: selector => selector === '.live-role-badge.is-guest' ? {} : null,
      getElementById: id => id === 'live-chat-input' ? chatInput : null
    },
    showLiveError: error => { throw new Error(error); }, console
  };
  vm.runInNewContext(`${stop}\n${publish}\n${binding}`, context);
  await click();
  assert.ok(tracks.every(track => track.stopped));
  assert.equal(context.guestOnStage, false);
  assert.equal(context.localVideoTrack, null);
  assert.equal(context.localAudioTrack, null);
  assert.deepEqual(events.map(([event]) => event), ['live_guest_leave', 'live_camera_state']);
  assert.deepEqual(replacements, [['video', null], ['audio', null]]);
  assert.deepEqual(negotiated, ['host']);
  assert.deepEqual(removed, ['self']);
  assert.equal(context.peerConnections.host, connection);
  assert.equal(context.activeRoomSessionId, room);
  assert.equal(context.selectedLiveSessionId, room);
  assert.equal(chatInput.value, 'Unsent chat message');
});

test('host removal stops guest media immediately without leaving the room', async () => {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  const listeners = new Map(), events = [], errors = [], controls = [];
  let release;
  const published = new Promise(resolve => { release = resolve; });
  const context = {
    socket: { id: 'guest', off: event => listeners.delete(event), on: (event, fn) => listeners.set(event, fn), emit: event => events.push(event) },
    isGuestRole: () => true, guestOnStage: true, guestStageGeneration: 0, hostMicrophoneGeneration: 0,
    stageGuestIds: new Set(['guest']), myStageInfo: {},
    cameraStream: { getTracks: () => tracks }, localVideoTrack: tracks[0], localAudioTrack: tracks[0], guestMuted: true,
    stopCameraFilter() {}, stopImageSource() {}, publishLocalMedia: () => published,
    updateLocalMediaControls: () => controls.push(context.guestOnStage),
    document: { querySelector: () => null, getElementById: () => null },
    showLiveError: message => errors.push(message), console
  };
  vm.createContext(context);
  vm.runInContext(`${stop}\n${handler}`, context);
  listeners.get('live_remove_from_stage')();
  assert.equal(tracks[0].stopped, true);
  assert.equal(context.guestOnStage, false);
  assert.equal(context.localAudioTrack, null);
  assert.equal(context.localVideoTrack, null);
  assert.equal(context.myStageInfo, null);
  assert.deepEqual(events, []);
  assert.deepEqual(controls, [false]);
  assert.match(errors[0], /continue watching/);
  release();
  await published;
});

test('host control confirms and sends a removal request for the selected guest', () => {
  const panel = { replaceChildren(...children) { this.children = children; } };
  const menu = { open: true };
  const document = {
    getElementById: id => id === 'live-host-panel' ? menu : panel,
    createElement() {
      return {
        style: {}, attributes: {}, children: [],
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(_name, fn) { this.click = fn; },
        append(...children) { this.children.push(...children); }
      };
    }
  };
  const events = [];
  const context = {
    document, hostGuestMuted: { guest: { name: 'Guest', muted: false } },
    window: { confirm: () => true },
    socket: { timeout: () => ({ emit: (event, data, callback) => { events.push([event, data.socketId]); callback(null, { ok: true }); } }) },
    showLiveError: error => { throw new Error(error); }
  };
  vm.runInNewContext(render, context);
  context.renderHostGuests();
  const button = panel.children[0].children[1];
  assert.equal(button.attributes['aria-label'], 'Remove Guest from stage');
  button.click();
  assert.deepEqual(events, [['live_remove_guest', 'guest']]);
  assert.equal(menu.open, false);
});

test('guest management closes on mute but remains open for cancelled or failed removal', () => {
  const panel = { replaceChildren(...children) { this.children = children; } };
  const menu = { open: true }, errors = [], events = [];
  let confirmed = false;
  const document = {
    getElementById: id => id === 'live-host-panel' ? menu : panel,
    createElement() {
      return {
        style: {}, children: [], setAttribute() {},
        addEventListener(_name, fn) { this.click = fn; },
        append(...children) { this.children.push(...children); }
      };
    }
  };
  const context = {
    document, hostGuestMuted: { guest: { name: 'Guest', muted: false } },
    window: { confirm: () => confirmed },
    socket: {
      timeout: () => ({ emit: (event, data, callback) => {
        events.push([event, data]);
        callback(null, event === 'live_mute_guest' ? { ok: true } : { ok: false, error: 'Removal failed' });
      } })
    },
    showLiveError: error => errors.push(error)
  };
  vm.runInNewContext(render, context);
  context.renderHostGuests();
  const [mute, remove] = panel.children[0].children;
  mute.click();
  assert.equal(menu.open, false);
  assert.equal(events[0][0], 'live_mute_guest');
  assert.equal(events[0][1].muted, true);
  menu.open = true;
  remove.click();
  assert.equal(menu.open, true);
  confirmed = true;
  remove.click();
  assert.equal(menu.open, true);
  assert.equal(remove.disabled, false);
  assert.deepEqual(errors, ['Removal failed']);
});

test('muted guests cannot be unmuted from host controls', () => {
  const panel = { replaceChildren(...children) { this.children = children; } };
  let emitted = false;
  const context = {
    hostGuestMuted: { guest: { name: 'Guest', muted: true } },
    document: {
      getElementById: () => panel,
      createElement: () => ({
        style: {}, children: [], setAttribute() {},
        addEventListener(_name, fn) { this.click = fn; },
        append(...children) { this.children.push(...children); }
      })
    },
    socket: { timeout() { emitted = true; } }
  };
  vm.runInNewContext(render, context);
  context.renderHostGuests();
  const button = panel.children[0].children[0];
  assert.equal(button.disabled, true);
  assert.match(button.textContent, /Muted/);
  assert.doesNotMatch(button.textContent, /Unmute/);
  button.click();
  assert.equal(emitted, false);
});

test('a failed mute request keeps the host control available and reports the error', () => {
  const panel = { replaceChildren(...children) { this.children = children; } };
  const menu = { open: true }, errors = [];
  const context = {
    hostGuestMuted: { guest: { name: 'Guest', muted: false } },
    document: {
      getElementById: id => id === 'live-host-panel' ? menu : panel,
      createElement: () => ({
        style: {}, children: [], setAttribute() {},
        addEventListener(_name, fn) { this.click = fn; },
        append(...children) { this.children.push(...children); }
      })
    },
    socket: { timeout: () => ({ emit: (_event, _data, callback) => callback(null, { ok: false, error: 'Mute failed' }) }) },
    showLiveError: error => errors.push(error)
  };
  vm.runInNewContext(render, context);
  context.renderHostGuests();
  const button = panel.children[0].children[0];
  button.click();
  assert.equal(button.disabled, false);
  assert.equal(menu.open, true);
  assert.deepEqual(errors, ['Mute failed']);
});

test('stage removal clears cached guest information and removes the stage tile', () => {
  const listeners = new Map(), removed = [];
  const context = {
    socket: { id: 'viewer', off: event => listeners.delete(event), on: (event, fn) => listeners.set(event, fn) },
    hostGuestMuted: { guest: {} }, stageGuestIds: new Set(['guest']),
    tileInfoCache: { guest: { name: 'Guest' } }, renderHostGuests() {},
    document: { querySelectorAll: () => [{ dataset: { peerId: 'guest', stageGuest: '1' } }] },
    removeVideoTile: id => removed.push(id)
  };
  vm.runInNewContext(leftHandler, context);
  listeners.get('live_stage_guest_left')({ socketId: 'guest' });
  assert.equal(context.stageGuestIds.has('guest'), false);
  assert.equal(context.tileInfoCache.guest, undefined);
  assert.deepEqual(removed, ['guest']);
});

test('stage departure stops the removed guest even if the targeted notification was missed', async () => {
  const listeners = new Map(), events = [], errors = [], removed = [];
  const track = { stopped: false, stop() { this.stopped = true; } };
  const context = {
    socket: { id: 'guest', off: event => listeners.delete(event), on: (event, fn) => listeners.set(event, fn), emit: event => events.push(event) },
    isGuestRole: () => true, guestOnStage: true, guestStageGeneration: 0, hostMicrophoneGeneration: 0,
    hostGuestMuted: {}, stageGuestIds: new Set(['guest']), tileInfoCache: {}, myStageInfo: {},
    cameraStream: { getTracks: () => [track] }, localVideoTrack: null, localAudioTrack: track, guestMuted: false,
    stopCameraFilter() {}, stopImageSource() {}, publishLocalMedia: () => Promise.resolve(),
    updateLocalMediaControls() {}, renderHostGuests() {}, removeVideoTile: id => removed.push(id),
    document: { querySelector: () => null, getElementById: () => null },
    showLiveError: error => errors.push(error), console
  };
  vm.createContext(context);
  vm.runInContext(`${stop}\n${leftHandler}`, context);
  listeners.get('live_stage_guest_left')({ socketId: 'guest' });
  assert.equal(track.stopped, true);
  assert.equal(context.guestOnStage, false);
  assert.equal(context.localAudioTrack, null);
  assert.deepEqual(events, []);
  assert.deepEqual(removed, ['self']);
  assert.match(errors[0], /continue watching/);
});

test('media renegotiation cannot restore a removed guest from stale tile information', () => {
  const frames = [], shown = [];
  const grid = { appendChild: frame => frames.push(frame) };
  const document = {
    querySelectorAll: () => frames,
    getElementById: () => grid,
    createElement() {
      return {
        dataset: {}, style: {}, setAttribute() {}, addEventListener() {},
        append() {}, querySelector() { return {}; }
      };
    }
  };
  const stageGuestIds = new Set();
  const context = {
    document, tileInfoCache: { guest: { name: 'Guest' } },
    liveHostSocketId: 'host', liveHostInfo: null, remoteImagePeers: new Set(),
    canShowTile: id => id === 'host' || stageGuestIds.has(id),
    setTileVisible(frame, visible) { frame.hidden = !visible; },
    showStageGuestTile(id) { shown.push(id); }
  };
  vm.runInNewContext(ensureTile, context);
  const tile = context.ensureVideoTile('guest', false);
  assert.equal(tile.frame.hidden, true);
  assert.deepEqual(shown, []);
});

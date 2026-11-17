const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/live.js'), 'utf8');
const camera = source.slice(source.indexOf('async function enableLocalCamera('), source.indexOf('\nasync function useLocalImage('));
const mute = source.slice(source.indexOf('function reportGuestMuteState() {'), source.indexOf('\nfunction renderHostGuests()', source.indexOf('function reportGuestMuteState() {')));
const stage = source.slice(source.indexOf('function createLiveStage('), source.indexOf('\nfunction attachLiveChatForm('));

test('a guest muted while microphone permission is pending remains muted when published', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const track = { enabled: true };
  let published;
  const context = {
    isGuestRole: () => true,
    guestOnStage: false, guestStageGeneration: 0,
    guestMuted: false,
    hostMuted: false,
    hostMicrophoneStarting: false,
    hostCameraStarting: false,
    requestGuestSlot: async () => { context.guestOnStage = true; return true; },
    navigator: { mediaDevices: { getUserMedia: () => pending } },
    audioDevices: { audioConstraints: value => value },
    HD_AUDIO_CONSTRAINTS: {},
    stopCameraFilter() {},
    stopImageSource() {},
    cameraStream: null,
    localVideoTrack: null,
    localAudioTrack: null,
    publishLocalMedia: async () => { published = track.enabled; },
    document: { getElementById: () => null },
    updateLocalMediaControls() {},
    showLiveError: message => { throw new Error(message); },
    console
  };
  vm.createContext(context);
  vm.runInContext(`${mute}\n${camera}`, context);
  const joining = context.enableLocalCamera();
  await new Promise(resolve => setImmediate(resolve));
  context.guestMuted = true;
  release({ getAudioTracks: () => [track] });
  await joining;
  assert.equal(published, false);
  assert.equal(track.enabled, false);
});

test('removing a guest while microphone permission is pending stops the late track', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const track = { stopped: false, stop() { this.stopped = true; } };
  let published = false;
  const context = {
    isGuestRole: () => true, guestOnStage: false, guestStageGeneration: 0,
    hostMicrophoneStarting: false,
    requestGuestSlot: async () => { context.guestOnStage = true; return true; },
    navigator: { mediaDevices: { getUserMedia: () => pending } },
    audioDevices: { audioConstraints: value => value }, HD_AUDIO_CONSTRAINTS: {},
    publishLocalMedia: async () => { published = true; }, console
  };
  vm.runInNewContext(camera, context);
  const joining = context.enableLocalCamera();
  await new Promise(resolve => setImmediate(resolve));
  context.guestOnStage = false;
  context.guestStageGeneration++;
  release({ getTracks: () => [track] });
  await joining;
  assert.equal(track.stopped, true);
  assert.equal(published, false);
});

test('host and guest each have one self-mute control', () => {
  const context = { escapeHtml: value => value, liveAvatarHtml: () => '' };
  vm.runInNewContext(stage, context);
  for (const host of [true, false]) {
    const markup = context.createLiveStage('', host);
    assert.equal((markup.match(/id="live-self-mute-btn"/g) || []).length, 1);
    assert.ok(markup.indexOf('id="live-self-mute-btn"') < markup.indexOf('id="live-media-menu"'));
  }
});

test('primary media controls stay visible and secondary controls are in settings', () => {
  const context = { escapeHtml: value => value, liveAvatarHtml: () => '' };
  vm.runInNewContext(stage, context);
  for (const host of [true, false]) {
    const markup = context.createLiveStage('', host);
    const panel = markup.indexOf('id="live-media-menu-panel"');
    const input = markup.indexOf('id="live-chat-input"');
    for (const id of ['live-share-btn', 'live-audio-devices-btn', 'live-camera-filter', 'live-mirror-camera-btn', 'live-select-image-btn', 'live-remove-image-btn', 'live-turn-media-off-btn']) {
      assert.ok(markup.indexOf(`id="${id}"`) > panel && markup.indexOf(`id="${id}"`) < input, id);
      assert.equal(markup.split(`id="${id}"`).length - 1, 1);
    }
    for (const id of ['live-enable-camera-btn']) {
      assert.ok(markup.indexOf(`id="${id}"`) < panel, id);
      assert.equal(markup.split(`id="${id}"`).length - 1, 1);
    }
  }
});

test('settings menu follows language direction and stays within the viewport', () => {
  const start = source.indexOf('  const setMenuOpen = (open) => {');
  const end = source.indexOf('\n  if (menu && menuButton && menuPanel)', start);
  const styles = { direction: 'rtl' };
  const panel = { hidden: true, offsetWidth: 260, style: {} };
  const button = { getBoundingClientRect: () => ({ left: 8, right: 75, top: 500 }), setAttribute() {} };
  const viewport = { clientWidth: 320, clientHeight: 700 };
  const context = { menuPanel: panel, menuButton: button, getComputedStyle: () => styles,
    document: { documentElement: viewport }, window: { innerWidth: 336, innerHeight: 716 } };
  vm.runInNewContext(`${source.slice(start, end)}\nthis.setMenuOpen = setMenuOpen;`, context);
  context.setMenuOpen(true);
  assert.equal(panel.style.left, '8px');
  assert.equal(panel.style.right, 'auto');
  assert.equal(panel.style.bottom, '206px', 'position excludes scrollbar space');
  button.getBoundingClientRect = () => ({ left: 300, right: 320, top: 500 });
  context.setMenuOpen(true);
  assert.equal(panel.style.left, '52px');
  styles.direction = 'ltr';
  context.setMenuOpen(true);
  assert.equal(panel.style.left, 'auto');
  assert.equal(panel.style.right, '8px');
  for (const viewportWidth of [280, 320, 390]) {
    viewport.clientWidth = viewportWidth;
    for (const right of [90, 180, viewportWidth - 8]) {
      button.getBoundingClientRect = () => ({ left: right - 70, right, top: 500 });
      context.setMenuOpen(true);
      const actualRight = viewportWidth - Number.parseFloat(panel.style.right);
      const actualLeft = actualRight - panel.offsetWidth;
      assert.ok(actualLeft >= 8, `menu left edge is visible at ${viewportWidth}px with button right ${right}px`);
      assert.ok(actualRight <= viewportWidth - 8, 'menu right edge stays within the viewport');
    }
  }
});

test('live title remains visible without an in-session editor for hosts or guests', () => {
  const context = { escapeHtml: value => value, liveAvatarHtml: () => '' };
  vm.runInNewContext(stage, context);
  for (const host of [true, false]) {
    const markup = context.createLiveStage('', host, 'Host', 'My live');
    assert.match(markup, /id="live-title-text">My live<\/small>/);
    assert.doesNotMatch(markup, /live-edit-title-btn|live-title-inline/);
  }
  assert.doesNotMatch(source, /live-edit-title-btn|live-title-inline/);
});

for (const guest of [false, true]) {
  test(`${guest ? 'guest' : 'host'} self-mute changes only its own microphone`, () => {
    const track = { enabled: true };
    const events = [];
    const button = { hidden: true, setAttribute(name, value) { this[name] = value; } };
    const context = {
      localAudioTrack: track, guestMuted: false, hostMuted: false, hostMicrophoneStarting: false, hostCameraStarting: false,
      isGuestRole: () => guest,
      document: { getElementById: id => id === 'live-self-mute-btn' ? button : null },
      socket: { timeout: () => ({ emit: (event, data, callback) => { events.push([event, data]); callback(null, { ok: true }); } }) }
    };
    vm.runInNewContext(mute, context);
    context.applyMute();
    assert.equal(button.hidden, false);
    context.toggleSelfMute();
    assert.equal(track.enabled, false);
    assert.equal(button['aria-pressed'], 'true');
    assert.equal(button['aria-label'], 'Unmute me');
    assert.equal(events.length, guest ? 1 : 0);
    if (guest) assert.equal(events[0][1].muted, true);
    context.toggleSelfMute();
    assert.equal(track.enabled, true);
    assert.equal(button['aria-pressed'], 'false');
    assert.equal(button['aria-label'], 'Mute me');
  });
}

test('a guest stays muted on remote unmute and can unmute their own microphone', () => {
  const handlers = new Map(), events = [];
  const track = { enabled: true };
  const status = { textContent: '' };
  const context = {
    localAudioTrack: track, guestMuted: false, hostMuted: false,
    hostMicrophoneStarting: false, hostCameraStarting: false,
    isGuestRole: () => true,
    document: { getElementById: id => id === 'live-media-status' ? status : null },
    socket: {
      off: event => handlers.delete(event),
      on: (event, fn) => handlers.set(event, fn),
      timeout: () => ({ emit(event, data, callback) { events.push([event, data.muted]); callback(null, { ok: true }); } })
    }
  };
  const handler = source.slice(source.indexOf("  socket.off('live_force_mute');"), source.indexOf("  socket.off('live_guest_request_cancel');"));
  vm.runInNewContext(mute + handler, context);
  handlers.get('live_force_mute')({ muted: true });
  assert.equal(track.enabled, false);
  assert.match(status.textContent, /unmute yourself/);
  handlers.get('live_force_mute')({ muted: false });
  assert.equal(track.enabled, false);
  context.toggleSelfMute();
  assert.equal(track.enabled, true);
  assert.equal(status.textContent, '');
  assert.deepEqual(events, [['live_self_mute', true], ['live_self_mute', false]]);
});

test('guest retains microphone choice if notifying the host fails', () => {
  const errors = [], track = { enabled: true };
  const context = {
    localAudioTrack: track, guestMuted: false, hostMuted: false,
    hostMicrophoneStarting: false, hostCameraStarting: false,
    isGuestRole: () => true,
    document: { getElementById: () => null },
    socket: { timeout: () => ({ emit: (_event, _data, callback) => callback(null, { ok: false, error: 'Notification failed' }) }) },
    showLiveError: error => errors.push(error)
  };
  vm.runInNewContext(mute, context);
  context.toggleSelfMute();
  assert.equal(track.enabled, false);
  assert.deepEqual(errors, ['Notification failed']);
});

test('host mute remains applied when a microphone is acquired again', async () => {
  const track = { enabled: true };
  let published;
  const context = {
    isGuestRole: () => false, guestOnStage: false, guestStageGeneration: 0, guestMuted: false, hostMuted: true, hostMicrophoneStarting: false, hostCameraStarting: false, hostMicrophoneStopped: false,
    requestGuestSlot: async () => true,
    navigator: { mediaDevices: { getUserMedia: async () => ({
      getAudioTracks: () => [track], getVideoTracks: () => [], getTracks: () => [track]
    }) } },
    audioDevices: { audioConstraints: value => value },
    HD_AUDIO_CONSTRAINTS: {}, HD_VIDEO_CONSTRAINTS: {},
    stopCameraFilter() {}, stopImageSource() {}, cameraStream: null,
    localVideoTrack: null, localAudioTrack: null, cameraMirrored: false,
    publishLocalMedia: async () => { published = track.enabled; },
    document: { getElementById: () => null }, updateLocalMediaControls() {},
    showLiveError: message => { throw new Error(message); }, console
  };
  vm.createContext(context);
  vm.runInContext(`${mute}\n${camera}`, context);
  await context.enableLocalCamera();
  assert.equal(published, false);
  assert.equal(track.enabled, false);
});

test('host starts audio without camera and can mute it', async () => {
  const track = { enabled: true, stop() {} };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const requests = [];
  const button = { setAttribute(name, value) { this[name] = value; } };
  let published;
  const context = {
    isGuestRole: () => false, guestMuted: false, hostMuted: false,
    hostMicrophoneStarting: false, hostCameraStarting: false, hostMicrophoneGeneration: 0,
    selectedLiveSessionId: 'live', localAudioTrack: null, cameraStream: null,
    navigator: { mediaDevices: { getUserMedia: async constraints => { requests.push(constraints); return stream; } } },
    audioDevices: { audioConstraints: value => value }, HD_AUDIO_CONSTRAINTS: {},
    document: { getElementById: id => id === 'live-self-mute-btn' ? button : null },
    publishLocalMedia: async () => { published = track.enabled; },
    updateLocalMediaControls() {}, showLiveError: message => { throw new Error(message); }, console
  };
  vm.createContext(context);
  vm.runInContext(mute, context);
  context.applyMute();
  assert.equal(button.hidden, false);
  assert.equal(button['aria-label'], 'Start microphone');
  await context.startHostMicrophone();
  assert.equal(requests[0].video, undefined);
  assert.equal(published, true);
  assert.equal(context.localAudioTrack, track);
  context.toggleSelfMute();
  assert.equal(track.enabled, false);
});

test('late microphone permission after leaving stops the acquired track', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const track = { stopped: false, stop() { this.stopped = true; } };
  const context = {
    isGuestRole: () => false, guestMuted: false, hostMuted: false,
    hostMicrophoneStarting: false, hostCameraStarting: false, hostMicrophoneGeneration: 0,
    selectedLiveSessionId: 'live', localAudioTrack: null, cameraStream: null,
    navigator: { mediaDevices: { getUserMedia: () => pending } },
    audioDevices: { audioConstraints: value => value }, HD_AUDIO_CONSTRAINTS: {},
    document: { getElementById: () => null }, publishLocalMedia: () => { throw new Error('must not publish'); },
    showLiveError: message => { throw new Error(message); }, console
  };
  vm.createContext(context);
  vm.runInContext(mute, context);
  const starting = context.startHostMicrophone();
  context.hostMicrophoneGeneration++;
  release({ getAudioTracks: () => [track], getTracks: () => [track] });
  await starting;
  assert.equal(track.stopped, true);
  assert.equal(context.localAudioTrack, null);
});

test('microphone permission denial is reported and the host can retry', async () => {
  const errors = [];
  const button = { setAttribute(name, value) { this[name] = value; } };
  const context = {
    isGuestRole: () => false, guestMuted: false, hostMuted: false,
    hostMicrophoneStarting: false, hostCameraStarting: false, hostMicrophoneGeneration: 0,
    selectedLiveSessionId: 'live', localAudioTrack: null, cameraStream: null,
    navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('denied'); } } },
    audioDevices: { audioConstraints: value => value }, HD_AUDIO_CONSTRAINTS: {},
    document: { getElementById: id => id === 'live-self-mute-btn' ? button : null },
    showLiveError: message => errors.push(message), console: { error() {} }
  };
  vm.createContext(context);
  vm.runInContext(mute, context);
  await context.startHostMicrophone();
  assert.match(errors[0], /permissions/);
  assert.equal(context.localAudioTrack, null);
  assert.equal(button.disabled, false);
  assert.equal(button['aria-label'], 'Start microphone');
});

test('failed publication stops the microphone before rolling back', async () => {
  const errors = [];
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  const stream = { tracks: [track], getAudioTracks: () => [track], getTracks() { return this.tracks; }, removeTrack(t) { this.tracks = this.tracks.filter(item => item !== t); } };
  let attempts = 0;
  const context = {
    isGuestRole: () => false, guestMuted: false, hostMuted: false,
    hostMicrophoneStarting: false, hostCameraStarting: false, hostMicrophoneGeneration: 0,
    selectedLiveSessionId: 'live', localAudioTrack: null, cameraStream: null,
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    audioDevices: { audioConstraints: value => value }, HD_AUDIO_CONSTRAINTS: {},
    document: { getElementById: () => null }, console: { error() {} },
    publishLocalMedia: async () => { attempts++; if (attempts === 1) throw new Error('publish failed'); assert.equal(track.stopped, true); },
    showLiveError: message => errors.push(message)
  };
  vm.createContext(context);
  vm.runInContext(mute, context);
  await context.startHostMicrophone();
  assert.equal(attempts, 2);
  assert.equal(context.localAudioTrack, null);
  assert.equal(context.cameraStream, null);
  assert.match(errors[0], /Could not start/);
});

test('host can stop the microphone without stopping camera video', async () => {
  const audio = { stopped: false, stop() { this.stopped = true; } };
  const video = { stopped: false, stop() { this.stopped = true; } };
  const stream = { tracks: [audio, video], getTracks() { return this.tracks; }, removeTrack(track) { this.tracks = this.tracks.filter(item => item !== track); } };
  let published = false;
  const context = {
    isGuestRole: () => false, guestMuted: false, hostMuted: false,
    hostMicrophoneStarting: false, hostCameraStarting: false, hostMicrophoneGeneration: 0,
    localAudioTrack: audio, cameraStream: stream,
    document: { getElementById: () => null }, updateLocalMediaControls() {},
    publishLocalMedia: async () => { published = true; assert.equal(audio.stopped, true); },
    showLiveError: message => { throw new Error(message); }, console
  };
  vm.createContext(context);
  vm.runInContext(mute, context);
  await context.stopHostMicrophone();
  assert.equal(published, true);
  assert.equal(context.localAudioTrack, null);
  assert.equal(context.hostMicrophoneStopped, true);
  assert.equal(video.stopped, false);
  assert.deepEqual(stream.tracks, [video]);
});

test('opening the host camera does not restart an explicitly stopped microphone', async () => {
  const requests = [];
  const stream = { getAudioTracks: () => [], getVideoTracks: () => [], getTracks: () => [] };
  const context = {
    isGuestRole: () => false, guestOnStage: false, guestStageGeneration: 0, guestMuted: false, hostMuted: false,
    hostMicrophoneStarting: false, hostCameraStarting: false, hostMicrophoneStopped: true,
    requestGuestSlot: async () => true,
    navigator: { mediaDevices: { getUserMedia: async constraints => { requests.push(constraints); return stream; } } },
    audioDevices: { audioConstraints: value => value }, HD_AUDIO_CONSTRAINTS: {}, HD_VIDEO_CONSTRAINTS: {},
    stopCameraFilter() {}, stopImageSource() {}, cameraStream: null, localVideoTrack: null,
    localAudioTrack: null, cameraMirrored: false, publishLocalMedia: async () => {},
    document: { getElementById: () => null }, updateLocalMediaControls() {},
    showLiveError: message => { throw new Error(message); }, console
  };
  vm.createContext(context);
  vm.runInContext(`${mute}\n${camera}`, context);
  await context.enableLocalCamera();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].audio, false);
});

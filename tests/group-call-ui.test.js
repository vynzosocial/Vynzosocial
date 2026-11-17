const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'group-call-ui.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export function createGroupCallUI', 'function createGroupCallUI');
const nameSource = fs.readFileSync(path.join(__dirname, '../frontend/js/call-participant-name.js'), 'utf8')
  .replace('export function', 'function');
const cameraSource = fs.readFileSync(path.join(__dirname, '../frontend/js/camera-devices.js'), 'utf8').replace(/^export /gm, '');

function setup(video) {
  const elements = [];
  const messages = [];
  const protections = [];
  let resolveInvite;
  let rejectInvite;
  let invitedId;
  let service;
  function element(tag) {
    const classes = new Set();
    const node = {
      tag, children: [], listeners: {}, dataset: {},
      style: { setProperty(name, value) { this[name] = value; } },
      getBoundingClientRect: () => ({ height: 52 }),
      contains(target) { return target === this || this.children.some(child => child.contains(target)); },
      get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); },
      set textContent(value) { this.text = String(value); this.children = []; },
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        toggle(name, force) {
          const value = force === undefined ? !classes.has(name) : force;
          if (value) classes.add(name); else classes.delete(name);
          return value;
        },
        contains(name) { return classes.has(name); }
      },
      setAttribute(name, value) { this[name] = value; },
      append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } },
      replaceChildren(...children) { this.children = []; this.text = ''; this.append(...children); },
      remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
        this.parent = null;
      },
      querySelector(selector) {
        const find = item => {
          if (selector.startsWith('.') && item.className?.split(' ').includes(selector.slice(1))) return item;
          const match = selector.match(/^\[data-peer="([^"]+)"\]$/);
          if (match && item.dataset.peer === match[1]) return item;
          for (const child of item.children) { const result = find(child); if (result) return result; }
          return null;
        };
        return find(this);
      },
      querySelectorAll(selector) {
        const found = [];
        function visit(item) {
          if (selector === '[data-peer]' && item.dataset.peer) found.push(item);
          for (const child of item.children) visit(child);
        }
        visit(this);
        return found;
      },
      addEventListener(name, callback) { this.listeners[name] = callback; }
    };
    elements.push(node);
    return node;
  }
  const stream = { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] };
  class Service {
    constructor(callbacks) { this.callbacks = callbacks; service = this; }
    startPolling() {}
    async create() { this.call = { video, participants: [], stream }; }
    async pendingInvitation(callId) { return { callId, video }; }
    async accept(callId) { this.call = { callId, video, participants: [], stream }; }
    async leave() { this.call = null; this.callbacks.onChange(null, 'You left the call.'); }
    invite(id) {
      invitedId = id;
      return new Promise((resolve, reject) => { resolveInvite = resolve; rejectInvite = reject; });
    }
  }
  const body = element('body');
  const context = {
    document: { createElement: element, body },
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    GroupCallService: Service,
    createAudioDevices: () => ({ audioConstraints: value => value, reset() {}, applyOutput: async () => {} }),
    API_ORIGIN: 'https://example.test',
    apiRequest: async () => ({ friends: [{ id: 'friend-1', display_name: 'Friend' }] }),
    console
  };
  vm.runInNewContext(`${cameraSource}\n${nameSource}\n${source}\nthis.createUI = createGroupCallUI;`, context);
  const ui = context.createUI({
    isBusy: () => false, showToast: message => messages.push(message),
    ensureStyles() {}, startRingtone() {}, stopRingtone() {},
    setVideoProtection: enabled => protections.push(enabled)
  });
  return {
    ui, body, elements, messages, service, protections, context,
    get invitedId() { return invitedId; },
    resolveInvite: () => resolveInvite(),
    rejectInvite: error => rejectInvite(error)
  };
}

test('video protection follows the active call and is not enabled for voice calls', async () => {
  const video = setup(true);
  await video.ui.start({ targetId: 'other', video: true });
  assert.deepEqual(video.protections, [true]);
  await video.service.leave();
  assert.deepEqual(video.protections, [true, false]);
  const voice = setup(false);
  await voice.ui.start({ targetId: 'other', video: false });
  await voice.service.leave();
  assert.deepEqual(voice.protections, []);
});

test('one-to-one video shows the remote participant large and swaps without replacing streams', async () => {
  const state = setup(true);
  const localStream = { getTracks: () => [] };
  state.service.create = async () => {
    state.service.userId = 'self';
    state.service.call = { video: true, participants: [{ id: 'self' }, { id: 'other' }], stream: localStream };
  };
  await state.ui.start({ targetId: 'other', video: true });
  const grid = state.body.querySelector('.group-call-grid');
  const local = grid.querySelector('[data-peer="self"]');
  const remote = grid.querySelector('[data-peer="other"]');
  assert.equal(grid.classList.contains('is-one-to-one'), true);
  assert.equal(local.classList.contains('is-call-inset'), true);
  assert.equal(remote.classList.contains('is-call-inset'), false);
  const localVideo = local.children[0];
  assert.equal(localVideo.srcObject, localStream);
  local.querySelector('.call-swap-video').listeners.click();
  assert.equal(local.classList.contains('is-call-inset'), false);
  assert.equal(remote.classList.contains('is-call-inset'), true);
  assert.equal(local.children[0], localVideo);
  assert.equal(localVideo.srcObject, localStream);
  state.service.callbacks.onChange(state.service.call);
  assert.equal(remote.classList.contains('is-call-inset'), true);
  remote.querySelector('.call-swap-video').listeners.click();
  assert.equal(local.classList.contains('is-call-inset'), true);
  state.service.call.participants.push({ id: 'third' });
  state.service.callbacks.onChange(state.service.call);
  assert.equal(grid.classList.contains('is-one-to-one'), false);
  assert.equal(local.classList.contains('is-call-inset'), false);
});

test('mirror affects only the local preview and persists through swaps and participant updates', async () => {
  const state = setup(true);
  const stream = { getTracks: () => [] };
  state.service.create = async () => {
    state.service.userId = 'self';
    state.service.call = { video: true, participants: [{ id: 'self' }, { id: 'other' }], stream };
  };
  await state.ui.start({ targetId: 'other', video: true });
  const grid = state.body.querySelector('.group-call-grid');
  const local = grid.querySelector('[data-peer="self"]');
  const remote = grid.querySelector('[data-peer="other"]');
  const mirror = state.elements.find(node => node.textContent === 'Mirror');
  assert.equal(mirror['aria-pressed'], 'false');
  mirror.listeners.click({ currentTarget: mirror });
  assert.equal(mirror['aria-pressed'], 'true');
  assert.equal(local.classList.contains('is-preview-mirrored'), true);
  assert.equal(remote.classList.contains('is-preview-mirrored'), false);
  local.querySelector('.call-swap-video').listeners.click();
  state.service.callbacks.onChange(state.service.call);
  assert.equal(local.classList.contains('is-preview-mirrored'), true);
  assert.equal(local.children[0].srcObject, stream);
  mirror.listeners.click({ currentTarget: mirror });
  assert.equal(local.classList.contains('is-preview-mirrored'), false);
  assert.equal(mirror['aria-pressed'], 'false');
});

test('video call camera switching updates outgoing video and keeps audio and camera-off state', async () => {
  const state = setup(true);
  const oldCamera = {
    kind: 'video', enabled: false, stopped: false,
    getSettings: () => ({ facingMode: 'user' }),
    stop() { this.stopped = true; }
  };
  const microphone = { kind: 'audio', enabled: false };
  const tracks = [oldCamera, microphone];
  const stream = {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter(track => track.kind === 'video'),
    removeTrack(track) { tracks.splice(tracks.indexOf(track), 1); },
    addTrack(track) { tracks.push(track); }
  };
  const newCamera = { kind: 'video', enabled: true, stop() {} };
  state.service.create = async () => { state.service.call = { video: true, participants: [], stream }; };
  await state.ui.start({ targetId: 'other', video: true });
  let replacement;
  state.service.mesh = { async replaceVideoTrack(oldTrack, nextTrack) { replacement = [oldTrack, nextTrack]; } };
  state.context.navigator.mediaDevices.getUserMedia = async constraints => {
    assert.equal(constraints.audio, false);
    assert.equal(constraints.video.facingMode.exact, 'environment');
    assert.equal(oldCamera.stopped, true);
    return { getTracks: () => [newCamera], getVideoTracks: () => [newCamera] };
  };
  const flip = state.elements.find(node => node.textContent === 'Switch camera');
  await flip.listeners.click({ currentTarget: flip });
  assert.deepEqual(replacement, [oldCamera, newCamera]);
  assert.equal(stream.getVideoTracks()[0], newCamera);
  assert.ok(tracks.includes(microphone));
  assert.equal(microphone.enabled, false);
  assert.equal(newCamera.enabled, false);
  assert.equal(flip.disabled, false);
  assert.deepEqual(state.messages, []);
});

test('web marker updates without replacing participant video', async () => {
  const state = setup(true);
  const stream = { getTracks: () => [] };
  state.service.create = async () => {
    state.service.userId = 'self';
    state.service.call = { video: true, participants: [{ id: 'self', platform: 'app' }, { id: 'other', display_name: 'Guest' }], stream };
  };
  await state.ui.start({ targetId: 'other', video: true });
  const grid = state.body.querySelector('.group-call-grid');
  const remote = grid.querySelector('[data-peer="other"]');
  const video = remote.children[0];
  assert.equal(remote.querySelector('.group-call-name').textContent, 'Guest');
  state.service.call.participants[1].platform = 'web';
  state.service.callbacks.onChange(state.service.call);
  const badge = remote.querySelector('.call-web-badge');
  assert.equal(badge.textContent, 'W');
  assert.equal(badge['aria-label'], 'Using the website or desktop app');
  assert.equal(remote.querySelector('.call-participant-name').textContent, 'Guest');
  assert.equal(remote.children[0], video);
  state.service.call.participants[1].platform = 'app';
  state.service.callbacks.onChange(state.service.call);
  assert.equal(remote.querySelector('.group-call-name').textContent, 'Guest');
  assert.equal(remote.querySelector('.call-web-badge'), null);
});

test('voice calls use the avatar layout without changing video-call layout', async () => {
  for (const video of [false, true]) {
    const state = setup(video);
    await state.ui.start({ targetId: 'other', video });
    assert.equal(state.body.querySelector('.group-call-panel').classList.contains('is-voice-call'), !video);
  }
});

test('voice grid adapts between one, two and three columns without replacing media', async () => {
  const state = setup(false);
  state.service.create = async () => {
    state.service.userId = 'self';
    state.service.call = { video: false, participants: [{ id: 'self' }], stream: { getTracks: () => [] } };
  };
  await state.ui.start({ targetId: 'other', video: false });
  const grid = state.body.querySelector('.group-call-grid');
  const video = grid.querySelector('[data-peer="self"]').children[0];
  for (const count of [1, 2, 3, 4, 5, 6, 4, 2]) {
    state.service.call.participants = Array.from({ length: count }, (_, i) => ({ id: i === 0 ? 'self' : `peer-${i}` }));
    state.service.callbacks.onChange(state.service.call);
    assert.equal(grid.dataset.voiceColumns, String(count === 1 ? 1 : count <= 4 ? 2 : 3));
    assert.equal(grid.dataset.voiceRows, String(count <= 2 ? 1 : 2));
    assert.equal(grid.querySelector('[data-peer="self"]').children[0], video);
  }
});

test('full voice calls count pending invitations when opening the invite list', async () => {
  for (const active of [4, 6]) {
    const state = setup(false);
    await state.ui.start({ targetId: 'other', video: false });
    state.service.call.participants = Array.from({ length: active }, (_, i) => ({ id: String(i) }));
    state.service.call.pending = Array.from({ length: 6 - active }, (_, i) => ({ id: `pending-${i}` }));
    await state.elements.find(node => node.textContent === 'Invite').listeners.click();
    assert.equal(state.body.querySelector('.group-call-friends'), null);
    assert.deepEqual(state.messages, ['This voice call is full (maximum 6 people).']);
  }
});

for (const video of [false, true]) {
  test(`incoming ${video ? 'video' : 'voice'} call uses the dedicated action layout`, () => {
    const state = setup(video);
    state.service.callbacks.onIncoming({ callId: 'call', video, from: { username: 'host' } });
    const panel = state.body.querySelector('.group-call-incoming');
    assert.ok(panel);
    assert.ok(state.elements.find(node => node.textContent === 'Decline'));
    assert.ok(state.elements.find(node => node.textContent === 'Accept'));
  });

  test(`notification tap joins a pending ${video ? 'video' : 'voice'} call`, async () => {
    const state = setup(video);
    await state.ui.openNotification('call');
    assert.equal(state.service.call.callId, 'call');
    assert.ok(state.body.querySelector('.group-call-panel'));
    assert.deepEqual(state.messages, []);
  });

  test(`${video ? 'video' : 'voice'} call hides the friends list only after a successful invitation`, async () => {
    const state = setup(video);
    await state.ui.start({ targetId: 'original', video });
    await state.elements.find(node => node.textContent === 'Invite').listeners.click();
    const panel = state.body.querySelector('.group-call-friends');
    const row = panel.children[0];
    const invitation = row.listeners.click();
    assert.equal(state.invitedId, 'friend-1');
    assert.equal(row.disabled, true);
    assert.equal(state.body.querySelector('.group-call-friends'), panel);
    state.resolveInvite();
    await invitation;
    assert.equal(state.body.querySelector('.group-call-friends'), null);
    assert.ok(state.body.querySelector('.group-call-panel'));
    await state.elements.find(node => node.textContent === 'Invite').listeners.click();
    assert.ok(state.body.querySelector('.group-call-friends'));
  });
}

test('incoming call shows the caller profile photo with an initial fallback', () => {
  const state = setup(false);
  state.service.callbacks.onIncoming({ callId: 'call', from: { display_name: 'Alice', avatar_url: '/alice.png' } });
  const avatar = state.body.querySelector('.group-call-avatar');
  assert.equal(avatar.children[0].textContent, 'A');
  assert.equal(avatar.children[1].src, 'https://example.test/alice.png');
  avatar.children[1].listeners.error();
  assert.equal(avatar.children.length, 1);
});

for (const video of [false, true]) {
  test(`${video ? 'video' : 'voice'} call displays participant profile images`, async () => {
    const state = setup(video);
    state.service.create = async () => {
      state.service.userId = 'self';
      state.service.call = { video, participants: [{ id: 'self', display_name: 'Alice', avatar_url: 'https://example.test/alice.png' }, { id: 'other', display_name: 'Bob', avatar_url: '/bob.png' }], stream: { getTracks: () => [] } };
    };
    await state.ui.start({ targetId: 'other', video });
    const avatars = state.elements.filter(node => node.className === 'group-call-avatar');
    assert.equal(avatars.length, 2);
    assert.equal(avatars[0].children[1].src, 'https://example.test/alice.png');
    assert.equal(avatars[1].children[1].src, 'https://example.test/bob.png');
  });
}
test('notification tap reports an expired invitation without joining', async () => {
  const state = setup(false);
  state.service.pendingInvitation = async () => { throw new Error('This call invitation has ended.'); };
  await state.ui.openNotification('old');
  assert.equal(state.service.call, undefined);
  assert.deepEqual(state.messages, ['This call invitation has ended.']);
});

for (const video of [false, true]) {
  test(`invited guest can leave a ${video ? 'video' : 'voice'} call`, async () => {
    const state = setup(video);
    state.service.callbacks.onIncoming({ callId: 'call', video, from: { username: 'host' } });
    await state.elements.find(node => node.textContent === 'Accept').listeners.click();
    assert.ok(state.body.querySelector('.group-call-panel'));
    state.elements.find(node => node.textContent === 'Leave').listeners.click();
    assert.equal(state.body.querySelector('.group-call-panel'), null);
    assert.equal(state.service.call, null);
    assert.deepEqual(state.messages, ['You left the call.']);
  });
}

for (const dismissed of [false, true]) {
  test(`a failed invitation reports its error ${dismissed ? 'after the picker is dismissed' : 'and allows retry'}`, async () => {
    const state = setup(false);
    await state.ui.start({ targetId: 'original', video: false });
    await state.elements.find(node => node.textContent === 'Invite').listeners.click();
    const panel = state.body.querySelector('.group-call-friends');
    const row = panel.children[0];
    const invitation = row.listeners.click();
    if (dismissed) {
      const overlay = state.body.querySelector('.call-overlay');
      overlay.listeners.click({ target: overlay.querySelector('.group-call-grid') });
    }
    state.rejectInvite(new Error('Invitation failed'));
    await invitation;
    assert.equal(state.body.querySelector('.group-call-friends'), dismissed ? null : panel);
    assert.equal(row.disabled, false);
    assert.deepEqual(state.messages, ['Invitation failed']);
  });
}

for (const video of [false, true]) {
  test(`${video ? 'video' : 'voice'} invite picker closes outside or with Escape without leaving the call`, async () => {
    const state = setup(video);
    await state.ui.start({ targetId: 'other', video });
    const overlay = state.body.querySelector('.call-overlay');
    const invite = state.elements.find(node => node.textContent === 'Invite');
    await invite.listeners.click();
    const friends = overlay.querySelector('.group-call-friends');
    overlay.listeners.click({ target: friends.children[0] });
    overlay.listeners.click({ target: invite });
    assert.equal(overlay.querySelector('.group-call-friends'), friends);
    overlay.listeners.click({ target: overlay.querySelector('.group-call-grid') });
    assert.equal(overlay.querySelector('.group-call-friends'), null);
    assert.ok(state.service.call);
    await invite.listeners.click();
    overlay.listeners.keydown({ key: 'Escape' });
    assert.equal(overlay.querySelector('.group-call-friends'), null);
    assert.ok(state.service.call);
  });
}

test('dismissed loading invite lists do not reappear after friends arrive', async () => {
  const state = setup(true);
  let resolveFriends;
  state.context.apiRequest = () => new Promise(resolve => { resolveFriends = resolve; });
  await state.ui.start({ targetId: 'other', video: true });
  const overlay = state.body.querySelector('.call-overlay');
  const opening = state.elements.find(node => node.textContent === 'Invite').listeners.click();
  overlay.listeners.click({ target: overlay.querySelector('.group-call-grid') });
  resolveFriends({ friends: [{ id: 'later', username: 'Late friend' }] });
  await opening;
  assert.equal(overlay.querySelector('.group-call-friends'), null);
  assert.deepEqual(state.messages, []);
});

test('dismissed loading invite lists log failures without showing obsolete notifications', async () => {
  const state = setup(true);
  const logged = [];
  state.context.console = { error: (...args) => logged.push(args) };
  let rejectFriends;
  state.context.apiRequest = () => new Promise((resolve, reject) => { rejectFriends = reject; });
  await state.ui.start({ targetId: 'other', video: true });
  const overlay = state.body.querySelector('.call-overlay');
  const opening = state.elements.find(node => node.textContent === 'Invite').listeners.click();
  overlay.listeners.click({ target: overlay.querySelector('.group-call-grid') });
  const error = new Error('Friends request failed');
  rejectFriends(error);
  await opening;
  assert.equal(overlay.querySelector('.group-call-friends'), null);
  assert.deepEqual(state.messages, []);
  assert.deepEqual(logged, [['Could not load call friends:', error]]);
});

test('video controls update the name clearance as rows wrap and release their observer on close', async () => {
  const state = setup(true);
  let resize, observed, disconnected = false;
  state.context.ResizeObserver = class {
    constructor(callback) { resize = callback; }
    observe(element) { observed = element; }
    disconnect() { disconnected = true; }
  };
  await state.ui.start({ targetId: 'other', video: true });
  const panel = state.body.querySelector('.group-call-panel');
  assert.equal(panel.style['--call-actions-height'], '52px');
  observed.getBoundingClientRect = () => ({ height: 132 });
  resize();
  assert.equal(panel.style['--call-actions-height'], '132px');
  await state.service.leave();
  assert.equal(disconnected, true);
});

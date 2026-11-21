const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/live.js'), 'utf8');
const stage = source.slice(source.indexOf('function createLiveStage('), source.indexOf('\nfunction attachLiveChatForm('));
const controls = source.slice(source.indexOf('function updateLocalMediaControls('), source.indexOf('\nfunction applyCameraMirror('));
const cameraOff = source.slice(source.indexOf('async function turnCameraOff()'), source.indexOf('\nasync function enableLocalCamera('));
const useImage = source.slice(source.indexOf('async function useLocalImage('), source.indexOf('\nasync function publishLocalMedia('));
const fit = source.slice(source.indexOf('const LIVE_IMAGE_TYPES'), source.indexOf('\nasync function publishLocalMedia('));
const request = source.slice(source.indexOf('function requestGuestSlot('), source.indexOf('\nasync function stopLocalMedia('));

test('host and guest have visible image controls and guests have a direct request button', () => {
  const context = { escapeHtml: value => value, liveAvatarHtml: () => '' };
  vm.runInNewContext(stage, context);
  for (const guest of [false, true]) {
    const markup = context.createLiveStage('', !guest);
    assert.match(markup, /id="live-select-image-btn"/);
    assert.match(markup, /id="live-remove-image-btn" hidden/);
    assert.equal(markup.includes('id="live-request-stage-btn"'), guest);
    if (guest) assert.match(markup, /id="live-enable-camera-btn"[^>]* hidden>/);
  }
});

for (const guest of [false, true]) {
  test(`${guest ? 'guest' : 'host'} can remove an image without stopping audio or leaving stage`, async () => {
    const audio = { stopped: false, stop() { this.stopped = true; } };
    const video = { stopped: false, stop() { this.stopped = true; } };
    let imageStopped = false, published = false;
    const stream = { getVideoTracks: () => [video], removeTrack() {}, getAudioTracks: () => [audio] };
    const context = {
      cameraStream: stream, localVideoTrack: video, localAudioTrack: audio,
      stopCameraFilter() {}, stopImageSource() { imageStopped = true; },
      updateLocalMediaControls() {}, publishLocalMedia: async () => { published = true; },
      showLiveError: error => { throw new Error(error); }, console
    };
    vm.runInNewContext(cameraOff, context);
    await context.turnCameraOff();
    assert.equal(imageStopped, true);
    assert.equal(context.localVideoTrack, null);
    assert.equal(context.localAudioTrack, audio);
    assert.equal(audio.stopped, false);
    assert.equal(published, true);
  });
}

test('image and guest controls reflect pending, approved and audio-only states', () => {
  const elements = Object.fromEntries(['live-media-status', 'live-turn-media-off-btn', 'live-remove-image-btn', 'live-request-stage-btn', 'live-enable-camera-btn'].map(id => [id, { setAttribute(name, value) { this[name] = value; } }]));
  const context = {
    document: { getElementById: id => elements[id] }, isGuestRole: () => true,
    imageStream: {}, localVideoTrack: {}, localAudioTrack: null, guestOnStage: false, guestRequestPending: true,
    applyCameraMirror() {}, applyMute() {}, updateVideoGridLayout() {}
  };
  vm.runInNewContext(controls, context);
  context.updateLocalMediaControls('');
  assert.equal(elements['live-remove-image-btn'].hidden, false);
  assert.equal(elements['live-request-stage-btn'].disabled, true);
  assert.equal(elements['live-enable-camera-btn'].hidden, true);
  context.imageStream = null; context.localVideoTrack = null; context.guestOnStage = true; context.guestRequestPending = false;
  context.updateLocalMediaControls('');
  assert.equal(elements['live-remove-image-btn'].hidden, true);
  assert.equal(elements['live-request-stage-btn'].hidden, true);
  assert.equal(elements['live-turn-media-off-btn'].hidden, false);
  assert.equal(elements['live-enable-camera-btn'].hidden, false);
  assert.equal(elements['live-enable-camera-btn'].textContent, '📷');
  assert.equal(elements['live-enable-camera-btn']['aria-label'], 'Turn camera on');
  context.guestOnStage = false;
  context.updateLocalMediaControls('');
  assert.equal(elements['live-turn-media-off-btn'].hidden, true);
  assert.equal(elements['live-request-stage-btn'].hidden, false);
  context.isGuestRole = () => false;
  context.guestOnStage = true;
  context.updateLocalMediaControls('');
  assert.equal(elements['live-turn-media-off-btn'].hidden, true);
});

test('duplicate host approvals complete a request only once', async () => {
  const listeners = new Map(), events = [];
  let acknowledgement;
  const context = {
    isGuestRole: () => true, guestOnStage: false, guestRequestPending: false,
    updateLocalMediaControls() {}, showLiveError: error => { throw new Error(error); },
    setTimeout: () => 1, clearTimeout() {},
    socket: { on: (event, fn) => listeners.set(event, fn), off: event => listeners.delete(event),
      emit: (...args) => events.push(args), timeout: () => ({ emit: (_event, _data, fn) => { acknowledgement = fn; } }) }
  };
  vm.runInNewContext(request, context);
  const result = context.requestGuestSlot();
  listeners.get('live_guest_approved')();
  acknowledgement(null, { ok: true, approved: true });
  assert.equal(await result, true);
  assert.equal(context.guestOnStage, true);
  assert.equal(events.length, 0);
});

test('stage departure cancels a pending request when targeted removal is missed', async () => {
  const listeners = new Map(), errors = [], events = [];
  const context = {
    isGuestRole: () => true, guestOnStage: false, guestRequestPending: false,
    updateLocalMediaControls() {}, showLiveError: error => errors.push(error),
    setTimeout: () => 1, clearTimeout() {},
    socket: { id: 'guest', on: (event, fn) => listeners.set(event, fn), off: event => listeners.delete(event),
      emit: event => events.push(event), timeout: () => ({ emit() {} }) }
  };
  vm.runInNewContext(request, context);
  const result = context.requestGuestSlot();
  listeners.get('live_stage_guest_left')({ socketId: 'other' });
  assert.equal(context.guestRequestPending, true);
  listeners.get('live_stage_guest_left')({ socketId: 'guest' });
  assert.equal(await result, false);
  assert.equal(context.guestRequestPending, false);
  assert.deepEqual(events, []);
  assert.match(errors[0], /continue watching/);
});

for (const guest of [false, true]) {
  test(`${guest ? 'guest' : 'host'} selected image is published and can be removed while audio remains`, async () => {
    const audio = { stop() { throw new Error('Audio must remain active'); } };
    const imageTrack = { stop() { this.stopped = true; } };
    const imageStream = { getVideoTracks: () => [imageTrack], getTracks: () => [imageTrack] };
    const cameraStream = { getVideoTracks: () => [], getAudioTracks: () => [audio], removeTrack() {} };
    const updates = [], published = [];
    class ImageMock {
      constructor() { this.naturalWidth = 640; this.naturalHeight = 480; }
      set src(_value) { this.onload(); }
    }
    const context = {
      requestGuestSlot: async () => true, isGuestRole: () => guest, guestOnStage: guest, guestStageGeneration: 0,
      showLiveError: error => { throw new Error(error); },
      URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} }, Image: ImageMock,
      document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), captureStream: () => imageStream }) },
      requestAnimationFrame: () => 1, stopCameraFilter() {},
      imageStream: null, imageObjectUrl: null, imageAnimationFrame: null, cameraStream,
      localVideoTrack: null, localAudioTrack: audio,
      stopImageSource() { if (this.imageStream) imageTrack.stop(); this.imageStream = null; },
      updateLocalMediaControls: value => updates.push(value),
      publishLocalMedia: async () => published.push(context.localVideoTrack), console
    };
    vm.createContext(context);
    vm.runInContext(`${useImage}\n${cameraOff}`, context);
    await context.useLocalImage({ type: 'image/png', size: 10, name: 'photo.png' });
    assert.equal(context.localVideoTrack, imageTrack);
    assert.equal(published[0], imageTrack);
    assert.match(updates[0], /Sharing photo.png/);
    await context.turnCameraOff();
    assert.equal(context.localVideoTrack, null);
    assert.equal(context.localAudioTrack, audio);
    assert.equal(published[1], null);
  });
}

test('shared images take the camera box shape and stay whole when shapes differ', () => {
  const context = {};
  vm.runInNewContext(fit, context);
  assert.deepEqual({ ...context.liveImageCanvasSize({ width: 360, height: 640 }, 4000, 3000) }, { width: 720, height: 1280 });
  assert.deepEqual({ ...context.liveImageCanvasSize({ width: 1600, height: 900 }, 3000, 4000) }, { width: 1280, height: 720 });
  assert.deepEqual({ ...context.liveImageCanvasSize(undefined, 3000, 4000) }, { width: 960, height: 1280 });

  const calls = [];
  const canvas = { filter: 'none', fillRect: (...args) => calls.push(['fill', ...args]), drawImage: (_image, ...args) => calls.push(['draw', canvas.filter, ...args.map(Math.round)]) };
  context.drawImageToFitBox(canvas, { naturalWidth: 1600, naturalHeight: 900 }, 720, 1280);
  assert.deepEqual(calls[0], ['fill', 0, 0, 720, 1280]);
  assert.match(calls[1][1], /blur/);
  assert.deepEqual(calls[2], ['draw', 'none', 0, 438, 720, 405]);

  calls.length = 0;
  context.drawImageToFitBox(canvas, { naturalWidth: 1000, naturalHeight: 1800 }, 720, 1280);
  assert.deepEqual(calls, [['draw', 'none', 0, -8, 720, 1296]]);
});

test('HEIC and unsupported photos are rejected with a clear message before decoding', async () => {
  const errors = [];
  const context = {
    requestGuestSlot: async () => true, guestStageGeneration: 0, showLiveError: error => errors.push(error),
    URL: { createObjectURL() { throw new Error('Must not decode'); } }
  };
  vm.runInNewContext(useImage, context);
  await context.useLocalImage({ type: '', size: 10, name: 'IMG_0001.HEIC' });
  await context.useLocalImage({ type: 'image/heif', size: 10, name: 'photo' });
  await context.useLocalImage({ type: 'image/tiff', size: 10, name: 'scan.tif' });
  assert.match(errors[0], /HEIC/);
  assert.match(errors[1], /HEIC/);
  assert.match(errors[2], /JPEG, PNG, WebP or GIF/);
});

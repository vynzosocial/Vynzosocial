const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'message-camera.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^export /gm, '');
const cameraSource = fs.readFileSync(path.join(__dirname, '../frontend/js/camera-devices.js'), 'utf8').replace(/^export /gm, '');

function setup({ delayed = false, denied = false, supportedTypes = ['video/webm;codecs=vp8,opus'] } = {}) {
  const nodes = [], captured = [], errors = [], timers = [];
  let stopped = 0, resolveMedia, recorder;
  const requests = [];
  const tracks = [
    { kind: 'video', enabled: true, getSettings: () => ({ facingMode: 'environment', deviceId: 'rear' }), stop() { stopped++; } },
    { kind: 'audio', enabled: true, stop() { stopped++; } }
  ];
  const stream = {
    getTracks: () => [...tracks],
    getVideoTracks: () => tracks.filter(track => track.kind === 'video'),
    removeTrack(track) { tracks.splice(tracks.indexOf(track), 1); },
    addTrack(track) { tracks.push(track); }
  };
  function element(tag) {
    const node = {
      tag, children: [], listeners: {}, removed: false,
      setAttribute(name, value) { this[name] = value; },
      append(...items) { this.children.push(...items); },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      remove() { this.removed = true; },
      play: async () => {}
    };
    nodes.push(node);
    return node;
  }
  const document = {
    body: element('body'), visibilityState: 'visible', listeners: {},
    createElement: element,
    addEventListener(name, callback) { this.listeners[name] = callback; },
    removeEventListener(name) { delete this.listeners[name]; }
  };
  class Recorder {
    static isTypeSupported(type) { return supportedTypes.includes(type); }
    constructor(stream, options) { this.stream = stream; this.options = options; this.listeners = {}; recorder = this; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.listeners.dataavailable({ data: new Blob(['video frames']) });
      this.listeners.stop();
    }
  }
  const context = {
    document, navigator: { mediaDevices: { getUserMedia: async constraints => {
      requests.push(constraints);
      if (denied) throw new Error('Permission denied');
      if (delayed) return new Promise(resolve => { resolveMedia = resolve; });
      if (constraints.audio === false) {
        const next = { kind: 'video', enabled: true, getSettings: () => ({ facingMode: 'user' }), stop() { stopped++; } };
        return { getTracks: () => [next], getVideoTracks: () => [next] };
      }
      return stream;
    } } },
    MediaRecorder: Recorder, Blob, File, Date,
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    setInterval() { return {}; }, clearInterval() {}
  };
  vm.runInNewContext(`${cameraSource}\n${source}`, context);
  return {
    context, nodes, captured, errors, timers, document, requests, stream,
    open: () => context.recordMessageVideo(file => captured.push(file), error => errors.push(error)),
    button: text => nodes.find(node => node.tag === 'button' && node.textContent === text),
    resolveMedia: () => resolveMedia(stream),
    get stopped() { return stopped; },
    get recorder() { return recorder; }
  };
}

test('camera choice exposes photo and ten-second video without opening media first', () => {
  const state = setup();
  const chosen = [];
  state.context.chooseMessageCamera(() => chosen.push('photo'), () => chosen.push('video'));
  state.button('Record video (up to 10s)').listeners.click();
  assert.deepEqual(chosen, ['video']);
  assert.equal(state.nodes.find(node => node.className === 'message-camera-overlay').removed, true);
});

test('camera recording auto-stops after ten seconds and releases camera and microphone', async () => {
  const state = setup();
  await state.open();
  state.button('Start recording').listeners.click();
  assert.equal(state.recorder.options.videoBitsPerSecond, 1_500_000);
  const limit = state.timers.find(timer => timer.delay === 10000);
  assert.ok(limit);
  limit.callback();
  assert.equal(state.captured.length, 1);
  assert.equal(state.captured[0].type, 'video/webm');
  assert.ok(state.captured[0].size);
  assert.equal(state.stopped, 2);
  assert.equal(limit.cleared, true);
  assert.deepEqual(state.errors, []);
});

test('manual stop prepares one camera video', async () => {
  const state = setup();
  await state.open();
  const button = state.button('Start recording');
  button.listeners.click();
  button.listeners.click();
  assert.equal(state.captured.length, 1);
  assert.equal(state.stopped, 2);
});

test('switches chat video camera before recording and retains the original microphone', async () => {
  const state = setup();
  await state.open();
  const microphone = state.stream.getTracks().find(track => track.kind === 'audio');
  const oldCamera = state.stream.getVideoTracks()[0];
  const flip = state.button('Switch camera');
  await flip.listeners.click();
  assert.equal(state.requests[1].audio, false);
  assert.equal(state.requests[1].video.facingMode.exact, 'user');
  assert.notEqual(state.stream.getVideoTracks()[0], oldCamera);
  assert.ok(state.stream.getTracks().includes(microphone));
  state.button('Start recording').listeners.click();
  assert.equal(state.recorder.stream, state.stream);
  assert.equal(flip.disabled, true);
  await flip.listeners.click();
  assert.equal(state.requests.length, 2);
  state.button('Cancel').listeners.click();
  assert.equal(state.stopped, 3);
});

test('camera prefers playable MP4 and AAC over WebM when available', async () => {
  const state = setup({ supportedTypes: ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp8,opus'] });
  await state.open();
  const button = state.button('Start recording');
  button.listeners.click();
  button.listeners.click();
  assert.equal(state.recorder.options.mimeType, 'video/mp4;codecs=avc1.42E01E,mp4a.40.2');
  assert.equal(state.captured[0].type, 'video/mp4');
  assert.match(state.captured[0].name, /\.mp4$/);
  assert.deepEqual(state.errors, []);
});

test('cancelling camera recording discards the video and stops every track', async () => {
  const state = setup();
  await state.open();
  state.button('Start recording').listeners.click();
  state.button('Cancel').listeners.click();
  assert.equal(state.captured.length, 0);
  assert.equal(state.stopped, 2);
  assert.deepEqual(state.errors, []);
});

test('closing while permission is pending also releases the late camera stream', async () => {
  const state = setup({ delayed: true });
  const opening = state.open();
  state.button('Cancel').listeners.click();
  state.resolveMedia();
  await opening;
  assert.equal(state.stopped, 2);
  assert.equal(state.captured.length, 0);
});

test('leaving the visible camera view cancels recording', async () => {
  const state = setup();
  await state.open();
  state.button('Start recording').listeners.click();
  state.document.visibilityState = 'hidden';
  state.document.listeners.visibilitychange();
  assert.equal(state.stopped, 2);
  assert.equal(state.captured.length, 0);
});

test('denied camera access is reported and the overlay is removed', async () => {
  const state = setup({ denied: true });
  await state.open();
  assert.deepEqual(state.errors, ['Permission denied']);
  assert.equal(state.nodes.find(node => node.className === 'message-camera-overlay').removed, true);
});

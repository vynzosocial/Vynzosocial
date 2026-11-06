const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..', 'frontend', 'js');
const filterSource = fs.readFileSync(path.join(root, 'live-camera-filter.js'), 'utf8')
  .replace('export async function', 'async function');
const liveSource = fs.readFileSync(path.join(root, 'live.js'), 'utf8');
const faceSource = fs.readFileSync(path.join(root, 'live-face-effects.js'), 'utf8');
const controls = liveSource.slice(liveSource.indexOf('function stopCameraFilter() {'), liveSource.indexOf('\nlet guestMuted = false;'));

function filterEnvironment({ supported = true, play = () => Promise.resolve() } = {}) {
  const callbacks = new Map();
  const sourceListeners = new Map();
  let nextFrame = 0;
  const outputTrack = { stopped: false, stop() { this.stopped = true; } };
  const source = {
    readyState: 'live',
    addEventListener(name, callback) { sourceListeners.set(name, callback); },
    removeEventListener(name) { sourceListeners.delete(name); }
  };
  const context2d = { filter: 'none', drawImage() { this.lastFilter = this.filter; } };
  const video = { videoWidth: 1920, videoHeight: 1080, play, pause() { this.paused = true; } };
  const canvas = {
    getContext: () => supported ? context2d : null,
    captureStream: () => ({ getTracks: () => [outputTrack], getVideoTracks: () => [outputTrack] })
  };
  const context = {
    document: { createElement: name => name === 'video' ? video : canvas },
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
    requestAnimationFrame: callback => { callbacks.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => callbacks.delete(id),
    setTimeout, clearTimeout
  };
  vm.runInNewContext(filterSource, context);
  return { context, source, outputTrack, video, canvas, context2d, callbacks, sourceListeners };
}

test('filters the outgoing track and releases resources without stopping the camera', async () => {
  const env = filterEnvironment();
  const result = await env.context.createCameraFilter(env.source, 'warm', () => assert.fail('unexpected failure'));
  assert.equal(result.track, env.outputTrack);
  assert.equal(env.canvas.width, 1280);
  assert.equal(env.canvas.height, 720);
  assert.match(env.context2d.lastFilter, /sepia/);
  result.setFilter('mono');
  [...env.callbacks.values()][0](100);
  assert.equal(env.context2d.lastFilter, 'grayscale(1)');
  result.stop();
  assert.equal(env.outputTrack.stopped, true);
  assert.equal(env.source.readyState, 'live');
  assert.equal(env.video.srcObject, null);
  assert.equal(env.sourceListeners.size, 0);
});

test('reports unsupported browsers and cancels pending setup', async () => {
  const unsupported = filterEnvironment({ supported: false });
  await assert.rejects(unsupported.context.createCameraFilter(unsupported.source, 'warm', () => {}), /not supported/);
  assert.equal(unsupported.video.srcObject, null);
  const pending = filterEnvironment({ play: () => new Promise(() => {}) });
  const controller = new AbortController();
  const promise = pending.context.createCameraFilter(pending.source, 'warm', () => {}, controller.signal);
  controller.abort();
  await assert.rejects(promise, /cancelled/);
  assert.equal(pending.video.srcObject, null);
  assert.equal(pending.video.paused, true);
});

test('reports camera failure and stops the generated track', async () => {
  const env = filterEnvironment();
  let error;
  await env.context.createCameraFilter(env.source, 'warm', value => { error = value; });
  env.sourceListeners.get('ended')();
  assert.match(error.message, /camera stopped/i);
  assert.equal(env.outputTrack.stopped, true);
});

function controlEnvironment(createCameraFilter) {
  const source = { readyState: 'live' };
  const select = { value: 'none', disabled: false };
  const published = [];
  const errors = [];
  const context = {
    AbortController, createCameraFilter,
    document: { getElementById: () => select },
    console: { error() {} },
    showLiveError: message => errors.push(message),
    updateLocalMediaControls() {},
    applyCameraMirror() {},
    async publishLocalMedia() { published.push(vm.runInNewContext('localVideoTrack', context)); }
  };
  vm.runInNewContext(`
    let cameraStream = { getVideoTracks: () => [source] };
    let localVideoTrack = source;
    let cameraFilter = null;
    let cameraFilterName = 'none';
    let cameraFilterSetup = null;
    let cameraFilterGeneration = 0;
    ${controls}
  `, Object.assign(context, { source }));
  return { context, source, select, published, errors };
}

test('publishes the processed track and restores the original when disabled', async () => {
  const processed = { track: {}, stop() { this.stopped = true; }, supportsFilter: () => true, setFilter(value) { this.name = value; } };
  const env = controlEnvironment(async () => processed);
  await env.context.applyLocalCameraFilter('warm');
  assert.equal(env.published[0], processed.track);
  await env.context.applyLocalCameraFilter('mono');
  assert.equal(processed.name, 'mono');
  await env.context.applyLocalCameraFilter('none');
  assert.equal(env.published[1], env.source);
  assert.equal(processed.stopped, true);
});

test('a later processing failure restores the original track after changing filters', async () => {
  let onError;
  const processed = { track: {}, stop() { this.stopped = true; }, supportsFilter: () => true, setFilter() {} };
  const env = controlEnvironment(async (_source, _name, callback) => {
    onError = callback;
    return processed;
  });
  await env.context.applyLocalCameraFilter('warm');
  await env.context.applyLocalCameraFilter('mono');
  onError(new Error('rendering failed'));
  await Promise.resolve();
  assert.equal(env.published[1], env.source);
  assert.equal(processed.stopped, true);
  assert.equal(env.select.value, 'none');
  assert.ok(env.errors.length);
});

test('background failure stops camera video instead of exposing the original feed', async () => {
  let onError;
  const processed = { track: {}, stop() { this.stopped = true; }, supportsFilter: () => false };
  const env = controlEnvironment(async (_source, _name, callback) => {
    onError = callback;
    return processed;
  });
  env.source.stop = function () { this.readyState = 'ended'; };
  await env.context.applyLocalCameraFilter('background-blue');
  onError(new Error('segmentation failed'));
  await Promise.resolve();
  assert.equal(env.source.readyState, 'ended');
  assert.equal(env.published[1], null);
  assert.equal(processed.stopped, true);
  assert.ok(env.errors.some(message => /video sharing was turned off/i.test(message)));
});

test('background controls validate local image uploads and warn about imperfect edges', () => {
  for (const name of ['background-blue', 'background-purple', 'background-dark', 'background-image']) {
    assert.ok(liveSource.includes(`value="${name}"`));
  }
  assert.match(liveSource, /image\/jpeg.*image\/png.*image\/webp/);
  assert.match(liveSource, /file\.size > 10 \* 1024 \* 1024/);
  assert.match(liveSource, /URL\.revokeObjectURL\(url\)/);
  assert.match(liveSource, /do not rely on it to hide private details/);
});

test('a failed sender replacement restores the prior camera track', async () => {
  const processed = { track: {}, stop() { this.stopped = true; } };
  const env = controlEnvironment(async () => processed);
  let count = 0;
  env.context.publishLocalMedia = async () => {
    count++;
    if (count === 1) throw new Error('sender rejected track');
    env.published.push(vm.runInNewContext('localVideoTrack', env.context));
  };
  await env.context.applyLocalCameraFilter('warm');
  assert.equal(env.published[0], env.source);
  assert.equal(processed.stopped, true);
  assert.equal(env.select.value, 'none');
  assert.ok(env.errors.length);
});

test('turning media off while setup is pending prevents a late publication', async () => {
  let complete;
  const processed = { track: {}, stop() { this.stopped = true; } };
  const env = controlEnvironment(() => new Promise(resolve => { complete = resolve; }));
  const pending = env.context.applyLocalCameraFilter('warm');
  assert.equal(env.select.disabled, true);
  env.context.stopCameraFilter();
  complete(processed);
  await pending;
  assert.equal(processed.stopped, true);
  assert.equal(env.published.length, 0);
  assert.equal(env.select.disabled, false);
});

test('moderation samples the outgoing self preview, not a processing input video', () => {
  assert.match(liveSource, /document\.querySelector\('\.live-video-frame\[data-peer-id="self"\] \.live-video-player'\)/);
  assert.match(liveSource, /srcObject\?\.getVideoTracks\?\.\(\)\.includes\(localVideoTrack\)/);
});

test('host camera-off status stays empty on initial display and after turning media off', () => {
  assert.doesNotMatch(liveSource, /Your camera is off\. Choose an option to share with everyone\./);
  assert.match(liveSource, /id="live-media-status">\$\{isHost \? '' :/);
  assert.match(liveSource, /updateLocalMediaControls\(isGuest\s*\? 'You are back in the chat\.[^\n]+\n\s*: ''\)/);
});

test('face presets draw only when facial landmarks are available', () => {
  const drawingSource = faceSource.slice(0, faceSource.indexOf('\nexport async function createFaceTracker'))
    .replace('export function drawFaceEffect', 'function drawFaceEffect');
  const calls = [];
  const ctx = {
    save() {}, restore() {}, scale() {}, translate() {}, rotate() {}, clip() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, ellipse() {}, fill() { calls.push('fill'); },
    stroke() { calls.push('stroke'); },
    createRadialGradient() { return { addColorStop() {} }; }
  };
  const context = { ctx };
  vm.runInNewContext(drawingSource, context);
  context.drawFaceEffect(ctx, null, 'lipstick', 1, 1);
  assert.equal(calls.length, 0);
  const face = { mesh: Array.from({ length: 468 }, (_, i) => [i % 40, Math.floor(i / 40)]), box: [0, 0, 100, 100] };
  context.drawFaceEffect(ctx, face, 'lipstick', 1, 1);
  assert.equal(calls.filter(item => item === 'fill').length, 2);
  context.drawFaceEffect(ctx, face, 'blush', 1, 1);
  assert.equal(calls.filter(item => item === 'fill').length, 4);
  context.drawFaceEffect(ctx, face, 'glasses', 1, 1);
  assert.equal(calls.filter(item => item === 'stroke').length, 1);
  for (const effect of ['eyeshadow', 'eyeliner', 'lashes', 'eyebrows', 'hat', 'stars']) {
    const before = calls.length;
    context.drawFaceEffect(ctx, face, effect, 1, 1);
    assert.ok(calls.length > before, `${effect} should draw`);
  }
});

test('face models and runtime are pinned, self-hosted and copied into both builds', () => {
  const repository = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['@vladmandic/human'], '3.3.6');
  const copier = fs.readFileSync(path.join(repository, 'scripts', 'copy-live-face-assets.js'), 'utf8');
  for (const file of ['blazeface.json', 'blazeface.bin', 'facemesh.json', 'facemesh.bin', 'iris.json', 'iris.bin', 'human.esm.js']) {
    assert.ok(copier.includes(file), `${file} must be included`);
  }
  for (const file of ['scripts/build.js', 'android-app/scripts/prepare-web.js']) {
    assert.match(fs.readFileSync(path.join(repository, file), 'utf8'), /copy-live-face-assets/);
  }
  assert.match(faceSource, /modelBasePath: new URL\('\.\.\/vendor\/human\/models\/'/);
  assert.match(faceSource, /cacheModels: false/);
  for (const effect of ['eyeshadow', 'eyeliner', 'lashes', 'eyebrows', 'eyes-blue', 'eyes-green', 'eyes-violet', 'hat', 'stars', 'skin']) {
    assert.ok(liveSource.includes(`value="${effect}"`), `${effect} must be available to hosts and guests`);
  }
});

test('skin smoothing clips the blurred video to the face, excluding eyes and lips', () => {
  const drawingSource = faceSource.slice(0, faceSource.indexOf('\nexport async function createFaceTracker'))
    .replace('export function drawFaceEffect', 'function drawFaceEffect');
  const calls = [];
  const ctx = {
    canvas: { width: 640, height: 480 },
    save() {}, restore() {}, scale() {}, beginPath() {}, closePath() {},
    moveTo() { calls.push('path'); }, lineTo() {},
    clip(rule) { calls.push(rule); },
    drawImage(video, ...dimensions) { calls.push({ video, dimensions, filter: this.filter, alpha: this.globalAlpha }); }
  };
  const context = {};
  vm.runInNewContext(drawingSource, context);
  const video = {};
  const face = { mesh: Array.from({ length: 468 }, (_, i) => [i % 40, Math.floor(i / 40)]) };
  context.drawFaceEffect(ctx, face, 'skin', 2, 2, video);
  assert.equal(calls.filter(call => call === 'path').length, 4);
  assert.ok(calls.includes('evenodd'));
  const draw = calls.find(call => call.video);
  assert.equal(draw.video, video);
  assert.deepEqual(draw.dimensions, [0, 0, 320, 240]);
  assert.equal(draw.filter, 'blur(3px)');
  assert.equal(draw.alpha, 0.4);
  calls.length = 0;
  face.mesh[10] = null;
  context.drawFaceEffect(ctx, face, 'skin', 1, 1, video);
  assert.equal(calls.some(call => call.video), false);
});

test('eye color uses iris landmarks and skips closed eyes', () => {
  const drawingSource = faceSource.slice(0, faceSource.indexOf('\nexport async function createFaceTracker'))
    .replace('export function drawFaceEffect', 'function drawFaceEffect');
  let strokes = 0;
  const ctx = {
    save() {}, restore() {}, scale() {}, beginPath() {}, closePath() {}, clip() {},
    moveTo() {}, lineTo() {}, ellipse() {}, stroke() { strokes++; }
  };
  const context = {};
  vm.runInNewContext(drawingSource, context);
  const mesh = Array.from({ length: 478 }, () => [0, 0]);
  mesh[33] = [0, 0]; mesh[133] = [40, 0]; mesh[159] = [20, 2]; mesh[145] = [20, 12];
  mesh[263] = [60, 0]; mesh[362] = [100, 0]; mesh[386] = [80, 2]; mesh[374] = [80, 12];
  mesh[473] = [20, 7]; mesh[474] = [24, 7]; mesh[468] = [80, 7]; mesh[469] = [84, 7];
  context.drawFaceEffect(ctx, { mesh }, 'eyes-blue', 1, 1);
  assert.equal(strokes, 2);
  mesh[145] = [20, 2]; mesh[374] = [80, 2];
  context.drawFaceEffect(ctx, { mesh }, 'eyes-green', 1, 1);
  assert.equal(strokes, 2);
});

test('switching from a non-iris effect to eye colors replaces the outgoing track', async () => {
  const first = { track: {}, supportsFilter: () => false, stop() { this.stopped = true; } };
  const second = { track: {}, supportsFilter: () => true, stop() {} };
  let count = 0;
  const env = controlEnvironment(async () => count++ ? second : first);
  await env.context.applyLocalCameraFilter('lipstick');
  await env.context.applyLocalCameraFilter('eyes-blue');
  assert.equal(env.published[1], second.track);
  assert.equal(first.stopped, true);
});

test('face model load failure disposes only successfully loaded models', async () => {
  const trackerSource = faceSource.slice(faceSource.indexOf('export async function createFaceTracker'))
    .replace('export async function', 'async function')
    .replace(/const moduleUrl = new URL[\s\S]*?const \{ Human \} = await import\(moduleUrl\.href\);/, '');
  const disposed = [];
  class Human {
    constructor() {
      this.tf = { getBackend: () => 'webgl', removeBackend: () => disposed.push('backend') };
      this.models = {
        models: {
          blazeface: { dispose() { disposed.push('blazeface'); } },
          facemesh: { dispose() { throw new Error('incomplete model cannot be disposed'); } }
        },
        stats: () => ({ modelStats: [{ name: 'blazeface', loaded: true }, { name: 'facemesh', loaded: false }] }),
        reset() {}
      };
    }
    async load() {}
  }
  const context = { Human, URL, setTimeout, clearTimeout };
  vm.runInNewContext(trackerSource.replaceAll('import.meta.url', "'http://localhost/js/live-face-effects.js'"), context);
  await assert.rejects(context.createFaceTracker({}, new AbortController().signal, () => {}), /models could not be loaded/);
  assert.deepEqual(disposed, ['blazeface', 'backend']);
});

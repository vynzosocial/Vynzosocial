const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'image-to-video.js'), 'utf8')
  .replace(/export (const|async function|function)/g, '$1')
  .replaceAll("import('../vendor/mediabunny/mediabunny.min.mjs')", 'loadBunny()');

function setup({ noAudio = false, invalid = false } = {}) {
  const state = {};
  class File {
    constructor(name, type = 'video/mp4') { this.name = name; this.type = type; }
  }
  class Input {
    async getAudioTracks() { return noAudio ? [] : [{}]; }
    async getVideoTracks() { return [{}]; }
    async computeDuration() { return 100; }
    async getFirstTimestamp() { return 2; }
    dispose() { state.disposed = true; }
  }
  class BufferTarget { constructor() { this.buffer = new ArrayBuffer(16); } }
  const bunny = {
    Input, BlobSource: class {}, BufferTarget, Output: class {}, WavOutputFormat: class {},
    ALL_FORMATS: [],
    Conversion: { init: async options => {
      state.options = options;
      return {
        isValid: !invalid,
        discardedTracks: invalid ? [{ reason: 'undecodable_source_codec' }] : [],
        async execute() {}
      };
    } }
  };
  const context = {
    File, Blob, loadBunny: async () => bunny,
    MediaRecorder: class {}, HTMLCanvasElement: class {},
    window: {}
  };
  context.HTMLCanvasElement.prototype.captureStream = () => {};
  vm.runInNewContext(source, context);
  return { context, state, file: new File('source.mp4') };
}

test('extraction uses PCM audio only and trims relative to the source timeline', async () => {
  const { context, state, file } = setup();
  const result = await context.extractAudioFromVideo(file, null, { start: 20, duration: 30 });
  assert.equal(state.options.video.discard, true);
  assert.equal(state.options.audio({}, 1).codec, 'pcm-s16');
  assert.equal(state.options.audio({}, 2).discard, true);
  assert.equal(state.options.trim.start, 22);
  assert.equal(state.options.trim.end, 52);
  assert.equal(result.duration, 30);
  assert.equal(result.audio.type, 'audio/wav');
  assert.equal(state.disposed, true);
});

test('extraction clips the segment to the end and reports undecodable or missing tracks', async () => {
  const end = setup();
  const result = await end.context.extractAudioFromVideo(end.file, null, { start: 90, duration: 30 });
  assert.equal(end.state.options.trim.end, 100);
  assert.equal(result.duration, 8);
  const missing = setup({ noAudio: true });
  await assert.rejects(missing.context.extractAudioFromVideo(missing.file), /does not contain an audio track/);
  assert.equal(missing.state.disposed, true);
  const unsupported = setup({ invalid: true });
  await assert.rejects(unsupported.context.extractAudioFromVideo(unsupported.file), /undecodable_source_codec/);
  assert.equal(unsupported.state.disposed, true);
});

test('video creation passes the chosen start and clips the duration to the remaining audio', async () => {
  const { context, file } = setup();
  const audio = { pause() {}, removeAttribute() {}, load() {} };
  let captured;
  context.URL = { revokeObjectURL() {} };
  context.window.AudioContext = class { async close() {} };
  context.loadImage = async () => ({});
  context.prepareVideoAudio = async (input, start) => {
    assert.equal(input, file);
    assert.equal(start, 75);
    return { audio, url: 'blob:test', duration: 100 };
  };
  context.renderSlideshow = async options => {
    captured = options;
    return new Blob(['video'], { type: 'video/webm' });
  };
  await context.createVideoFromImages([{}], { type: 'extracted', file, start: 75 }, ['static'], null, { maxSeconds: 30 });
  assert.equal(captured.audioElement, audio);
  assert.equal(captured.audioStart, 75);
  assert.equal(captured.seconds, 25);
});

test('audio file selection starts at the selected offset and respects the duration choice', async () => {
  const { context } = setup();
  let captured;
  context.window.AudioContext = class { async close() {} };
  context.loadImage = async () => ({});
  context.decodeAudio = async () => ({ duration: 100 });
  context.renderSlideshow = async options => {
    captured = options;
    return new Blob(['video'], { type: 'video/webm' });
  };
  await context.createVideoFromImages([{}], { type: 'file', blob: new Blob(['audio']), start: 20 }, ['static'], null, { maxSeconds: 15 });
  assert.equal(captured.audioStart, 20);
  assert.equal(captured.seconds, 15);
});

test('selected video audio end determines video duration and remains capped by the chosen limit', async () => {
  const { context, file } = setup();
  const audio = { pause() {}, removeAttribute() {}, load() {} };
  let captured;
  context.URL = { revokeObjectURL() {} };
  context.window.AudioContext = class { async close() {} };
  context.loadImage = async () => ({});
  context.prepareVideoAudio = async () => ({ audio, url: 'blob:test', duration: 100 });
  context.renderSlideshow = async options => {
    captured = options;
    return new Blob(['video'], { type: 'video/webm' });
  };
  await context.createVideoFromImages([{}], { type: 'extracted', file, start: 10, end: 35 }, ['static'], null, { maxSeconds: 60 });
  assert.equal(captured.audioStart, 10);
  assert.equal(captured.seconds, 25);
  await context.createVideoFromImages([{}], { type: 'extracted', file, start: 10, end: 80 }, ['static'], null, { maxSeconds: 30 });
  assert.equal(captured.seconds, 30);
});

test('audio file end limits output and invalid or too short selections fail', async () => {
  const { context } = setup();
  let captured;
  context.window.AudioContext = class { async close() {} };
  context.loadImage = async () => ({});
  context.decodeAudio = async () => ({ duration: 100 });
  context.renderSlideshow = async options => {
    captured = options;
    return new Blob(['video'], { type: 'video/webm' });
  };
  const audio = { type: 'file', blob: new Blob(['audio']), start: 10, end: 35 };
  await context.createVideoFromImages([{}], audio, ['static'], null, { maxSeconds: 60 });
  assert.equal(captured.seconds, 25);
  await assert.rejects(context.createVideoFromImages([{}], { ...audio, end: 10 }, [], null, { maxSeconds: 60 }), /end time must be after/);
  await assert.rejects(context.createVideoFromImages([{}], { ...audio, end: 10.1 }, [], null, { maxSeconds: 60 }), /too short/);
  await assert.rejects(context.createVideoFromImages([{}], { ...audio, end: NaN }, [], null, { maxSeconds: 60 }), /end time must be after/);
});

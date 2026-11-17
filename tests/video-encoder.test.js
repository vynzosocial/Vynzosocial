const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'video-encoder.js'), 'utf8')
  .replace('export async function encodePlaybackVideo', 'async function encodePlaybackVideo')
  .replace("await import('../vendor/mediabunny/mediabunny.min.mjs')", 'await loadEncoder()');

function setup(options = {}) {
  const inputs = [];
  class File {
    constructor(parts, name, { type }) {
      this.parts = parts;
      this.name = name;
      this.type = type;
      this.size = parts.reduce((sum, part) => sum + part.byteLength, 0);
    }
  }
  class BlobSource { constructor(file) { this.file = file; } }
  class Input {
    constructor({ source }) { this.source = source; inputs.push(this); }
    async getVideoTracks() {
      return [{
        getDisplayWidth: async () => this.source.file.name.endsWith('-playback.mp4')
          ? options.wrongWidth ? 240 : conversionOptions.video.width
          : options.width || 320,
        getDisplayHeight: async () => this.source.file.name.endsWith('-playback.mp4')
          ? conversionOptions.video.height
          : options.height || 240
      }];
    }
    async getAudioTracks() {
      return this.source.file.name.endsWith('-playback.mp4') && options.missingAudio ? [] : [{}];
    }
    async computeDuration() {
      if (this.source.file.name.endsWith('-playback.mp4') && conversionOptions.trim) {
        return options.resultDuration ?? conversionOptions.trim.end - conversionOptions.trim.start;
      }
      return options.duration || 20;
    }
    async getFirstTimestamp() { return 0; }
    dispose() { this.disposed = true; }
  }
  class BufferTarget { constructor() { this.buffer = new ArrayBuffer(options.outputSize || 8); } }
  class Quality {
    constructor(settings) { this.settings = settings; }
  }
  let conversionOptions;
  const context = {
    File,
    VideoEncoder: options.unsupported ? undefined : class {},
    VideoDecoder: class {},
    loadEncoder: async () => ({
      Input, BlobSource, BufferTarget,
      Output: class {},
      Mp4OutputFormat: class {},
      Quality,
      ALL_FORMATS: [],
      Conversion: { init: async value => {
        conversionOptions = value;
        return {
          isValid: true,
          discardedTracks: options.discarded ? [{ reason: 'undecodable_source_codec' }] : [],
          execute: async () => {}
        };
      } }
    })
  };
  vm.runInNewContext(source, context);
  return {
    context, inputs, file: new File([new ArrayBuffer(20)], 'input.mp4', { type: 'video/mp4' }),
    getConversionOptions: () => conversionOptions
  };
}

test('preserves the original and encodes a constrained MP4 playback file', async () => {
  const { context, inputs, file, getConversionOptions } = setup();
  const result = await context.encodePlaybackVideo(file);
  assert.equal(result.original, file);
  assert.equal(result.playback.type, 'video/mp4');
  assert.equal(result.savedBytes, 12);
  const { video } = getConversionOptions();
  assert.equal(video.codec, 'avc');
  assert.equal(video.width, 320);
  assert.equal(video.height, 240);
  assert.equal(video.fit, 'contain');
  assert.equal(video.frameRate, 30);
  assert.equal(video.quality.settings.bitrate, 1_500_000);
  assert.ok(inputs.every(input => input.disposed));
});

test('rejects videos outside the 1-60 second duration range', async () => {
  for (const duration of [0.9, 60.1]) {
    const { context, inputs, file } = setup({ duration });
    await assert.rejects(context.encodePlaybackVideo(file), /between 1 and 60 seconds/);
    assert.ok(inputs.every(input => input.disposed));
  }
});

test('rejects unsupported devices and non-video input', async () => {
  const { context, file } = setup({ unsupported: true });
  await assert.rejects(context.encodePlaybackVideo(file), /does not support video encoding/);
  await assert.rejects(context.encodePlaybackVideo({}), /Choose a video/);
});

test('rejects discarded tracks and disposes resources', async () => {
  const { context, inputs, file } = setup({ discarded: true });
  await assert.rejects(context.encodePlaybackVideo(file), /undecodable_source_codec/);
  assert.ok(inputs.every(input => input.disposed));
});

test('rejects output that has lost audio', async () => {
  const { context, inputs, file } = setup({ missingAudio: true });
  await assert.rejects(context.encodePlaybackVideo(file), /did not preserve/);
  assert.ok(inputs.every(input => input.disposed));
});

test('caps playback size and resolution', async () => {
  const large = setup({ outputSize: 50 * 1024 * 1024 + 1 });
  await assert.rejects(large.context.encodePlaybackVideo(large.file), /50 MB upload limit/);
  assert.ok(large.inputs.every(input => input.disposed));
  const dimensions = setup({ wrongWidth: true });
  await assert.rejects(dimensions.context.encodePlaybackVideo(dimensions.file), /did not preserve/);
  assert.ok(dimensions.inputs.every(input => input.disposed));
  const highResolution = setup({ width: 1920, height: 1080 });
  const result = await highResolution.context.encodePlaybackVideo(highResolution.file);
  assert.equal(result.playback.type, 'video/mp4');
  assert.equal(highResolution.getConversionOptions().video.width, 1280);
  assert.equal(highResolution.getConversionOptions().video.height, 720);
});

test('camera videos are trimmed below the ten-second hard limit', async () => {
  const { context, file, getConversionOptions } = setup({ duration: 10.3 });
  const result = await context.encodePlaybackVideo(file, null, { trimToSeconds: 10 });
  assert.equal(result.playback.type, 'video/mp4');
  assert.equal(getConversionOptions().trim.start, 0);
  assert.equal(getConversionOptions().trim.end, 9.9);
  const tooLong = setup({ duration: 10.3, resultDuration: 10.01 });
  await assert.rejects(tooLong.context.encodePlaybackVideo(tooLong.file, null, { trimToSeconds: 10 }), /did not preserve/);
  const invalid = setup();
  await assert.rejects(invalid.context.encodePlaybackVideo(invalid.file, null, { trimToSeconds: 0 }), /duration limit is invalid/);
});

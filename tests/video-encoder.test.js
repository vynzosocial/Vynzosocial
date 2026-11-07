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
        getDisplayWidth: async () => this.source.file.name.endsWith('-playback.mp4') && options.wrongWidth ? 240 : 320,
        getDisplayHeight: async () => 240
      }];
    }
    async getAudioTracks() {
      return this.source.file.name.endsWith('-playback.mp4') && options.missingAudio ? [] : [{}];
    }
    async computeDuration() { return 2; }
    async getFirstTimestamp() { return 0; }
    dispose() { this.disposed = true; }
  }
  class BufferTarget { constructor() { this.buffer = new ArrayBuffer(options.outputSize || 8); } }
  const context = {
    File,
    VideoEncoder: options.unsupported ? undefined : class {},
    VideoDecoder: class {},
    loadEncoder: async () => ({
      Input, BlobSource, BufferTarget,
      Output: class {},
      Mp4OutputFormat: class {},
      Quality: class {},
      ALL_FORMATS: [],
      Conversion: { init: async () => ({
        isValid: true,
        discardedTracks: options.discarded ? [{ reason: 'undecodable_source_codec' }] : [],
        execute: async () => {}
      }) }
    })
  };
  vm.runInNewContext(source, context);
  return { context, inputs, file: new File([new ArrayBuffer(20)], 'input.mp4', { type: 'video/mp4' }) };
}

test('preserves the original and produces an MP4 playback file', async () => {
  const { context, inputs, file } = setup();
  const result = await context.encodePlaybackVideo(file);
  assert.equal(result.original, file);
  assert.equal(result.playback.type, 'video/mp4');
  assert.equal(result.savedBytes, 12);
  assert.ok(inputs.every(input => input.disposed));
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

test('rejects larger output and changed display dimensions', async () => {
  const large = setup({ outputSize: 21 });
  await assert.rejects(large.context.encodePlaybackVideo(large.file), /smaller playback copy/);
  assert.ok(large.inputs.every(input => input.disposed));
  const dimensions = setup({ wrongWidth: true });
  await assert.rejects(dimensions.context.encodePlaybackVideo(dimensions.file), /did not preserve/);
  assert.ok(dimensions.inputs.every(input => input.disposed));
});

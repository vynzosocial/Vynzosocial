const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/video-cover.js'), 'utf8')
  .replace('export async function createVideoCover', 'async function createVideoCover');

function setup({ failure = false } = {}) {
  const revoked = [];
  let canvas;
  class File {
    constructor(parts, name, options) {
      this.parts = parts;
      this.name = name;
      this.type = options.type;
      this.size = 10;
    }
  }
  const video = {
    videoWidth: 2400,
    videoHeight: 1200,
    load() {
      if (this.src) queueMicrotask(() => failure ? this.onerror() : this.onloadeddata());
    },
    removeAttribute() { this.src = ''; }
  };
  const document = {
    createElement(tag) {
      if (tag === 'video') return video;
      canvas = {
        getContext: () => ({ drawImage() {} }),
        toBlob: callback => callback({ size: 10, type: 'image/webp' })
      };
      return canvas;
    }
  };
  const context = {
    File, document, setTimeout, clearTimeout,
    URL: { createObjectURL: () => 'blob:video', revokeObjectURL: url => revoked.push(url) }
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.generate = createVideoCover;`, context);
  return { context, File, revoked, getCanvas: () => canvas };
}

test('creates a bounded WebP cover and releases the video URL', async () => {
  const s = setup();
  const result = await s.context.generate(new s.File([], 'video.mp4', { type: 'video/mp4' }));
  assert.equal(result.type, 'image/webp');
  assert.equal(result.name, 'cover.webp');
  assert.equal(s.getCanvas().width, 1200);
  assert.equal(s.getCanvas().height, 600);
  assert.deepEqual(s.revoked, ['blob:video']);
});

test('reports decoding errors and releases the video URL', async () => {
  const s = setup({ failure: true });
  await assert.rejects(s.context.generate(new s.File([], 'video.mp4', { type: 'video/mp4' })), /decode/);
  assert.deepEqual(s.revoked, ['blob:video']);
});

test('rejects non-video inputs without opening them', async () => {
  const s = setup();
  await assert.rejects(s.context.generate(new s.File([], 'image.png', { type: 'image/png' })), /valid video/);
  assert.deepEqual(s.revoked, []);
});

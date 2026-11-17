const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'image-cover.js'), 'utf8')
  .replace('export async function createImageCover', 'async function createImageCover');

test('creates a bounded JPEG and releases decoded image resources', async () => {
  let closed = false;
  let canvas;
  class File {
    constructor(parts, name, options) { this.name = name; this.type = options.type; this.size = 10; }
  }
  const context = {
    File,
    createImageBitmap: async () => ({ width: 2400, height: 1200, close() { closed = true; } }),
    document: {
      createElement() {
        canvas = { getContext: () => ({ drawImage() {} }), toBlob: callback => callback({ size: 10 }) };
        return canvas;
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.generate = createImageCover;`, context);
  const result = await context.generate(new File([], 'image.png', { type: 'image/png' }));
  assert.equal(result.type, 'image/jpeg');
  assert.equal(canvas.width, 1200);
  assert.equal(canvas.height, 600);
  assert.equal(closed, true);
});

function fallbackEnvironment({ bitmapAvailable = true, imageReadable = true } = {}) {
  const revoked = [], warnings = [], errors = [];
  let canvas;
  const context = {
    File,
    Image: class {
      width = 2400;
      height = 1200;
      set src(value) { if (imageReadable) this.onload(); else this.onerror(); }
    },
    URL: { createObjectURL: () => 'blob:gallery-photo', revokeObjectURL: url => revoked.push(url) },
    console: { warn: (...args) => warnings.push(args), error: (...args) => errors.push(args) },
    document: {
      createElement() {
        canvas = {
          getContext: () => ({ drawImage() {} }),
          toBlob: callback => callback(new Blob(['preview'], { type: 'image/jpeg' }))
        };
        return canvas;
      }
    }
  };
  if (bitmapAvailable) context.createImageBitmap = async () => { throw new Error('The source image could not be decoded.'); };
  vm.runInNewContext(`${source}\nthis.generate = createImageCover;`, context);
  return { context, revoked, warnings, errors, get canvas() { return canvas; } };
}

for (const bitmapAvailable of [true, false]) {
  test(`uses the browser decoder when bitmap decoding ${bitmapAvailable ? 'rejects a gallery photo' : 'is unavailable'}`, async () => {
    const state = fallbackEnvironment({ bitmapAvailable });
    const result = await state.context.generate(new File(['gallery photo'], 'photo.jpg', { type: 'image/jpeg' }));
    assert.equal(result.type, 'image/jpeg');
    assert.equal(state.canvas.width, 1200);
    assert.equal(state.canvas.height, 600);
    assert.deepEqual(state.revoked, ['blob:gallery-photo']);
    assert.equal(state.warnings.length, bitmapAvailable ? 1 : 0);
    assert.equal(state.errors.length, 0);
  });
}

test('unsupported images report recovery instructions and release the fallback URL', async () => {
  const state = fallbackEnvironment({ imageReadable: false });
  await assert.rejects(
    state.context.generate(new File(['unsupported photo'], 'photo.heic', { type: 'image/heic' })),
    /saving it as JPG or PNG.*My Files/
  );
  assert.deepEqual(state.revoked, ['blob:gallery-photo']);
  assert.equal(state.errors.length, 1);
});

test('message images use the smaller compressed file and report encoding failures', async () => {
  const messages = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'messages.js'), 'utf8');
  const shrink = messages.slice(messages.indexOf('async function shrinkImage('), messages.indexOf('\nfunction replyText('));
  const context = {
    File, createImageCover: async () => new File([new Uint8Array(1000)], 'cover.jpg', { type: 'image/jpeg' })
  };
  vm.runInNewContext(shrink, context);
  const large = new File([new Uint8Array(500000)], 'photo.png', { type: 'image/png' });
  const result = await context.shrinkImage(large);
  assert.equal(result.size, 1000);
  assert.equal(result.name, 'photo.jpg');
  assert.equal(result.type, 'image/jpeg');
  const small = new File(['small'], 'small.png', { type: 'image/png' });
  const detached = await context.shrinkImage(small);
  assert.notEqual(detached, small);
  assert.equal(detached.name, small.name);
  assert.equal(detached.type, small.type);
  assert.equal(await detached.text(), await small.text());
  context.createImageCover = async () => { throw new Error('Image decoding failed'); };
  await assert.rejects(context.shrinkImage(large), /Image decoding failed/);
  const gif = new File([new Uint8Array(500000)], 'animated.gif', { type: 'image/gif' });
  const preserved = await context.shrinkImage(gif);
  assert.equal(preserved.type, gif.type);
  assert.deepEqual(await preserved.arrayBuffer(), await gif.arrayBuffer());
});

test('incomplete Gallery reads are rejected before decoding or preparing an attachment', async () => {
  const messages = fs.readFileSync(path.join(__dirname, '../frontend/js/messages.js'), 'utf8');
  const shrink = messages.slice(messages.indexOf('async function shrinkImage('), messages.indexOf('\nfunction replyText('));
  const errors = [];
  const context = { File, console: { error: (...args) => errors.push(args) } };
  vm.runInNewContext(shrink, context);
  await assert.rejects(context.shrinkImage({
    name: 'photo.jpg', type: 'image/jpeg', size: 100,
    arrayBuffer: async () => new ArrayBuffer(2)
  }), /could not read this photo from Gallery/);
  assert.equal(errors.length, 1);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'messages.js'), 'utf8');
const cropSource = source.slice(source.indexOf('function cropStickerCanvas('), source.indexOf('function traceStickerSelection('));

function setup(width, height, points, contextAvailable = true) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (const [x, y, alpha] of points) pixels[(y * width + x) * 4 + 3] = alpha;
  const calls = [];
  const cropped = { getContext: () => contextAvailable ? { drawImage: (...args) => calls.push(args) } : null };
  const context = { document: { createElement: () => cropped } };
  vm.runInNewContext(`${cropSource}\nthis.crop = cropStickerCanvas;`, context);
  const original = { width, height };
  return { crop: () => context.crop(original, { getImageData: () => ({ data: pixels }) }), original, cropped, calls };
}

test('crops transparent margins while preserving edge pixels and aspect ratio', () => {
  const state = setup(20, 15, [[4, 3, 10], [12, 9, 255], [6, 8, 255]]);
  assert.equal(state.crop(), state.cropped);
  assert.equal(state.cropped.width, 9);
  assert.equal(state.cropped.height, 7);
  assert.deepEqual(state.calls[0], [state.original, 4, 3, 9, 7, 0, 0, 9, 7]);
});

test('preserves a full-canvas selection and single pixel selection', () => {
  const full = setup(5, 4, [[0, 0, 255], [4, 3, 255]]);
  full.crop();
  assert.equal(full.cropped.width, 5);
  assert.equal(full.cropped.height, 4);
  const single = setup(5, 4, [[2, 1, 255]]);
  single.crop();
  assert.equal(single.cropped.width, 1);
  assert.equal(single.cropped.height, 1);
});

test('rejects empty selections and unsupported export', () => {
  assert.throws(() => setup(3, 3, []).crop(), /selected area is empty/);
  assert.throws(() => setup(3, 3, [[1, 1, 255]], false).crop(), /not supported/);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'live-background.js'), 'utf8')
  .replace('export async function createBackgroundRenderer', 'async function createBackgroundRenderer')
  .replace('const { Human } = await import(moduleUrl.href);', '')
  .replaceAll('import.meta.url', "'http://localhost/js/live-background.js'");

function environment({ fail = false, values } = {}) {
  let now = 100;
  let disposed = false;
  let removed = false;
  const mask = values || new Float32Array(256 * 256).fill(0.9);
  const model = {
    execute() {
      return { data: async () => {
        if (fail) throw new Error('inference failed');
        return mask;
      }, dispose() {} };
    },
    dispose() { disposed = true; }
  };
  const tf = {
    setBackend: async () => {}, ready: async () => {},
    loadGraphModel: async () => model,
    getBackend: () => 'webgl', removeBackend() { removed = true; },
    tidy: fn => fn(), browser: { fromPixels: () => ({}) },
    cast: () => ({}), div: () => ({}), expandDims: () => ({})
  };
  const canvases = [];
  const context = {
    Human: class { constructor() { this.tf = tf; } },
    URL, setTimeout, clearTimeout,
    performance: { now: () => now },
    document: {
      createElement() {
        const canvas = { width: 0, height: 0 };
        canvas.context = {
          drawImage() {}, clearRect() {}, putImageData() {},
          createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) })
        };
        canvas.getContext = () => canvas.context;
        canvases.push(canvas);
        return canvas;
      }
    }
  };
  vm.runInNewContext(source, context);
  return { context, canvases, setTime: value => { now = value; }, isDisposed: () => disposed, isRemoved: () => removed };
}

test('background renderer uses an opaque background until a matching mask is ready or when stale', async () => {
  const env = environment();
  const draws = [];
  const ctx = { fillRect: () => draws.push('fill'), drawImage: image => draws.push(image) };
  const renderer = await env.context.createBackgroundRenderer({}, '#123456', new AbortController().signal, () => assert.fail('unexpected failure'));
  renderer.draw(ctx, 640, 480);
  assert.equal(draws.includes(env.canvases[1]), false);
  await new Promise(resolve => setTimeout(resolve, 25));
  renderer.draw(ctx, 640, 480);
  assert.equal(draws.includes(env.canvases[1]), true);
  draws.length = 0;
  env.setTime(2000);
  renderer.draw(ctx, 640, 480);
  assert.equal(draws.includes(env.canvases[1]), false);
  renderer.stop();
  assert.equal(env.isDisposed(), true);
  assert.equal(env.isRemoved(), true);
});

test('background inference failure is reported and releases the model', async () => {
  const env = environment({ fail: true });
  let failure;
  await env.context.createBackgroundRenderer({}, '#123456', new AbortController().signal, error => { failure = error; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.match(failure.message, /inference failed/);
  assert.equal(env.isDisposed(), true);
  assert.equal(env.isRemoved(), true);
});

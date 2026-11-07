const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'r2-uploads.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replaceAll('export async function ', 'async function ')
  .replaceAll('export function ', 'function ');

function setup({ failUpload = false, failEncoding = false } = {}) {
  const calls = [];
  class File {
    constructor(name, type, size) { this.name = name; this.type = type; this.size = size; }
  }
  const context = {
    File, URL, AbortController, setTimeout, clearTimeout, atob,
    encodePlaybackVideo: async (file, progress) => {
      calls.push(['encode', file]);
      if (failEncoding) throw new Error('Unsupported encoder');
      progress(0.5);
      return { original: file, playback: new File('playback.mp4', 'video/mp4', 8) };
    },
    apiRequest: async (endpoint, options) => {
      calls.push([endpoint, JSON.parse(options.body)]);
      return endpoint === '/media/stage'
        ? { workerUrl: 'https://media.example', uploadId: 'upload-id', permits: { original: 'original-permit', playback: 'playback-permit' } }
        : endpoint.startsWith('/media/playback')
          ? { url: 'https://media.example/media?permit=new-token' }
        : { published: true };
    },
    fetch: async (url, options) => {
      calls.push(['upload', url.toString(), options]);
      return { ok: !failUpload, status: failUpload ? 502 : 201 };
    }
  };
  vm.runInNewContext(source, context);
  return { context, File, calls };
}

test('uploads image bytes to R2 before publishing', async () => {
  const { context, File, calls } = setup();
  const file = new File('image.jpg', 'image/jpeg', 20);
  const result = await context.uploadPublicMedia(file, { kind: 'post', caption: 'hello', protected: true });
  assert.equal(result.published, true);
  assert.equal(calls[0][0], '/media/stage');
  assert.equal(calls[1][0], 'upload');
  assert.equal(calls[1][1], 'https://media.example/stage');
  assert.equal(calls[1][2].body, file);
  assert.equal(calls[2][0], '/media/publish');
  assert.equal(calls[2][1].protected, true);
});

test('refreshes expired playback permits through the authenticated API', async () => {
  const { context } = setup();
  context.apiRequest = async () => ({ url: 'https://media.example/media?permit=new-token' });
  const payload = Buffer.from(JSON.stringify({ expires: Math.floor(Date.now() / 1000) - 1 })).toString('base64url');
  const listeners = {};
  const element = {
    src: `https://media.example/media?permit=${payload}.signature`,
    currentTime: 0,
    addEventListener(name, callback) { listeners[name] = callback; }
  };
  const item = { id: 'post-id', has_original: true };
  context.refreshExpiredMedia(element, item, 'post');
  await listeners.error();
  assert.equal(element.src, 'https://media.example/media?permit=new-token');
  assert.equal(item.media_url, element.src);
});

test('encodes on device and uploads both the original and playback copy', async () => {
  const { context, File, calls } = setup();
  const file = new File('video.mp4', 'video/mp4', 20);
  const progress = [];
  await context.uploadPublicMedia(file, { kind: 'story', onProgress: message => progress.push(message) });
  assert.equal(calls[0][0], 'encode');
  assert.equal(calls[1][0], '/media/stage');
  assert.equal(calls[2][2].body, file);
  assert.equal(calls[3][2].body.name, 'playback.mp4');
  assert.equal(calls[4][0], '/media/publish');
  assert.ok(progress.some(message => message.includes('50%')));
});

test('does not publish or fall back to Supabase on encoding or R2 upload failure', async () => {
  const encoding = setup({ failEncoding: true });
  await assert.rejects(encoding.context.uploadPublicMedia(new encoding.File('v.mp4', 'video/mp4', 20), { kind: 'post' }), /Unsupported encoder/);
  assert.deepEqual(encoding.calls.map(call => call[0]), ['encode']);
  const upload = setup({ failUpload: true });
  await assert.rejects(upload.context.uploadPublicMedia(new upload.File('i.jpg', 'image/jpeg', 20), { kind: 'post' }), /HTTP 502/);
  assert.deepEqual(upload.calls.map(call => call[0]), ['/media/stage', 'upload', '/media/abort']);
});

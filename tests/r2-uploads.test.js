const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'r2-uploads.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replaceAll('export async function ', 'async function ')
  .replaceAll('export function ', 'function ');

function setup({ failUpload = false, failEncoding = false, failVideoCover = false } = {}) {
  const calls = [];
  class File extends Blob {
    constructor(name, type, size) {
      if (Array.isArray(name)) {
        super(name, type && size);
        this.name = type;
        this.lastModified = size.lastModified;
      } else {
        super([new Uint8Array(size).fill(42)], { type });
        this.name = name;
        this.lastModified = 123;
      }
    }
  }
  const context = {
    File, Blob, URL, AbortController, TypeError, setTimeout, clearTimeout, atob,
    encodePlaybackVideo: async (file, progress) => {
      calls.push(['encode', file]);
      if (failEncoding) throw new Error('Unsupported encoder');
      progress(0.5);
      return { original: file, playback: new File('playback.mp4', 'video/mp4', 8) };
    },
    createVideoCover: async () => {
      if (failVideoCover) throw new Error('WebP covers are not supported');
      return new File('cover.webp', 'image/webp', 5);
    },
    createImageCover: async () => new File('cover.jpg', 'image/jpeg', 5),
    apiRequest: async (endpoint, options) => {
      calls.push([endpoint, JSON.parse(options.body)]);
      return endpoint === '/media/stage'
        ? { workerUrl: 'https://media.example', uploadId: 'upload-id', permits: { original: 'original-permit', playback: 'playback-permit', cover: 'cover-permit' } }
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
  assert.notEqual(calls[1][2].body, file);
  assert.deepEqual([...new Uint8Array(await calls[1][2].body.arrayBuffer())], Array(20).fill(42));
  assert.equal(calls[1][2].body.name, file.name);
  assert.equal(calls[1][2].body.lastModified, file.lastModified);
  assert.equal(calls[2][2].body.name, 'cover.jpg');
  assert.equal(calls[3][0], '/media/publish');
  assert.equal(calls[3][1].protected, true);
  assert.equal(calls[3][1].allowRepost, true);
});

test('preserves disabled repost permission for images and videos', async () => {
  for (const [name, type] of [['image.jpg', 'image/jpeg'], ['video.mp4', 'video/mp4']]) {
    const { context, File, calls } = setup();
    await context.uploadPublicMedia(new File(name, type, 20), { kind: 'post', allowRepost: false });
    assert.equal(calls.find(call => call[0] === '/media/publish')[1].allowRepost, false);
  }
});

test('refreshes expired playback permits through the authenticated API', async () => {
  const { context } = setup();
  context.apiRequest = async () => ({ url: 'https://media.example/media?permit=new-token' });
  const payload = Buffer.from(JSON.stringify({ expires: Math.floor(Date.now() / 1000) - 1 })).toString('base64url');
  const listeners = {};
  const element = {
    isConnected: true,
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

test('refreshes legacy gateway permits without enabling original download', async () => {
  const { context } = setup();
  let endpoint;
  context.apiRequest = async path => {
    endpoint = path;
    return { url: 'https://media.example/media?permit=new-token' };
  };
  const payload = Buffer.from(JSON.stringify({ expires: Math.floor(Date.now() / 1000) - 1 })).toString('base64url');
  const listeners = {};
  const element = {
    isConnected: true,
    src: `https://media.example/media?permit=${payload}.signature`,
    currentTime: 0,
    addEventListener(name, callback) { listeners[name] = callback; }
  };
  const item = { id: 'legacy-id', has_original: false, has_expiring_media_url: true };
  context.refreshExpiredMedia(element, item, 'story');
  await listeners.error();
  assert.equal(endpoint, '/media/playback?kind=story&id=legacy-id');
  assert.equal(item.has_original, false);
  assert.equal(item.media_url, 'https://media.example/media?permit=new-token');
});

test('retries a transient media load failure once without changing the URL', async () => {
  const { context } = setup();
  context.setTimeout = callback => callback();
  const url = 'https://media.example/photo.jpg';
  let writes = 0;
  let onError;
  const element = {
    isConnected: true,
    get src() { return url; },
    set src(value) { assert.equal(value, url); writes++; },
    addEventListener(name, callback) { if (name === 'error') onError = callback; }
  };
  context.refreshExpiredMedia(element, {}, 'post');
  await onError();
  await onError();
  assert.equal(writes, 1);
});

test('encodes on device and uploads both the original and playback copy', async () => {
  const { context, File, calls } = setup();
  const file = new File('video.mp4', 'video/mp4', 20);
  const progress = [];
  await context.uploadPublicMedia(file, { kind: 'story', onProgress: message => progress.push(message) });
  assert.equal(calls[0][0], 'encode');
  assert.equal(calls[1][0], '/media/stage');
  assert.equal(calls[2][2].body, calls[0][1]);
  assert.notEqual(calls[2][2].body, file);
  assert.equal(calls[3][2].body.name, 'playback.mp4');
  assert.equal(calls[4][2].body.name, 'cover.webp');
  assert.equal(calls[1][1].cover.contentType, 'image/webp');
  assert.equal(calls[5][0], '/media/publish');
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

test('does not stage a video when its required WebP cover cannot be created', async () => {
  const { context, File, calls } = setup({ failVideoCover: true });
  await assert.rejects(
    context.uploadPublicMedia(new File('video.mp4', 'video/mp4', 20), { kind: 'post' }),
    /WebP covers are not supported/
  );
  assert.deepEqual(calls.map(call => call[0]), ['encode']);
});

test('retries network failures through the Vynzo gateway before publishing', async () => {
  const { context, File, calls } = setup();
  context.console = { warn() {} };
  context.fetch = async (url, options) => {
    calls.push(['upload', url.toString(), options]);
    if (url.toString() === 'https://media.example/stage') throw new TypeError('Failed to fetch');
    return { ok: true, status: 201 };
  };
  await context.uploadPublicMedia(new File('image.jpg', 'image/jpeg', 20), { kind: 'story' });
  assert.deepEqual(calls.map(call => call[0]), ['/media/stage', 'upload', 'upload', 'upload', 'upload', '/media/publish']);
  assert.equal(calls[2][1], 'https://www.vynzosocial.com/media-stage');
  assert.equal(calls[2][2].headers['X-Upload-Permit'], 'original-permit');
  assert.deepEqual([...new Uint8Array(await calls[2][2].body.arrayBuffer())], Array(20).fill(42));
  assert.equal(calls[4][1], 'https://www.vynzosocial.com/media-stage');
});

test('aborts staging if both upload routes fail', async () => {
  const { context, File, calls } = setup();
  context.console = { warn() {}, error() {} };
  context.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(context.uploadPublicMedia(new File('image.jpg', 'image/jpeg', 20), { kind: 'story' }), /Could not reach the media upload service/);
  assert.deepEqual(calls.map(call => call[0]), ['/media/stage', '/media/abort']);
});

test('reports unreadable selected files before encoding or staging', async () => {
  const { context, File, calls } = setup();
  context.console = { warn() {}, error() {} };
  context.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const file = new File('image.jpg', 'image/jpeg', 20);
  file.arrayBuffer = async () => { throw new Error('Cannot read file'); };
  await assert.rejects(context.uploadPublicMedia(file, { kind: 'story' }), /could not read this selection from Gallery/);
  assert.deepEqual(calls.map(call => call[0]), []);
});

test('snapshots selected bytes before encoding and reuses them after direct upload failure', async () => {
  const { context, File, calls } = setup();
  context.console = { warn() {}, error() {} };
  const file = new File('video.mp4', 'video/mp4', 20);
  let readable = true;
  const read = file.arrayBuffer.bind(file);
  file.arrayBuffer = async () => {
    if (!readable) throw new Error('Provider no longer grants access');
    return read();
  };
  context.encodePlaybackVideo = async selected => {
    readable = false;
    return { playback: new File('playback.mp4', 'video/mp4', 8) };
  };
  context.fetch = async (url, options) => {
    calls.push(['upload', url.toString(), options]);
    if (url.toString() === 'https://media.example/stage') throw new TypeError('Failed to fetch');
    return { ok: true, status: 201 };
  };
  await context.uploadPublicMedia(file, { kind: 'story' });
  const original = calls.find(call => call[0] === 'upload' && call[1] === 'https://www.vynzosocial.com/media-stage');
  assert.deepEqual([...new Uint8Array(await original[2].body.arrayBuffer())], Array(20).fill(42));
  assert.equal(calls.at(-1)[0], '/media/publish');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('download worker serves only the published APK for GET and HEAD', async () => {
  const { default: worker } = await import('../workers/app-download/index.mjs');
  const calls = [];
  const bucket = {
    async get(key) {
      calls.push(['get', key]);
      return { size: 3, httpEtag: '"etag"', body: 'apk' };
    },
    async head(key) {
      calls.push(['head', key]);
      return { size: 3, httpEtag: '"etag"' };
    }
  };
  const url = 'https://example.test/vynzo-android-1.0.apk';
  const response = await worker.fetch(new Request(url), { DOWNLOADS: bucket });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'apk');
  assert.equal(response.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.equal((await worker.fetch(new Request(url, { method: 'HEAD' }), { DOWNLOADS: bucket })).status, 200);
  assert.equal((await worker.fetch(new Request(url, { method: 'POST' }), { DOWNLOADS: bucket })).status, 405);
  assert.equal((await worker.fetch(new Request('https://example.test/other'), { DOWNLOADS: bucket })).status, 404);
  assert.deepEqual(calls, [['get', 'vynzo-android-1.0.apk'], ['head', 'vynzo-android-1.0.apk']]);
  assert.equal((await worker.fetch(new Request(url), { DOWNLOADS: { get: async () => null } })).status, 404);
});

test('welcome and signed-in home pages link to the published APK', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../frontend/css/app-download.css'), 'utf8');
  const url = 'https://vynzo-app-download.vynzolive.workers.dev/vynzo-android-1.6.apk';
  assert.equal(html.split(`href="${url}"`).length - 1, 2);
  assert.match(html, /class="app-download-link welcome-app-download"/);
  assert.match(html, /class="home-app-download"/);
  assert.match(css, /\.vynzo-android-app \.welcome-app-download/);
  assert.match(css, /\.vynzo-android-app \.home-app-download/);
});

test('Windows update feed is not cached and versioned downloads support byte ranges', async () => {
  const { default: worker } = await import('../workers/app-download/index.mjs');
  const content = 'installer';
  const reads = [];
  const bucket = {
    head: async () => ({ size: content.length, httpEtag: '"windows"' }),
    get: async (file, options) => {
      reads.push(file);
      const range = options?.range;
      return {
        size: content.length, httpEtag: '"windows"',
        body: range ? content.slice(range.offset, range.offset + range.length) : content
      };
    }
  };
  const feed = await worker.fetch(new Request('https://example.test/windows/latest.yml'), { DOWNLOADS: bucket });
  assert.equal(feed.status, 200);
  assert.equal(feed.headers.get('cache-control'), 'no-store');
  const url = 'https://example.test/windows/VynzoSocial-Setup-1.2.0-x64.exe';
  for (const [range, text, contentRange] of [
    ['bytes=0-2', 'ins', 'bytes 0-2/9'],
    ['bytes=-3', 'ler', 'bytes 6-8/9']
  ]) {
    const result = await worker.fetch(new Request(url, { headers: { Range: range } }), { DOWNLOADS: bucket });
    assert.equal(result.status, 206);
    assert.equal(await result.text(), text);
    assert.equal(result.headers.get('content-range'), contentRange);
    assert.equal(result.headers.get('content-length'), '3');
  }
  const before = reads.length;
  for (const range of ['bytes=9-', 'bytes=3-1', 'bytes=0-1,4-5']) {
    const result = await worker.fetch(new Request(url, { headers: { Range: range } }), { DOWNLOADS: bucket });
    assert.equal(result.status, 416);
    assert.equal(result.headers.get('content-range'), 'bytes */9');
  }
  assert.equal(reads.length, before);
  const full = await worker.fetch(new Request(url), { DOWNLOADS: bucket });
  assert.equal(full.status, 200);
  assert.match(full.headers.get('cache-control'), /immutable/);
  const blockmap = await worker.fetch(new Request(`${url}.blockmap`), { DOWNLOADS: bucket });
  assert.equal(blockmap.status, 200);
  for (const path of ['windows/private.pem', 'windows/arbitrary.exe', 'windows/VynzoSocial-Setup-1.2.0-x64.exe/extra']) {
    assert.equal((await worker.fetch(new Request(`https://example.test/${path}`), { DOWNLOADS: bucket })).status, 404);
  }
});

test('home header links Snapchat next to Instagram', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../frontend/css/app-download.css'), 'utf8');
  assert.match(html, /class="instagram-icon-link"[\s\S]*?<\/a>\s*<a class="snapchat-icon-link" href="https:\/\/www\.snapchat\.com\/@vynzosocial" target="_blank" rel="noopener noreferrer" aria-label="Vynzo on Snapchat"/);
  assert.match(css, /\.snapchat-icon-link\s*\{\s*background:\s*#fffc00/);
});

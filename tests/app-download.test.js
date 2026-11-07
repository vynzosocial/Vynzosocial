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
  const url = 'https://vynzo-app-download.vynzolive.workers.dev/vynzo-android-1.2.apk';
  assert.equal(html.split(`href="${url}"`).length - 1, 2);
  assert.match(html, /class="app-download-link welcome-app-download"/);
  assert.match(html, /class="home-app-download"/);
  assert.match(css, /\.vynzo-android-app \.welcome-app-download/);
  assert.match(css, /\.vynzo-android-app \.home-app-download/);
});

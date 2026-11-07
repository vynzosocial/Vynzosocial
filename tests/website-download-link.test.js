const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the website exposes the Android download on the welcome and home screens', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../frontend/css/app-download.css'), 'utf8');
  const url = 'https://vynzo-app-download.vynzolive.workers.dev/vynzo-android-1.2.apk';
  assert.equal(html.split(`href="${url}"`).length - 1, 2);
  assert.match(html, /class="app-download-link welcome-app-download"/);
  assert.match(html, /class="home-app-download"/);
  assert.match(css, /\.vynzo-android-app \.welcome-app-download/);
  assert.match(css, /\.vynzo-android-app \.home-app-download/);
});

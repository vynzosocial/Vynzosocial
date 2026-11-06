const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const frontend = path.resolve(appRoot, '..', 'frontend');

test('Android web bundle shows separate login and signup links without changing the website', () => {
  execFileSync(process.execPath, [path.join(appRoot, 'scripts', 'prepare-web.js')]);

  const website = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const android = fs.readFileSync(path.join(appRoot, 'www', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(appRoot, 'www', 'css', 'landing.css'), 'utf8');

  assert.doesNotMatch(website, /<html class="vynzo-android-app"/);
  assert.match(android, /<html class="vynzo-android-app"/);
  assert.match(android, /class="welcome-web-auth"|class="[^"]*welcome-web-auth/);
  assert.match(android, /class="welcome-app-auth"[\s\S]*href="\.\/pages\/login\.html">Log in<\/a>[\s\S]*href="\.\/pages\/register\.html">Sign up<\/a>/);
  assert.match(css, /\.welcome-app-auth\s*\{\s*display:\s*none/);
  assert.match(css, /\.vynzo-android-app \.welcome-nav \.welcome-web-auth\s*\{\s*display:\s*none/);
  assert.match(css, /\.vynzo-android-app \.welcome-app-auth\s*\{\s*display:\s*inline-flex/);
});

test('tablet stylesheet is included in every Android page, not the website pages', () => {
  function checkPages(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        checkPages(path.join(directory, entry.name), name);
      } else if (entry.name.endsWith('.html')) {
        const website = fs.readFileSync(path.join(frontend, name), 'utf8');
        const android = fs.readFileSync(path.join(appRoot, 'www', name), 'utf8');
        assert.doesNotMatch(website, /\/css\/tablet-app\.css/);
        assert.match(android, /<link rel="stylesheet" href="\/css\/tablet-app\.css\?v=1">/);
        assert.match(android, /<script src="\/ota-ready\.js"><\/script>/);
      }
    }
  }
  checkPages(frontend);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, '../frontend/css/live-layout.css'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '../frontend/pages/live.html'), 'utf8');

test('live host names wrap rather than being truncated', () => {
  const rule = css.match(/\.live-host-text strong\s*\{([^}]*)\}/);
  assert.ok(rule);
  assert.match(rule[1], /overflow-wrap:\s*anywhere/);
  assert.match(rule[1], /white-space:\s*normal/);
  assert.doesNotMatch(rule[1], /text-overflow:\s*ellipsis|overflow:\s*hidden/);
});

test('mobile header gives the host a full row without hiding controls', () => {
  const rule = css.match(/@media \(max-width: 768px\)\s*\{\s*\.live-container \.live-stage \.live-session-context\s*\{([^}]*)\}\s*\.live-container \.live-stage \.live-host-chip\s*\{([^}]*)\}/);
  assert.ok(rule);
  assert.match(rule[1], /flex-wrap:\s*wrap/);
  assert.match(rule[2], /flex:\s*1 0 100%/);
  assert.match(page, /live-layout\.css\?v=stage-layout19/);
});

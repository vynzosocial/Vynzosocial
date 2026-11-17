const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/live.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../frontend/css/live-layout.css'), 'utf8');

test('live stage has no participant expansion controls or expansion state', () => {
  assert.doesNotMatch(source, /live-expand-btn|setTileExpanded|live-tile-expanded/);
  assert.doesNotMatch(css, /live-expand-btn|live-tile-expanded|\.live-video-frame\.is-expanded/);
  assert.match(source, /video\.setAttribute\('controlslist', 'nofullscreen'\)/);
});

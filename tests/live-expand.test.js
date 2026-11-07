const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/live.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../frontend/css/live-layout.css'), 'utf8');
const expansion = source.slice(source.indexOf('function setTileExpanded('), source.indexOf('\nconst tileInfoCache'));
const removeTile = source.slice(source.indexOf('function removeVideoTile('), source.indexOf('\nfunction showGuestRequest('));
const visibility = source.slice(source.indexOf('function setTileVisible('), source.indexOf('\nfunction registerLiveListeners('));

function classList() {
  const classes = new Set();
  return {
    contains: value => classes.has(value),
    toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); }
  };
}

function setup() {
  const frames = [];
  const body = { classList: classList() };
  let onKeydown;
  const document = {
    body,
    addEventListener(type, handler) { if (type === 'keydown') onKeydown = handler; },
    querySelectorAll(selector) {
      if (selector === '.live-video-frame.is-expanded') return frames.filter(frame => frame.classList.contains('is-expanded'));
      if (selector === '.live-video-frame') return frames;
      throw new Error(`Unexpected selector: ${selector}`);
    }
  };
  const context = { document, updateVideoGridLayout() {} };
  vm.runInNewContext(`${expansion}\n${removeTile}\n${visibility}`, context);
  function addFrame(id) {
    const button = { textContent: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
    const frame = {
      dataset: { peerId: id }, classList: classList(), style: {}, button,
      querySelector: () => button,
      remove() { frames.splice(frames.indexOf(this), 1); }
    };
    frames.push(frame);
    return frame;
  }
  return { context, body, addFrame, keydown: event => onKeydown(event) };
}

test('expanded camera can return to normal size and another tile can be expanded', () => {
  const { context, body, addFrame, keydown } = setup();
  const first = addFrame('first');
  const second = addFrame('second');
  context.setTileExpanded(first, true);
  assert.equal(first.button.attributes['aria-label'], 'Return to normal size');
  assert.equal(body.classList.contains('live-tile-expanded'), true);
  context.setTileExpanded(first, false);
  assert.equal(first.classList.contains('is-expanded'), false);
  assert.equal(body.classList.contains('live-tile-expanded'), false);
  context.setTileExpanded(first, true);
  context.setTileExpanded(second, true);
  assert.equal(first.classList.contains('is-expanded'), false);
  assert.equal(second.classList.contains('is-expanded'), true);
  keydown({ key: 'Escape' });
  assert.equal(second.classList.contains('is-expanded'), false);
  assert.equal(body.classList.contains('live-tile-expanded'), false);
});

test('hiding or removing an expanded camera clears the expanded state', () => {
  const { context, body, addFrame } = setup();
  const first = addFrame('first');
  context.setTileExpanded(first, true);
  context.setTileVisible(first, false);
  assert.equal(body.classList.contains('live-tile-expanded'), false);
  const second = addFrame('second');
  context.setTileExpanded(second, true);
  context.removeVideoTile('second');
  assert.equal(body.classList.contains('live-tile-expanded'), false);
});

test('expanded controls escape the mobile stacking and clipping contexts', () => {
  assert.match(css, /body\.live-tile-expanded \.live-container \.live-stage \.live-video-area\s*\{[^}]*z-index:\s*10000;[^}]*overflow:\s*visible/s);
  assert.match(css, /body\.live-tile-expanded \.live-container \.live-stage \.live-video-grid\s*\{\s*overflow:\s*visible/);
  assert.doesNotMatch(source, /Tap "Request to Join" to ask the host to put you on camera/);
});

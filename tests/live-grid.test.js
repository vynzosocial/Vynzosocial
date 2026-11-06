const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'live.js'), 'utf8');
const layout = source.slice(source.indexOf('function updateVideoGridLayout() {'), source.indexOf('\nfunction setTileVisible('));
assert.ok(layout.startsWith('function updateVideoGridLayout() {'));

function createGrid(peerIds, isGuest, width = 360, height = 400) {
  const frames = peerIds.map(peerId => ({
    dataset: { peerId },
    hidden: false,
    style: {},
    classList: { remove() {} }
  }));
  const emptySlots = [];
  const stage = { classList: { toggle(_name, enabled) { this.enabled = enabled; } } };
  const grid = {
    dataset: {}, style: {}, clientWidth: width, clientHeight: height,
    querySelectorAll(selector) {
      if (selector === '.live-video-frame') return frames;
      if (selector === '.live-slot-empty') return [...emptySlots];
      return [...frames, ...emptySlots];
    },
    appendChild(el) { emptySlots.push(el); },
    closest() { return stage; }
  };
  const context = {
    document: {
      getElementById(id) { return id === 'live-video-grid' ? grid : null; },
      createElement() {
        return { style: {}, remove() { emptySlots.splice(emptySlots.indexOf(this), 1); } };
      }
    },
    isGuestRole: () => isGuest,
    liveHostSocketId: 'host',
    stageGuestIds: new Set(['guest']),
    getComputedStyle: () => ({
      columnGap: '3px', rowGap: '3px',
      paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px'
    })
  };
  vm.runInNewContext(`${layout}\nupdateVideoGridLayout();`, context);
  return { grid, frames, emptySlots, stage, context };
}

test('host and guest share a single row on phones for both participants', () => {
  for (const [ids, isGuest, hostIndex] of [
    [['self', 'guest'], false, 0],
    [['self', 'host'], true, 1]
  ]) {
    const { grid, frames } = createGrid(ids, isGuest);
    assert.equal(grid.dataset.layout, 'two');
    assert.equal(grid.style.gridTemplateColumns, 'repeat(2, 178px)');
    assert.equal(grid.style.gridTemplateRows, 'repeat(1, 178px)');
    assert.equal(frames[hostIndex].style.order, '-1');
    assert.equal(frames[1 - hostIndex].style.order, '');
    assert.equal(frames[0].style.width, frames[1].style.width);
  }
});

test('single and three-person layouts remain unchanged', () => {
  const one = createGrid(['self'], false);
  assert.equal(one.grid.dataset.layout, 'equal');
  assert.equal(one.grid.style.gridTemplateColumns, 'repeat(1, 360px)');
  assert.equal(one.grid.style.gridTemplateRows, 'repeat(1, 360px)');

  const three = createGrid(['self', 'guest', 'guest2'], false);
  assert.equal(three.grid.dataset.layout, 'equal');
  assert.equal(three.grid.style.gridTemplateColumns, 'repeat(2, 178px)');
  assert.equal(three.grid.style.gridTemplateRows, 'repeat(2, 178px)');
  assert.equal(three.emptySlots.length, 1);
});

test('layout recalculates when a guest leaves or joins', () => {
  const { grid, frames, context } = createGrid(['self', 'guest'], false);
  frames[1].hidden = true;
  vm.runInNewContext('updateVideoGridLayout()', context);
  assert.equal(grid.dataset.layout, 'equal');
  assert.equal(grid.style.gridTemplateColumns, 'repeat(1, 360px)');
  frames[1].hidden = false;
  vm.runInNewContext('updateVideoGridLayout()', context);
  assert.equal(grid.dataset.layout, 'two');
  assert.equal(grid.style.gridTemplateColumns, 'repeat(2, 178px)');
});

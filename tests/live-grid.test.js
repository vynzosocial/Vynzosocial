const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/live.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../frontend/css/live-layout.css'), 'utf8');
const layout = source.slice(source.indexOf('function updateVideoGridLayout() {'), source.indexOf('\nfunction setTileVisible('));

function createGrid(ids, guest = false, width = 1000, height = 600) {
  const slots = [];
  const frames = ids.map(peerId => ({
    dataset: { peerId }, hidden: false, style: {}, classList: { remove() {} }
  }));
  const stage = { classes: {}, classList: { toggle(name, enabled) { stage.classes[name] = enabled; } } };
  const grid = {
    dataset: { choice: 'full' }, style: {}, clientWidth: width, clientHeight: height,
    querySelectorAll(selector) { return selector === '.live-video-frame' ? frames : [...slots]; },
    appendChild(slot) { slots.push(slot); },
    closest() { return stage; }
  };
  const context = {
    document: {
      getElementById: id => id === 'live-video-grid' ? grid : null,
      createElement(tagName) {
        return {
          tagName, style: {}, attributes: {},
          setAttribute(name, value) { this.attributes[name] = value; },
          addEventListener(_type, fn) { this.click = fn; },
          remove() { slots.splice(slots.indexOf(this), 1); }
        };
      }
    },
    openLiveGuestInvites() {},
    isGuestRole: () => guest, liveHostSocketId: 'host',
    stageGuestIds: new Set(ids.filter(id => id !== 'host' && id !== 'self')),
    socket: { id: guest ? 'guest-self' : 'host' },
    getComputedStyle: () => ({
      columnGap: '6px', rowGap: '6px',
      paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px'
    })
  };
  vm.runInNewContext(layout, context);
  return { grid, frames, slots, stage, context };
}

test('host overlay keeps a full-size host behind eight fixed side slots on every screen', () => {
  for (const [width, height] of [[1000, 600], [360, 640], [740, 300]]) {
    const { grid, frames, slots, stage, context } = createGrid(['self', 'a', 'b'], false, width, height);
    grid.dataset.choice = 'host-overlay';
    context.updateVideoGridLayout();
    assert.equal(stage.classes['live-solo'], true);
    assert.equal(stage.classes['live-multi'], false);
    assert.equal(frames[0].style.gridColumn, '1 / span 3');
    assert.equal(frames[0].style.gridRow, '1 / span 6');
    assert.equal(frames[0].style.zIndex, '0');
    assert.equal(frames[0].style.aspectRatio, 'auto');
    assert.equal(frames[1].style.gridColumn, '1 / span 1');
    assert.equal(frames[1].style.gridRow, '2 / span 1');
    assert.equal(frames[2].style.gridRow, '3 / span 1');
    assert.equal(slots.length, 6);
    assert.equal(slots[0].style.gridColumn, '1');
    assert.equal(slots[0].style.gridRow, '4');
    assert.equal(slots[5].style.gridColumn, '3');
    assert.equal(slots[5].style.gridRow, '5');
    assert.ok(slots.every(slot => slot.tagName === 'button' && slot.click && slot.innerHTML.includes('Invite')));
    const side = Math.floor(Math.min((width - 12) / 4.4, (height - 30) / 5.8));
    assert.equal(grid.style.gridTemplateColumns, `${side}px minmax(0, 1fr) ${side}px`);
    assert.equal(grid.style.gridTemplateRows, `minmax(0, 1fr) repeat(4, ${side}px) minmax(0, 1.8fr)`);
    assert.ok(side * 4 + 30 <= height);
    assert.ok(side * 2 + 12 < width);
  }
});

test('overlay slots follow joins and leaves, clear on switching, and restore after overflow', () => {
  const { grid, frames, slots, context } = createGrid(['self', ...Array.from({ length: 11 }, (_, i) => `g${i}`)]);
  grid.dataset.choice = 'host-overlay';
  frames.slice(1).forEach(frame => { frame.hidden = true; });
  context.updateVideoGridLayout();
  assert.equal(slots.length, 8);
  frames.slice(1, 9).forEach(frame => { frame.hidden = false; });
  context.updateVideoGridLayout();
  assert.equal(grid.dataset.layout, 'host-overlay');
  assert.equal(slots.length, 0);
  assert.equal(frames[8].style.gridColumn, '3 / span 1');
  assert.equal(frames[8].style.gridRow, '5 / span 1');
  frames.slice(9).forEach(frame => { frame.hidden = false; });
  context.updateVideoGridLayout();
  assert.equal(grid.dataset.layout, 'overflow');
  assert.equal(frames[0].style.zIndex, '');
  frames.slice(2).forEach(frame => { frame.hidden = true; });
  context.updateVideoGridLayout();
  assert.equal(grid.dataset.layout, 'host-overlay');
  assert.equal(slots.length, 7);
  grid.dataset.choice = 'two';
  context.updateVideoGridLayout();
  assert.equal(slots.length, 0);
  assert.equal(frames[0].style.aspectRatio, '1 / 1');
});

test('viewers see matching overlay positions without host invitation controls', () => {
  const host = createGrid(['self', 'z', 'guest-self']);
  const guest = createGrid(['self', 'host', 'z'], true);
  for (const scene of [host, guest]) {
    scene.grid.dataset.choice = 'host-overlay';
    scene.context.updateVideoGridLayout();
  }
  assert.equal(host.frames[0].style.gridRow, guest.frames[1].style.gridRow);
  assert.equal(host.frames[2].style.gridRow, guest.frames[0].style.gridRow);
  assert.equal(host.frames[1].style.gridRow, guest.frames[2].style.gridRow);
  assert.ok(guest.slots.every(slot => slot.tagName === 'div' && !slot.click && slot.attributes['aria-hidden'] === 'true'));
});

for (const [choice, count, cols, rows] of [
  ['full', 1, 1, 1], ['two', 2, 2, 1], ['four', 4, 2, 2],
  ['six', 6, 3, 2], ['host-left', 9, 6, 4], ['top-two', 10, 4, 4]
]) {
  test(`${choice} layout fills its specified grid`, () => {
    const ids = ['self', ...Array.from({ length: count - 1 }, (_, i) => `guest${i}`)];
    const { grid, frames, stage, context } = createGrid(ids);
    grid.dataset.choice = choice;
    context.updateVideoGridLayout();
    assert.equal(grid.dataset.layout, choice);
    const side = Math.floor(Math.min((1000 - 6 * (cols - 1)) / cols, (600 - 6 * (rows - 1)) / rows));
    if (choice === 'full') {
      assert.equal(grid.style.gridTemplateColumns, 'repeat(1, minmax(0, 1fr))');
    } else {
      assert.equal(grid.style.gridTemplateColumns, `repeat(${cols}, ${side}px)`);
      assert.equal(grid.style.gridTemplateRows, `repeat(${rows}, ${side}px)`);
    }
    assert.equal(stage.classes['live-solo'], choice === 'full');
    for (const frame of frames) {
      assert.equal(frame.style.width, '100%');
      assert.equal(frame.style.height, '100%');
    }
    if (choice === 'host-left') {
      assert.equal(frames[0].style.gridColumn, '1 / span 4');
      assert.equal(frames[0].style.gridRow, '1 / span 4');
      assert.equal(frames[1].style.gridColumn, '5 / span 1');
      assert.equal(frames[8].style.gridRow, '4 / span 1');
    }
    if (choice === 'top-two') {
      assert.equal(frames[0].style.gridColumn, '1 / span 2');
      assert.equal(frames[1].style.gridColumn, '3 / span 2');
      assert.equal(frames[1].style.gridRow, '1 / span 2');
      assert.equal(frames[9].style.gridRow, '4 / span 1');
    }
  });
}

test('fallback fits everyone, including the 12-person stage, and restores the selected layout', () => {
  const ids = ['self', ...Array.from({ length: 11 }, (_, i) => `guest${i}`)];
  const { grid, frames, context } = createGrid(ids);
  grid.dataset.choice = 'four';
  context.updateVideoGridLayout();
  assert.equal(grid.dataset.layout, 'overflow');
  assert.equal(grid.style.gridTemplateColumns, 'repeat(4, 196px)');
  assert.equal(grid.style.gridTemplateRows, 'repeat(3, 196px)');
  frames.slice(4).forEach(frame => { frame.hidden = true; });
  context.updateVideoGridLayout();
  assert.equal(grid.dataset.layout, 'four');
});

test('host-left guest area resizes as participants join and leave', () => {
  const { grid, frames, context } = createGrid(['self', 'guest0', 'guest1', 'guest2', 'guest3']);
  grid.dataset.choice = 'host-left';
  frames.slice(3).forEach(frame => { frame.hidden = true; });
  context.updateVideoGridLayout();
  assert.equal(grid.style.gridTemplateColumns, 'repeat(3, 297px)');
  assert.equal(frames[0].style.gridColumn, '1 / span 2');
  assert.equal(frames[1].style.gridColumn, '3 / span 1');
  assert.equal(frames[2].style.gridRow, '2 / span 1');
  frames.slice(3).forEach(frame => { frame.hidden = false; });
  context.updateVideoGridLayout();
  assert.equal(grid.style.gridTemplateColumns, 'repeat(4, 245px)');
  assert.equal(frames[3].style.gridRow, '2 / span 1');
  assert.equal(frames[4].style.gridColumn, '4 / span 1');
});

test('top-two layout uses one guest row when four or fewer bottom guests are present', () => {
  const { grid, context } = createGrid(['self', 'a', 'b', 'c']);
  grid.dataset.choice = 'top-two';
  context.updateVideoGridLayout();
  assert.equal(grid.style.gridTemplateColumns, 'repeat(4, 196px)');
  assert.equal(grid.style.gridTemplateRows, 'repeat(3, 196px)');
});

test('host and guest place the same participants in the same slots', () => {
  const host = createGrid(['self', 'z', 'guest-self']);
  const guest = createGrid(['self', 'host', 'z'], true);
  for (const scene of [host, guest]) {
    scene.grid.dataset.choice = 'host-left';
    scene.context.updateVideoGridLayout();
  }
  assert.equal(host.frames[0].style.gridColumn, guest.frames[1].style.gridColumn);
  assert.equal(host.frames[2].style.gridColumn, guest.frames[0].style.gridColumn);
  assert.equal(host.frames[1].style.gridColumn, guest.frames[2].style.gridColumn);
});

test('solo chat overlays the stage and guest videos remain uncropped', () => {
  assert.match(css, /\.live-stage\.live-solo \.live-chat-panel\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.live-video-frame\[data-stage-guest="1"\] \.live-video-player\s*\{[^}]*object-fit:\s*cover/);
  assert.match(css, /\.live-video-frame\[data-stage-guest="1"\] \.live-video-label\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.live-stage \.live-chat-message\s*\{[^}]*font-size:\s*calc\(var\(--live-chat-font-size, 13px\) \* var\(--live-chat-text-scale, \.5\)\)/);
});

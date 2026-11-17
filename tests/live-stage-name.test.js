const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/live.js'), 'utf8');
const badge = source.slice(source.indexOf('function appendLiveWebBadge('), source.indexOf('\nfunction createLiveStage('));
const render = badge + source.slice(source.indexOf('function showStageGuestTile('), source.indexOf('\nfunction removeVideoTile('));

function element() {
  let text = '';
  return {
    children: [], style: {}, dataset: {},
    set textContent(value) { text = value; this.children = []; },
    get textContent() { return text + this.children.map(child => child.textContent).join(''); },
    setAttribute() {},
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { text = ''; this.children = children; }
  };
}

for (const platform of ['web', 'app']) {
  for (const isLocal of [false, true]) {
    for (const cameraOn of [false, true]) {
      test(`${platform} ${isLocal ? 'local' : 'remote'} guest has one name with camera ${cameraOn ? 'on' : 'off'}`, () => {
        const label = element(), avatar = element();
        const frame = {
          dataset: {},
          querySelector(selector) { return selector === '.live-video-label' ? label : avatar; }
        };
        const track = { readyState: 'live', muted: false };
        const tile = { frame, video: { srcObject: cameraOn ? { getVideoTracks: () => [track] } : null, play: () => Promise.resolve() }, status: {} };
        const context = {
          tileInfoCache: {}, ensureVideoTile: () => tile, remoteMediaStreams: {},
          remoteCameraStates: new Map(), document: { createElement: element }, API_ORIGIN: '',
          setTileCameraOff(_tile, off) { tile.cameraOff = off; }, setTileVisible() {}, console
        };
        vm.runInNewContext(render, context);
        context.showStageGuestTile(isLocal ? 'self' : 'guest', { name: 'Guest', avatar_url: '/avatar.png', platform }, isLocal);
        assert.equal(label.children.length, 2);
        assert.equal(label.children[1].textContent, `Guest${isLocal ? ' (You)' : ''}${platform === 'web' ? ' W' : ''}`);
        assert.equal(label.children[1].title, platform === 'web' ? 'W: using the website' : '');
        assert.equal(label.children[1].children.length, platform === 'web' ? 1 : 0);
        if (platform === 'web') assert.equal(label.children[1].children[0].className, 'live-web-badge');
        assert.equal(avatar.children.length, 1);
        assert.equal(avatar.textContent, '');
        assert.equal(tile.cameraOff, !cameraOn);
      });
    }
  }
}

test('guest without a profile photo keeps the avatar initial without duplicating the name', () => {
  const label = element(), avatar = element();
  const tile = {
    frame: { dataset: {}, querySelector: selector => selector === '.live-video-label' ? label : avatar },
    video: { srcObject: null }, status: {}
  };
  const context = {
    tileInfoCache: {}, ensureVideoTile: () => tile, remoteMediaStreams: {},
    remoteCameraStates: new Map(), document: { createElement: element }, API_ORIGIN: '',
    setTileCameraOff() {}, setTileVisible() {}, console
  };
  vm.runInNewContext(render, context);
  context.showStageGuestTile('guest', { name: 'Guest', platform: 'web' }, false);
  assert.equal(avatar.textContent, 'G');
  assert.equal(label.children[1].textContent, 'Guest W');
});

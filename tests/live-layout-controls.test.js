const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/live.js'), 'utf8');
const stage = source.slice(source.indexOf('function createLiveStage('), source.indexOf('\nfunction attachLiveChatForm('));
const controls = source.slice(source.indexOf('function attachLiveMediaControls() {'), source.indexOf("  document.getElementById('live-audio-devices-btn')")) + '\n}';
const badge = source.slice(source.indexOf('function appendLiveWebBadge('), source.indexOf('\nfunction createLiveStage('));
const requests = badge + source.slice(source.indexOf('function showGuestRequest('), source.indexOf('\nfunction updateVideoGridLayout('));
const ensureTile = source.slice(source.indexOf('function ensureVideoTile('), source.indexOf('\nconst tileInfoCache'));

test('only the host has the grid layout menu in the header', () => {
  const context = { escapeHtml: value => value, liveAvatarHtml: () => '' };
  vm.runInNewContext(stage, context);
  for (const host of [true, false]) {
    const markup = context.createLiveStage('', host);
    assert.match(markup, /id="live-chat-toggle" aria-expanded="true"/);
    const menuPanel = markup.slice(markup.indexOf('id="live-media-menu-panel"'), markup.indexOf('id="live-chat-input"'));
    assert.ok(menuPanel.includes('id="live-chat-toggle"'), 'Hide chat is inside Settings');
    assert.ok(menuPanel.includes('id="live-switch-camera-btn"'), 'Switch camera is inside Settings for hosts and guests');
    assert.equal(markup.slice(0, markup.indexOf('id="live-media-menu-panel"')).includes('id="live-switch-camera-btn"'), false);
    assert.equal(markup.match(/id="live-switch-camera-btn"/g).length, 1);
    assert.doesNotMatch(markup, /live-(?:grid|focus)-view-btn/);
    const header = markup.slice(markup.indexOf('<header'), markup.indexOf('</header>'));
    assert.equal(header.includes('id="live-grid-menu"'), host);
    if (host) {
      for (const layout of ['full', 'two', 'four', 'six', 'host-left', 'top-two', 'host-overlay']) {
        assert.ok(header.includes(`data-layout="${layout}"`));
      }
    }
    assert.equal(markup.includes('id="live-host-panel"'), host);
    assert.equal(markup.includes('id="live-guest-requests"'), host);
    assert.equal(markup.includes('id="live-host-guests"'), host);
  }
});

test('new live layout labels are available in every supported translation', () => {
  const keys = ['Grid', 'Host only', 'Two people', 'Host and guests', 'Two above guests',
    'Host with side guests', 'Invite', 'No viewers available to invite',
    'Show chat', 'Hide chat', 'Manage guests', 'Requests', 'On stage', 'Live media controls'];
  for (const language of ['ar', 'de', 'es', 'fr', 'hi', 'nl', 'pt', 'ru', 'ur']) {
    const text = fs.readFileSync(path.join(__dirname, `../frontend/js/i18n-${language}.js`), 'utf8');
    const context = { window: {} };
    vm.runInNewContext(text, context);
    for (const key of keys) assert.ok(context.window.VynzoI18nDicts[language][key], `${language}: ${key}`);
  }
});

test('chat collapse updates state and reflows the grid', () => {
  function button() {
    return { attributes: {}, addEventListener(_type, fn) { this.click = fn; }, setAttribute(name, value) { this.attributes[name] = value; } };
  }
  const toggle = button();
  const classes = new Set();
  const stageElement = { classList: { toggle(name) { if (classes.has(name)) { classes.delete(name); return false; } classes.add(name); return true; } } };
  const elements = { 'live-chat-toggle': toggle };
  let reflows = 0;
  const context = {
    document: { querySelector: () => stageElement, getElementById: id => elements[id] },
    liveGridResizeObserver: null,
    updateVideoGridLayout() { reflows++; }
  };
  vm.runInNewContext(controls, context);
  context.attachLiveMediaControls();
  toggle.click();
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  assert.equal(toggle.textContent, 'Show chat');
  toggle.click();
  assert.equal(toggle.attributes['aria-expanded'], 'true');
  assert.equal(reflows, 2);
});

test('host grid menu reports failures and closes only after a successful change', () => {
  const buttons = ['full', 'four'].map(layout => ({
    dataset: { layout }, disabled: false,
    addEventListener(_type, fn) { this.click = fn; }
  }));
  const menu = { open: true, querySelectorAll: () => buttons };
  let answer = { ok: false, error: 'Could not change layout' };
  const errors = [], sent = [];
  const context = {
    document: {
      querySelector: () => ({}),
      getElementById: id => id === 'live-grid-menu' ? menu : null
    },
    socket: { timeout: () => ({ emit(event, layout, callback) {
      sent.push([event, layout]); callback(null, answer);
    } }) },
    liveGridResizeObserver: null,
    updateVideoGridLayout() {},
    showLiveError: message => errors.push(message)
  };
  vm.runInNewContext(controls, context);
  context.attachLiveMediaControls();
  buttons[1].click();
  assert.equal(menu.open, true);
  assert.deepEqual(errors, ['Could not change layout']);
  answer = { ok: true };
  buttons[1].click();
  assert.equal(menu.open, false);
  assert.equal(buttons[1].disabled, false);
  assert.deepEqual(sent[0], ['live_set_layout', 'four']);
});

test('empty side slots open an invite picker excluding host and current guests', () => {
  const helper = source.slice(source.indexOf('function openLiveGuestInvites('), source.indexOf('\nfunction updateVideoGridLayout('));
  const viewers = source.slice(source.indexOf('function refreshViewers('), source.indexOf('\nfunction scheduleViewersRefresh('));
  function element() {
    return {
      dataset: {}, attributes: {}, children: [], hidden: true,
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(_type, fn) { this.click = fn; },
      replaceChildren(...children) { this.children = children; }
    };
  }
  const menu = element(), button = element();
  const elements = {
    'live-viewers-menu': menu, 'live-viewers-btn': button,
    'live-viewers-total': element(), 'live-viewers-avatars': element()
  };
  const invites = [], profiles = [], errors = [];
  let guestRole = false;
  let response = { ok: true, viewers: [
    { socketId: 'host', id: 'h', username: 'Host' },
    { socketId: 'on-stage', id: 'g', username: 'Guest' },
    { socketId: 'viewer', id: 'v', username: 'Viewer' }
  ] };
  const context = {
    document: { getElementById: id => elements[id], createElement: element },
    isGuestRole: () => guestRole, activeRoomSessionId: 'room',
    stageGuestIds: new Set(['on-stage']),
    liveAvatarHtml: () => '', escapeHtml: value => value,
    inviteLiveViewer: (...args) => invites.push(args),
    showProfile: id => profiles.push(id), showLiveError: error => errors.push(error),
    socket: { id: 'host', connected: true, timeout: () => ({
      emit(_event, callback) { callback(null, response); }
    }) }
  };
  vm.runInNewContext(helper + viewers, context);
  let stopped = 0;
  const event = { stopPropagation() { stopped++; } };
  context.openLiveGuestInvites(event);
  assert.equal(stopped, 1);
  assert.equal(menu.hidden, false);
  assert.equal(button.attributes['aria-expanded'], 'true');
  assert.equal(menu.children.length, 1);
  menu.children[0].click();
  assert.deepEqual(invites, [['viewer', 'Viewer']]);
  assert.deepEqual(profiles, []);
  assert.equal(menu.hidden, true);
  assert.equal(button.attributes['aria-expanded'], 'false');
  response = { ok: true, viewers: [] };
  context.openLiveGuestInvites(event);
  assert.equal(menu.children[0].textContent, 'No viewers available to invite.');
  response = { ok: false, error: 'Could not load viewers' };
  context.openLiveGuestInvites(event);
  assert.deepEqual(errors, ['Could not load viewers']);
  guestRole = true;
  menu.hidden = true;
  context.openLiveGuestInvites(event);
  assert.equal(menu.hidden, true);
  menu.dataset.inviteOnly = 'false';
  response = { ok: true, viewers: [{ id: 'v', username: 'Viewer' }] };
  context.refreshViewers();
  menu.children[0].click();
  assert.deepEqual(profiles, ['v']);
  assert.equal(invites.length, 1);
  guestRole = false;
  context.socket.connected = false;
  context.openLiveGuestInvites(event);
  assert.equal(errors.at(-1), 'Unable to load viewers. Please try again.');
});

test('video tiles retain playback recovery without expand or focus controls', () => {
  const frames = [];
  const grid = { dataset: {}, appendChild: frame => frames.push(frame) };
  const document = {
    querySelectorAll: () => frames,
    getElementById: () => grid,
    createElement() {
      return {
        dataset: {}, style: {}, attributes: {}, children: [],
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(_type, fn) { this.click = fn; },
        append(...items) { this.children.push(...items); }
      };
    }
  };
  const context = {
    document, tileInfoCache: {}, liveHostSocketId: 'host', liveHostInfo: null,
    canShowTile: () => false, setTileVisible() {}, remoteImagePeers: new Set(['guest'])
  };
  vm.runInNewContext(ensureTile, context);
  const tile = context.ensureVideoTile('guest', false);
  assert.equal(tile.frame.dataset.mediaSource, 'image');
  assert.equal(tile.frame.children.some(child => child.className === 'live-focus-tile-btn'), false);
  assert.equal(tile.frame.children.some(child => child.className === 'live-expand-btn'), false);
  const video = tile.frame.children.find(child => child.className === 'live-video-player');
  assert.equal(video.controls, false);
  const status = tile.frame.children.find(child => child.className === 'live-video-status');
  video.controls = true;
  status.hidden = false;
  video.click();
  assert.equal(video.controls, false);
  assert.equal(status.hidden, true);
});

test('new and returning guest requests open host management and close after a decision', () => {
  function element() {
    return {
      style: {}, dataset: {}, children: [],
      setAttribute() {},
      append(...items) { this.children.push(...items); },
      appendChild(item) { this.children.push(item); },
      remove() { box.children.splice(box.children.indexOf(this), 1); }
    };
  }
  const box = element();
  box.querySelector = selector => box.children.find(child => selector === `[data-socket-id="${child.dataset.socketId}"]`);
  const panel = { open: false }, count = {}, events = [];
  const document = {
    getElementById(id) { return { 'live-guest-requests': box, 'live-host-panel': panel, 'live-request-count': count }[id]; },
    createElement: element
  };
  const context = { document, API_ORIGIN: '', socket: { emit: (...args) => events.push(args) } };
  vm.runInNewContext(requests, context);
  context.showGuestRequest('guest', 'Guest', null, 'app');
  context.showGuestRequest('guest', 'Guest', null, 'app');
  assert.equal(panel.open, true);
  assert.equal(count.textContent, '(1)');
  assert.equal(box.children.length, 1);
  box.children[0].children[1].onclick();
  assert.equal(panel.open, false);
  assert.equal(events[0][0], 'live_guest_decision');
  assert.equal(events[0][1].socketId, 'guest');
  assert.equal(events[0][1].accept, true);
  assert.equal(count.textContent, '');
  assert.equal(box.children.length, 0);
  context.showGuestRequest('guest', 'Guest', null, 'app');
  assert.equal(panel.open, true, 'the same guest can request again after leaving');
  assert.equal(box.children.length, 1);
  context.removeGuestRequest('guest');
  context.showGuestRequest('other', 'Other', null, 'app');
  panel.open = true;
  context.showGuestRequest('another', 'Another', null, 'app');
  assert.equal(panel.open, true);
  context.removeGuestRequest('another');
  assert.equal(panel.open, true);
  context.removeGuestRequest('other');
  assert.equal(box.children.length, 0);
  assert.equal(count.textContent, '');
  context.showGuestRequest('refused', 'Refused', null, 'web');
  box.children[0].children[2].onclick();
  assert.equal(panel.open, false);
  assert.equal(events[1][1].accept, false);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/audio-devices.js'), 'utf8')
  .replace('export function createAudioDevices', 'function createAudioDevices')
  .replace('import.meta.url', "'https://example.test/js/audio-devices.js'");

function setup({ failReplace = false, outputSupported = false, outputs, noTrack = false, mediaGate } = {}) {
  const errors = [];
  const requests = [];
  const tracks = [];
  const enabledDuringReplace = [];
  const oldTrack = { enabled: false, stopped: false, getSettings: () => ({ deviceId: 'old' }), stop() { this.stopped = true; } };
  let current = noTrack ? null : oldTrack;
  const elements = [];
  let deviceChange;
  let devices = [
    { kind: 'audioinput', deviceId: 'old', label: 'Old mic' },
    { kind: 'audioinput', deviceId: 'new', label: 'Headset mic' }
  ];
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.isConnected = true; this.value = ''; }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    addEventListener(event, callback) { this.listeners[event] = callback; }
    remove() { this.isConnected = false; }
  }
  const document = {
    getElementById: () => ({}),
    createElement: tag => { const element = new Element(tag); elements.push(element); return element; },
    body: { append() {} }
  };
  const navigator = { mediaDevices: {
    addEventListener: (event, callback) => { if (event === 'devicechange') deviceChange = callback; },
    enumerateDevices: async () => devices,
    getUserMedia: async constraints => {
      requests.push(constraints);
      const track = { enabled: true, stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ deviceId: 'new' }) };
      tracks.push(track);
      if (mediaGate) await mediaGate;
      return { getAudioTracks: () => [track], getTracks: () => [track] };
    }
  } };
  class HTMLMediaElement {}
  if (outputSupported) {
    HTMLMediaElement.prototype.setSinkId = async () => {};
    navigator.mediaDevices.selectAudioOutput = async () => ({ deviceId: 'headphones', label: 'Headphones' });
  }
  const context = { document, navigator, HTMLMediaElement, console, URL };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.factory = createAudioDevices;`, context);
  const output = { ids: [], async setSinkId(id) { this.ids.push(id); } };
  const controller = context.factory({
    getTrack: () => current,
    getOutputs: () => outputs || [output],
    onError: message => errors.push(message),
    replaceTrack: async (_old, track) => {
      enabledDuringReplace.push(track.enabled);
      if (failReplace) throw new Error('replace failed');
      current = track;
    }
  });
  return { controller, elements, errors, oldTrack, tracks, requests, output, enabledDuringReplace, getCurrent: () => current,
    disconnect: async () => { devices = []; await deviceChange(); } };
}

test('switching microphones preserves mute and stops the old track after success', async () => {
  const s = setup();
  await s.controller.open();
  const select = s.elements.find(element => element.tag === 'select');
  select.value = 'new';
  await select.listeners.change();
  assert.equal(s.getCurrent().enabled, false);
  assert.equal(s.oldTrack.stopped, true);
  assert.equal(s.tracks[0].stopped, false);
  assert.deepEqual(s.enabledDuringReplace, [false]);
  assert.equal(s.requests[0].audio.deviceId.exact, 'new');
  assert.equal(s.controller.audioConstraints({ echoCancellation: true }).deviceId.exact, 'new');
  assert.deepEqual(s.errors, []);
});

test('a new microphone stays muted during replacement and then matches the live state', async () => {
  const s = setup();
  s.oldTrack.enabled = true;
  await s.controller.open();
  const select = s.elements.find(element => element.tag === 'select');
  select.value = 'new';
  await select.listeners.change();
  assert.deepEqual(s.enabledDuringReplace, [false]);
  assert.equal(s.getCurrent().enabled, true);
});

test('failed replacement retains the original microphone and stops the new one', async () => {
  const s = setup({ failReplace: true });
  await s.controller.open();
  const select = s.elements.find(element => element.tag === 'select');
  select.value = 'new';
  await select.listeners.change();
  assert.equal(s.getCurrent(), s.oldTrack);
  assert.equal(s.oldTrack.stopped, false);
  assert.equal(s.tracks[0].stopped, true);
  assert.equal(s.errors.length, 1);
});

test('output selection is offered only where supported and applies to later elements', async () => {
  const unsupported = setup();
  await unsupported.controller.open();
  assert.equal(unsupported.elements.some(element => element.textContent === 'Choose speaker or headphones'), false);
  const supported = setup({ outputSupported: true });
  await supported.controller.open();
  const button = supported.elements.find(element => element.textContent === 'Choose speaker or headphones');
  await button.listeners.click();
  const later = { ids: [], async setSinkId(id) { this.ids.push(id); } };
  await supported.controller.applyOutput(later);
  assert.deepEqual(supported.output.ids, ['headphones']);
  assert.deepEqual(later.ids, ['headphones']);
});

test('disconnecting the selected microphone reports the loss and clears its constraint', async () => {
  const s = setup();
  await s.controller.open();
  const select = s.elements.find(element => element.tag === 'select');
  select.value = 'new';
  await select.listeners.change();
  await s.disconnect();
  assert.equal(s.controller.audioConstraints({ echoCancellation: true }).deviceId, undefined);
  assert.match(s.errors[0], /disconnected/);
});

test('a microphone can be selected before the live microphone is started', async () => {
  const s = setup({ noTrack: true });
  await s.controller.open();
  const select = s.elements.find(element => element.tag === 'select');
  assert.equal(select.disabled, false);
  select.value = 'new';
  await select.listeners.change();
  assert.equal(s.controller.audioConstraints({ echoCancellation: true }).deviceId.exact, 'new');
  assert.equal(s.requests.length, 0);
  assert.equal(s.errors.length, 0);
});

test('ending a call while microphone access is pending stops the newly acquired track', async () => {
  let release;
  const mediaGate = new Promise(resolve => { release = resolve; });
  const s = setup({ mediaGate });
  await s.controller.open();
  const select = s.elements.find(element => element.tag === 'select');
  select.value = 'new';
  const switching = select.listeners.change();
  s.controller.reset();
  release();
  await switching;
  assert.equal(s.tracks[0].stopped, true);
  assert.equal(s.getCurrent(), s.oldTrack);
  assert.deepEqual(s.enabledDuringReplace, []);
  assert.equal(s.controller.audioConstraints({}).deviceId, undefined);
});

test('disconnecting the selected output restores the default route', async () => {
  const s = setup({ outputSupported: true });
  await s.controller.open();
  const button = s.elements.find(element => element.textContent === 'Choose speaker or headphones');
  await button.listeners.click();
  await s.disconnect();
  assert.deepEqual(s.output.ids, ['headphones', '']);
  assert.match(s.errors[0], /disconnected/);
});

test('failed output changes wait for every element before restoring their previous route', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const calls = [];
  const outputs = [
    { async setSinkId(id) { calls.push(`first:${id}`); if (id) throw new Error('device unavailable'); } },
    { async setSinkId(id) { calls.push(`second:${id}`); if (id) await delayed; } }
  ];
  const s = setup({ outputSupported: true, outputs });
  await s.controller.open();
  const button = s.elements.find(element => element.textContent === 'Choose speaker or headphones');
  const switching = button.listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['first:headphones', 'second:headphones']);
  release();
  await switching;
  assert.deepEqual(calls, ['first:headphones', 'second:headphones', 'first:', 'second:']);
  assert.match(s.errors[0], /Could not change audio output/);
  assert.match(s.elements.find(element => element.tag === 'p').textContent, /Could not change audio output/);
});

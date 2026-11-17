const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'messages.js'), 'utf8');
const playerSource = source.slice(source.indexOf('// Custom voice-message player:'));

function setup({ supported = true, resume } = {}) {
  const audios = [], sources = [], gains = [], compressors = [], errors = [], warnings = [];
  const listeners = {};
  const node = () => ({ connect(next) { this.next = next; return next; } });
  class Audio {
    constructor() { this.paused = true; this.currentTime = 0; this.duration = 10; this.listeners = {}; audios.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    play() { this.paused = false; this.listeners.play(); return Promise.resolve(); }
    pause() { this.paused = true; this.listeners.pause(); }
  }
  class AudioContext {
    constructor() { this.state = 'suspended'; this.destination = {}; }
    async resume() { if (resume) await resume(); this.state = 'running'; }
    createMediaElementSource(audio) { const result = { ...node(), audio }; sources.push(result); return result; }
    createGain() { const result = { ...node(), gain: {} }; gains.push(result); return result; }
    createDynamicsCompressor() {
      const result = node();
      for (const key of ['threshold', 'knee', 'ratio', 'attack', 'release']) result[key] = {};
      compressors.push(result);
      return result;
    }
  }
  vm.runInNewContext(playerSource, {
    Audio, window: supported ? { AudioContext } : {},
    console: { error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) },
    document: { addEventListener: (name, callback) => { listeners[name] = callback; } }
  });
  const player = () => {
    const time = {};
    const seek = { addEventListener() {} };
    const button = { closest: () => result };
    const result = {
      dataset: { src: 'https://media.example.test/voice.weba' },
      querySelector: selector => ({ '.voice-play': button, '.voice-seek': seek, '.voice-time': time })[selector]
    };
    return { result, time, button };
  };
  return {
    audios, sources, gains, compressors, errors, warnings, player,
    click: player => listeners.click({ target: { closest: () => player.button } })
  };
}

test('voice playback boosts quiet audio through a compressor and reuses the graph', async () => {
  const state = setup();
  const first = state.player();
  await state.click(first);
  assert.equal(state.audios[0].crossOrigin, 'anonymous');
  assert.equal(state.audios[0].paused, false);
  assert.ok(state.gains[0].gain.value > 1 && state.gains[0].gain.value <= 2);
  assert.ok(state.compressors[0].threshold.value < 0 && state.compressors[0].ratio.value > 1);
  assert.equal(state.sources[0].next, state.gains[0]);
  assert.equal(state.gains[0].next, state.compressors[0]);
  await state.click(first);
  assert.equal(state.audios[0].paused, true);
  await state.click(first);
  assert.equal(state.sources.length, 1);
  const second = state.player();
  await state.click(second);
  assert.equal(state.audios[0].paused, true);
  assert.equal(state.audios[1].paused, false);
});

test('devices without Web Audio keep working playback with an explicit warning', async () => {
  const state = setup({ supported: false });
  await state.click(state.player());
  assert.equal(state.audios[0].paused, false);
  assert.equal(state.sources.length, 0);
  assert.equal(state.warnings.length, 1);
});

test('audio context errors remain visible and allow another playback attempt', async () => {
  let blocked = true;
  const state = setup({ resume: async () => { if (blocked) throw new Error('Audio blocked'); } });
  const player = state.player();
  await state.click(player);
  assert.equal(player.time.textContent, 'Tap to retry');
  assert.equal(state.errors.length, 1);
  assert.equal(state.audios[0].paused, true);
  blocked = false;
  await state.click(player);
  assert.equal(state.audios[0].paused, false);
  assert.equal(state.sources.length, 1);
});

test('switching voice messages while audio resumes cannot start both recordings', async () => {
  let resolve;
  const waiting = new Promise(done => { resolve = done; });
  const state = setup({ resume: () => waiting });
  const first = state.click(state.player());
  const second = state.click(state.player());
  resolve();
  await Promise.all([first, second]);
  assert.equal(state.audios[0].paused, true);
  assert.equal(state.audios[1].paused, false);
});

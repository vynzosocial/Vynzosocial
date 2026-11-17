const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'messages.js'), 'utf8');
const controls = source.slice(source.indexOf("  const voiceButton = document.getElementById('voice-btn');"),
  source.indexOf('\n  async function useFile('));
const clearAttachment = source.match(/  const clearAttachment = \(\) => \{[\s\S]*?\n  \};/)[0];

function setup(mimeType = 'audio/webm;codecs=opus', data = 'recorded audio') {
  let now = 1000;
  let tick;
  let stoppedTracks = 0;
  let submitted = 0;
  let recordingOptions, microphoneOptions;
  const revoked = [];
  function element(tag) {
    const classes = new Set();
    return {
      tagName: tag.toUpperCase(), children: [], listeners: {}, attributes: {},
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      querySelector(tag) { return this.children.find(child => child.tagName === tag.toUpperCase()) || null; },
      querySelectorAll(tags) { return this.children.filter(child => tags.split(', ').some(tag => child.tagName === tag.toUpperCase())); },
      pause() { this.paused = true; }
    };
  }
  const voiceButton = element('button');
  class Recorder {
    static isTypeSupported(type) { return type === mimeType; }
    constructor(stream, options) {
      recordingOptions = options;
      this.mimeType = options.mimeType;
      this.listeners = {};
      this.state = 'inactive';
    }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.listeners.dataavailable({ data: new Blob([data], { type: this.mimeType }) });
      this.listeners.stop();
    }
  }
  const context = {
    attachment: null, viewOnce: false, MAX_VOICE_SECONDS: 300,
    fileInput: { value: 'selected-file' },
    preview: Object.assign(element('div'), { hidden: true }),
    status: { hidden: true },
    form: { requestSubmit() { submitted++; } },
    document: { getElementById: () => voiceButton, createElement: element },
    navigator: { mediaDevices: { getUserMedia: async options => {
      microphoneOptions = options;
      return { getTracks: () => [{ stop() { stoppedTracks++; } }] };
    } } },
    MediaRecorder: Recorder, Blob, File,
    URL: { createObjectURL: () => 'blob:voice-preview', revokeObjectURL: url => revoked.push(url) },
    Date: { now: () => now },
    setInterval(callback) { tick = callback; return 1; },
    clearInterval() { tick = null; }
  };
  vm.runInNewContext(`${clearAttachment}\n${controls}`, context);
  return {
    context, voiceButton, revoked,
    click: () => voiceButton.listeners.click(),
    advance(milliseconds) { now += milliseconds; },
    tick: () => tick(),
    get stoppedTracks() { return stoppedTracks; },
    get recordingOptions() { return recordingOptions; },
    get microphoneOptions() { return microphoneOptions; },
    get submitted() { return submitted; }
  };
}

for (const [mime, extension] of [['audio/webm;codecs=opus', 'weba'], ['audio/mp4', 'm4a'], ['audio/ogg', 'ogg']]) {
  test(`stopping a ${extension} recording prepares a removable voice attachment without sending`, async () => {
    const state = setup(mime);
    await state.click();
    assert.equal(state.recordingOptions.audioBitsPerSecond, 64_000);
    assert.equal(state.microphoneOptions.audio.channelCount, 1);
    assert.equal(state.voiceButton.attributes['aria-label'], 'Stop recording');
    assert.equal(state.context.preview.hidden, true);
    state.advance(1200);
    await state.click();
    const { attachment, preview, status } = state.context;
    assert.ok(attachment instanceof File);
    assert.match(attachment.name, new RegExp(`\\.${extension}$`));
    assert.equal(attachment.type, mime.split(';')[0]);
    assert.equal(attachment.size, Buffer.byteLength('recorded audio'));
    assert.equal(preview.hidden, false);
    assert.equal(preview.children[0].tagName, 'AUDIO');
    assert.equal(preview.children[0].controls, true);
    assert.equal(preview.children[1].tagName, 'BUTTON');
    assert.equal(preview.children[1].type, 'button');
    assert.equal(status.textContent, 'Voice message ready. Press Send.');
    assert.equal(status.hidden, false);
    assert.equal(state.stoppedTracks, 1);
    assert.equal(state.voiceButton.classList.contains('recording'), false);
    assert.equal(state.submitted, 0);
    const audio = preview.children[0];
    audio.paused = false;
    preview.children[1].listeners.click();
    assert.equal(audio.paused, true);
    assert.deepEqual(state.revoked, ['blob:voice-preview']);
    assert.equal(preview.children.length, 0);
    assert.equal(state.context.attachment, null);
    assert.equal(preview.hidden, true);
    assert.equal(status.hidden, true);
    assert.equal(state.submitted, 0);
  });
}

test('the recording limit also prepares the voice message for manual sending', async () => {
  const state = setup();
  await state.click();
  state.advance(300000);
  state.tick();
  assert.ok(state.context.attachment instanceof File);
  assert.equal(state.context.preview.hidden, false);
  assert.equal(state.stoppedTracks, 1);
  assert.equal(state.submitted, 0);
});

test('a replacement recording stops and releases the previous voice preview', async () => {
  const state = setup();
  await state.click();
  state.advance(1200);
  await state.click();
  const previousFile = state.context.attachment;
  const previousAudio = state.context.preview.children[0];
  previousAudio.paused = false;
  await state.click();
  state.advance(1200);
  await state.click();
  assert.notEqual(state.context.attachment, previousFile);
  assert.equal(previousAudio.paused, true);
  assert.deepEqual(state.revoked, ['blob:voice-preview']);
  assert.equal(state.context.preview.hidden, false);
  assert.equal(state.submitted, 0);
});

for (const empty of [false, true]) {
  test(`${empty ? 'empty' : 'too-short'} recording reports why no voice attachment is ready`, async () => {
    const state = setup('audio/webm;codecs=opus', empty ? '' : 'audio');
    await state.click();
    state.advance(empty ? 1200 : 200);
    await state.click();
    assert.equal(state.context.attachment, null);
    assert.equal(state.context.preview.hidden, true);
    assert.equal(state.context.status.hidden, false);
    assert.match(state.context.status.textContent, empty ? /No audio was recorded/ : /Recording too short/);
    assert.equal(state.stoppedTracks, 1);
  });
}

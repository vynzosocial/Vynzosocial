const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '../frontend/js');
const stories = fs.readFileSync(path.join(root, 'stories.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const video = fs.readFileSync(path.join(root, 'video-create.js'), 'utf8');
const helpers = video.slice(video.indexOf('function el('), video.indexOf('export function openPhotoOptions('));
const chooser = video.slice(video.indexOf('export function openStoryOptions('), video.indexOf('\n/**'))
  .replace('export function', 'function');
const selectedFile = fs.readFileSync(path.join(root, 'selected-file.js'), 'utf8').replace(/^export /gm, '');

function setup(token = 'signed-in') {
  const nodes = [], uploads = [], cameraCallbacks = [];
  function element(tag) {
    const node = {
      tag, children: [], listeners: {}, clicks: 0, value: 'selected',
      get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); },
      set textContent(value) { this.text = value; this.children = []; },
      append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); },
      appendChild(child) { this.append(child); },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      click() { this.clicks++; return this.listeners.click?.(); },
      focus() { this.focused = true; },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    };
    nodes.push(node);
    return node;
  }
  const elements = {
    'add-story-btn': element('button'),
    'story-upload-input': element('input'),
    'story-video-input': element('input')
  };
  const body = element('body');
  const context = {
    document: {
      body, createElement: element, listeners: {},
      getElementById: id => elements[id],
      addEventListener(name, callback) { this.listeners[name] = callback; },
      removeEventListener(name) { delete this.listeners[name]; }
    },
    localStorage: { getItem: () => token }, window: { location: {} },
    openCamera: callback => cameraCallbacks.push(callback)
  };
  vm.runInNewContext(`${helpers}\n${chooser}\n${selectedFile}\n${stories}`, context);
  context.refreshStoriesCarousel = async () => [];
  context.uploadStory = async (file, button) => uploads.push({ file, button });
  return {
    context, body, elements, uploads, cameraCallbacks,
    initialize: () => context.initStoriesCarousel(),
    choice: label => nodes.find(node => node.tag === 'button' && node.children[0]?.textContent === label)
  };
}

for (const [label, inputId, type] of [
  ['Image', 'story-upload-input', 'image/jpeg'],
  ['Video', 'story-video-input', 'video/mp4']
]) {
  test(`Add story routes ${label} to its picker and uploads through the existing story flow`, async () => {
    const state = setup();
    await state.initialize();
    state.elements['add-story-btn'].click();
    assert.equal(state.body.children[0].children[0]['aria-label'], 'Add story');
    state.choice(label).click();
    assert.equal(state.elements[inputId].clicks, 1);
    assert.equal(state.body.children.length, 0);
    assert.equal(state.cameraCallbacks.length, 0);
    const file = new File(['selected media'], label, { type });
    state.elements[inputId].files = [file];
    await state.elements[inputId].listeners.change();
    assert.equal(state.uploads[0].file, file);
    assert.equal(state.uploads[0].button, state.elements['add-story-btn']);
    assert.equal(state.elements[inputId].value, '');
    assert.equal(state.elements[inputId].disabled, false);
  });
}

test('Camera closes the story chooser and sends its capture through the same story upload flow', async () => {
  const state = setup();
  await state.initialize();
  state.elements['add-story-btn'].click();
  state.choice('Camera').click();
  assert.equal(state.body.children.length, 0);
  assert.equal(state.elements['story-upload-input'].clicks, 0);
  assert.equal(state.elements['story-video-input'].clicks, 0);
  assert.equal(state.cameraCallbacks.length, 1);
  const capture = new File(['camera frame'], 'capture.jpg', { type: 'image/jpeg' });
  await state.cameraCallbacks[0](capture);
  assert.equal(state.uploads[0].file, capture);
});

test('signed-out Add story still redirects to login without opening a chooser or camera', async () => {
  const state = setup(null);
  await state.initialize();
  state.elements['add-story-btn'].click();
  assert.equal(state.context.window.location.href, './pages/login.html');
  assert.equal(state.body.children.length, 0);
  assert.equal(state.cameraCallbacks.length, 0);
});

test('dismissing the story chooser leaves both pickers and camera untouched', async () => {
  const state = setup();
  await state.initialize();
  state.elements['add-story-btn'].click();
  state.context.document.listeners.keydown({ key: 'Escape' });
  assert.equal(state.body.children.length, 0);
  assert.equal(state.elements['story-upload-input'].clicks, 0);
  assert.equal(state.elements['story-video-input'].clicks, 0);
  assert.equal(state.cameraCallbacks.length, 0);
});

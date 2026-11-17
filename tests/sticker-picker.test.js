const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/messages.js'), 'utf8');
const pickerSource = source.slice(source.indexOf('function openStickerPicker('), source.indexOf('\nasync function showStickerEditor('));

function setup(showStickerEditor) {
  const nodes = [];
  function element(tag) {
    const node = {
      tag, children: [], listeners: {}, classList: { toggle() {} },
      setAttribute(name, value) { this[name] = value; },
      append(...items) { this.children.push(...items); },
      appendChild(item) { this.children.push(item); },
      replaceChildren() { this.children = []; },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      querySelectorAll() { return []; }, remove() {}
    };
    nodes.push(node);
    return node;
  }
  const context = {
    document: { createElement: element, body: { appendChild() {}, contains: () => true }, addEventListener() {}, removeEventListener() {} },
    STICKER_EMOJIS: [], getSavedStickers: async () => [], showStickerEditor,
    File: class extends Blob { constructor(parts, name, options) { super(parts, options); this.name = name; this.lastModified = options.lastModified; } },
    console: { error() {} }
  };
  vm.runInNewContext(pickerSource, context);
  context.openStickerPicker('user', async () => {});
  return nodes;
}

test('sticker picker has a directly tappable image input and snapshots the photo before clearing', async () => {
  let selected;
  const nodes = setup(async (_editor, _picker, file) => { selected = file; return () => {}; });
  const input = nodes.find(node => node.className === 'sticker-file-input');
  const label = nodes.find(node => node.className === 'sticker-create-button');
  assert.equal(input.accept, 'image/*');
  assert.ok(label.children.includes(input));
  const file = {
    name: 'photo.webp', type: 'image/webp', size: 3, lastModified: 1,
    async arrayBuffer() {
      assert.equal(input.value, 'selected');
      return new Uint8Array([1, 2, 3]).buffer;
    }
  };
  input.files = [file];
  input.value = 'selected';
  await input.listeners.change();
  assert.equal(selected.type, 'image/webp');
  assert.equal(selected.size, 3);
  assert.equal(input.value, '');
});

test('failed photo decoding returns to the picker and reports the error', async () => {
  const nodes = setup(async (editor, picker) => {
    editor.hidden = false;
    picker.hidden = true;
    throw new Error('This image could not be opened.');
  });
  const input = nodes.find(node => node.className === 'sticker-file-input');
  input.files = [{ name: 'photo.png', type: 'image/png', size: 1, arrayBuffer: async () => new Uint8Array([1]).buffer }];
  await input.listeners.change();
  assert.equal(nodes.find(node => node.className === 'sticker-picker').hidden, false);
  assert.equal(nodes.find(node => node.className === 'sticker-editor').hidden, true);
  assert.equal(nodes.find(node => node.className === 'sticker-status').textContent, 'This image could not be opened.');
});

test('cancellation and unsupported or oversized images do not open the editor', async () => {
  let opened = false;
  const nodes = setup(async () => { opened = true; });
  const input = nodes.find(node => node.className === 'sticker-file-input');
  const status = nodes.find(node => node.className === 'sticker-status');
  input.files = [];
  await input.listeners.change();
  assert.equal(opened, false);
  input.files = [{ type: 'image/heic', size: 2 }];
  input.value = 'selected';
  await input.listeners.change();
  assert.match(status.textContent, /JPG, PNG, GIF, or WebP/);
  assert.equal(input.value, '');
  assert.equal(input.disabled, false);
  input.files = [{ type: 'image/png', size: 10 * 1024 * 1024 + 1 }];
  await input.listeners.change();
  assert.match(status.textContent, /10 MB/);
  assert.equal(opened, false);
});

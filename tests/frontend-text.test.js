const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const checkFrontendText = require('../scripts/check-frontend-text');

test('all frontend assets pass text validation', () => {
  checkFrontendText(path.join(__dirname, '..', 'frontend'));
});

test('text validation catches invalid UTF-8 and corrupted placeholders', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vynzo-text-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'test.js');
  for (const contents of [Buffer.from([0xff]), Buffer.from("const emoji = '??';"), Buffer.from("'?? Camera'"), Buffer.from('broken \uFFFD text'), Buffer.from('<span>?</span>')]) {
    fs.writeFileSync(file, contents);
    assert.throws(() => checkFrontendText(root), /Frontend text validation failed/);
  }
  fs.writeFileSync(file, "const label = name ?? '?'; const emoji = '😀';");
  assert.doesNotThrow(() => checkFrontendText(root));
});

test('live title emoji buttons insert the selected emoji', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'live.js'), 'utf8');
  const emojis = source.match(/const TITLE_EMOJIS = \[[^\n]+\];/);
  const start = source.indexOf('export function createTitleEditor(');
  const end = source.indexOf('\nexport async function initLiveStudio()', start);
  assert.ok(emojis && start >= 0 && end > start);
  function element() {
    return {
      style: {}, children: [], value: '', selectionStart: 0, selectionEnd: 0,
      listeners: {}, append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    };
  }
  const context = {
    document: { createElement: element },
    localStorage: { setItem() {} },
    LIVE_TITLE_KEY: 'test'
  };
  vm.runInNewContext(`${emojis[0]}\n${source.slice(start, end).replace('export function', 'function')}\nthis.createTitleEditor = createTitleEditor;`, context);
  const editor = context.createTitleEditor();
  const buttons = editor.element.children[1].children;
  assert.equal(buttons.length, 16);
  for (const button of buttons) {
    assert.match(button.textContent, /\p{Extended_Pictographic}/u);
    editor.input.value = '';
    editor.input.selectionStart = editor.input.selectionEnd = 0;
    button.listeners.click();
    assert.equal(editor.input.value, button.textContent);
  }
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'chat-composer.js'), 'utf8')
  .replace('export function ', 'function ');

function setup(coarse = false) {
  const listeners = {};
  const input = {
    style: {}, scrollHeight: 40, offsetHeight: 42, clientHeight: 40,
    addEventListener(type, handler) { listeners[type] = handler; }
  };
  let submissions = 0;
  const form = { requestSubmit() { submissions++; } };
  const context = { window: { matchMedia: () => ({ matches: coarse }) } };
  vm.runInNewContext(`${source}\nthis.attach = attachChatComposer;`, context);
  const resize = context.attach(input, form);
  return { input, listeners, resize, submissions: () => submissions };
}

test('composer resizes on input and when reset', () => {
  const state = setup();
  assert.equal(state.input.style.height, '42px');
  state.input.scrollHeight = 100;
  state.listeners.input();
  assert.equal(state.input.style.height, '102px');
  state.input.scrollHeight = 40;
  state.resize();
  assert.equal(state.input.style.height, '42px');
});

test('Enter sends on desktop but shift and composition do not', () => {
  const state = setup();
  let prevented = false;
  const event = { key: 'Enter', preventDefault() { prevented = true; } };
  state.listeners.keydown(event);
  assert.equal(prevented, true);
  assert.equal(state.submissions(), 1);
  for (const extra of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }]) {
    state.listeners.keydown({ ...event, ...extra, preventDefault() { throw new Error('Should not send'); } });
  }
  assert.equal(state.submissions(), 1);
});

test('mobile Enter inserts a line instead of sending', () => {
  const state = setup(true);
  state.listeners.keydown({ key: 'Enter', preventDefault() { throw new Error('Should not send'); } });
  assert.equal(state.submissions(), 0);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/auth-keyboard.js'), 'utf8');

function setup({ height = 180, first = -30, last = 100, active = 'password', register = false } = {}) {
  const handlers = {};
  const calls = [];
  const identifier = { closest: () => ({ getBoundingClientRect: () => ({ top: first }) }) };
  const password = {
    closest: () => ({ getBoundingClientRect: () => ({ bottom: last }) }),
    scrollIntoView: options => calls.push(['nearest', options.block])
  };
  const form = { addEventListener: (name, fn) => { handlers[name] = fn; } };
  const viewport = { height, offsetTop: 0, addEventListener: (name, fn) => { handlers[name] = fn; } };
  const elements = register
    ? { 'register-form': form, username: identifier, first_name: password, last_name: password }
    : { 'login-form': form, email: identifier, password };
  const document = { getElementById: id => elements[id], activeElement: elements[active] };
  vm.runInNewContext(source, {
    document,
    window: { visualViewport: viewport, scrollBy: (x, y) => calls.push(['scroll', x, y]) },
    requestAnimationFrame: callback => callback()
  });
  return { handlers, calls, document, viewport, identifier, password };
}

test('keeps both login fields visible when the keyboard shrinks the viewport', () => {
  const h = setup();
  h.handlers.resize();
  assert.deepEqual(h.calls, [['scroll', 0, -38]]);
});

test('does not disturb a visible form, an unfocused form, or a full-height viewport', () => {
  for (const options of [{ first: 10, last: 150 }, { active: 'login-form' }, { height: 700 }]) {
    const h = setup(options);
    h.handlers.focusin();
    assert.deepEqual(h.calls, []);
  }
});

test('prioritizes the focused field when both fields cannot fit', () => {
  const h = setup({ height: 100, first: 0, last: 150 });
  h.handlers.resize();
  assert.deepEqual(h.calls, [['nearest', 'nearest']]);
});

test('keeps the registration username visible while editing a name', () => {
  const h = setup({ register: true, active: 'first_name' });
  h.handlers.focusin();
  assert.deepEqual(h.calls, [['scroll', 0, -38]]);
});

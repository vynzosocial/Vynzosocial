const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function setup() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      hidden: true, dataset: {}, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      setAttribute(name, value) { this[name] = value; }
    });
    return elements.get(id);
  }
  const button = element('desktop-update');
  button.dataset.action = 'update';
  let onState;
  const actions = [];
  const state = {
    title: 'Home', version: '1.2.0', loading: false, offline: false,
    canGoBack: false, canGoForward: false,
    update: { state: 'current', detail: 'You have the latest desktop version.', progress: null }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'shell.js'), 'utf8'), {
    document: {
      getElementById: element,
      querySelectorAll: selector => selector.startsWith('button[') ? [button] : [],
      body: { dataset: {} }
    },
    window: { desktopApp: {
      onState(callback) { onState = callback; },
      getState: async () => state,
      action: async (...args) => { actions.push(args); }
    } }
  });
  await new Promise(resolve => setImmediate(resolve));
  return { button, actions, render: update => onState({ ...state, update: { progress: null, ...update } }) };
}

test('update button shows progress, remains after Later, and hides when the installed version is current', async () => {
  const { button, render, actions } = await setup();
  assert.equal(button.hidden, true);
  render({ state: 'downloading', detail: 'Downloading...', progress: 43 });
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Updating 43%');
  render({ state: 'downloaded', detail: 'Ready to restart.' });
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Update');
  button.listeners.click();
  assert.deepEqual(actions, [['update', undefined]]);
  render({ state: 'installing', detail: 'Restarting...' });
  assert.equal(button.disabled, true);
  render({ state: 'current', detail: 'You have the latest desktop version.' });
  assert.equal(button.hidden, true);
});

test('a failed update exposes a retry button and unconfigured hosting never claims an update is available', async () => {
  const { button, render } = await setup();
  render({ state: 'error', detail: 'Network unavailable.' });
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Retry update');
  assert.equal(button.title, 'Network unavailable.');
  render({ state: 'disabled', detail: 'Hosting is not configured.' });
  assert.equal(button.hidden, true);
});

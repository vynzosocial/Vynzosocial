const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'problem-report.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');

function setup(fetch) {
  const ids = ['problem-report-form', 'problem-report-toggle', 'problem-report-description', 'problem-report-image', 'problem-report-submit', 'problem-report-status'];
  const nodes = Object.fromEntries(ids.map(id => [id, {
    listeners: {}, value: '', files: [], disabled: false,
    addEventListener(type, cb) { this.listeners[type] = cb; },
    setAttribute(name, value) { this[name] = value; },
    focus() { this.focused = true; },
    reset() { nodes['problem-report-description'].value = ''; nodes['problem-report-image'].files = []; }
  }]));
  nodes['problem-report-form'].hidden = true;
  const context = {
    document: { getElementById: id => nodes[id] },
    requireSupabase: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } }),
    SUPABASE_URL: 'https://project.example', SUPABASE_PUBLISHABLE_KEY: 'public',
    fetch, FormData, AbortController, setTimeout, clearTimeout, console: { error() {} }
  };
  vm.runInNewContext(source, context);
  return nodes;
}

test('opens the form and sends text and attachment with the user session', async () => {
  let call;
  const nodes = setup(async (url, options) => { call = { url, options }; return { ok: true, json: async () => ({ message: 'Sent' }) }; });
  const form = nodes['problem-report-form'];
  nodes['problem-report-toggle'].listeners.click();
  assert.equal(form.hidden, false);
  assert.equal(nodes['problem-report-toggle']['aria-expanded'], 'true');
  nodes['problem-report-description'].value = 'Problem';
  nodes['problem-report-image'].files = [new File(['image'], 'photo.png', { type: 'image/png' })];
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(call.url, 'https://project.example/functions/v1/report-problem');
  assert.equal(call.options.headers.Authorization, 'Bearer token');
  assert.equal(call.options.body.get('description'), 'Problem');
  assert.equal(call.options.body.get('image').name, 'photo.png');
  assert.equal(nodes['problem-report-status'].textContent, 'Sent');
  assert.equal(nodes['problem-report-description'].value, '');
  assert.equal(form.hidden, true);
  assert.equal(nodes['problem-report-toggle']['aria-expanded'], 'false');
  nodes['problem-report-toggle'].listeners.click();
  assert.equal(form.hidden, false);
  assert.equal(nodes['problem-report-status'].textContent, '');
});

test('preserves the report for retry on delivery failure', async () => {
  const nodes = setup(async () => ({ ok: false, json: async () => ({ error: 'Delivery failed' }) }));
  nodes['problem-report-toggle'].listeners.click();
  nodes['problem-report-description'].value = 'Problem';
  await nodes['problem-report-form'].listeners.submit({ preventDefault() {} });
  assert.equal(nodes['problem-report-description'].value, 'Problem');
  assert.equal(nodes['problem-report-status'].textContent, 'Delivery failed');
  assert.equal(nodes['problem-report-submit'].disabled, false);
  assert.equal(nodes['problem-report-form'].hidden, false);
});

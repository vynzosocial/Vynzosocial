const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('Facebook icon opens the supplied page safely beside the other social links', () => {
  const index = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  const headerStart = index.indexOf('<header class="top-bar">');
  const headerEnd = index.indexOf('</header>', headerStart);
  const header = index.slice(headerStart, headerEnd);
  const facebookLink = header.indexOf('class="facebook-icon-link"');

  assert.ok(facebookLink > header.indexOf('class="instagram-icon-link"'));
  assert.ok(facebookLink < header.indexOf('class="snapchat-icon-link"'));
  assert.match(header.slice(facebookLink), /href="https:\/\/www\.facebook\.com\/share\/19u4zehaoU\/"/);
  assert.match(header.slice(facebookLink), /target="_blank" rel="noopener noreferrer"/);
});

function setupEditor({ failSave = false } = {}) {
  const elements = Object.fromEntries(['instagram', 'facebook', 'snapchat'].map(name => [name, { value: '', disabled: true }]));
  const listeners = {};
  const status = {};
  const retry = { addEventListener() {} };
  const form = {
    elements,
    reportValidity: () => true,
    querySelectorAll: () => Object.values(elements),
    addEventListener: (name, callback) => { listeners[name] = callback; }
  };
  const saved = { id: 'me', username: 'name', bio: 'original', instagram_username: 'old' };
  let stored = JSON.stringify(saved);
  let patch;
  const source = fs.readFileSync(path.join(__dirname, '../frontend/js/social-links.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('void loadLinks();', '');
  const context = {
    document: { getElementById: id => ({ 'social-links-form': form, 'social-links-status': status, 'social-links-retry': retry })[id] },
    localStorage: { getItem: () => stored, setItem: (key, value) => { stored = value; } },
    console: { error() {} },
    apiRequest: async (endpoint, options) => {
      if (!options) return { profile: { ...saved, bio: 'latest bio' } };
      patch = JSON.parse(options.body);
      if (failSave) throw new Error('Invalid Instagram username');
      return { user: { ...saved, bio: patch.bio, instagram_username: 'new.name', facebook_username: null, snapchat_username: 'snap' } };
    }
  };
  vm.runInNewContext(source, context);
  return { context, elements, status, submit: () => listeners.submit({ preventDefault() {} }), patch: () => patch, stored: () => JSON.parse(stored) };
}

test('social-links editor loads existing values and saves links without reverting the bio', async () => {
  const editor = setupEditor();
  await editor.context.loadLinks();
  assert.equal(editor.elements.instagram.value, 'old');
  editor.elements.instagram.value = 'https://www.instagram.com/new.name/';
  editor.elements.facebook.value = '';
  editor.elements.snapchat.value = '@snap';
  await editor.submit();
  assert.deepEqual(editor.patch(), {
    username: 'name', bio: 'latest bio', instagram: 'https://www.instagram.com/new.name/', facebook: '', snapchat: '@snap'
  });
  assert.equal(editor.stored().instagram_username, 'new.name');
  assert.equal(editor.elements.instagram.value, 'new.name');
  assert.equal(editor.status.textContent, 'Links saved.');
});

test('social-links editor keeps unsaved input and displays server validation errors', async () => {
  const editor = setupEditor({ failSave: true });
  await editor.context.loadLinks();
  editor.elements.instagram.value = 'invalid input';
  await editor.submit();
  assert.equal(editor.elements.instagram.value, 'invalid input');
  assert.equal(editor.elements.instagram.disabled, false);
  assert.equal(editor.stored().instagram_username, 'old');
  assert.equal(editor.status.textContent, 'Invalid Instagram username');
});

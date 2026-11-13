const test = require('node:test');
const assert = require('node:assert/strict');
const { routeUrl, sectionForUrl, viewBounds, validateAction, isShellSender } = require('../lib/shell-policy.cjs');

test('desktop navigation accepts only known app sections', () => {
  assert.equal(validateAction('navigate', 'messages'), 'https://www.vynzosocial.com/pages/messages.html');
  for (const section of ['https://example.com', '../../secret', '__proto__', 'constructor', null, {}]) {
    assert.throws(() => routeUrl(section), /Unknown desktop/);
  }
  assert.throws(() => validateAction('executeJavaScript'), /Unsupported/);
  assert.equal(validateAction('reload'), null);
  assert.equal(validateAction('update'), null);
});

test('native navigation tracks both clean website routes and HTML routes', () => {
  assert.equal(sectionForUrl('https://www.vynzosocial.com/index.html'), 'home');
  assert.equal(sectionForUrl('https://www.vynzosocial.com/pages/messages?conversation=example'), 'messages');
  assert.equal(sectionForUrl('https://www.vynzosocial.com/pages/blogs.html#/a/example'), 'blogs');
  assert.equal(sectionForUrl('https://example.com/pages/messages.html'), null);
  assert.equal(sectionForUrl('https://www.vynzosocial.com/pages/login.html'), null);
});

test('website bounds reserve space for desktop controls without overflowing the window', () => {
  const bounds = viewBounds(1280, 850);
  assert.equal(bounds.x + bounds.width, 1280);
  assert.equal(bounds.y + bounds.height, 850);
  assert.ok(bounds.x > 0);
  assert.ok(bounds.y > 0);
  assert.equal(viewBounds(0, 0).width, 0);
  assert.equal(viewBounds(0, 0).height, 0);
});

test('desktop IPC rejects website senders, subframes, and a navigated shell', () => {
  const shellUrl = 'file:///C:/app/ui/shell.html';
  const frame = { url: shellUrl };
  const contents = { mainFrame: frame };
  assert.equal(isShellSender({ sender: contents, senderFrame: frame }, contents, shellUrl), true);
  assert.equal(isShellSender({ sender: {}, senderFrame: frame }, contents, shellUrl), false);
  assert.equal(isShellSender({ sender: contents, senderFrame: { url: shellUrl } }, contents, shellUrl), false);
  frame.url = 'https://www.vynzosocial.com/';
  assert.equal(isShellSender({ sender: contents, senderFrame: frame }, contents, shellUrl), false);
});

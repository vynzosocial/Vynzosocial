const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const dataSource = fs.readFileSync(path.join(__dirname, '../frontend/js/share-data.js'), 'utf8').replace(/export /g, '');
const liveSource = fs.readFileSync(path.join(__dirname, '../frontend/js/messages.js'), 'utf8');
const functions = liveSource.slice(liveSource.indexOf('function sharedMessageMarkup('), liveSource.indexOf('function replyQuoteMarkup('));
const context = { URL, encodeURIComponent, decodeURIComponent, console, API_ORIGIN: 'https://api.example.test',
  escapeHtml: value => value.replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])),
  avatarMarkup: (url, name, className) => `<span class="${className}">${url || name}</span>` };
vm.createContext(context);
vm.runInContext(`${dataSource}\n${functions}`, context);

test('live shares keep a working link and render the host rather than the sender', () => {
  const content = context.shareMessage('🔴 Invitation to join live', 'https://www.vynzosocial.com/pages/live.html?sessionId=123',
    { type: 'live', name: 'Host', avatar: '/host.jpg' });
  const shared = context.parseSharedMessage(content);
  assert.equal(shared.url, 'https://www.vynzosocial.com/pages/live.html?sessionId=123');
  const markup = context.sharedMessageMarkup(shared, {}, 'Someone else');
  assert.match(markup, /Host/);
  assert.match(markup, /\/host.jpg/);
  assert.doesNotMatch(markup, /Someone else/);
});

test('image and video shares carry permission-checked identifiers', async () => {
  const id = 'a4e777de-3d68-4f4e-9e7a-843f3229dabc';
  for (const type of ['image', 'video']) {
    const shared = context.parseSharedMessage(context.shareMessage('Shared media', 'https://media.example.test/play?permit=old',
      { type, kind: 'post', id, r2: true }));
    assert.match(context.sharedMessageMarkup(shared, {}, 'Sender'), new RegExp(`data-type="${type}"`));
    assert.match(context.sharedMessageMarkup(shared, {}, 'Sender'), /data-kind="post"/);
    let request;
    context.apiRequest = async url => { request = url; return { url: 'https://media.example.test/fresh' }; };
    assert.equal(await context.sharedMediaUrl({ dataset: { kind: 'post', id, url: shared.url } }), 'https://media.example.test/fresh');
    assert.equal(request, `/media/playback?kind=post&id=${id}`);
    context.apiRequest = async () => { throw new Error('Media not found.'); };
    await assert.rejects(context.sharedMediaUrl({ dataset: { kind: 'post', id, url: shared.url } }), /Media not found/);
  }
});

test('old share links remain readable and invalid previews remain plain text', () => {
  assert.equal(context.parseSharedMessage('🖼 Image by @user\nhttps://media.example.test/image.jpg').preview.type, 'image');
  assert.equal(context.parseSharedMessage('🎬 Story by @user\nhttps://media.example.test/video.mp4').preview.type, 'video');
  assert.equal(context.parseSharedMessage('🔴 Join my live\nhttps://www.vynzosocial.com/pages/live.html?sessionId=1').preview.type, 'live');
  assert.equal(context.parseSharedMessage('hello\nhttps://example.test/'), null);
  assert.equal(context.parseSharedMessage(context.shareMessage('x', 'https://evil.example/live', { type: 'live' })), null);
  assert.equal(context.parseSharedMessage(context.shareMessage('x', 'https://example.test/x', { type: 'image', r2: true, kind: 'post', id: 'bad' })), null);
});

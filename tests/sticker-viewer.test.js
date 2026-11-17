const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'messages.js'), 'utf8');
const markup = source.slice(source.indexOf('function messageMediaPath('), source.indexOf('function openStickerViewer('));
const previews = source.slice(source.indexOf('function replyText('), source.indexOf('function sharedMessageMarkup('));

test('sticker opens as an in-chat button, while photos remain links', () => {
  const context = {
    STICKER_MESSAGE_CONTENT: '[vynzo-sticker]',
    API_ORIGIN: 'https://example.test',
    URL, atob,
    VOICE_PATTERN: /\.(weba|m4a|ogg)$/i,
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  };
  vm.runInNewContext(`${markup}\nthis.mediaMarkup = mediaMarkup;`, context);
  const sticker = context.mediaMarkup({ content: '[vynzo-sticker]', media_url: '/image.png' });
  assert.match(sticker, /^<button type="button" class="sticker-media-link"/);
  assert.doesNotMatch(sticker, /target="_blank"/);
  const photo = context.mediaMarkup({ content: 'photo', media_url: '/image.png' });
  assert.match(photo, /^<button type="button" class="sticker-media-link photo-media-link"/);
  assert.match(photo, /class="message-media photo-thumb"/);
  assert.doesNotMatch(photo, /target="_blank"/);
});

test('protected voice attachments use the audio player without changing their authorized URL', () => {
  const context = {
    STICKER_MESSAGE_CONTENT: '[vynzo-sticker]', API_ORIGIN: 'https://example.test',
    URL, atob, console, VOICE_PATTERN: /\.(weba|m4a|ogg)(\?.*)?$/i,
    parseSharedMessage: () => null,
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  };
  vm.runInNewContext(`${markup}\n${previews}`, context);
  for (const extension of ['weba', 'm4a', 'ogg']) {
    const claims = { storage: 'legacy-file', scope: 'message', path: `sender/messages/chat/voice.${extension}` };
    const permit = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
    const url = `https://media.example/media?permit=${permit}`;
    const html = context.mediaMarkup({ media_url: url });
    assert.match(html, /class="voice-player"/);
    assert.ok(html.includes(`data-src="${url}"`));
    assert.doesNotMatch(html, /<img|<video/);
    assert.equal(context.replyText({ media_url: url }), '\u{1f3a4} Voice message');
    assert.equal(context.messagePreview({ media_url: url }), '\u{1f3a4} Voice message');
    assert.match(context.mediaMarkup({ media_url: `/uploads/voice.${extension}?token=signed` }), /class="voice-player"/);
  }
  const permit = `${Buffer.from(JSON.stringify({ storage: 'legacy-file', scope: 'message', path: 'sender/messages/chat/clip.mp4' })).toString('base64url')}.signature`;
  assert.match(context.mediaMarkup({ media_url: `https://media.example/media?permit=${permit}` }), /^<video/);
  assert.match(context.mediaMarkup({ media_url: '/uploads/clip.mp4?token=signed' }), /^<video/);
  assert.match(context.mediaMarkup({ media_url: '/uploads/photo.jpg?token=signed' }), /photo-thumb/);
});

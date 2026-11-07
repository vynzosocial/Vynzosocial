const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/share.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');

function setup(canShare = false) {
  const elements = [];
  const calls = [];
  const document = {
    body: { append: element => elements.push(element) },
    getElementById: () => null,
    createElement(tag) {
      return {
        tag, children: [], events: {},
        setAttribute() {}, append(...children) { this.children.push(...children); },
        addEventListener(event, callback) { this.events[event] = callback; },
        remove() {}
      };
    }
  };
  const navigator = { clipboard: { writeText: async text => calls.push(text) } };
  if (canShare) navigator.share = async data => calls.push(data);
  const context = { document, navigator, window: { prompt() {} }, URL, encodeURIComponent,
    API_ORIGIN: '', apiRequest: async () => ({ friends: [] }), shareMessage: (text, url) => `${text}\n${url}`, console };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, elements, calls };
}

test('all types provide an encoded WhatsApp link and clipboard', async () => {
  for (const url of ['https://www.vynzosocial.com/pages/live.html?sessionId=1',
    'https://www.vynzosocial.com/pages/blogs.html#/a/1', 'https://cdn.example/image.jpg', 'https://cdn.example/video.mp4']) {
    const { context, elements, calls } = setup();
    await context.openShareDialog({ text: 'Watch & enjoy', url });
    const footer = elements[0].children[0].children[3];
    const whatsapp = footer.children[0];
    assert.equal(new URL(whatsapp.href).searchParams.get('text'), `Watch & enjoy\n${url}`);
    await footer.children[1].events.click();
    assert.equal(calls[0], url);
    assert.match(footer.children[2].textContent, /Snapchat or Instagram/);
  }
});

test('native share receives a stable privacy-checked R2 link rather than an expiring permit', async () => {
  const { context, elements, calls } = setup(true);
  await context.openShareDialog({ title: 'Share video', text: 'Video', url: 'https://media.example/play?permit=secret',
    preview: { r2: true, kind: 'post', id: 'a4e777de-3d68-4f4e-9e7a-843f3229dabc', type: 'video' } });
  const footer = elements[0].children[0].children[3];
  await footer.children[2].events.click();
  const link = new URL(calls[0].url);
  assert.equal(link.pathname, '/pages/shared-media.html');
  assert.equal(link.searchParams.get('id'), 'a4e777de-3d68-4f4e-9e7a-843f3229dabc');
  assert.equal(link.searchParams.get('type'), 'video');
  assert.equal(link.searchParams.has('permit'), false);
});

test('older Supabase media shares use Vynzo links instead of storage links', async () => {
  const { context } = setup();
  for (const kind of ['post', 'story']) {
    const url = context.externalShareUrl('https://storage.example.test/image.jpg', {
      type: 'image', kind, id: 'a4e777de-3d68-4f4e-9e7a-843f3229dabc', r2: false
    });
    const link = new URL(url);
    assert.equal(link.origin, 'https://www.vynzosocial.com');
    assert.equal(link.pathname, '/pages/shared-media.html');
    assert.equal(link.searchParams.get('kind'), kind);
    assert.doesNotMatch(url, /storage\.example/);
  }
  assert.throws(() => context.externalShareUrl('https://storage.example/image', { type: 'image', kind: 'post', id: 'invalid' }), /invalid/);
});

test('sign-in returns to valid shared content but rejects external redirects', () => {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/js/share-login.js'), 'utf8').replace(/export /g, '');
  const context = { URL, URLSearchParams, Set };
  vm.createContext(context);
  vm.runInContext(source, context);
  for (const target of ['/pages/live.html?sessionId=123', '/pages/blogs.html#/a/123',
    '/pages/shared-media.html?kind=post&id=123&type=image']) {
    const login = new URL(context.shareLoginUrl(new URL(`https://www.vynzosocial.com${target}`)));
    assert.equal(context.shareLoginDestination(login), `https://www.vynzosocial.com${target}`);
  }
  for (const target of ['//evil.example/pages/live.html', 'https://evil.example', '/pages/settings.html']) {
    const login = new URL(`https://www.vynzosocial.com/pages/login.html?return=${encodeURIComponent(target)}`);
    assert.equal(context.shareLoginDestination(login), '../index.html');
  }
});

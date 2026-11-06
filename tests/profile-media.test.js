const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..', 'frontend');
const users = fs.readFileSync(path.join(root, 'js', 'users.js'), 'utf8');
const feed = fs.readFileSync(path.join(root, 'js', 'feed.js'), 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.events = {};
    this.attributes = {};
    this.classes = new Set();
    this.classList = {
      add: value => this.classes.add(value),
      remove: value => this.classes.delete(value),
      contains: value => this.classes.has(value),
      toggle: (value, force) => force ? this.classes.add(value) : this.classes.delete(value)
    };
  }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.events[name] = callback; }
  querySelector(selector) {
    if (this.nodes) return this.nodes[selector] || null;
    if (selector === 'video') return this.children.find(child => child.tagName === 'VIDEO') || null;
    return null;
  }
  pause() { this.paused = true; }
}

function gridFor(posts) {
  const source = users.slice(users.indexOf("  const grid = document.createElement('div');"), users.indexOf('\n  container.appendChild(grid);') + '\n  container.appendChild(grid);'.length);
  const opened = [];
  const container = new Element();
  const sandbox = {
    document: { createElement: tag => new Element(tag) },
    posts, profile: { username: 'alice', avatar_url: '' }, container,
    MEDIA_BASE_URL: 'https://api.example',
    protectMedia: el => { el.dataset.protected = 'true'; },
    openPostViewer: (...args) => opened.push(args)
  };
  vm.runInNewContext(source, sandbox);
  return { grid: container.children[0], opened };
}

test('profile videos request a frame for old and new URLs and preserve protection', () => {
  const { grid, opened } = gridFor([
    { id: 'old', media_type: 'video', media_url: '/old.mp4', is_protected: true },
    { id: 'new', media_type: 'video', media_url: 'https://example.test/new.mp4' },
    { id: 'photo', media_type: 'image', media_url: '/photo.jpg' }
  ]);
  const [old, newer, photo] = grid.children;
  assert.equal(old.children[0].src, 'https://api.example/old.mp4');
  assert.equal(newer.children[0].src, 'https://example.test/new.mp4');
  assert.equal(old.dataset.protected, 'true');
  old.children[0].duration = 1;
  old.children[0].events.loadedmetadata();
  assert.equal(old.children[0].currentTime, 0.1);
  newer.children[0].duration = Infinity;
  newer.children[0].events.loadedmetadata();
  assert.equal(newer.children[0].currentTime, 0.1);
  newer.children[0].events.error();
  assert.equal(newer.classList.contains('preview-unavailable'), true);
  photo.events.click();
  assert.equal(opened[0][0].id, 'photo');
  assert.equal(opened[0][1].length, 3);
});

function viewerHarness() {
  const selectors = [
    '#post-viewer-like', '#post-viewer-comment-form', '#post-viewer-comment-input',
    '.post-viewer-close', '.post-viewer-previous', '.post-viewer-next',
    '#post-viewer-media', '.post-viewer-navigation', '.post-viewer-position',
    '.post-viewer-details', '#post-viewer-author', '#post-viewer-avatar-slot',
    '#post-viewer-caption', '#post-viewer-comments'
  ];
  const modal = new Element();
  modal.nodes = Object.fromEntries(selectors.map(selector => [selector, new Element()]));
  const formButton = new Element('button');
  modal.nodes['#post-viewer-comment-form'].nodes = { 'button[type="submit"]': formButton };
  const listeners = {};
  const document = {
    body: { appendChild() {} },
    createElement: tag => new Element(tag),
    getElementById(id) { return id === 'post-viewer-modal' ? modal : modal.nodes[`#${id}`]; },
    querySelector(selector) { return selector === '#post-viewer-comment-form button[type="submit"]' ? formButton : null; },
    querySelectorAll() { return []; },
    addEventListener(name, callback) { listeners[name] = callback; }
  };
  const sandbox = {
    document, API_ORIGIN: 'https://api.example', console,
    apiRequest: async () => ({ comments: [] }), timeAgo: () => 'now',
    createAuthorAvatar: () => new Element(), createPrivacySelect: () => new Element('select'),
    protectMedia: el => { el.dataset.protected = 'true'; },
    attachEmojiPicker() {}, alert() {}, confirm: () => false,
    localStorage: { getItem: () => null }
  };
  let source = feed.slice(feed.indexOf('export function openPostViewer('), feed.indexOf('\nfunction makeAuthorLink('));
  source = source.replace('export function openPostViewer(', 'function openPostViewer(');
  vm.runInNewContext(`${source}\nthis.open = openPostViewer;`, sandbox);
  return { sandbox, modal, listeners };
}

test('viewer navigates profile posts and respects boundaries and ordinary feed behavior', () => {
  const { sandbox, modal, listeners } = viewerHarness();
  // Force the viewer to create and wire its controls.
  const lookup = sandbox.document.getElementById;
  let created = false;
  sandbox.document.getElementById = id => id === 'post-viewer-modal' && !created ? null : lookup(id);
  sandbox.document.createElement = tag => {
    if (!created && tag === 'div') { created = true; return modal; }
    return new Element(tag);
  };
  const posts = [
    { id: '1', media_type: 'image', media_url: '/one.jpg' },
    { id: '2', media_type: 'video', media_url: '/two.mp4', is_protected: true }
  ];
  sandbox.open(posts[0], posts);
  assert.equal(modal.nodes['.post-viewer-position'].textContent, '1 / 2');
  assert.equal(modal.nodes['.post-viewer-previous'].disabled, true);
  modal.nodes['.post-viewer-next'].events.click();
  assert.equal(modal.nodes['.post-viewer-position'].textContent, '2 / 2');
  assert.equal(modal.nodes['#post-viewer-media'].children[0].tagName, 'VIDEO');
  assert.equal(modal.nodes['#post-viewer-media'].dataset.protected, 'true');
  assert.equal(modal.nodes['.post-viewer-next'].disabled, true);
  const media = modal.nodes['#post-viewer-media'];
  media.events.touchstart({ touches: [{ clientX: 20, clientY: 20 }] });
  media.events.touchend({ changedTouches: [{ clientX: 20, clientY: 120 }] });
  assert.equal(modal.nodes['.post-viewer-position'].textContent, '1 / 2');
  assert.equal(media.dataset.protected, undefined);
  let prevented = false;
  listeners.keydown({ key: 'ArrowDown', target: { closest: () => null }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(modal.nodes['.post-viewer-position'].textContent, '2 / 2');
  listeners.keydown({ key: 'ArrowUp', target: { closest: () => true }, preventDefault: () => assert.fail('typing should not navigate') });
  assert.equal(modal.nodes['.post-viewer-position'].textContent, '2 / 2');
  media.events.wheel({ deltaX: 0, deltaY: -100, preventDefault() {} });
  assert.equal(modal.nodes['.post-viewer-position'].textContent, '1 / 2');
  sandbox.open(posts[1]);
  assert.equal(modal.nodes['.post-viewer-navigation'].hidden, true);
  assert.equal(typeof media.children[0].events.ended, 'function');
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('video story preview waits until it approaches the carousel viewport, then seeks to a frame', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'stories.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replaceAll('export async function ', 'async function ');
  const created = [];
  function element(tag) {
    const node = {
      tag, children: [], listeners: {}, dataset: {}, isConnected: true,
      appendChild(child) { this.children.push(child); },
      append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; },
      addEventListener(name, callback) { this.listeners[name] = callback; }
    };
    created.push(node);
    return node;
  }
  let onIntersection;
  const observed = new Set();
  const context = {
    document: { createElement: element },
    localStorage: { getItem: () => '{}' },
    MEDIA_BASE_URL: 'https://example.test',
    IntersectionObserver: class {
      constructor(callback) { onIntersection = entries => callback(entries, this); }
      observe(target) { observed.add(target); }
      unobserve(target) { observed.delete(target); }
    },
    refreshExpiredMedia() {}
  };
  vm.runInNewContext(source, context);
  const container = element('div');
  context.renderStories(container, [{
    user_id: 'user-id', username: 'user',
    stories: [{ media_type: 'video', media_url: '/video.mp4' }]
  }]);
  const video = created.find(node => node.tag === 'video');
  assert.equal(video.preload, 'metadata');
  assert.ok(observed.has(video));
  onIntersection([{ target: video, isIntersecting: false }]);
  assert.equal(video.src, undefined);
  onIntersection([{ target: video, isIntersecting: true }]);
  assert.equal(video.src, 'https://example.test/video.mp4');
  assert.equal(observed.has(video), false);
  video.duration = 2;
  video.listeners.loadedmetadata();
  assert.equal(video.currentTime, 0.1);
});

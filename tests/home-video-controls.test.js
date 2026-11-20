const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'frontend');
const script = fs.readFileSync(path.join(root, 'js', 'home-video-controls.js'), 'utf8');

function setup({ blockSound = false, reducedMotion = false, signedIn = false } = {}) {
  const events = target => ({ ...target, addEventListener(name, callback) { this[name] = callback; } });
  const attempts = [];
  const video = {
    addEventListener(name, callback) { this.listeners[name] = callback; },
    listeners: {},
    muted: false, loop: false, paused: true,
    async play() {
      attempts.push(this.muted);
      if (blockSound && !this.muted) throw Object.assign(new Error('Autoplay blocked'), { name: 'NotAllowedError' });
      this.paused = false;
    },
    pause() { this.paused = true; }
  };
  const welcome = { hidden: false };
  const elements = { 'welcome-featured-video': video, 'welcome-page': welcome };
  const document = events({ hidden: false, getElementById: id => elements[id] });
  const window = events({ matchMedia: () => ({ matches: reducedMotion }) });
  let token = signedIn ? 'signed-in' : null;
  let onWelcomeChange;
  vm.runInNewContext(script, {
    document, window, localStorage: { getItem: () => token },
    console,
    MutationObserver: class {
      constructor(callback) { onWelcomeChange = callback; }
      observe() {}
    }
  });
  return { video, document, window, attempts,
    signIn() { token = 'signed-in'; window.storage(); },
    hideWelcome() { welcome.hidden = true; onWelcomeChange(); }
  };
}

test('intro keeps visible controls after the feature cards', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const videoMarkup = html.match(/<video[^>]*id="welcome-featured-video"[^>]*>[\s\S]*?<\/video>/)?.[0];
  assert.ok(videoMarkup);
  assert.match(videoMarkup, /preload="none"/);
  assert.match(videoMarkup, /\scontrols\b/);
  assert.match(videoMarkup, /\sposter="[^"]+"\s+src="[^"]+\.mp4"/);
  assert.doesNotMatch(videoMarkup, /\sautoplay\b/);
  assert.match(html, /<\/article>\s*<\/div>\s*<section id="welcome-video-preview"/);
});

test('intro starts with sound when allowed and loops muted after the first play', () => {
  const { video, attempts } = setup();
  assert.deepEqual(attempts, [false]);
  assert.equal(video.loop, false);
  video.listeners.ended();
  assert.deepEqual(attempts, [false, true]);
  assert.equal(video.muted, true);
  assert.equal(video.loop, true);
});

test('blocked audible autoplay retries muted', async () => {
  const { video, attempts } = setup({ blockSound: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(attempts, [false, true]);
  assert.equal(video.paused, false);
});

test('reduced motion and signed-in visits do not autoplay', () => {
  for (const options of [{ reducedMotion: true }, { signedIn: true }]) {
    assert.deepEqual(setup(options).attempts, []);
  }
});

test('intro stops and cannot restart when backgrounded or replaced by the signed-in feed', () => {
  const transitions = [
    ({ document }) => { document.hidden = true; document.visibilitychange(); },
    ({ window }) => window.pagehide(),
    ({ hideWelcome }) => hideWelcome(),
    ({ signIn }) => signIn()
  ];
  for (const transition of transitions) {
    const env = setup();
    env.video.paused = false;
    transition(env);
    assert.equal(env.video.paused, true);
    env.video.listeners.ended();
    assert.deepEqual(env.attempts, [false]);
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'home-video-controls.js'), 'utf8');

function setup(play, { desktop = false, signedIn = false, welcomeHidden = false, backgrounded = false } = {}) {
  class Video {
    constructor() {
      this.muted = false;
      this.paused = true;
      this.listeners = {};
      this.play = play.bind(this);
    }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    pause() {
      this.paused = true;
      this.listeners.pause?.();
    }
  }
  class Button {
    constructor() {
      this.listeners = {};
      this.attributes = {};
      this.classList = { toggle() {} };
    }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  const video = new Video();
  const button = new Button();
  const welcome = { hidden: welcomeHidden };
  const document = {
    hidden: backgrounded,
    listeners: {},
    getElementById: id => id === 'welcome-featured-video' ? video : id === 'welcome-page' ? welcome : button,
    addEventListener(name, callback) { this.listeners[name] = callback; }
  };
  const window = {
    listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; }
  };
  let visibilityObserver;
  const errors = [];
  vm.runInNewContext(script, {
    document,
    window,
    MutationObserver: class {
      constructor(callback) { visibilityObserver = callback; }
      observe() {}
    },
    navigator: { userAgent: desktop ? 'Vynzo/1.0.0 Chrome/156.0.0.0 Electron/45.3.1' : 'Chrome/156.0.0.0' },
    localStorage: { getItem: () => signedIn ? 'signed-in-token' : null },
    HTMLVideoElement: Video,
    HTMLButtonElement: Button,
    console: { error: (...args) => errors.push(args) }
  });
  return {
    video, button, welcome, document, window, errors,
    hideWelcome() {
      welcome.hidden = true;
      visibilityObserver();
    },
    signIn() { signedIn = true; }
  };
}

test('desktop welcome video waits for a deliberate click before playing', () => {
  let attempts = 0;
  const { video, button } = setup(function () {
    attempts++;
    this.paused = false;
    return Promise.resolve();
  }, { desktop: true });
  assert.equal(attempts, 0);
  assert.equal(video.paused, true);
  assert.equal(button.attributes['aria-label'], 'Play featured video with sound');
  button.listeners.click();
  assert.equal(attempts, 1);
  assert.equal(video.paused, false);
});

test('signed-in or hidden welcome pages do not start background playback', () => {
  for (const options of [{ signedIn: true }, { welcomeHidden: true }, { backgrounded: true }]) {
    let attempts = 0;
    setup(() => { attempts++; return Promise.resolve(); }, options);
    assert.equal(attempts, 0);
  }
});

test('hiding the front page stops playback and prevents clicks and ended events from restarting it', () => {
  let attempts = 0;
  const { video, button, hideWelcome } = setup(function () {
    attempts++;
    this.paused = false;
    return Promise.resolve();
  });
  assert.equal(video.paused, false);
  hideWelcome();
  assert.equal(video.paused, true);
  button.listeners.click();
  video.listeners.ended();
  assert.equal(attempts, 1);
});

test('backgrounding or leaving the page stops video without automatically restarting on return', () => {
  for (const event of ['visibilitychange', 'pagehide']) {
    const { video, document, window } = setup(function () {
      this.paused = false;
      return Promise.resolve();
    });
    if (event === 'visibilitychange') {
      document.hidden = true;
      document.listeners.visibilitychange();
    } else {
      window.listeners.pagehide();
    }
    assert.equal(video.paused, true);
    document.hidden = false;
    document.listeners.visibilitychange();
    assert.equal(video.paused, true);
  }
});

test('a saved session stops playback and rejects native playback outside the welcome page', () => {
  const { video, signIn, window } = setup(function () {
    this.paused = false;
    return Promise.resolve();
  });
  signIn();
  window.listeners.storage();
  assert.equal(video.paused, true);
  video.paused = false;
  video.listeners.play();
  assert.equal(video.paused, true);
});

test('late play completion is stopped when the front page disappears', async () => {
  for (const leavePage of [env => env.hideWelcome(), env => env.window.listeners.pagehide()]) {
    let finishPlay;
    const env = setup(function () {
      return new Promise(resolve => {
        finishPlay = () => {
          this.paused = false;
          resolve();
        };
      });
    });
    leavePage(env);
    finishPlay();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.video.paused, true);
  }
});

test('does not retry autoplay if the welcome page was hidden while play was pending', async () => {
  let rejectInitial;
  let attempts = 0;
  const { welcome } = setup(() => {
    attempts++;
    return new Promise((resolve, reject) => { rejectInitial = reject; });
  });
  welcome.hidden = true;
  rejectInitial({ name: 'NotAllowedError' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
});

test('keeps sound enabled when audible autoplay is allowed', async () => {
  const attempts = [];
  const { video, errors } = setup(function () {
    attempts.push(this.muted);
    this.paused = false;
    return Promise.resolve();
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(attempts, [false]);
  assert.equal(video.muted, false);
  assert.deepEqual(errors, []);
});

test('retries muted when audible autoplay is blocked and allows the user to enable sound', async () => {
  const attempts = [];
  const { video, button, errors } = setup(function () {
    attempts.push(this.muted);
    if (!this.muted && attempts.length === 1) return Promise.reject({ name: 'NotAllowedError' });
    this.paused = false;
    return Promise.resolve();
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(attempts, [false, true]);
  assert.equal(video.muted, true);
  assert.equal(button.attributes['aria-label'], 'Turn featured video sound on');
  button.listeners.click();
  assert.equal(video.muted, false);
  assert.deepEqual(errors, []);
});

test('does not override a user action while the initial autoplay attempt is pending', async () => {
  let rejectInitial;
  let attempts = 0;
  const { video, button } = setup(function () {
    attempts++;
    if (attempts === 1) return new Promise((resolve, reject) => { rejectInitial = reject; });
    this.paused = false;
    return Promise.resolve();
  });
  button.listeners.click();
  rejectInitial({ name: 'NotAllowedError' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(video.muted, false);
});

test('mutes and loops only after two plays with sound', () => {
  const { video } = setup(function () {
    this.paused = false;
    return Promise.resolve();
  });
  video.listeners.ended();
  assert.equal(video.muted, false);
  assert.notEqual(video.loop, true);
  video.listeners.ended();
  assert.equal(video.muted, true);
  assert.equal(video.loop, true);
  assert.equal(video.currentTime, 0);
});

test('muted mobile autoplay does not use up the two plays with sound', async () => {
  const { video, button } = setup(function () {
    if (!this.muted && this.paused) return Promise.reject({ name: 'NotAllowedError' });
    this.paused = false;
    return Promise.resolve();
  });
  await new Promise(resolve => setImmediate(resolve));
  video.listeners.ended();
  video.listeners.ended();
  assert.equal(video.muted, true);
  assert.notEqual(video.loop, true);

  button.listeners.click();
  video.listeners.ended();
  assert.equal(video.muted, false);
  assert.notEqual(video.loop, true);
  video.listeners.ended();
  assert.equal(video.muted, true);
  assert.equal(video.loop, true);
});

test('reports failures of the muted autoplay retry', async () => {
  const { errors } = setup(function () {
    return Promise.reject({ name: 'NotAllowedError' });
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /muted featured video/);
});

test('reports non-policy playback errors without retrying', async () => {
  let attempts = 0;
  const { errors } = setup(function () {
    attempts++;
    return Promise.reject({ name: 'NotSupportedError' });
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /with sound/);
});

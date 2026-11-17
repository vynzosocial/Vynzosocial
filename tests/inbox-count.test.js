const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/inbox-count.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
  .replace('import.meta.url', '"https://example.test/js/inbox-count.js"');
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(request) {
  const documentEvents = new Map(), windowEvents = new Map(), socketEvents = new Map();
  const appCounts = [], nativeStates = [], errors = [];
  const storage = new Map([['vynzo_token', 'signed-in'], ['vynzo_user', '{"id":"owner"}']]);
  function node() {
    const classes = new Set();
    return {
      children: [], attributes: {},
      classList: {
        add: value => classes.add(value),
        toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value),
        contains: value => classes.has(value)
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      appendChild(child) { this.children.push(child); }
    };
  }
  const links = [node(), node()];
  const head = node();
  const context = {
    URL, Date, console: { error: (...args) => errors.push(args) },
    document: {
      hidden: false, head,
      getElementById: id => head.children.find(child => child.id === id),
      createElement: node, querySelectorAll: () => links,
      addEventListener: (name, callback) => documentEvents.set(name, callback)
    },
    window: { addEventListener: (name, callback) => windowEvents.set(name, callback) },
    localStorage: { getItem: key => storage.get(key) || null },
    navigator: {
      setAppBadge: async count => { appCounts.push(count); },
      clearAppBadge: async () => { appCounts.push(0); }
    },
    setTimeout: () => 1, clearTimeout() {},
    apiRequest: request,
    syncNativeUnreadNotifications: async state => nativeStates.push(state),
    createRealtimeSocket: () => ({ on: (name, callback) => socketEvents.set(name, callback) })
  };
  vm.runInNewContext(source, context);
  return { context, links, appCounts, nativeStates, errors, documentEvents, windowEvents, socketEvents, storage };
}

test('all inbox links show the unread message total and update immediately on realtime events', async () => {
  let count = 2;
  const state = setup(async () => ({ conversations: [{ id: 'one', unread_count: count }, { id: 'two', unread_count: 3 }] }));
  state.context.initInboxCount();
  state.context.initInboxCount();
  await flush();
  for (const link of state.links) {
    assert.equal(link.children.length, 1);
    assert.equal(link.children[0].textContent, '5');
    assert.equal(link.children[0].hidden, false);
    assert.ok(link.classList.contains('has-unread'));
  }
  count = 100;
  await state.socketEvents.get('conversation_changed')();
  assert.equal(state.links[0].children[0].textContent, '99+');
  assert.equal(state.appCounts.at(-1), 103);
  assert.equal(state.nativeStates.at(-1).readConversationIds.length, 0);
});

test('reading messages clears inbox numbers and the app badge using the server unread state', async () => {
  let unread = true;
  const state = setup(async () => ({ conversations: [{ id: 'chat', unread_count: unread ? 4 : 0 }] }));
  state.context.initInboxCount();
  await flush();
  unread = false;
  await state.documentEvents.get('vynzo:messages-read')();
  assert.deepEqual(state.appCounts, [4, 0]);
  assert.equal(state.links[0].children[0].hidden, true);
  assert.equal(state.links[0].classList.contains('has-unread'), false);
  assert.deepEqual(Array.from(state.nativeStates.at(-1).readConversationIds), ['chat']);
  assert.equal(state.nativeStates.at(-1).userId, 'owner');
  assert.ok(state.nativeStates.at(-1).before > 0);
});

test('an older in-flight response cannot restore a badge after messages are read', async () => {
  const pending = [];
  const state = setup(() => new Promise(resolve => pending.push(resolve)));
  state.context.initInboxCount();
  const cleared = state.documentEvents.get('vynzo:messages-read')();
  pending[1]({ conversations: [] });
  await cleared;
  pending[0]({ conversations: [{ id: 'chat', unread_count: 8 }] });
  await flush();
  assert.deepEqual(state.appCounts, [0]);
  assert.equal(state.links[0].children[0].hidden, true);
});

test('failed or invalid refreshes retain the known count and report errors instead of clearing notifications', async () => {
  let result = { conversations: [{ id: 'chat', unread_count: 2 }] };
  const state = setup(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  state.context.initInboxCount();
  await flush();
  result = new Error('Offline');
  await state.context.refreshInboxCount();
  result = { conversations: [{ id: 'chat', unread_count: -1 }] };
  await state.context.refreshInboxCount();
  assert.equal(state.errors.length, 2);
  assert.deepEqual(state.appCounts, [2]);
  assert.equal(state.nativeStates.length, 1);
  assert.equal(state.links[0].children[0].textContent, '2');
});

test('a badge API failure does not prevent clearing native read notifications', async () => {
  const state = setup(async () => ({ conversations: [] }));
  state.context.navigator.clearAppBadge = async () => { throw new Error('Badge permission denied'); };
  state.context.initInboxCount();
  await flush();
  assert.equal(state.errors.length, 1);
  assert.equal(state.nativeStates.length, 1);
});

test('sign-out discards an account response that arrives late', async () => {
  let resolve;
  const state = setup(() => new Promise(done => { resolve = done; }));
  state.context.initInboxCount();
  state.storage.delete('vynzo_token');
  await state.windowEvents.get('storage')({ key: 'vynzo_token' });
  resolve({ conversations: [{ id: 'chat', unread_count: 5 }] });
  await flush();
  assert.deepEqual(state.appCounts, [0]);
  assert.equal(state.nativeStates.length, 0);
});

const chrome = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(file => file && fs.existsSync(file));

test('every page with inbox navigation loads the shared unread counter', () => {
  const frontend = path.resolve(__dirname, '../frontend');
  const files = ['index.html', ...fs.readdirSync(path.join(frontend, 'pages'))
    .filter(file => file.endsWith('.html')).map(file => path.join('pages', file))];
  for (const file of files) {
    const html = fs.readFileSync(path.join(frontend, file), 'utf8');
    if (/<a\b[^>]*href="[^"]*messages\.html"/.test(html)) {
      assert.match(html, /notifications\.js|initInboxCount/, `Inbox counter missing on ${file}`);
    }
  }
});

test('real Messages navigation displays and clears numeric inbox badges on mobile and desktop', { skip: !chrome }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vynzo-inbox-badges-'));
  try {
    const frontend = path.resolve(__dirname, '../frontend');
    let html = fs.readFileSync(path.join(frontend, 'pages', 'messages.html'), 'utf8')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace('<head>', `<head><base href="${pathToFileURL(path.join(frontend, 'pages') + path.sep).href}">
      <link id="vynzo-inbox-css" rel="stylesheet" href="../css/inbox-count.css">`);
    html = html.replace('</body>', `<pre id="result"></pre><script>
      localStorage.setItem('vynzo_token', 'fixture');
      localStorage.setItem('vynzo_user', '{"id":"owner"}');
      let fixtureCount = 7;
      const appCounts = [], nativeStates = [], realtime = {};
      Object.defineProperty(navigator, 'setAppBadge', {configurable:true,value:async count => appCounts.push(count)});
      Object.defineProperty(navigator, 'clearAppBadge', {configurable:true,value:async () => appCounts.push(0)});
      const apiRequest = async () => ({conversations:[{id:'chat',unread_count:fixtureCount}]});
      const syncNativeUnreadNotifications = async state => nativeStates.push(state);
      const createRealtimeSocket = () => ({on:(name, callback) => {realtime[name] = callback;}});
      ${source}
      (async () => {
        const check = (condition, message) => {if (!condition) throw new Error(message);};
        initInboxCount();
        await refreshInboxCount();
        const badges = [...document.querySelectorAll('.inbox-count')];
        check(badges.length === 2, 'Missing desktop or mobile counter');
        check(badges.every(badge => badge.textContent === '7' && !badge.hidden), 'Unread number is missing');
        const visible = badges.find(badge => badge.getBoundingClientRect().width > 0);
        const badgeRect = visible.getBoundingClientRect();
        check(badgeRect.left >= 0 && badgeRect.right <= innerWidth, 'Badge falls outside viewport');
        check(document.documentElement.scrollWidth <= innerWidth, 'Inbox badge causes horizontal overflow');
        fixtureCount = 102;
        await realtime.conversation_changed();
        check(badges.every(badge => badge.textContent === '99+'), 'Large unread count is not capped');
        check(appCounts.at(-1) === 102, 'App badge lost the real count');
        fixtureCount = 0;
        document.dispatchEvent(new CustomEvent('vynzo:messages-read'));
        await new Promise(resolve => setTimeout(resolve, 0));
        check(badges.every(badge => badge.hidden && getComputedStyle(badge).display === 'none'), 'Read badges remain visible');
        check(appCounts.at(-1) === 0 && nativeStates.at(-1).readConversationIds.includes('chat'), 'App notifications were not cleared');
        document.getElementById('result').textContent = JSON.stringify({passed:true});
      })().catch(error => {document.getElementById('result').textContent = JSON.stringify({error:error.message});});
    </script></body>`);
    const fixture = path.join(directory, 'fixture.html');
    fs.writeFileSync(fixture, html);
    for (const width of [360, 1280]) {
      const result = spawnSync(chrome, [
        '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${path.join(directory, `profile-${width}`)}`,
        `--window-size=${width},820`, '--force-device-scale-factor=1',
        '--allow-file-access-from-files', '--virtual-time-budget=1500', '--dump-dom',
        pathToFileURL(fixture).href
      ], { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
      assert.equal(result.status, 0, result.stderr);
      const output = result.stdout.match(/<pre id="result">([^<]+)<\/pre>/);
      assert.ok(output, `No browser result at ${width}px`);
      assert.deepEqual(JSON.parse(output[1]), { passed: true }, `${width}px`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

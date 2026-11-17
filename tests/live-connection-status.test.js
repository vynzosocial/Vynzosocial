const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');
const live = fs.readFileSync(path.join(root, 'frontend', 'js', 'live.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'frontend', 'css', 'live-layout.css'), 'utf8');

test('host badge and status dot follow the same connection state', () => {
  const badge = { hidden: true };
  const dot = {
    classList: {
      toggle(name, enabled) { this[name] = enabled; }
    },
    setAttribute(name, value) { this[name] = value; }
  };
  const document = {
    getElementById: id => id === 'live-status-dot' ? dot : null,
    querySelector: selector => selector === '.live-you-badge' ? badge : null
  };
  const status = live.slice(live.indexOf('function setLiveChatStatus('), live.indexOf('\nlet liveHostSocketId'));
  const context = vm.createContext({ document });
  vm.runInContext(status, context);

  context.setLiveChatStatus('Connected', true);
  assert.equal(dot.classList['is-on'], true);
  assert.equal(badge.hidden, false);
  assert.equal(dot['aria-label'], 'Connected');
  context.setLiveChatStatus('Reconnecting to chat...', false);
  assert.equal(dot.classList['is-on'], false);
  assert.equal(badge.hidden, true);
  assert.equal(dot['aria-label'], 'Reconnecting to chat...');
  assert.match(live, /class="live-you-badge" hidden>You live/);
  assert.match(styles, /\.live-you-badge\[hidden\]\s*\{\s*display:\s*none/);
});

test('lost and restored room connections update the host badge and chat', () => {
  const badge = { hidden: true };
  const input = { disabled: false };
  const dot = { classList: { toggle(name, enabled) { this[name] = enabled; } }, setAttribute() {} };
  const handlers = new Map();
  const socket = {
    off(event) { handlers.delete(event); },
    on(event, handler) { handlers.set(event, handler); }
  };
  const document = {
    getElementById: id => id === 'live-status-dot' ? dot : id === 'live-chat-input' ? input : null,
    querySelector: selector => selector === '.live-you-badge' ? badge : null
  };
  const status = live.slice(live.indexOf('function setLiveChatStatus('), live.indexOf('\nlet liveHostSocketId'));
  const listeners = live.slice(live.indexOf('function registerLiveListeners()'), live.indexOf("  socket.off('live_chat_message');")) + '\n}';
  const context = vm.createContext({
    socket, document, selectedLiveSessionId: 'live', activeRoomSessionId: 'live',
    closeAllPeerConnections() {}, refreshViewers() {}
  });
  vm.runInContext(`${status}\n${listeners}`, context);
  context.registerLiveListeners();
  context.setLiveChatStatus('Connected', true);
  handlers.get('live_room_disconnected')({ sessionId: 'live' });
  assert.equal(badge.hidden, true);
  assert.equal(dot.classList['is-on'], false);
  assert.equal(input.disabled, true);
  handlers.get('live_room_reconnected')({ sessionId: 'live' });
  assert.equal(badge.hidden, false);
  assert.equal(dot.classList['is-on'], true);
  assert.equal(input.disabled, false);
});

test('a replaced viewer closes media and returns to the home page', () => {
  const handlers = new Map();
  const socket = {
    off(event) { handlers.delete(event); },
    on(event, handler) { handlers.set(event, handler); }
  };
  const window = { location: { href: '' } };
  let closed = false;
  let stopped = false;
  const source = live.slice(live.indexOf("  socket.off('live_session_replaced');"), live.indexOf("  socket.off('live_guest_request');"));
  const context = vm.createContext({
    socket, window, activeRoomSessionId: 'live', selectedLiveSessionId: 'live',
    activeBroadcastSessionId: null,
    closeAllPeerConnections() { closed = true; },
    stopLocalMedia(notifyHost) { stopped = notifyHost === false; return Promise.resolve(); },
    console
  });
  vm.runInContext(source, context);
  handlers.get('live_session_replaced')();
  assert.equal(closed, true);
  assert.equal(stopped, true);
  assert.equal(context.selectedLiveSessionId, null);
  assert.equal(window.location.href, '../index.html');
});

test('all realtime consumers share the same module instance', () => {
  const directory = path.join(root, 'frontend', 'js');
  const consumers = fs.readdirSync(directory).filter(name => name.endsWith('.js'));
  const imports = consumers.flatMap(name => {
    const source = fs.readFileSync(path.join(directory, name), 'utf8');
    return [...source.matchAll(/from ['"](\.\/realtime\.js[^'"]*)['"]/g)]
      .map(match => ({ name, specifier: match[1] }));
  });
  assert.ok(imports.some(item => item.name === 'live.js'));
  assert.ok(imports.some(item => item.name === 'notifications.js'));
  assert.equal(new Set(imports.map(item => item.specifier)).size, 1, JSON.stringify(imports));
});

test('live and notifications connect through one shared realtime hub', async () => {
  const realtime = fs.readFileSync(path.join(root, 'frontend', 'js', 'realtime.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replaceAll('export async function ', 'async function ')
    .replaceAll('export function ', 'function ');
  const channels = new Map();
  const supabase = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) },
    realtime: { setAuth: async () => {} },
    channel(name) {
      if (channels.has(name)) return channels.get(name);
      const channel = {
        subscriptions: 0,
        on() { return this; },
        subscribe(callback) {
          assert.equal(++this.subscriptions, 1, `Channel ${name} subscribed more than once`);
          callback('SUBSCRIBED');
          return this;
        },
        track: async () => 'ok'
      };
      channels.set(name, channel);
      return channel;
    }
  };
  const context = vm.createContext({
    supabase,
    localStorage: { getItem: () => JSON.stringify({ id: 'user-id' }) },
    crypto: { randomUUID: () => 'socket-id' },
    window: { addEventListener() {} },
    console, setTimeout, clearTimeout, setInterval, clearInterval
  });
  vm.runInContext(`${realtime}\nthis.createSocket = createRealtimeSocket;`, context);
  const liveSocket = context.createSocket({ autoConnect: false });
  const notificationsSocket = context.createSocket({ autoConnect: false });
  const connected = socket => new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
    socket.connect();
  });
  await Promise.all([connected(liveSocket), connected(notificationsSocket)]);
  assert.equal(channels.size, 2);
  assert.equal(channels.get('user:user-id').subscriptions, 1);
  assert.equal(channels.get('vynzo:online').subscriptions, 1);
});

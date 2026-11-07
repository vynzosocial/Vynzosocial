const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/realtime.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export function createRealtimeSocket', 'function createRealtimeSocket');
const liveSource = fs.readFileSync(path.join(__dirname, '../frontend/js/live.js'), 'utf8');
const invitationUI = liveSource.slice(liveSource.indexOf('function inviteLiveViewer('), liveSource.indexOf('function renderChatMessage('));

async function setup(isHost) {
  const sent = [];
  const channels = new Map();
  const user = { id: isHost ? 'host-user' : 'guest-user', username: isHost ? 'Host' : 'Guest' };
  const state = {
    host: [{ isHost: true, name: 'Host', userId: 'host-user' }],
    guest: [{ isHost: false, name: 'Guest', userId: 'guest-user' }]
  };
  const supabase = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) },
    realtime: { setAuth: async () => {} },
    channel(name) {
      const callbacks = {};
      const channel = {
        on(type, filter, callback) { callbacks[`${type}:${filter.event}`] = callback; return this; },
        subscribe(callback) { callback('SUBSCRIBED'); return this; },
        track: async () => {},
        untrack: async () => {},
        presenceState: () => state,
        send: async payload => { sent.push(payload); return 'ok'; },
        signal(payload) { callbacks['broadcast:sig']({ payload }); },
        join(key, meta) { callbacks['presence:join']({ key, newPresences: [meta] }); },
        leave(key, meta, currentPresences = []) { callbacks['presence:leave']({ key, leftPresences: [meta], currentPresences }); }
      };
      channels.set(name, channel);
      return channel;
    },
    removeChannel: async () => {}
  };
  const context = {
    supabase,
    apiRequest: async () => ({ liveStreams: [{ id: 'room', host_id: 'host-user' }] }),
    createOfflineSocket() { throw new Error('Unexpected offline socket'); },
    localStorage: { getItem: () => JSON.stringify(user) },
    crypto: { randomUUID: () => isHost ? 'host' : 'guest' },
    window: { addEventListener() {} },
    console, setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {}
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.makeSocket = createRealtimeSocket;`, context);
  const socket = context.makeSocket({ autoConnect: false });
  const result = await new Promise(resolve => socket.emit('join_live_room', 'room', resolve));
  assert.equal(result.ok, true);
  return { socket, channel: channels.get('live:room'), sent, state };
}

function emit(socket, event, data) {
  return new Promise(resolve => socket.emit(event, data, resolve));
}

test('host invitation requires a present viewer and acceptance before stage approval', async () => {
  const { socket, channel, sent } = await setup(true);
  assert.equal((await emit(socket, 'live_invite_guest', { socketId: 'missing' })).ok, false);
  assert.equal((await emit(socket, 'live_invite_guest', { socketId: 'guest' })).ok, true);
  assert.ok(sent.some(item => item.payload.event === 'live_host_invite' && item.payload.to === 'guest'));
  assert.equal(sent.some(item => item.payload.event === 'live_guest_approved'), false);
  channel.signal({ event: 'cmd_guest_request', from: 'guest', to: 'host', data: { socketId: 'guest', name: 'Guest', acceptInvite: true } });
  assert.ok(sent.some(item => item.payload.event === 'live_guest_approved' && item.payload.to === 'guest'));
});

test('a guest accepts invitations only from the host and camera events identify the sender', async () => {
  const { socket, channel } = await setup(false);
  const invites = [];
  const camera = [];
  socket.on('live_host_invite', data => invites.push(data));
  socket.on('live_camera_state', data => camera.push(data));
  channel.signal({ event: 'live_host_invite', from: 'guest', to: 'guest', data: { name: 'Imposter' } });
  channel.signal({ event: 'live_host_invite', from: 'host', to: 'guest', data: { name: 'Host' } });
  channel.signal({ event: 'live_camera_state', from: 'host', data: { enabled: false } });
  assert.equal(invites.length, 1);
  assert.equal(invites[0].name, 'Host');
  assert.equal(camera.length, 1);
  assert.equal(camera[0].socketId, 'host');
  assert.equal(camera[0].enabled, false);
});

test('a guest cannot join automatically without a pending host invitation', async () => {
  const { socket, channel, sent } = await setup(true);
  const requests = [];
  socket.on('live_guest_request', data => requests.push(data));
  channel.signal({ event: 'cmd_guest_request', from: 'guest', to: 'host', data: { socketId: 'guest', name: 'Guest', acceptInvite: true } });
  assert.equal(requests.length, 1);
  assert.equal(sent.some(item => item.payload.event === 'live_guest_approved'), false);
  assert.equal((await emit(socket, 'live_invite_guest', { socketId: 'host' })).ok, false);
});

test('viewers cannot send host invitations', async () => {
  const { socket } = await setup(false);
  const result = await emit(socket, 'live_invite_guest', { socketId: 'host' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Only the host/);
});

test('host receives one inviteable arrival regardless of device clock, and sees rejoin', async () => {
  const { socket, channel, state } = await setup(true);
  const arrivals = [];
  socket.on('live_member_joined', data => arrivals.push(data));
  const viewer = { isHost: false, name: 'Guest', joinOrder: 1 };
  channel.join('guest', viewer);
  channel.join('guest', viewer);
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].socketId, 'guest');
  // Realtime can deliver leave before presenceState() reflects its final state.
  channel.leave('guest', viewer);
  channel.join('guest', viewer);
  assert.equal(arrivals.length, 2);
  channel.leave('guest', viewer, [viewer]);
  channel.join('guest', viewer);
  assert.equal(arrivals.length, 2);
});

test('host can click a viewer arrival and invite that viewer, who must accept', async () => {
  const { socket, channel, sent } = await setup(true);
  socket.connected = true;
  socket.timeout = () => ({ emit(event, data, callback) {
    socket.emit(event, data, result => callback(null, result));
  } });
  const messages = { children: [], appendChild(child) { this.children.push(child); } };
  const document = {
    getElementById: () => messages,
    createElement() {
      return {
        style: {}, children: [], attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(event, handler) { if (event === 'click') this.click = handler; },
        append(...children) { this.children.push(...children); }
      };
    }
  };
  const context = { socket, document, isGuestRole: () => false, showLiveError: error => { throw new Error(error); } };
  vm.runInNewContext(invitationUI, context);
  socket.on('live_member_joined', ({ name, socketId }) => context.renderSystemChatMessage('', socketId, name));
  channel.join('guest', { isHost: false, name: 'Guest', joinOrder: 1 });
  const button = messages.children[0].children[1];
  assert.equal(button.attributes['aria-label'], 'Invite Guest to join');
  button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(sent.some(item => item.payload.event === 'live_host_invite' && item.payload.to === 'guest'));
  assert.equal(sent.some(item => item.payload.event === 'live_guest_approved'), false);
  channel.signal({ event: 'cmd_guest_request', from: 'guest', to: 'host', data: { socketId: 'guest', name: 'Guest', acceptInvite: true } });
  assert.ok(sent.some(item => item.payload.event === 'live_guest_approved' && item.payload.to === 'guest'));
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/realtime.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replaceAll('export async function ', 'async function ')
  .replaceAll('export function ', 'function ');
const liveSource = fs.readFileSync(path.join(__dirname, '../frontend/js/live.js'), 'utf8');
const badge = liveSource.slice(liveSource.indexOf('function appendLiveWebBadge('), liveSource.indexOf('\nfunction createLiveStage('));
const invitationUI = badge + liveSource.slice(liveSource.indexOf('function inviteLiveViewer('), liveSource.indexOf('function renderChatMessage('));

function chatElement() {
  let text = '';
  return {
    style: {}, children: [], attributes: {},
    classList: { add() {} },
    set textContent(value) { text = value; this.children = []; },
    get textContent() { return text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(event, handler) { if (event === 'click') this.click = handler; },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { text = ''; this.children = children; }
  };
}

async function setup(isHost, { duplicateDevice = false, existingJoinOrder = 1, completeHandoff = true, existingMembers = {}, guestSocketId = 'guest' } = {}) {
  const sent = [];
  const channels = new Map();
  const removedChannels = [];
  const user = { id: isHost ? 'host-user' : 'guest-user', username: isHost ? 'Host' : 'Guest' };
  const state = {
    host: [{ isHost: true, name: 'Host', userId: 'host-user' }],
    guest: [{ isHost: false, name: 'Guest', userId: 'guest-user', joinOrder: existingJoinOrder }],
    ...existingMembers
  };
  if (duplicateDevice) {
    state['guest-device-2'] = [{ isHost: false, name: 'Guest', userId: 'guest-user', joinOrder: 2 }];
  }
  const supabase = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) },
    realtime: { setAuth: async () => {} },
    channel(name) {
      const callbacks = {};
      const channel = {
        on(type, filter, callback) { callbacks[`${type}:${filter.event}`] = callback; return this; },
        subscribe(callback) { this.statusCallback = callback; callback('SUBSCRIBED'); return this; },
        track: async () => 'ok',
        untrack: async () => {},
        presenceState: () => state,
        send: async payload => {
          sent.push(payload);
          if (duplicateDevice && completeHandoff && payload.payload?.event === 'live_session_replaced') {
            delete state[payload.payload.to];
          }
          return 'ok';
        },
        status(status) { this.statusCallback(status); },
        signal(payload) { callbacks['broadcast:sig']({ payload }); },
        join(key, meta) { callbacks['presence:join']({ key, newPresences: [meta] }); },
        leave(key, meta, currentPresences = []) { callbacks['presence:leave']({ key, leftPresences: [meta], currentPresences }); },
        sync() { callbacks['presence:sync'](); }
      };
      channels.set(name, channel);
      return channel;
    },
    removeChannel: async channel => { removedChannels.push(channel); }
  };
  const context = {
    supabase,
    apiRequest: async () => ({ liveStreams: [{ id: 'room', host_id: 'host-user' }] }),
    createOfflineSocket() { throw new Error('Unexpected offline socket'); },
    localStorage: { getItem: () => JSON.stringify(user) },
    crypto: { randomUUID: () => isHost ? 'host' : duplicateDevice ? 'guest-device-2' : guestSocketId },
    window: { addEventListener() {} },
    console, setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {}
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.makeSocket = createRealtimeSocket;`, context);
  const socket = context.makeSocket({ autoConnect: false });
  const result = await new Promise(resolve => socket.emit('join_live_room', 'room', resolve));
  if (completeHandoff) assert.equal(result.ok, true);
  return { socket, channel: channels.get('live:room'), sent, state, removedChannels, joinResult: result, context };
}

function emit(socket, event, data) {
  return new Promise(resolve => socket.emit(event, data, resolve));
}

test('a returning guest retries a request that reaches the host before presence synchronizes', async () => {
  const host = await setup(true);
  const requests = [];
  host.socket.on('live_guest_request', request => requests.push(request));
  host.channel.signal({ event: 'cmd_guest_request', from: 'guest', to: 'host', data: { socketId: 'guest', name: 'Guest' } });
  host.socket.emit('live_guest_decision', { socketId: 'guest', accept: true });
  const previousGuest = host.state.guest[0];
  delete host.state.guest;
  host.channel.leave('guest', previousGuest);
  await new Promise(resolve => setImmediate(resolve));

  const returning = { isHost: false, name: 'Guest', userId: 'guest-user' };
  const guest = await setup(false, { guestSocketId: 'guest-return', existingMembers: { guest: [], 'guest-return': [returning] } });
  const intervals = new Map();
  let nextTimer = 0;
  Object.assign(guest.context, {
    socket: guest.socket, isGuestRole: () => true, guestOnStage: false, guestRequestPending: false,
    updateLocalMediaControls() {}, showLiveError: error => { throw new Error(error); },
    setTimeout: () => ++nextTimer, clearTimeout() {},
    setInterval: fn => { const id = ++nextTimer; intervals.set(id, fn); return id; },
    clearInterval: id => intervals.delete(id)
  });
  const request = liveSource.slice(liveSource.indexOf('function requestGuestSlot('), liveSource.indexOf('\nasync function stopLocalMedia('));
  vm.runInContext(request, guest.context);
  const guestSend = guest.channel.send;
  guest.channel.send = async packet => { const result = await guestSend(packet); host.channel.signal(packet.payload); return result; };
  const hostSend = host.channel.send;
  let dropReceipt = true;
  host.channel.send = async packet => {
    const result = await hostSend(packet);
    if (dropReceipt && packet.payload.event === 'live_guest_request_received') {
      dropReceipt = false;
      return result;
    }
    guest.channel.signal(packet.payload);
    return result;
  };

  const approval = guest.context.requestGuestSlot();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(guest.context.guestRequestPending, true);
  assert.equal(requests.length, 1, 'the first returning request arrives before the host knows this connection');
  host.state['guest-return'] = [returning];
  host.channel.join('guest-return', returning);
  for (const tick of intervals.values()) tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2, 'the host must receive a fresh request after presence catches up');
  assert.equal(requests[1].socketId, 'guest-return');
  assert.equal(intervals.size, 1, 'a lost receipt must not stop delivery retries');
  for (const tick of intervals.values()) tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2, 'retries must not create duplicate host requests');
  assert.equal(intervals.size, 0, 'a repeated receipt confirms delivery');
  assert.equal(guest.context.guestOnStage, false, 'delivery confirmation is not host approval');
  assert.equal(guest.context.guestRequestPending, true);
  host.socket.emit('live_guest_decision', { socketId: 'guest-return', accept: true });
  assert.equal(await approval, true);
  assert.equal(guest.context.guestOnStage, true);
  assert.equal(intervals.size, 0, 'approval stops request retries');
});

test('only the host receipt for the current request stops delivery retries', async () => {
  const { socket, channel, sent, context } = await setup(false);
  const intervals = new Map();
  let nextId = 0;
  context.crypto.randomUUID = () => `request-${++nextId}`;
  context.setInterval = fn => { intervals.set(1, fn); return 1; };
  context.clearInterval = id => intervals.delete(id);
  await emit(socket, 'live_guest_join', {});
  const previous = sent.at(-1).payload.data.requestId;
  socket.emit('live_guest_leave');
  await emit(socket, 'live_guest_join', {});
  const current = sent.at(-1).payload.data.requestId;
  channel.signal({ event: 'live_guest_request_received', from: 'guest', to: 'guest', data: { requestId: current } });
  channel.signal({ event: 'live_guest_request_received', from: 'host', to: 'guest', data: { requestId: previous } });
  assert.equal(intervals.size, 1, 'neither another viewer nor a stale receipt confirms delivery');
  const beforeRetry = sent.length;
  intervals.get(1)();
  assert.equal(sent.length, beforeRetry + 1);
  channel.signal({ event: 'live_guest_request_received', from: 'host', to: 'guest', data: { requestId: current } });
  assert.equal(intervals.size, 0);
});

test('guest delivery retries stop on leaving the room and report an unreachable host', async () => {
  const { socket, context } = await setup(false);
  const intervals = new Map(), denied = [];
  context.setInterval = fn => { intervals.set(1, fn); return 1; };
  context.clearInterval = id => intervals.delete(id);
  socket.on('live_guest_denied', data => denied.push(data.reason));
  await emit(socket, 'live_guest_join', {});
  for (let attempt = 0; attempt < 30; attempt++) intervals.get(1)();
  assert.equal(intervals.size, 0);
  assert.equal(denied.length, 1);
  assert.match(denied[0], /Could not deliver/);
  await emit(socket, 'live_guest_join', {});
  assert.equal(intervals.size, 1);
  await emit(socket, 'leave_live_room', 'room');
  assert.equal(intervals.size, 0);
});

test('live room reports a lost connection and restores presence before reconnecting', async () => {
  const { socket, channel } = await setup(false);
  const events = [];
  socket.on('live_room_disconnected', () => events.push('disconnected'));
  socket.on('live_room_reconnected', () => events.push('reconnected'));
  let resolveTrack;
  channel.track = () => new Promise(resolve => { resolveTrack = resolve; });
  channel.status('CHANNEL_ERROR');
  channel.status('SUBSCRIBED');
  assert.deepEqual(events, ['disconnected']);
  resolveTrack('ok');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['disconnected', 'reconnected']);
});

test('a later device takes over even when the previous device clock is ahead', async () => {
  const { joinResult, sent } = await setup(false, {
    duplicateDevice: true,
    existingJoinOrder: Number.MAX_SAFE_INTEGER
  });
  assert.equal(joinResult.ok, true);
  assert.ok(sent.some(item => item.payload.event === 'live_session_replaced'
    && item.payload.to === 'guest'
    && item.payload.data.userId === 'guest-user'));
});

test('a new device is rejected if the old device cannot be disconnected', async () => {
  const { joinResult, sent, removedChannels, channel } = await setup(false, { duplicateDevice: true, completeHandoff: false });
  assert.equal(joinResult.ok, false);
  assert.match(joinResult.error, /disconnect your other device/i);
  assert.equal(sent.filter(item => item.payload.event === 'live_session_replaced').length, 10);
  assert.ok(removedChannels.includes(channel));
});

test('a replaced device leaves its room without ending the host broadcast', async () => {
  const { socket, channel, state, removedChannels } = await setup(false);
  state['guest-device-2'] = [{ isHost: false, name: 'Guest', userId: 'guest-user', joinOrder: Date.now() + 1 }];
  const replaced = [];
  socket.on('live_session_replaced', () => replaced.push(true));

  channel.signal({
    event: 'live_session_replaced',
    from: 'guest-device-2',
    to: 'guest',
    data: { userId: 'guest-user' }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replaced, [true]);
  assert.ok(removedChannels.includes(channel));
});

test('replacement waits for presence synchronization before validating the sender', async () => {
  const { socket, channel, state, removedChannels } = await setup(false);
  const replaced = [];
  socket.on('live_session_replaced', () => replaced.push(true));
  channel.signal({
    event: 'live_session_replaced', from: 'guest-device-2', to: 'guest', data: { userId: 'guest-user' }
  });
  assert.equal(replaced.length, 0);
  state['guest-device-2'] = [{ userId: 'guest-user' }];
  channel.sync();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replaced, [true]);
  assert.ok(removedChannels.includes(channel));
});

test('another account cannot replace a live viewer', async () => {
  const { socket, channel, state, removedChannels } = await setup(false);
  state.other = [{ userId: 'other-user' }];
  let replaced = false;
  socket.on('live_session_replaced', () => { replaced = true; });
  channel.signal({ event: 'live_session_replaced', from: 'other', to: 'guest', data: { userId: 'guest-user' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replaced, false);
  assert.equal(removedChannels.includes(channel), false);
});

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

test('shared-image display mode reaches viewers and late joiners without changing camera mode', async () => {
  const viewer = await setup(false);
  const states = [];
  viewer.socket.on('live_camera_state', data => states.push(data));
  viewer.channel.signal({ event: 'live_camera_state', from: 'host', data: { enabled: true, image: true } });
  viewer.channel.signal({ event: 'live_camera_state', from: 'host', data: { enabled: true } });
  viewer.channel.signal({ event: 'live_camera_state', from: 'host', data: { enabled: false, image: true } });
  assert.deepEqual(states.map(state => state.image), [true, false, false]);
  const host = await setup(true);
  host.socket.emit('live_camera_state', { enabled: true, image: true, targetSocketId: 'guest' });
  await new Promise(resolve => setImmediate(resolve));
  const sent = host.sent.find(item => item.payload.event === 'live_camera_state');
  assert.equal(sent.payload.to, 'guest');
  assert.equal(sent.payload.data.image, true);
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

test('one account cannot join the live stage from multiple devices', async () => {
  const { socket, channel, state, sent } = await setup(true);
  state['guest-device-2'] = [{
    isHost: false,
    name: 'Guest',
    userId: 'guest-user',
    platform: 'app'
  }];
  const requests = [];
  socket.on('live_guest_request', data => requests.push(data));

  channel.signal({
    event: 'cmd_guest_request',
    from: 'guest',
    to: 'host',
    data: { socketId: 'guest', name: 'Guest' }
  });
  channel.signal({
    event: 'cmd_guest_request',
    from: 'guest-device-2',
    to: 'host',
    data: { socketId: 'guest-device-2', name: 'Guest' }
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].userId, 'guest-user');
  assert.ok(sent.some(item => item.payload.event === 'live_guest_denied'
    && item.payload.to === 'guest-device-2'
    && /another device/.test(item.payload.data.reason)));

  socket.emit('live_guest_decision', { socketId: 'guest', accept: true });
  channel.signal({
    event: 'cmd_guest_request',
    from: 'guest-device-2',
    to: 'host',
    data: { socketId: 'guest-device-2', name: 'Guest' }
  });
  assert.equal(sent.filter(item => item.payload.event === 'live_guest_denied'
    && item.payload.to === 'guest-device-2').length, 2);
  assert.ok(sent.some(item => item.payload.event === 'live_stage_guest_info'
    && item.payload.data.userId === 'guest-user'));
});

test('viewers cannot send host invitations', async () => {
  const { socket } = await setup(false);
  const result = await emit(socket, 'live_invite_guest', { socketId: 'host' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Only the host/);
});

test('only the host can select a valid layout and late joiners receive it', async () => {
  const { socket, channel, sent } = await setup(true);
  const result = await emit(socket, 'live_set_layout', 'host-left');
  assert.equal(result.ok, true);
  assert.ok(sent.some(item => item.payload.event === 'live_layout' && item.payload.data.layout === 'host-left'));
  channel.join('new-viewer', { name: 'Viewer', userId: 'viewer', isHost: false });
  assert.ok(sent.some(item => item.payload.event === 'live_layout' && item.payload.to === 'new-viewer'
    && item.payload.data.layout === 'host-left'));
  assert.equal((await emit(socket, 'live_set_layout', 'invalid')).ok, false);
  const viewer = await setup(false);
  assert.equal((await emit(viewer.socket, 'live_set_layout', 'four')).ok, false);
  const layouts = [];
  viewer.socket.on('live_layout', data => layouts.push(data.layout));
  viewer.channel.signal({ event: 'live_layout', from: 'guest', data: { layout: 'four' } });
  viewer.channel.signal({ event: 'live_layout', from: 'host', data: { layout: 'invalid' } });
  viewer.channel.signal({ event: 'live_layout', from: 'host', data: { layout: 'four' } });
  assert.deepEqual(layouts, ['four']);
  channel.send = async () => 'error';
  assert.equal((await emit(socket, 'live_set_layout', 'six')).ok, false);
});

test('host-only layout is rejected while a guest is on stage', async () => {
  const { socket, channel } = await setup(true);
  channel.signal({ event: 'cmd_guest_request', from: 'guest', to: 'host', data: { socketId: 'guest', name: 'Guest' } });
  socket.emit('live_guest_decision', { socketId: 'guest', accept: true });
  assert.equal((await emit(socket, 'live_set_layout', 'full')).ok, false);
  assert.equal((await emit(socket, 'live_set_layout', 'two')).ok, true);
});

test('side-guest layout synchronizes to viewers and late joiners', async () => {
  const host = await setup(true);
  assert.equal((await emit(host.socket, 'live_set_layout', 'host-overlay')).ok, true);
  host.channel.join('late', { name: 'Late', userId: 'late-user', isHost: false });
  assert.ok(host.sent.some(item => item.payload.event === 'live_layout'
    && item.payload.to === 'late' && item.payload.data.layout === 'host-overlay'));
  const viewer = await setup(false);
  const layouts = [];
  viewer.socket.on('live_layout', data => layouts.push(data.layout));
  viewer.channel.signal({ event: 'live_layout', from: 'host', data: { layout: 'host-overlay' } });
  assert.deepEqual(layouts, ['host-overlay']);
  assert.equal((await emit(viewer.socket, 'live_set_layout', 'host-overlay')).ok, false);
  const viewers = await emit(host.socket, 'live_viewers');
  const guest = viewers.viewers.find(item => item.id === 'guest-user');
  assert.equal(guest.socketId, 'guest');
  assert.equal((await emit(host.socket, 'live_invite_guest', { socketId: guest.socketId })).ok, true);
});

test('website platform follows live presence into viewer list, chat and stage requests', async () => {
  const { socket, channel, state, sent } = await setup(true);
  state.guest[0].platform = 'web';
  const viewers = await emit(socket, 'live_viewers');
  assert.equal(viewers.viewers.find(viewer => viewer.id === 'guest-user').platform, 'web');
  const chats = [];
  const requests = [];
  socket.on('live_chat_message', message => chats.push(message));
  socket.on('live_guest_request', request => requests.push(request));
  channel.signal({ event: 'live_chat_message', from: 'guest', data: { username: 'Guest', content: 'Hello', platform: 'app' } });
  assert.equal(chats[0].platform, 'web');
  channel.signal({ event: 'cmd_guest_request', from: 'guest', to: 'host', data: { socketId: 'guest', name: 'Guest' } });
  assert.equal(requests[0].platform, 'web');
  socket.emit('live_guest_decision', { socketId: 'guest', accept: true });
  assert.equal(sent.find(item => item.payload.event === 'live_stage_guest_info').payload.data.platform, 'web');
});

test('only the host can remove a stage guest, and the guest can request again', async () => {
  const { socket, channel, sent } = await setup(true);
  const left = [];
  socket.on('live_stage_guest_left', info => left.push(info.socketId));
  assert.equal((await emit(socket, 'live_remove_guest', { socketId: 'guest' })).ok, false);
  channel.signal({ event: 'cmd_guest_request', from: 'guest', to: 'host', data: { socketId: 'guest', name: 'Guest' } });
  socket.emit('live_guest_decision', { socketId: 'guest', accept: true });
  assert.equal((await emit(socket, 'live_remove_guest', { socketId: 'guest' })).ok, true);
  assert.ok(sent.some(item => item.payload.event === 'live_remove_from_stage' && item.payload.to === 'guest'));
  assert.ok(sent.some(item => item.payload.event === 'live_stage_guest_left' && item.payload.data.socketId === 'guest'));
  assert.deepEqual(left, ['guest']);
  const requests = [];
  socket.on('live_guest_request', info => requests.push(info));
  channel.signal({ event: 'cmd_guest_request', from: 'guest', to: 'host', data: { socketId: 'guest', name: 'Guest' } });
  assert.equal(requests.length, 1);
  const viewer = await setup(false);
  assert.equal((await emit(viewer.socket, 'live_remove_guest', { socketId: 'host' })).ok, false);
});

test('a guest can leave the stage, keep chatting and request host approval again', async () => {
  const { socket, channel, sent } = await setup(true);
  const requests = [], chats = [];
  socket.on('live_guest_request', request => requests.push(request));
  socket.on('live_chat_message', message => chats.push(message));
  const request = { event: 'cmd_guest_request', from: 'guest', to: 'host', data: { socketId: 'guest', name: 'Guest' } };
  channel.signal(request);
  socket.emit('live_guest_decision', { socketId: 'guest', accept: true });
  channel.signal({ event: 'cmd_guest_leave', from: 'guest', to: 'host', data: { socketId: 'guest' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(sent.some(packet => packet.payload.event === 'live_guest_count' && packet.payload.data.count === 0));
  channel.signal({ event: 'live_chat_message', from: 'guest', data: { username: 'Guest', content: 'Still watching!' } });
  assert.equal(chats[0].content, 'Still watching!');
  const approvals = sent.filter(packet => packet.payload.event === 'live_guest_approved').length;
  channel.signal(request);
  assert.equal(requests.length, 2);
  assert.equal(sent.filter(packet => packet.payload.event === 'live_guest_approved').length, approvals, 'returning guests still need host approval');
  socket.emit('live_guest_decision', { socketId: 'guest', accept: true });
  assert.equal(sent.filter(packet => packet.payload.event === 'live_guest_approved').length, approvals + 1);
});

test('guest accepts a targeted removal only from the host', async () => {
  const { socket, channel } = await setup(false);
  let removed = 0;
  socket.on('live_remove_from_stage', () => removed++);
  channel.signal({ event: 'live_remove_from_stage', from: 'guest', to: 'guest', data: {} });
  channel.signal({ event: 'live_remove_from_stage', from: 'host', data: {} });
  channel.signal({ event: 'live_remove_from_stage', from: 'host', to: 'guest', data: {} });
  assert.equal(removed, 1);
});

test('host can mute a stage guest but cannot send an unmute command', async () => {
  const { socket, channel, sent } = await setup(true);
  assert.equal((await emit(socket, 'live_mute_guest', { socketId: 'guest', muted: true })).ok, false);
  channel.signal({ event: 'cmd_guest_request', from: 'guest', to: 'host', data: { socketId: 'guest', name: 'Guest' } });
  socket.emit('live_guest_decision', { socketId: 'guest', accept: true });
  assert.equal((await emit(socket, 'live_mute_guest', { socketId: 'guest', muted: false })).ok, false);
  assert.equal((await emit(socket, 'live_mute_guest', { socketId: 'guest', muted: true })).ok, true);
  const mutes = sent.filter(item => item.payload.event === 'live_force_mute');
  assert.equal(mutes.length, 1);
  assert.equal(mutes[0].payload.to, 'guest');
  assert.equal(mutes[0].payload.data.muted, true);
  channel.send = async () => 'error';
  assert.equal((await emit(socket, 'live_mute_guest', { socketId: 'guest', muted: true })).ok, false);
  const viewer = await setup(false);
  assert.equal((await emit(viewer.socket, 'live_mute_guest', { socketId: 'host', muted: true })).ok, false);
});

test('guests accept only targeted host mute commands and never remote unmute', async () => {
  const { socket, channel } = await setup(false);
  const mutes = [];
  socket.on('live_force_mute', data => mutes.push(data.muted));
  channel.signal({ event: 'live_force_mute', from: 'guest', to: 'guest', data: { muted: true } });
  channel.signal({ event: 'live_force_mute', from: 'host', data: { muted: true } });
  channel.signal({ event: 'live_force_mute', from: 'host', to: 'guest', data: { muted: false } });
  channel.signal({ event: 'live_force_mute', from: 'host', to: 'guest', data: { muted: true } });
  assert.deepEqual(mutes, [true]);
});

test('host accepts microphone state only from the corresponding stage guest', async () => {
  const { socket, channel } = await setup(true);
  channel.signal({ event: 'cmd_guest_request', from: 'guest', to: 'host', data: { socketId: 'guest', name: 'Guest' } });
  socket.emit('live_guest_decision', { socketId: 'guest', accept: true });
  const states = [];
  socket.on('live_mute_state', data => states.push(data.muted));
  channel.signal({ event: 'live_mute_state', from: 'other', to: 'host', data: { socketId: 'guest', muted: false } });
  channel.signal({ event: 'live_mute_state', from: 'guest', to: 'host', data: { socketId: 'other', muted: false } });
  channel.signal({ event: 'live_mute_state', from: 'guest', to: 'host', data: { socketId: 'guest', muted: true } });
  channel.signal({ event: 'live_mute_state', from: 'guest', to: 'host', data: { socketId: 'guest', muted: false } });
  assert.deepEqual(states, [true, false]);
});

test('stage departure notifications are accepted only from the host', async () => {
  const { socket, channel } = await setup(false);
  const left = [];
  socket.on('live_stage_guest_left', info => left.push(info.socketId));
  channel.signal({ event: 'live_stage_guest_left', from: 'guest', data: { socketId: 'guest' } });
  channel.signal({ event: 'live_stage_guest_left', from: 'host', data: { socketId: 'guest' } });
  assert.deepEqual(left, ['guest']);
});

test('failed removal notification leaves the guest on stage', async () => {
  const { socket, channel } = await setup(true);
  channel.signal({ event: 'cmd_guest_request', from: 'guest', to: 'host', data: { socketId: 'guest', name: 'Guest' } });
  socket.emit('live_guest_decision', { socketId: 'guest', accept: true });
  channel.send = async () => 'error';
  assert.equal((await emit(socket, 'live_remove_guest', { socketId: 'guest' })).ok, false);
  assert.match((await emit(socket, 'live_invite_guest', { socketId: 'guest' })).error, /already on stage/);
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

test('same account on a second device does not create a duplicate joined notice', async () => {
  const { socket, channel, state } = await setup(true);
  const arrivals = [];
  socket.on('live_member_joined', data => arrivals.push(data));
  const firstDevice = { isHost: false, name: 'Guest', userId: 'guest-user', joinOrder: 1 };
  channel.join('guest', firstDevice);
  state['guest-device-2'] = [{ ...firstDevice, joinOrder: 2 }];
  channel.join('guest-device-2', state['guest-device-2'][0]);
  assert.equal(arrivals.length, 1);
});

test('viewers see new arrivals after presence sync even when device clocks differ', async () => {
  const existing = { isHost: false, name: 'Existing', userId: 'existing', joinOrder: 1, platform: 'app' };
  const { socket, channel, state } = await setup(false, { existingMembers: { existing: [existing] } });
  const arrivals = [];
  socket.on('live_member_joined', data => arrivals.push(data));
  channel.join('existing', existing);
  channel.sync();
  channel.join('existing', existing);
  assert.equal(arrivals.length, 0);

  const newcomer = { isHost: false, name: 'New viewer', userId: 'new-user', joinOrder: 1, platform: 'web' };
  state.newcomer = [newcomer];
  channel.join('newcomer', newcomer);
  channel.join('newcomer', newcomer);
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].name, 'New viewer');
  assert.equal(arrivals[0].platform, 'web');

  state['new-device'] = [newcomer];
  channel.join('new-device', newcomer);
  assert.equal(arrivals.length, 1);
  delete state['new-device'];
  channel.leave('newcomer', newcomer);
  channel.join('newcomer', newcomer);
  assert.equal(arrivals.length, 2);
  channel.join('host', { isHost: true, name: 'Host' });
  channel.join('guest', { isHost: false, name: 'Self' });
  assert.equal(arrivals.length, 2);
});

test('all viewers receive join notices even when initial presence sync is delayed', async () => {
  for (const guestOnStage of [false, true]) {
    for (const platform of ['app', 'web']) {
      const { socket, channel, state } = await setup(false);
      const messages = { children: [], appendChild(child) { this.children.push(child); } };
      const document = {
        getElementById: () => messages,
        createElement: chatElement
      };
      const context = { document, socket, isGuestRole: () => true, guestOnStage };
      vm.runInNewContext(invitationUI, context);
      const handler = liveSource.slice(liveSource.indexOf("  socket.off('live_member_joined');"), liveSource.indexOf("  socket.off('live_host_invite');"));
      vm.runInNewContext(handler, context);
      const newcomer = { name: 'New viewer', userId: 'new-user', platform };
      state.newcomer = [newcomer];
      channel.join('newcomer', newcomer);
      channel.sync();
      channel.join('newcomer', newcomer);
      assert.equal(messages.children.length, 1);
      assert.equal(messages.children[0].textContent, `✨ New viewer${platform === 'web' ? ' W' : ''} joined the live`);
      const username = messages.children[0].children[1];
      assert.equal(username.children.length, platform === 'web' ? 1 : 0);
      if (platform === 'web') assert.equal(username.children[0].className, 'live-web-badge');
    }
  }
});

test('viewers see non-clickable join messages whether or not they are on stage', async () => {
  for (const guestOnStage of [false, true]) {
    const { socket, channel } = await setup(false);
    const messages = { children: [], appendChild(child) { this.children.push(child); } };
    const document = {
      getElementById: () => messages,
      createElement: chatElement
    };
    const context = { document, socket, isGuestRole: () => true, guestOnStage };
    vm.runInNewContext(invitationUI, context);
    const handler = liveSource.slice(liveSource.indexOf("  socket.off('live_member_joined');"), liveSource.indexOf("  socket.off('live_host_invite');"));
    vm.runInNewContext(handler, context);
    channel.sync();
    channel.join('newcomer', { name: 'New viewer', userId: 'new-user', platform: 'web', joinOrder: 1 });
    assert.equal(messages.children[0].textContent, '✨ New viewer W joined the live');
    assert.equal(messages.children[0].children[1].className, undefined);
  }
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
    createElement: chatElement
  };
  const context = { socket, document, isGuestRole: () => false, showLiveError: error => { throw new Error(error); } };
  vm.runInNewContext(invitationUI, context);
  socket.on('live_member_joined', ({ name, socketId, platform }) => context.renderSystemChatMessage('', socketId, name, platform));
  channel.join('guest', { isHost: false, name: 'Guest', joinOrder: 1, platform: 'web' });
  const button = messages.children[0].children[1];
  assert.equal(button.attributes['aria-label'], 'Invite Guest to join');
  assert.equal(button.textContent, 'Guest W');
  assert.equal(button.children[0].className, 'live-web-badge');
  button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(sent.some(item => item.payload.event === 'live_host_invite' && item.payload.to === 'guest'));
  assert.equal(sent.some(item => item.payload.event === 'live_guest_approved'), false);
  channel.signal({ event: 'cmd_guest_request', from: 'guest', to: 'host', data: { socketId: 'guest', name: 'Guest', acceptInvite: true } });
  assert.ok(sent.some(item => item.payload.event === 'live_guest_approved' && item.payload.to === 'guest'));
});

test('live chat marks website users without marking app users', () => {
  const messages = chatElement();
  const document = { getElementById: () => messages, createElement: chatElement };
  const render = liveSource.slice(liveSource.indexOf('function renderChatMessage('), liveSource.indexOf('\nfunction attachChatStyleControls('));
  const context = { document, isGuestRole: () => true, socket: { id: 'self' }, API_ORIGIN: '' };
  vm.runInNewContext(badge + render, context);
  for (const platform of ['web', 'app']) context.renderChatMessage({ username: 'Guest', content: 'Hello', platform });
  assert.equal(messages.children[0].children[1].textContent, 'Guest W');
  assert.equal(messages.children[0].children[1].children[0].className, 'live-web-badge');
  assert.equal(messages.children[1].children[1].textContent, 'Guest');
  assert.equal(messages.children[1].children[1].children.length, 0);
});

test('join notices use chat font sizing and a yellow color with a red website badge', () => {
  const css = fs.readFileSync(path.join(__dirname, '../frontend/css/live-layout.css'), 'utf8');
  const systemRule = css.match(/\.live-container \.live-stage \.live-chat-system\s*\{([^}]*)\}/);
  assert.ok(systemRule);
  assert.match(systemRule[1], /color:\s*#ffd700/i);
  assert.doesNotMatch(systemRule[1], /font-size/);
  assert.doesNotMatch(invitationUI, /font-size:\s*12px/);
  assert.match(css, /\.live-web-badge\s*\{[^}]*color:\s*#ff3b4e/i);
});

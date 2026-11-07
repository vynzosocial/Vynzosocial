// Socket.IO-compatible realtime layer built on Supabase Realtime (broadcast + presence).
// It replaces the removed Render backend for live rooms, calls and instant message pings.
import { supabase } from './supabase-client.js';
import { apiRequest } from './api.js?v=sb6';
import { createOfflineSocket } from './config.js?v=sb4';

const MAX_LIVE_GUESTS = 11;
const LAYOUTS = ['auto', 'full', 'panel', 'fixed', 'sidebar', 'side', 'spotlight', 'round1', 'round2'];
const CALL_RING_MS = 45000;
const HOST_GRACE_MS = 30000;

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const currentUser = () => {
  try { return JSON.parse(localStorage.getItem('vynzo_user') || '{}'); } catch { return {}; }
};
const displayName = user => user.display_name || user.username || 'Guest';

// Private channels are authorised by RLS, so the socket must carry the user's JWT before joining.
async function ensureRealtimeAuth() {
  const { data } = await supabase.auth.getSession();
  if (!data?.session?.access_token) throw new Error('Please log in again to use live features.');
  await supabase.realtime.setAuth(data.session.access_token);
}

function subscribe(channel) {
  return new Promise((resolve, reject) => {
    let settled = false;
    channel.subscribe(status => {
      if (settled) return;
      if (status === 'SUBSCRIBED') { settled = true; resolve(channel); }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        settled = true;
        reject(new Error(`Realtime ${status.toLowerCase()}`));
      }
    });
  });
}

// One shared connection per page for per-user events (calls and message pings).
const hub = {
  instances: new Set(),
  userId: null,
  socketId: uid(),
  inbox: null,
  online: null,
  outbound: new Map(),
  calls: new Map(),
  starting: null
};

function dispatchAll(event, data) {
  hub.instances.forEach(instance => instance.dispatch(event, data));
}

async function outboundChannel(userId) {
  if (!hub.outbound.has(userId)) {
    hub.outbound.set(userId, ensureRealtimeAuth().then(() => subscribe(
      supabase.channel(`user:${userId}`, { config: { private: true } })
    )).catch(err => {
      hub.outbound.delete(userId);
      throw err;
    }));
  }
  return hub.outbound.get(userId);
}

async function sendToUser(userId, event, data) {
  if (userId === hub.userId && hub.inbox) {
    await hub.inbox.send({ type: 'broadcast', event: 'sig', payload: { event, data, from: hub.socketId, userId: hub.userId } });
    return;
  }
  const channel = await outboundChannel(userId);
  await channel.send({ type: 'broadcast', event: 'sig', payload: { event, data, from: hub.socketId, userId: hub.userId } });
}

function endCallLocally(callId, reason) {
  const call = hub.calls.get(callId);
  if (!call) return;
  clearTimeout(call.timer);
  hub.calls.delete(callId);
  dispatchAll('call_ended', { callId, reason });
}

function onUserSignal({ event, data, from, userId }) {
  if (from === hub.socketId) return;
  switch (event) {
    case 'call_invite': {
      if (hub.calls.has(data.callId)) return;
      const call = { peerId: userId, role: 'callee', accepted: false, timer: null };
      call.timer = setTimeout(() => {
        if (!call.accepted) endCallLocally(data.callId, 'missed');
      }, CALL_RING_MS);
      hub.calls.set(data.callId, call);
      dispatchAll('call_incoming', data);
      break;
    }
    case 'call_accept': {
      const call = hub.calls.get(data.callId);
      if (!call || call.role !== 'caller') return;
      call.accepted = true;
      clearTimeout(call.timer);
      dispatchAll('call_accepted', { callId: data.callId });
      break;
    }
    case 'call_end':
      endCallLocally(data.callId, data.reason || 'ended');
      break;
    case 'call_signal':
      if (hub.calls.get(data.callId)?.accepted) dispatchAll('call_signal', data);
      break;
    case 'conversation_changed':
      dispatchAll('conversation_changed', data);
      break;
    default:
  }
}

async function startHub() {
  const user = currentUser();
  if (!supabase || !user.id) throw new Error('Log in to use realtime features.');
  if (hub.starting) return hub.starting;
  hub.userId = user.id;
  hub.starting = (async () => {
    await ensureRealtimeAuth();
    const inbox = supabase.channel(`user:${user.id}`, { config: { broadcast: { self: false }, private: true } });
    inbox.on('broadcast', { event: 'sig' }, ({ payload }) => onUserSignal(payload));
    const online = supabase.channel('vynzo:online', { config: { presence: { key: user.id }, private: true } });
    await subscribe(inbox);
    await subscribe(online);
    await online.track({ user_id: user.id, at: Date.now() });
    hub.inbox = inbox;
    hub.online = online;
    hub.outbound.set(user.id, Promise.resolve(inbox));
  })().catch(err => {
    hub.starting = null;
    throw err;
  });
  return hub.starting;
}

window.addEventListener('pagehide', () => {
  for (const [callId, call] of hub.calls) {
    const reason = !call.accepted && call.role === 'callee' ? 'declined' : 'ended';
    sendToUser(call.peerId, 'call_end', { callId, reason }).catch(() => {});
  }
});

function isUserOnline(userId) {
  return Boolean(hub.online && hub.online.presenceState()[userId]);
}

export function createRealtimeSocket(options = {}) {
  if (!supabase) return createOfflineSocket();

  const handlers = new Map();
  const commands = {};
  let room = null;
  let started = false;

  const socket = {
    connected: false,
    active: false,
    id: hub.socketId,
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return socket;
    },
    off(event, fn) {
      if (!fn) handlers.delete(event);
      else handlers.get(event)?.delete(fn);
      return socket;
    },
    once(event, fn) {
      const wrapper = data => { socket.off(event, wrapper); fn(data); };
      return socket.on(event, wrapper);
    },
    removeAllListeners() { handlers.clear(); return socket; },
    emit(event, ...args) {
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
      const command = commands[event];
      if (!command) return socket;
      Promise.resolve(command(args[0], ack)).catch(err => {
        console.error(`Realtime "${event}" failed:`, err);
        ack({ ok: false, error: err.message || 'Realtime action failed.' });
      });
      return socket;
    },
    timeout(ms) {
      return {
        emit(event, ...args) {
          const callback = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
          let done = false;
          const timer = setTimeout(() => {
            if (done) return;
            done = true;
            callback(new Error('Realtime request timed out'));
          }, ms);
          socket.emit(event, ...args, response => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            callback(null, response);
          });
        }
      };
    },
    connect() {
      if (started) return socket;
      started = true;
      socket.active = true;
      startHub()
        .then(() => {
          socket.connected = true;
          dispatch('connect');
        })
        .catch(err => {
          started = false;
          socket.active = false;
          dispatch('connect_error', err);
        });
      return socket;
    },
    disconnect() {
      leaveRoom().catch(() => {});
      socket.connected = false;
      socket.active = false;
      started = false;
      hub.instances.delete(instance);
      dispatch('disconnect');
      return socket;
    }
  };

  function dispatch(event, data) {
    handlers.get(event)?.forEach(fn => {
      try { fn(data); } catch (err) { console.error(`Realtime handler "${event}" failed:`, err); }
    });
  }
  const instance = { dispatch };
  hub.instances.add(instance);

  // ---- messages and calls ----
  commands.notify_peer = ({ userId, conversation_id: conversationId }) => {
    if (!userId) return;
    sendToUser(userId, 'conversation_changed', { conversation_id: conversationId }).catch(() => {});
  };

  commands.join_conversation = (_id, ack) => ack({ ok: true });

  commands.call_invite = async ({ conversationId, video, calleeId }, ack) => {
    const me = currentUser();
    if (!me.id) return ack({ ok: false, error: 'Please log in to make calls.' });
    if (!calleeId) return ack({ ok: false, error: 'Calls are only available in one-to-one chats.' });
    await startHub();
    if ([...hub.calls.values()].length) return ack({ ok: false, error: 'You are already in a call.' });
    if (!isUserOnline(calleeId)) return ack({ ok: false, error: 'This person is offline right now.' });

    const callId = uid();
    const call = { peerId: calleeId, role: 'caller', accepted: false, timer: null };
    call.timer = setTimeout(() => {
      if (call.accepted) return;
      sendToUser(calleeId, 'call_end', { callId, reason: 'missed' }).catch(() => {});
      endCallLocally(callId, 'no_answer');
    }, CALL_RING_MS);
    hub.calls.set(callId, call);
    await sendToUser(calleeId, 'call_invite', {
      callId,
      conversationId,
      video: Boolean(video),
      from: { id: me.id, username: me.username, display_name: me.display_name, avatar_url: me.avatar_url }
    });
    ack({ ok: true, callId });
  };

  commands.call_accept = ({ callId }) => {
    const call = hub.calls.get(callId);
    if (!call || call.role !== 'callee' || call.accepted) return;
    call.accepted = true;
    clearTimeout(call.timer);
    sendToUser(call.peerId, 'call_accept', { callId }).catch(() => {});
    sendToUser(hub.userId, 'call_end', { callId, reason: 'answered_elsewhere' }).catch(() => {});
  };

  commands.call_end = ({ callId }) => {
    const call = hub.calls.get(callId);
    if (!call) return;
    const reason = !call.accepted && call.role === 'callee' ? 'declined' : 'ended';
    sendToUser(call.peerId, 'call_end', { callId, reason }).catch(() => {});
    sendToUser(hub.userId, 'call_end', { callId, reason: 'ended' }).catch(() => {});
    clearTimeout(call.timer);
    hub.calls.delete(callId);
  };

  commands.call_signal = ({ callId, signal }) => {
    const call = hub.calls.get(callId);
    if (!call || !call.accepted) return;
    sendToUser(call.peerId, 'call_signal', { callId, signal }).catch(() => {});
  };

  // ---- live rooms ----
  const hostSocketId = () => {
    if (!room) return null;
    const state = room.channel.presenceState();
    for (const [key, metas] of Object.entries(state)) {
      if (metas.some(meta => meta.isHost)) return key;
    }
    return null;
  };

  const sendRoom = (event, data, to) => room?.channel.send({
    type: 'broadcast',
    event: 'sig',
    payload: { event, data, from: socket.id, to: to || null }
  });

  const removeStageGuest = socketId => {
    if (!room) return;
    room.invites.delete(socketId);
    if (room.pending.delete(socketId)) sendRoom('live_guest_request_cancel', { socketId });
    if (room.guests.delete(socketId)) {
      sendRoom('live_guest_count', { count: room.guests.size, max: MAX_LIVE_GUESTS });
      sendRoom('live_stage_guest_left', { socketId });
    }
  };

  const reportViewerCount = () => {
    if (!room || !room.isHost) return;
    const viewers = Math.max(0, Object.keys(room.channel.presenceState()).length - 1);
    apiRequest(`/live/${encodeURIComponent(room.sessionId)}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({ viewer_count: viewers })
    }).catch(() => {});
  };

  function onRoomSignal(payload) {
    if (!room || (payload.to && payload.to !== socket.id)) return;
    const { event, data, from } = payload;
    if (event === 'cmd_guest_request') {
      if (!room.isHost) return;
      if (!from || data.socketId !== from || !room.channel.presenceState()[from]) return;
      if (room.guests.size >= MAX_LIVE_GUESTS) {
        sendRoom('live_guest_denied', { reason: `The stage is full (${MAX_LIVE_GUESTS} guests maximum).` }, data.socketId);
        return;
      }
      room.pending.set(data.socketId, data);
      if (data.acceptInvite && room.invites.delete(from)) {
        commands.live_guest_decision({ socketId: from, accept: true });
        return;
      }
      dispatch('live_guest_request', data);
      return;
    }
    if (event === 'live_host_invite') {
      if (room.isHost || from !== hostSocketId()) return;
      dispatch(event, data);
      return;
    }
    if (event === 'live_camera_state') {
      if (!room.channel.presenceState()[from] || typeof data?.enabled !== 'boolean') return;
      dispatch(event, { socketId: from, enabled: data.enabled });
      return;
    }
    if (event === 'live_chat_message') {
      if (!room.channel.presenceState()[from]) return;
      dispatch(event, { ...data, socketId: from });
      return;
    }
    if (event === 'cmd_guest_leave') {
      if (room.isHost) removeStageGuest(data.socketId);
      return;
    }
    if (event === 'live_chat_style') room.style = data;
    if (event === 'live_layout') room.layout = data.layout;
    if (event === 'live_stream_ended') {
      dispatch(event, data);
      return;
    }
    if (from === socket.id && ['webrtc_offer', 'webrtc_answer', 'ice_candidate'].includes(event)) return;
    dispatch(event, data);
  }

  function onPresenceJoin(key, metas) {
    if (!room || key === socket.id) return;
    const meta = metas[metas.length - 1] || {};
    dispatch('live_viewers_changed');
    if (meta.joinOrder > room.joinOrder) {
      dispatch('viewer_joined', { socketId: key });
      if (!meta.isHost) dispatch('live_member_joined', { name: meta.name, socketId: key });
    }
    if (meta.isHost && room.hostTimer) {
      clearTimeout(room.hostTimer);
      room.hostTimer = null;
    }
    if (room.isHost) {
      if (room.style) sendRoom('live_chat_style', room.style, key);
      sendRoom('live_layout', { layout: room.layout, hostSocketId: socket.id }, key);
      room.guests.forEach(info => sendRoom('live_stage_guest_info', info, key));
      sendRoom('live_guest_count', { count: room.guests.size, max: MAX_LIVE_GUESTS }, key);
      reportViewerCount();
    }
  }

  function onPresenceLeave(key, metas) {
    if (!room || key === socket.id) return;
    dispatch('viewer_left', { socketId: key });
    dispatch('live_viewers_changed');
    if (room.isHost) {
      removeStageGuest(key);
      reportViewerCount();
    }
    const leftHost = metas.some(meta => meta.isHost);
    if (leftHost && !room.isHost && !hostSocketId()) {
      clearTimeout(room.hostTimer);
      const sessionId = room.sessionId;
      room.hostTimer = setTimeout(() => {
        if (room && room.sessionId === sessionId && !hostSocketId()) dispatch('live_stream_ended', {});
      }, HOST_GRACE_MS);
    }
  }

  async function leaveRoom() {
    if (!room) return;
    const closing = room;
    if (closing.isHost) await sendRoom('live_stream_ended', {})?.catch?.(() => {});
    clearTimeout(closing.hostTimer);
    clearInterval(closing.heartbeat);
    room = null;
    try { await closing.channel.untrack(); } catch { /* channel already closed */ }
    try { await supabase.removeChannel(closing.channel); } catch { /* channel already closed */ }
  }

  commands.join_live_room = async (sessionId, ack) => {
    if (typeof sessionId !== 'string' || !sessionId) return ack({ ok: false, error: 'Invalid livestream.' });
    if (room && room.sessionId === sessionId) {
      return ack({ ok: true, messages: [], layout: room.layout, hostSocketId: hostSocketId() });
    }
    await leaveRoom();
    await startHub();

    let stream = null;
    try {
      const data = await apiRequest('/live');
      stream = (data.liveStreams || []).find(item => String(item.id) === sessionId);
    } catch (err) {
      return ack({ ok: false, error: err.message || 'Unable to load this livestream.' });
    }
    if (!stream) return ack({ ok: false, error: 'This livestream is no longer active.' });

    const me = currentUser();
    const isHost = me.id === stream.host_id;
    const joinOrder = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    const channel = supabase.channel(`live:${sessionId}`, {
      config: { broadcast: { self: true }, presence: { key: socket.id }, private: true }
    });
    const next = {
      sessionId,
      channel,
      isHost,
      joinOrder,
      layout: 'auto',
      style: null,
      pending: new Map(),
      guests: new Map(),
      invites: new Set(),
      hostTimer: null,
      heartbeat: null
    };
    room = next;

    channel.on('broadcast', { event: 'sig' }, ({ payload }) => onRoomSignal(payload));
    channel.on('presence', { event: 'join' }, ({ key, newPresences }) => onPresenceJoin(key, newPresences || []));
    channel.on('presence', { event: 'leave' }, ({ key, leftPresences }) => onPresenceLeave(key, leftPresences || []));

    try {
      await ensureRealtimeAuth();
      await subscribe(channel);
      await channel.track({
        userId: me.id,
        name: displayName(me),
        avatar_url: me.avatar_url || null,
        joinOrder,
        isHost
      });
    } catch (err) {
      room = null;
      return ack({ ok: false, error: err.message || 'Unable to join this livestream.' });
    }

    // Give existing members a moment to appear in presence before answering.
    await new Promise(resolve => setTimeout(resolve, 700));
    if (room !== next) return ack({ ok: false, error: 'Left the livestream.' });

    if (isHost) {
      next.heartbeat = setInterval(reportViewerCount, 20000);
      reportViewerCount();
      sendRoom('live_layout', { layout: next.layout, hostSocketId: socket.id });
    }
    dispatch('live_viewers_changed');
    ack({ ok: true, messages: [], layout: next.layout, hostSocketId: hostSocketId() });
  };

  commands.leave_live_room = async (sessionId, ack = () => {}) => {
    if (room && room.sessionId === sessionId) await leaveRoom();
    ack({ ok: true });
  };

  commands.live_viewers = (_unused, ack) => {
    if (!room) return ack({ ok: false, viewers: [], total: 0 });
    const state = room.channel.presenceState();
    const seen = new Map();
    let total = 0;
    Object.values(state).forEach(metas => {
      total += 1;
      const meta = metas[0];
      if (meta?.userId && !seen.has(meta.userId)) {
        seen.set(meta.userId, { id: meta.userId, username: meta.name, display_name: meta.name, avatar_url: meta.avatar_url });
      }
    });
    ack({ ok: true, viewers: [...seen.values()], total });
  };

  commands.live_chat_message = async (data, ack) => {
    const { sessionId, content, username } = data || {};
    if (!room || room.sessionId !== sessionId) {
      return ack({ ok: false, error: 'Join this live chat before sending messages.' });
    }
    const text = typeof content === 'string' ? content.trim() : '';
    if (!text || text.length > 500) return ack({ ok: false, error: 'Messages must be between 1 and 500 characters.' });
    const me = currentUser();
    await sendRoom('live_chat_message', {
      id: uid(),
      content: text,
      created_at: new Date().toISOString(),
      username: me.id ? displayName(me) : (String(username || '').trim().slice(0, 24) || 'Guest'),
      avatar_url: me.avatar_url || null
    });
    ack({ ok: true });
  };

  commands.update_live_chat_style = ({ sessionId, backgroundColor, fontColor, fontSize } = {}) => {
    const valid = /^#[0-9a-f]{6}$/i;
    if (!room || !room.isHost || room.sessionId !== sessionId || !valid.test(backgroundColor || '')
      || !valid.test(fontColor || '') || !Number.isInteger(fontSize) || fontSize < 12 || fontSize > 24) {
      dispatch('live_chat_error', { error: 'Only the host can change chat appearance.' });
      return;
    }
    sendRoom('live_chat_style', { backgroundColor, fontColor, fontSize });
  };

  commands.live_set_layout = layout => {
    if (!room || !room.isHost || !LAYOUTS.includes(layout)) return;
    sendRoom('live_layout', { layout, hostSocketId: socket.id });
  };

  commands.live_guest_join = (options, ack) => {
    if (!room) return ack({ ok: false, error: 'Log in and join a livestream first.' });
    if (room.isHost) return ack({ ok: true, approved: true });
    if (room.guests.has(socket.id)) return ack({ ok: true, approved: true });
    const host = hostSocketId();
    if (!host) return ack({ ok: false, error: 'This livestream is no longer active.' });
    const me = currentUser();
    sendRoom('cmd_guest_request', { socketId: socket.id, name: displayName(me), avatar_url: me.avatar_url || null, acceptInvite: options?.acceptInvite === true }, host);
    ack({ ok: true, approved: false });
  };

  commands.live_invite_guest = async ({ socketId } = {}, ack) => {
    if (!room || !room.isHost) return ack({ ok: false, error: 'Only the host can invite viewers.' });
    if (!socketId || socketId === socket.id || !room.channel.presenceState()[socketId]) {
      return ack({ ok: false, error: 'This viewer is no longer in the live.' });
    }
    if (room.guests.has(socketId)) return ack({ ok: false, error: 'This viewer is already on stage.' });
    if (room.guests.size >= MAX_LIVE_GUESTS) return ack({ ok: false, error: 'The stage is full.' });
    room.invites.add(socketId);
    const result = await sendRoom('live_host_invite', { name: displayName(currentUser()) }, socketId);
    if (result !== 'ok') {
      room.invites.delete(socketId);
      return ack({ ok: false, error: 'Could not send the invitation. Please try again.' });
    }
    ack({ ok: true });
  };

  commands.live_camera_state = async ({ enabled, targetSocketId } = {}) => {
    if (!room || typeof enabled !== 'boolean') return;
    const result = await sendRoom('live_camera_state', { enabled }, targetSocketId);
    if (result !== 'ok') throw new Error('Unable to notify viewers about the camera state.');
  };

  commands.live_guest_decision = ({ socketId, accept } = {}) => {
    if (!room || !room.isHost) return;
    const request = room.pending.get(socketId);
    if (!request) return;
    room.pending.delete(socketId);
    if (!accept) {
      sendRoom('live_guest_denied', { reason: 'The host declined your request.' }, socketId);
      return;
    }
    if (room.guests.size >= MAX_LIVE_GUESTS) {
      sendRoom('live_guest_denied', { reason: `The stage is full (${MAX_LIVE_GUESTS} guests maximum).` }, socketId);
      return;
    }
    const info = { socketId, name: request.name, avatar_url: request.avatar_url || null };
    room.guests.set(socketId, info);
    sendRoom('live_guest_count', { count: room.guests.size, max: MAX_LIVE_GUESTS });
    sendRoom('live_guest_approved', {}, socketId);
    sendRoom('live_stage_guest_info', info);
    sendRoom('live_guest_joined', { socketId, name: request.name });
    dispatch('live_stage_guest', { socketId, name: request.name });
  };

  commands.live_mute_guest = ({ socketId, muted } = {}) => {
    if (!room || !room.isHost || !room.guests.has(socketId)) return;
    sendRoom('live_force_mute', { muted: Boolean(muted) }, socketId);
    dispatch('live_mute_state', { socketId, muted: Boolean(muted) });
  };

  commands.live_self_mute = ({ muted } = {}) => {
    const host = hostSocketId();
    if (room && host) sendRoom('live_mute_state', { socketId: socket.id, muted: Boolean(muted) }, host);
  };

  commands.live_guest_leave = () => {
    const host = hostSocketId();
    if (room && host && !room.isHost) sendRoom('cmd_guest_leave', { socketId: socket.id }, host);
  };

  ['webrtc_offer', 'webrtc_answer', 'ice_candidate'].forEach(event => {
    commands[event] = ({ targetSocketId, ...rest } = {}) => {
      if (!room || !targetSocketId) return;
      sendRoom(event, { ...rest, senderSocketId: socket.id }, targetSocketId);
    };
  });

  window.addEventListener('pagehide', () => {
    if (!room) return;
    try { room.channel.untrack(); } catch { /* page is closing */ }
  });

  if (options.autoConnect !== false) socket.connect();
  return socket;
}

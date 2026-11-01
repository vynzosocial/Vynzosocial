const db = require('../database/db');
const { hostDisconnectTimers } = require('../services/live-presence');
const HOST_RECONNECT_GRACE_MS = 120000;
const MAX_LIVE_GUESTS = 10;
const stageGuests = new Map();
const stageGuestInfo = new Map();
let liveJoinSequence = 0;

const pendingGuests = new Map();
const sessionLayouts = new Map();
const LAYOUTS = ['auto', 'full', 'panel', 'fixed', 'sidebar', 'side', 'spotlight', 'round1', 'round2'];

function findHostSocketId(io, sessionId, hostId) {
  for (const id of io.sockets.adapter.rooms.get(sessionId) || []) {
    const s = io.sockets.sockets.get(id);
    if (s && s.user && s.user.id === hostId) return id;
  }
  return null;
}

function notifyViewers(io, sessionId) {
  io.to(sessionId).emit('live_viewers_changed');
}

function emitToHost(io, sessionId, hostId, event, payload) {
  for (const id of io.sockets.adapter.rooms.get(sessionId) || []) {
    const s = io.sockets.sockets.get(id);
    if (s && s.user && s.user.id === hostId) s.emit(event, payload);
  }
}

function removeStageGuest(io, sessionId, socketId) {
  const pending = pendingGuests.get(sessionId);
  if (pending && pending.delete(socketId)) {
    if (!pending.size) pendingGuests.delete(sessionId);
    io.to(sessionId).emit('live_guest_request_cancel', { socketId });
  }
  const guests = stageGuests.get(sessionId);
  if (!guests || !guests.delete(socketId)) return;
  stageGuestInfo.delete(socketId);
  if (!guests.size) stageGuests.delete(sessionId);
  io.to(sessionId).emit('live_guest_count', { count: guests.size, max: MAX_LIVE_GUESTS });
  io.to(sessionId).emit('live_stage_guest_left', { socketId });
}

let presenceRestored = false;

// After a server restart nobody is in a live room yet; give hosts of active streams the same
// reconnect grace so their streams stay visible until the host's client rejoins.
async function restoreLivePresence(io) {
  if (presenceRestored) return;
  presenceRestored = true;
  try {
    const active = await db.query('SELECT id, host_id FROM live_sessions WHERE is_active = TRUE');
    for (const { id, host_id: hostId } of active.rows) {
      const sessionId = String(id);
      if (hostDisconnectTimers.has(sessionId)) continue;
      const timer = setTimeout(async () => {
        hostDisconnectTimers.delete(sessionId);
        try {
          const ended = await db.query(
            'UPDATE live_sessions SET is_active = FALSE WHERE id = $1 AND host_id = $2 AND is_active = TRUE RETURNING id',
            [sessionId, hostId]
          );
          if (ended.rows.length) io.to(sessionId).emit('live_stream_ended');
        } catch (err) {
          console.error('Live restore cleanup error:', err);
        }
      }, HOST_RECONNECT_GRACE_MS);
      timer.unref();
      hostDisconnectTimers.set(sessionId, timer);
    }
  } catch (err) {
    console.error('Live presence restore error:', err);
  }
}

function registerLiveHandlers(io, socket) {
  restoreLivePresence(io);
  // Guest asks to join the stage; the host must approve.
  socket.on('live_guest_join', async (acknowledge) => {
    const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
    const sessionId = socket.sessionId;
    if (!sessionId || !socket.user) {
      respond({ ok: false, error: 'Log in and join a livestream first.' });
      return;
    }
    try {
      const session = await db.query(
        'SELECT host_id FROM live_sessions WHERE id = $1 AND is_active = TRUE',
        [sessionId]
      );
      if (!session.rows.length) {
        respond({ ok: false, error: 'This livestream is no longer active.' });
        return;
      }
      const hostId = session.rows[0].host_id;
      const guests = stageGuests.get(sessionId) || new Set();
      if (hostId === socket.user.id || guests.has(socket.id)) {
        respond({ ok: true, approved: true });
        return;
      }
      if (guests.size >= MAX_LIVE_GUESTS) {
        respond({ ok: false, error: `The stage is full (${MAX_LIVE_GUESTS} guests maximum).` });
        return;
      }
      const pending = pendingGuests.get(sessionId) || new Map();
      pendingGuests.set(sessionId, pending);
      const profile = await db.query('SELECT display_name, username, avatar_url FROM users WHERE id = $1', [socket.user.id]);
      const name = profile.rows[0]?.display_name || profile.rows[0]?.username || 'A viewer';
      const request = { socketId: socket.id, name, avatar_url: profile.rows[0]?.avatar_url || null };
      pending.set(socket.id, request);
      emitToHost(io, sessionId, hostId, 'live_guest_request', request);
      respond({ ok: true, approved: false });
    } catch (err) {
      console.error('Guest join error:', err);
      respond({ ok: false, error: 'Unable to request to join the stage.' });
    }
  });

  socket.on('live_guest_decision', async (data) => {
    const sessionId = socket.sessionId;
    const target = io.sockets.sockets.get(data && data.socketId);
    const pending = pendingGuests.get(sessionId);
    if (!sessionId || !socket.user || !target || !pending || !pending.has(target.id)) return;
    try {
      const session = await db.query(
        'SELECT 1 FROM live_sessions WHERE id = $1 AND host_id = $2 AND is_active = TRUE',
        [sessionId, socket.user.id]
      );
      if (!session.rows.length) return;
      pending.delete(target.id);
      if (!pending.size) pendingGuests.delete(sessionId);
      if (!data.accept) {
        target.emit('live_guest_denied', { reason: 'The host declined your request.' });
        return;
      }
      const guests = stageGuests.get(sessionId) || new Set();
      if (guests.size >= MAX_LIVE_GUESTS) {
        target.emit('live_guest_denied', { reason: `The stage is full (${MAX_LIVE_GUESTS} guests maximum).` });
        return;
      }
      guests.add(target.id);
      stageGuests.set(sessionId, guests);
      io.to(sessionId).emit('live_guest_count', { count: guests.size, max: MAX_LIVE_GUESTS });
      target.emit('live_guest_approved');
      const guestProfile = await db.query('SELECT display_name, username, avatar_url FROM users WHERE id = $1', [target.user.id]);
      const guestName = guestProfile.rows[0]?.display_name || guestProfile.rows[0]?.username || 'Guest';
      const info = { socketId: target.id, name: guestName, avatar_url: guestProfile.rows[0]?.avatar_url || null };
      stageGuestInfo.set(target.id, info);
      io.to(sessionId).emit('live_stage_guest_info', info);
      io.to(sessionId).emit('live_guest_joined', { socketId: target.id, name: guestName });
      emitToHost(io, sessionId, socket.user.id, 'live_stage_guest', { socketId: target.id, name: guestName });
    } catch (err) {
      console.error('Guest decision error:', err);
    }
  });

  // Host mutes/unmutes a guest on stage; guests can also toggle their own mute.
  socket.on('live_mute_guest', async (data) => {
    const sessionId = socket.sessionId;
    const target = io.sockets.sockets.get(data && data.socketId);
    const guests = stageGuests.get(sessionId);
    if (!sessionId || !socket.user || !target || !guests || !guests.has(target.id)) return;
    try {
      const session = await db.query(
        'SELECT 1 FROM live_sessions WHERE id = $1 AND host_id = $2 AND is_active = TRUE',
        [sessionId, socket.user.id]
      );
      if (!session.rows.length) return;
      const muted = Boolean(data.muted);
      target.emit('live_force_mute', { muted });
      emitToHost(io, sessionId, socket.user.id, 'live_mute_state', { socketId: target.id, muted });
    } catch (err) {
      console.error('Mute guest error:', err);
    }
  });

  socket.on('live_self_mute', async (data) => {
    const sessionId = socket.sessionId;
    const guests = stageGuests.get(sessionId);
    if (!sessionId || !socket.user || !guests || !guests.has(socket.id)) return;
    try {
      const session = await db.query('SELECT host_id FROM live_sessions WHERE id = $1 AND is_active = TRUE', [sessionId]);
      if (!session.rows.length) return;
      emitToHost(io, sessionId, session.rows[0].host_id, 'live_mute_state', { socketId: socket.id, muted: Boolean(data && data.muted) });
    } catch (err) {
      console.error('Self mute error:', err);
    }
  });

  socket.on('live_guest_leave', () => {
    if (socket.sessionId) removeStageGuest(io, socket.sessionId, socket.id);
  });

  // Host picks how camera tiles are arranged; everyone in the room follows it.
  socket.on('live_set_layout', async (layout) => {
    const sessionId = socket.sessionId;
    if (!sessionId || !socket.user || !LAYOUTS.includes(layout)) return;
    try {
      const session = await db.query(
        'SELECT host_id FROM live_sessions WHERE id = $1 AND host_id = $2 AND is_active = TRUE',
        [sessionId, socket.user.id]
      );
      if (!session.rows.length) return;
      sessionLayouts.set(sessionId, layout);
      io.to(sessionId).emit('live_layout', { layout, hostSocketId: findHostSocketId(io, sessionId, socket.user.id) });
    } catch (err) {
      console.error('Set layout error:', err);
    }
  });

  socket.on('live_viewers', async (acknowledge) => {
    const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
    const sessionId = socket.sessionId;
    if (!sessionId) return respond({ ok: false, viewers: [], total: 0 });
    try {
      const ids = new Set();
      let total = 0;
      for (const id of io.sockets.adapter.rooms.get(sessionId) || []) {
        total += 1;
        const s = io.sockets.sockets.get(id);
        if (s && s.user && s.user.id) ids.add(s.user.id);
      }
      const users = ids.size
        ? await db.query(
          'SELECT id, username, display_name, avatar_url FROM users WHERE id = ANY($1::uuid[])',
          [Array.from(ids)]
        )
        : { rows: [] };
      respond({ ok: true, viewers: users.rows, total });
    } catch (err) {
      console.error('Viewers list error:', err);
      respond({ ok: false, viewers: [], total: 0 });
    }
  });
  socket.on('join_live_room', async (sessionId, acknowledge) => {
    const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (typeof sessionId !== 'string' || !sessionId) {
      respond({ ok: false, error: 'Invalid livestream.' });
      return;
    }

    try {
      if (socket.sessionId === sessionId) {
        respond({ ok: true, messages: [] });
        return;
      }

      socket.liveJoinOrder = ++liveJoinSequence;

      if (socket.sessionId) {
        const previousSessionId = socket.sessionId;
        socket.leave(previousSessionId);
        socket.sessionId = null;
        removeStageGuest(io, previousSessionId, socket.id);
        await db.query(
          'UPDATE live_sessions SET viewer_count = GREATEST(0, viewer_count - 1) WHERE id = $1',
          [previousSessionId]
        );
        socket.to(previousSessionId).emit('viewer_left', { socketId: socket.id });
      }

      const result = await db.query(
        `UPDATE live_sessions
         SET viewer_count = viewer_count + 1
         WHERE id = $1 AND is_active = TRUE
         RETURNING host_id, chat_background_color, chat_font_color, chat_font_size`,
        [sessionId]
      );
      if (!result.rows.length) {
        respond({ ok: false, error: 'This livestream is no longer active.' });
        return;
      }

      if (socket.user && socket.user.id === result.rows[0].host_id) {
        const reconnectTimer = hostDisconnectTimers.get(sessionId);
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          hostDisconnectTimers.delete(sessionId);
        }
      }

      socket.join(sessionId);
      socket.sessionId = sessionId;
      const history = await db.query(
        `SELECT messages.id, messages.content, messages.created_at,
                COALESCE(users.display_name, users.username, messages.guest_username, 'Guest') AS username,
                users.avatar_url
         FROM (
           SELECT id, user_id, guest_username, content, created_at
           FROM live_chat_messages
           WHERE live_session_id = $1
           ORDER BY created_at DESC
           LIMIT 50
         ) AS messages
         LEFT JOIN users ON users.id = messages.user_id
         ORDER BY messages.created_at ASC`,
        [sessionId]
      );
      socket.emit('live_chat_style', {
        backgroundColor: result.rows[0].chat_background_color,
        fontColor: result.rows[0].chat_font_color,
        fontSize: result.rows[0].chat_font_size
      });
      const hostId = result.rows[0].host_id;
      const hostSocketId = findHostSocketId(io, sessionId, hostId);
      const layout = sessionLayouts.get(sessionId) || 'auto';
      respond({ ok: true, messages: history.rows, layout, hostSocketId });
      for (const guestSocketId of stageGuests.get(sessionId) || []) {
        const info = stageGuestInfo.get(guestSocketId);
        if (info) socket.emit('live_stage_guest_info', info);
      }
      if (socket.user && socket.user.id === hostId) {
        for (const request of (pendingGuests.get(sessionId) || new Map()).values()) {
          if (request && request.socketId) socket.emit('live_guest_request', request);
        }
        io.to(sessionId).emit('live_layout', { layout, hostSocketId });
      }
      notifyViewers(io, sessionId);
      const roomSocketIds = io.sockets.adapter.rooms.get(sessionId) || new Set();
      for (const memberId of roomSocketIds) {
        if (memberId === socket.id) continue;
        const memberSocket = io.sockets.sockets.get(memberId);
        if (memberSocket && memberSocket.liveJoinOrder < socket.liveJoinOrder) {
          io.to(memberId).emit('viewer_joined', { socketId: socket.id });
        }
      }
    } catch (err) {
      console.error('Join live room error:', err);
      respond({ ok: false, error: 'Unable to join this livestream.' });
      socket.emit('live_chat_error', { error: 'Unable to join this livestream.' });
    }
  });

  socket.on('update_live_chat_style', async (data) => {
    try {
      const { sessionId, backgroundColor, fontColor, fontSize } = data || {};
      if (
        !socket.user ||
        socket.sessionId !== sessionId ||
        !/^#[0-9a-f]{6}$/i.test(backgroundColor || '') ||
        !/^#[0-9a-f]{6}$/i.test(fontColor || '') ||
        !Number.isInteger(fontSize) ||
        fontSize < 12 ||
        fontSize > 24
      ) {
        socket.emit('live_chat_error', { error: 'Only the host can change chat appearance.' });
        return;
      }

      const result = await db.query(
        `UPDATE live_sessions
         SET chat_background_color = $1, chat_font_color = $2, chat_font_size = $3
         WHERE id = $4 AND host_id = $5 AND is_active = TRUE`,
        [backgroundColor, fontColor, fontSize, sessionId, socket.user.id]
      );
      if (!result.rowCount) {
        socket.emit('live_chat_error', { error: 'Only the host can change chat appearance.' });
        return;
      }

      io.to(sessionId).emit('live_chat_style', { backgroundColor, fontColor, fontSize });
    } catch (err) {
      console.error('Update live chat style error:', err);
      socket.emit('live_chat_error', { error: 'Unable to update chat appearance.' });
    }
  });

  socket.on('leave_live_room', async (sessionId, acknowledge) => {
    const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (socket.sessionId !== sessionId) {
      respond({ ok: true });
      return;
    }

    socket.leave(sessionId);
    socket.sessionId = null;
    removeStageGuest(io, sessionId, socket.id);
    try {
      await db.query(
        'UPDATE live_sessions SET viewer_count = GREATEST(0, viewer_count - 1) WHERE id = $1',
        [sessionId]
      );
      if (socket.user) {
        const endedByHost = await db.query(
          'SELECT 1 FROM live_sessions WHERE id = $1 AND host_id = $2 AND is_active = FALSE',
          [sessionId, socket.user.id]
        );
        if (endedByHost.rows.length) {
          io.to(sessionId).emit('live_stream_ended');
        }
      }
      respond({ ok: true });
    } catch (err) {
      console.error('Leave live room error:', err);
      respond({ ok: false });
    }
    socket.to(sessionId).emit('viewer_left', { socketId: socket.id });
    notifyViewers(io, sessionId);
  });

  // WebRTC Signaling
  socket.on('webrtc_offer', (data) => {
    const target = io.sockets.sockets.get(data && data.targetSocketId);
    if (!socket.sessionId || !target || target.sessionId !== socket.sessionId) return;
    target.emit('webrtc_offer', {
      offer: data.offer,
      senderSocketId: socket.id
    });
  });

  socket.on('webrtc_answer', (data) => {
    const target = io.sockets.sockets.get(data && data.targetSocketId);
    if (!socket.sessionId || !target || target.sessionId !== socket.sessionId) return;
    target.emit('webrtc_answer', {
      answer: data.answer,
      senderSocketId: socket.id
    });
  });

  socket.on('ice_candidate', (data) => {
    const target = io.sockets.sockets.get(data && data.targetSocketId);
    if (!socket.sessionId || !target || target.sessionId !== socket.sessionId) return;
    target.emit('ice_candidate', {
      candidate: data.candidate,
      senderSocketId: socket.id
    });
  });

  // Live Chat Messaging
  socket.on('live_chat_message', async (data, acknowledge) => {
    const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
    try {
      const { sessionId, content, username: requestedUsername } = data || {};
      if (!sessionId || typeof content !== 'string') {
        respond({ ok: false, error: 'Message is invalid.' });
        return;
      }
      if (socket.sessionId !== sessionId) {
        respond({ ok: false, error: 'Join this live chat before sending messages.' });
        return;
      }

      const trimmedContent = content.trim();
      const guestUsername = typeof requestedUsername === 'string'
        ? requestedUsername.trim().slice(0, 24)
        : '';
      if (!trimmedContent || trimmedContent.length > 500) {
        respond({ ok: false, error: 'Messages must be between 1 and 500 characters.' });
        return;
      }

      const activeSession = await db.query(
        'SELECT 1 FROM live_sessions WHERE id = $1 AND is_active = TRUE',
        [sessionId]
      );
      if (activeSession.rows.length === 0) {
        respond({ ok: false, error: 'This livestream is no longer active.' });
        return;
      }

      let username = guestUsername || 'Guest';
      let senderId = null;
      let avatarUrl = null;
      if (socket.user) {
        const userResult = await db.query(
          'SELECT id, username, display_name, avatar_url FROM users WHERE id = $1',
          [socket.user.id]
        );
        if (userResult.rows.length === 0) {
          respond({ ok: false, error: 'Unable to verify your account.' });
          return;
        }
        senderId = userResult.rows[0].id;
        avatarUrl = userResult.rows[0].avatar_url;
        username = userResult.rows[0].display_name || userResult.rows[0].username;
      }

      const insertQuery = `
        INSERT INTO live_chat_messages (live_session_id, user_id, guest_username, content)
        VALUES ($1, $2, $3, $4)
        RETURNING id, content, created_at
      `;
      const result = await db.query(insertQuery, [sessionId, senderId, senderId ? null : username, trimmedContent]);
      const payload = {
        ...result.rows[0],
        username,
        avatar_url: avatarUrl
      };

      io.to(sessionId).emit('live_chat_message', payload);
      respond({ ok: true });
    } catch (err) {
      console.error('Live chat error:', err);
      respond({ ok: false, error: 'Message could not be sent. Please try again.' });
    }
  });

  socket.on('disconnect', async () => {
    const sessionId = socket.sessionId;
    if (!sessionId) return;
    removeStageGuest(io, sessionId, socket.id);

    try {
      const result = await db.query(
        `UPDATE live_sessions
         SET viewer_count = GREATEST(0, viewer_count - 1)
         WHERE id = $1 AND is_active = TRUE
         RETURNING host_id`,
        [sessionId]
      );
      if (!result.rows.length) return;

      io.to(sessionId).emit('viewer_left', { socketId: socket.id });
      notifyViewers(io, sessionId);

      const hostId = result.rows[0].host_id;
      if (!socket.user || socket.user.id !== hostId) return;

      const roomSocketIds = io.sockets.adapter.rooms.get(sessionId) || new Set();
      const hostStillConnected = Array.from(roomSocketIds).some((socketId) => {
        const roomSocket = io.sockets.sockets.get(socketId);
        return roomSocket && roomSocket.user && roomSocket.user.id === hostId;
      });
      if (hostStillConnected) return;

      const existingTimer = hostDisconnectTimers.get(sessionId);
      if (existingTimer) clearTimeout(existingTimer);

      const reconnectTimer = setTimeout(async () => {
        hostDisconnectTimers.delete(sessionId);
        try {
          const ended = await db.query(
            `UPDATE live_sessions
             SET is_active = FALSE
             WHERE id = $1 AND host_id = $2 AND is_active = TRUE
             RETURNING id`,
            [sessionId, hostId]
          );
          if (ended.rows.length) io.to(sessionId).emit('live_stream_ended');
        } catch (err) {
          console.error('Live disconnect cleanup error:', err);
        }
      }, HOST_RECONNECT_GRACE_MS);
      reconnectTimer.unref();
      hostDisconnectTimers.set(sessionId, reconnectTimer);
    } catch (err) {
      console.error('Live disconnect cleanup error:', err);
    }
  });
}

module.exports = { registerLiveHandlers, restoreLivePresence };
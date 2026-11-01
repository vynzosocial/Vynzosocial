const crypto = require('crypto');
const db = require('../database/db');

// callId -> { callerId, calleeId, conversationId, video, accepted }
const activeCalls = new Map();

const userRoom = (userId) => `user:${userId}`;

function findCallForUser(userId) {
  for (const [callId, call] of activeCalls) {
    if (call.callerId === userId || call.calleeId === userId) return { callId, call };
  }
  return null;
}

function registerCallHandlers(io, socket) {
  if (socket.user) socket.join(userRoom(socket.user.id));

  const respondTo = (acknowledge) => (typeof acknowledge === 'function' ? acknowledge : () => {});

  socket.on('call_invite', async (data, acknowledge) => {
    const respond = respondTo(acknowledge);
    if (!socket.user) return respond({ ok: false, error: 'Please log in to make calls.' });

    const conversationId = data && data.conversationId;
    const video = Boolean(data && data.video);
    if (typeof conversationId !== 'string' || !conversationId) {
      return respond({ ok: false, error: 'Invalid conversation.' });
    }

    try {
      const members = await db.query(
        `SELECT cm.user_id, c.is_group
         FROM conversation_members cm
         JOIN conversations c ON c.id = cm.conversation_id
         WHERE cm.conversation_id = $1`,
        [conversationId]
      );
      const callerId = socket.user.id;
      const isMember = members.rows.some((row) => row.user_id === callerId);
      if (!isMember || members.rows.length !== 2 || members.rows[0].is_group) {
        return respond({ ok: false, error: 'Calls are only available in one-to-one chats.' });
      }
      const calleeId = members.rows.find((row) => row.user_id !== callerId).user_id;

      const friends = await db.query(
        `SELECT 1 FROM follows a
         JOIN follows b ON b.follower_id = a.following_id AND b.following_id = a.follower_id AND b.status = 'accepted'
         WHERE a.follower_id = $1 AND a.following_id = $2 AND a.status = 'accepted'`,
        [callerId, calleeId]
      );
      if (!friends.rows.length) {
        return respond({ ok: false, error: 'You can only call friends who follow you back.' });
      }

      const prefs = await db.query(
        'SELECT id, COALESCE(allow_calls, TRUE) AS allow_calls FROM users WHERE id = ANY($1::uuid[])',
        [[callerId, calleeId]]
      );
      const callerAllows = prefs.rows.find((row) => row.id === callerId)?.allow_calls !== false;
      const calleeAllows = prefs.rows.find((row) => row.id === calleeId)?.allow_calls !== false;
      if (!callerAllows) {
        return respond({ ok: false, error: 'Calls are turned off in your settings.' });
      }
      if (!calleeAllows) {
        return respond({ ok: false, error: 'This person does not accept calls.' });
      }

      if (findCallForUser(callerId)) return respond({ ok: false, error: 'You are already in a call.' });
      if (findCallForUser(calleeId)) return respond({ ok: false, error: 'This person is busy on another call.' });

      const calleeSockets = io.sockets.adapter.rooms.get(userRoom(calleeId));
      if (!calleeSockets || !calleeSockets.size) {
        return respond({ ok: false, error: 'This person is offline right now.' });
      }

      const caller = await db.query(
        'SELECT id, username, display_name, avatar_url FROM users WHERE id = $1',
        [callerId]
      );
      const callId = crypto.randomUUID();
      activeCalls.set(callId, { callerId, calleeId, conversationId, video, accepted: false });

      io.to(userRoom(calleeId)).emit('call_incoming', {
        callId,
        conversationId,
        video,
        from: caller.rows[0]
      });
      respond({ ok: true, callId });

      // Stop ringing if nobody answers.
      setTimeout(() => {
        const call = activeCalls.get(callId);
        if (call && !call.accepted) {
          activeCalls.delete(callId);
          io.to(userRoom(callerId)).emit('call_ended', { callId, reason: 'no_answer' });
          io.to(userRoom(calleeId)).emit('call_ended', { callId, reason: 'missed' });
        }
      }, 45000);
    } catch (err) {
      console.error('Call invite error:', err);
      respond({ ok: false, error: 'Could not start the call.' });
    }
  });

  socket.on('call_accept', (data) => {
    const call = socket.user && data && activeCalls.get(data.callId);
    if (!call || call.calleeId !== socket.user.id || call.accepted) return;
    call.accepted = true;
    io.to(userRoom(call.callerId)).emit('call_accepted', { callId: data.callId });
    // Other devices of the callee stop ringing.
    socket.to(userRoom(call.calleeId)).emit('call_ended', { callId: data.callId, reason: 'answered_elsewhere' });
  });

  socket.on('call_end', (data) => {
    const call = socket.user && data && activeCalls.get(data.callId);
    if (!call) return;
    const userId = socket.user.id;
    if (call.callerId !== userId && call.calleeId !== userId) return;

    activeCalls.delete(data.callId);
    const otherId = call.callerId === userId ? call.calleeId : call.callerId;
    const reason = !call.accepted && call.calleeId === userId ? 'declined' : 'ended';
    io.to(userRoom(otherId)).emit('call_ended', { callId: data.callId, reason });
    socket.to(userRoom(userId)).emit('call_ended', { callId: data.callId, reason: 'ended' });
  });

  socket.on('call_signal', (data) => {
    const call = socket.user && data && activeCalls.get(data.callId);
    if (!call || !call.accepted) return;
    const userId = socket.user.id;
    if (call.callerId !== userId && call.calleeId !== userId) return;
    const otherId = call.callerId === userId ? call.calleeId : call.callerId;
    io.to(userRoom(otherId)).emit('call_signal', { callId: data.callId, signal: data.signal });
  });

  socket.on('disconnect', () => {
    if (!socket.user) return;
    const userId = socket.user.id;
    const remaining = io.sockets.adapter.rooms.get(userRoom(userId));
    if (remaining && remaining.size) return;

    const entry = findCallForUser(userId);
    if (!entry) return;
    activeCalls.delete(entry.callId);
    const otherId = entry.call.callerId === userId ? entry.call.calleeId : entry.call.callerId;
    io.to(userRoom(otherId)).emit('call_ended', { callId: entry.callId, reason: 'ended' });
  });
}

module.exports = { registerCallHandlers };

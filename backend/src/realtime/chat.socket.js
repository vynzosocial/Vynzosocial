const db = require('../database/db');

function registerChatHandlers(socket) {
  socket.on('join_conversation', async (conversationId, acknowledge) => {
    const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!socket.user || typeof conversationId !== 'string' || !conversationId) {
      respond({ ok: false, error: 'Authentication required to join this conversation.' });
      return;
    }

    try {
      const membership = await db.query(
        'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, socket.user.id]
      );
      if (!membership.rows.length) {
        respond({ ok: false, error: 'Access denied to this conversation.' });
        return;
      }

      socket.join(conversationId);
      respond({ ok: true });
    } catch (err) {
      console.error('Join conversation error:', err);
      respond({ ok: false, error: 'Could not join this conversation.' });
    }
  });

  socket.on('typing', (data) => {
    if (!socket.user || !data || !socket.rooms.has(data.conversationId)) return;
    socket.to(data.conversationId).emit('user_typing', { username: socket.user.username });
  });
}

module.exports = { registerChatHandlers };
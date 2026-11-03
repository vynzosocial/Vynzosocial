const db = require('../database/db');

const SYSTEM_USERNAME = 'vynzo_team';

// Official sender for moderation notices. Created on first use and cannot log in.
async function getSystemUserId() {
  const found = await db.query('SELECT id FROM users WHERE username = $1', [SYSTEM_USERNAME]);
  if (found.rows[0]) return found.rows[0].id;
  const created = await db.query(
    `INSERT INTO users (username, email, display_name)
     VALUES ($1, $2, 'Vynzo Team')
     ON CONFLICT (username) DO UPDATE SET display_name = users.display_name
     RETURNING id`,
    [SYSTEM_USERNAME, 'team@vynzo.invalid']
  );
  return created.rows[0].id;
}

// Sends a direct message from the Vynzo Team account, ignoring the recipient's message privacy.
async function notifyUser(io, toUserId, content) {
  const systemId = await getSystemUserId();
  if (systemId === toUserId) return null;

  const existing = await db.query(
    `SELECT c.id FROM conversations c
     JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = $1
     JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = $2
     WHERE c.is_group = FALSE LIMIT 1`,
    [systemId, toUserId]
  );
  let conversationId = existing.rows[0]?.id;
  if (!conversationId) {
    conversationId = (await db.query('INSERT INTO conversations (is_group) VALUES (FALSE) RETURNING id')).rows[0].id;
    await db.query('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)', [conversationId, systemId, toUserId]);
  }
  const inserted = await db.query(
    `WITH m AS (
       INSERT INTO messages (conversation_id, sender_id, content) VALUES ($1, $2, $3)
       RETURNING id, conversation_id, sender_id, content, media_url, created_at
     )
     SELECT m.*, u.username, u.display_name, u.avatar_url FROM m JOIN users u ON u.id = m.sender_id`,
    [conversationId, systemId, content]
  );
  if (io) io.to(conversationId).emit('receive_message', inserted.rows[0]);
  return inserted.rows[0];
}

module.exports = { notifyUser, getSystemUserId };

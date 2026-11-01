const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const { privateUploadDir } = require('../config/multer.config');
const { messageBlockReason } = require('../utils/privacy');

// Get all conversations for the logged-in user
async function getUserConversations(req, res) {
  try {
    const userId = req.user.id;
    const query = `
      SELECT 
        c.id, 
        c.is_group, 
        c.group_name, 
        c.group_avatar,
        c.created_at,
        peer.username AS other_username,
        peer.display_name AS other_display_name,
        peer.avatar_url AS other_avatar_url,
        latest_message.last_message
      FROM conversations c
      JOIN conversation_members cm ON c.id = cm.conversation_id
      LEFT JOIN LATERAL (
        SELECT json_build_object(
            'id', m.id,
            'content', m.content,
            'media_url', m.media_url,
            'view_once', m.view_once,
            'sender_id', m.sender_id,
            'created_at', m.created_at
          ) AS last_message,
          m.created_at AS last_message_at
        FROM messages m
        WHERE m.conversation_id = c.id
          AND m.created_at > COALESCE(cm.cleared_at, '-infinity'::timestamptz)
        ORDER BY m.created_at DESC
        LIMIT 1
      ) latest_message ON TRUE
      LEFT JOIN LATERAL (
        SELECT u.username, u.display_name, u.avatar_url
        FROM conversation_members other_member
        JOIN users u ON u.id = other_member.user_id
        WHERE other_member.conversation_id = c.id
          AND other_member.user_id <> $1
        ORDER BY other_member.joined_at
        LIMIT 1
      ) peer ON TRUE
      WHERE cm.user_id = $1
      ORDER BY latest_message.last_message_at DESC NULLS LAST, c.created_at DESC
    `;
    const result = await db.query(query, [userId]);
    res.json({ conversations: result.rows });
  } catch (err) {
    console.error('Get conversations error:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
}

// Get messages for a specific conversation
async function getConversationMessages(req, res) {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;

    // Verify membership
    const memberCheck = await db.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this conversation' });
    }

    // `seen` honours both people's read-receipt settings; `can_unsend` uses real reads only.
    const query = `
      SELECT 
        m.id, m.conversation_id, m.sender_id, m.content,         m.media_url, m.created_at, m.view_once, m.viewed_at,
        u.username AS sender_username, u.display_name AS sender_display_name, u.avatar_url AS sender_avatar_url,
        (m.sender_id = $2 AND viewer.read_receipts AND EXISTS (
          SELECT 1 FROM conversation_members r
          JOIN users ru ON ru.id = r.user_id
          WHERE r.conversation_id = m.conversation_id AND r.user_id <> m.sender_id
            AND ru.read_receipts AND r.last_read_at >= m.created_at
        )) AS seen,
        (m.sender_id = $2 AND NOT EXISTS (
          SELECT 1 FROM conversation_members r
          WHERE r.conversation_id = m.conversation_id AND r.user_id <> m.sender_id
            AND r.last_read_at >= m.created_at
        )) AS can_unsend
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      JOIN users viewer ON viewer.id = $2
      WHERE m.conversation_id = $1
        AND m.created_at > COALESCE(
          (SELECT cleared_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2),
          '-infinity'::timestamptz)
      ORDER BY m.created_at ASC
    `;
    const result = await db.query(query, [conversationId, userId]);
    const prefs = await db.query('SELECT read_receipts FROM users WHERE id = $1', [userId]);
    res.json({ messages: result.rows, read_receipts: prefs.rows[0]?.read_receipts !== false });
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
}

async function sendConversationMessage(req, res) {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const body = req.body || {};
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const mediaUrl = req.file ? `/uploads/${req.file.filename}` : null;

    if (!content && !mediaUrl) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const memberCheck = await db.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this conversation' });
    }

    const others = await db.query(
      `SELECT cm.user_id FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
       WHERE cm.conversation_id = $1 AND cm.user_id <> $2 AND c.is_group = FALSE`,
      [conversationId, userId]
    );
    for (const other of others.rows) {
      const reason = await messageBlockReason(userId, other.user_id);
      if (reason) return res.status(403).json({ error: reason });
    }

    const result = await db.query(
      `WITH inserted_message AS (
         INSERT INTO messages (conversation_id, sender_id, content, media_url)
         VALUES ($1, $2, $3, $4)
         RETURNING id, conversation_id, sender_id, content, media_url, created_at
       )
       SELECT inserted_message.*,
              users.username,
              users.display_name,
              users.avatar_url
       FROM inserted_message
       JOIN users ON users.id = inserted_message.sender_id`,
      [conversationId, userId, content, mediaUrl]
    );
    const message = result.rows[0];

    req.app.get('io').to(conversationId).emit('receive_message', message);
    res.status(201).json({ message: { ...message, seen: false, can_unsend: true } });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
}

async function sendViewOncePhoto(req, res) {
  const discard = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'Choose a photo to send' });

    const memberCheck = await db.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );
    if (!memberCheck.rows.length) {
      discard();
      return res.status(403).json({ error: 'Access denied to this conversation' });
    }
    const others = await db.query(
      `SELECT cm.user_id FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
       WHERE cm.conversation_id = $1 AND cm.user_id <> $2 AND c.is_group = FALSE`,
      [conversationId, userId]
    );
    for (const other of others.rows) {
      const reason = await messageBlockReason(userId, other.user_id);
      if (reason) {
        discard();
        return res.status(403).json({ error: reason });
      }
    }

    const result = await db.query(
      `WITH inserted_message AS (
         INSERT INTO messages (conversation_id, sender_id, content, view_once, view_once_path)
         VALUES ($1, $2, '', TRUE, $3)
         RETURNING id, conversation_id, sender_id, content, media_url, view_once, viewed_at, created_at
       )
       SELECT inserted_message.*, users.username, users.display_name, users.avatar_url
       FROM inserted_message JOIN users ON users.id = inserted_message.sender_id`,
      [conversationId, userId, req.file.filename]
    );
    const message = result.rows[0];
    req.app.get('io').to(conversationId).emit('receive_message', message);
    res.status(201).json({ message: { ...message, seen: false, can_unsend: false } });
  } catch (err) {
    discard();
    console.error('Send view-once photo error:', err);
    res.status(500).json({ error: 'Failed to send photo' });
  }
}

// Atomically claims the photo for the recipient, streams it once, then deletes the file.
async function openViewOncePhoto(req, res) {
  try {
    const userId = req.user.id;
    const { conversationId, messageId } = req.params;
    const claimed = await db.query(
      `UPDATE messages m SET viewed_at = CURRENT_TIMESTAMP
       WHERE m.id = $1 AND m.conversation_id = $2 AND m.view_once = TRUE
         AND m.viewed_at IS NULL AND m.sender_id <> $3
         AND EXISTS (SELECT 1 FROM conversation_members cm
                     WHERE cm.conversation_id = m.conversation_id AND cm.user_id = $3)
       RETURNING m.view_once_path, m.viewed_at`,
      [messageId, conversationId, userId]
    );
    if (!claimed.rows.length) {
      return res.status(410).json({ error: 'This photo is no longer available.' });
    }
    const { view_once_path: name, viewed_at: viewedAt } = claimed.rows[0];
    const filePath = path.join(privateUploadDir, path.basename(name || ''));
    let data;
    try {
      data = await fs.promises.readFile(filePath);
    } catch (e) {
      return res.status(410).json({ error: 'This photo is no longer available.' });
    }
    await db.query('UPDATE messages SET view_once_path = NULL WHERE id = $1', [messageId]);
    fs.unlink(filePath, () => {});

    req.app.get('io').to(conversationId).emit('view_once_opened', {
      conversation_id: conversationId,
      message_id: messageId,
      viewed_at: viewedAt
    });
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
    res.set({
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.send(data);
  } catch (err) {
    console.error('Open view-once photo error:', err);
    res.status(500).json({ error: 'Failed to open photo' });
  }
}

async function deleteConversationMessage(req, res) {
  try {
    const userId = req.user.id;
    const { conversationId, messageId } = req.params;

    const memberCheck = await db.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this conversation' });
    }

    const result = await db.query(
      `DELETE FROM messages m
       WHERE m.id = $1 AND m.conversation_id = $2 AND m.sender_id = $3
         AND NOT EXISTS (
           SELECT 1 FROM conversation_members r
           WHERE r.conversation_id = m.conversation_id AND r.user_id <> m.sender_id
             AND r.last_read_at >= m.created_at
         )
       RETURNING m.id, m.conversation_id`,
      [messageId, conversationId, userId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'This message can no longer be deleted because it has already been seen.' });
    }

    req.app.get('io').to(conversationId).emit('message_deleted', {
      conversation_id: conversationId,
      message_id: messageId
    });
    res.json({ messageId });
  } catch (err) {
    console.error('Delete message error:', err);
    res.status(500).json({ error: 'Failed to delete message' });
  }
}

// Hide all current messages from the requesting user only; other members keep their copy.
async function clearConversation(req, res) {
  try {
    const result = await db.query(
      `UPDATE conversation_members SET cleared_at = CURRENT_TIMESTAMP
       WHERE conversation_id = $1 AND user_id = $2
       RETURNING cleared_at`,
      [req.params.conversationId, req.user.id]
    );
    if (!result.rows.length) {
      return res.status(403).json({ error: 'Access denied to this conversation' });
    }
    res.json({ cleared_at: result.rows[0].cleared_at });
  } catch (err) {
    console.error('Clear chat error:', err);
    res.status(500).json({ error: 'Failed to clear chat' });
  }
}

// Record that the requesting user has read the conversation up to now.
async function markConversationRead(req, res) {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const result = await db.query(
      `UPDATE conversation_members SET last_read_at = CURRENT_TIMESTAMP
       WHERE conversation_id = $1 AND user_id = $2
       RETURNING last_read_at`,
      [conversationId, userId]
    );
    if (!result.rows.length) {
      return res.status(403).json({ error: 'Access denied to this conversation' });
    }
    const prefs = await db.query('SELECT read_receipts FROM users WHERE id = $1', [userId]);
    const readAt = result.rows[0].last_read_at;
    req.app.get('io').to(conversationId).emit('messages_read', {
      conversation_id: conversationId,
      reader_id: userId,
      read_at: readAt,
      show_receipt: prefs.rows[0]?.read_receipts !== false
    });
    res.json({ read_at: readAt });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Failed to mark conversation as read' });
  }
}

// Create or get 1-on-1 conversation / Group conversation
async function createConversation(req, res) {
  try {
    const userId = req.user.id;
    const { recipientId, isGroup, groupName, memberIds } = req.body;

    if (isGroup) {
      for (const memberId of [...new Set(memberIds || [])]) {
        const reason = await messageBlockReason(userId, memberId);
        if (reason) return res.status(403).json({ error: reason });
      }
      // Create group chat
      const groupResult = await db.query(
        'INSERT INTO conversations (is_group, group_name) VALUES (TRUE, $1) RETURNING id',
        [groupName || 'New Group']
      );
      const conversationId = groupResult.rows[0].id;

      // Add creator as admin and members
      const allMembers = [...new Set([userId, ...(memberIds || [])])];
      for (const memberId of allMembers) {
        const role = memberId === userId ? 'admin' : 'member';
        await db.query(
          'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3)',
          [conversationId, memberId, role]
        );
      }

      return res.status(201).json({ message: 'Group conversation created', conversationId });
    } else {
      if (!recipientId) {
        return res.status(400).json({ error: 'Recipient ID is required for direct messages' });
      }

      const blockReason = await messageBlockReason(userId, recipientId);
      if (blockReason) {
        return res.status(403).json({ error: blockReason });
      }

      // Check if 1-on-1 conversation already exists
      const existingQuery = `
        SELECT c.id 
        FROM conversations c
        JOIN conversation_members cm1 ON c.id = cm1.conversation_id
        JOIN conversation_members cm2 ON c.id = cm2.conversation_id
        WHERE c.is_group = FALSE AND cm1.user_id = $1 AND cm2.user_id = $2
      `;
      const existing = await db.query(existingQuery, [userId, recipientId]);

      if (existing.rows.length > 0) {
        return res.json({ conversationId: existing.rows[0].id });
      }

      // Create new 1-on-1 conversation
      const newConv = await db.query('INSERT INTO conversations (is_group) VALUES (FALSE) RETURNING id');
      const conversationId = newConv.rows[0].id;

      await db.query('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)', [conversationId, userId]);
      await db.query('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)', [conversationId, recipientId]);

      res.status(201).json({ conversationId });
    }
  } catch (err) {
    console.error('Create conversation error:', err);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
}

module.exports = {
  getUserConversations,
  getConversationMessages,
  sendConversationMessage,
  sendViewOncePhoto,
  openViewOncePhoto,
  deleteConversationMessage,
  clearConversation,
  markConversationRead,
  createConversation
};
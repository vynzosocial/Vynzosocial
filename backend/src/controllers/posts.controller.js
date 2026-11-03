const db = require('../database/db');
const cloudStorage = require('../config/storage');
const { visiblePostSql, canViewPost, STORY_PRIVACY_VALUES } = require('../utils/privacy');

const isTrue = value => value === true || value === 'true' || value === '1' || value === 'on';

// Create a new post with uploaded media
async function createPost(req, res) {
  try {
    const userId = req.user.id;
    const { caption } = req.body;
    const isProtected = isTrue(req.body.protected);
    
    if (!req.file) {
      return res.status(400).json({ error: 'Media file is required' });
    }

    const mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';
    const mediaUrl = `/uploads/${req.file.filename}`;

    const query = `
      INSERT INTO posts (user_id, caption, media_type, media_url, is_protected)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, user_id, caption, media_type, media_url, is_protected, views_count, likes_count, comments_count, created_at
    `;

    const result = await db.query(query, [userId, caption || '', mediaType, mediaUrl, isProtected]);
    const post = result.rows[0];

    res.status(201).json({ message: 'Post created successfully', post });
  } catch (err) {
    console.error('Create post error:', err);
    res.status(500).json({ error: 'Failed to create post' });
  }
}

// Delete one of the caller's own posts (and its stored media file)
async function deletePost(req, res) {
  try {
    const result = await db.query(
      'DELETE FROM posts WHERE id = $1 AND user_id = $2 RETURNING media_url',
      [req.params.postId, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found or you do not own it' });
    }

    try {
      await cloudStorage.deletePublicPath(result.rows[0].media_url);
    } catch (err) {
      console.error('Deleted post media cleanup error:', err);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete post error:', err);
    res.status(500).json({ error: 'Failed to delete post' });
  }
}

// Fetch posts feed (For You / Following) with pagination
async function getFeed(req, res) {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 10;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT 
        p.id,
        p.caption,
        p.media_type,
        p.media_url,
        p.thumbnail_url,
        p.views_count,
        p.likes_count,
        p.comments_count,
        p.created_at,
        p.is_protected,
        p.privacy,
        (p.user_id = $1) AS is_owner,
        u.id AS author_id,
        u.username AS author_username,
        u.display_name AS author_display_name,
        u.avatar_url AS author_avatar_url,
        EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $1) AS is_liked
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE ${visiblePostSql('u', '$1', 'p')} AND ${req.query.scope === 'all'
        ? 'TRUE'
        : req.query.scope === 'me'
          ? 'p.user_id = $1'
          : `p.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1 AND status = 'accepted')`}
      ORDER BY p.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await db.query(query, [userId, limit, offset]);
    res.json({ posts: result.rows, limit, offset });
  } catch (err) {
    console.error('Get feed error:', err);
    res.status(500).json({ error: 'Failed to retrieve feed' });
  }
}

// Toggle Like / Unlike post
async function toggleLike(req, res) {
  try {
    const userId = req.user.id;
    const { postId } = req.params;

    if (!(await canViewPost(userId, postId))) {
      return res.status(403).json({ error: 'This account is private.' });
    }

    const checkLike = await db.query(
      'SELECT 1 FROM likes WHERE user_id = $1 AND post_id = $2',
      [userId, postId]
    );

    if (checkLike.rows.length > 0) {
      // Unlike
      await db.query('DELETE FROM likes WHERE user_id = $1 AND post_id = $2', [userId, postId]);
      await db.query('UPDATE posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = $1', [postId]);
      return res.json({ liked: false, postId });
    } else {
      // Like
      await db.query('INSERT INTO likes (user_id, post_id) VALUES ($1, $2)', [userId, postId]);
      await db.query('UPDATE posts SET likes_count = likes_count + 1 WHERE id = $1', [postId]);
      return res.json({ liked: true, postId });
    }
  } catch (err) {
    console.error('Toggle like error:', err);
    res.status(500).json({ error: 'Failed to update like status' });
  }
}

// Get comments for a post
async function getComments(req, res) {
  try {
    const { postId } = req.params;
    if (!(await canViewPost(req.user.id, postId))) {
      return res.status(403).json({ error: 'This account is private.' });
    }
    const query = `
      SELECT 
        c.id, c.content, c.created_at,
        u.id AS user_id, u.username, u.display_name, u.avatar_url
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.post_id = $1
      ORDER BY c.created_at ASC
    `;
    const result = await db.query(query, [postId]);
    res.json({ comments: result.rows });
  } catch (err) {
    console.error('Get comments error:', err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
}

// Add comment to a post
async function addComment(req, res) {
  try {
    const userId = req.user.id;
    const { postId } = req.params;
    const { content } = req.body;

    if (!(await canViewPost(userId, postId))) {
      return res.status(403).json({ error: 'This account is private.' });
    }

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Comment content cannot be empty' });
    }

    const insertQuery = `
      INSERT INTO comments (post_id, user_id, content)
      VALUES ($1, $2, $3)
      RETURNING id, post_id, user_id, content, created_at
    `;
    const result = await db.query(insertQuery, [postId, userId, content.trim()]);
    await db.query('UPDATE posts SET comments_count = comments_count + 1 WHERE id = $1', [postId]);

    const userQuery = 'SELECT username, display_name, avatar_url FROM users WHERE id = $1';
    const userResult = await db.query(userQuery, [userId]);
    const comment = { ...result.rows[0], ...userResult.rows[0] };

    res.status(201).json({ message: 'Comment added', comment });
  } catch (err) {
    console.error('Add comment error:', err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
}

// Owner changes who can see a post after publishing.
async function updatePostPrivacy(req, res) {
  try {
    const privacy = String(req.body?.privacy || '');
    if (!STORY_PRIVACY_VALUES.includes(privacy)) return res.status(400).json({ error: 'Invalid privacy option' });
    const result = await db.query(
      'UPDATE posts SET privacy = $1 WHERE id = $2 AND user_id = $3 RETURNING id',
      [privacy, req.params.postId, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Post not found' });
    res.json({ success: true, privacy });
  } catch (err) {
    console.error('Update post privacy error:', err);
    res.status(500).json({ error: 'Failed to update post privacy' });
  }
}

module.exports = { updatePostPrivacy, createPost, deletePost, getFeed, toggleLike, getComments, addComment };
const db = require('../database/db');
const fs = require('fs/promises');
const path = require('path');
const { visibleStorySql, STORY_PRIVACY_VALUES, canViewStory } = require('../utils/privacy');
const { scanStory, removeStory } = require('../services/story-moderation');

// Create a new story (expires in 24 hours)
async function createStory(req, res) {
  try {
    const userId = req.user.id;
    if (!req.file) {
      return res.status(400).json({ error: 'Media file is required for a story' });
    }

    const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
    const mediaUrl = `/uploads/${req.file.filename}`;
    const isProtected = ['true', '1', 'on'].includes(String(req.body.protected));

    const query = `
      INSERT INTO stories (user_id, media_type, media_url, is_protected, expires_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '24 hours')
      RETURNING id, user_id, media_type, media_url, is_protected, expires_at, created_at
    `;

    const result = await db.query(query, [userId, mediaType, mediaUrl, isProtected]);
    res.status(201).json({ message: 'Story published successfully', story: result.rows[0] });
    scanStory(req.app.get('io'), result.rows[0]);
  } catch (err) {
    console.error('Create story error:', err);
    res.status(500).json({ error: 'Failed to publish story' });
  }
}

// Administrators can take down any story; the owner is told why in a direct message.
async function moderateRemoveStory(req, res) {
  try {
    const admin = await db.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
    if (!admin.rows[0]?.is_admin) return res.status(403).json({ error: 'Administrator access required' });

    const reason = String(req.body?.reason || '').trim().slice(0, 300) || 'it violates the Vynzo community guidelines';
    const found = await db.query('SELECT id, user_id, media_type, media_url FROM stories WHERE id = $1', [req.params.storyId]);
    const story = found.rows[0];
    if (!story) return res.status(404).json({ error: 'Story not found' });

    await removeStory(req.app.get('io'), story, { reason, actorId: req.user.id, action: 'admin_removed' });
    res.json({ success: true });
  } catch (err) {
    console.error('Admin remove story error:', err);
    res.status(500).json({ error: 'Failed to remove story' });
  }
}

// Owner changes who can watch a story after publishing.
async function updateStoryPrivacy(req, res) {
  try {
    const privacy = String(req.body?.privacy || '');
    if (!STORY_PRIVACY_VALUES.includes(privacy)) return res.status(400).json({ error: 'Invalid privacy option' });
    const result = await db.query(
      'UPDATE stories SET privacy = $1 WHERE id = $2 AND user_id = $3 RETURNING id, privacy',
      [privacy, req.params.storyId, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Story not found' });
    res.json({ success: true, privacy });
  } catch (err) {
    console.error('Update story privacy error:', err);
    res.status(500).json({ error: 'Failed to update story privacy' });
  }
}

// Get active stories (not expired)
async function getStories(req, res) {
  try {
    const viewerId = req.user.id;
    const query = `
      SELECT 
        s.id AS story_id,
        s.media_type,
        s.media_url,
        s.is_protected,
        s.privacy,
        s.created_at,
        s.expires_at,
        u.id AS user_id,
        u.username,
        u.display_name,
        u.avatar_url,
        (SELECT COUNT(*) FROM story_likes sl WHERE sl.story_id = s.id) AS likes_count,
        (SELECT COUNT(*) FROM story_comments sc WHERE sc.story_id = s.id) AS comments_count,
        EXISTS(SELECT 1 FROM story_likes sl WHERE sl.story_id = s.id AND sl.user_id = $1) AS is_liked
      FROM stories s
      JOIN users u ON s.user_id = u.id
      WHERE s.expires_at > CURRENT_TIMESTAMP AND ${visibleStorySql('s', 'u', '$1')} AND ${req.query.scope === 'any'
         ? 'TRUE'
         : req.query.scope === 'all'
               ? 's.user_id <> $1'
               : req.query.scope === 'me'
                 ? 's.user_id = $1'
                 : `s.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1 AND status = 'accepted')`}
      ORDER BY s.created_at ASC
    `;

    const result = await db.query(query, [viewerId]);
    
    // Group stories by user
    const userStoriesMap = {};
    result.rows.forEach(row => {
      if (!userStoriesMap[row.user_id]) {
        userStoriesMap[row.user_id] = {
          user_id: row.user_id,
          username: row.username,
          display_name: row.display_name,
          avatar_url: row.avatar_url,
          stories: []
        };
      }
      userStoriesMap[row.user_id].stories.push({
        id: row.story_id,
        media_type: row.media_type,
        media_url: row.media_url,
        is_protected: row.is_protected,
        privacy: row.privacy || 'everyone',
        created_at: row.created_at,
        expires_at: row.expires_at,
        likes_count: Number(row.likes_count),
        comments_count: Number(row.comments_count),
        is_liked: row.is_liked,
        is_owner: req.user?.id === row.user_id
      });
    });

    const viewer = await db.query('SELECT is_admin FROM users WHERE id = $1', [viewerId]);
    res.json({ usersWithStories: Object.values(userStoriesMap), viewer_is_admin: Boolean(viewer.rows[0]?.is_admin) });
  } catch (err) {
    console.error('Get stories error:', err);
    res.status(500).json({ error: 'Failed to fetch stories' });
  }
}

async function toggleStoryLike(req, res) {
  try {
    const { storyId } = req.params;
    const userId = req.user.id;

    if (!(await canViewStory(userId, storyId))) {
      return res.status(403).json({ error: 'This account is private.' });
    }

    const activeStory = await db.query(
      'SELECT 1 FROM stories WHERE id = $1 AND expires_at > CURRENT_TIMESTAMP',
      [storyId]
    );
    if (activeStory.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found or has expired' });
    }

    const removed = await db.query(
      'DELETE FROM story_likes WHERE story_id = $1 AND user_id = $2 RETURNING story_id',
      [storyId, userId]
    );
    if (removed.rows.length > 0) {
      return res.json({ liked: false });
    }

    const added = await db.query(
      `INSERT INTO story_likes (story_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING story_id`,
      [storyId, userId]
    );
    res.json({ liked: added.rows.length > 0 });
  } catch (err) {
    console.error('Toggle story like error:', err);
    res.status(500).json({ error: 'Failed to update story like' });
  }
}

async function getStoryComments(req, res) {
  try {
    const { storyId } = req.params;
    if (!(await canViewStory(req.user.id, storyId))) {
      return res.status(403).json({ error: 'This account is private.' });
    }
    const result = await db.query(
      `SELECT sc.id, sc.content, sc.created_at, u.id AS user_id, u.username, u.display_name
       FROM story_comments sc
       JOIN users u ON u.id = sc.user_id
       JOIN stories s ON s.id = sc.story_id
       WHERE sc.story_id = $1 AND s.expires_at > CURRENT_TIMESTAMP
       ORDER BY sc.created_at ASC`,
      [storyId]
    );
    res.json({ comments: result.rows });
  } catch (err) {
    console.error('Get story comments error:', err);
    res.status(500).json({ error: 'Failed to fetch story comments' });
  }
}

async function addStoryComment(req, res) {
  try {
    const { storyId } = req.params;
    const userId = req.user.id;
    const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';

    if (!(await canViewStory(userId, storyId))) {
      return res.status(403).json({ error: 'This account is private.' });
    }

    if (!content) {
      return res.status(400).json({ error: 'Comment content cannot be empty' });
    }
    if (content.length > 500) {
      return res.status(400).json({ error: 'Comment must be 500 characters or fewer' });
    }

    const result = await db.query(
      `INSERT INTO story_comments (story_id, user_id, content)
       SELECT s.id, $2, $3
       FROM stories s
       WHERE s.id = $1 AND s.expires_at > CURRENT_TIMESTAMP
       RETURNING id, story_id, user_id, content, created_at`,
      [storyId, userId, content]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found or has expired' });
    }

    const user = await db.query(
      'SELECT username, display_name FROM users WHERE id = $1',
      [userId]
    );
    res.status(201).json({ comment: { ...result.rows[0], ...user.rows[0] } });
  } catch (err) {
    console.error('Add story comment error:', err);
    res.status(500).json({ error: 'Failed to add story comment' });
  }
}

async function deleteStory(req, res) {
  try {
    const { storyId } = req.params;
    const result = await db.query(
      'DELETE FROM stories WHERE id = $1 AND user_id = $2 RETURNING media_url',
      [storyId, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found or you do not own it' });
    }

    const filename = path.basename(result.rows[0].media_url);
    try {
      await fs.unlink(path.join(__dirname, '../../uploads', filename));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('Deleted story media cleanup error:', err);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete story error:', err);
    res.status(500).json({ error: 'Failed to delete story' });
  }
}

// Record that a user viewed a story
async function viewStory(req, res) {
  try {
    const userId = req.user.id;
    const { storyId } = req.params;

    if (!(await canViewStory(userId, storyId))) {
      return res.status(403).json({ error: 'This account is private.' });
    }

    await db.query(
      `INSERT INTO story_views (story_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [storyId, userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('View story error:', err);
    res.status(500).json({ error: 'Failed to record story view' });
  }
}

module.exports = {
  createStory,
  getStories,
  viewStory,
  toggleStoryLike,
  getStoryComments,
  addStoryComment,
  deleteStory,
  moderateRemoveStory,
  updateStoryPrivacy
};
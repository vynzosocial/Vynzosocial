const db = require('../database/db');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth.middleware');
const { isHostConnectedToLive } = require('../services/live-presence');

// Get active live streams
async function getActiveLiveStreams(req, res) {
  try {
    const query = `
      SELECT 
        ls.id, ls.title, ls.category, ls.viewer_count, ls.created_at,
        u.id AS host_id, u.username AS host_username, u.display_name AS host_display_name, u.avatar_url AS host_avatar_url
      FROM live_sessions ls
      JOIN users u ON ls.host_id = u.id
      WHERE ls.is_active = TRUE
      ORDER BY ls.viewer_count DESC, ls.created_at DESC
    `;
    const result = await db.query(query);
    const io = req.app.get('io');
    const live = result.rows.filter(stream =>
      isHostConnectedToLive(io, stream.id, stream.host_id)
    );

    // The list is public, but a logged-in viewer also learns which hosts are their friends (mutual follow).
    let friendIds = new Set();
    try {
      const token = (req.headers.authorization || '').split(' ')[1];
      const viewer = token ? jwt.verify(token, JWT_SECRET) : null;
      if (viewer && live.length) {
        const friends = await db.query(
          `SELECT following_id AS id FROM follows WHERE follower_id = $1 AND status = 'accepted'
           UNION
           SELECT follower_id AS id FROM follows WHERE following_id = $1 AND status = 'accepted'`,
          [viewer.id]
        );
        friendIds = new Set(friends.rows.map(row => row.id));
      }
    } catch (authErr) {
      friendIds = new Set();
    }

    const liveStreams = live
      .map(stream => ({ ...stream, is_friend: friendIds.has(stream.host_id) }))
      .sort((a, b) => Number(b.is_friend) - Number(a.is_friend));
    res.json({ liveStreams });
  } catch (err) {
    console.error('Get live streams error:', err);
    res.status(500).json({ error: 'Failed to fetch active livestreams' });
  }
}

// Start a new live session
async function startLiveSession(req, res) {
  try {
    const hostId = req.user.id;
    const title = String(req.body.title || '').trim().slice(0, 100);
    const { category } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Livestream title is required' });
    }

    // End any existing active streams for this host
    await db.query('UPDATE live_sessions SET is_active = FALSE WHERE host_id = $1 AND is_active = TRUE', [hostId]);

    const query = `
      INSERT INTO live_sessions (host_id, title, category, is_active)
      VALUES ($1, $2, $3, TRUE)
      RETURNING id, title, category, viewer_count, created_at
    `;
    const result = await db.query(query, [hostId, title, category || 'General']);
    res.status(201).json({ message: 'Livestream started successfully', session: result.rows[0] });
  } catch (err) {
    console.error('Start live session error:', err);
    res.status(500).json({ error: 'Failed to start livestream' });
  }
}

// End a live session
async function endLiveSession(req, res) {
  try {
    const hostId = req.user.id;
    const { sessionId } = req.params;

    await db.query(
      'UPDATE live_sessions SET is_active = FALSE WHERE id = $1 AND host_id = $2',
      [sessionId, hostId]
    );

    res.json({ message: 'Livestream ended successfully' });
  } catch (err) {
    console.error('End live session error:', err);
    res.status(500).json({ error: 'Failed to end livestream' });
  }
}

async function updateLiveTitle(req, res) {
  try {
    const title = String(req.body.title || '').trim().slice(0, 100);
    if (!title) return res.status(400).json({ error: 'Livestream title is required' });
    const result = await db.query(
      'UPDATE live_sessions SET title = $1 WHERE id = $2 AND host_id = $3 AND is_active = TRUE RETURNING id, title',
      [title, req.params.sessionId, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Livestream not found' });
    res.json({ session: result.rows[0] });
  } catch (err) {
    console.error('Update live title error:', err);
    res.status(500).json({ error: 'Failed to update title' });
  }
}

module.exports = { getActiveLiveStreams, startLiveSession, endLiveSession, updateLiveTitle };
const db = require('../database/db');
const { isHostConnectedToLive } = require('../services/live-presence');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth.middleware');
const { syncAuthUser } = require('../utils/auth-sync');
const { MESSAGE_PRIVACY_VALUES, POST_PRIVACY_VALUES, FOLLOWING_PRIVACY_VALUES, messageBlockReason } = require('../utils/privacy');

async function updateMyProfile(req, res) {
  try {
    const body = req.body || {};
    const username = typeof body.username === 'string'
      ? body.username.trim().toLowerCase()
      : '';
    const bio = typeof body.bio === 'string' ? body.bio.trim() : '';

    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9._]{1,28}[a-zA-Z0-9])$/.test(username)) {
      return res.status(400).json({
        error: 'Username must be 3–30 characters and use only letters, numbers, periods, and underscores.'
      });
    }
    if (bio.length > 500) {
      return res.status(400).json({ error: 'Bio must be 500 characters or fewer.' });
    }

    const result = await db.query(
      `UPDATE users
       SET username = $1, bio = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING id, username, email, display_name, bio, avatar_url`,
      [username, bio, req.user.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const user = result.rows[0];
    await syncAuthUser(user.id);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ user, token });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That username is already in use.' });
    }
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
}

async function updateMyAvatar(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Choose a profile photo to upload.' });
    }

    const avatarUrl = `/uploads/${req.file.filename}`;
    const result = await db.query(
      `UPDATE users
       SET avatar_url = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, username, email, display_name, bio, avatar_url`,
      [avatarUrl, req.user.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Account not found' });
    }

    await syncAuthUser(req.user.id);
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Update profile photo error:', err);
    res.status(500).json({ error: 'Failed to update profile photo' });
  }
}

async function getFriends(req, res) {
  try {
    const result = await db.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url,
              live.id AS live_session_id, live.title AS live_title,
              live.viewer_count
       FROM follows outgoing
       JOIN follows incoming
         ON incoming.follower_id = outgoing.following_id
        AND incoming.following_id = outgoing.follower_id
        AND incoming.status = 'accepted'
       JOIN users u ON u.id = outgoing.following_id
       LEFT JOIN LATERAL (
         SELECT ls.id, ls.title, ls.viewer_count
         FROM live_sessions ls
         WHERE ls.host_id = u.id AND ls.is_active = TRUE
         ORDER BY ls.created_at DESC
         LIMIT 1
       ) live ON TRUE
       WHERE outgoing.follower_id = $1 AND outgoing.status = 'accepted'
       ORDER BY (live.id IS NOT NULL) DESC, LOWER(COALESCE(u.display_name, u.username))`,
      [req.user.id]
    );

    const io = req.app.get('io');
    res.json({
      friends: result.rows.map(friend => {
        const isLive = friend.live_session_id !== null
          && isHostConnectedToLive(io, friend.live_session_id, friend.id);
        return {
          ...friend,
          live_session_id: isLive ? friend.live_session_id : null,
          live_title: isLive ? friend.live_title : null,
          viewer_count: isLive ? friend.viewer_count : null,
          is_live: isLive
        };
      })
    });
  } catch (err) {
    console.error('Get friends error:', err);
    res.status(500).json({ error: 'Failed to load friends' });
  }
}

// Adds live_session_id / is_live to each user row for hosts who are live right now.
async function withLiveStatus(req, rows) {
  const ids = rows.map(row => row.id);
  if (!ids.length) return rows;
  const live = await db.query(
    `SELECT DISTINCT ON (host_id) host_id, id, title FROM live_sessions
     WHERE is_active = TRUE AND host_id = ANY($1::uuid[]) ORDER BY host_id, created_at DESC`,
    [ids]
  );
  const io = req.app.get('io');
  const byHost = new Map();
  live.rows.forEach(session => {
    if (isHostConnectedToLive(io, session.id, session.host_id)) byHost.set(session.host_id, session);
  });
  return rows.map(row => {
    const session = byHost.get(row.id);
    return { ...row, is_live: Boolean(session), live_session_id: session ? session.id : null, live_title: session ? session.title : null };
  });
}

async function getConnections(req, res) {
  try {
    const type = req.query.type === 'followers' ? 'followers' : 'friends';
    const result = await db.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_private,
              mine.status AS follow_status,
              (theirs.follower_id IS NOT NULL) AS follows_me,
              (mine.status = 'accepted' AND theirs.follower_id IS NOT NULL) AS is_friend,
              (SELECT COUNT(*) FROM follows fr
               WHERE fr.following_id = u.id AND fr.status = 'accepted')::int AS followers_count,
              (SELECT COUNT(*) FROM follows a
               JOIN follows b ON b.follower_id = a.following_id AND b.following_id = a.follower_id AND b.status = 'accepted'
               WHERE a.follower_id = u.id AND a.status = 'accepted')::int AS friends_count
       FROM follows theirs
       JOIN users u ON u.id = theirs.follower_id
       LEFT JOIN follows mine ON mine.follower_id = $1 AND mine.following_id = u.id
       WHERE theirs.following_id = $1 AND theirs.status = 'accepted'
         AND (($2 = 'friends' AND mine.status = 'accepted')
              OR ($2 = 'followers' AND mine.status IS DISTINCT FROM 'accepted'))
       ORDER BY LOWER(COALESCE(u.display_name, u.username))
       LIMIT 200`,
      [req.user.id, type]
    );

    res.json({
      users: (await withLiveStatus(req, result.rows)).map(user => ({
        ...user,
        is_following: user.follow_status === 'accepted',
        follow_requested: user.follow_status === 'pending'
      }))
    });
  } catch (err) {
    console.error('Get connections error:', err);
    res.status(500).json({ error: 'Failed to load connections' });
  }
}

async function searchUsers(req, res) {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (query.length < 2 || query.length > 50) {
      return res.status(400).json({ error: 'Search must be between 2 and 50 characters' });
    }

    const escapedQuery = query.replace(/[!%_]/g, character => `!${character}`);
    const result = await db.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_private,
              f.status AS follow_status,
              EXISTS (
                SELECT 1 FROM follows theirs
                WHERE theirs.follower_id = u.id AND theirs.following_id = $1 AND theirs.status = 'accepted'
              ) AS follows_me,
              (f.status = 'accepted' AND EXISTS (
                SELECT 1 FROM follows reciprocal
                WHERE reciprocal.follower_id = u.id
                  AND reciprocal.following_id = $1
                  AND reciprocal.status = 'accepted'
              )) AS is_friend,
              (SELECT COUNT(*) FROM follows fr
               WHERE fr.following_id = u.id AND fr.status = 'accepted')::int AS followers_count,
              (SELECT COUNT(*) FROM follows a
               JOIN follows b ON b.follower_id = a.following_id AND b.following_id = a.follower_id AND b.status = 'accepted'
               WHERE a.follower_id = u.id AND a.status = 'accepted')::int AS friends_count
       FROM users u
       LEFT JOIN follows f ON f.following_id = u.id AND f.follower_id = $1
       WHERE u.id <> $1
         AND (u.username ILIKE $2 ESCAPE '!' OR u.display_name ILIKE $2 ESCAPE '!')
       ORDER BY CASE WHEN u.username ILIKE $2 ESCAPE '!' THEN 0 ELSE 1 END,
                u.username
       LIMIT 20`,
      [req.user.id, `%${escapedQuery}%`]
    );

    res.json({
      users: (await withLiveStatus(req, result.rows)).map(user => ({
        ...user,
        is_following: user.follow_status === 'accepted',
        follow_requested: user.follow_status === 'pending',
        is_friend: user.is_friend
      }))
    });
  } catch (err) {
    console.error('Search users error:', err);
    res.status(500).json({ error: 'Failed to search accounts' });
  }
}

async function getUserProfile(req, res) {
  try {
    const { userId } = req.params;
    const profileResult = await db.query(
      `SELECT u.id, u.username, u.display_name, u.bio, u.avatar_url,
              private_user.vynzo_id,
              u.is_private, u.is_verified, u.created_at, u.message_privacy, u.allow_calls, u.posts_privacy, u.following_privacy, u.read_receipts,
              f.status AS follow_status,
              EXISTS (
                SELECT 1 FROM follows theirs
                WHERE theirs.follower_id = u.id AND theirs.following_id = $1 AND theirs.status = 'accepted'
              ) AS follows_me,
              (f.status = 'accepted' AND EXISTS (
                SELECT 1 FROM follows reciprocal
                WHERE reciprocal.follower_id = u.id
                  AND reciprocal.following_id = $1
                  AND reciprocal.status = 'accepted'
              )) AS is_friend,
              (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id)::int AS posts_count,
              (SELECT COUNT(*) FROM follows followers
               WHERE followers.following_id = u.id AND followers.status = 'accepted')::int AS followers_count,
              (SELECT COUNT(*) FROM follows a
               JOIN follows b ON b.follower_id = a.following_id AND b.following_id = a.follower_id AND b.status = 'accepted'
               WHERE a.follower_id = u.id AND a.status = 'accepted')::int AS friends_count,
              (SELECT COUNT(*) FROM follows following
               WHERE following.follower_id = u.id AND following.status = 'accepted')::int AS following_count
       FROM users u
       JOIN vynzo_private.user_identifiers private_user ON private_user.user_id = u.id
       LEFT JOIN follows f ON f.following_id = u.id AND f.follower_id = $1
       WHERE u.id = $2`,
      [req.user.id, userId]
    );
    if (profileResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const profile = profileResult.rows[0];
    const isOwner = profile.id === req.user.id;
    const isFollowing = profile.follow_status === 'accepted';
    const postsPrivacy = profile.posts_privacy || 'everyone';
    const canViewPosts = isOwner
      || (postsPrivacy === 'friends' && Boolean(profile.is_friend))
      || (postsPrivacy === 'everyone' && (!profile.is_private || Boolean(profile.is_friend)));
    const followingPrivacy = profile.following_privacy || 'everyone';
    const canViewFollowing = isOwner
      || followingPrivacy === 'everyone'
      || (followingPrivacy === 'friends' && Boolean(profile.is_friend));
    const posts = canViewPosts
      ? await db.query(
        `SELECT p.id, p.caption, p.media_type, p.media_url, p.created_at,
                p.likes_count, p.comments_count, p.is_protected,
                (p.user_id = $1) AS is_owner,
                EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $1) AS is_liked
         FROM posts p
         WHERE p.user_id = $2
         ORDER BY p.created_at DESC`,
        [req.user.id, userId]
      )
      : { rows: [] };

    const messageBlock = isOwner ? null : await messageBlockReason(req.user.id, profile.id);

    let likeStats;
    if (isOwner) {
      const stats = await db.query(
        `SELECT
           (SELECT COUNT(*) FROM story_likes sl JOIN stories s ON s.id = sl.story_id WHERE s.user_id = $1)::int AS stories,
           (SELECT COUNT(*) FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.user_id = $1 AND p.media_type = 'image')::int AS images,
           (SELECT COUNT(*) FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.user_id = $1 AND p.media_type = 'video')::int AS videos,
           (SELECT COUNT(*) FROM blog_likes bl JOIN blog_articles a ON a.id = bl.article_id WHERE a.author_id = $1)::int AS blogs`,
        [profile.id]
      );
      const row = stats.rows[0];
      likeStats = { ...row, total: row.stories + row.images + row.videos + row.blogs };
    }

    const [profileLive] = await withLiveStatus(req, [{ id: profile.id }]);
    res.json({
      profile: {
        id: profile.id,
        is_live: profileLive.is_live,
        live_session_id: profileLive.live_session_id,
        live_title: profileLive.live_title,
        username: profile.username,
        vynzo_id: isOwner ? profile.vynzo_id : undefined,
        display_name: profile.display_name,
        bio: profile.bio,
        avatar_url: profile.avatar_url,
        is_private: profile.is_private,
        message_privacy: isOwner ? profile.message_privacy : undefined,
        allow_calls: isOwner ? profile.allow_calls : undefined,
        posts_privacy: isOwner ? postsPrivacy : undefined,
        following_privacy: isOwner ? followingPrivacy : undefined,
        read_receipts: isOwner ? profile.read_receipts !== false : undefined,
        can_message: !messageBlock,
        message_block_reason: messageBlock,
        is_verified: profile.is_verified,
        created_at: profile.created_at,
        is_owner: isOwner,
        is_following: isFollowing,
        follows_me: profile.follows_me,
        follow_requested: profile.follow_status === 'pending',
        is_friend: profile.is_friend,
        can_view_content: canViewPosts,
        posts_count: canViewPosts ? profile.posts_count : null,
        followers_count: profile.followers_count,
        friends_count: profile.friends_count,
        following_count: canViewFollowing ? profile.following_count : null,
        like_stats: likeStats
      },
      posts: posts.rows
    });
  } catch (err) {
    console.error('Get user profile error:', err);
    res.status(500).json({ error: 'Failed to load account profile' });
  }
}

async function getFollowRequests(req, res) {
  try {
    const result = await db.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, f.created_at
       FROM follows f
       JOIN users u ON u.id = f.follower_id
       WHERE f.following_id = $1 AND f.status = 'accepted'
         AND NOT EXISTS (
           SELECT 1 FROM follows back
           WHERE back.follower_id = $1 AND back.following_id = f.follower_id AND back.status = 'accepted'
         )
       ORDER BY f.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json({ requests: result.rows });
  } catch (err) {
    console.error('Get follow requests error:', err);
    res.status(500).json({ error: 'Failed to load friend requests' });
  }
}

async function followUser(req, res) {
  try {
    const { userId } = req.params;
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'You cannot add your own account' });
    }

    const target = await db.query(
      'SELECT 1 FROM users WHERE id = $1',
      [userId]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Private accounts only share content with mutual friends, so adding is always immediate.
    await db.query(
      `INSERT INTO follows (follower_id, following_id, status)
       VALUES ($1, $2, 'accepted')
       ON CONFLICT (follower_id, following_id) DO UPDATE SET status = 'accepted'`,
      [req.user.id, userId]
    );
    const relation = await db.query(
      `SELECT f.status,
              EXISTS (
                SELECT 1 FROM follows reciprocal
                WHERE reciprocal.follower_id = $2
                  AND reciprocal.following_id = $1
                  AND reciprocal.status = 'accepted'
              ) AS is_followed_back
       FROM follows f
       WHERE f.follower_id = $1 AND f.following_id = $2`,
      [req.user.id, userId]
    );
    res.json({
      is_following: relation.rows[0].status === 'accepted',
      follow_requested: relation.rows[0].status === 'pending',
      is_friend: relation.rows[0].status === 'accepted' && relation.rows[0].is_followed_back
    });
  } catch (err) {
    console.error('Follow user error:', err);
    res.status(500).json({ error: 'Failed to add account' });
  }
}

async function unfollowUser(req, res) {
  try {
    await db.query(
      'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2',
      [req.user.id, req.params.userId]
    );
    res.json({ is_following: false, follow_requested: false, is_friend: false });
  } catch (err) {
    console.error('Unfollow user error:', err);
    res.status(500).json({ error: 'Failed to remove account' });
  }
}

async function updateMyPrivacy(req, res) {
  try {
    const body = req.body || {};
    const hasPrivate = body.is_private !== undefined;
    const hasMessages = body.message_privacy !== undefined;
    const hasCalls = body.allow_calls !== undefined;
    const hasPosts = body.posts_privacy !== undefined;
    const hasFollowing = body.following_privacy !== undefined;
    const hasReceipts = body.read_receipts !== undefined;
    if (!hasPrivate && !hasMessages && !hasCalls && !hasPosts && !hasFollowing && !hasReceipts) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }
    if (hasReceipts && typeof body.read_receipts !== 'boolean') {
      return res.status(400).json({ error: 'read_receipts must be true or false.' });
    }
    if (hasFollowing && !FOLLOWING_PRIVACY_VALUES.includes(body.following_privacy)) {
      return res.status(400).json({ error: 'following_privacy must be everyone, friends or only_me.' });
    }
    if (hasPosts && !POST_PRIVACY_VALUES.includes(body.posts_privacy)) {
      return res.status(400).json({ error: 'posts_privacy must be everyone, friends or only_me.' });
    }
    if (hasCalls && typeof body.allow_calls !== 'boolean') {
      return res.status(400).json({ error: 'allow_calls must be true or false.' });
    }
    if (hasPrivate && typeof body.is_private !== 'boolean') {
      return res.status(400).json({ error: 'is_private must be true or false.' });
    }
    if (hasMessages && !MESSAGE_PRIVACY_VALUES.includes(body.message_privacy)) {
      return res.status(400).json({ error: 'message_privacy must be everyone, friends or nobody.' });
    }
    const result = await db.query(
      `UPDATE users
       SET is_private = COALESCE($1, is_private),
           message_privacy = COALESCE($2, message_privacy),
           allow_calls = COALESCE($4, allow_calls),
           posts_privacy = COALESCE($5, posts_privacy),
           following_privacy = COALESCE($6, following_privacy),
           read_receipts = COALESCE($7, read_receipts),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 RETURNING id, is_private, message_privacy, allow_calls, posts_privacy, following_privacy, read_receipts`,
      [hasPrivate ? body.is_private : null, hasMessages ? body.message_privacy : null, req.user.id, hasCalls ? body.allow_calls : null, hasPosts ? body.posts_privacy : null, hasFollowing ? body.following_privacy : null, hasReceipts ? body.read_receipts : null]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Account not found' });
    }
    res.json({ is_private: result.rows[0].is_private, message_privacy: result.rows[0].message_privacy, allow_calls: result.rows[0].allow_calls, posts_privacy: result.rows[0].posts_privacy, following_privacy: result.rows[0].following_privacy, read_receipts: result.rows[0].read_receipts });
  } catch (err) {
    console.error('Update privacy error:', err);
    res.status(500).json({ error: 'Failed to update privacy' });
  }
}

module.exports = {
  getFriends,
  getConnections,
  searchUsers,
  getUserProfile,
  getFollowRequests,
  followUser,
  unfollowUser,
  updateMyProfile,
  updateMyAvatar,
  updateMyPrivacy
};

const db = require('../database/db');

// SQL condition: the row owned by `ownerAlias` is visible to the viewer in `viewerParam`
// when the owner is public, is the viewer, or both users have accepted each other.
function visibleToSql(ownerAlias, viewerParam) {
  return `(
    NOT COALESCE(${ownerAlias}.is_private, FALSE)
    OR ${ownerAlias}.id = ${viewerParam}
    OR EXISTS (
      SELECT 1 FROM follows pv_a
      JOIN follows pv_b
        ON pv_b.follower_id = pv_a.following_id
       AND pv_b.following_id = pv_a.follower_id
       AND pv_b.status = 'accepted'
      WHERE pv_a.follower_id = ${viewerParam}
        AND pv_a.following_id = ${ownerAlias}.id
        AND pv_a.status = 'accepted'
    )
  )`;
}

const POST_PRIVACY_VALUES = ['everyone', 'friends', 'only_me'];
const FOLLOWING_PRIVACY_VALUES = POST_PRIVACY_VALUES;

// Posts honour the dedicated posts_privacy setting on top of the private-profile rule.
function visiblePostSql(ownerAlias, viewerParam, postAlias) {
  const postRule = postAlias ? `
    AND (
      ${ownerAlias}.id = ${viewerParam}
      OR COALESCE(${postAlias}.privacy, 'everyone') = 'everyone'
      OR (
        COALESCE(${postAlias}.privacy, 'everyone') = 'friends'
        AND EXISTS (
          SELECT 1 FROM follows pf_a
          JOIN follows pf_b
            ON pf_b.follower_id = pf_a.following_id
           AND pf_b.following_id = pf_a.follower_id
           AND pf_b.status = 'accepted'
          WHERE pf_a.follower_id = ${viewerParam}
            AND pf_a.following_id = ${ownerAlias}.id
            AND pf_a.status = 'accepted'
        )
      )
    )` : '';
  return `((
    ${ownerAlias}.id = ${viewerParam}
    OR (
      COALESCE(${ownerAlias}.posts_privacy, 'everyone') <> 'only_me'
      AND (
        (COALESCE(${ownerAlias}.posts_privacy, 'everyone') = 'everyone' AND NOT COALESCE(${ownerAlias}.is_private, FALSE))
        OR EXISTS (
          SELECT 1 FROM follows pv_a
          JOIN follows pv_b
            ON pv_b.follower_id = pv_a.following_id
           AND pv_b.following_id = pv_a.follower_id
           AND pv_b.status = 'accepted'
          WHERE pv_a.follower_id = ${viewerParam}
            AND pv_a.following_id = ${ownerAlias}.id
            AND pv_a.status = 'accepted'
        )
      )
    )
  )${postRule})`;
}

async function canViewPost(viewerId, postId) {
  const result = await db.query(
    `SELECT 1 FROM posts p JOIN users u ON u.id = p.user_id
     WHERE p.id = $2 AND ${visiblePostSql('u', '$1', 'p')}`,
    [viewerId, postId]
  );
  return result.rows.length > 0;
}

const STORY_PRIVACY_VALUES = ['everyone', 'friends', 'only_me'];

// A story honours its own privacy setting on top of the owner's private-profile rule.
function visibleStorySql(storyAlias, ownerAlias, viewerParam) {
  return `(
    ${ownerAlias}.id = ${viewerParam}
    OR (
      COALESCE(${storyAlias}.privacy, 'everyone') <> 'only_me'
      AND (
        (COALESCE(${storyAlias}.privacy, 'everyone') = 'everyone' AND ${visibleToSql(ownerAlias, viewerParam)})
        OR EXISTS (
          SELECT 1 FROM follows pv_a
          JOIN follows pv_b
            ON pv_b.follower_id = pv_a.following_id
           AND pv_b.following_id = pv_a.follower_id
           AND pv_b.status = 'accepted'
          WHERE pv_a.follower_id = ${viewerParam}
            AND pv_a.following_id = ${ownerAlias}.id
            AND pv_a.status = 'accepted'
        )
      )
    )
  )`;
}

async function canViewStory(viewerId, storyId) {
  const result = await db.query(
    `SELECT 1 FROM stories s JOIN users u ON u.id = s.user_id
     WHERE s.id = $2 AND ${visibleStorySql('s', 'u', '$1')}`,
    [viewerId, storyId]
  );
  return result.rows.length > 0;
}

const MESSAGE_PRIVACY_VALUES = ['everyone', 'friends', 'nobody'];

// Returns null when senderId may message recipientId, otherwise a user-facing reason.
async function messageBlockReason(senderId, recipientId) {
  if (senderId === recipientId) return null;
  const result = await db.query(
    `SELECT u.message_privacy,
            EXISTS (
              SELECT 1 FROM follows a
              JOIN follows b ON b.follower_id = a.following_id AND b.following_id = a.follower_id AND b.status = 'accepted'
              WHERE a.follower_id = $1 AND a.following_id = u.id AND a.status = 'accepted'
            ) AS is_friend
     FROM users u WHERE u.id = $2`,
    [senderId, recipientId]
  );
  if (!result.rows.length) return 'Account not found';
  const { message_privacy: setting, is_friend: isFriend } = result.rows[0];
  if (setting === 'nobody') return 'This person is not accepting messages.';
  if (setting === 'friends' && !isFriend) return 'This person only accepts messages from friends.';
  return null;
}

module.exports = { visibleToSql, visibleStorySql, STORY_PRIVACY_VALUES, visiblePostSql, POST_PRIVACY_VALUES, FOLLOWING_PRIVACY_VALUES, canViewPost, canViewStory, MESSAGE_PRIVACY_VALUES, messageBlockReason };

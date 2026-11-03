const db = require('../database/db');
const cloudStorage = require('../config/storage');
const { moderateContent, aiEnabled } = require('./blog-moderation');
const { notifyUser } = require('./moderation-notice');

const CATEGORY_LABELS = {
  sexual: 'sexual content', sexual_minors: 'sexual content involving minors', hate: 'hate speech',
  harassment: 'harassment', self_harm: 'self-harm', graphic_violence: 'graphic violence',
  illegal: 'illegal activity', violence_extremism: 'violent extremism'
};

function label(category) {
  return CATEGORY_LABELS[String(category).replace(/^image_/, '')] || String(category).replace(/_/g, ' ');
}

// Deletes a story, keeps an audit record and tells the owner why.
async function removeStory(io, story, { reason, actorId = null, action }) {
  await db.query('DELETE FROM stories WHERE id = $1', [story.id]);
  try {
    await cloudStorage.deletePublicPath(story.media_url);
  } catch (err) {
    console.error('Story media cleanup failed:', err);
  }
  await db.query(
    `INSERT INTO story_moderation_logs (user_id, actor_id, media_type, action, reason) VALUES ($1, $2, $3, $4, $5)`,
    [story.user_id, actorId, story.media_type, action, reason]
  ).catch(err => console.error('Story moderation log failed:', err.message));
  await notifyUser(io, story.user_id,
    `Your story was removed because it violates the Vynzo community guidelines.\nReason: ${reason}\nIf you think this was a mistake, reply to this message and our team will review it.`
  ).catch(err => console.error('Story removal notice failed:', err.message));
}

// Runs right after upload. Images are scanned with the AI moderation model when one is configured.
// Videos cannot be scanned automatically, so they rely on admin review.
async function scanStory(io, story) {
  if (story.media_type !== 'image' || !aiEnabled()) return;
  try {
    const result = await moderateContent({ text: '', images: [story.media_url] });
    const flagged = result.categories.filter(c => c.score >= 0.5).map(c => label(c.name));
    if (result.decision === 'reject' || flagged.length) {
      await removeStory(io, story, {
        reason: `automatic check found ${[...new Set(flagged)].join(', ') || 'content that breaks the policy'}`,
        action: 'auto_removed'
      });
    }
  } catch (err) {
    console.error('Story scan failed:', err.message);
  }
}

module.exports = { scanStory, removeStory };

const db = require('../database/db');
const { moderateContent } = require('./blog-moderation');
const { extractImagePaths } = require('./blog-sanitize');

// Articles waiting longer than this are decided automatically, so nobody waits more than ~60s.
const MAX_WAIT_SECONDS = 30;
const TICK_MS = 15000;
const RECHECK_MINUTES = 10;

const POLICY_MESSAGE = 'Your article was removed automatically because it appears to violate the Vynzo content policy';

async function logAction(articleId, userId, action, reason, details = {}) {
  await db.query(
    `INSERT INTO blog_moderation_logs (article_id, subject_user_id, action, reason, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [articleId, userId, action, reason, JSON.stringify(details)]
  ).catch(() => {});
}

async function addStrike(userId, articleId, reason) {
  const result = await db.query('UPDATE users SET blog_strikes = blog_strikes + 1 WHERE id = $1 RETURNING blog_strikes', [userId]);
  const strikes = result.rows[0]?.blog_strikes || 0;
  const days = strikes >= 8 ? 3650 : strikes >= 5 ? 30 : strikes >= 3 ? 7 : 0;
  if (days) {
    await db.query(`UPDATE users SET blog_banned_until = NOW() + ($2 || ' days')::interval WHERE id = $1`, [userId, String(days)]);
  }
  await logAction(articleId, userId, 'strike', reason, { strikes, ban_days: days });
}

async function check(article) {
  const images = [...new Set([...(article.cover_url ? [article.cover_url] : []), ...extractImagePaths(article.content_html)])];
  const result = await moderateContent({
    title: article.title,
    text: article.content_text,
    images,
    hasEmbeds: article.has_embeds
  });
  const flagged = result.categories.filter(c => c.score >= 0.5).map(c => c.name);
  return { result, violation: result.decision === 'reject' || flagged.length > 0, flagged };
}

async function reject(article, status, flagged, action) {
  const reason = `${POLICY_MESSAGE}${flagged.length ? ` (${flagged.join(', ')})` : ''}. You can edit it or appeal this decision.`;
  await db.query(
    `UPDATE blog_articles SET status = $1::text, rejection_reason = $2, updated_at = NOW() WHERE id = $3`,
    [status, reason, article.id]
  );
  await logAction(article.id, article.author_id, action, flagged.join(', ') || null);
  await addStrike(article.author_id, article.id, action);
}

async function decideWaiting() {
  const waiting = await db.query(
    `SELECT a.id, a.author_id, a.title, a.content_text, a.content_html, a.cover_url, a.has_embeds
     FROM blog_articles a
     WHERE a.status IN ('pending', 'in_review')
       AND a.updated_at < NOW() - ($1 || ' seconds')::interval
       AND NOT EXISTS (SELECT 1 FROM blog_reports r WHERE r.target_type = 'article' AND r.target_id = a.id AND r.status = 'open')
     ORDER BY a.updated_at ASC LIMIT 10`,
    [String(MAX_WAIT_SECONDS)]
  );
  for (const article of waiting.rows) {
    try {
      const { violation, flagged, result } = await check(article);
      if (violation) {
        await reject(article, 'rejected', flagged, 'auto_rejected_timed');
      } else {
        await db.query(
          `UPDATE blog_articles SET status = 'published', rejection_reason = NULL,
             published_at = COALESCE(published_at, NOW()), updated_at = NOW(),
             moderation = $2 WHERE id = $1`,
          [article.id, JSON.stringify({ categories: [], reasons: result.reasons, engine: result.engine, checked_at: new Date().toISOString() })]
        );
        await logAction(article.id, article.author_id, 'auto_approve_timed', null);
      }
    } catch (err) {
      console.error('Blog auto-review failed:', err.message);
    }
  }
}

// Published articles keep being re-checked; anything that now violates the policy is taken down.
async function recheckPublished() {
  const published = await db.query(
    `SELECT id, author_id, title, content_text, content_html, cover_url, has_embeds
     FROM blog_articles
     WHERE status = 'published'
       AND COALESCE((moderation->>'checked_at')::timestamptz, published_at, created_at) < NOW() - ($1 || ' minutes')::interval
     ORDER BY COALESCE((moderation->>'checked_at')::timestamptz, published_at, created_at) ASC LIMIT 10`,
    [String(RECHECK_MINUTES)]
  );
  for (const article of published.rows) {
    try {
      const { violation, flagged, result } = await check(article);
      if (violation) {
        await reject(article, 'removed', flagged, 'auto_removed_recheck');
      } else {
        await db.query(
          `UPDATE blog_articles SET moderation = $2 WHERE id = $1`,
          [article.id, JSON.stringify({ categories: [], reasons: result.reasons, engine: result.engine, checked_at: new Date().toISOString() })]
        );
      }
    } catch (err) {
      console.error('Blog recheck failed:', err.message);
    }
  }
}

let running = false;
function startBlogAutoReview() {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await decideWaiting();
      await recheckPublished();
    } catch (err) {
      console.error('Blog auto-review tick failed:', err.message);
    } finally {
      running = false;
    }
  };
  setInterval(tick, TICK_MS).unref();
  tick();
}

module.exports = { startBlogAutoReview };

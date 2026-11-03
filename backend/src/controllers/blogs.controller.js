const crypto = require('crypto');
const path = require('path');
const db = require('../database/db');
const cloudStorage = require('../config/storage');
const { cleanHtml, htmlToText, toEmbedUrl, extractImagePaths, extractHashtags } = require('../services/blog-sanitize');
const { moderateContent, moderateComment, moderationMode, aiEnabled } = require('../services/blog-moderation');

const CATEGORIES = ['general', 'technology', 'lifestyle', 'travel', 'food', 'health', 'education',
  'business', 'entertainment', 'sports', 'art', 'opinion', 'news', 'family'];
const REPORT_REASONS = ['sexual', 'child_safety', 'religious_hate', 'self_harm', 'hate_harassment',
  'extremism', 'illegal', 'violence', 'misinformation', 'copyright', 'spam_scam', 'other'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COVER_PATH = /^\/uploads\/[A-Za-z0-9._-]+$/;
const MAX_HTML = 200000;
const MAX_SUBMISSIONS_PER_DAY = 10;
const AUTO_HIDE_REPORTS = 3;

const isUuid = value => UUID.test(String(value || ''));
const clampInt = (value, min, max, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const escapeLike = value => value.replace(/[\\%_]/g, '\\$&');
const detectLanguage = text => {
  const letters = (text.match(/\p{L}/gu) || []).length || 1;
  const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
  return arabic / letters > 0.3 ? 'ar' : 'en';
};

const ARTICLE_COLUMNS = `a.id, a.title, a.excerpt, a.cover_url, a.category, a.tags, a.language, a.status,
  a.views_count, a.likes_count, a.comments_count, a.shares_count, a.bookmarks_count,
  a.published_at, a.created_at, a.updated_at,
  GREATEST(1, CEIL(LENGTH(a.content_text) / 1200.0))::int AS read_minutes,
  u.id AS author_id, u.username AS author_username, u.display_name AS author_display_name,
  u.avatar_url AS author_avatar_url,
  EXISTS(SELECT 1 FROM blog_likes bl WHERE bl.article_id = a.id AND bl.user_id = $1) AS is_liked,
  EXISTS(SELECT 1 FROM blog_bookmarks bb WHERE bb.article_id = a.id AND bb.user_id = $1) AS is_bookmarked`;

const TRENDING_SCORE = `(a.likes_count * 3 + a.comments_count * 4 + a.shares_count * 3 + a.bookmarks_count * 2 + a.views_count * 0.2)
  / POWER(EXTRACT(EPOCH FROM (NOW() - a.published_at)) / 3600 + 2, 1.3)`;

async function log({ articleId = null, commentId = null, subjectUserId = null, actorId = null, action, reason = null, details = {} }) {
  await db.query(
    `INSERT INTO blog_moderation_logs (article_id, comment_id, subject_user_id, actor_id, action, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [articleId, commentId, subjectUserId, actorId, action, reason, JSON.stringify(details)]
  );
}

async function getUserState(userId) {
  const result = await db.query(
    'SELECT id, username, is_admin, suspended_until, suspension_reason, blog_strikes, blog_banned_until FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

// Blocks writes (not reading) for suspended or blog-banned accounts.
async function requireWriter(req, res, next) {
  try {
    const user = await getUserState(req.user.id);
    if (!user) return res.status(401).json({ error: 'Account not found' });
    const now = new Date();
    if (user.suspended_until && new Date(user.suspended_until) > now) {
      return res.status(403).json({ error: 'Your account is suspended.', code: 'suspended' });
    }
    if (user.blog_banned_until && new Date(user.blog_banned_until) > now) {
      return res.status(403).json({
        error: `Publishing is disabled on your account until ${new Date(user.blog_banned_until).toISOString().slice(0, 10)} because of repeated policy violations.`,
        code: 'blog_banned'
      });
    }
    req.account = user;
    next();
  } catch (err) {
    console.error('requireWriter error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = await getUserState(req.user.id);
    if (!user || !user.is_admin) return res.status(403).json({ error: 'Administrator access required' });
    req.account = user;
    next();
  } catch (err) {
    console.error('requireAdmin error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

async function addStrike(userId, articleId, reason) {
  const result = await db.query(
    'UPDATE users SET blog_strikes = blog_strikes + 1 WHERE id = $1 RETURNING blog_strikes',
    [userId]
  );
  const strikes = result.rows[0]?.blog_strikes || 0;
  let days = 0;
  if (strikes >= 8) days = 3650;
  else if (strikes >= 5) days = 30;
  else if (strikes >= 3) days = 7;
  if (days) {
    await db.query(
      `UPDATE users SET blog_banned_until = NOW() + ($2 || ' days')::interval WHERE id = $1`,
      [userId, String(days)]
    );
  }
  await log({ articleId, subjectUserId: userId, action: 'strike', reason, details: { strikes, ban_days: days } });
}

function publicReasons(result) {
  return {
    categories: result.categories.map(c => c.name),
    reasons: result.reasons,
    engine: result.engine,
    checked_at: new Date().toISOString()
  };
}

function sanitizeInput(body) {
  const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const contentHtml = cleanHtml(String(body.content_html || '').slice(0, MAX_HTML * 2));
  const contentText = htmlToText(contentHtml);
  const category = CATEGORIES.includes(body.category) ? body.category : 'general';
  const rawTags = Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(/[,\s]+/);
  const tags = new Set(rawTags.map(t => String(t).replace(/^#/, '').toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 30)).filter(t => t.length >= 2));
  extractHashtags(contentText).forEach(t => tags.add(t));
  const coverUrl = body.cover_url && COVER_PATH.test(body.cover_url) ? body.cover_url : null;
  return {
    title,
    contentHtml,
    contentText,
    category,
    tags: [...tags].slice(0, 10),
    coverUrl,
    language: detectLanguage(`${title} ${contentText}`),
    hasEmbeds: /<(iframe|video)\b/i.test(contentHtml),
    excerpt: contentText.slice(0, 220)
  };
}

const hashOf = text => crypto.createHash('sha256')
  .update(text.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');

/* ---------- Meta ---------- */
async function getMeta(req, res) {
  res.json({
    categories: CATEGORIES,
    report_reasons: REPORT_REASONS,
    moderation: { mode: moderationMode(), ai: aiEnabled() }
  });
}

/* ---------- Media upload ---------- */
const MAGIC = [
  { ext: ['.jpg', '.jpeg'], test: b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { ext: ['.png'], test: b => b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG' },
  { ext: ['.gif'], test: b => b.toString('latin1', 0, 4) === 'GIF8' },
  { ext: ['.webp'], test: b => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
  { ext: ['.mp4', '.mov', '.m4v'], video: true, test: b => b.toString('latin1', 4, 8) === 'ftyp' },
  { ext: ['.webm'], video: true, test: b => b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3 }
];
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
// Remembers each writer's latest upload so the editor can recover it if the page reloaded mid-upload.
const lastUploads = new Map();

function lastBlogUpload(req, res) {
  const last = lastUploads.get(req.user.id);
  res.json({ upload: last && Date.now() - last.at < 5 * 60 * 1000 ? last : null });
}

async function uploadBlogImage(req, res) {
  if (!req.file) return res.status(400).json({ error: 'Image or video file is required' });
  const reject = async message => {
    try {
      await cloudStorage.deleteFile(req.file.filename);
    } catch (err) {
      console.error('Rejected blog upload cleanup failed:', err);
    }
    return res.status(400).json({ error: message });
  };
  try {
    const ext = path.extname(req.file.filename).toLowerCase();
    const header = req.file.buffer.subarray(0, 12);
    const kind = MAGIC.find(m => m.ext.includes(ext) && m.test(header));
    if (!kind) return await reject('The file is not a valid JPEG, PNG, GIF or WEBP image, or MP4, WEBM or MOV video.');
    if (!kind.video && req.file.size > MAX_IMAGE_BYTES) return await reject('Images can be up to 15 MB.');
    const result = { url: `/uploads/${req.file.filename}`, type: kind.video ? 'video' : 'image' };
    lastUploads.set(req.user.id, { ...result, at: Date.now() });
    res.status(201).json(result);
  } catch (err) {
    console.error('Blog upload error:', err);
    await reject('Upload failed');
  }
}

function embedUrl(req, res) {
  const url = toEmbedUrl(req.body.url);
  if (!url) return res.status(400).json({ error: 'Only https YouTube and Vimeo links can be embedded.' });
  res.json({ url });
}

/* ---------- Articles ---------- */
async function listArticles(req, res) {
  try {
    const userId = req.user.id;
    const limit = clampInt(req.query.limit, 1, 30, 12);
    const offset = clampInt(req.query.offset, 0, 100000, 0);
    const params = [userId];
    const where = [`a.status = 'published'`,
      `NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = a.author_id) OR (b.blocker_id = a.author_id AND b.blocked_id = $1))`];

    if (req.query.category && CATEGORIES.includes(req.query.category)) {
      params.push(req.query.category);
      where.push(`a.category = $${params.length}`);
    }
    if (req.query.author && isUuid(req.query.author)) {
      params.push(req.query.author);
      where.push(`a.author_id = $${params.length}`);
    }
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q.startsWith('#') && q.length > 2) {
      params.push(q.slice(1).toLowerCase());
      where.push(`$${params.length} = ANY(a.tags)`);
    } else if (q) {
      params.push(`%${escapeLike(q)}%`);
      const n = params.length;
      where.push(`(a.title ILIKE $${n} OR a.excerpt ILIKE $${n} OR a.content_text ILIKE $${n} OR u.username ILIKE $${n} OR u.display_name ILIKE $${n})`);
    }
    if (req.query.tag) {
      params.push(String(req.query.tag).toLowerCase().replace(/^#/, '').slice(0, 30));
      where.push(`$${params.length} = ANY(a.tags)`);
    }
    const order = req.query.sort === 'trending' ? `${TRENDING_SCORE} DESC` : 'a.published_at DESC';
    params.push(limit, offset);

    const result = await db.query(
      `SELECT ${ARTICLE_COLUMNS}
       FROM blog_articles a JOIN users u ON u.id = a.author_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${order}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ articles: result.rows, limit, offset });
  } catch (err) {
    console.error('List articles error:', err);
    res.status(500).json({ error: 'Failed to load articles' });
  }
}

async function trendingTags(req, res) {
  try {
    const result = await db.query(
      `SELECT tag, COUNT(*)::int AS uses
       FROM blog_articles a, UNNEST(a.tags) AS tag
       WHERE a.status = 'published' AND a.published_at > NOW() - INTERVAL '30 days'
       GROUP BY tag ORDER BY uses DESC, tag LIMIT 12`
    );
    res.json({ tags: result.rows });
  } catch (err) {
    console.error('Trending tags error:', err);
    res.status(500).json({ error: 'Failed to load tags' });
  }
}

async function myArticles(req, res) {
  try {
    const result = await db.query(
      `SELECT ${ARTICLE_COLUMNS}, a.rejection_reason, a.moderation,
        (SELECT status FROM blog_appeals ap WHERE ap.article_id = a.id ORDER BY ap.created_at DESC LIMIT 1) AS appeal_status
       FROM blog_articles a JOIN users u ON u.id = a.author_id
       WHERE a.author_id = $1 ORDER BY a.updated_at DESC LIMIT 100`,
      [req.user.id]
    );
    const account = await getUserState(req.user.id);
    res.json({
      articles: result.rows,
      strikes: account?.blog_strikes || 0,
      banned_until: account?.blog_banned_until || null
    });
  } catch (err) {
    console.error('My articles error:', err);
    res.status(500).json({ error: 'Failed to load your articles' });
  }
}

async function myBookmarks(req, res) {
  try {
    const result = await db.query(
      `SELECT ${ARTICLE_COLUMNS}
       FROM blog_bookmarks k JOIN blog_articles a ON a.id = k.article_id
       JOIN users u ON u.id = a.author_id
       WHERE k.user_id = $1 AND a.status = 'published'
       ORDER BY k.created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json({ articles: result.rows });
  } catch (err) {
    console.error('Bookmarks error:', err);
    res.status(500).json({ error: 'Failed to load bookmarks' });
  }
}

async function getArticle(req, res) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ error: 'Article not found' });
    const result = await db.query(
      `SELECT ${ARTICLE_COLUMNS}, a.content_html, a.rejection_reason, a.moderation, a.cover_url
       FROM blog_articles a JOIN users u ON u.id = a.author_id WHERE a.id = $2`,
      [req.user.id, id]
    );
    const article = result.rows[0];
    if (!article) return res.status(404).json({ error: 'Article not found' });

    const isOwner = article.author_id === req.user.id;
    let isAdmin = false;
    if (!isOwner && article.status !== 'published') {
      isAdmin = Boolean((await getUserState(req.user.id))?.is_admin);
      if (!isAdmin) return res.status(404).json({ error: 'Article not found' });
    }
    if (article.status === 'published' && !isOwner) {
      const blocked = await db.query(
        `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [req.user.id, article.author_id]
      );
      if (blocked.rows.length) return res.status(404).json({ error: 'Article not found' });
      await db.query('UPDATE blog_articles SET views_count = views_count + 1 WHERE id = $1', [id]);
      article.views_count += 1;
    }
    if (!isOwner && !isAdmin) {
      delete article.moderation;
      delete article.rejection_reason;
    }
    article.is_owner = isOwner;
    res.json({ article });
  } catch (err) {
    console.error('Get article error:', err);
    res.status(500).json({ error: 'Failed to load article' });
  }
}

async function saveArticle(req, res) {
  try {
    const input = sanitizeInput(req.body);
    if (input.title.length < 3) return res.status(400).json({ error: 'Add a title (at least 3 characters).' });
    if (input.contentHtml.length > MAX_HTML) return res.status(400).json({ error: 'The article is too long.' });
    const hash = hashOf(`${input.title} ${input.contentText}`);

    if (req.params.id) {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Article not found' });
      const existing = await db.query('SELECT id, status, author_id FROM blog_articles WHERE id = $1', [req.params.id]);
      const article = existing.rows[0];
      if (!article || article.author_id !== req.user.id) return res.status(404).json({ error: 'Article not found' });
      if (article.status === 'removed') return res.status(403).json({ error: 'This article was removed. You can appeal the decision.' });

      // Editing a live article takes it offline until the new version passes moderation again.
      const nextStatus = 'draft';
      const result = await db.query(
        `UPDATE blog_articles SET title = $1, excerpt = $2, content_html = $3, content_text = $4, cover_url = $5,
           category = $6, tags = $7, language = $8, has_embeds = $9, content_hash = $10,
           status = $11, rejection_reason = NULL, updated_at = NOW()
         WHERE id = $12 RETURNING id, status`,
        [input.title, input.excerpt, input.contentHtml, input.contentText, input.coverUrl, input.category,
          input.tags, input.language, input.hasEmbeds, hash, nextStatus, article.id]
      );
      return res.json({ article: result.rows[0], note: article.status === 'published' ? 'unpublished_for_edit' : null });
    }

    const result = await db.query(
      `INSERT INTO blog_articles (author_id, title, excerpt, content_html, content_text, cover_url, category, tags,
         language, has_embeds, content_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft') RETURNING id, status`,
      [req.user.id, input.title, input.excerpt, input.contentHtml, input.contentText, input.coverUrl,
        input.category, input.tags, input.language, input.hasEmbeds, hash]
    );
    res.status(201).json({ article: result.rows[0] });
  } catch (err) {
    console.error('Save article error:', err);
    res.status(500).json({ error: 'Failed to save article' });
  }
}

// Server-side gate: nothing becomes public without passing moderation or admin approval.
async function submitArticle(req, res) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ error: 'Article not found' });
    const found = await db.query('SELECT * FROM blog_articles WHERE id = $1 AND author_id = $2', [id, req.user.id]);
    const article = found.rows[0];
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (!['draft', 'rejected'].includes(article.status)) {
      return res.status(409).json({ error: 'This article is already submitted.' });
    }
    if (article.title.length < 3 || article.content_text.length < 100) {
      return res.status(400).json({ error: 'Write a title and at least 100 characters before publishing.' });
    }

    const recent = await db.query(
      `SELECT COUNT(*)::int AS n FROM blog_moderation_logs
       WHERE subject_user_id = $1 AND action = 'submitted' AND created_at > NOW() - INTERVAL '24 hours'`,
      [req.user.id]
    );
    if (recent.rows[0].n >= MAX_SUBMISSIONS_PER_DAY) {
      return res.status(429).json({ error: 'You have reached the daily publishing limit. Try again tomorrow.' });
    }
    const duplicate = await db.query(
      `SELECT 1 FROM blog_articles WHERE content_hash = $1 AND id <> $2 AND status IN ('published','pending','in_review') LIMIT 1`,
      [article.content_hash, id]
    );
    if (duplicate.rows.length) {
      return res.status(409).json({ error: 'This content duplicates an existing article.' });
    }

    await log({ articleId: id, subjectUserId: req.user.id, actorId: req.user.id, action: 'submitted' });
    await db.query(`UPDATE blog_articles SET status = 'pending', updated_at = NOW() WHERE id = $1`, [id]);

    const images = [...new Set([...(article.cover_url ? [article.cover_url] : []), ...extractImagePaths(article.content_html)])];
    const result = await moderateContent({
      title: article.title,
      text: article.content_text,
      images,
      hasEmbeds: article.has_embeds
    });
    const moderation = publicReasons(result);

    let status;
    let message;
    if (result.decision === 'approve') {
      status = 'published';
      message = 'published';
    } else if (result.decision === 'review') {
      status = 'in_review';
      message = 'in_review';
    } else {
      status = 'rejected';
      message = 'rejected';
    }
    const reason = status === 'rejected'
      ? 'The article appears to violate the Vynzo content policy.' : null;

    await db.query(
      `UPDATE blog_articles SET status = $1::text, moderation = $2, rejection_reason = $3,
         published_at = CASE WHEN $1::text = 'published' THEN NOW() ELSE published_at END, updated_at = NOW()
       WHERE id = $4`,
      [status, JSON.stringify(moderation), reason, id]
    );
    await log({
      articleId: id, subjectUserId: req.user.id, action: `auto_${result.decision}`,
      reason: moderation.categories.join(', ') || moderation.reasons.join(', ') || null, details: moderation
    });
    if (status === 'rejected') await addStrike(req.user.id, id, 'auto_rejected');

    res.json({ status, result: message, moderation: { categories: moderation.categories, reasons: moderation.reasons } });
  } catch (err) {
    console.error('Submit article error:', err);
    // Fail closed: if anything breaks mid-way the article must not stay public.
    await db.query(`UPDATE blog_articles SET status = 'in_review' WHERE id = $1 AND status = 'pending'`, [req.params.id]).catch(() => {});
    res.status(500).json({ error: 'Moderation could not be completed. Your article was held for review.' });
  }
}

async function unpublishArticle(req, res) {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Article not found' });
    const result = await db.query(
      `UPDATE blog_articles SET status = 'draft', updated_at = NOW()
       WHERE id = $1 AND author_id = $2 AND status IN ('published','pending','in_review') RETURNING id, status`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Article not found' });
    res.json({ article: result.rows[0] });
  } catch (err) {
    console.error('Unpublish error:', err);
    res.status(500).json({ error: 'Failed to unpublish' });
  }
}

async function deleteArticle(req, res) {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Article not found' });
    const account = await getUserState(req.user.id);
    const result = await db.query(
      `DELETE FROM blog_articles WHERE id = $1 AND (author_id = $2 OR $3::boolean) RETURNING id, author_id`,
      [req.params.id, req.user.id, Boolean(account?.is_admin)]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Article not found' });
    await log({
      subjectUserId: result.rows[0].author_id, actorId: req.user.id, action: 'deleted',
      details: { article_id: req.params.id }
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete article error:', err);
    res.status(500).json({ error: 'Failed to delete article' });
  }
}

/* ---------- Engagement ---------- */
async function loadPublished(id) {
  if (!isUuid(id)) return null;
  const result = await db.query(`SELECT id, author_id FROM blog_articles WHERE id = $1 AND status = 'published'`, [id]);
  return result.rows[0] || null;
}

async function toggle(req, res, table, counter, key) {
  try {
    const article = await loadPublished(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    const removed = await db.query(`DELETE FROM ${table} WHERE article_id = $1 AND user_id = $2`, [article.id, req.user.id]);
    let active;
    if (removed.rowCount) {
      active = false;
      await db.query(`UPDATE blog_articles SET ${counter} = GREATEST(0, ${counter} - 1) WHERE id = $1`, [article.id]);
    } else {
      active = true;
      await db.query(`INSERT INTO ${table} (article_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [article.id, req.user.id]);
      await db.query(`UPDATE blog_articles SET ${counter} = ${counter} + 1 WHERE id = $1`, [article.id]);
    }
    const count = (await db.query(`SELECT ${counter} AS n FROM blog_articles WHERE id = $1`, [article.id])).rows[0].n;
    res.json({ [key]: active, count });
  } catch (err) {
    console.error('Toggle error:', err);
    res.status(500).json({ error: 'Action failed' });
  }
}

const toggleLike = (req, res) => toggle(req, res, 'blog_likes', 'likes_count', 'liked');
const toggleBookmark = (req, res) => toggle(req, res, 'blog_bookmarks', 'bookmarks_count', 'bookmarked');

async function shareArticle(req, res) {
  try {
    const article = await loadPublished(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    const result = await db.query(
      'UPDATE blog_articles SET shares_count = shares_count + 1 WHERE id = $1 RETURNING shares_count', [article.id]);
    res.json({ shares_count: result.rows[0].shares_count });
  } catch (err) {
    console.error('Share error:', err);
    res.status(500).json({ error: 'Action failed' });
  }
}

/* ---------- Comments ---------- */
async function listComments(req, res) {
  try {
    const article = await loadPublished(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    const account = await getUserState(req.user.id);
    const result = await db.query(
      `SELECT c.id, c.body, c.status, c.created_at, u.id AS user_id, u.username, u.display_name, u.avatar_url
       FROM blog_comments c JOIN users u ON u.id = c.user_id
       WHERE c.article_id = $1 AND (c.status = 'visible' OR (c.status = 'held' AND (c.user_id = $2 OR $3::boolean)))
       ORDER BY c.created_at ASC LIMIT 200`,
      [article.id, req.user.id, Boolean(account?.is_admin)]
    );
    res.json({ comments: result.rows, article_author_id: article.author_id });
  } catch (err) {
    console.error('List comments error:', err);
    res.status(500).json({ error: 'Failed to load comments' });
  }
}

async function addComment(req, res) {
  try {
    const article = await loadPublished(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    const body = String(req.body.body || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    if (!body) return res.status(400).json({ error: 'Write a comment first.' });

    const recent = await db.query(
      `SELECT COUNT(*)::int AS n FROM blog_comments WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 minute'`,
      [req.user.id]
    );
    if (recent.rows[0].n >= 6) return res.status(429).json({ error: 'You are commenting too fast. Please wait a moment.' });

    const verdict = await moderateComment(body);
    if (verdict.decision === 'reject') {
      await log({ articleId: article.id, subjectUserId: req.user.id, action: 'comment_blocked',
        reason: verdict.categories.map(c => c.name).join(', ') });
      return res.status(422).json({ error: 'This comment violates the Vynzo content policy and was not posted.' });
    }
    const status = verdict.decision === 'approve' ? 'visible' : 'held';
    const result = await db.query(
      `INSERT INTO blog_comments (article_id, user_id, body, status, moderation)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, body, status, created_at`,
      [article.id, req.user.id, body, status, JSON.stringify(publicReasons(verdict))]
    );
    if (status === 'visible') {
      await db.query('UPDATE blog_articles SET comments_count = comments_count + 1 WHERE id = $1', [article.id]);
    } else {
      await log({ articleId: article.id, commentId: result.rows[0].id, subjectUserId: req.user.id, action: 'comment_held',
        reason: verdict.categories.map(c => c.name).join(', ') });
    }
    const user = (await db.query('SELECT id AS user_id, username, display_name, avatar_url FROM users WHERE id = $1', [req.user.id])).rows[0];
    res.status(201).json({ comment: { ...result.rows[0], ...user }, held: status === 'held' });
  } catch (err) {
    console.error('Add comment error:', err);
    res.status(500).json({ error: 'Failed to post comment' });
  }
}

async function removeComment(commentId, byUserId, isAdmin) {
  const found = await db.query(
    `SELECT c.id, c.article_id, c.user_id, c.status, a.author_id
     FROM blog_comments c JOIN blog_articles a ON a.id = c.article_id WHERE c.id = $1`, [commentId]);
  const comment = found.rows[0];
  if (!comment) return null;
  if (!(isAdmin || comment.user_id === byUserId || comment.author_id === byUserId)) return false;
  await db.query('DELETE FROM blog_comments WHERE id = $1', [commentId]);
  if (comment.status === 'visible') {
    await db.query('UPDATE blog_articles SET comments_count = GREATEST(0, comments_count - 1) WHERE id = $1', [comment.article_id]);
  }
  return comment;
}

async function deleteComment(req, res) {
  try {
    if (!isUuid(req.params.commentId)) return res.status(404).json({ error: 'Comment not found' });
    const account = await getUserState(req.user.id);
    const removed = await removeComment(req.params.commentId, req.user.id, Boolean(account?.is_admin));
    if (removed === null) return res.status(404).json({ error: 'Comment not found' });
    if (removed === false) return res.status(403).json({ error: 'You cannot delete this comment' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete comment error:', err);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
}

/* ---------- Authors ---------- */
async function getAuthor(req, res) {
  try {
    if (!isUuid(req.params.userId)) return res.status(404).json({ error: 'Author not found' });
    const profile = await db.query(
      `SELECT u.id, u.username, u.display_name, u.bio, u.avatar_url, u.is_verified,
         (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id AND f.status = 'accepted')::int AS followers_count,
         EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.following_id = u.id AND f.status = 'accepted') AS is_following,
         COUNT(a.id)::int AS articles_count,
         COALESCE(SUM(a.views_count), 0)::int AS total_views,
         COALESCE(SUM(a.likes_count), 0)::int AS total_likes,
         COALESCE(SUM(a.comments_count), 0)::int AS total_comments
       FROM users u LEFT JOIN blog_articles a ON a.author_id = u.id AND a.status = 'published'
       WHERE u.id = $1 GROUP BY u.id`,
      [req.params.userId, req.user.id]
    );
    if (!profile.rows.length) return res.status(404).json({ error: 'Author not found' });
    res.json({ author: profile.rows[0] });
  } catch (err) {
    console.error('Get author error:', err);
    res.status(500).json({ error: 'Failed to load author' });
  }
}

async function toggleFollow(req, res) {
  try {
    const target = req.params.userId;
    if (!isUuid(target) || target === req.user.id) return res.status(400).json({ error: 'Invalid author' });
    const existing = await db.query(
      'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2 RETURNING 1', [req.user.id, target]);
    let following = false;
    if (!existing.rowCount) {
      const priv = await db.query('SELECT is_private FROM users WHERE id = $1', [target]);
      if (!priv.rows.length) return res.status(404).json({ error: 'Author not found' });
      const status = priv.rows[0].is_private ? 'pending' : 'accepted';
      await db.query(
        `INSERT INTO follows (follower_id, following_id, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [req.user.id, target, status]);
      following = status === 'accepted';
      return res.json({ following, pending: status === 'pending' });
    }
    res.json({ following });
  } catch (err) {
    console.error('Toggle follow error:', err);
    res.status(500).json({ error: 'Action failed' });
  }
}

/* ---------- Reports and appeals ---------- */
async function reportTarget(req, res) {
  try {
    const { target_type: type, target_id: targetId } = req.body;
    const reason = REPORT_REASONS.includes(req.body.reason) ? req.body.reason : 'other';
    const details = String(req.body.details || '').slice(0, 1000);
    if (!['article', 'comment'].includes(type) || !isUuid(targetId)) {
      return res.status(400).json({ error: 'Invalid report target' });
    }
    const table = type === 'article' ? 'blog_articles' : 'blog_comments';
    const exists = await db.query(`SELECT ${type === 'article' ? 'author_id' : 'user_id'} AS owner FROM ${table} WHERE id = $1`, [targetId]);
    if (!exists.rows.length) return res.status(404).json({ error: 'Content not found' });
    if (exists.rows[0].owner === req.user.id) return res.status(400).json({ error: 'You cannot report your own content.' });

    const inserted = await db.query(
      `INSERT INTO blog_reports (reporter_id, target_type, target_id, reason, details)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
      [req.user.id, type, targetId, reason, details]
    );
    if (!inserted.rowCount) return res.status(409).json({ error: 'You already reported this.' });

    const open = (await db.query(
      `SELECT COUNT(*)::int AS n FROM blog_reports WHERE target_type = $1 AND target_id = $2 AND status = 'open'`,
      [type, targetId])).rows[0].n;
    const severe = ['child_safety', 'sexual'].includes(reason);
    if (open >= AUTO_HIDE_REPORTS || severe) {
      const hidden = type === 'article'
        ? await db.query(`UPDATE blog_articles SET status = 'in_review' WHERE id = $1 AND status = 'published' RETURNING id`, [targetId])
        : await db.query(`UPDATE blog_comments SET status = 'held' WHERE id = $1 AND status = 'visible' RETURNING article_id`, [targetId]);
      if (hidden.rowCount) {
        if (type === 'comment') {
          await db.query('UPDATE blog_articles SET comments_count = GREATEST(0, comments_count - 1) WHERE id = $1', [hidden.rows[0].article_id]);
        }
        await log({ articleId: type === 'article' ? targetId : null, commentId: type === 'comment' ? targetId : null,
          subjectUserId: exists.rows[0].owner, action: 'auto_hidden_by_reports', reason, details: { open_reports: open } });
      }
    }
    res.status(201).json({ message: 'Thank you. Our moderators will review your report.' });
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: 'Failed to send report' });
  }
}

async function appealArticle(req, res) {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Article not found' });
    const message = String(req.body.message || '').trim().slice(0, 2000);
    if (message.length < 10) return res.status(400).json({ error: 'Please explain your appeal (at least 10 characters).' });
    const found = await db.query(
      `SELECT id, status FROM blog_articles WHERE id = $1 AND author_id = $2`, [req.params.id, req.user.id]);
    const article = found.rows[0];
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (!['rejected', 'removed'].includes(article.status)) {
      return res.status(400).json({ error: 'Only rejected or removed articles can be appealed.' });
    }
    const total = (await db.query('SELECT COUNT(*)::int AS n FROM blog_appeals WHERE article_id = $1', [article.id])).rows[0].n;
    if (total >= 3) return res.status(429).json({ error: 'The appeal limit for this article was reached.' });
    try {
      await db.query('INSERT INTO blog_appeals (article_id, author_id, message) VALUES ($1, $2, $3)', [article.id, req.user.id, message]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'You already have an appeal waiting for review.' });
      throw err;
    }
    await log({ articleId: article.id, subjectUserId: req.user.id, actorId: req.user.id, action: 'appeal_submitted' });
    res.status(201).json({ message: 'Your appeal was sent to the moderation team.' });
  } catch (err) {
    console.error('Appeal error:', err);
    res.status(500).json({ error: 'Failed to send appeal' });
  }
}

/* ---------- Admin ---------- */
async function adminStats(req, res) {
  try {
    const result = await db.query(
      `SELECT
        (SELECT COUNT(*)::int FROM blog_articles WHERE status = 'in_review') AS in_review,
        (SELECT COUNT(*)::int FROM blog_reports WHERE status = 'open') AS open_reports,
        (SELECT COUNT(*)::int FROM blog_appeals WHERE status = 'open') AS open_appeals,
        (SELECT COUNT(*)::int FROM blog_comments WHERE status = 'held') AS held_comments,
        (SELECT COUNT(*)::int FROM blog_articles WHERE status = 'published') AS published`
    );
    res.json({ stats: result.rows[0], moderation: { mode: moderationMode(), ai: aiEnabled() } });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
}

async function adminQueue(req, res) {
  try {
    const result = await db.query(
      `SELECT ${ARTICLE_COLUMNS}, a.content_html, a.moderation,
         (SELECT COUNT(*)::int FROM blog_reports r WHERE r.target_type = 'article' AND r.target_id = a.id AND r.status = 'open') AS open_reports,
         u.blog_strikes AS author_strikes
       FROM blog_articles a JOIN users u ON u.id = a.author_id
       WHERE a.status = 'in_review' ORDER BY a.updated_at ASC LIMIT 50`,
      [req.user.id]
    );
    const comments = await db.query(
      `SELECT c.id, c.body, c.moderation, c.created_at, c.article_id, u.username, u.id AS user_id
       FROM blog_comments c JOIN users u ON u.id = c.user_id WHERE c.status = 'held' ORDER BY c.created_at ASC LIMIT 50`
    );
    res.json({ articles: result.rows, comments: comments.rows });
  } catch (err) {
    console.error('Admin queue error:', err);
    res.status(500).json({ error: 'Failed to load queue' });
  }
}

async function adminDecideArticle(req, res) {
  try {
    const { id } = req.params;
    const action = req.params.action;
    if (!isUuid(id) || !['approve', 'reject', 'remove'].includes(action)) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    const reasonText = String(req.body.reason || '').trim().slice(0, 500);
    if (action !== 'approve' && reasonText.length < 3) {
      return res.status(400).json({ error: 'Give a reason for this decision.' });
    }
    const found = await db.query('SELECT id, author_id, status FROM blog_articles WHERE id = $1', [id]);
    const article = found.rows[0];
    if (!article) return res.status(404).json({ error: 'Article not found' });

    const status = action === 'approve' ? 'published' : action === 'reject' ? 'rejected' : 'removed';
    await db.query(
      `UPDATE blog_articles       SET status = $1::text, rejection_reason = $2,
         published_at = CASE WHEN $1::text = 'published' AND published_at IS NULL THEN NOW() ELSE published_at END,
         updated_at = NOW() WHERE id = $3`,
      [status, action === 'approve' ? null : reasonText, id]
    );
    await db.query(
      `UPDATE blog_reports SET status = $1 WHERE target_type = 'article' AND target_id = $2 AND status = 'open'`,
      [action === 'approve' ? 'dismissed' : 'resolved', id]
    );
    await log({ articleId: id, subjectUserId: article.author_id, actorId: req.user.id, action: `admin_${action}`, reason: reasonText || null });
    if (action !== 'approve') await addStrike(article.author_id, id, `admin_${action}`);
    res.json({ status });
  } catch (err) {
    console.error('Admin decide error:', err);
    res.status(500).json({ error: 'Failed to apply decision' });
  }
}

async function adminDecideComment(req, res) {
  try {
    const { commentId, action } = req.params;
    if (!isUuid(commentId) || !['approve', 'remove'].includes(action)) return res.status(400).json({ error: 'Invalid request' });
    const found = await db.query('SELECT id, article_id, user_id, status FROM blog_comments WHERE id = $1', [commentId]);
    const comment = found.rows[0];
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (action === 'approve') {
      if (comment.status === 'held') {
        await db.query(`UPDATE blog_comments SET status = 'visible' WHERE id = $1`, [commentId]);
        await db.query('UPDATE blog_articles SET comments_count = comments_count + 1 WHERE id = $1', [comment.article_id]);
      }
      await db.query(`UPDATE blog_reports SET status = 'dismissed' WHERE target_type = 'comment' AND target_id = $1 AND status = 'open'`, [commentId]);
    } else {
      await removeComment(commentId, req.user.id, true);
      await db.query(`UPDATE blog_reports SET status = 'resolved' WHERE target_type = 'comment' AND target_id = $1 AND status = 'open'`, [commentId]);
      await addStrike(comment.user_id, comment.article_id, 'admin_comment_removed');
    }
    await log({ articleId: comment.article_id, commentId, subjectUserId: comment.user_id, actorId: req.user.id, action: `admin_comment_${action}` });
    res.json({ success: true });
  } catch (err) {
    console.error('Admin comment error:', err);
    res.status(500).json({ error: 'Failed to apply decision' });
  }
}

async function adminReports(req, res) {
  try {
    const result = await db.query(
      `SELECT r.target_type, r.target_id, COUNT(*)::int AS reports, MAX(r.created_at) AS last_report,
         ARRAY_AGG(DISTINCT r.reason) AS reasons,
         COALESCE(a.title, '') AS article_title, COALESCE(a.status, '') AS article_status,
         COALESCE(c.body, '') AS comment_body, COALESCE(c.status, '') AS comment_status
       FROM blog_reports r
       LEFT JOIN blog_articles a ON r.target_type = 'article' AND a.id = r.target_id
       LEFT JOIN blog_comments c ON r.target_type = 'comment' AND c.id = r.target_id
       WHERE r.status = 'open'
       GROUP BY r.target_type, r.target_id, a.title, a.status, c.body, c.status
       ORDER BY reports DESC, last_report DESC LIMIT 100`
    );
    res.json({ reports: result.rows });
  } catch (err) {
    console.error('Admin reports error:', err);
    res.status(500).json({ error: 'Failed to load reports' });
  }
}

async function adminDismissReports(req, res) {
  try {
    const { type, targetId } = req.params;
    if (!['article', 'comment'].includes(type) || !isUuid(targetId)) return res.status(400).json({ error: 'Invalid request' });
    await db.query(`UPDATE blog_reports SET status = 'dismissed' WHERE target_type = $1 AND target_id = $2 AND status = 'open'`, [type, targetId]);
    await log({ articleId: type === 'article' ? targetId : null, commentId: type === 'comment' ? targetId : null,
      actorId: req.user.id, action: 'reports_dismissed' });
    res.json({ success: true });
  } catch (err) {
    console.error('Dismiss reports error:', err);
    res.status(500).json({ error: 'Failed to dismiss' });
  }
}

async function adminAppeals(req, res) {
  try {
    const result = await db.query(
      `SELECT ap.id, ap.message, ap.created_at, ap.article_id, a.title, a.status AS article_status,
         a.rejection_reason, a.moderation, a.content_html, u.username, u.id AS author_id, u.blog_strikes
       FROM blog_appeals ap JOIN blog_articles a ON a.id = ap.article_id JOIN users u ON u.id = ap.author_id
       WHERE ap.status = 'open' ORDER BY ap.created_at ASC LIMIT 50`
    );
    res.json({ appeals: result.rows });
  } catch (err) {
    console.error('Admin appeals error:', err);
    res.status(500).json({ error: 'Failed to load appeals' });
  }
}

async function adminResolveAppeal(req, res) {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ error: 'Appeal not found' });
    const accept = req.body.accept === true;
    const note = String(req.body.note || '').trim().slice(0, 500);
    if (!accept && note.length < 3) return res.status(400).json({ error: 'Explain why the appeal is denied.' });
    const found = await db.query(`SELECT id, article_id, author_id FROM blog_appeals WHERE id = $1 AND status = 'open'`, [id]);
    const appeal = found.rows[0];
    if (!appeal) return res.status(404).json({ error: 'Appeal not found' });
    await db.query(
      `UPDATE blog_appeals SET status = $1, admin_note = $2, resolved_by = $3, resolved_at = NOW() WHERE id = $4`,
      [accept ? 'accepted' : 'denied', note || null, req.user.id, id]
    );
    if (accept) {
      await db.query(
        `UPDATE blog_articles SET status = 'published', rejection_reason = NULL,
           published_at = COALESCE(published_at, NOW()), updated_at = NOW() WHERE id = $1`, [appeal.article_id]);
      await db.query('UPDATE users SET blog_strikes = GREATEST(0, blog_strikes - 1) WHERE id = $1', [appeal.author_id]);
    }
    await log({ articleId: appeal.article_id, subjectUserId: appeal.author_id, actorId: req.user.id,
      action: accept ? 'appeal_accepted' : 'appeal_denied', reason: note || null });
    res.json({ success: true });
  } catch (err) {
    console.error('Resolve appeal error:', err);
    res.status(500).json({ error: 'Failed to resolve appeal' });
  }
}

async function adminLogs(req, res) {
  try {
    const result = await db.query(
      `SELECT l.id, l.action, l.reason, l.details, l.created_at, l.article_id,
         actor.username AS actor_username, subj.username AS subject_username, a.title AS article_title
       FROM blog_moderation_logs l
       LEFT JOIN users actor ON actor.id = l.actor_id
       LEFT JOIN users subj ON subj.id = l.subject_user_id
       LEFT JOIN blog_articles a ON a.id = l.article_id
       ORDER BY l.created_at DESC LIMIT 150`
    );
    res.json({ logs: result.rows });
  } catch (err) {
    console.error('Admin logs error:', err);
    res.status(500).json({ error: 'Failed to load logs' });
  }
}

async function adminUsers(req, res) {
  try {
    const q = String(req.query.q || '').trim().slice(0, 50);
    const result = await db.query(
      `SELECT id, username, display_name, blog_strikes, blog_banned_until, suspended_until, suspension_reason, is_admin
       FROM users
       WHERE ($1 = '' OR username ILIKE $2 OR display_name ILIKE $2)
         AND ($1 <> '' OR blog_strikes > 0 OR suspended_until > NOW() OR blog_banned_until > NOW())
       ORDER BY blog_strikes DESC, username LIMIT 50`,
      [q, `%${escapeLike(q)}%`]
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
}

async function adminSuspendUser(req, res) {
  try {
    const { userId } = req.params;
    if (!isUuid(userId)) return res.status(404).json({ error: 'User not found' });
    if (userId === req.user.id) return res.status(400).json({ error: 'You cannot suspend yourself.' });
    const target = await getUserState(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.is_admin) return res.status(403).json({ error: 'Administrators cannot be suspended here.' });

    const lift = req.body.lift === true;
    const days = clampInt(req.body.days, 0, 3650, 0);
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (!lift && reason.length < 3) return res.status(400).json({ error: 'Give a reason for the suspension.' });

    if (lift) {
      await db.query(`UPDATE users SET suspended_until = NULL, suspension_reason = NULL, blog_banned_until = NULL WHERE id = $1`, [userId]);
    } else {
      await db.query(
        `UPDATE users SET suspended_until = CASE WHEN $2::int = 0 THEN 'infinity'::timestamptz ELSE NOW() + ($2 || ' days')::interval END,
           suspension_reason = $3 WHERE id = $1`,
        [userId, days, reason]
      );
    }
    await log({ subjectUserId: userId, actorId: req.user.id, action: lift ? 'user_unsuspended' : 'user_suspended',
      reason, details: { days: lift ? null : days || 'permanent' } });
    res.json({ success: true });
  } catch (err) {
    console.error('Suspend user error:', err);
    res.status(500).json({ error: 'Failed to update the account' });
  }
}

module.exports = {
  requireWriter, requireAdmin,
  getMeta, uploadBlogImage, lastBlogUpload, embedUrl,
  listArticles, trendingTags, myArticles, myBookmarks, getArticle,
  saveArticle, submitArticle, unpublishArticle, deleteArticle,
  toggleLike, toggleBookmark, shareArticle,
  listComments, addComment, deleteComment,
  getAuthor, toggleFollow, reportTarget, appealArticle,
  adminStats, adminQueue, adminDecideArticle, adminDecideComment, adminReports, adminDismissReports,
  adminAppeals, adminResolveAppeal, adminLogs, adminUsers, adminSuspendUser
};

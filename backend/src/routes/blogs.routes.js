const express = require('express');
const router = express.Router();
const upload = require('../config/multer.config');
const { authenticateToken } = require('../middleware/auth.middleware');
const { rateLimiter } = require('../security/security.middleware');
const c = require('../controllers/blogs.controller');

router.use(authenticateToken);

router.get('/meta', c.getMeta);
router.get('/tags/trending', c.trendingTags);
router.get('/mine', c.myArticles);
router.get('/bookmarks', c.myBookmarks);

const blogUpload = (req, res, next) => upload.blog.single('image')(req, res, err => {
  if (!err) return next();
  const message = err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large (images up to 15 MB, videos up to 50 MB).' : err.message;
  res.status(400).json({ error: message || 'Upload failed' });
});

router.post('/media', rateLimiter({ windowMs: 10 * 60 * 1000, max: 40 }), c.requireWriter, blogUpload, c.uploadBlogImage);
router.get('/media/last', c.requireWriter, c.lastBlogUpload);
router.post('/embed', c.requireWriter, c.embedUrl);
router.post('/report', rateLimiter({ windowMs: 10 * 60 * 1000, max: 30 }), c.reportTarget);
router.delete('/comments/:commentId', c.deleteComment);
router.get('/authors/:userId', c.getAuthor);
router.post('/authors/:userId/follow', c.toggleFollow);

// Administrator-only moderation dashboard API
router.get('/admin/stats', c.requireAdmin, c.adminStats);
router.get('/admin/queue', c.requireAdmin, c.adminQueue);
router.post('/admin/articles/:id/:action', c.requireAdmin, c.adminDecideArticle);
router.post('/admin/comments/:commentId/:action', c.requireAdmin, c.adminDecideComment);
router.get('/admin/reports', c.requireAdmin, c.adminReports);
router.post('/admin/reports/:type/:targetId/dismiss', c.requireAdmin, c.adminDismissReports);
router.get('/admin/appeals', c.requireAdmin, c.adminAppeals);
router.post('/admin/appeals/:id/resolve', c.requireAdmin, c.adminResolveAppeal);
router.get('/admin/logs', c.requireAdmin, c.adminLogs);
router.get('/admin/users', c.requireAdmin, c.adminUsers);
router.post('/admin/users/:userId/suspend', c.requireAdmin, c.adminSuspendUser);

router.get('/', c.listArticles);
router.post('/', c.requireWriter, c.saveArticle);
router.get('/:id', c.getArticle);
router.put('/:id', c.requireWriter, c.saveArticle);
router.delete('/:id', c.deleteArticle);
router.post('/:id/publish', rateLimiter({ windowMs: 60 * 60 * 1000, max: 30 }), c.requireWriter, c.submitArticle);
router.post('/:id/unpublish', c.unpublishArticle);
router.post('/:id/like', c.toggleLike);
router.post('/:id/bookmark', c.toggleBookmark);
router.post('/:id/share', c.shareArticle);
router.get('/:id/comments', c.listComments);
router.post('/:id/comments', c.requireWriter, c.addComment);
router.post('/:id/appeal', c.requireWriter, c.appealArticle);

module.exports = router;

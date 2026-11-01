const express = require('express');
const router = express.Router();
const upload = require('../config/multer.config');
const { authenticateToken } = require('../middleware/auth.middleware');
const {
  updatePostPrivacy,
  createPost,
  deletePost,
  getFeed,
  toggleLike,
  getComments,
  addComment
} = require('../controllers/posts.controller');

router.get('/feed', authenticateToken, getFeed);
router.post('/upload', authenticateToken, upload.single('media'), createPost);
router.patch('/:postId/privacy', authenticateToken, updatePostPrivacy);
router.delete('/:postId', authenticateToken, deletePost);
router.post('/:postId/like', authenticateToken, toggleLike);
router.get('/:postId/comments', authenticateToken, getComments);
router.post('/:postId/comments', authenticateToken, addComment);

module.exports = router;
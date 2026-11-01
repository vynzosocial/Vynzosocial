const express = require('express');
const router = express.Router();
const upload = require('../config/multer.config');
const { authenticateToken } = require('../middleware/auth.middleware');
const {
  createStory,
  getStories,
  viewStory,
  toggleStoryLike,
  getStoryComments,
  addStoryComment,
  deleteStory,
  moderateRemoveStory,
  updateStoryPrivacy
} = require('../controllers/stories.controller');

router.get('/', authenticateToken, getStories);
router.post('/upload', authenticateToken, upload.single('media'), createStory);
router.post('/:storyId/view', authenticateToken, viewStory);
router.post('/:storyId/like', authenticateToken, toggleStoryLike);
router.get('/:storyId/comments', authenticateToken, getStoryComments);
router.post('/:storyId/comments', authenticateToken, addStoryComment);
router.delete('/:storyId', authenticateToken, deleteStory);
router.patch('/:storyId/privacy', authenticateToken, updateStoryPrivacy);
router.post('/:storyId/moderate', authenticateToken, moderateRemoveStory);

module.exports = router;
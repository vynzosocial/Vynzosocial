const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const upload = require('../config/multer.config');
const {
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
} = require('../controllers/users.controller');

router.get('/friends', authenticateToken, getFriends);
router.get('/follow-requests', authenticateToken, getFollowRequests);
router.get('/search', authenticateToken, searchUsers);
router.get('/connections', authenticateToken, getConnections);
router.patch('/me/profile', authenticateToken, updateMyProfile);
router.patch('/me/privacy', authenticateToken, updateMyPrivacy);
router.put('/me/avatar', authenticateToken, (req, res, next) => {
  upload.avatar.single('avatar')(req, res, err => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Could not upload profile photo.' });
    }
    next();
  });
}, updateMyAvatar);
router.get('/:userId/profile', authenticateToken, getUserProfile);
router.post('/:userId/follow', authenticateToken, followUser);
router.delete('/:userId/follow', authenticateToken, unfollowUser);

module.exports = router;

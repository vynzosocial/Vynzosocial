const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const { reportContent, blockUser } = require('../controllers/moderation.controller');

router.post('/report', authenticateToken, reportContent);
router.post('/block/:blockedId', authenticateToken, blockUser);

module.exports = router;
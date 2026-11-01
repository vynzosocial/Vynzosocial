const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const { getActiveLiveStreams, startLiveSession, endLiveSession, updateLiveTitle } = require('../controllers/live.controller');

router.get('/', getActiveLiveStreams);
router.post('/start', authenticateToken, startLiveSession);
router.patch('/:sessionId/title', authenticateToken, updateLiveTitle);
router.post('/:sessionId/end', authenticateToken, endLiveSession);

module.exports = router;
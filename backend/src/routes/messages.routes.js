const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const {
  getUserConversations,
  getConversationMessages,
  sendConversationMessage,
  sendViewOncePhoto,
  openViewOncePhoto,
  deleteConversationMessage,
  clearConversation,
  markConversationRead,
  createConversation
} = require('../controllers/messages.controller');

const upload = require('../config/multer.config');

function uploadMessageMedia(req, res, next) {
  upload.single('media')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || 'Could not upload this file' });
    next();
  });
}

function uploadViewOnce(req, res, next) {
  upload.viewOnce.single('photo')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || 'Could not upload this photo' });
    next();
  });
}

router.get('/', authenticateToken, getUserConversations);
router.get('/:conversationId/messages', authenticateToken, getConversationMessages);
router.post('/:conversationId/view-once', authenticateToken, uploadViewOnce, sendViewOncePhoto);
router.post('/:conversationId/messages/:messageId/view-once', authenticateToken, openViewOncePhoto);
router.post('/:conversationId/messages', authenticateToken, uploadMessageMedia, sendConversationMessage);
router.delete('/:conversationId/messages', authenticateToken, clearConversation);
router.post('/:conversationId/read', authenticateToken, markConversationRead);
router.delete('/:conversationId/messages/:messageId', authenticateToken, deleteConversationMessage);
router.post('/conversations', authenticateToken, createConversation);

module.exports = router;
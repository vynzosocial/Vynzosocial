const db = require('../database/db');

async function reportContent(req, res) {
  try {
    const reporterId = req.user.id;
    const { target_type, target_id, reason } = req.body;

    if (!target_type || !target_id || !reason) {
      return res.status(400).json({ error: 'Target type, target ID, and reason are required' });
    }

    const query = `
      INSERT INTO reports (reporter_id, target_type, target_id, reason)
      VALUES ($1, $2, $3, $4)
      RETURNING id, target_type, target_id, status, created_at
    `;
    const result = await db.query(query, [reporterId, target_type, target_id, reason]);
    res.status(201).json({ message: 'Report submitted successfully. Our moderation team will review it.', report: result.rows[0] });
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: 'Failed to submit report' });
  }
}

async function blockUser(req, res) {
  try {
    const blockerId = req.user.id;
    const { blockedId } = req.params;

    if (blockerId === blockedId) {
      return res.status(400).json({ error: 'You cannot block yourself' });
    }

    await db.query(
      'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [blockerId, blockedId]
    );

    res.json({ message: 'User blocked successfully' });
  } catch (err) {
    console.error('Block error:', err);
    res.status(500).json({ error: 'Failed to block user' });
  }
}

module.exports = { reportContent, blockUser };
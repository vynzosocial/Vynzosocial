const jwt = require('jsonwebtoken');
const { SupabaseAuthError, getUserWithAccessToken } = require('../services/supabase-auth');
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required. Configure it in backend/.env before starting the server.');
}

async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access token required' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
    return;
  } catch {
    // Supabase access tokens are validated by Auth; legacy app JWTs remain accepted during rollout.
  }

  try {
    const user = await getUserWithAccessToken(token);
    if (!user.id) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = { id: user.id };
    return next();
  } catch (err) {
    if (err instanceof SupabaseAuthError && [401, 403].includes(err.status)) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    console.error('Supabase session verification error:', err);
    return res.status(503).json({ error: 'Unable to verify your session right now.' });
  }
}

module.exports = { authenticateToken, JWT_SECRET };
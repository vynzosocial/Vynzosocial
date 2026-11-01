// Simple in-memory rate limiter; each limiter keeps its own counters

function rateLimiter(options = { windowMs: 15 * 60 * 1000, max: 100 }) {
  const requestCounts = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, data] of requestCounts) {
      if (now > data.resetTime) requestCounts.delete(key);
    }
  }, options.windowMs).unref();

  return (req, res, next) => {
    if (req.method === 'OPTIONS') return next();

    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();

    if (!requestCounts.has(ip)) {
      requestCounts.set(ip, { count: 1, resetTime: now + options.windowMs });
      return next();
    }

    const clientData = requestCounts.get(ip);
    if (now > clientData.resetTime) {
      clientData.count = 1;
      clientData.resetTime = now + options.windowMs;
      return next();
    }

    if (clientData.count >= options.max) {
      return res.status(429).json({ error: 'Too many requests, please try again later.' });
    }

    clientData.count++;
    next();
  };
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
}

module.exports = { rateLimiter, securityHeaders };
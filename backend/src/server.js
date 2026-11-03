require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const authRoutes = require('./routes/auth.routes');
const postsRoutes = require('./routes/posts.routes');
const storiesRoutes = require('./routes/stories.routes');
const messagesRoutes = require('./routes/messages.routes');
const liveRoutes = require('./routes/live.routes');
const moderationRoutes = require('./routes/moderation.routes');
const usersRoutes = require('./routes/users.routes');
const blogsRoutes = require('./routes/blogs.routes');

const { JWT_SECRET } = require('./middleware/auth.middleware');
const { rateLimiter, securityHeaders } = require('./security/security.middleware');
const { registerChatHandlers } = require('./realtime/chat.socket');
const { registerLiveHandlers, restoreLivePresence } = require('./realtime/live.socket');
const { registerCallHandlers } = require('./realtime/call.socket');

const app = express();
const server = http.createServer(app);
const cloudStorage = require('./config/storage');
const { validateAuthConfig } = require('./services/supabase-auth');
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
app.set('io', io);

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next();

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return next(new Error('Invalid or expired token'));
    socket.user = user;
    next();
  });
});

// Production Security Hardening
const generalApiLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 5000 });
app.use(securityHeaders);
app.use(cors());
app.use('/api/blogs', express.json({ limit: '1mb' }));
app.use(express.json());

// Strict limit only for login/register; normal API use gets a generous limit
app.use('/api/auth', rateLimiter({ windowMs: 15 * 60 * 1000, max: 200 }));
app.use('/api', (req, res, next) => (
  req.path.startsWith('/auth') ? next() : generalApiLimiter(req, res, next)
));

app.get('/uploads/:name', (req, res) => res.redirect(302, cloudStorage.publicUrl(req.params.name)));

// Mount API Routes
app.use('/api/auth', authRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/stories', storiesRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/live', liveRoutes);
app.use('/api/moderation', moderationRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/blogs', blogsRoutes);

// Health check route
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', platform: 'Vynzo API v1.0' });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  registerChatHandlers(socket);
  registerLiveHandlers(io, socket);
  registerCallHandlers(io, socket);

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;
validateAuthConfig();
cloudStorage.ensureBuckets()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Vynzo production-ready server running on port ${PORT}`);
      restoreLivePresence(io);
      require('./services/blog-autoreview').startBlogAutoReview();
    });
  })
  .catch(err => {
    console.error('Unable to initialize Supabase Storage:', err);
    process.exitCode = 1;
  });
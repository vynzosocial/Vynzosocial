require('dotenv').config();
const { pool } = require('./db');

const migrationSchema = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    bio TEXT,
    avatar_url TEXT,
    is_private BOOLEAN DEFAULT FALSE,
    message_privacy VARCHAR(10) NOT NULL DEFAULT 'everyone',
    is_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS message_privacy VARCHAR(10) NOT NULL DEFAULT 'everyone';

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS allow_calls BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS posts_privacy VARCHAR(10) NOT NULL DEFAULT 'everyone';

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS following_privacy VARCHAR(10) NOT NULL DEFAULT 'everyone';

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS age_confirmed_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS terms_version VARCHAR(20);

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS first_name VARCHAR(60),
    ADD COLUMN IF NOT EXISTS last_name VARCHAR(60),
    ADD COLUMN IF NOT EXISTS birth_date DATE,
    ADD COLUMN IF NOT EXISTS nationality VARCHAR(80);

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users (phone) WHERE phone IS NOT NULL;

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS view_once BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS view_once_path TEXT,
    ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMP WITH TIME ZONE;

CREATE SCHEMA IF NOT EXISTS vynzo_private;
REVOKE ALL ON SCHEMA vynzo_private FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA vynzo_private FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SCHEMA vynzo_private FROM authenticated;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS vynzo_private.user_identifiers (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    vynzo_id VARCHAR(38) NOT NULL UNIQUE
      DEFAULT ('vynzo_' || replace(uuid_generate_v4()::text, '-', '')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE vynzo_private.user_identifiers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE vynzo_private.user_identifiers FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE vynzo_private.user_identifiers FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE vynzo_private.user_identifiers FROM authenticated;
  END IF;
END $$;

INSERT INTO vynzo_private.user_identifiers (user_id)
SELECT id FROM users
ON CONFLICT (user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS follows (
    follower_id UUID REFERENCES users(id) ON DELETE CASCADE,
    following_id UUID REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'accepted',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (follower_id, following_id)
);

CREATE TABLE IF NOT EXISTS posts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    caption TEXT,
    media_type VARCHAR(20) NOT NULL,
    media_url TEXT NOT NULL,
    thumbnail_url TEXT,
    views_count INT DEFAULT 0,
    likes_count INT DEFAULT 0,
    comments_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS likes (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    is_group BOOLEAN DEFAULT FALSE,
    group_name VARCHAR(100),
    group_avatar TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'member',
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(id) ON DELETE CASCADE,
    content TEXT,
    media_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    media_type VARCHAR(20) NOT NULL,
    media_url TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours'),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS story_views (
    story_id UUID REFERENCES stories(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    viewed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (story_id, user_id)
);

CREATE TABLE IF NOT EXISTS story_likes (
    story_id UUID REFERENCES stories(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (story_id, user_id)
);

CREATE TABLE IF NOT EXISTS story_comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    story_id UUID REFERENCES stories(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS live_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    host_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    category VARCHAR(100) DEFAULT 'General',
    is_active BOOLEAN DEFAULT TRUE,
    viewer_count INT DEFAULT 0,
    chat_background_color VARCHAR(7) NOT NULL DEFAULT '#1a1b22',
    chat_font_color VARCHAR(7) NOT NULL DEFAULT '#ffffff',
    chat_font_size SMALLINT NOT NULL DEFAULT 13,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE live_sessions
    ADD COLUMN IF NOT EXISTS chat_background_color VARCHAR(7) NOT NULL DEFAULT '#1a1b22',
    ADD COLUMN IF NOT EXISTS chat_font_color VARCHAR(7) NOT NULL DEFAULT '#ffffff',
    ADD COLUMN IF NOT EXISTS chat_font_size SMALLINT NOT NULL DEFAULT 13;

CREATE TABLE IF NOT EXISTS live_chat_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    live_session_id UUID REFERENCES live_sessions(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    guest_username VARCHAR(24),
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE live_chat_messages
    ADD COLUMN IF NOT EXISTS guest_username VARCHAR(24);

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS read_receipts BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE posts
    ADD COLUMN IF NOT EXISTS is_protected BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE posts
    ADD COLUMN IF NOT EXISTS privacy TEXT NOT NULL DEFAULT 'everyone';

ALTER TABLE stories
    ADD COLUMN IF NOT EXISTS is_protected BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE stories
    ADD COLUMN IF NOT EXISTS privacy TEXT NOT NULL DEFAULT 'everyone';

CREATE TABLE IF NOT EXISTS story_moderation_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    media_type VARCHAR(20),
    action VARCHAR(40) NOT NULL,
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE story_moderation_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON story_moderation_logs FROM anon, authenticated;

ALTER TABLE conversation_members
    ADD COLUMN IF NOT EXISTS cleared_at TIMESTAMP WITH TIME ZONE;

-- Messages that existed before read tracking are treated as already read.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversation_members' AND column_name = 'last_read_at'
  ) THEN
    ALTER TABLE conversation_members ADD COLUMN last_read_at TIMESTAMP WITH TIME ZONE;
    UPDATE conversation_members SET last_read_at = CURRENT_TIMESTAMP;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reporter_id UUID REFERENCES users(id) ON DELETE CASCADE,
    target_type VARCHAR(50) NOT NULL,
    target_id UUID NOT NULL,
    reason TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS blocks (
    blocker_id UUID REFERENCES users(id) ON DELETE CASCADE,
    blocked_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (blocker_id, blocked_id)
);

-- ===== Vynzo Blogs =====
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS suspension_reason TEXT,
    ADD COLUMN IF NOT EXISTS blog_strikes INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS blog_banned_until TIMESTAMP WITH TIME ZONE;

CREATE TABLE IF NOT EXISTS blog_articles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    excerpt TEXT NOT NULL DEFAULT '',
    content_html TEXT NOT NULL DEFAULT '',
    content_text TEXT NOT NULL DEFAULT '',
    cover_url TEXT,
    category VARCHAR(40) NOT NULL DEFAULT 'general',
    tags TEXT[] NOT NULL DEFAULT '{}',
    language VARCHAR(5) NOT NULL DEFAULT 'en',
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','pending','in_review','published','rejected','removed')),
    has_embeds BOOLEAN NOT NULL DEFAULT FALSE,
    content_hash VARCHAR(64),
    moderation JSONB NOT NULL DEFAULT '{}'::jsonb,
    rejection_reason TEXT,
    views_count INTEGER NOT NULL DEFAULT 0,
    likes_count INTEGER NOT NULL DEFAULT 0,
    comments_count INTEGER NOT NULL DEFAULT 0,
    shares_count INTEGER NOT NULL DEFAULT 0,
    bookmarks_count INTEGER NOT NULL DEFAULT 0,
    published_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_blog_articles_status_pub ON blog_articles (status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_articles_author ON blog_articles (author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_articles_category ON blog_articles (category) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_blog_articles_tags ON blog_articles USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_blog_articles_hash ON blog_articles (content_hash);

CREATE TABLE IF NOT EXISTS blog_likes (
    article_id UUID NOT NULL REFERENCES blog_articles(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (article_id, user_id)
);

CREATE TABLE IF NOT EXISTS blog_bookmarks (
    article_id UUID NOT NULL REFERENCES blog_articles(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (article_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_blog_bookmarks_user ON blog_bookmarks (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS blog_comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    article_id UUID NOT NULL REFERENCES blog_articles(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','held','removed')),
    moderation JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_blog_comments_article ON blog_comments (article_id, created_at);

CREATE TABLE IF NOT EXISTS blog_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type VARCHAR(10) NOT NULL CHECK (target_type IN ('article','comment')),
    target_id UUID NOT NULL,
    reason VARCHAR(40) NOT NULL,
    details TEXT,
    status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (reporter_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_blog_reports_target ON blog_reports (target_type, target_id, status);

CREATE TABLE IF NOT EXISTS blog_appeals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    article_id UUID NOT NULL REFERENCES blog_articles(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','denied')),
    admin_note TEXT,
    resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP WITH TIME ZONE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_appeals_open ON blog_appeals (article_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS blog_moderation_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    article_id UUID REFERENCES blog_articles(id) ON DELETE SET NULL,
    comment_id UUID,
    subject_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(40) NOT NULL,
    reason TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_blog_mod_logs_created ON blog_moderation_logs (created_at DESC);

-- The API is the only way to reach these tables. RLS with no policies denies direct
-- Data API access; the backend's owner connection bypasses RLS.
ALTER TABLE blog_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_appeals ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_moderation_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON blog_articles, blog_likes, blog_bookmarks, blog_comments, blog_reports, blog_appeals, blog_moderation_logs FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON blog_articles, blog_likes, blog_bookmarks, blog_comments, blog_reports, blog_appeals, blog_moderation_logs FROM authenticated;
  END IF;
END $$;
`;

async function runMigrations() {
  try {
    console.log('Running database migrations...');
    await pool.query(migrationSchema);
    console.log('Database migrations completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

runMigrations();
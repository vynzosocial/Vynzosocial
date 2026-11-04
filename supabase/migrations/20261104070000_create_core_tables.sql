-- Core Vynzo tables used by the vynzo-api Edge Function (previously created by the retired Express backend).
-- Idempotent: safe to run on a database that already has some of these objects.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS bio text,
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS is_private boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_verified boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS message_privacy varchar(10) NOT NULL DEFAULT 'everyone',
  ADD COLUMN IF NOT EXISTS allow_calls boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS posts_privacy varchar(10) NOT NULL DEFAULT 'everyone',
  ADD COLUMN IF NOT EXISTS following_privacy varchar(10) NOT NULL DEFAULT 'everyone',
  ADD COLUMN IF NOT EXISTS read_receipts boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS public.follows (
  follower_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  following_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  status varchar(20) DEFAULT 'accepted',
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_id, following_id)
);

CREATE TABLE IF NOT EXISTS public.posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  caption text,
  media_type varchar(20) NOT NULL,
  media_url text NOT NULL,
  thumbnail_url text,
  views_count int DEFAULT 0,
  likes_count int DEFAULT 0,
  comments_count int DEFAULT 0,
  is_protected boolean NOT NULL DEFAULT false,
  privacy text NOT NULL DEFAULT 'everyone',
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.likes (
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  post_id uuid REFERENCES public.posts(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS public.comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.comments(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  is_group boolean DEFAULT false,
  group_name varchar(100),
  group_avatar text,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.conversation_members (
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  role varchar(20) DEFAULT 'member',
  joined_at timestamptz DEFAULT CURRENT_TIMESTAMP,
  cleared_at timestamptz,
  last_read_at timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  content text,
  media_url text,
  view_once boolean NOT NULL DEFAULT false,
  view_once_path text,
  viewed_at timestamptz,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.stories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  media_type varchar(20) NOT NULL,
  media_url text NOT NULL,
  is_protected boolean NOT NULL DEFAULT false,
  privacy text NOT NULL DEFAULT 'everyone',
  expires_at timestamptz DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours'),
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.story_views (
  story_id uuid REFERENCES public.stories(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  viewed_at timestamptz DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (story_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.story_likes (
  story_id uuid REFERENCES public.stories(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (story_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.story_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid REFERENCES public.stories(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.story_moderation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  media_type varchar(20),
  action varchar(40) NOT NULL,
  reason text,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.live_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  title varchar(255) NOT NULL,
  category varchar(100) DEFAULT 'General',
  is_active boolean DEFAULT true,
  viewer_count int DEFAULT 0,
  chat_background_color varchar(7) NOT NULL DEFAULT '#1a1b22',
  chat_font_color varchar(7) NOT NULL DEFAULT '#ffffff',
  chat_font_size smallint NOT NULL DEFAULT 13,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.live_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  live_session_id uuid REFERENCES public.live_sessions(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  guest_username varchar(24),
  content text NOT NULL,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  target_type varchar(50) NOT NULL,
  target_id uuid NOT NULL,
  reason text NOT NULL,
  status varchar(20) DEFAULT 'pending',
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.blocks (
  blocker_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  blocked_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS follows_following_idx ON public.follows (following_id, status);
CREATE INDEX IF NOT EXISTS posts_user_created_idx ON public.posts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS comments_post_idx ON public.comments (post_id, created_at);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON public.messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS conversation_members_user_idx ON public.conversation_members (user_id);
CREATE INDEX IF NOT EXISTS stories_user_expires_idx ON public.stories (user_id, expires_at);
CREATE INDEX IF NOT EXISTS live_chat_session_idx ON public.live_chat_messages (live_session_id, created_at);

-- The Edge Function uses the service role; browsers must not reach these tables directly.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.story_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.story_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.story_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.story_moderation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;

NOTIFY pgrst, 'reload schema';

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT,
  ADD COLUMN IF NOT EXISTS blog_strikes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS blog_banned_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.blog_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  content_html TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL DEFAULT '',
  cover_url TEXT,
  category VARCHAR(40) NOT NULL DEFAULT 'general',
  tags TEXT[] NOT NULL DEFAULT '{}',
  language VARCHAR(5) NOT NULL DEFAULT 'en',
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','in_review','published','rejected','removed')),
  has_embeds BOOLEAN NOT NULL DEFAULT FALSE,
  content_hash VARCHAR(64),
  moderation JSONB NOT NULL DEFAULT '{}'::jsonb,
  rejection_reason TEXT,
  views_count INTEGER NOT NULL DEFAULT 0,
  likes_count INTEGER NOT NULL DEFAULT 0,
  comments_count INTEGER NOT NULL DEFAULT 0,
  shares_count INTEGER NOT NULL DEFAULT 0,
  bookmarks_count INTEGER NOT NULL DEFAULT 0,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_blog_articles_status_pub ON public.blog_articles (status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_articles_author ON public.blog_articles (author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_articles_category ON public.blog_articles (category) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_blog_articles_tags ON public.blog_articles USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_blog_articles_hash ON public.blog_articles (content_hash);

CREATE TABLE IF NOT EXISTS public.blog_likes (
  article_id UUID NOT NULL REFERENCES public.blog_articles(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (article_id, user_id)
);
CREATE TABLE IF NOT EXISTS public.blog_bookmarks (
  article_id UUID NOT NULL REFERENCES public.blog_articles(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (article_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_blog_bookmarks_user ON public.blog_bookmarks (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.blog_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID NOT NULL REFERENCES public.blog_articles(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','held','removed')),
  moderation JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_blog_comments_article ON public.blog_comments (article_id, created_at);

CREATE TABLE IF NOT EXISTS public.blog_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  target_type VARCHAR(10) NOT NULL CHECK (target_type IN ('article','comment')),
  target_id UUID NOT NULL,
  reason VARCHAR(40) NOT NULL,
  details TEXT,
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (reporter_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_blog_reports_target ON public.blog_reports (target_type, target_id, status);

CREATE TABLE IF NOT EXISTS public.blog_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID NOT NULL REFERENCES public.blog_articles(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','denied')),
  admin_note TEXT,
  resolved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_appeals_open ON public.blog_appeals (article_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS public.blog_moderation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID REFERENCES public.blog_articles(id) ON DELETE SET NULL,
  comment_id UUID,
  subject_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  action VARCHAR(40) NOT NULL,
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_blog_mod_logs_created ON public.blog_moderation_logs (created_at DESC);

ALTER TABLE public.blog_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_appeals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_moderation_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.blog_articles, public.blog_likes, public.blog_bookmarks, public.blog_comments,
  public.blog_reports, public.blog_appeals, public.blog_moderation_logs FROM PUBLIC;
REVOKE ALL ON public.blog_articles, public.blog_likes, public.blog_bookmarks, public.blog_comments,
  public.blog_reports, public.blog_appeals, public.blog_moderation_logs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.blog_articles, public.blog_likes, public.blog_bookmarks,
  public.blog_comments, public.blog_reports, public.blog_appeals, public.blog_moderation_logs TO service_role;

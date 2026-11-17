ALTER TABLE public.posts
  ADD COLUMN allow_repost boolean NOT NULL DEFAULT true;

CREATE TABLE public.post_reposts (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);

CREATE INDEX post_reposts_post_id_idx ON public.post_reposts (post_id);
CREATE INDEX post_reposts_user_created_idx ON public.post_reposts (user_id, created_at DESC);

ALTER TABLE public.post_reposts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.post_reposts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.post_reposts TO service_role;
-- Activity feed for the signed-in user: likes on their posts, stories and blogs plus new followers.
CREATE OR REPLACE FUNCTION public.get_my_activity(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  me uuid := (SELECT auth.uid());
  max_rows integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  result jsonb;
BEGIN
  IF me IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(jsonb_agg(item ORDER BY (item->>'created_at') DESC), '[]'::jsonb)
  INTO result
  FROM (
    SELECT * FROM (
      SELECT jsonb_build_object(
        'kind', CASE WHEN p.media_type = 'video' THEN 'video' ELSE 'image' END,
        'target_id', p.id,
        'preview', COALESCE(p.thumbnail_url, p.media_url),
        'title', left(COALESCE(p.caption, ''), 80),
        'actor_id', u.id,
        'username', u.username,
        'display_name', u.display_name,
        'avatar_url', u.avatar_url,
        'created_at', l.created_at
      ) AS item, l.created_at
      FROM public.likes AS l
      JOIN public.posts AS p ON p.id = l.post_id
      JOIN public.users AS u ON u.id = l.user_id
      WHERE p.user_id = me AND l.user_id <> me
      ORDER BY l.created_at DESC
      LIMIT max_rows
    ) AS post_likes
    UNION ALL
    SELECT * FROM (
      SELECT jsonb_build_object(
        'kind', 'story',
        'target_id', s.id,
        'preview', CASE WHEN s.media_type = 'image' THEN s.media_url ELSE NULL END,
        'title', '',
        'actor_id', u.id,
        'username', u.username,
        'display_name', u.display_name,
        'avatar_url', u.avatar_url,
        'created_at', l.created_at
      ), l.created_at
      FROM public.story_likes AS l
      JOIN public.stories AS s ON s.id = l.story_id
      JOIN public.users AS u ON u.id = l.user_id
      WHERE s.user_id = me AND l.user_id <> me
      ORDER BY l.created_at DESC
      LIMIT max_rows
    ) AS story_likes_recent
    UNION ALL
    SELECT * FROM (
      SELECT jsonb_build_object(
        'kind', 'blog',
        'target_id', a.id,
        'preview', a.cover_url,
        'title', left(COALESCE(a.title, ''), 80),
        'actor_id', u.id,
        'username', u.username,
        'display_name', u.display_name,
        'avatar_url', u.avatar_url,
        'created_at', l.created_at
      ), l.created_at
      FROM public.blog_likes AS l
      JOIN public.blog_articles AS a ON a.id = l.article_id
      JOIN public.users AS u ON u.id = l.user_id
      WHERE a.author_id = me AND l.user_id <> me
      ORDER BY l.created_at DESC
      LIMIT max_rows
    ) AS blog_likes_recent
    UNION ALL
    SELECT * FROM (
      SELECT jsonb_build_object(
        'kind', 'follow',
        'target_id', NULL,
        'preview', NULL,
        'title', '',
        'actor_id', u.id,
        'username', u.username,
        'display_name', u.display_name,
        'avatar_url', u.avatar_url,
        'created_at', f.created_at
      ), f.created_at
      FROM public.follows AS f
      JOIN public.users AS u ON u.id = f.follower_id
      WHERE f.following_id = me AND f.status = 'accepted' AND f.follower_id <> me
      ORDER BY f.created_at DESC
      LIMIT max_rows
    ) AS new_followers
  ) AS merged;

  RETURN (
    SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'created_at') DESC), '[]'::jsonb)
    FROM (SELECT e FROM jsonb_array_elements(result) AS e ORDER BY (e->>'created_at') DESC LIMIT max_rows) AS top
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_activity(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_activity(integer) TO authenticated;

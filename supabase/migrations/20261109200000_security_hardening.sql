-- The Edge Function is the only supported data access path.  RLS alone is
-- insufficient on installations with policies left over from older backends.
DO $hardening$
DECLARE
  table_name text;
  columns text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users', 'follows', 'posts', 'likes', 'comments', 'conversations',
    'conversation_members', 'messages', 'stories', 'story_views', 'story_likes',
    'story_comments', 'story_moderation_logs', 'live_sessions', 'live_chat_messages',
    'reports', 'blocks', 'live_session_invites', 'blog_articles', 'blog_likes',
    'blog_bookmarks', 'blog_comments', 'blog_reports', 'blog_appeals',
    'blog_moderation_logs', 'media_moderation', 'moderation_notices',
    'problem_report_limits', 'push_devices'
  ] LOOP
    IF pg_catalog.to_regclass(pg_catalog.format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', table_name);
      SELECT pg_catalog.string_agg(pg_catalog.format('%I', a.attname), ', ' ORDER BY a.attnum)
        INTO columns
        FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid = pg_catalog.to_regclass(pg_catalog.format('public.%I', table_name))
          AND a.attnum > 0 AND NOT a.attisdropped;
      IF columns IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) ON TABLE public.%2$I FROM PUBLIC, anon, authenticated',
          columns, table_name
        );
      END IF;
    END IF;
  END LOOP;
END
$hardening$;

-- The identifier table is an existing prerequisite of the profile trigger.
ALTER TABLE vynzo_private.user_identifiers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA vynzo_private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE vynzo_private.user_identifiers FROM PUBLIC, anon, authenticated;
DO $hardening$
DECLARE columns text;
BEGIN
  SELECT pg_catalog.string_agg(pg_catalog.format('%I', a.attname), ', ' ORDER BY a.attnum)
    INTO columns FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = 'vynzo_private.user_identifiers'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped;
  IF columns IS NOT NULL THEN
    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) ON TABLE vynzo_private.user_identifiers FROM PUBLIC, anon, authenticated', columns
    );
  END IF;
END
$hardening$;

-- After deploying this migration, disable "Allow public access" in Supabase Realtime settings.
-- The app's user, online-presence, and live channels are private and authorized by the policies below.
ALTER TABLE public.live_sessions
  ADD COLUMN IF NOT EXISTS visibility varchar(20) NOT NULL DEFAULT 'public';

UPDATE public.live_sessions SET visibility = 'public' WHERE visibility IS NULL;

ALTER TABLE public.live_sessions
  ALTER COLUMN visibility SET DEFAULT 'public',
  ALTER COLUMN visibility SET NOT NULL;

ALTER TABLE public.live_sessions
  DROP CONSTRAINT IF EXISTS live_sessions_visibility_check;

ALTER TABLE public.live_sessions
  ADD CONSTRAINT live_sessions_visibility_check
  CHECK (visibility IN ('public', 'friends', 'selected'));

CREATE TABLE IF NOT EXISTS public.live_session_invites (
  live_session_id uuid NOT NULL REFERENCES public.live_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (live_session_id, user_id)
);

CREATE INDEX IF NOT EXISTS live_session_invites_user_idx
  ON public.live_session_invites (user_id, live_session_id);

ALTER TABLE public.live_session_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.live_session_invites FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.live_session_invites TO service_role;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.can_access_live_topic(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_user_id uuid := auth.uid();
  session_id uuid;
BEGIN
  IF current_user_id IS NULL
    OR p_topic !~* '^live:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;

  session_id := substring(p_topic FROM 6)::uuid;

  RETURN EXISTS (
    SELECT 1
    FROM public.live_sessions AS session
    WHERE session.id = session_id
      AND session.is_active IS TRUE
      AND NOT EXISTS (
        SELECT 1
        FROM public.blocks AS block
        WHERE (block.blocker_id = current_user_id AND block.blocked_id = session.host_id)
          OR (block.blocker_id = session.host_id AND block.blocked_id = current_user_id)
      )
      AND (
        session.visibility = 'public'
        OR session.host_id = current_user_id
        OR (
          session.visibility = 'friends'
          AND EXISTS (
            SELECT 1
            FROM public.follows AS follow
            WHERE follow.status = 'accepted'
              AND (
                (follow.follower_id = current_user_id AND follow.following_id = session.host_id)
                OR (follow.follower_id = session.host_id AND follow.following_id = current_user_id)
              )
          )
        )
        OR (
          session.visibility = 'selected'
          AND EXISTS (
            SELECT 1
            FROM public.live_session_invites AS invite
            WHERE invite.live_session_id = session.id
              AND invite.user_id = current_user_id
          )
          AND EXISTS (
            SELECT 1
            FROM public.follows AS follows_out
            WHERE follows_out.follower_id = current_user_id
              AND follows_out.following_id = session.host_id
              AND follows_out.status = 'accepted'
          )
          AND EXISTS (
            SELECT 1
            FROM public.follows AS follows_in
            WHERE follows_in.follower_id = session.host_id
              AND follows_in.following_id = current_user_id
              AND follows_in.status = 'accepted'
          )
        )
      )
  );
END;
$$;

REVOKE ALL ON FUNCTION private.can_access_live_topic(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_access_live_topic(text) TO authenticated;

DROP POLICY IF EXISTS "authorized viewers can read live room messages" ON realtime.messages;
DROP POLICY IF EXISTS "authorized viewers can send live room messages" ON realtime.messages;
CREATE POLICY "authenticated users can read authorized realtime channels"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    (SELECT realtime.topic()) = 'vynzo:online'
    OR (SELECT realtime.topic()) = 'user:' || (SELECT auth.uid())::text
    OR (SELECT private.can_access_live_topic(realtime.topic()))
  );

CREATE POLICY "authenticated users can publish to authorized realtime channels"
  ON realtime.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT realtime.topic()) = 'vynzo:online'
    OR (SELECT realtime.topic()) ~* '^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR (SELECT private.can_access_live_topic(realtime.topic()))
  );
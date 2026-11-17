CREATE TABLE public.account_lifecycle (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('deactivating', 'deactivated', 'deleting')),
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  activation_token_hash text UNIQUE,
  activation_expires_at timestamptz,
  CONSTRAINT account_lifecycle_activation_pair CHECK (
    (activation_token_hash IS NULL AND activation_expires_at IS NULL)
    OR (state = 'deactivated' AND activation_token_hash IS NOT NULL AND activation_expires_at IS NOT NULL)
  )
);

ALTER TABLE public.account_lifecycle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_lifecycle FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_lifecycle TO service_role;

CREATE OR REPLACE FUNCTION public.begin_account_deactivation(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  inserted_rows integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));
  INSERT INTO public.account_lifecycle (user_id, state)
  VALUES (p_user_id, 'deactivating')
  ON CONFLICT (user_id) DO NOTHING;
  GET DIAGNOSTICS inserted_rows = ROW_COUNT;
  RETURN inserted_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_account_deactivation(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_account_deactivation(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_view_once_message(
  p_conversation_id uuid,
  p_message_id uuid,
  p_viewer_id uuid
)
RETURNS TABLE (view_once_path text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_sender_id uuid;
  claimed_path text;
BEGIN
  SELECT message.sender_id
  INTO v_sender_id
  FROM public.messages AS message
  WHERE message.id = p_message_id
    AND message.conversation_id = p_conversation_id
    AND message.view_once IS TRUE
    AND message.viewed_at IS NULL
    AND message.view_once_path IS NOT NULL
    AND message.sender_id <> p_viewer_id
  FOR UPDATE;

  IF v_sender_id IS NULL THEN
    RETURN;
  END IF;

  IF v_sender_id < p_viewer_id THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_sender_id::text, 0));
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_viewer_id::text, 0));
  ELSE
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_viewer_id::text, 0));
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_sender_id::text, 0));
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.account_lifecycle
    WHERE user_id IN (v_sender_id, p_viewer_id)
  ) THEN
    RETURN;
  END IF;

  UPDATE public.messages AS message
  SET viewed_at = pg_catalog.clock_timestamp()
  WHERE message.id = p_message_id
    AND message.conversation_id = p_conversation_id
    AND message.sender_id = v_sender_id
    AND message.view_once IS TRUE
    AND message.viewed_at IS NULL
    AND message.view_once_path IS NOT NULL
  RETURNING message.view_once_path INTO claimed_path;

  IF claimed_path IS NOT NULL THEN
    RETURN QUERY SELECT claimed_path;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_view_once_message(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_view_once_message(uuid, uuid, uuid) TO service_role;

ALTER FUNCTION public.get_my_activity(integer) SET SCHEMA private;
ALTER FUNCTION private.get_my_activity(integer) RENAME TO get_my_activity_unfiltered;
REVOKE ALL ON FUNCTION private.get_my_activity_unfiltered(integer) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.get_my_activity(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  me uuid := (SELECT auth.uid());
  activity jsonb;
BEGIN
  IF me IS NULL OR EXISTS (SELECT 1 FROM public.account_lifecycle WHERE user_id = me) THEN
    RAISE EXCEPTION 'Account unavailable' USING ERRCODE = '42501';
  END IF;
  activity := private.get_my_activity_unfiltered(p_limit);
  RETURN (
    SELECT COALESCE(jsonb_agg(entry.item ORDER BY entry.ordinal), '[]'::jsonb)
    FROM jsonb_array_elements(activity) WITH ORDINALITY AS entry(item, ordinal)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.account_lifecycle AS restricted
      WHERE restricted.user_id = (entry.item->>'actor_id')::uuid
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_activity(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_activity(integer) TO authenticated;

CREATE OR REPLACE FUNCTION private.can_access_user_topic(p_topic text, p_publish boolean)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_user_id uuid := (SELECT auth.uid());
  target_user_id uuid;
BEGIN
  IF current_user_id IS NULL OR p_topic IS NULL
    OR p_topic IS DISTINCT FROM (SELECT realtime.topic())
    OR EXISTS (
      SELECT 1 FROM public.account_lifecycle
      WHERE user_id = current_user_id
    ) THEN
    RETURN false;
  END IF;

  IF p_topic = 'vynzo:online' THEN
    RETURN true;
  END IF;

  IF p_topic !~* '^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;

  target_user_id := substring(p_topic FROM 6)::uuid;

  IF EXISTS (
    SELECT 1 FROM public.account_lifecycle WHERE user_id = target_user_id
  ) THEN
    RETURN false;
  END IF;

  RETURN p_publish OR target_user_id = current_user_id;
END;
$$;

REVOKE ALL ON FUNCTION private.can_access_user_topic(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_access_user_topic(text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION private.can_access_live_topic(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_user_id uuid := (SELECT auth.uid());
  session_id uuid;
BEGIN
  IF current_user_id IS NULL
    OR p_topic IS DISTINCT FROM (SELECT realtime.topic())
    OR p_topic !~* '^live:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR EXISTS (SELECT 1 FROM public.account_lifecycle WHERE user_id = current_user_id) THEN
    RETURN false;
  END IF;

  session_id := substring(p_topic FROM 6)::uuid;

  RETURN EXISTS (
    SELECT 1
    FROM public.live_sessions AS session
    WHERE session.id = session_id
      AND session.is_active IS TRUE
      AND NOT EXISTS (
        SELECT 1 FROM public.account_lifecycle AS restricted
        WHERE restricted.user_id = session.host_id
      )
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

DROP POLICY IF EXISTS "authenticated users can read authorized realtime channels" ON realtime.messages;
DROP POLICY IF EXISTS "authenticated users can publish to authorized realtime channels" ON realtime.messages;
CREATE POLICY "active authenticated users can read authorized realtime channels"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    (SELECT private.can_access_user_topic(realtime.topic(), false))
    OR (SELECT private.can_access_live_topic(realtime.topic()))
  );

CREATE POLICY "active authenticated users can publish to authorized realtime channels"
  ON realtime.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT private.can_access_user_topic(realtime.topic(), true))
    OR (SELECT private.can_access_live_topic(realtime.topic()))
  );

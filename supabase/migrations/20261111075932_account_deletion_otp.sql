CREATE TABLE public.account_deletion_challenges (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  verified_at timestamptz
);

ALTER TABLE public.account_deletion_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_deletion_challenges FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_deletion_challenges TO service_role;

CREATE TABLE public.account_deletion_tombstones (
  user_id uuid PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.account_deletion_tombstones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_deletion_tombstones FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_deletion_tombstones TO service_role;

CREATE OR REPLACE FUNCTION public.issue_account_deletion_otp(
  p_user_id uuid,
  p_code_hash text,
  p_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$'
    OR p_expires_at IS NULL OR p_expires_at <= pg_catalog.clock_timestamp()
    OR p_expires_at > pg_catalog.clock_timestamp() + INTERVAL '10 minutes' THEN
    RETURN false;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.account_lifecycle WHERE user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.account_deletion_tombstones WHERE user_id = p_user_id) THEN
    RETURN false;
  END IF;

  INSERT INTO public.account_deletion_challenges (user_id, code_hash, expires_at, attempt_count, verified_at)
  VALUES (p_user_id, p_code_hash, p_expires_at, 0, NULL)
  ON CONFLICT (user_id) DO UPDATE
  SET code_hash = EXCLUDED.code_hash,
      expires_at = EXCLUDED.expires_at,
      attempt_count = 0,
      verified_at = NULL;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.issue_account_deletion_otp(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_account_deletion_otp(uuid, text, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.begin_account_deletion(p_user_id uuid, p_code_hash text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  challenge public.account_deletion_challenges%ROWTYPE;
  current_state text;
  inserted_rows integer;
BEGIN
  IF p_user_id IS NULL OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));

  SELECT * INTO challenge
  FROM public.account_deletion_challenges
  WHERE user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT state INTO current_state
  FROM public.account_lifecycle
  WHERE user_id = p_user_id;

  IF challenge.verified_at IS NOT NULL
    AND challenge.code_hash = p_code_hash
    AND (current_state = 'deleting'
      OR EXISTS (SELECT 1 FROM public.account_deletion_tombstones WHERE user_id = p_user_id)) THEN
    RETURN true;
  END IF;

  IF current_state IS NOT NULL
    OR challenge.attempt_count >= 5
    OR challenge.expires_at <= pg_catalog.clock_timestamp() THEN
    RETURN false;
  END IF;

  IF challenge.code_hash <> p_code_hash THEN
    UPDATE public.account_deletion_challenges
    SET attempt_count = attempt_count + 1
    WHERE user_id = p_user_id;
    RETURN false;
  END IF;

  UPDATE public.account_deletion_challenges
  SET verified_at = pg_catalog.clock_timestamp()
  WHERE user_id = p_user_id;

  INSERT INTO public.account_lifecycle (user_id, state)
  VALUES (p_user_id, 'deleting')
  ON CONFLICT (user_id) DO NOTHING;
  GET DIAGNOSTICS inserted_rows = ROW_COUNT;
  RETURN inserted_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_account_deletion(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_account_deletion(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION private.is_deleted_account(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND p_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.account_deletion_tombstones
      WHERE user_id = p_user_id
    );
$$;

REVOKE ALL ON FUNCTION private.is_deleted_account(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.is_deleted_account(uuid) TO authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
GRANT EXECUTE ON FUNCTION private.is_deleted_account(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_my_activity(p_limit integer DEFAULT 50)
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
  IF me IS NULL
    OR EXISTS (SELECT 1 FROM public.account_lifecycle WHERE user_id = me)
    OR private.is_deleted_account(me) THEN
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
      AND NOT private.is_deleted_account((entry.item->>'actor_id')::uuid)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_activity(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_activity(integer) TO authenticated;

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
  ) OR private.is_deleted_account(v_sender_id)
    OR private.is_deleted_account(p_viewer_id) THEN
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
    )
    OR private.is_deleted_account(current_user_id) THEN
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
  ) OR private.is_deleted_account(target_user_id) THEN
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
    OR EXISTS (SELECT 1 FROM public.account_lifecycle WHERE user_id = current_user_id)
    OR private.is_deleted_account(current_user_id) THEN
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
      AND NOT private.is_deleted_account(session.host_id)
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
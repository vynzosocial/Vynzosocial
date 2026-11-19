CREATE TABLE private.live_friend_alert_cooldowns (
  host_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL
);
ALTER TABLE private.live_friend_alert_cooldowns ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON private.live_friend_alert_cooldowns TO service_role;

CREATE POLICY "users receive only their own live friend alerts"
ON realtime.messages FOR SELECT TO authenticated
USING (
  extension = 'broadcast'
  AND (SELECT realtime.topic()) = 'live-alert:' || (SELECT auth.uid())::text
  AND topic = (SELECT realtime.topic())
);

CREATE FUNCTION public.send_live_friend_alerts(p_session_id uuid, p_host_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  recipients uuid[];
  recipient uuid;
  host_name text;
  sent_time timestamptz := now();
BEGIN
  SELECT array_agg(DISTINCT outgoing.following_id)
  INTO recipients
  FROM public.live_sessions AS session
  JOIN public.follows AS outgoing ON outgoing.follower_id = session.host_id AND outgoing.status = 'accepted'
  JOIN public.follows AS incoming ON incoming.follower_id = outgoing.following_id
    AND incoming.following_id = session.host_id AND incoming.status = 'accepted'
  WHERE session.id = p_session_id AND session.host_id = p_host_id
    AND session.is_active AND session.last_heartbeat >= sent_time - interval '90 seconds'
    AND outgoing.following_id <> session.host_id
    AND (session.visibility IN ('public', 'friends') OR (
      session.visibility = 'selected' AND EXISTS (
        SELECT 1 FROM public.live_session_invites AS invite
        WHERE invite.live_session_id = session.id AND invite.user_id = outgoing.following_id
      )
    ))
    AND NOT EXISTS (
      SELECT 1 FROM public.blocks AS block
      WHERE (block.blocker_id = session.host_id AND block.blocked_id = outgoing.following_id)
         OR (block.blocked_id = session.host_id AND block.blocker_id = outgoing.following_id)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.account_lifecycle AS restricted
      WHERE restricted.user_id IN (session.host_id, outgoing.following_id)
    );

  IF recipients IS NULL THEN RETURN '{}'::uuid[]; END IF;

  INSERT INTO private.live_friend_alert_cooldowns AS cooldown (host_id, sent_at)
  VALUES (p_host_id, sent_time)
  ON CONFLICT (host_id) DO UPDATE SET sent_at = EXCLUDED.sent_at
  WHERE cooldown.sent_at <= EXCLUDED.sent_at - interval '5 minutes';
  IF NOT FOUND THEN RETURN '{}'::uuid[]; END IF;

  SELECT COALESCE(NULLIF(display_name, ''), username) INTO host_name
  FROM public.users WHERE id = p_host_id;
  FOREACH recipient IN ARRAY recipients LOOP
    PERFORM realtime.send(
      jsonb_build_object('sessionId', p_session_id, 'hostName', host_name),
      'live_started', 'live-alert:' || recipient::text, true
    );
  END LOOP;
  RETURN recipients;
END;
$$;

REVOKE ALL ON FUNCTION public.send_live_friend_alerts(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_live_friend_alerts(uuid, uuid) TO service_role;
ALTER TABLE public.live_sessions ADD COLUMN friend_alerts_sent_at timestamptz;

CREATE OR REPLACE FUNCTION public.send_live_friend_alerts(p_session_id uuid, p_host_id uuid)
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
  SELECT array_agg(DISTINCT subscription.subscriber_id)
  INTO recipients
  FROM public.live_sessions AS session
  JOIN public.live_alert_subscriptions AS subscription ON subscription.host_id = session.host_id
  JOIN public.follows AS outgoing ON outgoing.follower_id = session.host_id
    AND outgoing.following_id = subscription.subscriber_id AND outgoing.status = 'accepted'
  JOIN public.follows AS incoming ON incoming.follower_id = subscription.subscriber_id
    AND incoming.following_id = session.host_id AND incoming.status = 'accepted'
  WHERE session.id = p_session_id AND session.host_id = p_host_id
    AND session.is_active AND session.last_heartbeat >= sent_time - interval '90 seconds'
    AND session.friend_alerts_sent_at IS NULL
    AND (session.visibility IN ('public', 'friends') OR (
      session.visibility = 'selected' AND EXISTS (
        SELECT 1 FROM public.live_session_invites AS invite
        WHERE invite.live_session_id = session.id AND invite.user_id = subscription.subscriber_id
      )
    ))
    AND NOT EXISTS (
      SELECT 1 FROM public.blocks AS block
      WHERE (block.blocker_id = session.host_id AND block.blocked_id = subscription.subscriber_id)
         OR (block.blocked_id = session.host_id AND block.blocker_id = subscription.subscriber_id)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.account_lifecycle AS restricted
      WHERE restricted.user_id IN (session.host_id, subscription.subscriber_id)
    );

  IF recipients IS NULL THEN RETURN '{}'::uuid[]; END IF;

  -- Claim this session atomically so concurrent calls cannot send it twice.
  UPDATE public.live_sessions
  SET friend_alerts_sent_at = sent_time
  WHERE id = p_session_id AND host_id = p_host_id AND is_active
    AND last_heartbeat >= sent_time - interval '90 seconds'
    AND friend_alerts_sent_at IS NULL;
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

DROP TABLE private.live_friend_alert_cooldowns;
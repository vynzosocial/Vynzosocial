\set ON_ERROR_STOP on
BEGIN;

CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA private;
CREATE SCHEMA realtime;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
CREATE TABLE realtime.messages (extension text, topic text);
CREATE TABLE realtime.sent (payload jsonb, event text, topic text, private boolean);
CREATE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean)
RETURNS void LANGUAGE sql AS $$ INSERT INTO realtime.sent VALUES (payload, event, topic, private) $$;
CREATE TABLE public.users (id uuid PRIMARY KEY, username text, display_name text);
CREATE TABLE public.follows (
  follower_id uuid REFERENCES public.users ON DELETE CASCADE,
  following_id uuid REFERENCES public.users ON DELETE CASCADE,
  status text NOT NULL,
  PRIMARY KEY (follower_id, following_id)
);
CREATE TABLE public.live_sessions (
  id uuid PRIMARY KEY, host_id uuid NOT NULL, is_active boolean NOT NULL,
  last_heartbeat timestamptz NOT NULL, visibility text NOT NULL
);
CREATE TABLE public.live_session_invites (live_session_id uuid, user_id uuid);
CREATE TABLE public.blocks (blocker_id uuid, blocked_id uuid);
CREATE TABLE public.account_lifecycle (user_id uuid);
GRANT USAGE ON SCHEMA public, private, realtime TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public, realtime TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA realtime TO service_role;

\ir '..\\supabase\\migrations\\20261119212052_live_friend_alerts.sql'
\ir '..\\supabase\\migrations\\20261120111722_live_alert_subscriptions.sql'
\ir '..\\supabase\\migrations\\20261120114947_live_alerts_once_per_session.sql'

INSERT INTO public.users (id, username) VALUES
  ('11111111-1111-4111-8111-111111111111', 'host'),
  ('22222222-2222-4222-8222-222222222222', 'friend1'),
  ('33333333-3333-4333-8333-333333333333', 'friend2'),
  ('44444444-4444-4444-8444-444444444444', 'friend3');
INSERT INTO public.follows (follower_id, following_id, status)
SELECT '11111111-1111-4111-8111-111111111111', id, 'accepted'
FROM public.users WHERE username <> 'host'
UNION ALL
SELECT id, '11111111-1111-4111-8111-111111111111', 'accepted'
FROM public.users WHERE username <> 'host';
INSERT INTO public.live_sessions (id, host_id, is_active, last_heartbeat, visibility) VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', true, now(), 'public'
);

DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.live_alert_subscriptions', 'SELECT')
    OR has_table_privilege('authenticated', 'public.live_alert_subscriptions', 'INSERT')
    OR has_function_privilege('authenticated', 'public.send_live_friend_alerts(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'subscriptions or alert sender exposed to authenticated users';
  END IF;
END $$;

SET ROLE service_role;
DO $$
DECLARE recipients uuid[];
BEGIN
  recipients := public.send_live_friend_alerts('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111');
  IF cardinality(recipients) <> 0 THEN RAISE EXCEPTION 'unsubscribed friends were alerted'; END IF;
END $$;
RESET ROLE;

INSERT INTO public.live_alert_subscriptions (subscriber_id, host_id) VALUES
  ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111'),
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111');
INSERT INTO public.blocks VALUES ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111');
SET ROLE service_role;
DO $$
DECLARE recipients uuid[];
BEGIN
  recipients := public.send_live_friend_alerts('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111');
  IF recipients <> ARRAY['22222222-2222-4222-8222-222222222222'::uuid] THEN
    RAISE EXCEPTION 'blocked or unsubscribed account received an alert: %', recipients;
  END IF;
  IF (SELECT count(*) FROM realtime.sent) <> 1 THEN RAISE EXCEPTION 'wrong broadcast count'; END IF;
  recipients := public.send_live_friend_alerts('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111');
  IF cardinality(recipients) <> 0 OR (SELECT count(*) FROM realtime.sent) <> 1 THEN
    RAISE EXCEPTION 'same session sent duplicate alerts';
  END IF;
END $$;
RESET ROLE;

DELETE FROM public.live_sessions;
INSERT INTO public.live_sessions (id, host_id, is_active, last_heartbeat, visibility)
VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', true, now(), 'public');
SET ROLE service_role;
DO $$
DECLARE recipients uuid[];
BEGIN
  recipients := public.send_live_friend_alerts('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111');
  IF recipients <> ARRAY['22222222-2222-4222-8222-222222222222'::uuid]
    OR (SELECT count(*) FROM realtime.sent WHERE payload->>'sessionId' = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') <> 1 THEN
    RAISE EXCEPTION 'immediate restart did not alert the already subscribed friend: %', recipients;
  END IF;
END $$;
RESET ROLE;

DELETE FROM public.live_sessions;
INSERT INTO public.live_sessions (id, host_id, is_active, last_heartbeat, visibility)
VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '11111111-1111-4111-8111-111111111111', true, now(), 'selected');
DELETE FROM public.blocks;
INSERT INTO public.live_session_invites VALUES
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '33333333-3333-4333-8333-333333333333'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '44444444-4444-4444-8444-444444444444');
SET ROLE service_role;
DO $$
DECLARE recipients uuid[];
BEGIN
  recipients := public.send_live_friend_alerts('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '11111111-1111-4111-8111-111111111111');
  IF recipients <> ARRAY['33333333-3333-4333-8333-333333333333'::uuid] THEN
    RAISE EXCEPTION 'selected audience or opt-in filter failed: %', recipients;
  END IF;
END $$;
RESET ROLE;

DELETE FROM public.live_sessions;
INSERT INTO public.live_sessions (id, host_id, is_active, last_heartbeat, visibility)
VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '11111111-1111-4111-8111-111111111111', true, now(), 'selected');
INSERT INTO public.live_session_invites VALUES
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '33333333-3333-4333-8333-333333333333');
INSERT INTO public.account_lifecycle VALUES ('33333333-3333-4333-8333-333333333333');
SET ROLE service_role;
DO $$
BEGIN
  IF cardinality(public.send_live_friend_alerts('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '11111111-1111-4111-8111-111111111111')) <> 0 THEN
    RAISE EXCEPTION 'inactive account received an alert';
  END IF;
END $$;
RESET ROLE;
DELETE FROM public.account_lifecycle;
UPDATE public.follows SET status = 'pending'
WHERE follower_id = '33333333-3333-4333-8333-333333333333'
  AND following_id = '11111111-1111-4111-8111-111111111111';
SET ROLE service_role;
DO $$
BEGIN
  IF cardinality(public.send_live_friend_alerts('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '11111111-1111-4111-8111-111111111111')) <> 0 THEN
    RAISE EXCEPTION 'non-mutual friend received an alert';
  END IF;
END $$;
RESET ROLE;
UPDATE public.follows SET status = 'accepted'
WHERE follower_id = '33333333-3333-4333-8333-333333333333'
  AND following_id = '11111111-1111-4111-8111-111111111111';
DELETE FROM public.live_alert_subscriptions
WHERE subscriber_id = '33333333-3333-4333-8333-333333333333'
  AND host_id = '11111111-1111-4111-8111-111111111111';
SET ROLE service_role;
DO $$
BEGIN
  IF cardinality(public.send_live_friend_alerts('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '11111111-1111-4111-8111-111111111111')) <> 0 THEN
    RAISE EXCEPTION 'unsubscribed friend received an alert';
  END IF;
END $$;
RESET ROLE;
INSERT INTO public.live_alert_subscriptions (subscriber_id, host_id)
VALUES ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111');
UPDATE public.live_sessions SET last_heartbeat = now() - interval '91 seconds';
SET ROLE service_role;
DO $$
BEGIN
  IF cardinality(public.send_live_friend_alerts('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '11111111-1111-4111-8111-111111111111')) <> 0 THEN
    RAISE EXCEPTION 'stale livestream sent alerts';
  END IF;
END $$;
RESET ROLE;

INSERT INTO public.live_alert_subscriptions (subscriber_id, host_id)
VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
DELETE FROM public.follows
WHERE follower_id = '22222222-2222-4222-8222-222222222222'
  AND following_id = '11111111-1111-4111-8111-111111111111';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.live_alert_subscriptions
    WHERE subscriber_id = '22222222-2222-4222-8222-222222222222'
       OR host_id = '22222222-2222-4222-8222-222222222222') THEN
    RAISE EXCEPTION 'friendship removal did not clear both subscriptions';
  END IF;
END $$;

ROLLBACK;

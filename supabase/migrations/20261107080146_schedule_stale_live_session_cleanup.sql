CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'delete-stale-live-sessions',
  '* * * * *',
  $job$
    DELETE FROM public.live_sessions
    WHERE is_active IS FALSE
       OR last_heartbeat < now() - interval '90 seconds';
  $job$
);

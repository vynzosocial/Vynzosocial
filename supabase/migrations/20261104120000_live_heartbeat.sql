ALTER TABLE public.live_sessions
  ADD COLUMN IF NOT EXISTS last_heartbeat timestamptz DEFAULT now();

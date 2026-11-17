create table if not exists public.api_rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  attempts integer not null check (attempts >= 1)
);

alter table public.api_rate_limits enable row level security;
revoke all on public.api_rate_limits from public, anon, authenticated;

-- Fixed-window limiter. Returns true while the caller is within p_max attempts per p_window_seconds.
create or replace function public.consume_rate_limit(p_key text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_attempts integer;
begin
  if p_key is null or length(p_key) > 200 or p_max < 1 or p_window_seconds < 1 then
    return false;
  end if;
  insert into public.api_rate_limits as limits (key, window_start, attempts)
  values (p_key, now(), 1)
  on conflict (key) do update
  set window_start = case when limits.window_start <= now() - make_interval(secs => p_window_seconds) then now() else limits.window_start end,
      attempts = case when limits.window_start <= now() - make_interval(secs => p_window_seconds) then 1 else limits.attempts + 1 end
  returning attempts into current_attempts;
  return current_attempts <= p_max;
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;
grant select, insert, update, delete on public.api_rate_limits to service_role;

create or replace function public.purge_api_rate_limits()
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.api_rate_limits where window_start < now() - interval '1 day';
$$;

revoke all on function public.purge_api_rate_limits() from public, anon, authenticated;
grant execute on function public.purge_api_rate_limits() to service_role;

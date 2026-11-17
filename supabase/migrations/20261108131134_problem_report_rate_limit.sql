create table public.problem_report_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null default now(),
  attempts integer not null check (attempts between 1 and 3)
);

alter table public.problem_report_limits enable row level security;
revoke all on public.problem_report_limits from public, anon, authenticated;

create function public.consume_problem_report_limit(p_user_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  allowed boolean;
begin
  insert into public.problem_report_limits as limits (user_id, window_start, attempts)
  values (p_user_id, now(), 1)
  on conflict (user_id) do update
  set window_start = case when limits.window_start <= now() - interval '10 minutes' then now() else limits.window_start end,
      attempts = case when limits.window_start <= now() - interval '10 minutes' then 1 else limits.attempts + 1 end
  where limits.window_start <= now() - interval '10 minutes' or limits.attempts < 3
  returning true into allowed;
  return coalesce(allowed, false);
end;
$$;

revoke all on function public.consume_problem_report_limit(uuid) from public, anon, authenticated;
grant execute on function public.consume_problem_report_limit(uuid) to service_role;
grant select, insert, update on public.problem_report_limits to service_role;
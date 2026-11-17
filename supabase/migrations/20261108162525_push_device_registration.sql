create table public.push_devices (
  device_id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  installation_id text not null unique
    check (installation_id ~ '^[A-Za-z0-9_-]{11,128}$'),
  device_secret_hash text not null
    check (device_secret_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);

create index push_devices_user_id_idx on public.push_devices (user_id);
alter table public.push_devices enable row level security;
revoke all on public.push_devices from public, anon, authenticated;
grant select, insert, update, delete on public.push_devices to service_role;

create function public.register_push_device(
  p_device_id uuid,
  p_user_id uuid,
  p_installation_id text,
  p_device_secret_hash text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  saved uuid;
begin
  insert into public.push_devices as device
    (device_id, user_id, installation_id, device_secret_hash, updated_at)
  values
    (p_device_id, p_user_id, p_installation_id, p_device_secret_hash, now())
  on conflict (device_id) do update
    set user_id = excluded.user_id,
        installation_id = excluded.installation_id,
        updated_at = excluded.updated_at
    where device.device_secret_hash = excluded.device_secret_hash
  returning device_id into saved;
  return saved is not null;
end;
$$;

revoke all on function public.register_push_device(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.register_push_device(uuid, uuid, text, text)
  to service_role;
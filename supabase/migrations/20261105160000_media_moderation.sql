create table if not exists public.media_moderation (
  kind text not null check (kind in ('post', 'story')),
  item_id uuid not null,
  user_id uuid not null references public.users(id) on delete cascade,
  status text not null check (status in ('clean', 'removed')),
  created_at timestamptz not null default now(),
  primary key (kind, item_id)
);

create table if not exists public.moderation_notices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  message text not null,
  seen_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists moderation_notices_user_unseen_idx
  on public.moderation_notices (user_id, created_at desc) where seen_at is null;
create index if not exists media_moderation_user_idx
  on public.media_moderation (user_id);

-- No client policies: only the service-role edge function reads or writes these tables.
alter table public.media_moderation enable row level security;
alter table public.moderation_notices enable row level security;

alter table public.users add column if not exists instagram_username text;

alter table public.users drop constraint if exists users_instagram_username_format;
alter table public.users add constraint users_instagram_username_format
  check (instagram_username is null or instagram_username ~ '^[A-Za-z0-9._]{1,30}$');

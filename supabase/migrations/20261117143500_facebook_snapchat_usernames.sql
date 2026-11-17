alter table public.users add column if not exists facebook_username text;
alter table public.users add column if not exists snapchat_username text;

alter table public.users drop constraint if exists users_facebook_username_format;
alter table public.users add constraint users_facebook_username_format
  check (facebook_username is null or facebook_username ~ '^[A-Za-z0-9.]{1,50}$');

alter table public.users drop constraint if exists users_snapchat_username_format;
alter table public.users add constraint users_snapchat_username_format
  check (snapchat_username is null or snapchat_username ~ '^[A-Za-z0-9._-]{1,30}$');

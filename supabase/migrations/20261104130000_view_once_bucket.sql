insert into storage.buckets (id, name, public)
values ('view-once', 'view-once', false)
on conflict (id) do update set public = false;

insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', true)
on conflict (id) do nothing;

alter table public.messages add column if not exists edited_at timestamptz;
alter table public.conversation_members add column if not exists deleted_at timestamptz;

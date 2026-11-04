alter table public.messages
  add column if not exists reply_to_id uuid references public.messages(id) on delete set null;

alter table public.conversation_members
  add column if not exists hidden_senders jsonb not null default '{}'::jsonb;

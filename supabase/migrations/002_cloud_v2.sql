-- Maya cloud migration: run once in Supabase SQL Editor.
-- Order-safe (IF NOT EXISTS throughout). Run top to bottom, then set secrets.

-- 0) Extensions (or enable in Database > Extensions)
create extension if not exists vector;
create extension if not exists pg_net;

-- 1) Semantic vectors on existing tables
alter table memories add column if not exists embedding vector(768);
alter table chunks add column if not exists embedding vector(768);

-- 2) Full-text search index for documents
create index if not exists chunks_text_fts on chunks using gin (to_tsvector('english', text));

-- 3) Multi-device conversations
create table if not exists conversations (
  id text primary key,
  owner text not null,
  title text,
  created bigint,
  updated bigint,
  summary text
);
create table if not exists messages (
  id text primary key,
  conversation_id text not null references conversations(id) on delete cascade,
  owner text not null,
  role text,
  text text,
  images jsonb default '[]',
  created bigint
);
create index if not exists messages_conv_idx on messages(conversation_id, created);
alter table conversations enable row level security;
alter table messages enable row level security;
drop policy if exists "own rows" on conversations;
create policy "own rows" on conversations for all to authenticated
  using (owner = auth.uid()::text) with check (owner = auth.uid()::text);
drop policy if exists "own rows" on messages;
create policy "own rows" on messages for all to authenticated
  using (owner = auth.uid()::text) with check (owner = auth.uid()::text);

-- 4) Server reminders + push subscriptions
create table if not exists reminders (
  id text primary key,
  owner text not null,
  text text,
  at bigint,
  delivered boolean default false,
  created bigint
);
create table if not exists push_subscriptions (
  endpoint text primary key,
  owner text not null,
  keys jsonb,
  created bigint
);
alter table reminders enable row level security;
alter table push_subscriptions enable row level security;
drop policy if exists "own rows" on reminders;
create policy "own rows" on reminders for all to authenticated
  using (owner = auth.uid()::text) with check (owner = auth.uid()::text);
drop policy if exists "own rows" on push_subscriptions;
create policy "own rows" on push_subscriptions for all to authenticated
  using (owner = auth.uid()::text) with check (owner = auth.uid()::text);

-- 5) Observability + product analytics (service-role writes from functions)
create table if not exists model_calls (
  id bigint generated always as identity primary key,
  owner text,
  model text,
  latency_ms integer,
  prompt_chars integer,
  completion_chars integer,
  tool text,
  error text,
  created bigint
);
create table if not exists events (
  id bigint generated always as identity primary key,
  owner text,
  name text,
  props jsonb default '{}',
  created bigint
);
alter table model_calls enable row level security;
alter table events enable row level security;
drop policy if exists "own rows" on events;
create policy "own rows" on events for all to authenticated
  using (owner = auth.uid()::text) with check (owner = auth.uid()::text);

-- 6) Chat image storage (public read, owner-scoped writes)
insert into storage.buckets (id, name, public) values ('chat-images', 'chat-images', true)
on conflict (id) do nothing;
drop policy if exists "auth read images" on storage.objects;
create policy "auth read images" on storage.objects for select to authenticated
  using (bucket_id = 'chat-images');
drop policy if exists "auth upload images" on storage.objects;
create policy "auth upload images" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-images');
drop policy if exists "auth delete images" on storage.objects;
create policy "auth delete images" on storage.objects for delete to authenticated
  using (bucket_id = 'chat-images');

-- 7) Realtime for live sync (conversations, messages, reminders)
alter publication supabase_realtime add table conversations;
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table reminders;

-- 8) Reminder cron (Service key: Project Settings → API. VAPID keys below.)
-- Replace <REF> and <SERVICE_KEY>, then run. Fires every minute.
-- select cron.schedule('maya-reminders', '* * * * *', $$
--   select net.http_post(
--     url := 'https://<REF>.supabase.co/functions/v1/cron-reminders',
--     headers := '{"Content-Type": "application/json", "Authorization": "Bearer <SERVICE_KEY>"}'::jsonb,
--     body := '{}'::jsonb
--   );
-- $$);

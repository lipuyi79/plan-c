create extension if not exists pgcrypto;

create table if not exists public.scans (
  id uuid primary key default gen_random_uuid(),
  input_url text not null,
  site_url text not null,
  page_count integer not null default 0,
  pages jsonb not null default '[]'::jsonb,
  analysis jsonb not null,
  elapsed_ms integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists scans_created_at_idx on public.scans (created_at desc);
create index if not exists scans_site_url_idx on public.scans (site_url);

alter table public.scans enable row level security;

drop policy if exists "No public scan reads" on public.scans;
drop policy if exists "No public scan writes" on public.scans;

create policy "No public scan reads"
on public.scans
for select
to anon, authenticated
using (false);

create policy "No public scan writes"
on public.scans
for insert
to anon, authenticated
with check (false);


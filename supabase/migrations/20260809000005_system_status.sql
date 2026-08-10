-- ADR-012: minimal ops monitoring — worker heartbeat visible to the dashboard.

create table public.system_status (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.system_status enable row level security;
create policy "authenticated read system_status"
  on public.system_status for select to authenticated using (true);

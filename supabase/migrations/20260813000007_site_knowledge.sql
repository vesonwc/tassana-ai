-- ADR-013: layer-4 config — knowledge the system asks for and accumulates.

create table public.site_knowledge (
  id         uuid primary key default gen_random_uuid(),
  site_id    uuid not null references public.sites(id) on delete cascade,
  camera_id  uuid references public.cameras(id) on delete set null, -- null = whole site
  fact_th    text not null,
  source     text not null default 'line_reply'
             check (source in ('line_reply', 'dashboard', 'system')),
  created_at timestamptz not null default now()
);

create index site_knowledge_site_idx on public.site_knowledge (site_id, created_at desc);

alter table public.site_knowledge enable row level security;
create policy "scoped read site_knowledge"
  on public.site_knowledge for select to authenticated
  using (public.is_admin() or site_id = public.my_site_id());

-- Question awaiting a human answer, keyed by the LINE chat it was sent to.
create table public.pending_questions (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references public.sites(id) on delete cascade,
  event_id    uuid not null references public.events(event_id) on delete cascade,
  line_target text not null,
  question_th text not null,
  created_at  timestamptz not null default now(),
  answered_at timestamptz
);

create index pending_questions_target_idx
  on public.pending_questions (line_target, answered_at, created_at desc);

alter table public.pending_questions enable row level security; -- service-role only

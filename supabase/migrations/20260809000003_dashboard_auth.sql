-- M4: dashboard auth per ADR-010.
-- profiles = who can log in and which site they can see. RLS grants
-- authenticated users scoped reads; writes go through server actions.

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  role         text not null default 'site_user' check (role in ('admin', 'site_user')),
  site_id      uuid references public.sites(id) on delete cascade, -- null for admin
  display_name text,
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "read own profile"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

-- ---------------------------------------------------------------- helpers
create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.my_site_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select site_id from profiles where id = auth.uid();
$$;

-- ---------------------------------------------------------------- rules
alter table public.sites add column rules jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------- read policies
create policy "scoped read sites"
  on public.sites for select to authenticated
  using (public.is_admin() or id = public.my_site_id());

create policy "scoped read cameras"
  on public.cameras for select to authenticated
  using (public.is_admin() or site_id = public.my_site_id());

create policy "scoped read events"
  on public.events for select to authenticated
  using (public.is_admin() or site_id = public.my_site_id());

create policy "scoped read alerts"
  on public.alerts for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.events e
      where e.event_id = alerts.event_id and e.site_id = public.my_site_id()
    )
  );

create policy "scoped read reports"
  on public.reports for select to authenticated
  using (public.is_admin() or site_id = public.my_site_id());

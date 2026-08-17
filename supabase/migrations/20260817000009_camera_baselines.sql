-- ADR-014: layer 5 — the system's own daily summary of what "normal" looks
-- like per camera. Editable/lockable by humans like any other knowledge.

create table public.camera_baselines (
  camera_id    uuid primary key references public.cameras(id) on delete cascade,
  baseline_th  text not null,
  sample_count int  not null default 0,
  locked       boolean not null default false, -- true = human-edited, worker won't overwrite
  updated_at   timestamptz not null default now()
);

alter table public.camera_baselines enable row level security;
create policy "scoped read camera_baselines"
  on public.camera_baselines for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.cameras c
      where c.id = camera_baselines.camera_id and c.site_id = public.my_site_id()
    )
  );

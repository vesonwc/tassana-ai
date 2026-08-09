-- M1: core tables per docs/event-schema.md + pgmq queue.
-- Changing table shapes here requires an ADR in docs/decisions.md first.

create extension if not exists pgmq;

-- ---------------------------------------------------------------- sites
create table public.sites (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  site_key     text not null unique, -- secret, used in webhook URL
  mode         text not null default 'no_box' check (mode in ('no_box', 'edge_box')),
  line_group_id text,
  timezone     text not null default 'Asia/Bangkok',
  status       text not null default 'active' check (status in ('active', 'paused', 'churned')),
  heartbeat_at timestamptz,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- cameras
create table public.cameras (
  id                uuid primary key default gen_random_uuid(),
  site_id           uuid not null references public.sites(id) on delete cascade,
  name              text not null,
  location_note     text,
  source_type       text not null check (source_type in ('hikvision_isapi', 'dahua', 'onvif', 'frigate', 'manual')),
  source_camera_ref text, -- device-side id, e.g. Hikvision channelID
  status            text not null default 'active' check (status in ('active', 'offline', 'disabled')),
  last_event_at     timestamptz,
  created_at        timestamptz not null default now(),
  unique (site_id, source_type, source_camera_ref)
);

-- ---------------------------------------------------------------- events
create table public.events (
  event_id      uuid primary key,
  site_id       uuid not null references public.sites(id) on delete cascade,
  camera_id     uuid references public.cameras(id) on delete set null,
  source_type   text not null check (source_type in ('hikvision_isapi', 'dahua', 'onvif', 'frigate', 'manual')),
  source_raw_id text,
  event_type    text not null check (event_type in (
    'person_detected', 'vehicle_detected', 'line_crossing', 'intrusion',
    'loitering', 'lpr', 'camera_offline', 'camera_online', 'unknown')),
  occurred_at   timestamptz not null,
  received_at   timestamptz not null,
  detection     jsonb not null default '{}'::jsonb,
  media         jsonb not null default '{}'::jsonb,
  ai            jsonb not null default '{}'::jsonb,
  raw           jsonb not null default '{}'::jsonb -- full raw payload, kept forever (ADR-008)
);

create index events_site_occurred_idx on public.events (site_id, occurred_at desc);
-- Idempotency: same device event must not create a second row/alert.
create unique index events_dedupe_idx
  on public.events (site_id, source_type, source_raw_id)
  where source_raw_id is not null;

-- ---------------------------------------------------------------- alerts
create table public.alerts (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(event_id) on delete cascade,
  channel     text not null default 'line' check (channel in ('line')),
  sent_at     timestamptz,
  message_id  text,
  -- false_alarm feedback is the most valuable data in the system (ADR-008)
  feedback    text check (feedback in ('confirmed', 'false_alarm')),
  feedback_by text,
  feedback_at timestamptz
);

create index alerts_event_idx on public.alerts (event_id);

-- ---------------------------------------------------------------- reports
create table public.reports (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references public.sites(id) on delete cascade,
  report_date date not null,
  period      text not null default 'daily' check (period in ('daily', 'monthly')),
  pdf_path    text,
  stats       jsonb not null default '{}'::jsonb,
  sent_at     timestamptz,
  unique (site_id, report_date, period)
);

-- ---------------------------------------------------------------- queue
-- Worker consumes from this queue (pgmq.read/pgmq.delete).
select pgmq.create('events');

-- Wrapper so the webhook (service role via PostgREST) can enqueue without
-- exposing the pgmq schema over the API.
create or replace function public.enqueue_event(p_event_id uuid)
returns bigint
language sql
security definer
set search_path = pgmq, public
as $$
  select pgmq.send('events', jsonb_build_object('event_id', p_event_id));
$$;

-- ---------------------------------------------------------------- RLS
-- Locked down by default: no policies yet, so anon/authenticated see nothing.
-- The webhook and worker use the service role key (bypasses RLS).
-- Dashboard policies land in M4.
alter table public.sites enable row level security;
alter table public.cameras enable row level security;
alter table public.events enable row level security;
alter table public.alerts enable row level security;
alter table public.reports enable row level security;

-- M3: queue consumer functions for the worker (read/ack over PostgREST,
-- since the pgmq schema itself is not exposed to the Data API).

create or replace function public.dequeue_events(
  p_limit int default 5,
  p_vt int default 90
)
returns table (msg_id bigint, read_ct int, message jsonb)
language sql
security definer
set search_path = pgmq, public
as $$
  select msg_id, read_ct, message from pgmq.read('events', p_vt, p_limit);
$$;

create or replace function public.ack_event(p_msg_id bigint)
returns boolean
language sql
security definer
set search_path = pgmq, public
as $$
  select pgmq.delete('events', p_msg_id);
$$;

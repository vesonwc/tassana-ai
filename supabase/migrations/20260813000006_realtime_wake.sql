-- Push-based worker wake: broadcast event inserts on the realtime publication
-- so the worker reacts instantly instead of waiting out its poll interval.

alter publication supabase_realtime add table public.events;

-- Destructive exam changes are available only through the audited RPC.
-- RLS remains useful defense in depth, but direct table DELETE/TRUNCATE must
-- not depend on whichever grants happened to exist before this release.

revoke delete, truncate on table public.exam_sessions, public.exam_answers
from public, anon, authenticated;

notify pgrst, 'reload schema';

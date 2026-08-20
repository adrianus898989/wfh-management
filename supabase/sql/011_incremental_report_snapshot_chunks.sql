create table if not exists public.report_sheet_snapshot_chunks (
  source text not null,
  chunk_index integer not null,
  payload jsonb not null default '[]'::jsonb,
  row_count integer not null default 0,
  content_hash text not null,
  synced_at timestamptz not null default now(),
  primary key (source, chunk_index)
);

alter table public.report_sheet_snapshot_chunks enable row level security;

grant select, insert, update, delete
on table public.report_sheet_snapshot_chunks
to service_role;

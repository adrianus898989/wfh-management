-- Error rows are chunked after invalid source rows are filtered out.  When a
-- formerly invalid row becomes valid (or the reverse), later source rows can
-- move to an adjacent chunk while retaining their stable source_row identity.
-- Parallel chunk imports used to DELETE only their own old chunk and then use
-- a plain INSERT, so the moved row could still exist under its former chunk
-- and violate the (source_name, source_row) primary key.
--
-- Treat that stable primary key as the upsert boundary.  Moving a row now also
-- moves source_chunk_index and refreshes every mutable field atomically; a
-- later DELETE of the former chunk cannot remove the row from its new chunk.

create or replace function public.sync_report_employee_error_chunk(
  p_source_name text,
  p_chunk_index integer,
  p_chunk_size integer,
  p_content_hash text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_name text := nullif(btrim(p_source_name), '');
  v_count integer := 0;
begin
  if v_source_name is null or p_chunk_index < 0 or p_chunk_size < 1
     or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '错误统计多来源同步分块参数无效';
  end if;

  delete from public.report_employee_error_rows
  where source_name = v_source_name
    and source_chunk_index = p_chunk_index;

  insert into public.report_employee_error_rows (
    source_name, source_row, source_chunk_index, record_key, employee_no,
    member_order, amount, error_note, correct_action, error_type, score,
    qc_person, qc_date, leader_review, qc_result, review_date, synced_at
  )
  select distinct on (source_row)
    v_source_name,
    source_row,
    p_chunk_index,
    coalesce(
      nullif(item->>'record_key', ''),
      concat_ws('|', upper(btrim(item->>'employee_id')), item->>'qc_date', source_row::text)
    ),
    regexp_replace(upper(btrim(item->>'employee_id')), '[-–—]+$', ''),
    nullif(btrim(item->>'member_order'), ''),
    nullif(btrim(item->>'amount'), ''),
    nullif(btrim(item->>'error_note'), ''),
    nullif(btrim(item->>'correct_action'), ''),
    nullif(btrim(item->>'error_type'), ''),
    nullif(btrim(item->>'score'), ''),
    nullif(btrim(item->>'qc_person'), ''),
    case when coalesce(item->>'qc_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
      then (item->>'qc_date')::date end,
    nullif(btrim(item->>'leader_review'), ''),
    nullif(btrim(item->>'qc_result'), ''),
    case when coalesce(item->>'review_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
      then (item->>'review_date')::date end,
    clock_timestamp()
  from (
    select item,
      case when coalesce(item->>'source_row', '') ~ '^\d+$'
        then (item->>'source_row')::integer end source_row
    from jsonb_array_elements(p_rows) item
  ) parsed
  where source_row is not null
    and nullif(regexp_replace(upper(btrim(item->>'employee_id')), '[-–—]+$', ''), '') is not null
  order by source_row
  on conflict (source_name, source_row) do update set
    source_chunk_index = excluded.source_chunk_index,
    record_key = excluded.record_key,
    employee_no = excluded.employee_no,
    member_order = excluded.member_order,
    amount = excluded.amount,
    error_note = excluded.error_note,
    correct_action = excluded.correct_action,
    error_type = excluded.error_type,
    score = excluded.score,
    qc_person = excluded.qc_person,
    qc_date = excluded.qc_date,
    leader_review = excluded.leader_review,
    qc_result = excluded.qc_result,
    review_date = excluded.review_date,
    synced_at = excluded.synced_at;

  get diagnostics v_count = row_count;

  insert into public.report_error_sync_chunks (
    source_name, chunk_index, chunk_size, content_hash, row_count, synced_at
  ) values (
    v_source_name, p_chunk_index, p_chunk_size, p_content_hash, v_count,
    clock_timestamp()
  )
  on conflict (source_name, chunk_index) do update set
    chunk_size = excluded.chunk_size,
    content_hash = excluded.content_hash,
    row_count = excluded.row_count,
    synced_at = excluded.synced_at;

  return jsonb_build_object(
    'source_name', v_source_name,
    'chunk_index', p_chunk_index,
    'rows', v_count
  );
end;
$$;

revoke all on function
  public.sync_report_employee_error_chunk(text, integer, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function
  public.sync_report_employee_error_chunk(text, integer, integer, text, jsonb)
  to service_role;

comment on function
  public.sync_report_employee_error_chunk(text, integer, integer, text, jsonb) is
  'Atomically replaces one normalized error chunk and safely moves stable source rows across chunk boundaries.';

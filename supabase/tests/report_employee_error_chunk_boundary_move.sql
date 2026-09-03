-- Run against a disposable database after all migrations. Every mutation is
-- rolled back. Stable source rows must be movable in both directions between
-- filtered-array chunks without a primary-key collision or stale copy.

begin;

do $$
declare
  v_source_name text := '__sql_test_error_chunk_boundary__';
  v_row public.report_employee_error_rows%rowtype;
begin
  perform public.sync_report_employee_error_chunk(
    v_source_name,
    1,
    500,
    repeat('1', 64),
    jsonb_build_array(jsonb_build_object(
      'source_row', 502,
      'record_key', 'before-move',
      'employee_id', 'TST-CHUNK-001',
      'member_order', 'before',
      'error_note', 'old chunk',
      'error_type', 'test',
      'score', '1',
      'qc_date', '2026-09-01'
    ))
  );

  perform public.sync_report_employee_error_chunk(
    v_source_name,
    0,
    500,
    repeat('2', 64),
    jsonb_build_array(jsonb_build_object(
      'source_row', 502,
      'record_key', 'moved-left',
      'employee_id', 'TST-CHUNK-001',
      'member_order', 'left',
      'error_note', 'new chunk zero',
      'error_type', 'test',
      'score', '2',
      'qc_date', '2026-09-02'
    ))
  );

  select * into strict v_row
  from public.report_employee_error_rows row
  where row.source_name = v_source_name
    and row.source_row = 502;

  if v_row.source_chunk_index <> 0
     or v_row.record_key <> 'moved-left'
     or v_row.member_order <> 'left'
     or v_row.score <> '2'
     or v_row.qc_date <> date '2026-09-02' then
    raise exception 'error row did not move left with its latest values';
  end if;

  perform public.sync_report_employee_error_chunk(
    v_source_name,
    1,
    500,
    repeat('3', 64),
    jsonb_build_array(jsonb_build_object(
      'source_row', 502,
      'record_key', 'moved-right',
      'employee_id', 'TST-CHUNK-001',
      'member_order', 'right',
      'error_note', 'new chunk one',
      'error_type', 'test',
      'score', '3',
      'qc_date', '2026-09-03'
    ))
  );

  select * into strict v_row
  from public.report_employee_error_rows row
  where row.source_name = v_source_name
    and row.source_row = 502;

  if v_row.source_chunk_index <> 1
     or v_row.record_key <> 'moved-right'
     or v_row.member_order <> 'right'
     or v_row.score <> '3'
     or v_row.qc_date <> date '2026-09-03'
     or (select count(*) from public.report_employee_error_rows row
         where row.source_name = v_source_name and row.source_row = 502) <> 1 then
    raise exception 'error row did not move right as one latest copy';
  end if;
end;
$$;

rollback;

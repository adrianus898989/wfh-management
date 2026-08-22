-- Avoid rewriting every synced question once per minute when the sheet has not changed.
create or replace function public.sync_exam_questions_from_sheet(p_rows jsonb, p_read_count integer default 0)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_row jsonb;
  v_existing record;
  v_hash text;
  v_inserted integer:=0;
  v_updated integer:=0;
  v_deactivated integer:=0;
  v_eligible integer:=coalesce(jsonb_array_length(coalesce(p_rows,'[]'::jsonb)),0);
  v_run_id bigint;
begin
  if auth.role()<>'service_role' then raise exception 'service role required'; end if;
  perform pg_advisory_xact_lock(hashtext('exam-sheet-sync'));
  insert into public.exam_sync_runs(direction,status,read_count,details)
  values('sheet_to_db','running',greatest(coalesce(p_read_count,0),v_eligible),jsonb_build_object('eligible_rows',v_eligible,'team_column','K'))
  returning id into v_run_id;

  for v_row in select value from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) loop
    if nullif(btrim(v_row->>'team_name'),'') is null or nullif(btrim(v_row->>'series_name'),'') is null
       or nullif(btrim(v_row->>'position_name'),'') is null then continue; end if;
    v_hash:=md5(v_row::text);
    select id,source_hash,active into v_existing from public.exam_questions where external_key=v_row->>'external_key';

    insert into public.exam_questions(
      external_key,sheet_row,series_name,team_name,position_name,question_en,question_zh,question_vi,
      points,difficulty,image_urls,active,source,source_hash,revision,sheet_updated_at,synced_at,sync_status,updated_at
    ) values(
      v_row->>'external_key',(v_row->>'sheet_row')::integer,btrim(v_row->>'series_name'),btrim(v_row->>'team_name'),btrim(v_row->>'position_name'),
      coalesce(v_row->>'question_en',''),coalesce(v_row->>'question_zh',''),coalesce(v_row->>'question_vi',''),
      (v_row->>'points')::smallint,(v_row->>'difficulty')::smallint,coalesce(v_row->'image_urls','[]'::jsonb),
      true,'google_sheet',v_hash,1,now(),now(),'synced',now()
    ) on conflict (external_key) do update set
      sheet_row=excluded.sheet_row,series_name=excluded.series_name,team_name=excluded.team_name,position_name=excluded.position_name,
      question_en=excluded.question_en,question_zh=excluded.question_zh,question_vi=excluded.question_vi,
      points=excluded.points,difficulty=excluded.difficulty,image_urls=excluded.image_urls,active=true,source='google_sheet',
      source_hash=excluded.source_hash,revision=public.exam_questions.revision+1,sheet_updated_at=now(),synced_at=now(),sync_status='synced',updated_at=now()
    where public.exam_questions.source_hash is distinct from excluded.source_hash or not public.exam_questions.active;

    if v_existing.id is null then v_inserted:=v_inserted+1;
    elsif v_existing.source_hash is distinct from v_hash or not v_existing.active then v_updated:=v_updated+1;
    end if;
  end loop;

  update public.exam_questions q set active=false,updated_at=now()
  where q.source='google_sheet' and q.active and not exists(
    select 1 from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) r where r->>'external_key'=q.external_key
  );
  get diagnostics v_deactivated=row_count;

  update public.exam_sync_runs set status='success',inserted_count=v_inserted,updated_count=v_updated,
    skipped_count=greatest(coalesce(p_read_count,0)-v_eligible,0),completed_at=now(),
    details=details||jsonb_build_object('active_questions',v_eligible,'blank_team_rows',greatest(coalesce(p_read_count,0)-v_eligible,0),'deactivated',v_deactivated)
  where id=v_run_id;
  return jsonb_build_object('run_id',v_run_id,'read',p_read_count,'eligible',v_eligible,'inserted',v_inserted,'updated',v_updated,'deactivated',v_deactivated,'team_column','K');
exception when others then
  if v_run_id is not null then update public.exam_sync_runs set status='failed',error_count=1,completed_at=now(),details=details||jsonb_build_object('error',sqlerrm) where id=v_run_id; end if;
  raise;
end $$;

revoke all on function public.sync_exam_questions_from_sheet(jsonb,integer) from public,anon,authenticated;
grant execute on function public.sync_exam_questions_from_sheet(jsonb,integer) to service_role;

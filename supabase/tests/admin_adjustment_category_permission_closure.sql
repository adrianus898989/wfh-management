begin;

do $adjustment_category_permission_closure$
declare
  v_logs text;
  v_editor text;
  v_upsert text;
  v_writer_call constant text:='admin_adjustment_upsert_page_v1(p_payload)';
begin
  select pg_get_functiondef(
    'public.admin_data_entry_logs(text,text,date,date,integer,integer)'::regprocedure
  ) into v_logs;
  select pg_get_functiondef(
    'public.admin_adjustment_editor_options(text,integer)'::regprocedure
  ) into v_editor;
  select pg_get_functiondef(
    'public.admin_adjustment_upsert(jsonb)'::regprocedure
  ) into v_upsert;

  if position('adjustment.bonus.view' in v_logs)=0
     or position('adjustment.deduction.view' in v_logs)=0
     or position('adjustment_visibility_kind' in v_logs)=0 then
    raise exception 'admin_data_entry_logs is missing category filtering';
  end if;
  if position('adjustment_visibility_kind' in v_logs)
     >= position('filtered as materialized' in lower(v_logs)) then
    raise exception 'admin_data_entry_logs must filter categories before totals and pagination';
  end if;

  if position('adjustment.page.create' in v_editor)=0
     or position('adjustment.page.edit' in v_editor)=0
     or position('adjustment.bonus.view' in v_editor)=0
     or position('adjustment.deduction.view' in v_editor)=0 then
    raise exception 'editor options are missing write-plus-category permissions';
  end if;

  if position('v_target_kind' in v_upsert)=0
     or position('v_current_kind' in v_upsert)=0
     or position('adjustment_visibility_kind' in v_upsert)=0
     or position('v_can_bonus and v_can_deduction' in lower(v_upsert))=0 then
    raise exception 'adjustment upsert is missing current/target category checks';
  end if;
  if (
    length(v_upsert)-length(replace(v_upsert,v_writer_call,''))
  )/length(v_writer_call)<>1 then
    raise exception 'adjustment upsert must invoke the legacy writer exactly once';
  end if;
  if v_upsert ~* '\minsert\s+into\M|\mupdate\s+public\.|\mdelete\s+from\M' then
    raise exception 'outer adjustment upsert must remain validation-only';
  end if;
  if position('v_current_kind' in v_upsert)>=position(v_writer_call in v_upsert) then
    raise exception 'category checks must happen before the writer call';
  end if;

  if has_function_privilege('anon','public.admin_data_entry_logs(text,text,date,date,integer,integer)','EXECUTE')
     or not has_function_privilege('authenticated','public.admin_data_entry_logs(text,text,date,date,integer,integer)','EXECUTE') then
    raise exception 'admin_data_entry_logs execute grants are unsafe';
  end if;
  if has_function_privilege('anon','public.admin_adjustment_editor_options(text,integer)','EXECUTE')
     or has_function_privilege('anon','public.admin_adjustment_upsert(jsonb)','EXECUTE')
     or not has_function_privilege('authenticated','public.admin_adjustment_editor_options(text,integer)','EXECUTE')
     or not has_function_privilege('authenticated','public.admin_adjustment_upsert(jsonb)','EXECUTE') then
    raise exception 'adjustment mutation execute grants are unsafe';
  end if;
end;
$adjustment_category_permission_closure$;

rollback;

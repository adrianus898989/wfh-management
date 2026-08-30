begin;

-- The employee drawer exposes the same bounded page-size choices as the other
-- history panels.  Keep the existing, heavily scoped reader byte-for-byte the
-- same apart from its maximum page size; this avoids copying a long security
-- definer body and accidentally drifting its employee/report visibility rules.
set local lock_timeout = '500ms';
set local statement_timeout = '10s';

do $migration$
declare
  v_function regprocedure :=
    'public.online_training_list(text,date,date,uuid,integer,integer)'::regprocedure;
  v_definition text;
  v_updated text;
  v_old text := 'least(greatest(coalesce(p_page_size, 12), 1), 50)';
  v_new text := 'least(greatest(coalesce(p_page_size, 12), 1), 100)';
begin
  select pg_catalog.pg_get_functiondef(v_function::oid)
    into v_definition;

  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'online_training_list_page_size_guard_changed';
  end if;

  v_updated := pg_catalog.replace(v_definition, v_old, v_new);
  if v_updated = v_definition
     or pg_catalog.strpos(v_updated, v_old) > 0 then
    raise exception 'online_training_list_page_size_patch_failed';
  end if;

  execute v_updated;
end;
$migration$;

revoke all on function public.online_training_list(text,date,date,uuid,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.online_training_list(text,date,date,uuid,integer,integer)
  to authenticated;

comment on function public.online_training_list(text,date,date,uuid,integer,integer) is
  'Lists scoped online-training reports; employee-history callers may request bounded pages up to 100 rows.';

notify pgrst,'reload schema';

commit;

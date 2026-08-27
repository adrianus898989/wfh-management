begin;

-- LEAST, like NULLIF, is SQL special syntax and cannot be schema-qualified.
do $fix_alert_group_least$
declare
  v_signature regprocedure :=
    'alerts_private.refresh_alert_group(text)'::regprocedure;
  v_definition text;
begin
  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;

  if position('pg_catalog.least(' in v_definition)>0 then
    v_definition:=replace(v_definition,'pg_catalog.least(','least(');
    execute v_definition;
  elsif position('record.event_date >= least(' in v_definition)=0 then
    raise exception 'alert_group_least_shape_changed';
  end if;

  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
  if position('pg_catalog.least(' in v_definition)>0
     or position('record.event_date >= least(' in v_definition)=0 then
    raise exception 'alert_group_least_fix_incomplete';
  end if;
end;
$fix_alert_group_least$;

commit;

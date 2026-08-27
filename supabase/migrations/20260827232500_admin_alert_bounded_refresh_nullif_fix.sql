begin;

-- The first production canary exposed schema-qualified NULLIF calls. NULLIF
-- is SQL special syntax, not a pg_catalog function. Patch only that reviewed
-- token and fail closed if the function has an unexpected shape.
do $fix_alert_group_nullif$
declare
  v_signature regprocedure :=
    'alerts_private.refresh_alert_group(text)'::regprocedure;
  v_definition text;
begin
  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;

  if position('pg_catalog.nullif(' in v_definition)=0 then
    if position('nullif(pg_catalog.btrim(error.employee_no)' in v_definition)=0 then
      raise exception 'alert_group_nullif_shape_changed';
    end if;
  else
    v_definition:=replace(v_definition,'pg_catalog.nullif(','nullif(');
    execute v_definition;
  end if;

  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
  if position('pg_catalog.nullif(' in v_definition)>0
     or position('nullif(pg_catalog.btrim(error.employee_no)' in v_definition)=0 then
    raise exception 'alert_group_nullif_fix_incomplete';
  end if;
end;
$fix_alert_group_nullif$;

commit;

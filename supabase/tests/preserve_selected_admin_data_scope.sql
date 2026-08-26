-- Local regression test. Run only against a disposable database after all
-- migrations. It verifies the database guardrails without changing data.

begin;

do $$
declare
  v_definition text;
  v_all_position integer;
  v_self_position integer;
  v_own_team_position integer;
  v_assigned_position integer;
begin
  if exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_class relation on relation.oid = trigger_row.tgrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'user_access'
      and trigger_row.tgname = 'enforce_linked_backend_own_team_trigger'
      and not trigger_row.tgisinternal
  ) then
    raise exception 'linked-account own_team coercion trigger still exists';
  end if;

  if to_regprocedure('public.enforce_linked_backend_own_team()') is not null then
    raise exception 'linked-account own_team coercion function still exists';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.backend_employee_in_scope(uuid)'::regprocedure
  ) into v_definition;

  v_all_position := strpos(v_definition, 'if v_scope = ''all'' then return true');
  v_self_position := strpos(v_definition, 'if v_scope = ''self'' then');
  v_own_team_position := strpos(v_definition, 'if v_scope = ''own_team'' then');
  v_assigned_position := strpos(v_definition, 'if v_scope = ''assigned_teams'' then');

  if v_all_position = 0
     or v_self_position = 0
     or v_own_team_position = 0
     or v_assigned_position = 0 then
    raise exception 'one or more explicit data-scope branches are missing';
  end if;

  if not (
    v_all_position < v_self_position
    and v_self_position < v_own_team_position
    and v_own_team_position < v_assigned_position
  ) then
    raise exception 'data-scope branches are not evaluated in fail-safe order';
  end if;

  if strpos(v_definition, 'v_caller_position_id') > 0 then
    raise exception 'own_team still has the obsolete position restriction';
  end if;
end;
$$;

rollback;

begin;

-- A 2026-08-25 compatibility trigger coerced every linked non-Founder account
-- to own_team. Linked accounts may now intentionally use the narrower
-- team/position intersection, so retaining that trigger would silently undo
-- the atomic scope save on a clean migration replay.
drop trigger if exists enforce_linked_backend_own_team_trigger
  on public.user_access;
drop function if exists public.enforce_linked_backend_own_team();

-- The management-risk report predates the current-roster scope authority and
-- used to reconstruct own-team access from team-name equality. That allowed a
-- roster row with no canonical employee/position mapping to enter the result.
-- Patch the deployed function in place and abort if its reviewed shape changes.
do $harden_management_risk_scope$
declare
  v_signature regprocedure :=
    'public.admin_employee_management_risk(date,date,jsonb,integer)'::regprocedure;
  v_definition text;
  v_old text := $old$
    where v_all
      or roster.employee_id=v_current_employee
      or (
        v_scope='own_team'
        and exists(
          select 1 from caller_roster caller
          where pg_catalog.lower(pg_catalog.btrim(caller.team_name))
               =pg_catalog.lower(pg_catalog.btrim(roster.team_name))
        )
      )
      or (
        v_scope='assigned_teams'
        and (
          exists(
            select 1 from public.user_scope_employees scoped_employee
            where scoped_employee.auth_user_id=v_user_id
              and scoped_employee.employee_id=roster.employee_id
          )
          or exists(
            select 1 from public.user_scope_teams scoped_team
            where scoped_team.auth_user_id=v_user_id
              and scoped_team.team_id=roster.roster_team_id
          )
        )
      )
  ), filtered_roster as materialized ($old$;
  v_new text := $new$
    where v_all
      or public.backend_employee_in_scope(roster.employee_id)
  ), filtered_roster as materialized ($new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'management_risk_scope_definition_changed';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;

  select pg_get_functiondef(v_signature) into v_definition;
  if position('public.backend_employee_in_scope(roster.employee_id)' in v_definition) = 0
     or position('public.user_scope_teams' in v_definition) > 0 then
    raise exception 'management_risk_scope_hardening_failed';
  end if;
end;
$harden_management_risk_scope$;

-- The application moved to online_training_context(). The retained bootstrap
-- still reconstructs own-team and trainer visibility from historical fields,
-- so it must not remain a callable alternate reader.
revoke all on function public.online_training_bootstrap()
  from public, anon, authenticated;
comment on function public.online_training_bootstrap() is
  'Deprecated compatibility implementation; direct authenticated execution is revoked. Use online_training_context().';

notify pgrst, 'reload schema';

commit;

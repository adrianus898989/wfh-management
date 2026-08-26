begin;

set local search_path = pg_catalog;

-- The search function already resolves the authoritative employee hire date in
-- candidate_people and already groups by it, but person_rollup accidentally
-- stopped one column before exposing it in the JSON payload. Patch that single
-- projection in-place so the signature, security mode, scope checks, grants,
-- filters, ordering and every existing response field stay unchanged.
do $migration$
declare
  v_function regprocedure := to_regprocedure(
    'public.online_training_search_people(jsonb,integer,integer)'
  );
  v_definition text;
  v_before constant text := E'      candidate.trainer_name,\n      candidate.is_current_roster,';
  v_after constant text := E'      candidate.trainer_name,\n      candidate.hire_date,\n      candidate.is_current_roster,';
  v_match_count integer;
begin
  if v_function is null then
    raise exception 'online_training_search_people(jsonb,integer,integer) is missing';
  end if;

  v_definition := pg_get_functiondef(v_function);

  if strpos(v_definition, v_after) = 0 then
    v_match_count := (
      length(v_definition) - length(replace(v_definition, v_before, ''))
    ) / length(v_before);

    if v_match_count <> 1 then
      raise exception
        'expected one online_training_search_people person_rollup projection, found %',
        v_match_count;
    end if;

    execute replace(v_definition, v_before, v_after);
  end if;

  if strpos(
    pg_get_functiondef(
      'public.online_training_search_people(jsonb,integer,integer)'::regprocedure
    ),
    v_after
  ) = 0 then
    raise exception 'online_training_search_people did not expose candidate.hire_date';
  end if;
end;
$migration$;

commit;

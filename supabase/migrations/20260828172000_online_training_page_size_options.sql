begin;

set local lock_timeout = '500ms';
set local statement_timeout = '10s';

-- Raise only the bounded page-size cap. Abort if either deployed function has
-- drifted so a production change can never overwrite an unexpected guard.
do $online_training_page_size$
declare
  v_regprocedure regprocedure;
  v_definition text;
  v_old text;
  v_new text;
  v_page_size_argument text;
begin
  foreach v_regprocedure in array array[
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure,
    'public.online_training_search_people(jsonb,integer,integer)'::regprocedure
  ] loop
    select pg_get_functiondef(v_regprocedure) into v_definition;
    if v_regprocedure = 'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure then
      v_old := 'v_page_size integer := least(greatest(coalesce(p_page_size, 12), 1), 50);';
      v_new := 'v_page_size integer := least(greatest(coalesce(p_page_size, 20), 1), 100);';
      v_page_size_argument := 'p_page_size integer DEFAULT 12';
    else
      v_old := 'v_page_size integer := least(greatest(coalesce(p_page_size, 20), 1), 50);';
      v_new := 'v_page_size integer := least(greatest(coalesce(p_page_size, 20), 1), 100);';
      v_page_size_argument := 'p_page_size integer DEFAULT 20';
    end if;

    if strpos(v_definition, v_old) = 0
      or (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
      raise exception 'online_training_page_size_guard_changed: %', v_regprocedure::text;
    end if;
    if strpos(v_definition, v_page_size_argument) = 0
      or (length(v_definition) - length(replace(v_definition, v_page_size_argument, ''))) / length(v_page_size_argument) <> 1 then
      raise exception 'online_training_page_size_default_guard_changed: %', v_regprocedure::text;
    end if;

    v_definition := replace(v_definition, v_old, v_new);
    if v_regprocedure = 'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure then
      v_definition := replace(v_definition, 'p_page_size integer DEFAULT 12', 'p_page_size integer DEFAULT 20');
    end if;
    execute v_definition;

    if strpos(pg_get_function_arguments(v_regprocedure), 'p_page_size integer DEFAULT 20') = 0 then
      raise exception 'online_training_page_size_default_not_applied: %', v_regprocedure::text;
    end if;
  end loop;
end
$online_training_page_size$;

commit;

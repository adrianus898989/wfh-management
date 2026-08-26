-- Local regression test. Run only against a disposable database after all
-- migrations. It verifies that linked account writes can maintain the
-- user_access expression index without exposing its normalizer to anon.

begin;

set local search_path = pg_catalog;

do $$
declare
  v_function regprocedure :=
    'public.online_training_identity_key(text)'::regprocedure;
  v_security_definer boolean;
  v_volatility "char";
begin
  if not has_function_privilege('service_role', v_function, 'execute') then
    raise exception 'service_role cannot maintain the linked-account identity index';
  end if;

  if not has_function_privilege('authenticated', v_function, 'execute') then
    raise exception 'authenticated online-training identity lookup lost execute access';
  end if;

  if has_function_privilege('anon', v_function, 'execute') then
    raise exception 'anonymous callers can execute the identity normalizer';
  end if;

  select procedure.prosecdef, procedure.provolatile
  into v_security_definer, v_volatility
  from pg_proc procedure
  where procedure.oid = v_function;

  if v_security_definer or v_volatility <> 'i' then
    raise exception 'identity normalizer must stay immutable and security invoker';
  end if;

  if not exists (
    select 1
    from pg_index index_row
    join pg_class relation on relation.oid = index_row.indrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'user_access'
      and pg_get_indexdef(index_row.indexrelid)
        like '%online_training_identity_key(login_username)%'
      and pg_get_expr(index_row.indpred, index_row.indrelid)
        = '(employee_id IS NOT NULL)'
  ) then
    raise exception 'linked-account identity expression index is missing';
  end if;
end;
$$;

set local role service_role;
do $$
begin
  if public.online_training_identity_key(' capple.001 ') <> 'capple001' then
    raise exception 'service_role identity normalization returned an unexpected value';
  end if;
end;
$$;
reset role;

rollback;

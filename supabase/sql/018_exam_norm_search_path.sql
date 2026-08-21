create or replace function public.exam_norm(p_value text)
returns text language sql immutable parallel safe set search_path=public as $$
  select lower(regexp_replace(coalesce(p_value,''),'[[:space:]]+','','g'));
$$;

revoke all on function public.exam_norm(text) from public;
grant execute on function public.exam_norm(text) to authenticated;

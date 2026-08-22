-- Backward compatibility for cached staff bundles plus paginated own error history.
drop function if exists public.staff_exam_start(uuid);
drop function if exists public.staff_exam_start(text);

create function public.staff_exam_start(p_assignment_id text default null)
returns jsonb
language plpgsql
security definer
set search_path=public,auth
as $$
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  if coalesce(btrim(p_assignment_id),'') not in ('','adaptive') then
    raise exception '考试入口已更新，请刷新页面后重试';
  end if;
  return public.staff_exam_start_adaptive();
end;
$$;

revoke all on function public.staff_exam_start(text) from public, anon;
grant execute on function public.staff_exam_start(text) to authenticated;

create or replace function public.staff_portal_errors(p_page integer default 1,p_page_size integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,auth
as $$
declare
  c record;
  v_page integer:=greatest(coalesce(p_page,1),1);
  v_size integer:=least(greatest(coalesce(p_page_size,20),1),50);
  v_total bigint:=0;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联在职员工档案'; end if;

  select count(*) into v_total from public.employee_error_audit e
  where upper(btrim(e.employee_no))=upper(btrim(c.employee_no));

  return jsonb_build_object(
    'page',v_page,'page_size',v_size,'total',v_total,
    'pages',greatest(1,ceil(v_total::numeric/v_size)::integer),
    'rows',(select coalesce(jsonb_agg(to_jsonb(x) order by x.qc_date desc nulls last,x.first_seen_at desc),'[]'::jsonb)
      from (select qc_date,error_type,error_note,correct_action,score,qc_person,leader_review,qc_result,review_date,first_seen_at
            from public.employee_error_audit
            where upper(btrim(employee_no))=upper(btrim(c.employee_no))
            order by qc_date desc nulls last,first_seen_at desc
            limit v_size offset (v_page-1)*v_size) x)
  );
end;
$$;

revoke all on function public.staff_portal_errors(integer,integer) from public, anon;
grant execute on function public.staff_portal_errors(integer,integer) to authenticated;

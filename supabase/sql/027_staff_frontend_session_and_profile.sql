create or replace function public.staff_portal_home()
returns jsonb
language plpgsql
stable security definer
set search_path to 'public', 'auth'
as $function$
declare c record;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联在职员工档案'; end if;
  return jsonb_build_object(
    'profile',(select to_jsonb(x) from (select e.employee_no,e.full_name,e.country,e.nationality,e.employment_type,e.status,e.hire_date,e.group_name,e.platform_scope,e.work_content,e.shift_name,e.work_tg,e.work_account,e.leader_name,e.trainer_name,e.person_in_charge,e.online_leader,e.online_trainer,t.name team_name,p.name position_name from public.employees e left join public.teams t on t.id=e.team_id left join public.positions p on p.id=e.position_id where e.id=c.employee_id) x),
    'payment',coalesce((select jsonb_build_object('payment_mode',pp.payment_mode,'transfer_using',pp.transfer_using,'account_name',pp.gcash_name,'bank_account_masked',case when nullif(btrim(pp.gcash_account),'') is null then null when length(btrim(pp.gcash_account))<=6 then left(btrim(pp.gcash_account),1)||'****'||right(btrim(pp.gcash_account),1) else left(btrim(pp.gcash_account),4)||'****'||right(btrim(pp.gcash_account),4) end,'usdt_address_masked',case when nullif(btrim(pp.usdt_address),'') is null then null when length(btrim(pp.usdt_address))<=6 then left(btrim(pp.usdt_address),1)||'****'||right(btrim(pp.usdt_address),1) else left(btrim(pp.usdt_address),4)||'****'||right(btrim(pp.usdt_address),4) end,'contact_phone',pp.contact_phone,'whatsapp_number',pp.whatsapp_number,'facebook',pp.facebook,'employee_address',pp.employee_address) from public.employee_payment_profiles pp where pp.employee_id=c.employee_id),'{}'::jsonb),
    'error_summary',coalesce((select to_jsonb(x) from (select month_error_count,last_30d_error_count,total_error_count,total_deduct,last_error_date,main_error_type,risk_level from public.employee_error_summary where upper(btrim(employee_no))=upper(btrim(c.employee_no)) order by updated_at desc limit 1) x),'{}'::jsonb),
    'recent_errors',(select coalesce(jsonb_agg(to_jsonb(x) order by x.qc_date desc nulls last),'[]'::jsonb) from (select qc_date,error_type,error_note,correct_action,score,qc_person,leader_review,qc_result,review_date from public.employee_error_audit where upper(btrim(employee_no))=upper(btrim(c.employee_no)) order by qc_date desc nulls last,first_seen_at desc limit 12) x),
    'exam_summary',(select jsonb_build_object('total',count(*),'completed',count(*) filter(where status='graded'),'passed',count(*) filter(where status='graded' and passed),'average',coalesce(round(avg(percentage) filter(where status='graded'),1),0)) from public.exam_sessions where employee_id=c.employee_id and auth_user_id=auth.uid())
  );
end;
$function$;
create or replace function public.staff_portal_reveal_payment(p_field text) returns text language plpgsql stable security definer set search_path to 'public','auth' as $function$ declare c record; v text; begin if auth.uid() is null then raise exception '请先登录'; end if; select * into c from public.exam_staff_context(); if c.employee_id is null then raise exception '账号尚未关联在职员工档案'; end if; if p_field='bank_account' then select gcash_account into v from public.employee_payment_profiles where employee_id=c.employee_id; elsif p_field='usdt_address' then select usdt_address into v from public.employee_payment_profiles where employee_id=c.employee_id; else raise exception '不支持的资料字段'; end if; return nullif(btrim(v),''); end; $function$;
revoke all on function public.staff_portal_reveal_payment(text) from public, anon;
grant execute on function public.staff_portal_reveal_payment(text) to authenticated;

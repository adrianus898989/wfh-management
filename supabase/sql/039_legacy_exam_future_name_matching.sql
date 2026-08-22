-- Keep future incremental legacy exam imports matched even when the old account
-- field contains a person's name instead of an employee ID.
create or replace function public.legacy_exam_match_employee_row()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_count integer;v_employee_id uuid;
begin
  select count(distinct e.id),case when count(distinct e.id)=1 then min(e.id::text)::uuid end
  into v_count,v_employee_id from public.employees e
  where nullif(public.exam_norm(new.employee_no),'') is not null
    and public.exam_norm(e.employee_no)=public.exam_norm(new.employee_no);
  if v_count=1 then new.employee_id:=v_employee_id;new.employee_match_status:='matched';return new;end if;
  if v_count>1 then new.employee_id:=null;new.employee_match_status:='ambiguous';return new;end if;
  select count(distinct e.id),case when count(distinct e.id)=1 then min(e.id::text)::uuid end
  into v_count,v_employee_id from public.employees e
  where public.exam_norm(e.full_name) in(nullif(public.exam_norm(new.employee_name),''),nullif(public.exam_norm(new.employee_no),''));
  new.employee_id:=case when v_count=1 then v_employee_id end;
  new.employee_match_status:=case when v_count=1 then 'matched' when v_count>1 then 'ambiguous' else 'unmatched' end;
  return new;
end $$;

revoke all on function public.legacy_exam_match_employee_row() from public,anon,authenticated;
drop trigger if exists legacy_exam_match_employee_before_write on public.legacy_exam_sessions;
create trigger legacy_exam_match_employee_before_write before insert or update of employee_no,employee_name,employee_id,employee_match_status
on public.legacy_exam_sessions for each row execute function public.legacy_exam_match_employee_row();

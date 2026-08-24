-- Keep the employee portal shift aligned with the latest private roster snapshot.
-- The caller cannot choose an employee: exam_staff_context() resolves the
-- authenticated staff member, and the roster cache is joined only by that ID.

create or replace function public.staff_portal_home()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c record;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;

  select * into c from public.exam_staff_context();
  if c.employee_id is null then
    raise exception '账号尚未关联在职员工档案';
  end if;

  return jsonb_build_object(
    'schedule', coalesce((
      select jsonb_build_object(
        'shift_name', nullif(btrim(d.shift_name), ''),
        'team_name', nullif(btrim(d.team_name), ''),
        'group_name', nullif(btrim(d.group_name), ''),
        'position_name', nullif(btrim(d.position_name), ''),
        'platform_name', nullif(btrim(d.platform_name), ''),
        'refreshed_at', d.refreshed_at,
        'source_kind', d.source_kind
      )
      from public.report_employee_directory_cache d
      where upper(btrim(d.employee_no)) = upper(btrim(c.employee_no))
      limit 1
    ), '{}'::jsonb),
    'profile', (
      select to_jsonb(x)
      from (
        select
          e.employee_no,
          e.full_name,
          e.country,
          e.nationality,
          e.employment_type,
          e.status,
          e.hire_date,
          e.group_name,
          e.platform_scope,
          e.work_content,
          e.shift_name,
          nullif(btrim(d.shift_name), '') as schedule_shift,
          coalesce(nullif(btrim(d.shift_name), ''), nullif(btrim(e.shift_name), '')) as current_shift,
          e.work_tg,
          e.work_account,
          e.leader_name,
          e.trainer_name,
          e.person_in_charge,
          e.online_leader,
          e.online_trainer,
          t.name as team_name,
          p.name as position_name
        from public.employees e
        left join public.teams t on t.id = e.team_id
        left join public.positions p on p.id = e.position_id
        left join public.report_employee_directory_cache d
          on upper(btrim(d.employee_no)) = upper(btrim(e.employee_no))
        where e.id = c.employee_id
      ) x
    ),
    'payment', coalesce((
      select jsonb_build_object(
        'payment_mode', pp.payment_mode,
        'transfer_using', pp.transfer_using,
        'account_name', pp.gcash_name,
        'bank_account_masked', case
          when nullif(btrim(pp.gcash_account), '') is null then null
          when length(btrim(pp.gcash_account)) <= 6 then left(btrim(pp.gcash_account), 1) || '****' || right(btrim(pp.gcash_account), 1)
          else left(btrim(pp.gcash_account), 4) || '****' || right(btrim(pp.gcash_account), 4)
        end,
        'usdt_address_masked', case
          when nullif(btrim(pp.usdt_address), '') is null then null
          when length(btrim(pp.usdt_address)) <= 6 then left(btrim(pp.usdt_address), 1) || '****' || right(btrim(pp.usdt_address), 1)
          else left(btrim(pp.usdt_address), 4) || '****' || right(btrim(pp.usdt_address), 4)
        end,
        'contact_phone', pp.contact_phone,
        'whatsapp_number', pp.whatsapp_number,
        'facebook', pp.facebook,
        'employee_address', pp.employee_address
      )
      from public.employee_payment_profiles pp
      where pp.employee_id = c.employee_id
    ), '{}'::jsonb),
    'error_summary', coalesce((
      select to_jsonb(x)
      from (
        select
          month_error_count,
          last_30d_error_count,
          total_error_count,
          total_deduct,
          last_error_date,
          main_error_type,
          risk_level
        from public.employee_error_summary
        where upper(btrim(employee_no)) = upper(btrim(c.employee_no))
        order by updated_at desc
        limit 1
      ) x
    ), '{}'::jsonb),
    'recent_errors', (
      select coalesce(
        jsonb_agg(to_jsonb(x) order by x.qc_date desc nulls last, x.source_row desc nulls last),
        '[]'::jsonb
      )
      from (
        select
          record_key,
          source_row,
          qc_date,
          error_type,
          error_note,
          correct_action,
          score,
          qc_person,
          leader_review,
          qc_result,
          review_date
        from public.report_employee_errors_v
        where employee_no = upper(btrim(c.employee_no))
        order by qc_date desc nulls last, source_row desc nulls last
        limit 12
      ) x
    ),
    'exam_summary', (
      select jsonb_build_object(
        'total', count(*),
        'completed', count(*) filter (where status = 'graded'),
        'passed', count(*) filter (where status = 'graded' and passed),
        'average', coalesce(round(avg(percentage) filter (where status = 'graded'), 1), 0),
        'current', count(*) filter (where source_system = 'current'),
        'legacy', count(*) filter (where source_system = 'legacy'),
        'pending', count(*) filter (where status in ('submitted', 'grading', 'in_progress'))
      )
      from public.admin_exam_combined_sessions_v
      where employee_id = c.employee_id
    ),
    'exam_history', (
      select coalesce(
        jsonb_agg(to_jsonb(x) order by x.started_at desc),
        '[]'::jsonb
      )
      from (
        select
          id,
          title,
          attempt_no,
          status,
          started_at,
          submitted_at,
          graded_at,
          earned_score,
          total_score,
          percentage,
          passed,
          grader_name,
          correct_count,
          partial_count,
          wrong_count,
          pending_count,
          source_system,
          source_label,
          answer_detail_available,
          answer_detail_count,
          total_question_count,
          unanswered_count
        from public.admin_exam_combined_sessions_v
        where employee_id = c.employee_id
          and status <> 'in_progress'
        order by started_at desc
        limit 100
      ) x
    )
  );
end;
$$;

revoke all on function public.staff_portal_home()
  from public, anon, authenticated;
grant execute on function public.staff_portal_home()
  to authenticated;

comment on function public.staff_portal_home() is
  'Returns the authenticated staff member own portal profile, with shift sourced from the latest private roster snapshot when available.';

begin;

set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- online_training_list only returns published reports, so the reviewed
-- set-based visibility helper installed immediately before this migration is
-- semantically equivalent to the old per-report can_view/caller/scope chain.
-- Fail closed if either dependency or the production reader shape drifted.
do $install_online_training_list$
declare
  v_signature constant regprocedure :=
    'public.online_training_list(text,date,date,uuid,integer,integer)'::regprocedure;
  v_definition text;
  v_acl_before aclitem[];
  v_owner_before oid;
  v_comment_before text;
  v_new_definition constant text := $ddl$
create or replace function public.online_training_list(
  p_query text default '',
  p_date_from date default null,
  p_date_to date default null,
  p_employee_id uuid default null,
  p_page integer default 1,
  p_page_size integer default 12
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 12), 1), 100);
  v_total integer;
  v_rows jsonb;
  v_full_scope boolean := false;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;

  select public.is_founder() or exists (
    select 1
    from public.user_access access
    where access.auth_user_id = (select auth.uid())
      and access.active = true
      and access.backend_enabled = true
      and access.data_scope = 'all'
  ) into v_full_scope;

  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;

  if p_employee_id is not null
     and not public.online_training_employee_history_in_scope(p_employee_id) then
    raise exception '无权查看该员工培训记录';
  end if;

  with allowed_employee_ids as materialized (
    select distinct scope.employee_id
    from session_private.online_training_effective_employee_ids() scope
    where scope.employee_id is not null
  ), visible as materialized (
    select report.*
    from public.online_training_reports report
    join session_private.online_training_visible_published_report_ids(
      p_date_from,
      p_date_to
    ) visible_report on visible_report.report_id = report.id
    where report.status = 'published'
      and (p_date_from is null or report.report_date >= p_date_from)
      and (p_date_to is null or report.report_date <= p_date_to)
      and exists (
        select 1
        from public.online_training_report_members scoped_member
        join allowed_employee_ids allowed_member
          on allowed_member.employee_id = scoped_member.employee_id
        where scoped_member.report_id = report.id
          and (
            p_employee_id is null
            or scoped_member.employee_id = p_employee_id
          )
      )
      and (
        v_query = ''
        or lower(concat_ws(' ',
          report.title,
          report.platform,
          report.shift_name,
          report.team_name,
          report.group_name,
          report.leader_name,
          report.trainer_name,
          report.course_type,
          report.report_summary,
          report.issues_summary,
          report.next_plan
        )) like '%' || v_query || '%'
        or exists (
          select 1
          from public.online_training_report_members member_filter
          join allowed_employee_ids allowed_member
            on allowed_member.employee_id = member_filter.employee_id
          where member_filter.report_id = report.id
            and (
              p_employee_id is null
              or member_filter.employee_id = p_employee_id
            )
            and lower(concat_ws(' ',
              member_filter.employee_no,
              member_filter.employee_name,
              member_filter.position_name,
              member_filter.team_name,
              member_filter.group_name,
              member_filter.shift_name,
              member_filter.platform,
              member_filter.work_details,
              member_filter.performance,
              member_filter.issues,
              member_filter.follow_up
            )) like '%' || v_query || '%'
        )
      )
  ), counted as materialized (
    select count(*)::integer total
    from visible
  ), paged as materialized (
    select report.*
    from visible report
    order by report.report_date desc, report.created_at desc
    offset (v_page - 1) * v_page_size
    limit v_page_size
  ), row_payload as materialized (
    select coalesce(jsonb_agg(
      (
        case
          when p_employee_id is null and v_full_scope then to_jsonb(report)
          else to_jsonb(report)
            - 'attachments'
            - 'report_summary'
            - 'issues_summary'
            - 'next_plan'
            - 'review_note'
        end
      )
      || jsonb_build_object(
        'can_edit', case
          when p_employee_id is null
            and (
              v_full_scope
              or not exists (
                select 1
                from public.online_training_report_members outside_member
                left join allowed_employee_ids allowed_member
                  on allowed_member.employee_id = outside_member.employee_id
                where outside_member.report_id = report.id
                  and allowed_member.employee_id is null
              )
            )
          then public.online_training_can_edit_report(report.id)
          else false
        end,
        'can_review', case
          when p_employee_id is null
            and (
              v_full_scope
              or not exists (
                select 1
                from public.online_training_report_members outside_member
                left join allowed_employee_ids allowed_member
                  on allowed_member.employee_id = outside_member.employee_id
                where outside_member.report_id = report.id
                  and allowed_member.employee_id is null
              )
            )
          then public.online_training_can_review_report(report.id)
          else false
        end,
        'members', coalesce((
          select jsonb_agg(
            to_jsonb(member)
            || jsonb_build_object('hire_date', employee.hire_date)
            order by member.sort_order, member.employee_name
          )
          from public.online_training_report_members member
          join allowed_employee_ids allowed_member
            on allowed_member.employee_id = member.employee_id
          left join public.employees employee
            on employee.id = member.employee_id
          where member.report_id = report.id
            and (
              p_employee_id is null
              or member.employee_id = p_employee_id
            )
        ), '[]'::jsonb)
      )
      order by report.report_date desc, report.created_at desc
    ), '[]'::jsonb) rows
    from paged report
  )
  select counted.total, row_payload.rows
  into v_total, v_rows
  from counted
  cross join row_payload;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'page', v_page,
    'page_size', v_page_size,
    'pages', greatest(1, ceil(v_total::numeric / v_page_size)::integer)
  );
end;
$body$;
$ddl$;
begin
  if pg_catalog.to_regprocedure(
       'session_private.online_training_visible_published_report_ids(date,date)'
     ) is null
     or pg_catalog.to_regprocedure(
       'session_private.online_training_effective_employee_ids()'
     ) is null then
    raise exception 'online_training_list_set_visibility_prerequisite_missing';
  end if;

  select
    procedure.proacl,
    procedure.proowner,
    pg_catalog.obj_description(procedure.oid, 'pg_proc'),
    pg_catalog.pg_get_functiondef(procedure.oid)
  into
    v_acl_before,
    v_owner_before,
    v_comment_before,
    v_definition
  from pg_catalog.pg_proc procedure
  where procedure.oid = v_signature
    and procedure.prosecdef
    and procedure.provolatile = 's'
    and coalesce(
      procedure.proconfig @> array['search_path=""']::text[],
      false
    );

  if v_definition is null
     or pg_catalog.strpos(
       v_definition,
       'public.online_training_can_view_report(report.id)'
     ) = 0
     or pg_catalog.strpos(
       v_definition,
       'public.online_training_employee_in_scope(scoped_member.employee_id)'
     ) = 0
     or pg_catalog.strpos(
       v_definition,
       'public.online_training_caller_is_report_trainer(report.id)'
     ) = 0
     or pg_catalog.strpos(
       v_definition,
       'least(greatest(coalesce(p_page_size, 12), 1), 100)'
     ) = 0
     or pg_catalog.strpos(
       v_definition,
       $shape$jsonb_build_object('hire_date', employee.hire_date)$shape$
     ) = 0 then
    raise exception 'online_training_list_production_shape_changed';
  end if;

  execute v_new_definition;

  if (select procedure.proacl
      from pg_catalog.pg_proc procedure
      where procedure.oid = v_signature) is distinct from v_acl_before
     or (select procedure.proowner
         from pg_catalog.pg_proc procedure
         where procedure.oid = v_signature) is distinct from v_owner_before
     or (select pg_catalog.obj_description(procedure.oid, 'pg_proc')
         from pg_catalog.pg_proc procedure
         where procedure.oid = v_signature) is distinct from v_comment_before then
    raise exception 'online_training_list_metadata_changed';
  end if;
end
$install_online_training_list$;

do $verify_online_training_list$
declare
  v_signature constant regprocedure :=
    'public.online_training_list(text,date,date,uuid,integer,integer)'::regprocedure;
  v_definition text;
begin
  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;

  if pg_catalog.strpos(
       v_definition,
       'session_private.online_training_visible_published_report_ids('
     ) = 0
     or pg_catalog.strpos(
       v_definition,
       'session_private.online_training_effective_employee_ids()'
     ) = 0
     or pg_catalog.strpos(v_definition, 'visible as materialized') = 0
     or pg_catalog.strpos(v_definition, 'counted as materialized') = 0
     or pg_catalog.strpos(v_definition, 'paged as materialized') = 0
     or pg_catalog.strpos(v_definition, 'row_payload as materialized') = 0
     or pg_catalog.strpos(
       v_definition,
       'public.online_training_can_view_report(report.id)'
     ) > 0
     or pg_catalog.strpos(
       v_definition,
       'public.online_training_caller_is_report_trainer(report.id)'
     ) > 0
     or pg_catalog.strpos(
       v_definition,
       'public.online_training_employee_in_scope('
     ) > 0 then
    raise exception 'online_training_list_set_visibility_verify_failed';
  end if;
end
$verify_online_training_list$;

commit;

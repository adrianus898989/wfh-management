-- Daily work reports, training reports, handovers and private screenshots.

insert into public.permissions (code, name, category, sensitive)
values
  ('daily_work.submit', '每日工作 · 提交记录', 'daily_work', false),
  ('daily_work.manage', '每日工作 · 管理全部记录', 'daily_work', false)
on conflict (code) do update
set name = excluded.name,
    category = excluded.category,
    sensitive = excluded.sensitive;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'daily_work.submit'
where r.code in ('supervisor', 'team_leader', 'trainer')
on conflict do nothing;

create table if not exists public.daily_work_reports (
  id uuid primary key default gen_random_uuid(),
  report_type text not null check (report_type in ('work', 'training', 'handover')),
  report_date date not null default current_date,
  report_end_date date,
  title text not null,
  platform text not null default '',
  shift_name text not null default '',
  team_name text not null default '',
  team_leader text not null default '',
  trainer_name text not null default '',
  course_type text not null default '',
  staff_list text not null default '',
  work_summary text not null default '',
  employee_updates text not null default '',
  response_metrics text not null default '',
  handover_notes text not null default '',
  issues text not null default '',
  next_plan text not null default '',
  handover_status text not null default 'pending'
    check (handover_status in ('pending', 'in_progress', 'done')),
  attachments jsonb not null default '[]'::jsonb
    check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 12),
  created_by uuid not null,
  updated_by uuid,
  author_name text not null default '',
  author_employee_no text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_work_report_end_date_check
    check (report_end_date is null or report_end_date >= report_date),
  constraint daily_work_report_title_check
    check (char_length(btrim(title)) between 2 and 160),
  constraint daily_work_report_content_check
    check (
      char_length(btrim(work_summary)) > 0
      or char_length(btrim(employee_updates)) > 0
      or char_length(btrim(handover_notes)) > 0
    )
);

comment on table public.daily_work_reports is
  'Shared daily work, online training and handover records. Owners manage their own rows; daily_work.manage manages all rows.';

create index if not exists daily_work_reports_date_idx
  on public.daily_work_reports (report_date desc, created_at desc);
create index if not exists daily_work_reports_type_date_idx
  on public.daily_work_reports (report_type, report_date desc);
create index if not exists daily_work_reports_creator_idx
  on public.daily_work_reports (created_by, report_date desc);

create or replace function public.daily_work_is_active_backend()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_access ua
    where ua.auth_user_id = (select auth.uid())
      and ua.active = true
      and ua.backend_enabled = true
  );
$$;

create or replace function public.daily_work_can_manage(p_created_by uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.daily_work_is_active_backend()
    and (
      p_created_by = (select auth.uid())
      or public.has_permission('daily_work.manage')
    );
$$;

revoke all on function public.daily_work_is_active_backend() from public;
revoke all on function public.daily_work_can_manage(uuid) from public;
grant execute on function public.daily_work_is_active_backend() to authenticated;
grant execute on function public.daily_work_can_manage(uuid) to authenticated;

create or replace function public.daily_work_set_metadata()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_author_name text;
  v_employee_no text;
begin
  if v_user_id is null or not public.daily_work_is_active_backend() then
    raise exception '无后台权限';
  end if;

  if tg_op = 'INSERT' then
    if not public.has_permission('daily_work.submit') then
      raise exception '无提交每日工作权限';
    end if;

    select
      coalesce(nullif(btrim(e.full_name), ''), nullif(btrim(ua.login_username), ''), '后台用户'),
      coalesce(nullif(btrim(e.employee_no), ''), '')
    into v_author_name, v_employee_no
    from public.user_access ua
    left join public.employees e on e.id = ua.employee_id
    where ua.auth_user_id = v_user_id
      and ua.active = true
      and ua.backend_enabled = true;

    new.created_by := v_user_id;
    new.updated_by := v_user_id;
    new.author_name := coalesce(v_author_name, '后台用户');
    new.author_employee_no := coalesce(v_employee_no, '');
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.author_name := old.author_name;
    new.author_employee_no := old.author_employee_no;
    new.created_at := old.created_at;
    new.updated_by := v_user_id;
  end if;

  new.title := btrim(new.title);
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.daily_work_set_metadata() from public;

drop trigger if exists daily_work_set_metadata_trigger on public.daily_work_reports;
create trigger daily_work_set_metadata_trigger
before insert or update on public.daily_work_reports
for each row execute function public.daily_work_set_metadata();

create or replace function public.daily_work_audit_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.daily_work_reports;
  v_employee_id uuid;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  select employee_id into v_employee_id
  from public.user_access
  where auth_user_id = (select auth.uid());

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, record_id, old_data, new_data, reason
  ) values (
    (select auth.uid()),
    v_employee_id,
    'daily_work',
    lower(tg_op),
    v_row.id::text,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end,
    v_row.report_type || ' · ' || v_row.report_date::text || ' · ' || v_row.title
  );

  return v_row;
end;
$$;

revoke all on function public.daily_work_audit_change() from public;

drop trigger if exists daily_work_audit_trigger on public.daily_work_reports;
create trigger daily_work_audit_trigger
after insert or update or delete on public.daily_work_reports
for each row execute function public.daily_work_audit_change();

alter table public.daily_work_reports enable row level security;

drop policy if exists daily_work_read_all_backend on public.daily_work_reports;
create policy daily_work_read_all_backend
on public.daily_work_reports
for select
to authenticated
using (public.daily_work_is_active_backend());

drop policy if exists daily_work_submit on public.daily_work_reports;
create policy daily_work_submit
on public.daily_work_reports
for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and public.has_permission('daily_work.submit')
);

drop policy if exists daily_work_update_owner_or_manager on public.daily_work_reports;
create policy daily_work_update_owner_or_manager
on public.daily_work_reports
for update
to authenticated
using (public.daily_work_can_manage(created_by))
with check (public.daily_work_can_manage(created_by));

drop policy if exists daily_work_delete_owner_or_manager on public.daily_work_reports;
create policy daily_work_delete_owner_or_manager
on public.daily_work_reports
for delete
to authenticated
using (public.daily_work_can_manage(created_by));

grant select, insert, update, delete on public.daily_work_reports to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'daily-work',
  'daily-work',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists daily_work_storage_read on storage.objects;
create policy daily_work_storage_read
on storage.objects
for select
to authenticated
using (
  bucket_id = 'daily-work'
  and public.daily_work_is_active_backend()
);

drop policy if exists daily_work_storage_upload on storage.objects;
create policy daily_work_storage_upload
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'daily-work'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and public.has_permission('daily_work.submit')
);

drop policy if exists daily_work_storage_delete on storage.objects;
create policy daily_work_storage_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'daily-work'
  and (
    owner_id = (select auth.uid())::text
    or public.has_permission('daily_work.manage')
    or exists (
      select 1
      from public.daily_work_reports r,
           jsonb_array_elements(r.attachments) attachment
      where attachment ->> 'path' = storage.objects.name
        and r.created_by = (select auth.uid())
    )
  )
);

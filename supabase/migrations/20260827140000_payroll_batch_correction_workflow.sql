begin;

-- Preserve every imported payroll batch as an auditable business document.
-- A mistaken draft or archived import is voided, never physically erased.
alter table public.payroll_batches
  add column if not exists created_by_name text,
  add column if not exists updated_by uuid references auth.users(id) on delete set null,
  add column if not exists updated_by_name text,
  add column if not exists published_by_name text,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references auth.users(id) on delete set null,
  add column if not exists archived_by_name text,
  add column if not exists archive_reason text,
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references auth.users(id) on delete set null,
  add column if not exists voided_by_name text,
  add column if not exists void_reason text,
  add column if not exists voided_prior_status text,
  add column if not exists correction_of_batch_id bigint
    references public.payroll_batches(id) on delete restrict;

do $payroll_batch_correction_constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.payroll_batches'::regclass
      and constraint_row.conname = 'payroll_batches_voided_prior_status_check'
  ) then
    alter table public.payroll_batches
      add constraint payroll_batches_voided_prior_status_check
      check (voided_prior_status is null or voided_prior_status in ('draft','archived'));
  end if;
end;
$payroll_batch_correction_constraints$;

create index if not exists payroll_batches_correction_parent_idx
  on public.payroll_batches(correction_of_batch_id)
  where correction_of_batch_id is not null;
create index if not exists payroll_batches_voided_updated_idx
  on public.payroll_batches(voided_at,updated_at desc)
  where voided_at is not null;

-- Resolve a human-readable account once, then persist that value beside the
-- UUID. The snapshot remains useful if the user_access row is renamed later.
create or replace function payroll_private.admin_payroll_actor_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path=''
as $$
  select case when p_user_id is null then null else coalesce(
    (
      select coalesce(
        nullif(btrim(access.login_username),''),
        nullif(btrim(access.login_email),'')
      )
      from public.user_access access
      where access.auth_user_id = p_user_id
      order by access.updated_at desc
      limit 1
    ),
    left(p_user_id::text,8)
  ) end;
$$;
revoke all on function payroll_private.admin_payroll_actor_name(uuid)
  from public,anon,authenticated;

-- Best-effort snapshots for historical rows. The latest payroll audit actor is
-- a safer approximation of "last editor" than blindly using the creator.
update public.payroll_batches batch
set created_by_name = coalesce(
      batch.created_by_name,
      payroll_private.admin_payroll_actor_name(batch.created_by)
    ),
    published_by_name = coalesce(
      batch.published_by_name,
      payroll_private.admin_payroll_actor_name(batch.published_by)
    )
where batch.created_by_name is null or batch.published_by_name is null;

with latest_actor as (
  select distinct on (audit.batch_id)
    audit.batch_id,audit.actor_user_id
  from public.payroll_audit_log audit
  where audit.batch_id is not null and audit.actor_user_id is not null
  order by audit.batch_id,audit.created_at desc,audit.id desc
)
update public.payroll_batches batch
set updated_by = coalesce(batch.updated_by,latest_actor.actor_user_id,batch.published_by,batch.created_by)
from latest_actor
where latest_actor.batch_id = batch.id
  and batch.updated_by is null;

update public.payroll_batches batch
set updated_by = coalesce(batch.updated_by,batch.published_by,batch.created_by),
    updated_by_name = coalesce(
      batch.updated_by_name,
      payroll_private.admin_payroll_actor_name(
        coalesce(batch.updated_by,batch.published_by,batch.created_by)
      )
    )
where batch.updated_by is null or batch.updated_by_name is null;

create or replace function payroll_private.admin_payroll_batch_metadata(p_batch_id bigint)
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select jsonb_build_object(
    'notes',batch.notes,
    'created_by',batch.created_by,
    'created_by_name',coalesce(
      batch.created_by_name,
      payroll_private.admin_payroll_actor_name(batch.created_by)
    ),
    'updated_by',batch.updated_by,
    'updated_by_name',coalesce(
      batch.updated_by_name,
      payroll_private.admin_payroll_actor_name(batch.updated_by)
    ),
    'updated_at',batch.updated_at,
    'published_by',batch.published_by,
    'published_by_name',coalesce(
      batch.published_by_name,
      payroll_private.admin_payroll_actor_name(batch.published_by)
    ),
    'archived_at',batch.archived_at,
    'archived_by',batch.archived_by,
    'archived_by_name',coalesce(
      batch.archived_by_name,
      payroll_private.admin_payroll_actor_name(batch.archived_by)
    ),
    'archive_reason',batch.archive_reason,
    'voided_at',batch.voided_at,
    'voided_by',batch.voided_by,
    'voided_by_name',coalesce(
      batch.voided_by_name,
      payroll_private.admin_payroll_actor_name(batch.voided_by)
    ),
    'void_reason',batch.void_reason,
    'voided_prior_status',batch.voided_prior_status,
    'correction_of_batch_id',batch.correction_of_batch_id,
    'is_voided',batch.voided_at is not null
  )
  from public.payroll_batches batch
  where batch.id = p_batch_id;
$$;

create or replace function payroll_private.admin_payroll_enrich_page(p_result jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_batches jsonb := '[]'::jsonb;
  v_selected jsonb := 'null'::jsonb;
begin
  select coalesce(jsonb_agg(
    item.batch_data || coalesce(
      payroll_private.admin_payroll_batch_metadata(
        case when item.batch_data->>'id' ~ '^[0-9]+$'
          then (item.batch_data->>'id')::bigint end
      ),
      '{}'::jsonb
    ) order by item.ordinality
  ),'[]'::jsonb)
  into v_batches
  from jsonb_array_elements(coalesce(p_result->'batches','[]'::jsonb))
    with ordinality as item(batch_data,ordinality);

  if jsonb_typeof(p_result->'selected_batch') = 'object' then
    v_selected := (p_result->'selected_batch') || coalesce(
      payroll_private.admin_payroll_batch_metadata(
        case when p_result->'selected_batch'->>'id' ~ '^[0-9]+$'
          then (p_result->'selected_batch'->>'id')::bigint end
      ),
      '{}'::jsonb
    );
  end if;

  return jsonb_set(
    jsonb_set(p_result,'{batches}',v_batches,true),
    '{selected_batch}',v_selected,true
  );
end;
$$;

revoke all on function payroll_private.admin_payroll_batch_metadata(bigint),
  payroll_private.admin_payroll_enrich_page(jsonb)
  from public,anon,authenticated;

-- Keep every reader on the existing employee-scope implementation and enrich
-- only the rows it already authorized.
create or replace function public.admin_payroll_pending_page(p_batch_id bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare v_result jsonb; v_full_scope boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not public.has_permission('payroll.pending.view') then raise exception 'permission_denied'; end if;
  v_full_scope := payroll_private.admin_payroll_has_full_scope();
  v_result := payroll_private.admin_payroll_enrich_page(
    payroll_private.admin_payroll_granular_page('draft',p_batch_id,true)
  );
  return v_result || jsonb_build_object('permissions',jsonb_build_object(
    'edit',v_full_scope and public.has_permission('payroll.pending.edit'),
    'approve',v_full_scope and public.has_permission('payroll.pending.approve'),
    'publish',v_full_scope and public.has_permission('payroll.pending.publish'),
    'export',false
  ));
end;
$$;

create or replace function public.admin_payroll_published_page(p_batch_id bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_result jsonb;
  v_full_scope boolean;
  v_latest_id bigint;
  v_latest_status text;
  v_latest_voided_at timestamptz;
  v_empty_reason text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not public.has_permission('payroll.published.view') then raise exception 'permission_denied'; end if;
  v_full_scope := payroll_private.admin_payroll_has_full_scope();
  v_result := payroll_private.admin_payroll_enrich_page(
    payroll_private.admin_payroll_granular_page('published',p_batch_id,true)
  );

  if jsonb_array_length(coalesce(v_result->'batches','[]'::jsonb)) = 0 then
    if v_full_scope then
      select batch.id,batch.status,batch.voided_at
      into v_latest_id,v_latest_status,v_latest_voided_at
      from public.payroll_batches batch
      order by batch.updated_at desc,batch.id desc
      limit 1;
    end if;
    v_empty_reason := case
      when not v_full_scope then '当前无有效发布批次。'
      when v_latest_id is null then '当前无有效发布批次，尚未导入工资资料。'
      when v_latest_voided_at is not null then '当前无有效发布批次，最近批次已删除/作废；可到“导入记录”恢复或创建纠正草稿。'
      when v_latest_status = 'archived' then '当前无有效发布批次，最近批次已归档；已归档表示同月份新批次发布后自动替代旧批次。'
      when v_latest_status = 'draft' then '当前无有效发布批次，最近批次仍是待发布草稿。'
      else '当前无有效发布批次，请到“导入记录”核对批次状态。'
    end;
    v_result := v_result || jsonb_build_object('empty_reason',v_empty_reason);
  end if;

  return v_result || jsonb_build_object('permissions',jsonb_build_object(
    'edit',false,'approve',false,'publish',false,
    'export',public.has_permission('payroll.published.export')
  ));
end;
$$;

create or replace function public.admin_payroll_import_history_page(p_batch_id bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare v_result jsonb; v_full_scope boolean; v_edit boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not public.has_permission('payroll.import_history.view') then raise exception 'permission_denied'; end if;
  v_full_scope := payroll_private.admin_payroll_has_full_scope();
  v_edit := v_full_scope and public.has_permission('payroll.import_history.edit');
  v_result := payroll_private.admin_payroll_enrich_page(
    payroll_private.admin_payroll_granular_page(
      null,p_batch_id,p_batch_id is not null and p_batch_id > 0
    )
  );
  return v_result || jsonb_build_object('permissions',jsonb_build_object(
    'edit',v_edit,'void',v_edit,'restore',v_edit,
    'clone_correction',v_edit,'approve',false,'publish',false,'export',false
  ));
end;
$$;

-- Preserve actor snapshots on existing import and publish mutations. The
-- legacy implementations still own row matching and publication rules.
create or replace function public.admin_payroll_import(p_batch jsonb,p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := auth.uid();
  v_actor_name text;
  v_result jsonb;
  v_batch_id bigint;
  v_started timestamptz := clock_timestamp();
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not public.has_permission('payroll.import_history.edit') then raise exception 'permission_denied'; end if;
  if not payroll_private.admin_payroll_has_full_scope() then raise exception 'payroll_all_scope_required'; end if;
  if jsonb_typeof(p_batch) <> 'object' then raise exception 'invalid_batch'; end if;
  if nullif(btrim(coalesce(p_batch->>'id','')),'') is not null then raise exception 'import_batch_id_not_allowed'; end if;

  v_actor_name := payroll_private.admin_payroll_actor_name(v_user);
  v_result := public.admin_payroll_import_granular_v1(
    jsonb_build_object(
      'period_start',p_batch->'period_start','title',p_batch->'title',
      'currency',p_batch->'currency','source_type','upload',
      'source_file_name',p_batch->'source_file_name','notes',p_batch->'notes'
    ),
    p_rows
  );
  v_batch_id := nullif(v_result->>'batch_id','')::bigint;

  update public.payroll_batches batch
  set created_by_name = coalesce(batch.created_by_name,v_actor_name),
      updated_by = v_user,updated_by_name = v_actor_name,
      updated_at = greatest(batch.updated_at,v_started)
  where batch.id = v_batch_id;
  update public.payroll_audit_log audit
  set detail = audit.detail || jsonb_build_object('actor_name',v_actor_name)
  where audit.id = (
    select log.id from public.payroll_audit_log log
    where log.batch_id = v_batch_id and log.actor_user_id = v_user
      and log.action = 'import'
    order by log.created_at desc,log.id desc limit 1
  );

  return jsonb_build_object(
    'batch_id',v_result->'batch_id','rows',v_result->'rows',
    'matched',v_result->'matched','unmatched',v_result->'unmatched',
    'resigned',v_result->'resigned'
  );
end;
$$;

create or replace function public.admin_payroll_publish(p_batch_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := auth.uid();
  v_actor_name text;
  v_period date;
  v_archived_ids bigint[] := '{}'::bigint[];
  v_result jsonb;
  v_started timestamptz := clock_timestamp();
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not public.has_permission('payroll.pending.publish') then raise exception 'permission_denied'; end if;
  if not payroll_private.admin_payroll_has_full_scope() then raise exception 'payroll_all_scope_required'; end if;

  select batch.period_start into v_period
  from public.payroll_batches batch
  where batch.id = p_batch_id and batch.status = 'draft' and batch.voided_at is null
  for update;
  if not found then raise exception 'batch_not_publishable'; end if;
  select coalesce(array_agg(batch.id order by batch.id),'{}'::bigint[])
  into v_archived_ids
  from public.payroll_batches batch
  where batch.period_start = v_period and batch.status = 'published'
    and batch.id <> p_batch_id and batch.voided_at is null;

  v_actor_name := payroll_private.admin_payroll_actor_name(v_user);
  v_result := public.admin_payroll_publish_granular_v1(p_batch_id);

  update public.payroll_batches batch
  set updated_by = v_user,updated_by_name = v_actor_name,
      published_by_name = v_actor_name
  where batch.id = p_batch_id;
  update public.payroll_batches batch
  set archived_at = coalesce(batch.archived_at,v_started),
      archived_by = v_user,archived_by_name = v_actor_name,
      archive_reason = format('批次 #%s 发布后自动替代同月份旧批次',p_batch_id),
      updated_by = v_user,updated_by_name = v_actor_name
  where batch.id = any(v_archived_ids);

  insert into public.payroll_audit_log(batch_id,actor_user_id,action,detail)
  select archived.archived_id,v_user,'auto_archive',jsonb_build_object(
    'actor_name',v_actor_name,'replacement_batch_id',p_batch_id,
    'period_start',v_period,
    'reason',format('批次 #%s 发布后自动替代同月份旧批次',p_batch_id)
  ) from unnest(v_archived_ids) as archived(archived_id);
  update public.payroll_audit_log audit
  set detail = audit.detail || jsonb_build_object('actor_name',v_actor_name)
  where audit.id = (
    select log.id from public.payroll_audit_log log
    where log.batch_id = p_batch_id and log.actor_user_id = v_user
      and log.action = 'publish'
    order by log.created_at desc,log.id desc limit 1
  );

  return jsonb_build_object(
    'batch_id',v_result->'batch_id','status',v_result->'status',
    'rows',v_result->'rows','excluded_rows',v_result->'excluded_rows',
    'resigned',v_result->'resigned','unmatched',v_result->'unmatched'
  );
end;
$$;

create or replace function public.admin_payroll_update_batch(
  p_batch_id bigint,
  p_title text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := auth.uid();
  v_actor_name text;
  v_before public.payroll_batches%rowtype;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not (public.has_permission('payroll.import_history.edit') or public.has_permission('payroll.pending.edit')) then raise exception 'permission_denied'; end if;
  if not payroll_private.admin_payroll_has_full_scope() then raise exception 'payroll_all_scope_required'; end if;
  if p_batch_id is null or p_batch_id <= 0 then raise exception 'invalid_batch'; end if;
  if nullif(btrim(coalesce(p_title,'')),'') is null then raise exception 'batch_title_required'; end if;
  if length(btrim(p_title)) > 200 then raise exception 'batch_title_too_long'; end if;
  if length(coalesce(p_notes,'')) > 2000 then raise exception 'batch_notes_too_long'; end if;

  select * into v_before from public.payroll_batches batch
  where batch.id = p_batch_id for update;
  if not found then raise exception 'batch_not_found'; end if;
  if v_before.status not in ('draft','archived') or v_before.voided_at is not null then raise exception 'only_active_draft_or_archived_metadata_can_be_edited'; end if;

  v_actor_name := payroll_private.admin_payroll_actor_name(v_user);
  update public.payroll_batches batch
  set title = btrim(p_title),notes = nullif(btrim(coalesce(p_notes,'')),''),
      updated_by = v_user,updated_by_name = v_actor_name,
      updated_at = clock_timestamp()
  where batch.id = p_batch_id;
  insert into public.payroll_audit_log(batch_id,actor_user_id,action,detail)
  values(p_batch_id,v_user,'update_batch',jsonb_build_object(
    'actor_name',v_actor_name,'status',v_before.status,
    'before',jsonb_build_object('title',v_before.title,'notes',v_before.notes),
    'after',jsonb_build_object('title',btrim(p_title),'notes',nullif(btrim(coalesce(p_notes,'')),''))
  ));
  return jsonb_build_object(
    'batch_id',p_batch_id,'title',btrim(p_title),
    'notes',nullif(btrim(coalesce(p_notes,'')),''),
    'updated_by_name',v_actor_name,'updated_at',clock_timestamp()
  );
end;
$$;

-- Keep the existing browser RPC name, but replace hard deletion with a
-- recoverable draft void. Payslips and the batch primary key remain intact.
create or replace function public.admin_payroll_delete(p_batch_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := auth.uid();
  v_actor_name text;
  v_batch public.payroll_batches%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not (public.has_permission('payroll.pending.edit') or public.has_permission('payroll.import_history.edit')) then raise exception 'permission_denied'; end if;
  if not payroll_private.admin_payroll_has_full_scope() then raise exception 'payroll_all_scope_required'; end if;
  select * into v_batch from public.payroll_batches batch
  where batch.id = p_batch_id for update;
  if not found then raise exception 'batch_not_found'; end if;
  if v_batch.status <> 'draft' or v_batch.voided_at is not null then raise exception 'only_active_draft_can_be_deleted'; end if;

  v_actor_name := payroll_private.admin_payroll_actor_name(v_user);
  update public.payroll_batches batch
  set status = 'archived',archived_at = v_now,archived_by = v_user,
      archived_by_name = v_actor_name,archive_reason = '错误草稿已移除（可恢复）',
      voided_at = v_now,voided_by = v_user,voided_by_name = v_actor_name,
      void_reason = '后台移除错误导入草稿',voided_prior_status = 'draft',
      updated_by = v_user,updated_by_name = v_actor_name,updated_at = v_now
  where batch.id = p_batch_id;
  insert into public.payroll_audit_log(batch_id,actor_user_id,action,detail)
  values(p_batch_id,v_user,'void_batch',jsonb_build_object(
    'actor_name',v_actor_name,'prior_status','draft','reason','后台移除错误导入草稿',
    'title',v_batch.title,'rows',v_batch.row_count,'recoverable',true
  ));
  return jsonb_build_object(
    'batch_id',p_batch_id,'deleted',true,'soft_deleted',true,
    'recoverable',true,'rows',v_batch.row_count
  );
end;
$$;

create or replace function public.admin_payroll_void_batch(
  p_batch_id bigint,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := auth.uid();
  v_actor_name text;
  v_batch public.payroll_batches%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not public.has_permission('payroll.import_history.edit') then raise exception 'permission_denied'; end if;
  if not payroll_private.admin_payroll_has_full_scope() then raise exception 'payroll_all_scope_required'; end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null then raise exception 'void_reason_required'; end if;
  if length(btrim(p_reason)) > 1000 then raise exception 'void_reason_too_long'; end if;
  select * into v_batch from public.payroll_batches batch
  where batch.id = p_batch_id for update;
  if not found then raise exception 'batch_not_found'; end if;
  if v_batch.status <> 'archived' or v_batch.voided_at is not null then raise exception 'only_active_archived_batch_can_be_voided'; end if;

  v_actor_name := payroll_private.admin_payroll_actor_name(v_user);
  update public.payroll_batches batch
  set voided_at = v_now,voided_by = v_user,voided_by_name = v_actor_name,
      void_reason = btrim(p_reason),voided_prior_status = 'archived',
      updated_by = v_user,updated_by_name = v_actor_name,updated_at = v_now
  where batch.id = p_batch_id;
  insert into public.payroll_audit_log(batch_id,actor_user_id,action,detail)
  values(p_batch_id,v_user,'void_batch',jsonb_build_object(
    'actor_name',v_actor_name,'prior_status','archived','reason',btrim(p_reason),
    'title',v_batch.title,'rows',v_batch.row_count,'recoverable',true
  ));
  return jsonb_build_object('batch_id',p_batch_id,'voided',true,'recoverable',true);
end;
$$;

create or replace function public.admin_payroll_restore_batch(p_batch_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := auth.uid();
  v_actor_name text;
  v_batch public.payroll_batches%rowtype;
  v_restore_status text;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not public.has_permission('payroll.import_history.edit') then raise exception 'permission_denied'; end if;
  if not payroll_private.admin_payroll_has_full_scope() then raise exception 'payroll_all_scope_required'; end if;
  select * into v_batch from public.payroll_batches batch
  where batch.id = p_batch_id for update;
  if not found then raise exception 'batch_not_found'; end if;
  if v_batch.voided_at is null then raise exception 'batch_not_voided'; end if;
  v_restore_status := case when v_batch.voided_prior_status = 'draft' then 'draft' else 'archived' end;
  v_actor_name := payroll_private.admin_payroll_actor_name(v_user);

  update public.payroll_batches batch
  set status = v_restore_status,
      archived_at = case when v_restore_status = 'draft' then null else batch.archived_at end,
      archived_by = case when v_restore_status = 'draft' then null else batch.archived_by end,
      archived_by_name = case when v_restore_status = 'draft' then null else batch.archived_by_name end,
      archive_reason = case when v_restore_status = 'draft' then null else batch.archive_reason end,
      voided_at = null,voided_by = null,voided_by_name = null,
      void_reason = null,voided_prior_status = null,
      updated_by = v_user,updated_by_name = v_actor_name,updated_at = clock_timestamp()
  where batch.id = p_batch_id;
  insert into public.payroll_audit_log(batch_id,actor_user_id,action,detail)
  values(p_batch_id,v_user,'restore_batch',jsonb_build_object(
    'actor_name',v_actor_name,'restored_status',v_restore_status,
    'previous_void_reason',v_batch.void_reason
  ));
  return jsonb_build_object('batch_id',p_batch_id,'restored',true,'status',v_restore_status);
end;
$$;

create or replace function public.admin_payroll_clone_correction(p_batch_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := auth.uid();
  v_actor_name text;
  v_source public.payroll_batches%rowtype;
  v_new_batch_id bigint;
  v_title text;
  v_notes text;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not public.has_permission('payroll.import_history.edit') then raise exception 'permission_denied'; end if;
  if not payroll_private.admin_payroll_has_full_scope() then raise exception 'payroll_all_scope_required'; end if;
  select * into v_source from public.payroll_batches batch
  where batch.id = p_batch_id for update;
  if not found then raise exception 'batch_not_found'; end if;
  if v_source.status not in ('published','archived') or v_source.voided_at is not null then raise exception 'batch_cannot_be_cloned_for_correction'; end if;

  v_actor_name := payroll_private.admin_payroll_actor_name(v_user);
  v_title := left(v_source.title || '（纠正草稿）',200);
  v_notes := left(concat_ws(E'\n',nullif(v_source.notes,''),
    format('纠正自批次 #%s；原批次保持只读。',v_source.id)),2000);
  insert into public.payroll_batches(
    period_start,title,currency,status,source_type,source_file_name,
    source_project_ref,source_batch_key,notes,row_count,matched_count,
    unmatched_count,created_by,created_by_name,updated_by,updated_by_name,
    correction_of_batch_id
  ) values (
    v_source.period_start,v_title,v_source.currency,'draft','manual',
    v_source.source_file_name,v_source.source_project_ref,null,v_notes,
    v_source.row_count,v_source.matched_count,v_source.unmatched_count,
    v_user,v_actor_name,v_user,v_actor_name,v_source.id
  ) returning id into v_new_batch_id;

  insert into public.payroll_payslips(
    batch_id,period_start,employee_id,employee_no_raw,employee_no_key,full_name,
    platform,position_name,hire_date,card_number,payment_name,payment_method,
    base_salary,attendance_salary,leave_deduction,late_deduction,
    absence_deduction,performance_adjustment,deposit_adjustment,overtime_bonus,
    other_adjustment,total_pay,line_items,remark,source_row,external_record_id,
    raw_payload,source_group,departure_date,increment_adjustment,
    attendance_bonus,extra_adjustment,next_deduction,overpayment_deduction,
    identity_match_state,identity_match_source,published_to_staff,
    publish_exclusion_reason
  )
  select
    v_new_batch_id,payslip.period_start,payslip.employee_id,
    payslip.employee_no_raw,payslip.employee_no_key,payslip.full_name,
    payslip.platform,payslip.position_name,payslip.hire_date,payslip.card_number,
    payslip.payment_name,payslip.payment_method,payslip.base_salary,
    payslip.attendance_salary,payslip.leave_deduction,payslip.late_deduction,
    payslip.absence_deduction,payslip.performance_adjustment,
    payslip.deposit_adjustment,payslip.overtime_bonus,payslip.other_adjustment,
    payslip.total_pay,payslip.line_items,payslip.remark,payslip.source_row,
    payslip.external_record_id,payslip.raw_payload,payslip.source_group,
    payslip.departure_date,payslip.increment_adjustment,payslip.attendance_bonus,
    payslip.extra_adjustment,payslip.next_deduction,
    payslip.overpayment_deduction,payslip.identity_match_state,
    payslip.identity_match_source,false,null
  from public.payroll_payslips payslip
  where payslip.batch_id = v_source.id
  order by payslip.source_row,payslip.id;

  insert into public.payroll_audit_log(batch_id,actor_user_id,action,detail)
  values
    (v_new_batch_id,v_user,'clone_correction',jsonb_build_object(
      'actor_name',v_actor_name,'source_batch_id',v_source.id,
      'rows',v_source.row_count
    )),
    (v_source.id,v_user,'correction_draft_created',jsonb_build_object(
      'actor_name',v_actor_name,'correction_batch_id',v_new_batch_id
    ));
  return jsonb_build_object(
    'batch_id',v_new_batch_id,'source_batch_id',v_source.id,
    'status','draft','rows',v_source.row_count,'title',v_title
  );
end;
$$;

revoke all on function public.admin_payroll_pending_page(bigint),
  public.admin_payroll_published_page(bigint),
  public.admin_payroll_import_history_page(bigint),
  public.admin_payroll_import(jsonb,jsonb),
  public.admin_payroll_publish(bigint),
  public.admin_payroll_update_batch(bigint,text,text),
  public.admin_payroll_delete(bigint),
  public.admin_payroll_void_batch(bigint,text),
  public.admin_payroll_restore_batch(bigint),
  public.admin_payroll_clone_correction(bigint)
  from public,anon,authenticated;
grant execute on function public.admin_payroll_pending_page(bigint),
  public.admin_payroll_published_page(bigint),
  public.admin_payroll_import_history_page(bigint),
  public.admin_payroll_import(jsonb,jsonb),
  public.admin_payroll_publish(bigint),
  public.admin_payroll_update_batch(bigint,text,text),
  public.admin_payroll_delete(bigint),
  public.admin_payroll_void_batch(bigint,text),
  public.admin_payroll_restore_batch(bigint),
  public.admin_payroll_clone_correction(bigint)
  to authenticated,service_role;

comment on function public.admin_payroll_delete(bigint) is
  'Recoverably voids an active draft. It never deletes payroll batch or payslip rows.';
comment on function public.admin_payroll_clone_correction(bigint) is
  'Creates an auditable draft copy of an immutable published or archived payroll batch.';

notify pgrst,'reload schema';
commit;

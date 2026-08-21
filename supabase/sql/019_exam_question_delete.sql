-- Soft-delete exam questions so completed exam history remains auditable.
-- The row is kept as a tombstone for the Google Sheet reconciliation worker.

create or replace function public.admin_exam_delete_question(p_question_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v public.exam_questions;
  v_snapshot jsonb;
begin
  if not public.exam_is_admin('exam.manage') then
    raise exception '没有删除考试题目的权限';
  end if;

  update public.exam_questions
     set active=false,
         revision=revision+1,
         source='backend',
         sync_status='pending_sheet',
         backend_updated_at=now(),
         updated_at=now(),
         updated_by=auth.uid()
   where id=p_question_id and active
   returning * into v;

  if v.id is null then
    raise exception '题目不存在或已经删除';
  end if;

  v_snapshot:=to_jsonb(v)-'created_by'-'updated_by';
  insert into public.exam_question_versions(question_id,revision,snapshot,changed_source,changed_by)
  values(v.id,v.revision,v_snapshot,'backend',auth.uid())
  on conflict do nothing;

  return to_jsonb(v);
end;
$$;

revoke all on function public.admin_exam_delete_question(uuid) from public;
grant execute on function public.admin_exam_delete_question(uuid) to authenticated;


-- The live Sep-Dec workbooks use separate 休假填表 and 奖惩填表 tabs. Keep the
-- already-deployed annual ingest implementation, but validate the new metadata
-- at the public boundary and translate only its legacy internal tab label.

create or replace function public.ingest_annual_attendance_snapshot(
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_source_key text:=btrim(coalesce(p_payload#>>'{source,source_key}',''));
  v_leave_gid text:=btrim(coalesce(p_payload#>>'{source,leave_sheet_gid}',''));
  v_leave_tab text:=btrim(coalesce(p_payload#>>'{source,leave_tab_name}',''));
  v_adjustment_tab text:=btrim(coalesce(p_payload#>>'{source,adjustment_tab_name}',''));
  v_expected_leave_gid text;
  v_legacy_payload jsonb;
begin
  v_expected_leave_gid:=case
    when v_source_key like 'onsite_annual_2026_%' then '868595464'
    when v_source_key like 'home_vimm_annual_2026_%' then '1582220550'
    when v_source_key like 'home_ph_annual_2026_%' then '1880767097'
  end;
  if v_expected_leave_gid is null
    or v_leave_gid<>v_expected_leave_gid
    or v_leave_tab<>'休假填表'
    or v_adjustment_tab<>'奖惩填表' then
    raise exception 'source_not_configured';
  end if;

  -- The private v1 allowlist originally recorded the placeholder name「填表」.
  -- All spreadsheet reads and header checks have already used the actual live
  -- name; this translation is limited to backwards-compatible DB metadata.
  v_legacy_payload:=jsonb_set(
    p_payload,
    '{source,adjustment_tab_name}',
    to_jsonb('填表'::text),
    false
  );
  return attendance_private.ingest_annual_attendance_snapshot(v_legacy_payload);
end;
$$;

revoke all on function public.ingest_annual_attendance_snapshot(jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.ingest_annual_attendance_snapshot(jsonb)
  to service_role;

update public.attendance_sheet_sources s
set metadata=jsonb_set(
      jsonb_set(
        jsonb_set(
          coalesce(s.metadata,'{}'::jsonb),
          '{annual_sync,adjustment_tab}',to_jsonb('奖惩填表'::text),true
        ),
        '{annual_sync,leave_tab}',to_jsonb('休假填表'::text),true
      ),
      '{annual_sync,leave_sheet_gid}',
      to_jsonb(case
        when s.source_key like 'onsite_annual_2026_%' then '868595464'
        when s.source_key like 'home_vimm_annual_2026_%' then '1582220550'
        when s.source_key like 'home_ph_annual_2026_%' then '1880767097'
      end),
      true
    ),
    updated_at=clock_timestamp()
where s.source_key like 'onsite_annual_2026_%'
   or s.source_key like 'home_vimm_annual_2026_%'
   or s.source_key like 'home_ph_annual_2026_%';

comment on function public.ingest_annual_attendance_snapshot(jsonb) is
  'Service-role annual ingest boundary validating the live 休假填表 and 奖惩填表 metadata for Sep-Dec sources.';

notify pgrst,'reload schema';

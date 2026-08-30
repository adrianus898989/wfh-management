begin;

-- Keep the existing bounded, permission-checked diagnostic query as the only
-- reader of persisted synchronization results.  V2 adds a stable presentation
-- contract without re-reading ledgers, Google Sheets, or employee tables.
create or replace function public.admin_sync_diagnostics_v2(
  p_filters jsonb default '{}'::jsonb,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set statement_timeout = '4s'
as $$
declare
  v_result jsonb;
  v_rows jsonb;
begin
  -- admin_sync_diagnostics enforces the current admin session, alert.view,
  -- alert.sync_diagnostics.view, employee scope, page bounds, and its own
  -- three-second statement timeout.
  v_result := public.admin_sync_diagnostics(p_filters,p_page,p_page_size);

  select coalesce(
    jsonb_agg(
      entry.row_value || jsonb_build_object(
        'diagnostic_status',case
          when entry.row_value->>'issue_code'='source_sync_failed' then 'failed'
          when entry.row_value->>'issue_code'='source_sync_partial' then 'partial'
          else 'needs_review'
        end
      )
      order by entry.ordinal
    ),
    '[]'::jsonb
  )
  into v_rows
  from jsonb_array_elements(coalesce(v_result->'rows','[]'::jsonb))
    with ordinality as entry(row_value,ordinal);

  return jsonb_set(v_result,'{rows}',v_rows,true)
    || jsonb_build_object('contract_version',2);
end;
$$;

revoke all on function public.admin_sync_diagnostics_v2(jsonb,integer,integer)
  from public,anon;
grant execute on function public.admin_sync_diagnostics_v2(jsonb,integer,integer)
  to authenticated,service_role;

comment on function public.admin_sync_diagnostics_v2(jsonb,integer,integer) is
  'Adds explicit failed, partial, or needs_review status to the bounded, permission- and scope-checked persisted synchronization diagnostics result. It performs no live sheet or full-table scan.';

commit;

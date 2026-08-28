-- Keep the existing stable three-day error alert semantics, but let the
-- DISTINCT ON view resolve its latest row from a covering index.  This avoids
-- thousands of heap reads during every alert refresh and preserves the 6s
-- circuit breaker used to protect the rest of the application.
create index if not exists report_employee_error_rows_alert_cover_idx
on public.report_employee_error_rows (
  record_key,
  synced_at desc,
  source_row desc
)
include (employee_no, qc_date)
where nullif(employee_no, '') is not null;

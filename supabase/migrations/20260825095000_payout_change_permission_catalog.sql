insert into public.permissions(code, name, category, sensitive)
values
  ('payroll.payout_change.view', '查看收款资料修改申请', 'payroll', true),
  ('payroll.payout_change.review', '审核收款资料修改申请', 'payroll', true)
on conflict(code) do update set
  name = excluded.name,
  category = excluded.category,
  sensitive = excluded.sensitive;

begin;

-- The handbook describes internal workflows, permission boundaries and risk
-- controls. Founder keeps implicit access, while every other backend role must
-- receive this page permission explicitly.
insert into public.permissions(code, name, category, sensitive)
values(
  'account.manual.view',
  '后台账号 · 查看后台功能用途手册',
  'account',
  true
)
on conflict(code) do update
set name = excluded.name,
    category = excluded.category,
    sensitive = excluded.sensitive;

commit;

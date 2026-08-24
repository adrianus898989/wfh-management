-- Fine-grained permissions discovered by the page/action permission audit.
--
-- These sensitive permissions are deliberately not granted to any non-Founder
-- role here. Founder access is implicit in the application; every other role
-- must receive the required permission explicitly in 用户与权限.

insert into public.permissions (code, name, category, sensitive)
values
  ('user.activation.generate', '生成 / 重置员工激活码', 'user', true),
  ('user.account.create', '创建员工前端账号', 'user', true),
  ('account.edit', '编辑后台账号', 'account', true),
  ('employee.delete', '撤销新增员工档案', 'employee', true),
  ('sensitive.employee.edit', '编辑员工敏感资料', 'sensitive', true)
on conflict (code) do update
set name = excluded.name,
    category = excluded.category,
    sensitive = excluded.sensitive;

-- =========================================================
-- 006_admin_username
-- 后台使用“用户名 + 密码”登录
-- 普通员工仍然使用“邮箱 + 密码”
-- =========================================================

alter table public.user_access
  add column if not exists login_username text;

create unique index if not exists user_access_login_username_unique
  on public.user_access (lower(login_username))
  where login_username is not null;

-- 后台用户名格式：3-32位，只允许字母/数字/._-
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_access_login_username_format'
  ) then
    alter table public.user_access
      add constraint user_access_login_username_format
      check (
        login_username is null
        or login_username ~ '^[A-Za-z0-9._-]{3,32}$'
      );
  end if;
end $$;

-- 当前 Founder 先设置一个后台用户名。
-- 以后可以在“用户与权限”页面直接修改，不需要改代码。
update public.user_access
set login_username = 'founder'
where lower(login_email) = lower('adrianus898989@gmail.com')
  and backend_enabled = true;

select
  login_username,
  login_email,
  backend_enabled,
  active,
  data_scope
from public.user_access
where lower(login_email) = lower('adrianus898989@gmail.com');

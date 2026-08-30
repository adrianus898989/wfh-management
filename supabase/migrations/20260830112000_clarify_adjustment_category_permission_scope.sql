begin;

-- These labels are rendered by the role editor.  Keep the permissions
-- sensitive and make it explicit that the same choice controls both the
-- adjustment page and the employee drawer; no role grants are changed here.
update public.permissions
set name=case code
      when 'adjustment.bonus.view' then '查看奖金记录（奖惩表 / 员工档案）'
      when 'adjustment.deduction.view' then '查看扣款记录（奖惩表 / 员工档案）'
    end,
    category='adjustment',
    sensitive=true
where code in ('adjustment.bonus.view','adjustment.deduction.view');

do $adjustment_category_permission_catalog$
begin
  if (
    select count(*)
    from public.permissions
    where code in ('adjustment.bonus.view','adjustment.deduction.view')
      and category='adjustment'
      and sensitive
  )<>2 then
    raise exception 'adjustment_category_permissions_missing';
  end if;
end;
$adjustment_category_permission_catalog$;

commit;

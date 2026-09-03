import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sqlUrl = new URL('../../supabase/sql/047_login_password_lockout.sql', import.meta.url)
const scopeAlignmentSqlUrl = new URL(
  '../../supabase/sql/048_login_password_unlock_scope_alignment.sql',
  import.meta.url,
)
const permissionPrecedenceSqlUrl = new URL(
  '../../supabase/sql/049_login_lockout_exact_permission_precedence.sql',
  import.meta.url,
)
const readSql = () => readFile(sqlUrl, 'utf8')
const readScopeAlignmentSql = () => readFile(scopeAlignmentSqlUrl, 'utf8')
const readPermissionPrecedenceSql = () => readFile(permissionPrecedenceSqlUrl, 'utf8')

const functionBody = (sql, signature, nextSignature) => {
  const start = sql.indexOf(signature)
  const end = nextSignature ? sql.indexOf(nextSignature, start + signature.length) : sql.length
  assert.ok(start >= 0, `${signature} is missing`)
  assert.ok(end > start, `${signature} body boundary is missing`)
  return sql.slice(start, end)
}

test('login password state is private, RLS protected and independent of employment status', async () => {
  const sql = await readSql()

  assert.match(sql, /create schema if not exists security_private/i)
  assert.match(sql, /create table if not exists security_private\.login_lockout_policy/i)
  assert.match(sql, /create table if not exists security_private\.login_lock_states/i)
  assert.match(sql, /alter table security_private\.login_lockout_policy enable row level security/i)
  assert.match(sql, /alter table security_private\.login_lockout_policy force row level security/i)
  assert.match(sql, /alter table security_private\.login_lock_states enable row level security/i)
  assert.match(sql, /alter table security_private\.login_lock_states force row level security/i)
  assert.match(sql, /revoke all on schema security_private from public, anon, authenticated/i)
  assert.match(sql, /revoke all on table security_private\.login_lock_states[\s\S]+from public, anon, authenticated, service_role/i)
  assert.match(sql, /grant select, insert, update, delete on table security_private\.login_lock_states[\s\S]+to service_role/i)
  assert.doesNotMatch(sql, /update\s+public\.user_access[\s\S]{0,180}\bactive\s*=/i)
})

test('lockout policy is configurable from 3 to 99, defaults to 5 and is audited', async () => {
  const sql = await readSql()
  const setter = functionBody(
    sql,
    'create or replace function public.login_password_lockout_policy_set(',
    'create or replace function public.login_password_attempt_status(',
  )

  assert.match(sql, /lock_threshold smallint not null default 5/i)
  assert.match(sql, /check \(lock_threshold between 3 and 99\)/i)
  assert.match(sql, /'backend_account\.lockout_policy_manage',[^\n]+true\)/i)
  assert.match(sql, /create or replace function public\.login_password_lockout_policy_get\(\)/i)
  assert.match(setter, /p_lock_threshold not between 3 and 99/i)
  assert.match(setter, /login_admin_permission_allowed\([\s\S]+backend_account\.lockout_policy_manage/i)
  assert.match(setter, /from security_private\.login_lockout_policy policy[\s\S]+for update/i)
  assert.match(setter, /where state\.locked_at is null/i)
  assert.match(setter, /least\([\s\S]+v_new_threshold - 1/i)
  assert.match(setter, /insert into public\.audit_logs[\s\S]+login_lockout_policy_update/i)
})

test('wrong-password registration serializes per account and locks at the current threshold', async () => {
  const sql = await readSql()
  const failure = functionBody(
    sql,
    'create or replace function public.login_password_failure_register(',
    'create or replace function public.login_password_success_clear(',
  )

  const policyLock = failure.indexOf('for share;')
  const accountLock = failure.indexOf("'login-password-lock:' || p_user_id::text")
  const rowLock = failure.indexOf('for update;', accountLock)
  assert.ok(policyLock > 0 && accountLock > policyLock && rowLock > accountLock)
  assert.match(failure, /least\([\s\S]+v_threshold::integer[\s\S]+v_failed_attempts::integer \+ 1/i)
  assert.match(failure, /if v_new_attempts >= v_threshold then[\s\S]+v_locked_at := v_now/i)
  assert.match(failure, /elsif v_locked_at is null then/i)
  assert.match(failure, /'lock_threshold', v_state_threshold/i)
  assert.match(failure, /'newly_locked', v_newly_locked/i)
  assert.match(failure, /insert into public\.audit_logs[\s\S]+login_account_locked/i)
  assert.doesNotMatch(failure, /interval\s+'[^']+'/i)
})

test('a successful password clears only an unlocked streak and cannot unlock a locked row', async () => {
  const sql = await readSql()
  const success = functionBody(
    sql,
    'create or replace function public.login_password_success_clear(',
    'create or replace function public.login_password_lock_states(',
  )

  const lockedGuard = success.indexOf('if v_locked_at is not null then')
  const deletion = success.indexOf('delete from security_private.login_lock_states')
  assert.ok(lockedGuard > 0 && deletion > lockedGuard)
  assert.match(success, /where state\.user_id = p_user_id[\s\S]+and state\.locked_at is null/i)
  assert.match(success, /'login_locked', true,[\s\S]+'cleared', false/i)
})

test('batch state output is bounded and shaped for account-list decoration', async () => {
  const sql = await readSql()
  const batch = functionBody(
    sql,
    'create or replace function public.login_password_lock_states(',
    'create or replace function public.login_password_lock_clear(',
  )

  assert.match(batch, /cardinality\(p_user_ids\) > 200/i)
  assert.match(batch, /unnest\(p_user_ids\) with ordinality/i)
  assert.match(batch, /'auth_user_id', requested\.user_id/i)
  assert.match(batch, /'login_locked', state\.locked_at is not null/i)
  assert.match(batch, /'failed_attempts', coalesce\(state\.failed_attempts, 0\)/i)
  assert.match(batch, /'lock_threshold'/i)
  assert.match(batch, /'locked_at', state\.locked_at/i)
  assert.match(batch, /'last_failure_portal', state\.last_failure_portal/i)
})

test('manual unlock rechecks permission and scope, then clears and audits atomically', async () => {
  const sql = await readSql()
  const unlock = functionBody(
    sql,
    'create or replace function public.login_password_lock_clear(',
    'create or replace function session_private.app_session_claim(',
  )

  assert.match(unlock, /actor\.active = true[\s\S]+actor\.backend_enabled = true/i)
  assert.match(unlock, /v_required_permission := 'backend_account\.unlock'/i)
  assert.match(unlock, /v_required_permission := 'staff_account\.unlock'/i)
  assert.match(unlock, /public\.admin_recovery_backend_action_allowed\([\s\S]+backend_account\.unlock/i)
  assert.match(unlock, /public\.user_scope_employees scoped_employee/i)
  assert.match(unlock, /message = 'permission_or_scope_denied'/i)
  assert.match(unlock, /v_actor_role_code = 'founder'/i)

  const deletion = unlock.indexOf('delete from security_private.login_lock_states')
  const audit = unlock.indexOf('insert into public.audit_logs', deletion)
  assert.ok(deletion > 0 && audit > deletion)
  assert.match(unlock, /login_account_unlock/i)
  assert.match(unlock, /'auth_user_id', p_target_user_id/i)
  assert.match(unlock, /'login_locked', false/i)
})

test('all lockout RPCs are service-only and the session claim blocks only a new lease', async () => {
  const sql = await readSql()
  const signatures = [
    'login_password_lockout_policy_get\\(\\)',
    'login_password_lockout_policy_set\\(uuid, integer, text\\)',
    'login_password_attempt_status\\(uuid\\)',
    'login_password_failure_register\\(uuid, text\\)',
    'login_password_success_clear\\(uuid\\)',
    'login_password_lock_states\\(uuid\\[\\]\\)',
    'login_password_lock_clear\\(uuid, uuid, text\\)',
  ]
  for (const signature of signatures) {
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${signature}[\\s\\S]+?from public, anon, authenticated, service_role`, 'i'),
    )
    assert.match(
      sql,
      new RegExp(`grant execute on function public\\.${signature}[\\s\\S]+?to service_role`, 'i'),
    )
  }

  const claim = functionBody(
    sql,
    'create or replace function session_private.app_session_claim(',
    'revoke all on function security_private.login_admin_permission_allowed(',
  )
  const lockedLookup = claim.indexOf('security_private.login_lock_states')
  const existingLease = claim.indexOf('public.app_session_leases', lockedLookup)
  const innerClaim = claim.indexOf('app_session_claim_release_inner_v1', existingLease)
  assert.ok(lockedLookup > 0 && existingLease > lockedLookup && innerClaim > existingLease)
  assert.match(claim, /lease\.session_id = v_session_id/i)
  assert.match(claim, /lease\.lease_expires_at > clock_timestamp\(\)/i)
  assert.match(claim, /'reason', 'account_locked'/i)
})

test('forward unlock alignment preserves durable limited scopes and Founder target protection', async () => {
  const sql = await readScopeAlignmentSql()
  const helper = functionBody(
    sql,
    'create or replace function security_private.login_backend_unlock_allowed(',
    'revoke all on function security_private.login_backend_unlock_allowed(',
  )
  const unlock = functionBody(
    sql,
    'create or replace function public.login_password_lock_clear(',
    'revoke all on function public.login_password_lock_clear(',
  )

  assert.match(helper, /security definer[\s\S]+set search_path = ''/i)
  assert.match(helper, /if v_target_role_code = 'founder' then[\s\S]+p_actor_user_id = p_target_user_id/i)
  assert.match(helper, /if v_actor_role_code = 'founder' then return true/i)
  assert.match(helper, /login_admin_permission_allowed\([\s\S]+backend_account\.unlock/i)
  assert.match(helper, /v_target_scope = 'self'[\s\S]+user_scope_employee_filters actor_employee_filter/i)
  assert.match(helper, /v_target_scope = 'assigned_teams'[\s\S]+v_actor_scope is distinct from 'assigned_teams'/i)
  assert.match(helper, /user_scope_team_filters target_team[\s\S]+user_scope_team_filters actor_team/i)
  assert.match(helper, /user_scope_position_filters target_position[\s\S]+user_scope_position_filters actor_position/i)
  assert.match(helper, /user_scope_employee_filters target_employee[\s\S]+user_scope_employee_filters actor_employee/i)
  assert.match(helper, /v_target_active is true and exists[\s\S]+user_scope_employees target_scope/i)
  assert.equal((helper.match(/scope_private\.current_employee_scope_directory\(\)/g) || []).length, 1)
  assert.match(unlock, /security_private\.login_backend_unlock_allowed\(/i)
  assert.doesNotMatch(unlock, /admin_recovery_backend_action_allowed/i)
  assert.match(sql, /revoke all on function security_private\.login_backend_unlock_allowed\([\s\S]+to service_role/i)
  assert.match(sql, /revoke all on function public\.login_password_lock_clear\([\s\S]+to service_role/i)
})

test('exact grants remain effective when wildcard permission is denied', async () => {
  const sql = await readPermissionPrecedenceSql()
  const helper = functionBody(
    sql,
    'create or replace function security_private.login_admin_permission_allowed(',
    'revoke all on function security_private.login_admin_permission_allowed(',
  )
  const exactOverride = helper.indexOf('permission.code = p_permission_code')
  const exactRole = helper.indexOf('permission.code = p_permission_code', exactOverride + 1)
  const wildcardOverride = helper.indexOf("permission.code = '*'", exactRole + 1)
  const wildcardRole = helper.indexOf("permission.code = '*'", wildcardOverride + 1)

  assert.ok(exactOverride > 0)
  assert.ok(exactRole > exactOverride)
  assert.ok(wildcardOverride > exactRole)
  assert.ok(wildcardRole > wildcardOverride)
  assert.match(helper, /if v_role_code = 'founder' then return true/i)
  assert.match(sql, /revoke all on function security_private\.login_admin_permission_allowed\([\s\S]+to service_role/i)
})

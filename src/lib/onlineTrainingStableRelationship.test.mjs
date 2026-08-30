import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl=new URL('../../supabase/migrations/20260830151000_online_training_stable_roster_relationship.sql',import.meta.url)
const sqlTestUrl=new URL('../../supabase/tests/online_training_stable_roster_relationship.sql',import.meta.url)

test('online training hierarchy persists only stable employee UUID edges',async()=>{
  const sql=await readFile(migrationUrl,'utf8')

  assert.match(sql,/create table if not exists session_private\.online_training_roster_relationships/)
  assert.match(sql,/learner_employee_id uuid primary key[\s\S]*?references public\.employees\(id\)/)
  assert.match(sql,/responsible_employee_id uuid[\s\S]*?references public\.employees\(id\)/)
  assert.match(sql,/onsite_trainer_employee_id uuid[\s\S]*?references public\.employees\(id\)/)
  assert.match(sql,/online_trainer_employee_id uuid[\s\S]*?references public\.employees\(id\)/)
  assert.match(sql,/online_leader_employee_id uuid[\s\S]*?references public\.employees\(id\)/)
  assert.match(sql,/directory\.source_kind = 'roster'/)
  assert.match(sql,/having count\(distinct person\.employee_id\) = 1/)
  assert.doesNotMatch(sql,/online_training_snapshot_employee_id\([\s\S]*?online_training_roster_relationships/)
})

test('strict C and D resolver preserves punctuation and ambiguous names fail closed',async()=>{
  const sql=await readFile(migrationUrl,'utf8')
  const resolver=sql.slice(
    sql.indexOf('create or replace function session_private.online_training_roster_name_key'),
    sql.indexOf('create table if not exists session_private.online_training_roster_relationships')
  )

  assert.match(resolver,/normalize\(coalesce\(p_value, ''\), NFKC\)/)
  assert.match(resolver,/\[\[:space:\]\]\+/)
  assert.doesNotMatch(resolver,/\[\^a-z0-9\]|\[\^[:alnum:]/i)
  assert.match(sql,/unresolved_trainer_rows/)
  assert.match(sql,/unresolved_leader_rows/)
  assert.match(sql,/unresolved_responsible_rows/)
})

test('training-only authorization lets self-scoped roster actors reach only stable assignments',async()=>{
  const sql=await readFile(migrationUrl,'utf8')
  const scope=sql.slice(
    sql.indexOf('create or replace function public.online_training_employee_in_scope'),
    sql.indexOf('create or replace function public.online_training_employee_history_in_scope')
  )
  const assignedMember=sql.slice(
    sql.indexOf('create or replace function public.online_training_is_assigned_member'),
    sql.indexOf('comment on function public.online_training_is_assigned_member')
  )
  const assignmentTargets=sql.slice(
    sql.indexOf('create or replace function session_private.online_training_assignment_targets'),
    sql.indexOf('revoke all on function\n  session_private.online_training_assignment_targets')
  )
  const learnerAssignments=assignmentTargets.slice(
    assignmentTargets.indexOf('select relation.learner_employee_id target_employee_id'),
    assignmentTargets.indexOf('union all')
  )

  assert.match(scope,/session_private\.current_app_session_is_valid\('admin'\)/)
  assert.match(scope,/public\.online_training_can_view_module\(\)/)
  assert.doesNotMatch(scope,/not public\.backend_employee_in_scope\(p_employee_id\)/)
  assert.match(scope,/v_role_code = 'founder' or v_data_scope = 'all'/)
  assert.match(scope,/return public\.backend_employee_in_scope\(p_employee_id\)/)
  assert.match(scope,/session_private\.online_training_relationship_allows/)
  assert.doesNotMatch(sql,/create or replace function public\.backend_employee_in_scope/)
  assert.match(assignedMember,/session_private\.online_training_assignment_targets/)
  assert.doesNotMatch(assignedMember,/backend_employee_in_scope/)
  assert.match(sql,/relation\.learner_employee_id = p_target_employee_id[\s\S]*?relation\.online_leader_employee_id = p_caller_employee_id[\s\S]*?relation\.online_trainer_employee_id is not null/)
  assert.match(sql,/relation\.online_trainer_employee_id = p_target_employee_id[\s\S]*?relation\.online_leader_employee_id = p_caller_employee_id/)
  assert.doesNotMatch(scope,/relation\.online_leader_employee_id = p_caller_employee_id/)
  assert.match(assignmentTargets,/relation\.onsite_trainer_employee_id = p_actor_employee_id[\s\S]*?relation\.online_trainer_employee_id = p_actor_employee_id[\s\S]*?select relation\.online_trainer_employee_id target_employee_id[\s\S]*?relation\.online_leader_employee_id = p_actor_employee_id/)
  assert.doesNotMatch(learnerAssignments,/online_leader_employee_id/)
  assert.match(sql,/allow_all_stable_training_report_subjects[\s\S]*?online_training_assignment_targets\([\s\S]*?v_author_employee_id/)
  assert.match(sql,/create function public\.online_training_save_report\([\s\S]*?online_training_employee_in_scope\(v_employee_id\)[\s\S]*?online_training_assignment_targets\([\s\S]*?v_caller_employee_id/)
  assert.match(sql,/v_role_code <> 'founder'[\s\S]*?v_data_scope is distinct from 'all'[\s\S]*?online_training_assignment_targets/)
  assert.match(sql,/'reporter_role', coalesce\(v_actor_role, ''\)/)
  assert.match(sql,/not public\.online_training_employee_in_scope\(member\.employee_id\)/)
})

test('relationship refresh is atomic with directory sync and private objects are not browser callable',async()=>{
  const sql=await readFile(migrationUrl,'utf8')

  assert.match(sql,/sync_report_employee_directory_stable_relationship_inner_v1\(p_rows\)/)
  assert.match(sql,/rebuild_online_training_roster_relationships\(p_rows\)/)
  assert.match(sql,/revoke all on table session_private\.online_training_roster_relationships[\s\S]*?from public, anon, authenticated, service_role/)
  assert.match(sql,/revoke all on function[\s\S]*?rebuild_online_training_roster_relationships\(jsonb\)[\s\S]*?from public, anon, authenticated, service_role/)
  assert.match(sql,/grant execute on function public\.sync_report_employee_directory\(jsonb\)[\s\S]*?to service_role/)
  assert.match(sql,/schedule_roster_relationship_snapshot_empty/)
  assert.match(sql,/schedule_roster_relationship_health_guard/)
  assert.doesNotMatch(sql,/rebuild_online_training_roster_relationships\(\s*coalesce\([\s\S]*?'\[\]'::jsonb/)
})

test('trainer identity resolves exact roster label through H before authoritative hire-date lookup',async()=>{
  const sql=await readFile(migrationUrl,'utf8')
  const resolver=sql.slice(
    sql.indexOf('create function public.online_training_resolve_trainer_identities'),
    sql.indexOf('-- Preserve the context response contract')
  )

  assert.match(resolver,/report_employee_directory_cache/)
  assert.match(resolver,/directory\.source_kind = 'roster'/)
  assert.match(resolver,/online_training_roster_name_key\(directory\.full_name\)/)
  assert.match(resolver,/employee_master_normalize_id\(directory\.employee_no\)/)
  assert.match(resolver,/employee\.status in \('active', 'probation'\)/)
  assert.match(resolver,/employee\.hire_date/)
  assert.match(resolver,/employee_lifecycle_events/)
  assert.match(resolver,/online_training_employee_in_scope\(roster\.employee_id\)/)
  assert.doesNotMatch(resolver,/member\.(?:employee_no|employee_name)/)
  assert.match(sql,/online_training_roster_actor_label\(text,text\)/)
  assert.match(sql,/online_training_report_actor_key_definition_changed/)
  assert.match(sql,/report\.trainer_name, report\.author_employee_no/)
})

test('required hierarchy and lifecycle regressions are covered by disposable SQL test',async()=>{
  const sql=await readFile(sqlTestUrl,'utf8')

  assert.match(sql,/trainer did not receive its direct learner/)
  assert.match(sql,/trainer received sibling trainer learner/)
  assert.match(sql,/leader did not receive its subordinate online trainers/)
  assert.match(sql,/leader did not receive learners below its resolved trainers/)
  assert.match(sql,/leader received a C-only learner without a resolved D trainer/)
  assert.match(sql,/onsite trainer did not receive its direct employee/)
  assert.match(sql,/responsible column unexpectedly became a report permission edge/)
  assert.match(sql,/leader report subjects were not limited to its D trainers/)
  assert.match(sql,/onsite trainer report subject did not follow B to G/)
  assert.match(sql,/new roster learner did not inherit stable hierarchy/)
  assert.match(sql,/rename\/transfer changed stable trainer UUID relationship/)
  assert.match(sql,/duplicate trainer name did not fail closed/)
  assert.match(sql,/removed online trainer retained stale learner access/)
  assert.match(sql,/empty replacement erased the last healthy hierarchy/)
  assert.match(sql,/formula-loading replacement erased the last healthy hierarchy/)
  assert.match(sql,/self-scoped training actor is still blocked before roster relationship evaluation/)
  assert.match(sql,/training assignment helper still intersects generic backend scope/)
  assert.match(sql,/report mutation boundary lost stable subject enforcement/)
  assert.match(sql,/retained report writer still rejects valid B or C subjects/)
  assert.match(sql,/authenticated role can read private relationship table/)
})

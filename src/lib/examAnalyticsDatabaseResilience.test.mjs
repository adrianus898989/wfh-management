import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const migration=await readFile(new URL(
  '../../supabase/migrations/20260831054500_exam_analytics_and_sync_failure_isolation.sql',
  import.meta.url,
),'utf8')

test('exam analytics reads grade status from covering indexes',()=>{
  assert.match(migration,/legacy_exam_answers_overview_stats_idx[\s\S]*?legacy_session_id[\s\S]*?include \(grade_status\)/i)
  assert.match(migration,/exam_answers_overview_stats_idx[\s\S]*?session_id[\s\S]*?include \(grade_status\)/i)
  assert.match(migration,/analyze public\.legacy_exam_answers/i)
})

test('relationship snapshot rejection retains the last healthy cache without swallowing unrelated errors',()=>{
  assert.match(migration,/begin[\s\S]*?rebuild_online_training_roster_relationships\(p_rows\)[\s\S]*?exception[\s\S]*?when sqlstate '22023'/i)
  assert.match(migration,/not like 'schedule_roster_relationship_%'[\s\S]*?raise;/i)
  assert.match(migration,/'status', 'retained_previous'/i)
  assert.match(migration,/sync_report_employee_directory_stable_relationship_inner_v1\(p_rows\)[\s\S]*?begin[\s\S]*?rebuild_online_training_roster_relationships/i)
})

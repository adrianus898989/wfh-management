# Kaoshi reference architecture (read-only review)

Reviewed on 2026-08-21 from Supabase project `vlabmqvbfhdkjsxhajkp` in
`xiaozhang66558's Org`. This is a structural reference only. Do not migrate
legacy employees, accounts, submissions, sessions, or scores.

## Reference data model

- `profiles`: Auth-linked student/admin profile (`auth.users.id`).
- `questions_cache`: active question bank with `series` (team/盘口), `position`,
  English/Chinese/Vietnamese text, score, difficulty, and up to three images.
- `exam_sessions`: one attempt, selected question IDs/snapshot, time limit,
  status, total score, team/position, grader and timestamps.
- `submissions`: one response per session/question, free-text answer, answer
  images, manual score, feedback, feedback images, grader and timestamps.
- Views expose distinct teams/positions and sessions joined to profiles.
- Public image bucket: `exam-images`.

## Reference workflow

1. `create_exam_session` prevents a second in-progress attempt, randomly selects
   active questions, and creates a timed session.
2. The employee saves one submission per question. The unique key is
   `(session_id, question_id)`.
3. `submit_exam` permits the signed-in employee to submit only their own
   in-progress session.
4. `grade_submission` scores one response, stores grader/time, and recalculates
   the session total. Grading is manual rather than answer-key auto-grading.
5. Employees can read their own attempts; admins can inspect all attempts.

## Design to implement in WFH Management

- Reuse the existing employee archive and employee account. Link exam records by
  the existing employee ID/account UUID; do not create a second employee table.
- Treat `盘口` as `团队`; assign exams by both team and position.
- Snapshot question text, score and images when an attempt starts so later edits
  do not change historical attempts.
- Show attempt count, scores and history inside the existing employee drawer,
  governed by exam/history permissions and without exposing sensitive profile
  fields to ordinary staff.
- Employee frontend needs pending exams, clear duration/progress, multilingual
  questions, image zoom, autosaved answers, submit confirmation, and permitted
  result/history views.
- Admin workflow needs question bank, exam assignment, submitted-attempt queue,
  per-question scoring/feedback, total calculation and score statistics.
- Google Sheet and database two-way add/edit/delete require an explicit sync
  worker and reconciliation log. The reference project has no Edge Function for
  this and is not itself a complete two-way sync implementation.

## Security issues not to copy

- `questions_cache_backup` has RLS disabled.
- Several tables/functions grant access to `anon`; notably the security-definer
  grading function is executable by `anon` and does not enforce admin status
  inside the function.
- Profile and active-question policies are overly broad and duplicated.
- The public image bucket has duplicate policies, no file-size limit and no MIME
  allow-list.
- The reference project has no Edge Functions and only one relevant trigger:
  `auth.users` inserts a row into `profiles`.

The WFH implementation must use strict authenticated/admin checks, scoped RLS,
private or signed image access where appropriate, bounded uploads, and existing
role/permission definitions.

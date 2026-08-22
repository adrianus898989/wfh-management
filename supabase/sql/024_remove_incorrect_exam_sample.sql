-- Remove the known incorrect AR India / payout sample previously assigned to CJ00007.
-- It was only test data and must not appear in the employee's history or statistics.

delete from public.exam_sessions
where assignment_id='beb3b112-379b-4e0c-bd92-2bf43279c06c'::uuid;

delete from public.exam_assignments
where id='beb3b112-379b-4e0c-bd92-2bf43279c06c'::uuid
  and title='考试模块测试样本（CJ00007）';

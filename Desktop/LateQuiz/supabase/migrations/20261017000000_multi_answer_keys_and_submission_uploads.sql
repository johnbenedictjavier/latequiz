-- Multiple identification answer keys and real submission image uploads.
--
-- Deploy together: this migration drops LQ_question_keys.answer_key, so the
-- old submit-attempt / finalize-expired-attempts edge functions and the old
-- frontend (which select answer_key) fail until they are redeployed.
--
-- Untouched on purpose:
--   * LQ_question_keys RLS (lq_question_keys_admin_write)
--   * lq_submission_student_read, lq_submission_admin_delete
--   * LQ_delete_attempt and every lq-avatars policy
--   * LQ_answers rows: no statement here reads, updates, or deletes
--     LQ_answers.file_path, so legacy bare file names stay byte-for-byte.

-- ---------------------------------------------------------------------------
-- 1. Answer keys become a text[]
-- ---------------------------------------------------------------------------
alter table public."LQ_question_keys" add column if not exists answer_keys text[];

-- Backfill each legacy single key as a one-element array. No trimming or
-- rewriting: the stored value is copied exactly. Guarded so a re-run after
-- the column has been dropped is a no-op.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'LQ_question_keys'
      and column_name = 'answer_key'
  ) then
    execute $sql$
      update public."LQ_question_keys"
         set answer_keys = array[answer_key]
       where answer_key is not null
         and answer_keys is null
    $sql$;
  end if;
end;
$$;

alter table public."LQ_question_keys" drop column if exists answer_key;

-- Structural check only (non-empty, no null elements). Blank-element and
-- normalized-duplicate rules live in the shared validator used by the
-- builder and saveQuiz. NOT VALID: new writes are checked, existing rows are
-- not rescanned or rewritten.
alter table public."LQ_question_keys"
  drop constraint if exists lq_question_keys_answer_keys_check;
alter table public."LQ_question_keys"
  add constraint lq_question_keys_answer_keys_check
  check (
    answer_keys is null
    or (
      cardinality(answer_keys) >= 1
      and array_position(answer_keys, null) is null
    )
  )
  not valid;

-- ---------------------------------------------------------------------------
-- 2. Bucket limits for lq-submissions (bucket stays private)
-- ---------------------------------------------------------------------------
update storage.buckets
   set file_size_limit = 10485760,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id = 'lq-submissions';

-- ---------------------------------------------------------------------------
-- 3. Tighter student insert policy
--    {own school_id}/{own in_progress attempt_id}/... only, and never for a
--    quiz the student is a reporter on. The attempt id is compared as text so
--    a non-uuid folder segment fails the check instead of raising a cast error.
-- ---------------------------------------------------------------------------
drop policy if exists lq_submission_student_upload on storage.objects;
create policy lq_submission_student_upload on storage.objects
for insert to authenticated
with check (
  bucket_id = 'lq-submissions'
  and public."LQ_workspace_ready"()
  and (storage.foldername(storage.objects.name))[1] = public."LQ_my_school_id"()
  and exists (
    select 1
    from public."LQ_attempts" attempt
    where attempt.id::text = (storage.foldername(storage.objects.name))[2]
      and attempt.auth_user_id = auth.uid()
      and attempt.school_id = public."LQ_my_school_id"()
      and attempt.status = 'in_progress'
      and not public."LQ_is_quiz_reporter"(attempt.quiz_id)
  )
);

-- ---------------------------------------------------------------------------
-- 4. Narrow student delete for superseded objects
--    Own school folder, own in_progress attempt, and the object is not the
--    saved file_path of any answer. Submitted/expired/reviewed attempts are
--    immutable for students. storage.objects.name is qualified everywhere to
--    avoid resolving against columns of the subquery tables.
--    No recursion: LQ_attempts / LQ_answers policies never read storage.objects.
-- ---------------------------------------------------------------------------
drop policy if exists lq_submission_student_delete_superseded on storage.objects;
create policy lq_submission_student_delete_superseded on storage.objects
for delete to authenticated
using (
  bucket_id = 'lq-submissions'
  and public."LQ_workspace_ready"()
  and (storage.foldername(storage.objects.name))[1] = public."LQ_my_school_id"()
  and exists (
    select 1
    from public."LQ_attempts" attempt
    where attempt.id::text = (storage.foldername(storage.objects.name))[2]
      and attempt.auth_user_id = auth.uid()
      and attempt.school_id = public."LQ_my_school_id"()
      and attempt.status = 'in_progress'
  )
  and not exists (
    select 1
    from public."LQ_answers" answer
    where answer.file_path = storage.objects.name
  )
);

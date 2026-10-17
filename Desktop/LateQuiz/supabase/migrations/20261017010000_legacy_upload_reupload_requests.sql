-- Admin-requested re-upload of legacy submission images.
--
-- Runs after 20261017000000_multi_answer_keys_and_submission_uploads.sql.
-- Additive only: new table, new functions, two new permissive storage
-- policies, and one tightening of lq_submission_student_delete_superseded
-- (see section 6).
--
-- Untouched on purpose:
--   * lq_answers_student_update, lq_attempts_student_update
--   * LQ_protect_student_attempt, LQ_protect_student_answer
--     LQ_protect_student_answer only rejects changes to is_correct,
--     points_awarded, feedback, reviewed_by, reviewed_at. LQ_fulfill_reupload
--     changes only file_path (plus updated_at via LQ_set_updated_at), so the
--     trigger passes unchanged and remains a second guard against grading
--     writes. No session setting or bypass is introduced.
--   * LQ_delete_attempt: attempt delete cascades to LQ_answers and to
--     LQ_reupload_requests through the FKs below.
--   * lq_submission_student_upload, lq_submission_student_read,
--     lq_submission_admin_delete, every lq-avatars policy
--   * lq_notifications_recipient_read (notifications stay admin-only)
--   * student quiz/question read policies (LQ_my_reupload_requests reads as
--     definer instead of widening them)
--
-- LQ_notifications.type and LQ_audit_logs.event_type have no check
-- constraints, so the new 'reupload_*' values need no constraint change.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
create table if not exists public."LQ_reupload_requests" (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public."LQ_attempts"(id) on delete cascade,
  question_id uuid not null references public."LQ_questions"(id) on delete cascade,
  answer_id uuid not null references public."LQ_answers"(id) on delete cascade,
  original_file_name text not null,
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  deadline timestamptz,
  status text not null default 'open' check (status in ('open', 'fulfilled', 'cancelled')),
  fulfilled_at timestamptz,
  fulfilled_path text,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancel_reason text check (cancel_reason in ('admin', 'expired')),
  constraint lq_reupload_state_check check (
    (status = 'open' and fulfilled_at is null and fulfilled_path is null and cancelled_at is null)
    or (status = 'fulfilled' and fulfilled_at is not null and fulfilled_path is not null and cancelled_at is null)
    or (status = 'cancelled' and cancelled_at is not null and cancel_reason is not null and fulfilled_path is null)
  )
);

create unique index if not exists lq_reupload_one_open_per_answer
  on public."LQ_reupload_requests" (answer_id) where status = 'open';
create index if not exists lq_reupload_attempt_idx
  on public."LQ_reupload_requests" (attempt_id, status);

-- ---------------------------------------------------------------------------
-- 2. RLS: admin full access, students read their own attempts' requests.
--    No student insert/update/delete policy, so those are denied.
-- ---------------------------------------------------------------------------
alter table public."LQ_reupload_requests" enable row level security;

drop policy if exists lq_reupload_admin_all on public."LQ_reupload_requests";
create policy lq_reupload_admin_all on public."LQ_reupload_requests"
for all to authenticated
using (public."LQ_is_admin"())
with check (public."LQ_is_admin"());

drop policy if exists lq_reupload_student_read on public."LQ_reupload_requests";
create policy lq_reupload_student_read on public."LQ_reupload_requests"
for select to authenticated
using (
  public."LQ_workspace_ready"()
  and exists (
    select 1
    from public."LQ_attempts" attempt
    where attempt.id = "LQ_reupload_requests".attempt_id
      and attempt.auth_user_id = auth.uid()
      and attempt.school_id = public."LQ_my_school_id"()
  )
);

-- ---------------------------------------------------------------------------
-- 3. LQ_request_reupload (admin)
-- ---------------------------------------------------------------------------
create or replace function public."LQ_request_reupload"(
  p_answer_id uuid,
  p_deadline timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_answer public."LQ_answers";
  v_attempt public."LQ_attempts";
  v_question public."LQ_questions";
  v_existing public."LQ_reupload_requests";
  v_request public."LQ_reupload_requests";
begin
  if not public."LQ_is_admin"() then
    raise exception 'Only administrators can request re-uploads';
  end if;

  -- Lock the answer first so concurrent requests for it serialize here.
  select * into v_answer
  from public."LQ_answers"
  where id = p_answer_id
  for update;

  if v_answer.id is null then
    raise exception 'Answer not found';
  end if;

  select * into v_attempt
  from public."LQ_attempts"
  where id = v_answer.attempt_id
  for update;

  select * into v_question
  from public."LQ_questions"
  where id = v_answer.question_id
  for update;

  if v_attempt.id is null or v_question.id is null then
    raise exception 'Answer not found';
  end if;

  if v_question.question_type <> 'upload' then
    raise exception 'Re-upload requests are only available for upload questions';
  end if;

  if v_attempt.status not in ('submitted', 'expired', 'reviewed') then
    raise exception 'Re-upload requests are only available for submitted, expired, or reviewed attempts';
  end if;

  if v_answer.file_path is null or btrim(v_answer.file_path) = '' then
    raise exception 'This answer has no file name to recover';
  end if;

  if strpos(v_answer.file_path, '/') > 0 then
    raise exception 'This answer already has a stored image';
  end if;

  if p_deadline is not null and p_deadline <= now() then
    raise exception 'The re-upload deadline must be in the future';
  end if;

  select * into v_existing
  from public."LQ_reupload_requests"
  where answer_id = v_answer.id
    and status = 'open'
  for update;

  if v_existing.id is not null then
    if v_existing.deadline is null or v_existing.deadline > now() then
      raise exception 'A re-upload request is already open for this answer';
    end if;

    -- Lapsed open request: close it so a new one can be opened.
    update public."LQ_reupload_requests"
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = v_actor,
        cancel_reason = 'expired'
    where id = v_existing.id;
  end if;

  begin
    insert into public."LQ_reupload_requests" (
      attempt_id, question_id, answer_id, original_file_name, requested_by, deadline
    )
    values (
      v_attempt.id, v_question.id, v_answer.id, v_answer.file_path, v_actor, p_deadline
    )
    returning * into v_request;
  exception when unique_violation then
    -- Backstop for races on lq_reupload_one_open_per_answer.
    raise exception 'A re-upload request is already open for this answer';
  end;

  insert into public."LQ_audit_logs" (actor_id, event_type, entity_type, entity_id, metadata)
  values (
    v_actor,
    'reupload_requested',
    'attempt',
    v_attempt.id,
    jsonb_build_object(
      'request_id', v_request.id,
      'answer_id', v_answer.id,
      'question_id', v_question.id,
      'school_id', v_attempt.school_id,
      'deadline', p_deadline
    )
  );

  return to_jsonb(v_request);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. LQ_cancel_reupload (admin). Open-but-lapsed requests may be cancelled.
-- ---------------------------------------------------------------------------
create or replace function public."LQ_cancel_reupload"(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_request public."LQ_reupload_requests";
  v_school_id text;
begin
  if not public."LQ_is_admin"() then
    raise exception 'Only administrators can cancel re-upload requests';
  end if;

  select * into v_request
  from public."LQ_reupload_requests"
  where id = p_request_id
  for update;

  if v_request.id is null then
    raise exception 'Re-upload request not found';
  end if;

  if v_request.status <> 'open' then
    raise exception 'Only open re-upload requests can be cancelled';
  end if;

  update public."LQ_reupload_requests"
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = v_actor,
      cancel_reason = 'admin'
  where id = v_request.id
  returning * into v_request;

  select school_id into v_school_id
  from public."LQ_attempts"
  where id = v_request.attempt_id;

  insert into public."LQ_audit_logs" (actor_id, event_type, entity_type, entity_id, metadata)
  values (
    v_actor,
    'reupload_cancelled',
    'attempt',
    v_request.attempt_id,
    jsonb_build_object(
      'request_id', v_request.id,
      'answer_id', v_request.answer_id,
      'question_id', v_request.question_id,
      'school_id', v_school_id,
      'deadline', v_request.deadline
    )
  );

  return to_jsonb(v_request);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Storage helpers and policies
-- ---------------------------------------------------------------------------

-- True when any LQ_answers row references the object, regardless of the
-- caller's RLS on LQ_answers. Shared by the discard helper and the tightened
-- superseded-delete policy (section 6).
create or replace function public."LQ_submission_object_referenced"(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public."LQ_answers" answer where answer.file_path = p_name
  );
$$;

-- True only for {own school}/{own attempt}/{question_id}_{request_id}_<rest>
-- where the attempt is closed and the request is open and unexpired.
create or replace function public."LQ_can_upload_reupload_object"(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public."LQ_workspace_ready"()
    and coalesce(cardinality(storage.foldername(p_name)), 0) = 2
    and exists (
      select 1
      from public."LQ_reupload_requests" request
      join public."LQ_attempts" attempt on attempt.id = request.attempt_id
      where attempt.auth_user_id = auth.uid()
        and attempt.school_id = public."LQ_my_school_id"()
        and attempt.status in ('submitted', 'expired', 'reviewed')
        and request.status = 'open'
        and (request.deadline is null or request.deadline > now())
        and (storage.foldername(p_name))[1] = attempt.school_id
        and (storage.foldername(p_name))[2] = attempt.id::text
        and starts_with(
          storage.filename(p_name),
          request.question_id::text || '_' || request.id::text || '_'
        )
    );
$$;

-- Cleanup of a failed fulfillment: same ownership/school/folder/prefix match,
-- the request is not fulfilled, and no answer references the object.
-- Open/unexpired is deliberately not required, so an object left behind when
-- the deadline lapses (or the admin cancels) between upload and fulfillment
-- can still be removed by its owner.
create or replace function public."LQ_can_discard_reupload_object"(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public."LQ_workspace_ready"()
    and coalesce(cardinality(storage.foldername(p_name)), 0) = 2
    and exists (
      select 1
      from public."LQ_reupload_requests" request
      join public."LQ_attempts" attempt on attempt.id = request.attempt_id
      where attempt.auth_user_id = auth.uid()
        and attempt.school_id = public."LQ_my_school_id"()
        and attempt.status in ('submitted', 'expired', 'reviewed')
        and request.status <> 'fulfilled'
        and (storage.foldername(p_name))[1] = attempt.school_id
        and (storage.foldername(p_name))[2] = attempt.id::text
        and starts_with(
          storage.filename(p_name),
          request.question_id::text || '_' || request.id::text || '_'
        )
    )
    and not public."LQ_submission_object_referenced"(p_name);
$$;

-- Additional permissive policies. Bucket size/MIME limits still apply.
drop policy if exists lq_submission_student_reupload on storage.objects;
create policy lq_submission_student_reupload on storage.objects
for insert to authenticated
with check (
  bucket_id = 'lq-submissions'
  and public."LQ_can_upload_reupload_object"(storage.objects.name)
);

drop policy if exists lq_submission_student_discard_reupload on storage.objects;
create policy lq_submission_student_discard_reupload on storage.objects
for delete to authenticated
using (
  bucket_id = 'lq-submissions'
  and public."LQ_can_discard_reupload_object"(storage.objects.name)
);

-- ---------------------------------------------------------------------------
-- 6. Tighten lq_submission_student_delete_superseded (from 20261017000000)
--    The original "no answer references this object" check ran under the
--    student's RLS on LQ_answers, so an answer on another student's attempt
--    referencing the object was invisible and did not block the delete. The
--    only change is that this check now goes through the security-definer
--    helper and sees every answer. All other conditions are identical, so the
--    policy can only allow fewer deletes than before.
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
  and not public."LQ_submission_object_referenced"(storage.objects.name)
);

-- ---------------------------------------------------------------------------
-- 7. LQ_fulfill_reupload (owning student)
--    Writes only LQ_answers.file_path, LQ_reupload_requests, one admin
--    notification, and one audit row. No statement touches LQ_attempts or
--    LQ_attempt_part_scores, and no grading column is written.
-- ---------------------------------------------------------------------------
create or replace function public."LQ_fulfill_reupload"(p_request_id uuid, p_path text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_school_id text := public."LQ_my_school_id"();
  v_request public."LQ_reupload_requests";
  v_attempt public."LQ_attempts";
  v_answer public."LQ_answers";
  v_prefix text;
  v_quiz_title text;
  v_student_name text;
  v_question_number integer;
begin
  if v_actor is null
    or not public."LQ_workspace_ready"()
    or not exists (
      select 1 from public."LQ_profiles" profile
      where profile.id = v_actor and profile.role = 'student'
    ) then
    raise exception 'This re-upload request is no longer open';
  end if;

  select * into v_request
  from public."LQ_reupload_requests"
  where id = p_request_id
  for update;

  if v_request.id is not null then
    select * into v_attempt
    from public."LQ_attempts"
    where id = v_request.attempt_id
    for update;
  end if;

  -- One message for missing, foreign, closed, and lapsed requests so ids
  -- cannot be probed.
  if v_request.id is null
    or v_attempt.id is null
    or v_attempt.auth_user_id is distinct from v_actor
    or v_attempt.school_id is distinct from v_school_id
    or v_request.status <> 'open'
    or (v_request.deadline is not null and v_request.deadline <= now()) then
    raise exception 'This re-upload request is no longer open';
  end if;

  if v_attempt.status not in ('submitted', 'expired', 'reviewed') then
    raise exception 'This attempt cannot accept a re-upload';
  end if;

  -- Literal prefix comparison (no regex escaping of school_id) plus a strict
  -- suffix: uuid and image extension only, no extra segments or '..'.
  v_prefix := v_attempt.school_id || '/' || v_attempt.id::text || '/'
    || v_request.question_id::text || '_' || v_request.id::text || '_';

  if p_path is null
    or not starts_with(p_path, v_prefix)
    or substr(p_path, length(v_prefix) + 1) !~ '^[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$' then
    raise exception 'Invalid re-upload path';
  end if;

  -- Owner column differs across Storage versions (owner_id text on current
  -- Supabase, owner uuid on older stacks). Reading through to_jsonb avoids
  -- referencing a column that may not exist.
  if not exists (
    select 1
    from storage.objects stored_object
    where stored_object.bucket_id = 'lq-submissions'
      and stored_object.name = p_path
      and coalesce(
            to_jsonb(stored_object) ->> 'owner_id',
            to_jsonb(stored_object) ->> 'owner'
          ) = v_actor::text
      and stored_object.metadata ->> 'mimetype' in ('image/jpeg', 'image/png', 'image/webp')
      -- CASE guards the cast; AND does not guarantee evaluation order.
      and (case
             when (stored_object.metadata ->> 'size') ~ '^[0-9]{1,18}$'
               then (stored_object.metadata ->> 'size')::bigint
           end) between 1 and 10485760
  ) then
    raise exception 'The uploaded image was not found or is not an allowed image';
  end if;

  select * into v_answer
  from public."LQ_answers"
  where id = v_request.answer_id
  for update;

  if v_answer.id is null
    or v_answer.attempt_id <> v_request.attempt_id
    or v_answer.question_id <> v_request.question_id
    or v_answer.file_path is null
    or btrim(v_answer.file_path) = ''
    or strpos(v_answer.file_path, '/') > 0 then
    raise exception 'This answer no longer needs a re-upload';
  end if;

  update public."LQ_answers"
  set file_path = p_path
  where id = v_answer.id;

  update public."LQ_reupload_requests"
  set status = 'fulfilled',
      fulfilled_at = now(),
      fulfilled_path = p_path
  where id = v_request.id;

  select quiz.title into v_quiz_title
  from public."LQ_quizzes" quiz
  where quiz.id = v_attempt.quiz_id;

  select coalesce(
           nullif(concat_ws(' ', nullif(trim(roster.first_names), ''), nullif(trim(roster.last_name), '')), ''),
           v_attempt.school_id
         )
    into v_student_name
  from public."LQ_student_roster" roster
  where roster.school_id = v_attempt.school_id;

  select numbered.question_number into v_question_number
  from (
    select question.id,
           (row_number() over (order by question.position))::integer as question_number
    from public."LQ_questions" question
    where question.quiz_id = v_attempt.quiz_id
  ) numbered
  where numbered.id = v_request.question_id;

  insert into public."LQ_notifications" (recipient_role, type, title, message, metadata)
  values (
    'admin',
    'reupload_fulfilled',
    'Re-uploaded image received',
    format(
      '%s re-uploaded the image for question %s of %s.',
      coalesce(v_student_name, v_attempt.school_id),
      coalesce(v_question_number::text, '?'),
      coalesce(v_quiz_title, 'a quiz')
    ),
    jsonb_build_object(
      'school_id', v_attempt.school_id,
      'quiz_id', v_attempt.quiz_id::text,
      'attempt_id', v_attempt.id::text,
      'question_id', v_request.question_id::text,
      'request_id', v_request.id::text
    )
  );

  insert into public."LQ_audit_logs" (actor_id, event_type, entity_type, entity_id, metadata)
  values (
    v_actor,
    'reupload_fulfilled',
    'attempt',
    v_attempt.id,
    jsonb_build_object(
      'request_id', v_request.id,
      'answer_id', v_answer.id,
      'question_id', v_request.question_id,
      'path', p_path
    )
  );

  return jsonb_build_object('status', 'fulfilled', 'file_path', p_path);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. LQ_my_reupload_requests (student list). Reads as definer so archived
--    quizzes / inactive assignments still resolve; returns no keys, options,
--    points, correctness, or feedback.
-- ---------------------------------------------------------------------------
create or replace function public."LQ_my_reupload_requests"()
returns table (
  request_id uuid,
  attempt_id uuid,
  quiz_id uuid,
  quiz_title text,
  question_id uuid,
  question_number integer,
  prompt text,
  original_file_name text,
  deadline timestamptz,
  requested_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select request.id,
         attempt.id,
         attempt.quiz_id,
         quiz.title,
         request.question_id,
         numbered.question_number,
         numbered.prompt,
         request.original_file_name,
         request.deadline,
         request.requested_at
  from public."LQ_reupload_requests" request
  join public."LQ_attempts" attempt on attempt.id = request.attempt_id
  join public."LQ_quizzes" quiz on quiz.id = attempt.quiz_id
  join (
    select question.id,
           question.prompt,
           (row_number() over (partition by question.quiz_id order by question.position))::integer as question_number
    from public."LQ_questions" question
  ) numbered on numbered.id = request.question_id
  where public."LQ_workspace_ready"()
    and auth.uid() is not null
    and attempt.auth_user_id = auth.uid()
    and attempt.school_id = public."LQ_my_school_id"()
    and request.status = 'open'
    and (request.deadline is null or request.deadline > now())
  order by request.requested_at, request.id;
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants (role checks happen inside each function)
-- ---------------------------------------------------------------------------
revoke all on function public."LQ_request_reupload"(uuid, timestamptz) from public, anon;
revoke all on function public."LQ_cancel_reupload"(uuid) from public, anon;
revoke all on function public."LQ_can_upload_reupload_object"(text) from public, anon;
revoke all on function public."LQ_can_discard_reupload_object"(text) from public, anon;
revoke all on function public."LQ_fulfill_reupload"(uuid, text) from public, anon;
revoke all on function public."LQ_my_reupload_requests"() from public, anon;
revoke all on function public."LQ_submission_object_referenced"(text) from public, anon;

grant execute on function public."LQ_request_reupload"(uuid, timestamptz) to authenticated;
grant execute on function public."LQ_cancel_reupload"(uuid) to authenticated;
grant execute on function public."LQ_can_upload_reupload_object"(text) to authenticated;
grant execute on function public."LQ_can_discard_reupload_object"(text) to authenticated;
grant execute on function public."LQ_fulfill_reupload"(uuid, text) to authenticated;
grant execute on function public."LQ_my_reupload_requests"() to authenticated;
-- Needed because storage policies evaluate it with the caller's privileges.
grant execute on function public."LQ_submission_object_referenced"(text) to authenticated;

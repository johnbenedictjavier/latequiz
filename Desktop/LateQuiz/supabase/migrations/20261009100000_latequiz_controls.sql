-- Assignment, quiz lifecycle, and score-display controls.

alter table public."LQ_attempts"
  drop constraint if exists lq_attempts_status_check;

alter table public."LQ_attempts"
  drop constraint if exists "LQ_attempts_status_check";

alter table public."LQ_attempts"
  add constraint lq_attempts_status_check
  check (status in ('in_progress', 'submitted', 'expired', 'reviewed', 'cancelled'));

-- Keep assignment edits atomic and invalidate attempts that can no longer be used.
create or replace function public."LQ_sync_quiz_assignments"(
  p_quiz_id uuid,
  p_school_ids text[],
  p_attempt_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  selected_ids text[] := coalesce(p_school_ids, array[]::text[]);
  deactivated_count integer := 0;
begin
  if not public."LQ_is_admin"() then
    raise exception 'Only administrators can manage quiz assignments';
  end if;

  if p_attempt_limit is null or p_attempt_limit < 1 then
    raise exception 'Attempt limit must be at least one';
  end if;

  if not exists (select 1 from public."LQ_quizzes" where id = p_quiz_id) then
    raise exception 'Quiz not found';
  end if;

  if exists (
    select 1
    from unnest(selected_ids) as requested(school_id)
    where not exists (
      select 1
      from public."LQ_student_roster" roster
      where roster.school_id = upper(trim(requested.school_id))
        and roster.is_active = true
    )
  ) then
    raise exception 'Every selected student must be active in the roster';
  end if;

  insert into public."LQ_quiz_assignments" (
    quiz_id,
    school_id,
    attempt_limit,
    assigned_by,
    is_active,
    assigned_at
  )
  select
    p_quiz_id,
    upper(trim(requested.school_id)),
    p_attempt_limit,
    actor_id,
    true,
    now()
  from (
    select distinct school_id
    from unnest(selected_ids) as requested_ids(school_id)
  ) as requested
  on conflict (quiz_id, school_id) do update set
    attempt_limit = excluded.attempt_limit,
    assigned_by = excluded.assigned_by,
    assigned_at = excluded.assigned_at,
    is_active = true;

  update public."LQ_quiz_assignments" assignment
  set is_active = false
  where assignment.quiz_id = p_quiz_id
    and assignment.is_active = true
    and not (assignment.school_id = any(selected_ids));
  get diagnostics deactivated_count = row_count;

  update public."LQ_attempts" attempt
  set status = 'cancelled',
      submitted_at = coalesce(attempt.submitted_at, now())
  where attempt.quiz_id = p_quiz_id
    and attempt.status = 'in_progress'
    and not (attempt.school_id = any(selected_ids));

  insert into public."LQ_audit_logs" (actor_id, event_type, entity_type, entity_id, metadata)
  values (
    actor_id,
    'quiz_assignments_synced',
    'quiz',
    p_quiz_id,
    jsonb_build_object('selected_school_ids', selected_ids, 'deactivated_count', deactivated_count)
  );

  return jsonb_build_object('deactivated_count', deactivated_count);
end;
$$;

grant execute on function public."LQ_sync_quiz_assignments"(uuid, text[], integer) to authenticated;

-- Delete drafts without history. Historical quizzes are archived so scores and audit data remain valid.
create or replace function public."LQ_delete_quiz"(p_quiz_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  has_history boolean;
  result text;
begin
  if not public."LQ_is_admin"() then
    raise exception 'Only administrators can delete quizzes';
  end if;

  if not exists (select 1 from public."LQ_quizzes" where id = p_quiz_id) then
    raise exception 'Quiz not found';
  end if;

  select exists (
    select 1 from public."LQ_attempts" where quiz_id = p_quiz_id
  ) into has_history;

  if has_history then
    update public."LQ_quizzes"
    set status = 'archived', published_at = null
    where id = p_quiz_id;

    update public."LQ_quiz_assignments"
    set is_active = false
    where quiz_id = p_quiz_id;

    update public."LQ_attempts"
    set status = 'cancelled',
        submitted_at = coalesce(submitted_at, now())
    where quiz_id = p_quiz_id and status = 'in_progress';

    result := 'archived';
  else
    delete from public."LQ_quizzes" where id = p_quiz_id;
    result := 'deleted';
  end if;

  insert into public."LQ_audit_logs" (actor_id, event_type, entity_type, entity_id, metadata)
  values (
    actor_id,
    case when result = 'archived' then 'quiz_archived' else 'quiz_deleted' end,
    'quiz',
    p_quiz_id,
    jsonb_build_object('result', result)
  );

  return result;
end;
$$;

grant execute on function public."LQ_delete_quiz"(uuid) to authenticated;

-- Students may read their history, but only active attempts can be created or edited.
drop policy if exists lq_attempts_student_read_write on public."LQ_attempts";
drop policy if exists lq_attempts_student_read on public."LQ_attempts";
drop policy if exists lq_attempts_student_insert on public."LQ_attempts";
drop policy if exists lq_attempts_student_update on public."LQ_attempts";
drop policy if exists lq_attempts_admin_write on public."LQ_attempts";

create policy lq_attempts_student_read on public."LQ_attempts"
for select to authenticated
using (auth_user_id = auth.uid() or public."LQ_is_admin"());

create policy lq_attempts_student_insert on public."LQ_attempts"
for insert to authenticated
with check (
  public."LQ_is_admin"()
  or (
    auth_user_id = auth.uid()
    and school_id = public."LQ_my_school_id"()
    and status = 'in_progress'
    and exists (
      select 1
      from public."LQ_quiz_assignments" assignment
      join public."LQ_quizzes" quiz on quiz.id = assignment.quiz_id
      where assignment.id = "LQ_attempts".assignment_id
        and assignment.school_id = "LQ_attempts".school_id
        and assignment.quiz_id = "LQ_attempts".quiz_id
        and assignment.is_active = true
        and quiz.status = 'published'
    )
  )
);

create policy lq_attempts_student_update on public."LQ_attempts"
for update to authenticated
using (
  public."LQ_is_admin"()
  or (
    auth_user_id = auth.uid()
    and status = 'in_progress'
    and exists (
      select 1 from public."LQ_quiz_assignments" assignment
      where assignment.id = "LQ_attempts".assignment_id
        and assignment.is_active = true
    )
  )
)
with check (
  public."LQ_is_admin"()
  or (
    auth_user_id = auth.uid()
    and status = 'in_progress'
    and school_id = public."LQ_my_school_id"()
  )
);

create policy lq_attempts_admin_write on public."LQ_attempts"
for all to authenticated
using (public."LQ_is_admin"())
with check (public."LQ_is_admin"());

drop policy if exists lq_answers_student_read_write on public."LQ_answers";
drop policy if exists lq_answers_student_read on public."LQ_answers";
drop policy if exists lq_answers_student_insert on public."LQ_answers";
drop policy if exists lq_answers_student_update on public."LQ_answers";
drop policy if exists lq_answers_admin_write on public."LQ_answers";

create policy lq_answers_student_read on public."LQ_answers"
for select to authenticated
using (
  public."LQ_is_admin"()
  or exists (select 1 from public."LQ_attempts" attempt where attempt.id = attempt_id and attempt.auth_user_id = auth.uid())
);

create policy lq_answers_student_insert on public."LQ_answers"
for insert to authenticated
with check (
  public."LQ_is_admin"()
  or exists (
    select 1
    from public."LQ_attempts" attempt
    join public."LQ_quiz_assignments" assignment on assignment.id = attempt.assignment_id
    where attempt.id = attempt_id
      and attempt.auth_user_id = auth.uid()
      and attempt.status = 'in_progress'
      and assignment.is_active = true
  )
);

create policy lq_answers_student_update on public."LQ_answers"
for update to authenticated
using (
  public."LQ_is_admin"()
  or exists (
    select 1
    from public."LQ_attempts" attempt
    join public."LQ_quiz_assignments" assignment on assignment.id = attempt.assignment_id
    where attempt.id = attempt_id
      and attempt.auth_user_id = auth.uid()
      and attempt.status = 'in_progress'
      and assignment.is_active = true
  )
)
with check (
  public."LQ_is_admin"()
  or exists (
    select 1
    from public."LQ_attempts" attempt
    join public."LQ_quiz_assignments" assignment on assignment.id = attempt.assignment_id
    where attempt.id = attempt_id
      and attempt.auth_user_id = auth.uid()
      and attempt.status = 'in_progress'
      and assignment.is_active = true
  )
);

create policy lq_answers_admin_write on public."LQ_answers"
for all to authenticated
using (public."LQ_is_admin"())
with check (public."LQ_is_admin"());

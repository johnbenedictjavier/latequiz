-- Server-owned attempt lifecycle, quiz reporters, and protected answer keys.

alter table public."LQ_attempts"
  add column if not exists time_taken_seconds integer,
  add column if not exists submission_reason text not null default 'manual',
  add column if not exists last_saved_at timestamptz;

alter table public."LQ_attempts"
  drop constraint if exists lq_attempts_submission_reason_check;

alter table public."LQ_attempts"
  add constraint lq_attempts_submission_reason_check
  check (submission_reason in ('manual', 'exit', 'timeout', 'admin'));

alter table public."LQ_attempts"
  drop constraint if exists lq_attempts_time_taken_check;

alter table public."LQ_attempts"
  add constraint lq_attempts_time_taken_check
  check (time_taken_seconds is null or time_taken_seconds >= 0);

create table if not exists public."LQ_question_keys" (
  question_id uuid primary key references public."LQ_questions"(id) on delete cascade,
  answer_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public."LQ_question_keys" (question_id, answer_key)
select id, answer_key
from public."LQ_questions"
where answer_key is not null
on conflict (question_id) do update set answer_key = excluded.answer_key;

alter table public."LQ_questions" drop column if exists answer_key;

create table if not exists public."LQ_quiz_collaborators" (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public."LQ_quizzes"(id) on delete cascade,
  school_id text not null references public."LQ_student_roster"(school_id) on delete cascade,
  role text not null default 'reporter' check (role = 'reporter'),
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (quiz_id, school_id)
);

create index if not exists lq_collaborators_quiz_idx
  on public."LQ_quiz_collaborators" (quiz_id, school_id);

alter table public."LQ_quiz_collaborators" enable row level security;

create index if not exists lq_attempts_expiry_idx
  on public."LQ_attempts" (status, expires_at);

drop trigger if exists lq_question_keys_updated_at on public."LQ_question_keys";
create trigger lq_question_keys_updated_at before update on public."LQ_question_keys"
for each row execute function public."LQ_set_updated_at"();

create or replace function public."LQ_is_admin"()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public."LQ_profiles"
    where id = auth.uid()
      and role = 'admin'
      and must_change_password = false
  );
$$;

create or replace function public."LQ_workspace_ready"()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public."LQ_profiles" profile
    left join public."LQ_student_roster" roster on roster.school_id = profile.school_id
    where profile.id = auth.uid()
      and profile.must_change_password = false
      and (
        profile.role = 'admin'
        or (
          profile.role = 'student'
          and roster.is_active = true
          and roster.must_change_password = false
        )
      )
  );
$$;

create or replace function public."LQ_is_quiz_reporter"(p_quiz_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public."LQ_workspace_ready"()
    and exists (
      select 1
      from public."LQ_profiles" profile
      join public."LQ_quiz_collaborators" collaborator on collaborator.school_id = profile.school_id
      where profile.id = auth.uid()
        and collaborator.quiz_id = p_quiz_id
        and collaborator.role = 'reporter'
    );
$$;

create or replace function public."LQ_get_quiz_reporters"(p_quiz_ids uuid[])
returns table (
  quiz_id uuid,
  school_id text,
  first_names text,
  last_name text,
  avatar_url text
)
language sql
stable
security definer
set search_path = public
as $$
  select collaborator.quiz_id,
         roster.school_id,
         roster.first_names,
         roster.last_name,
         profile.avatar_url
  from public."LQ_quiz_collaborators" collaborator
  join public."LQ_quizzes" quiz on quiz.id = collaborator.quiz_id
  join public."LQ_student_roster" roster on roster.school_id = collaborator.school_id
  left join public."LQ_profiles" profile on profile.school_id = collaborator.school_id
  where public."LQ_workspace_ready"()
    and quiz.status = 'published'
     and collaborator.quiz_id = any(coalesce(p_quiz_ids, array[]::uuid[]))
     and roster.is_active = true
     and roster.auth_user_id is not null
  order by collaborator.quiz_id, roster.last_name, roster.first_names;
$$;

grant execute on function public."LQ_workspace_ready"() to authenticated;
grant execute on function public."LQ_is_quiz_reporter"(uuid) to authenticated;
grant execute on function public."LQ_get_quiz_reporters"(uuid[]) to authenticated;

create or replace function public."LQ_sync_quiz_collaborators"(
  p_quiz_id uuid,
  p_school_ids text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  selected_ids text[] := coalesce(
    array(
      select distinct upper(trim(value))
      from unnest(coalesce(p_school_ids, array[]::text[])) as requested(value)
      where trim(value) <> ''
    ),
    array[]::text[]
  );
begin
  if not public."LQ_is_admin"() then
    raise exception 'Only administrators can manage quiz reporters';
  end if;

  if not exists (select 1 from public."LQ_quizzes" where id = p_quiz_id) then
    raise exception 'Quiz not found';
  end if;

  if exists (
    select 1
    from public."LQ_quiz_assignments" assignment
    where assignment.quiz_id = p_quiz_id
      and assignment.is_active = true
      and assignment.school_id = any(selected_ids)
  ) then
    raise exception 'A reporter cannot also be assigned to this quiz';
  end if;

  if exists (
    select 1
    from unnest(selected_ids) as requested(school_id)
    where not exists (
      select 1
      from public."LQ_student_roster" roster
      where roster.school_id = requested.school_id
        and roster.is_active = true
        and roster.auth_user_id is not null
    )
  ) then
    raise exception 'Every reporter must be active in the roster';
  end if;

  delete from public."LQ_quiz_collaborators" collaborator
  where collaborator.quiz_id = p_quiz_id
    and not (collaborator.school_id = any(selected_ids));

  insert into public."LQ_quiz_collaborators" (quiz_id, school_id, role, added_by)
  select p_quiz_id, requested.school_id, 'reporter', actor_id
  from unnest(selected_ids) as requested(school_id)
  on conflict (quiz_id, school_id) do update set
    role = excluded.role,
    added_by = excluded.added_by;

  insert into public."LQ_audit_logs" (actor_id, event_type, entity_type, entity_id, metadata)
  values (
    actor_id,
    'quiz_collaborators_synced',
    'quiz',
    p_quiz_id,
    jsonb_build_object('school_ids', selected_ids)
  );

  return jsonb_build_object('count', cardinality(selected_ids));
end;
$$;

grant execute on function public."LQ_sync_quiz_collaborators"(uuid, text[]) to authenticated;

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
  selected_ids text[] := coalesce(
    array(
      select distinct upper(trim(value))
      from unnest(coalesce(p_school_ids, array[]::text[])) as requested(value)
      where trim(value) <> ''
    ),
    array[]::text[]
  );
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
    from public."LQ_quiz_collaborators" collaborator
    where collaborator.quiz_id = p_quiz_id
      and collaborator.school_id = any(selected_ids)
  ) then
    raise exception 'A reporter cannot also be assigned to this quiz';
  end if;

  if exists (
    select 1
    from unnest(selected_ids) as requested(school_id)
    where not exists (
      select 1
      from public."LQ_student_roster" roster
      where roster.school_id = requested.school_id
        and roster.is_active = true
    )
  ) then
    raise exception 'Every selected student must be active in the roster';
  end if;

  insert into public."LQ_quiz_assignments" (
    quiz_id, school_id, attempt_limit, assigned_by, is_active, assigned_at
  )
  select p_quiz_id, requested.school_id, p_attempt_limit, actor_id, true, now()
  from unnest(selected_ids) as requested(school_id)
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
      submitted_at = coalesce(attempt.submitted_at, now()),
      submission_reason = 'admin'
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

create or replace function public."LQ_start_attempt"(p_quiz_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  student_school_id text;
  assignment_record public."LQ_quiz_assignments";
  existing_attempt public."LQ_attempts";
  latest_attempt_number integer := 0;
  next_attempt_number integer;
  used_attempts integer := 0;
  duration integer;
  started_at_value timestamptz := now();
  expires_at_value timestamptz;
begin
  if actor_id is null or not public."LQ_workspace_ready"() then
    raise exception 'Your account must finish password setup before taking quizzes';
  end if;

  select school_id into student_school_id
  from public."LQ_profiles"
  where id = actor_id and role = 'student';
  if student_school_id is null then
    raise exception 'Only student accounts can start quiz attempts';
  end if;

  if public."LQ_is_quiz_reporter"(p_quiz_id) then
    raise exception 'Reporters can view this quiz but cannot answer it';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_quiz_id::text || ':' || actor_id::text));

  select * into assignment_record
  from public."LQ_quiz_assignments"
  where quiz_id = p_quiz_id
    and school_id = student_school_id
    and is_active = true;
  if assignment_record.id is null then
    raise exception 'Quiz is not assigned to this student';
  end if;

  select duration_seconds into duration
  from public."LQ_quizzes"
  where id = p_quiz_id and status = 'published';
  if duration is null then
    raise exception 'Quiz is not available';
  end if;

  select * into existing_attempt
  from public."LQ_attempts"
  where assignment_id = assignment_record.id
    and auth_user_id = actor_id
    and status = 'in_progress'
  order by attempt_number desc
  limit 1
  for update;

  if existing_attempt.id is not null and existing_attempt.expires_at > now() then
     select count(*) into used_attempts
     from public."LQ_attempts"
     where assignment_id = assignment_record.id
       and status <> 'cancelled';
    return jsonb_build_object(
      'attempt_id', existing_attempt.id,
      'expires_at', existing_attempt.expires_at,
      'attempt_number', existing_attempt.attempt_number,
      'remaining_attempts', greatest(assignment_record.attempt_limit - used_attempts, 0)
    );
  end if;

  if existing_attempt.id is not null then
    update public."LQ_attempts"
    set status = 'expired',
        submitted_at = coalesce(submitted_at, existing_attempt.expires_at),
        time_taken_seconds = greatest(0, extract(epoch from (existing_attempt.expires_at - existing_attempt.started_at))::integer),
        submission_reason = 'timeout'
    where id = existing_attempt.id and status = 'in_progress';
  end if;

  select coalesce(max(attempt_number), 0)
  into latest_attempt_number
  from public."LQ_attempts"
  where assignment_id = assignment_record.id and status <> 'cancelled';

  select count(*)
  into used_attempts
  from public."LQ_attempts"
   where assignment_id = assignment_record.id
     and status <> 'cancelled';

  next_attempt_number := latest_attempt_number + 1;
  if next_attempt_number > assignment_record.attempt_limit then
    raise exception 'You have used all attempts for this quiz';
  end if;

  expires_at_value := started_at_value + make_interval(secs => duration);
  insert into public."LQ_attempts" (
    assignment_id, quiz_id, school_id, auth_user_id, attempt_number, started_at, expires_at, last_saved_at
  ) values (
    assignment_record.id, p_quiz_id, student_school_id, actor_id, next_attempt_number, started_at_value, expires_at_value, started_at_value
  ) returning * into existing_attempt;

  return jsonb_build_object(
    'attempt_id', existing_attempt.id,
    'expires_at', existing_attempt.expires_at,
    'attempt_number', existing_attempt.attempt_number,
    'remaining_attempts', greatest(assignment_record.attempt_limit - used_attempts - 1, 0)
  );
end;
$$;

grant execute on function public."LQ_start_attempt"(uuid) to authenticated;

-- Protect the first-login flag from direct client updates. The password Edge Function
-- uses the service role and can update both identity records together.
create or replace function public."LQ_protect_student_profile"()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public."LQ_is_admin"() then
    if new.role is distinct from old.role
      or new.school_id is distinct from old.school_id
      or new.must_change_password is distinct from old.must_change_password
      then
      raise exception 'Students cannot change protected profile fields';
    end if;
  end if;
  return new;
end;
$$;

drop policy if exists lq_question_keys_admin_write on public."LQ_question_keys";
alter table public."LQ_question_keys" enable row level security;
create policy lq_question_keys_admin_write on public."LQ_question_keys"
for all to authenticated
using (public."LQ_is_admin"())
with check (public."LQ_is_admin"());

drop policy if exists lq_collaborators_read on public."LQ_quiz_collaborators";
create policy lq_collaborators_read on public."LQ_quiz_collaborators"
for select to authenticated
using (
  public."LQ_is_admin"()
  or (
    public."LQ_workspace_ready"()
    and exists (
      select 1 from public."LQ_quizzes" quiz
      where quiz.id = "LQ_quiz_collaborators".quiz_id and quiz.status = 'published'
    )
  )
);

drop policy if exists lq_collaborators_admin_write on public."LQ_quiz_collaborators";
create policy lq_collaborators_admin_write on public."LQ_quiz_collaborators"
for all to authenticated
using (public."LQ_is_admin"())
with check (public."LQ_is_admin"());

drop policy if exists lq_quizzes_student_read on public."LQ_quizzes";
create policy lq_quizzes_student_read on public."LQ_quizzes"
for select to authenticated
using ((status = 'published' and public."LQ_workspace_ready"()) or public."LQ_is_admin"());

drop policy if exists lq_questions_assigned_read on public."LQ_questions";
create policy lq_questions_assigned_read on public."LQ_questions"
for select to authenticated
using (
  public."LQ_is_admin"()
  or (
    public."LQ_workspace_ready"()
    and exists (
      select 1
      from public."LQ_quizzes" quiz
      where quiz.id = "LQ_questions".quiz_id
        and quiz.status = 'published'
        and (
          public."LQ_is_quiz_reporter"(quiz.id)
          or exists (
            select 1
            from public."LQ_quiz_assignments" assignment
            where assignment.quiz_id = quiz.id
              and assignment.school_id = public."LQ_my_school_id"()
              and assignment.is_active = true
          )
        )
    )
  )
);

drop policy if exists lq_parts_assigned_read on public."LQ_quiz_parts";
create policy lq_parts_assigned_read on public."LQ_quiz_parts"
for select to authenticated
using (
  public."LQ_is_admin"()
  or (
    public."LQ_workspace_ready"()
    and exists (
      select 1 from public."LQ_quizzes" quiz
      where quiz.id = "LQ_quiz_parts".quiz_id
        and quiz.status = 'published'
        and (
          public."LQ_is_quiz_reporter"(quiz.id)
          or exists (
            select 1 from public."LQ_quiz_assignments" assignment
            where assignment.quiz_id = quiz.id
              and assignment.school_id = public."LQ_my_school_id"()
              and assignment.is_active = true
          )
        )
    )
  )
);

drop policy if exists lq_assignments_student_read on public."LQ_quiz_assignments";
create policy lq_assignments_student_read on public."LQ_quiz_assignments"
for select to authenticated
using ((school_id = public."LQ_my_school_id"() and public."LQ_workspace_ready"()) or public."LQ_is_admin"());

drop policy if exists lq_attempts_student_insert on public."LQ_attempts";
create policy lq_attempts_student_insert on public."LQ_attempts"
for insert to authenticated
with check (public."LQ_is_admin"());

drop policy if exists lq_attempts_student_update on public."LQ_attempts";
create policy lq_attempts_student_update on public."LQ_attempts"
for update to authenticated
using (public."LQ_is_admin"())
with check (public."LQ_is_admin"());

drop policy if exists lq_answers_student_read on public."LQ_answers";
create policy lq_answers_student_read on public."LQ_answers"
for select to authenticated
using (
  public."LQ_is_admin"()
  or (
    public."LQ_workspace_ready"()
    and exists (
      select 1 from public."LQ_attempts" attempt
      where attempt.id = attempt_id
        and attempt.auth_user_id = auth.uid()
    )
  )
);

drop policy if exists lq_answers_student_insert on public."LQ_answers";
create policy lq_answers_student_insert on public."LQ_answers"
for insert to authenticated
with check (
  public."LQ_is_admin"()
  or (
    public."LQ_workspace_ready"()
    and exists (
      select 1
      from public."LQ_attempts" attempt
      where attempt.id = attempt_id
        and attempt.auth_user_id = auth.uid()
        and attempt.status = 'in_progress'
        and not public."LQ_is_quiz_reporter"(attempt.quiz_id)
    )
  )
);

drop policy if exists lq_answers_student_update on public."LQ_answers";
create policy lq_answers_student_update on public."LQ_answers"
for update to authenticated
using (
  public."LQ_is_admin"()
  or (
    public."LQ_workspace_ready"()
    and exists (
      select 1
      from public."LQ_attempts" attempt
      where attempt.id = attempt_id
        and attempt.auth_user_id = auth.uid()
        and attempt.status = 'in_progress'
        and not public."LQ_is_quiz_reporter"(attempt.quiz_id)
    )
  )
)
with check (
  public."LQ_is_admin"()
  or (
    public."LQ_workspace_ready"()
    and exists (
      select 1
      from public."LQ_attempts" attempt
      where attempt.id = attempt_id
        and attempt.auth_user_id = auth.uid()
        and attempt.status = 'in_progress'
        and not public."LQ_is_quiz_reporter"(attempt.quiz_id)
    )
  )
);

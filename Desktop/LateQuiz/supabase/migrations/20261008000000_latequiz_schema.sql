create extension if not exists pgcrypto;

create table if not exists public."LQ_student_roster" (
  id uuid primary key default gen_random_uuid(),
  school_id text not null unique check (school_id ~ '^[0-9]{2}-[0-9]{5}$'),
  last_name text not null,
  first_names text not null,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  is_active boolean not null default true,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public."LQ_profiles" (
  id uuid primary key references auth.users(id) on delete cascade,
  school_id text unique references public."LQ_student_roster"(school_id) on update cascade,
  username text unique,
  full_name text,
  avatar_url text,
  role text not null default 'student' check (role in ('student', 'admin')),
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public."LQ_quizzes" (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  subject text not null,
  description text not null default '',
  duration_seconds integer not null default 1800 check (duration_seconds between 60 and 86400),
  passing_score numeric(5, 2) not null default 75 check (passing_score between 0 and 100),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public."LQ_questions" (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public."LQ_quizzes"(id) on delete cascade,
  position integer not null check (position > 0),
  question_type text not null check (question_type in ('multiple-choice', 'identification', 'essay', 'upload')),
  prompt text not null,
  points numeric(7, 2) not null default 1 check (points > 0),
  options jsonb not null default '[]'::jsonb,
  answer_key text,
  requires_manual_review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (quiz_id, position)
);

create table if not exists public."LQ_quiz_assignments" (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public."LQ_quizzes"(id) on delete cascade,
  school_id text not null references public."LQ_student_roster"(school_id) on delete cascade,
  attempt_limit integer not null default 1 check (attempt_limit > 0),
  is_active boolean not null default true,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  unique (quiz_id, school_id)
);

create table if not exists public."LQ_attempts" (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public."LQ_quiz_assignments"(id) on delete restrict,
  quiz_id uuid not null references public."LQ_quizzes"(id) on delete restrict,
  school_id text not null references public."LQ_student_roster"(school_id) on delete restrict,
  auth_user_id uuid references auth.users(id) on delete set null,
  attempt_number integer not null default 1 check (attempt_number > 0),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  submitted_at timestamptz,
  status text not null default 'in_progress' check (status in ('in_progress', 'submitted', 'expired', 'reviewed')),
  auto_score numeric(7, 2) not null default 0,
  manual_score numeric(7, 2) not null default 0,
  final_score numeric(7, 2),
  created_at timestamptz not null default now(),
  unique (assignment_id, attempt_number)
);

create table if not exists public."LQ_answers" (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public."LQ_attempts"(id) on delete cascade,
  question_id uuid not null references public."LQ_questions"(id) on delete restrict,
  answer_text text,
  file_path text,
  is_correct boolean,
  points_awarded numeric(7, 2) not null default 0,
  feedback text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (attempt_id, question_id)
);

create table if not exists public."LQ_audit_logs" (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists lq_assignments_school_idx on public."LQ_quiz_assignments" (school_id, is_active);
create index if not exists lq_attempts_school_idx on public."LQ_attempts" (school_id, status);
create index if not exists lq_attempts_quiz_idx on public."LQ_attempts" (quiz_id, status);
create index if not exists lq_questions_quiz_idx on public."LQ_questions" (quiz_id, position);

create or replace function public."LQ_set_updated_at"()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists lq_roster_updated_at on public."LQ_student_roster";
create trigger lq_roster_updated_at before update on public."LQ_student_roster"
for each row execute function public."LQ_set_updated_at"();

drop trigger if exists lq_profiles_updated_at on public."LQ_profiles";
create trigger lq_profiles_updated_at before update on public."LQ_profiles"
for each row execute function public."LQ_set_updated_at"();

drop trigger if exists lq_quizzes_updated_at on public."LQ_quizzes";
create trigger lq_quizzes_updated_at before update on public."LQ_quizzes"
for each row execute function public."LQ_set_updated_at"();

drop trigger if exists lq_questions_updated_at on public."LQ_questions";
create trigger lq_questions_updated_at before update on public."LQ_questions"
for each row execute function public."LQ_set_updated_at"();

drop trigger if exists lq_answers_updated_at on public."LQ_answers";
create trigger lq_answers_updated_at before update on public."LQ_answers"
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
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public."LQ_my_school_id"()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select school_id from public."LQ_profiles" where id = auth.uid();
$$;

create or replace function public."LQ_school_id_is_rostered"(p_school_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public."LQ_student_roster"
    where school_id = upper(trim(p_school_id)) and is_active = true
  );
$$;

grant execute on function public."LQ_school_id_is_rostered"(text) to anon, authenticated;
grant execute on function public."LQ_is_admin"() to authenticated;
grant execute on function public."LQ_my_school_id"() to authenticated;

create or replace function public."LQ_link_new_auth_user"()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_school_id text := upper(trim(new.raw_user_meta_data ->> 'school_id'));
  roster_record public."LQ_student_roster";
begin
  if requested_school_id is not null and requested_school_id <> '' then
    select * into roster_record
    from public."LQ_student_roster"
    where school_id = requested_school_id and is_active = true;

    if roster_record.id is null then
      raise exception 'School ID is not present in the active roster';
    end if;

    insert into public."LQ_profiles" (id, school_id, full_name, role, must_change_password)
    values (new.id, roster_record.school_id, initcap(roster_record.first_names || ' ' || roster_record.last_name), 'student', true)
    on conflict (id) do update set school_id = excluded.school_id;

    update public."LQ_student_roster"
    set auth_user_id = new.id, must_change_password = true
    where id = roster_record.id;
  else
    insert into public."LQ_profiles" (id, role, username, full_name, must_change_password)
    values (new.id, 'student', split_part(new.email, '@', 1), initcap(coalesce(new.raw_user_meta_data ->> 'full_name', 'LateQuiz user')), true)
    on conflict (id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists lq_on_auth_user_created on auth.users;
create trigger lq_on_auth_user_created
  after insert on auth.users
  for each row execute function public."LQ_link_new_auth_user"();

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
      then
      raise exception 'Students cannot change protected profile fields';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists lq_protect_student_profile on public."LQ_profiles";
create trigger lq_protect_student_profile
  before update on public."LQ_profiles"
  for each row execute function public."LQ_protect_student_profile"();

create or replace function public."LQ_protect_student_attempt"()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public."LQ_is_admin"() and old.auth_user_id = auth.uid() then
    if new.assignment_id is distinct from old.assignment_id
      or new.quiz_id is distinct from old.quiz_id
      or new.school_id is distinct from old.school_id
      or new.attempt_number is distinct from old.attempt_number
      or new.started_at is distinct from old.started_at
      or new.expires_at is distinct from old.expires_at
      or new.auto_score is distinct from old.auto_score
      or new.manual_score is distinct from old.manual_score
      or new.final_score is distinct from old.final_score
      or (old.status <> 'in_progress' and new.status is distinct from old.status)
      or (old.status = 'in_progress' and new.status not in ('in_progress', 'submitted', 'expired')) then
      raise exception 'Students cannot change protected attempt fields';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists lq_protect_student_attempt on public."LQ_attempts";
create trigger lq_protect_student_attempt
  before update on public."LQ_attempts"
  for each row execute function public."LQ_protect_student_attempt"();

create or replace function public."LQ_validate_student_attempt"()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed_attempts integer;
begin
  if auth.uid() is not null and not public."LQ_is_admin"() then
    select attempt_limit into allowed_attempts
    from public."LQ_quiz_assignments"
    where id = new.assignment_id
      and school_id = new.school_id
      and quiz_id = new.quiz_id
      and is_active = true;

    if allowed_attempts is null or new.auth_user_id is distinct from auth.uid() or new.attempt_number > allowed_attempts then
      raise exception 'Attempt is not allowed for this assignment';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists lq_validate_student_attempt on public."LQ_attempts";
create trigger lq_validate_student_attempt
  before insert on public."LQ_attempts"
  for each row execute function public."LQ_validate_student_attempt"();

create or replace function public."LQ_protect_student_answer"()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public."LQ_is_admin"() then
    if new.is_correct is distinct from old.is_correct
      or new.points_awarded is distinct from old.points_awarded
      or new.feedback is distinct from old.feedback
      or new.reviewed_by is distinct from old.reviewed_by
      or new.reviewed_at is distinct from old.reviewed_at then
      raise exception 'Students cannot change grading fields';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists lq_protect_student_answer on public."LQ_answers";
create trigger lq_protect_student_answer
  before update on public."LQ_answers"
  for each row execute function public."LQ_protect_student_answer"();

alter table public."LQ_student_roster" enable row level security;
alter table public."LQ_profiles" enable row level security;
alter table public."LQ_quizzes" enable row level security;
alter table public."LQ_questions" enable row level security;
alter table public."LQ_quiz_assignments" enable row level security;
alter table public."LQ_attempts" enable row level security;
alter table public."LQ_answers" enable row level security;
alter table public."LQ_audit_logs" enable row level security;

drop policy if exists lq_roster_self_read on public."LQ_student_roster";
create policy lq_roster_self_read on public."LQ_student_roster"
for select to authenticated
using (school_id = public."LQ_my_school_id"() or public."LQ_is_admin"());

drop policy if exists lq_roster_admin_write on public."LQ_student_roster";
create policy lq_roster_admin_write on public."LQ_student_roster"
for all to authenticated
using (public."LQ_is_admin"())
with check (public."LQ_is_admin"());

drop policy if exists lq_profiles_self_read on public."LQ_profiles";
create policy lq_profiles_self_read on public."LQ_profiles"
for select to authenticated
using (id = auth.uid() or public."LQ_is_admin"());

drop policy if exists lq_profiles_self_update on public."LQ_profiles";
create policy lq_profiles_self_update on public."LQ_profiles"
for update to authenticated
using (id = auth.uid() or public."LQ_is_admin"())
with check (id = auth.uid() or public."LQ_is_admin"());

drop policy if exists lq_profiles_admin_insert on public."LQ_profiles";
create policy lq_profiles_admin_insert on public."LQ_profiles"
for insert to authenticated
with check (public."LQ_is_admin"());

drop policy if exists lq_quizzes_student_read on public."LQ_quizzes";
create policy lq_quizzes_student_read on public."LQ_quizzes"
for select to authenticated
using (status = 'published' or public."LQ_is_admin"());

drop policy if exists lq_quizzes_admin_write on public."LQ_quizzes";
create policy lq_quizzes_admin_write on public."LQ_quizzes"
for all to authenticated
using (public."LQ_is_admin"())
with check (public."LQ_is_admin"());

drop policy if exists lq_questions_assigned_read on public."LQ_questions";
create policy lq_questions_assigned_read on public."LQ_questions"
for select to authenticated
using (
  public."LQ_is_admin"()
  or exists (
    select 1
    from public."LQ_quizzes" q
    join public."LQ_quiz_assignments" a on a.quiz_id = q.id
    where q.id = "LQ_questions".quiz_id
      and q.status = 'published'
      and a.school_id = public."LQ_my_school_id"()
      and a.is_active = true
  )
);

drop policy if exists lq_questions_admin_write on public."LQ_questions";
create policy lq_questions_admin_write on public."LQ_questions"
for all to authenticated
using (public."LQ_is_admin"())
with check (public."LQ_is_admin"());

drop policy if exists lq_assignments_student_read on public."LQ_quiz_assignments";
create policy lq_assignments_student_read on public."LQ_quiz_assignments"
for select to authenticated
using (school_id = public."LQ_my_school_id"() or public."LQ_is_admin"());

drop policy if exists lq_assignments_admin_write on public."LQ_quiz_assignments";
create policy lq_assignments_admin_write on public."LQ_quiz_assignments"
for all to authenticated
using (public."LQ_is_admin"())
with check (public."LQ_is_admin"());

drop policy if exists lq_attempts_student_read_write on public."LQ_attempts";
create policy lq_attempts_student_read_write on public."LQ_attempts"
for all to authenticated
using (auth_user_id = auth.uid() or public."LQ_is_admin"())
with check (
  public."LQ_is_admin"()
  or (
    auth_user_id = auth.uid()
    and school_id = public."LQ_my_school_id"()
    and exists (
      select 1 from public."LQ_quiz_assignments" assignment
      where assignment.id = "LQ_attempts".assignment_id
        and assignment.school_id = "LQ_attempts".school_id
        and assignment.quiz_id = "LQ_attempts".quiz_id
        and assignment.is_active = true
    )
  )
);

drop policy if exists lq_answers_student_read_write on public."LQ_answers";
create policy lq_answers_student_read_write on public."LQ_answers"
for all to authenticated
using (
  public."LQ_is_admin"()
  or exists (select 1 from public."LQ_attempts" a where a.id = attempt_id and a.auth_user_id = auth.uid())
)
with check (
  public."LQ_is_admin"()
  or exists (select 1 from public."LQ_attempts" a where a.id = attempt_id and a.auth_user_id = auth.uid())
);

drop policy if exists lq_audit_admin_read on public."LQ_audit_logs";
create policy lq_audit_admin_read on public."LQ_audit_logs"
for select to authenticated using (public."LQ_is_admin"());

drop policy if exists lq_audit_admin_insert on public."LQ_audit_logs";
create policy lq_audit_admin_insert on public."LQ_audit_logs"
for insert to authenticated with check (public."LQ_is_admin"() and actor_id = auth.uid());

insert into storage.buckets (id, name, public)
values ('lq-submissions', 'lq-submissions', false), ('lq-avatars', 'lq-avatars', false)
on conflict (id) do nothing;

drop policy if exists lq_submission_student_upload on storage.objects;
create policy lq_submission_student_upload on storage.objects
for insert to authenticated
with check (
  bucket_id = 'lq-submissions'
  and (storage.foldername(name))[1] = public."LQ_my_school_id"()
);

drop policy if exists lq_submission_student_read on storage.objects;
create policy lq_submission_student_read on storage.objects
for select to authenticated
using (
  bucket_id = 'lq-submissions'
  and ((storage.foldername(name))[1] = public."LQ_my_school_id"() or public."LQ_is_admin"())
);

drop policy if exists lq_submission_admin_delete on storage.objects;
create policy lq_submission_admin_delete on storage.objects
for delete to authenticated
using (bucket_id = 'lq-submissions' and public."LQ_is_admin"());

drop policy if exists lq_avatar_self_write on storage.objects;
create policy lq_avatar_self_write on storage.objects
for all to authenticated
using (bucket_id = 'lq-avatars' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'lq-avatars' and (storage.foldername(name))[1] = auth.uid()::text);

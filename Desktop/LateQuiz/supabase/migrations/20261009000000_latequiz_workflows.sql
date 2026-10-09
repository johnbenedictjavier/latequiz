-- Workflow additions for the production student/admin experience.

alter table public."LQ_quizzes"
  drop constraint if exists lq_quizzes_duration_seconds_check;

alter table public."LQ_quizzes"
  drop constraint if exists "LQ_quizzes_duration_seconds_check";

alter table public."LQ_quizzes"
  add constraint lq_quizzes_duration_seconds_check
  check (duration_seconds between 60 and 86400);

create table if not exists public."LQ_subjects" (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public."LQ_notifications" (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid references auth.users(id) on delete cascade,
  recipient_role text not null check (recipient_role in ('admin', 'student')),
  type text not null,
  title text not null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists lq_notifications_recipient_idx
  on public."LQ_notifications" (recipient_role, recipient_id, created_at desc);

drop trigger if exists lq_subjects_updated_at on public."LQ_subjects";
create trigger lq_subjects_updated_at before update on public."LQ_subjects"
for each row execute function public."LQ_set_updated_at"();

insert into public."LQ_subjects" (name)
values ('Architecture and Organization')
on conflict (name) do update set is_active = true;

-- Existing quizzes remain drafts and keep their titles, while the initial subject
-- is normalized to the course requested by the administrator.
update public."LQ_quizzes"
set subject = 'Architecture and Organization'
where subject is distinct from 'Architecture and Organization';

alter table public."LQ_subjects" enable row level security;
alter table public."LQ_notifications" enable row level security;

drop policy if exists lq_subjects_authenticated_read on public."LQ_subjects";
create policy lq_subjects_authenticated_read on public."LQ_subjects"
for select to authenticated
using (is_active = true or public."LQ_is_admin"());

drop policy if exists lq_subjects_admin_write on public."LQ_subjects";
create policy lq_subjects_admin_write on public."LQ_subjects"
for all to authenticated
using (public."LQ_is_admin"())
with check (public."LQ_is_admin"());

drop policy if exists lq_notifications_recipient_read on public."LQ_notifications";
create policy lq_notifications_recipient_read on public."LQ_notifications"
for select to authenticated
using (
  recipient_role = 'admin'
  and public."LQ_is_admin"()
  and (recipient_id is null or recipient_id = auth.uid())
);

drop policy if exists lq_notifications_recipient_update on public."LQ_notifications";
create policy lq_notifications_recipient_update on public."LQ_notifications"
for update to authenticated
using (
  recipient_role = 'admin'
  and public."LQ_is_admin"()
  and (recipient_id is null or recipient_id = auth.uid())
)
with check (
  recipient_role = 'admin'
  and public."LQ_is_admin"()
  and (recipient_id is null or recipient_id = auth.uid())
);

drop policy if exists lq_roster_self_read on public."LQ_student_roster";
create policy lq_roster_self_read on public."LQ_student_roster"
for select to authenticated
using ((school_id = public."LQ_my_school_id"() and is_active = true) or public."LQ_is_admin"());

drop policy if exists lq_assignments_student_read on public."LQ_quiz_assignments";
create policy lq_assignments_student_read on public."LQ_quiz_assignments"
for select to authenticated
using ((school_id = public."LQ_my_school_id"() and is_active = true) or public."LQ_is_admin"());

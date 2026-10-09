create table if not exists public."LQ_quiz_parts" (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public."LQ_quizzes"(id) on delete cascade,
  position integer not null check (position > 0),
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (quiz_id, position)
);

alter table public."LQ_questions"
  add column if not exists part_id uuid references public."LQ_quiz_parts"(id) on delete restrict;

alter table public."LQ_questions"
  add column if not exists part_position integer check (part_position is null or part_position > 0);

create table if not exists public."LQ_attempt_part_scores" (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public."LQ_attempts"(id) on delete cascade,
  part_id uuid references public."LQ_quiz_parts"(id) on delete set null,
  part_title text not null,
  position integer not null check (position > 0),
  points_possible numeric(7, 2) not null default 0 check (points_possible >= 0),
  auto_points numeric(7, 2) not null default 0 check (auto_points >= 0),
  final_points numeric(7, 2) check (final_points is null or final_points >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (attempt_id, position)
);

create index if not exists lq_parts_quiz_idx on public."LQ_quiz_parts" (quiz_id, position);
create index if not exists lq_questions_part_idx on public."LQ_questions" (part_id, part_position);
create index if not exists lq_attempt_part_scores_attempt_idx on public."LQ_attempt_part_scores" (attempt_id, position);

drop trigger if exists lq_parts_updated_at on public."LQ_quiz_parts";
create trigger lq_parts_updated_at before update on public."LQ_quiz_parts"
for each row execute function public."LQ_set_updated_at"();

drop trigger if exists lq_attempt_part_scores_updated_at on public."LQ_attempt_part_scores";
create trigger lq_attempt_part_scores_updated_at before update on public."LQ_attempt_part_scores"
for each row execute function public."LQ_set_updated_at"();

alter table public."LQ_quiz_parts" enable row level security;
alter table public."LQ_attempt_part_scores" enable row level security;

drop policy if exists lq_parts_assigned_read on public."LQ_quiz_parts";
create policy lq_parts_assigned_read on public."LQ_quiz_parts"
for select to authenticated
using (
  public."LQ_is_admin"()
  or exists (
    select 1
    from public."LQ_quizzes" q
    join public."LQ_quiz_assignments" a on a.quiz_id = q.id
    where q.id = "LQ_quiz_parts".quiz_id
      and q.status = 'published'
      and a.school_id = public."LQ_my_school_id"()
      and a.is_active = true
  )
);

drop policy if exists lq_parts_admin_write on public."LQ_quiz_parts";
create policy lq_parts_admin_write on public."LQ_quiz_parts"
for all to authenticated
using (public."LQ_is_admin"())
with check (public."LQ_is_admin"());

drop policy if exists lq_attempt_part_scores_self_read on public."LQ_attempt_part_scores";
create policy lq_attempt_part_scores_self_read on public."LQ_attempt_part_scores"
for select to authenticated
using (
  public."LQ_is_admin"()
  or exists (
    select 1 from public."LQ_attempts" a
    where a.id = attempt_id and a.auth_user_id = auth.uid()
  )
);

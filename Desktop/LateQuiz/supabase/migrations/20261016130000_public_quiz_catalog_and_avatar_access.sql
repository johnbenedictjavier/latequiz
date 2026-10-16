-- Safe quiz catalog counts and signed avatar reads for workspace users.

create or replace function public."LQ_get_published_quiz_catalog"(
  p_quiz_ids uuid[]
)
returns table (
  quiz_id uuid,
  question_count bigint,
  possible_points numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select quiz.id,
         count(question.id)::bigint,
         coalesce(sum(question.points), 0)::numeric
  from public."LQ_quizzes" quiz
  left join public."LQ_questions" question on question.quiz_id = quiz.id
  where public."LQ_workspace_ready"()
    and quiz.status = 'published'
    and (p_quiz_ids is null or quiz.id = any(p_quiz_ids))
  group by quiz.id;
$$;

grant execute on function public."LQ_get_published_quiz_catalog"(uuid[]) to authenticated;

create or replace function public."LQ_get_admin_quiz_reporters"(
  p_quiz_ids uuid[]
)
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
  join public."LQ_student_roster" roster on roster.school_id = collaborator.school_id
  left join public."LQ_profiles" profile on profile.school_id = collaborator.school_id
  where public."LQ_is_admin"()
    and (p_quiz_ids is null or collaborator.quiz_id = any(p_quiz_ids))
    and collaborator.role = 'reporter'
    and roster.is_active = true
  order by collaborator.quiz_id, roster.last_name, roster.first_names;
$$;

grant execute on function public."LQ_get_admin_quiz_reporters"(uuid[]) to authenticated;

drop policy if exists lq_avatar_workspace_read on storage.objects;
create policy lq_avatar_workspace_read on storage.objects
for select to authenticated
using (
  bucket_id = 'lq-avatars'
  and public."LQ_workspace_ready"()
);

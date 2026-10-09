-- Admin review, score correction, and submission deletion controls.

drop policy if exists lq_attempt_part_scores_admin_write on public."LQ_attempt_part_scores";
create policy lq_attempt_part_scores_admin_write on public."LQ_attempt_part_scores"
for all to authenticated
using (public."LQ_is_admin"())
with check (public."LQ_is_admin"());

create or replace function public."LQ_review_attempt"(
  p_attempt_id uuid,
  p_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  attempt_record public."LQ_attempts";
  answer_record public."LQ_answers";
  answer_exists boolean;
  question_record record;
  grade_item jsonb;
  awarded numeric(7, 2);
  correct boolean;
  answer_feedback text;
  total_points numeric(7, 2) := 0;
  auto_points numeric(7, 2) := 0;
  manual_points numeric(7, 2) := 0;
begin
  if not public."LQ_is_admin"() then
    raise exception 'Only administrators can review submissions';
  end if;

  if jsonb_typeof(coalesce(p_answers, '[]'::jsonb)) <> 'array' then
    raise exception 'Submission grades must be an array';
  end if;

  select * into attempt_record
  from public."LQ_attempts"
  where id = p_attempt_id;

  if attempt_record.id is null then
    raise exception 'Submission not found';
  end if;

  if attempt_record.status = 'cancelled' then
    raise exception 'Cancelled submissions cannot be reviewed';
  end if;

  for question_record in
    select id, points, question_type, requires_manual_review
    from public."LQ_questions"
    where quiz_id = attempt_record.quiz_id
    order by position
  loop
    total_points := total_points + question_record.points;
    grade_item := null;

    select value into grade_item
    from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) value
    where value ->> 'question_id' = question_record.id::text
    limit 1;

    select * into answer_record
    from public."LQ_answers"
    where attempt_id = attempt_record.id
      and question_id = question_record.id;
    answer_exists := found;

    awarded := coalesce(
      nullif(grade_item ->> 'points_awarded', '')::numeric,
      case when answer_exists then answer_record.points_awarded else 0 end,
      0
    );
    if awarded < 0 or awarded > question_record.points then
      raise exception 'Points awarded must be between zero and the question points';
    end if;

    correct := case
      when grade_item ? 'is_correct' and grade_item ->> 'is_correct' is not null then (grade_item ->> 'is_correct')::boolean
      when answer_exists then answer_record.is_correct
      else null
    end;
    answer_feedback := case
      when grade_item ? 'feedback' then grade_item ->> 'feedback'
      when answer_exists then answer_record.feedback
      else null
    end;

    if answer_exists then
      update public."LQ_answers"
      set is_correct = correct,
          points_awarded = awarded,
          feedback = answer_feedback,
          reviewed_by = actor_id,
          reviewed_at = now()
      where id = answer_record.id;
    else
      insert into public."LQ_answers" (
        attempt_id,
        question_id,
        is_correct,
        points_awarded,
        feedback,
        reviewed_by,
        reviewed_at
      ) values (
        attempt_record.id,
        question_record.id,
        correct,
        awarded,
        answer_feedback,
        actor_id,
        now()
      );
    end if;

    if question_record.requires_manual_review or question_record.question_type in ('essay', 'upload') then
      manual_points := manual_points + awarded;
    else
      auto_points := auto_points + awarded;
    end if;
  end loop;

  delete from public."LQ_attempt_part_scores"
  where attempt_id = attempt_record.id;

  insert into public."LQ_attempt_part_scores" (
    attempt_id,
    part_id,
    part_title,
    position,
    points_possible,
    auto_points,
    final_points
  )
  select
    attempt_record.id,
    grouped.part_id,
    grouped.part_title,
    grouped.position,
    grouped.points_possible,
    grouped.auto_points,
    grouped.final_points
  from (
    select
      question.part_id,
      coalesce(part.title, 'General') as part_title,
      coalesce(part.position, coalesce((select max(position) from public."LQ_quiz_parts" where quiz_id = attempt_record.quiz_id), 0) + 1) as position,
      sum(question.points)::numeric(7, 2) as points_possible,
      sum(case when question.requires_manual_review or question.question_type in ('essay', 'upload') then 0 else coalesce(answer.points_awarded, 0) end)::numeric(7, 2) as auto_points,
      sum(coalesce(answer.points_awarded, 0))::numeric(7, 2) as final_points
    from public."LQ_questions" question
    left join public."LQ_quiz_parts" part on part.id = question.part_id
    left join public."LQ_answers" answer on answer.attempt_id = attempt_record.id and answer.question_id = question.id
    where question.quiz_id = attempt_record.quiz_id
    group by question.part_id, part.title, part.position
  ) grouped;

  update public."LQ_attempts"
  set status = 'reviewed',
      submitted_at = coalesce(submitted_at, now()),
      auto_score = case when total_points > 0 then round((auto_points / total_points) * 100, 2) else 0 end,
      manual_score = manual_points,
      final_score = case when total_points > 0 then round(((auto_points + manual_points) / total_points) * 100, 2) else 0 end
  where id = attempt_record.id;

  insert into public."LQ_audit_logs" (actor_id, event_type, entity_type, entity_id, metadata)
  values (
    actor_id,
    'submission_reviewed',
    'attempt',
    attempt_record.id,
    jsonb_build_object('auto_points', auto_points, 'manual_points', manual_points, 'possible_points', total_points)
  );

  return jsonb_build_object(
    'status', 'reviewed',
    'auto_score', case when total_points > 0 then round((auto_points / total_points) * 100, 2) else 0 end,
    'final_score', case when total_points > 0 then round(((auto_points + manual_points) / total_points) * 100, 2) else 0 end
  );
end;
$$;

grant execute on function public."LQ_review_attempt"(uuid, jsonb) to authenticated;

create or replace function public."LQ_delete_attempt"(p_attempt_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  attempt_record public."LQ_attempts";
begin
  if not public."LQ_is_admin"() then
    raise exception 'Only administrators can delete submissions';
  end if;

  select * into attempt_record
  from public."LQ_attempts"
  where id = p_attempt_id;

  if attempt_record.id is null then
    raise exception 'Submission not found';
  end if;

  insert into public."LQ_audit_logs" (actor_id, event_type, entity_type, entity_id, metadata)
  values (
    actor_id,
    'submission_deleted',
    'attempt',
    attempt_record.id,
    jsonb_build_object('quiz_id', attempt_record.quiz_id, 'school_id', attempt_record.school_id, 'status', attempt_record.status)
  );

  delete from public."LQ_attempts" where id = p_attempt_id;
  return 'deleted';
end;
$$;

grant execute on function public."LQ_delete_attempt"(uuid) to authenticated;

-- Replace UUID-only submission notifications with the student and quiz names.

update public."LQ_notifications" as notification
set message = case
  when notification.metadata->>'submission_reason' = 'timeout' then format(
    '%s''s attempt for %s reached its time limit.',
    coalesce(nullif(concat_ws(' ', nullif(trim(student.first_names), ''), nullif(trim(student.last_name), '')), ''), student.school_id),
    quiz.title
  )
  else format(
    '%s submitted an attempt for %s.',
    coalesce(nullif(concat_ws(' ', nullif(trim(student.first_names), ''), nullif(trim(student.last_name), '')), ''), student.school_id),
    quiz.title
  )
end
from public."LQ_student_roster" as student, public."LQ_quizzes" as quiz
where notification.type = 'submission_received'
  and notification.metadata->>'school_id' = student.school_id
  and notification.metadata->>'quiz_id' = quiz.id::text;

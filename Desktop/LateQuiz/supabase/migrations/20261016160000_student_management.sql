-- Keep student removal safe for historical attempts and auditable for administrators.

create or replace function public."LQ_delete_student"(p_school_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  normalized_school_id text := upper(trim(coalesce(p_school_id, '')));
  roster_record public."LQ_student_roster";
  has_history boolean;
  result text;
begin
  if not public."LQ_is_admin"() then
    raise exception 'Only administrators can delete students';
  end if;

  if normalized_school_id !~ '^[0-9]{2}-[0-9]{5}$' then
    raise exception 'Valid school ID required';
  end if;

  select * into roster_record
  from public."LQ_student_roster"
  where school_id = normalized_school_id
  for update;

  if not found then
    raise exception 'Student not found';
  end if;

  select exists (
    select 1
    from public."LQ_attempts"
    where school_id = normalized_school_id
  ) into has_history;

  if has_history then
    update public."LQ_quiz_assignments"
    set is_active = false
    where school_id = normalized_school_id;

    update public."LQ_attempts"
    set status = 'cancelled',
        submitted_at = coalesce(submitted_at, now())
    where school_id = normalized_school_id
      and status = 'in_progress';

    update public."LQ_student_roster"
    set is_active = false
    where school_id = normalized_school_id;

    result := 'deactivated';
    insert into public."LQ_audit_logs" (actor_id, event_type, entity_type, entity_id, metadata)
    values (
      actor_id,
      'student_deactivated',
      'student',
      roster_record.id,
      jsonb_build_object('school_id', normalized_school_id, 'result', result, 'history_preserved', true)
    );
  else
    -- Profiles reference the roster without ON DELETE CASCADE. Remove the profile first;
    -- the Edge Function removes the matching Auth user after this transaction succeeds.
    delete from public."LQ_profiles"
    where school_id = normalized_school_id;

    delete from public."LQ_student_roster"
    where school_id = normalized_school_id;

    result := 'deleted';
    insert into public."LQ_audit_logs" (actor_id, event_type, entity_type, entity_id, metadata)
    values (
      actor_id,
      'student_deleted',
      'student',
      roster_record.id,
      jsonb_build_object('school_id', normalized_school_id, 'result', result, 'history_preserved', false)
    );
  end if;

  return jsonb_build_object(
    'result', result,
    'school_id', normalized_school_id,
    'name', trim(roster_record.first_names || ' ' || roster_record.last_name),
    'auth_user_id', roster_record.auth_user_id
  );
end;
$$;

grant execute on function public."LQ_delete_student"(text) to authenticated;

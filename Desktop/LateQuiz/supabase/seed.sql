insert into public."LQ_student_roster" (school_id, last_name, first_names)
values
  ('24-00392', 'Javier', 'John Benedict'),
  ('24-00529', 'Lucido', 'Carl Andrei'),
  ('24-00320', 'Vidal', 'Ryan'),
  ('24-00336', 'Dimaano', 'Daniah'),
  ('24-00463', 'Almendras', 'Jedh Laurence'),
  ('24-00982', 'Ramirez', 'John Harvey'),
  ('24-00366', 'Tapire', 'Jonh Carlo'),
  ('24-00795', 'Navarro', 'Danharry'),
  ('24-00333', 'Flores', 'Aramae'),
  ('24-00889', 'Resaba', 'Jessica Marie'),
  ('24-00844', 'Abrenica', 'Aerol Justine')
on conflict (school_id) do update set
  last_name = excluded.last_name,
  first_names = excluded.first_names,
  updated_at = now();

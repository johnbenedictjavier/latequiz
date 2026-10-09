# LateQuiz

LateQuiz is a mobile-first recovery quiz workspace for students and administrators.

## Local development

The application requires a configured Supabase project. Run:

```bash
npm install
npm run dev
```

Open `/login` for students. Administrators use the Admin login switch on the same page.

## Supabase setup

1. Copy `.env.example` to `.env.local`.
2. Add the Supabase URL and publishable key.
3. Apply all migrations in `supabase/migrations/`.
4. Run `supabase/seed.sql` to load the initial school-ID roster.
5. Deploy `supabase/functions/provision-students`, `supabase/functions/reset-student-password`, `supabase/functions/request-student-password-reset`, and `supabase/functions/submit-attempt`.
6. Create the administrator in Supabase Auth using the internal identifier `admin@auth.latequiz.internal`.
7. Add that user to `LQ_profiles` with `role = 'admin'`.

The student-facing forms do not ask for email. Supabase uses a hidden internal identifier only to support Auth password sessions. New and reset student accounts use `LQ@Architect2026` and must change it after signing in.

Student profile pictures are stored in the private `lq-avatars` bucket. Quiz assignments can be synchronized from the assignment modal, including unassigning students. Draft quizzes without attempts can be deleted; quizzes with attempt history are archived to preserve scores.

All application tables use the required `LQ_` prefix. Quiz access is controlled by `LQ_quiz_assignments.school_id`, so assignments can exist before students activate their accounts.

## Verification

```bash
npm run build
```

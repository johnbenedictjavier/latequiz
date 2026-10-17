# Multi Answer Keys and Image Uploads Bugfix Design

## Overview

Two defects share one spec, plus a recovery path for data the second defect already damaged:

1. **Single identification key.** `LQ_question_keys.answer_key` is a single `text`. The builder (`BuilderQuestion` in `src/App.tsx`) offers one input, `saveQuiz` (`src/lib/admin.ts`) writes `question.answer?.trim() || null`, and both grading paths (`supabase/functions/submit-attempt/index.ts`, `supabase/functions/finalize-expired-attempts/index.ts`) compare `normalize(answer_text) === normalize(answer_key)`. Valid alternatives are graded wrong, and a blank key saves as `null` so nothing can ever match.
2. **Uploads never upload.** `QuestionInput` calls `onChange(file.name)`, so `LQ_answers.file_path` holds a bare file name. Nothing is written to `lq-submissions`, there is no validation, the review drawer prints the name as text, and no storage cleanup happens on replace/remove/delete.
3. **No recovery for legacy uploads.** Submitted, expired, and reviewed attempts that hold a bare file name have no stored image, and nothing lets an admin ask for it or lets the student provide it. Students cannot write to `LQ_answers` once the attempt leaves `in_progress` (RLS `lq_answers_student_update`), and there is no student notification centre (`lq_notifications_recipient_read` only serves `recipient_role = 'admin'`).

Fix strategy:

- Add `answer_keys text[]` to `LQ_question_keys`, backfill each non-null `answer_key` as a one-element array, then drop `answer_key`. Identification questions get repeatable key fields; every other type keeps writing at most one key (a one-element array).
- Put `normalize`, `matchesAnyKey`, and key validation in one dependency-free module shared by both edge functions and the frontend. Grading changes from "equals the key" to "equals any key", which is identical when there is exactly one key.
- Implement real image uploads to `lq-submissions` under `{school_id}/{attempt_id}/`, validated client-side and by bucket limits, persisted immediately to `LQ_answers.file_path`, and displayed to admins via short-lived signed URLs.
- Clean up storage with least privilege: a narrowly scoped student delete policy for superseded files on their own in-progress attempts, and admin-side removal of the attempt's objects when a submission is deleted. `LQ_delete_attempt` and its `submission_deleted` audit entry are unchanged.
- Add an admin-requested re-upload flow for legacy answers, built for least privilege: a new `LQ_reupload_requests` table (admin full access, students read-only on their own attempts), admin-checked security-definer RPCs to open and cancel requests, one extra storage insert policy that only admits an object named for the student's own open, unexpired request, and a security-definer `LQ_fulfill_reupload` RPC that verifies everything again, sets only that answer's `file_path`, closes the request, and notifies admins. Students learn about requests from a banner on the dashboard and score history and upload on a single-question page with no timer. Nothing in the flow touches `is_correct`, `points_awarded`, scores, part scores, or attempt status; grading stays in the existing review drawer.

### Defaults chosen for open decisions (change any of these before implementation)

| Decision | Default in this design |
|---|---|
| Allowed upload types | Images only: `image/jpeg`, `image/png`, `image/webp` (`.jpg`, `.jpeg`, `.png`, `.webp`). PDF is dropped from the picker. |
| Size limit | 10 MB (10,485,760 bytes); empty (0-byte) files are rejected. |
| Server-side enforcement | `storage.buckets` row for `lq-submissions` gets `file_size_limit = 10485760` and `allowed_mime_types = {image/jpeg,image/png,image/webp}`. |
| Picker copy | Label "JPG, PNG, or WEBP image up to 10 MB", `accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"`. |
| Replace/remove cleanup | Student delete policy limited to `{own school_id}/{own in_progress attempt_id}/…` objects that are **not** the currently saved `file_path` of any answer. Submitted/expired attempts are immutable for students. |
| Admin delete cleanup | Client collects the attempt's object paths, calls `LQ_delete_attempt` (rows + audit log), then removes the objects with the admin's storage delete permission. Storage failure after a successful row delete is reported as a warning, not a rollback. |
| Multiple-choice storage | Exactly one key, stored as a one-element `text[]` (`{"Option text"}`). The MC builder UI is unchanged. |
| Essay/upload keys | Unchanged semantics: if a stale `answer` string exists it is stored as a one-element array, otherwise `null`. Never used for grading. |
| Blank key fields | Blocking: the builder refuses to save while any identification key field is blank or duplicated, and names the problem. Admins remove extra fields with the remove button. |
| Signed URL lifetime | 300 seconds, re-requested each time the drawer renders the answer. |
| Deploy order | Migration, then both edge functions, then the frontend, in one release window. Old code that selects `answer_key` fails between the migration and redeploy. The re-upload migration is additive and can ship in the same window. |
| Re-upload eligibility to open a request | Upload question, `file_path` is a legacy file name, attempt status `submitted`, `expired`, or `reviewed` (2.14, 2.23). `in_progress` and `cancelled` attempts are rejected. |
| Re-upload eligibility to fulfill | Request `open` and unexpired, attempt owned by the caller and in `submitted`, `expired`, or `reviewed`. `reviewed` is allowed because requests can be opened on reviewed attempts and an admin may also save a review while a request is open. |
| Expiry | No cron and no `expired` status value. A request is unexpired when `deadline is null or deadline > now()`, evaluated at check time (storage policy, fulfill RPC, student list, drawer). The drawer shows such requests as "Expired". Opening a new request for the same answer first closes a lapsed open one as `cancelled` with `cancel_reason = 'expired'`. |
| Deadline input | Optional `datetime-local` in the drawer, interpreted in the admin's local time zone, sent as ISO 8601; must be in the future (client and RPC). |
| Re-upload object name | `{school_id}/{attempt_id}/{question_id}_{request_id}_{uuid}.{ext}`. Same folder as normal uploads, so submission delete already finds it; the request id in the name is what the storage policy checks. |
| Attempt status after fulfillment | Unchanged. A `submitted`/`expired` attempt is already pending review (`final_score` is null because upload questions need manual review). A `reviewed` attempt stays `reviewed` with its scores (2.21, 3.20), and the drawer and submissions list show a derived "New image awaiting review" flag until the admin saves a review again (2.26). The flow never writes `LQ_attempts`. |
| Admin notification | `recipient_role = 'admin'`, `type = 'reupload_fulfilled'`, title "Re-uploaded image received", readable message in the same style as `submission_received`. Clicking it opens the submission instead of the students page. |
| Upload limits on re-upload | Same as normal uploads: `validateSubmissionImage` client-side plus the bucket's `file_size_limit` and `allowed_mime_types`. |

## Glossary

- **Bug_Condition (C)**: The input conditions under which current behavior is wrong: an identification answer matching a non-first/alternative key, an identification save with no usable key, any upload-question interaction (select, replace, remove, review, delete), or any attempt to recover the image for a legacy upload answer on a submitted/expired/reviewed attempt (request, discover, upload, review, cancel, delete).
- **Property (P)**: The desired behavior under C: any configured key grants full points in both grading paths; uploads land in the private bucket, are viewable by admins through signed URLs, and leave no orphaned objects; legacy answers can be re-uploaded once per admin request, by the owning student only, without any regrading.
- **Preservation**: Grading, scoring, review, MC/essay behavior, avatar storage, key confidentiality, attempt immutability for students, and admin-only notifications for every input outside C.
- **F / F'**: The original and fixed code paths.
- **`normalize(v)`**: `(v ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')`, currently duplicated in both edge functions. Moved unchanged to `supabase/functions/_shared/answerKeys.ts`.
- **`LQ_question_keys`**: Admin-only (RLS `lq_question_keys_admin_write`) table, one row per question. Today `answer_key text`; after the fix `answer_keys text[]`.
- **`submit-attempt`**: Edge function that grades a student's own in-progress attempt on submit.
- **`finalize-expired-attempts`**: Cron/service-role edge function that grades in-progress attempts past `expires_at`.
- **`LQ_delete_attempt(uuid)`**: Admin-only security-definer RPC that writes the `submission_deleted` audit row and deletes the attempt (answers and part scores cascade).
- **Object path**: Storage key inside `lq-submissions`, format `{school_id}/{attempt_id}/{question_id}_{uuid}.{ext}`. A flat attempt folder lets one `list()` call find every object for an attempt, including interrupted uploads.
- **Legacy file name**: A pre-fix `file_path` value with no `/` (just the picked file name). It never pointed at a stored object and cannot be recovered from the system; only the student can supply the image again, through an admin re-upload request. `isLegacyFileName(v) = v is non-empty AND v does not contain '/'`.
- **Attempt status**: `LQ_attempts.status IN ('in_progress', 'submitted', 'expired', 'reviewed', 'cancelled')`. `LQ_review_attempt` sets `reviewed` (and sets `reviewed_by`/`reviewed_at` on every answer of the attempt); cancelled attempts cannot be reviewed. The admin list maps `reviewed` or a non-null `final_score` to "graded", anything else submitted/expired to "needs review" (`mapSubmissionStatus` in `src/lib/submissions.ts`).
- **`LQ_reupload_requests`**: New table, one row per admin request to re-upload one legacy answer.
- **Open / unexpired request**: `status = 'open' AND (deadline IS NULL OR deadline > now())`. `effectiveReuploadStatus(r, now)` returns `'expired'` for an open request whose deadline has passed, otherwise `r.status`.
- **Re-upload object path**: `{school_id}/{attempt_id}/{question_id}_{request_id}_{uuid}.{ext}` with `ext IN (jpg, jpeg, png, webp)`.
- **`LQ_fulfill_reupload(request_id, path)`**: Student-callable security-definer RPC that links a re-uploaded object to the answer and closes the request.
- **New image awaiting review**: Derived flag (2.26), true when an answer's latest request is `fulfilled` and `answer.reviewed_at IS NULL OR answer.reviewed_at < request.fulfilled_at`. Cleared by the next `LQ_review_attempt` save.

## Bug Details

### Bug Condition

The identification part of the bug manifests when an answer equals (after normalization) a valid alternative that cannot be stored, or when an admin saves an identification question with no non-empty key. The grading code compares against a single `answer_key`, and `saveQuiz` writes `trim() || null` without validation.

The upload part manifests on every upload interaction. `QuestionInput` stores `file.name` instead of uploading, `saveAttemptAnswers` persists that name as `file_path`, the drawer renders it as text, and neither `removeSubmission` flows nor `deleteSubmission` touch storage.

The legacy-recovery part manifests for every legacy upload answer on a submitted, expired, or reviewed attempt. There is no request record, no admin action, no student-visible signal, and no write path: students cannot update `LQ_answers` outside `in_progress`, so even an object uploaded into their own folder could never be linked to the answer.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type
         GradeInput  { question, answerText, configuredKeys[] }       // grading
       | SaveInput   { question, keyFields[] }                        // builder save
       | UploadInput { action IN [select, replace, remove, review, delete], file?, attempt }
       | ReuploadInput { action IN [request, cancel, discover, open_page, upload, review, delete],
                         answer, question, attempt, request?, actor, file?, now }
  OUTPUT: boolean

  IF input IS GradeInput THEN
    RETURN input.question.type = 'identification'
           AND NOT input.question.requiresReview
           AND normalize(input.answerText) <> ''
           AND normalize(input.answerText) IN { normalize(k) | k IN input.configuredKeys }
           AND normalize(input.answerText) <> normalize(input.configuredKeys[0])   // only an alternative matches
  IF input IS SaveInput THEN
    RETURN input.question.type = 'identification'
           AND ( count(k IN input.keyFields WHERE trim(k) <> '') = 0
                 OR count(k IN input.keyFields WHERE trim(k) <> '') > 1           // cannot be stored today
                 OR EXISTS k IN input.keyFields WHERE trim(k) = ''
                 OR hasNormalizedDuplicate(input.keyFields) )
  IF input IS UploadInput THEN
    RETURN input.question.type = 'upload'      // every upload action is defective today
  IF input IS ReuploadInput THEN
    RETURN input.question.type = 'upload'
           AND isLegacyFileName(input.answer.file_path_at_request_time)
           AND input.attempt.status_at_request_time IN ['submitted', 'expired', 'reviewed']
           // no request/discover/upload/review path exists today for these answers
  RETURN false
END FUNCTION
```

Inputs outside this condition that the re-upload flow must still handle (by rejecting or ignoring them) are the preservation side: answers with real object paths, non-upload questions, `in_progress`/`cancelled` attempts at request time, other students' requests, and fulfilled/cancelled/expired requests.

### Examples

- Key "Central Processing Unit" plus alternative "CPU". Student answers "cpu". Today: only one key can be stored, so "cpu" scores 0 in both grading paths. Expected: correct, full points.
- Keys "Photosynthesis", "photo synthesis". Today the second cannot exist. After the fix the builder rejects nothing here (they normalize differently), and either answer scores full points.
- Admin adds keys "RAM" and " ram ". Expected: save blocked with "Answer keys 'RAM' and ' ram ' are duplicates." Today: impossible to express; the single field just saves.
- Admin saves an identification question with an empty key field. Today: saved with `answer_key = null`, nothing ever grades correct. Expected: save blocked with "Identification questions need at least one answer key."
- Student picks `diagram.png` (2 MB). Today: `file_path = 'diagram.png'`, nothing uploaded, drawer shows "diagram.png". Expected: object `S-1001/<attempt>/<question>_<uuid>.png` exists, `file_path` holds that path, drawer shows the image.
- Student picks `essay.pdf` or a 14 MB JPEG. Today: accepted. Expected: rejected before upload with a clear message, answer unchanged.
- Student replaces `a.png` with `b.png`. Expected: `a.png` object deleted, only `b.png` remains.
- Admin deletes a submission with two uploads. Today: both objects stay forever. Expected: both removed, audit log entry still written.
- Admin opens a pre-fix submission with `file_path = 'diagram.png'`. Today: "diagram.png" shown as if it were a file. Expected: "diagram.png" plus the notice "Image not available: this answer was submitted before image uploads were enabled, so only the file name was saved."; points/correctness controls still work.
- Student resumes an in-progress attempt saved before deploy with `file_path = 'diagram.png'`. Expected: the same notice in the question, and picking a real image replaces the bare name with an object path; no storage delete is attempted for `diagram.png`.
- Admin opens submitted attempt `A` (student `S-1001`) whose question 4 has `file_path = 'diagram.png'`. Today: notice only, nothing else possible. Expected: "Request re-upload" with an optional deadline; after confirming, the drawer shows "Re-upload requested, due Oct 30, 5:00 PM" and a Cancel button.
- `S-1001` signs in. Today: nothing tells them. Expected: dashboard and score history show "Re-upload image needed: Data Representation, question 4, due Oct 30, 5:00 PM" with "Re-upload image". The page shows the question 4 prompt and "Original file: diagram.png", no timer.
- `S-1001` picks a 3 MB PNG. Expected: object `S-1001/<A>/<q4>_<request>_<uuid>.png` is stored, `file_path` becomes that path, the request is `fulfilled`, the banner entry disappears, the student sees "Image received", and admins get "S-1001's name re-uploaded the image for question 4 of Data Representation." `is_correct`, `points_awarded`, `final_score`, and part scores are unchanged.
- `S-1001` tries again on the same request, or after the admin cancels it, or after the deadline. Expected: the page says the request is no longer open; a direct storage upload and a direct `LQ_fulfill_reupload` call are both rejected.
- `S-1002` calls `LQ_fulfill_reupload` with `S-1001`'s request id, or uploads into `S-1001/<A>/`. Expected: denied.
- Admin tries to request a re-upload for an answer with a real object path, an essay question, or an `in_progress` or `cancelled` attempt. Expected: no action shown; the RPC rejects.
- Admin opens attempt `B`, already `reviewed` with a final score, whose upload answer has `file_path = 'photo.jpg'`. Today: notice only. Expected: "Request re-upload" is offered; after the student fulfills, status stays `reviewed`, scores unchanged, drawer and list show "New image awaiting review" until the admin saves a review again (2.26).
- Admin opened a request, then saved a review (attempt now `reviewed`), then the student fulfilled. Expected: status stays `reviewed`, scores unchanged, drawer and list show "New image awaiting review" until the admin saves a review again (2.26).
- Admin deletes attempt `A` with an open and a fulfilled request. Expected: both request rows cascade away, the re-uploaded object is removed with the rest of the attempt folder, and the `submission_deleted` audit row is written.
- Edge: answer "  CPU  " with keys ["cpu"] (single key). Same as today: correct.
- Edge: blank identification answer. Same as today: incorrect, 0 points.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Single-key identification grading (including migrated keys) is identical in both grading paths (3.1).
- Normalization stays NFKC, trim, lowercase, collapse whitespace; the function body is moved, not modified (3.2).
- Blank identification answers stay incorrect with 0 points (3.3).
- Multiple-choice keeps one correct option: same builder UI, same `question.answer` field, same grading result. Stored as a one-element array (3.4).
- Essay and upload questions skip auto-grading, set manual review, and leave `final_score` null (3.5, 3.6). Upload grading logic is not touched; only the content of `file_path` changes from a name to a path.
- `requires_manual_review` routes to manual review before any key comparison (3.7).
- `auto_score`, part scores, `final_score`, status, `submission_reason`, `time_taken_seconds`, and the admin notification insert are computed by the same code (3.8).
- Review drawer points/correctness editing and `LQ_review_attempt` are unchanged (3.9).
- `lq-submissions` stays private; students still insert/read only within their school-ID folder; admins read and delete (3.10). New policies only narrow or add a tightly scoped student delete.
- Deleting a submission without uploads behaves exactly as before, including the `submission_deleted` audit row (3.11).
- `lq-avatars` policies and `src/lib/profile.ts` are not modified (3.12).
- `LQ_question_keys` RLS is not modified; students never query it, and edge functions read it with the service role (3.13).
- Adding or changing keys never regrades stored attempts. Grading only runs inside `submit-attempt` and `finalize-expired-attempts`, and both only act on `in_progress` attempts. `saveQuiz` writes only `LQ_question_keys` (and quiz/question rows), never `LQ_answers`, `LQ_attempts`, or part scores. New keys apply only to attempts graded after the change (3.14).
- The migration does not read, update, or delete `LQ_answers.file_path`; legacy bare names stay byte-for-byte (3.15). Past attempts are never regraded; the only later change to a legacy `file_path` is the student-fulfilled re-upload below.
- Deleting a legacy submission deletes rows and writes the audit entry as before; bare names are never passed to `storage.remove` (3.16).
- Students still cannot change any field of a submitted/expired/reviewed attempt or its answers. `lq_answers_student_update`, `lq_attempts_student_update`, `LQ_protect_student_attempt`, and `LQ_protect_student_answer` are not modified. The single exception is `LQ_answers.file_path` for the one answer named by an open, unexpired request, written only inside `LQ_fulfill_reupload` (3.17).
- Student storage writes stay inside `{own school_id}/`. For non-`in_progress` attempts, a write is admitted only when the object name embeds the id of the student's own open, unexpired request for that attempt and question (3.18).
- The student request list RPC returns quiz title, question number, prompt, original file name, and deadline only. No answer keys, options, points, `is_correct`, or feedback (3.19). `LQ_question_keys` stays admin-only.
- Opening, cancelling, expiring, and fulfilling a request write only `LQ_reupload_requests`, the one `file_path`, `LQ_notifications`, and `LQ_audit_logs`. They never write `is_correct`, `points_awarded`, `feedback`, `reviewed_*`, `LQ_attempts`, or `LQ_attempt_part_scores` (3.20). Grading changes only through `LQ_review_attempt`.
- Legacy answers without a fulfilled request keep the bare name and the 2.13 notice (3.21). Answers with real object paths render through signed URLs and never get the request action (3.22).
- `LQ_start_attempt`, `QuestionInput`, the timer, autosave, `submit-attempt`, and `finalize-expired-attempts` are not changed by this flow (3.23), and the `submission_received` notification inserts in both edge functions are untouched (3.24).
- `lq_notifications_recipient_read` and `loadAdminNotifications` still serve admins only; re-upload notifications use `recipient_role = 'admin'`, and no student notification UI is added (3.25).

**Scope:**
All inputs that do NOT involve identification key alternatives/validation or upload-question file handling are unaffected. This includes:
- MC questions in the builder and in both grading paths
- Essay answers and manual-review-flagged questions
- Identification questions with exactly one key
- Avatar upload/remove flows
- Submission review saves and deletes of attempts with no uploads
- Student quiz loading (keys remain invisible)
- Normal quiz-taking, submission, and expiry finalization
- Upload answers with real object paths, and all non-upload answers, in submitted/reviewed attempts
- Admin notifications of other types

## Hypothesized Root Cause

1. **Schema limited to one key**: `LQ_question_keys.answer_key` is `text` (migration `20261016120000_attempts_reporters_and_security.sql`). There is nowhere to store alternatives.

2. **Equality-only grading duplicated in two functions**: Both edge functions build `keyByQuestion: Map<string, string>` and compare `normalize(answer_text) === normalize(key)`. Each copy must change in lockstep; today they are independent copies of `normalize`.

3. **No builder validation for identification**: `AdminBuilderWorkspace.save` validates MC options and MC answer only. Identification renders one `<input>` bound to `question.answer`, and `saveQuiz` coerces blank to `null`.

4. **Upload UI writes a name, not a file**: `QuestionInput` (line ~628) calls `onChange(event.target.files?.[0]?.name ?? '')`. `saveAttemptAnswers` then stores that string in `file_path`. There is no storage client call, so bucket policies are never exercised.

5. **No validation path**: the `accept=".pdf,.jpg,.jpeg,.png"` attribute is the only check, and the bucket has no `file_size_limit` or `allowed_mime_types`.

6. **Review drawer renders text**: `mapAnswer` sets `answer: answer_text || file_path`, and the drawer prints `{answer.answer}`. No signed URL is ever created for `lq-submissions`.

7. **No storage cleanup anywhere**: The remove button clears state only. `deleteSubmission` only calls `LQ_delete_attempt`; Postgres cascades rows but cannot touch storage objects (direct `delete from storage.objects` is blocked on current Supabase, so cleanup must go through the Storage API). Students also have no delete policy on `lq-submissions`.

8. **No recovery model for legacy uploads**: There is no table to record a request, no admin RPC, and no student-visible list. The only write paths to `LQ_answers` for students require `attempt.status = 'in_progress'`, which is correct for normal answers and must stay, so recovery needs a separate, narrowly checked server-side write. Notifications cannot carry the request to students because `lq_notifications_recipient_read` only admits admins, and student quiz/question reads require a published quiz with an active assignment, so a student-facing list cannot rely on the existing table policies for archived quizzes or deactivated assignments.

## Correctness Properties

Property 1: Bug Condition - Any configured identification key is accepted and keys are validated

_For any_ identification question that does not require manual review, with a non-empty list of valid keys, and any non-blank student answer whose normalized form equals the normalized form of any key in that list, both `submit-attempt` and `finalize-expired-attempts` SHALL mark the answer correct and award the question's full points; _for any_ identification key list that is empty after trimming, contains a blank entry, or contains two entries with equal normalized forms, the builder and `saveQuiz` SHALL reject the save with a validation message; and _for any_ non-null legacy `answer_key`, the migration SHALL produce `answer_keys = ARRAY[answer_key]` byte-for-byte.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.12**

Property 2: Bug Condition - Image uploads are stored, validated, viewable, and cleaned up

_For any_ file selected for an upload question, the upload module SHALL accept it if and only if its MIME type is in {image/jpeg, image/png, image/webp}, its extension matches, and `0 < size <= 10 MB`; accepted files SHALL be stored in `lq-submissions` under `{school_id}/{attempt_id}/` with that path saved as `file_path`; rejected files SHALL leave the answer unchanged; replaced or removed files SHALL no longer exist in the bucket; the review drawer SHALL render a signed-URL image or a clear fallback; _for any_ legacy file name (non-empty, no `/`), the review drawer SHALL show the name with the notice "Image not available: this answer was submitted before image uploads were enabled, so only the file name was saved.", SHALL NOT request a signed URL, and SHALL keep the manual grading controls enabled; and deleting a submission SHALL remove every object under the attempt's folder.

**Validates: Requirements 2.7, 2.8, 2.9, 2.10, 2.11, 2.13**

Property 3: Preservation - Grading and non-identification behavior unchanged

_For any_ question/answer pair where the bug condition does NOT hold (single-key identification, multiple-choice, essay, upload, manual-review-flagged, or blank answers), the fixed grading SHALL produce the same `is_correct`, `points_awarded`, `auto_score`, part scores, `final_score`, status, and notification as the original, using the unchanged normalization; `matchesAnyKey(a, [k])` SHALL equal `normalize(a) === normalize(k)` for all strings `a`, `k`; and _for any_ already submitted, expired, or reviewed attempt, saving a quiz with added or changed keys SHALL leave that attempt's `is_correct`, `points_awarded`, `auto_score`, `final_score`, part scores, status, and review data unchanged.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.14**

Property 4: Preservation - Review, deletion, storage access, avatars, and key secrecy unchanged

_For any_ action outside upload handling (manual review saves, deleting attempts without uploads, avatar operations, student quiz loading), the fixed system SHALL behave as the original: same review RPC, same `submission_deleted` audit row, unchanged `lq-avatars` behavior, `lq-submissions` still private with students limited to their own school-ID folder, and `LQ_question_keys` still returning no rows to non-admins; _for any_ existing `LQ_answers.file_path`, the migration SHALL leave it unchanged; and _for any_ deleted submission, the paths passed to `storage.remove` SHALL contain no legacy file names (every path contains `/` and starts with `{school_id}/{attempt_id}/`).

**Validates: Requirements 3.9, 3.10, 3.11, 3.12, 3.13, 3.15, 3.16**

Property 5: Bug Condition - Admin-requested re-upload recovers legacy upload answers

_For any_ upload answer whose `file_path` is a legacy file name on a `submitted`, `expired`, or `reviewed` attempt, `LQ_request_reupload` called by an admin SHALL create exactly one `open` request for that answer (rejecting a second while one is open and unexpired); `canRequestReupload` SHALL be true exactly for such answers with no open, unexpired request, and `LQ_request_reupload` SHALL reject every other (answer, question, attempt) combination; _for any_ open, unexpired request, the owning student SHALL see exactly one banner entry for it (quiz title, question number, deadline or "No deadline") on the dashboard and score history, and the re-upload page SHALL show only that question's prompt and original file name, with no timer; _for any_ file, the page SHALL upload it only if `validateSubmissionImage(file).ok`; _for any_ valid file and open, unexpired request owned by the caller, uploading to `buildReuploadPath(...)` then calling `LQ_fulfill_reupload` SHALL set that answer's `file_path` to the path, set the request to `fulfilled` with `fulfilled_path = path`, insert one `reupload_fulfilled` admin notification naming the student, quiz, and question, and the drawer SHALL then show the image through a signed URL; _for any_ fulfilled request whose answer has `reviewed_at` null or earlier than `fulfilled_at`, `isAwaitingImageReview` SHALL be true and the drawer and submissions list SHALL show "New image awaiting review", and the next `LQ_review_attempt` save for that attempt SHALL make it false; _for any_ request that is fulfilled, cancelled, or past its deadline, or that belongs to another student, both the storage insert and `LQ_fulfill_reupload` SHALL be rejected and `LQ_reupload_requests` SHALL return no rows to that other student; _for any_ path that is not exactly `{attempt.school_id}/{attempt.id}/{question_id}_{request_id}_{uuid}.{jpg|jpeg|png|webp}` or names no existing object, `LQ_fulfill_reupload` SHALL reject; if fulfillment fails after the upload, the client SHALL remove the uploaded object; and deleting the submission SHALL remove all its requests and re-uploaded objects.

**Validates: Requirements 2.14, 2.15, 2.16, 2.17, 2.18, 2.19, 2.20, 2.21, 2.22, 2.23, 2.24, 2.25, 2.26**

Property 6: Preservation - Re-upload never regrades and never widens student access

_For any_ sequence of request, cancel, expiry, fulfill, and rejected fulfill operations on an attempt, every `LQ_answers` column other than the target answer's `file_path` (and its `updated_at`), every `LQ_attempts` column, and every `LQ_attempt_part_scores` row SHALL be identical before and after, including `is_correct`, `points_awarded`, `auto_score`, `final_score`, part scores, status (a `reviewed` attempt stays `reviewed`), and review data; _for any_ student and any submitted/expired/reviewed attempt, direct updates to answers or attempts SHALL still be rejected with or without an open request; _for any_ storage write by a student outside `{own school_id}/`, or into a non-`in_progress` attempt folder without a matching open, unexpired request of their own, the write SHALL be rejected; the student request list SHALL contain no answer keys, options, points, correctness, or feedback; legacy answers without a fulfilled request SHALL keep their bare name and the 2.13 notice; answers with real object paths SHALL never offer the request action; normal quiz start, timer, autosave, submission, expiry finalization, and their `submission_received` notifications SHALL behave exactly as without the flow; and `LQ_notifications` SHALL still return no rows to students.

**Validates: Requirements 3.17, 3.18, 3.19, 3.20, 3.21, 3.22, 3.23, 3.24, 3.25**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `supabase/migrations/20261017000000_multi_answer_keys_and_submission_uploads.sql` (new)

1. **Answer key array**:
   ```sql
   alter table public."LQ_question_keys" add column if not exists answer_keys text[];
   update public."LQ_question_keys"
      set answer_keys = array[answer_key]
    where answer_key is not null and answer_keys is null;   -- no trimming, no rewriting
   alter table public."LQ_question_keys" drop column if exists answer_key;
   alter table public."LQ_question_keys"
     add constraint lq_question_keys_answer_keys_check
     check (answer_keys is null or (cardinality(answer_keys) >= 1
            and array_position(answer_keys, null) is null))
     not valid;   -- new writes are checked; legacy rows are not rewritten
   ```
   The migration contains no statement touching `LQ_answers` (no update/delete of `file_path`, no constraint on it), so legacy bare names survive unchanged (3.15).
   Blank-element and normalized-duplicate rules live in the shared validator (client + `saveQuiz`), because Postgres `\s` and JS `\s` differ slightly and duplicating normalization in SQL would risk divergence. RLS on `LQ_question_keys` is untouched.

2. **Bucket limits**:
   ```sql
   update storage.buckets
      set file_size_limit = 10485760,
          allowed_mime_types = array['image/jpeg','image/png','image/webp']
    where id = 'lq-submissions';
   ```

3. **Tighter student insert policy** (replaces `lq_submission_student_upload`): still requires `foldername[1] = LQ_my_school_id()`, and additionally `foldername[2]` must be the id of an `LQ_attempts` row with `auth_user_id = auth.uid()`, `status = 'in_progress'`, matching `school_id`, and `not LQ_is_quiz_reporter(quiz_id)`. Admin/student read policy and admin delete policy are unchanged.

4. **New narrowly scoped student delete policy** `lq_submission_student_delete_superseded`:
   ```sql
   for delete to authenticated using (
     bucket_id = 'lq-submissions'
     and public."LQ_workspace_ready"()
     and (storage.foldername(name))[1] = public."LQ_my_school_id"()
     and exists (select 1 from public."LQ_attempts" a
                  where a.id::text = (storage.foldername(name))[2]
                    and a.auth_user_id = auth.uid()
                    and a.status = 'in_progress')
     and not exists (select 1 from public."LQ_answers" ans
                      where ans.file_path = storage.objects.name)
   )
   ```
   Students can only delete their own unreferenced objects while the attempt is open. Once submitted or expired, nothing can be deleted by students, and a currently saved answer file can never be deleted out from under the answer row. This is safe enough to prefer over a server-side cleanup function; if review finds a gap, fall back to a `cleanup-submission-upload` edge function with the service role.

**File**: `supabase/functions/_shared/answerKeys.ts` (new, no imports, usable by Deno and Vite)

- `normalize(value)`: body moved verbatim from the edge functions.
- `toKeyList(row: { answer_keys?: string[] | null } | undefined): string[]`: `row?.answer_keys ?? []`.
- `matchesAnyKey(answer, keys)`: `const n = normalize(answer); return keys.some((k) => normalize(k) === n)`.
- `validateAnswerKeys(fields: string[]): { ok: true; keys: string[] } | { ok: false; message: string }`: trims each field; fails on zero fields, any blank field, or two fields with equal `normalize`; returns trimmed keys in admin order.

**Files**: `supabase/functions/submit-attempt/index.ts`, `supabase/functions/finalize-expired-attempts/index.ts`

1. Import `matchesAnyKey` and `toKeyList` from `../_shared/answerKeys.ts`; delete the local `normalize` copy.
2. Select `question_id, answer_keys` instead of `answer_key`; build `keysByQuestion: Map<string, string[]>` via `toKeyList`.
3. Replace the comparison with `const correct = hasResponse && matchesAnyKey(answer?.answer_text, keysByQuestion.get(question.id) ?? [])`.
4. Nothing else in either function changes (manual-review branch, part stats, score math, updates, notifications).
5. These two functions remain the only grading paths, and both keep their existing `status = 'in_progress'` guard. No trigger, RPC, or `saveQuiz` step regrades stored attempts when keys change (3.14).

Note: a question with no keys now never matches. Previously a whitespace-only answer against a `null` key compared `'' === ''` and was graded correct; that quirk is part of bug 1.5 and is intentionally removed.

**File**: `src/types.ts`

- `Question`: add `answers?: string[]` (identification keys). `answer?: string` stays for MC.
- `SubmissionAnswer`: replace `correctAnswer: string` with `correctAnswers: string[]`; add `filePath?: string | null`.

**File**: `src/lib/workspace.ts`

- `loadAdminQuizzes`: select `question_id, answer_keys`; `mapAdminQuestion(row, keys)` sets `answer = keys[0]` and, for identification, `answers = keys`. Student loaders are untouched and still set `answer: undefined`.

**File**: `src/lib/admin.ts` (`saveQuiz`)

- Before any write, validate every identification question with `validateAnswerKeys(identificationKeyFields(question))` and return `{ id: null, error }` on failure (defense in depth behind the builder check).
- Key upsert payload becomes `{ question_id, answer_keys }` where identification → validated keys; MC → `[answer.trim()]` (MC validation already requires a non-empty answer); essay/upload → `answer?.trim() ? [answer.trim()] : null`.
- `identificationKeyFields(question)` = `question.answers ?? (question.answer ? [question.answer] : [''])`, which also covers PDF-imported questions that only set `answer`.

**File**: `src/App.tsx`

1. **`BuilderQuestion`**: for identification, replace the single input with a labelled list ("Accepted answers") of inputs bound to `answers`, each with a remove button (`aria-label="Remove answer key N"`, disabled when only one remains) and an "Add answer key" button. Switching type to identification seeds `answers` from `identificationKeyFields`. MC markup is unchanged.
2. **`AdminBuilderWorkspace.save`**: add an identification check using `validateAnswerKeys`, showing a warning toast with the validator's message (e.g. "Part 1, question 3: identification questions need at least one answer key.").
3. **`QuestionInput`**: add an `upload` prop `{ attemptId, schoolId, onError, onBusyChange }`. Upload questions render the new picker copy/`accept`, call `uploadSubmissionImage`, show "Uploading…" while busy, display the original file name (or the path's basename after reload), and the remove button calls `removeSubmissionImage`. The picker is disabled until `attemptId` exists. Validation errors show inline (`role="alert"`) and via toast; the answer value is left unchanged. If the current value is a legacy file name (in-progress attempt saved before deploy), the question shows the legacy notice and the picker stays enabled; a newly picked image is uploaded and replaces the bare name in `file_path`, and the bare name is never sent to `storage.remove`. Removing a legacy value just clears `file_path`.
4. **`StudentQuiz` / `LegacyStudentQuiz`**: pass the `upload` prop; track in-flight uploads and block manual submit/exit with a toast while one is running (timeout auto-submit proceeds as today).
5. **`SubmissionReviewDrawer`**: identification shows "Accepted answers" as a list of all keys; other types keep "Correct answer" with `correctAnswers[0]`. Upload answers render a new `SubmissionImage` component: legacy names (`isLegacyFileName`) show the file name plus a notice (`role="note"`): "Image not available: this answer was submitted before image uploads were enabled, so only the file name was saved." No signed URL is requested, and the points/correctness controls for that answer stay enabled so it can be graded manually (2.13). Otherwise it requests `signedSubmissionUrl(path)`, renders `<img alt="Student upload for question N">` plus an "Open full size" link, and on error/missing object shows "Image unavailable" with the path.
6. **Delete flow**: `remove()` surfaces the warning from `deleteSubmission` when storage cleanup partially fails.

**File**: `src/lib/submissionUploads.ts` (new)

- Constants: `SUBMISSION_BUCKET = 'lq-submissions'`, `MAX_SUBMISSION_BYTES = 10 * 1024 * 1024`, `ALLOWED_SUBMISSION_TYPES = { 'image/jpeg': ['jpg','jpeg'], 'image/png': ['png'], 'image/webp': ['webp'] }`.
- `validateSubmissionImage(file): { ok: true; ext } | { ok: false; message }` (pure).
- `buildSubmissionPath(schoolId, attemptId, questionId, ext)` → `${schoolId}/${attemptId}/${questionId}_${crypto.randomUUID()}.${ext}`.
- `uploadSubmissionImage({ attemptId, schoolId, questionId, file, previousPath })`: validate → `storage.upload(path, file, { contentType: file.type, upsert: false })` → upsert that single `LQ_answers` row with `file_path = path` → on row failure remove the new object and return the error → on success, if `previousPath` is a real object path (not `isLegacyFileName`), `storage.remove([previousPath])` (best effort, mirrors `uploadAvatar`).
- `removeSubmissionImage({ attemptId, questionId, path })`: update the answer row's `file_path` to `null`, then remove the object unless `path` is a legacy file name.
- `isLegacyFileName(value)`: exported pure helper used by the picker, drawer, and delete flow.
- `signedSubmissionUrl(path)`: `createSignedUrl(path, 300)`; returns `{ url: null, error }` for legacy names without calling storage.
- `listAttemptObjectPaths(schoolId, attemptId)`: `storage.list(`${schoolId}/${attemptId}`, { limit: 1000 })` mapped to full paths.

**File**: `src/lib/attempts.ts`

- `saveAttemptAnswers` keeps writing `file_path` from answer state; state now contains the object path, so autosave stays consistent with the immediate upsert done by the upload module.

**File**: `src/lib/submissions.ts`

- Select `answer_keys`; `mapAnswer` sets `correctAnswers = keys`, `filePath = answer?.file_path ?? null`. `answer` display text for uploads becomes the path basename.
- `deleteSubmission(submissionId)` becomes `deleteSubmission(submission: { id, schoolId })`: collect paths = referenced `file_path` values for the attempt (bare names without `/` dropped first, then filtered to `${schoolId}/${id}/` prefix) ∪ `listAttemptObjectPaths`; call `LQ_delete_attempt`; if it fails, return the error and touch nothing; otherwise `storage.remove(paths)` when non-empty and return `{ error: null, warning? }`. Attempts without uploads, and legacy attempts whose only uploads are bare names, make no `storage.remove` call (3.16).

**File**: `package.json`

- Add pinned dev dependencies `vitest` and `fast-check`, and a `"test": "vitest run"` script. Vitest config includes `tests/**/*.test.ts`; the end-to-end suite is skipped unless `LATEQUIZ_E2E_SUPABASE_URL`, `LATEQUIZ_E2E_ANON_KEY`, and `LATEQUIZ_E2E_SERVICE_ROLE_KEY` are set.

### Legacy upload re-upload flow (2.14–2.25, 3.17–3.25)

**File**: `supabase/migrations/20261017010000_legacy_upload_reupload_requests.sql` (new, runs after the migration above, additive only)

1. **Table**:
   ```sql
   create table if not exists public."LQ_reupload_requests" (
     id uuid primary key default gen_random_uuid(),
     attempt_id uuid not null references public."LQ_attempts"(id) on delete cascade,
     question_id uuid not null references public."LQ_questions"(id) on delete cascade,
     answer_id uuid not null references public."LQ_answers"(id) on delete cascade,
     original_file_name text not null,           -- bare name at request time, kept after fulfillment
     requested_by uuid references auth.users(id) on delete set null,
     requested_at timestamptz not null default now(),
     deadline timestamptz,                       -- null = no deadline
     status text not null default 'open' check (status in ('open', 'fulfilled', 'cancelled')),
     fulfilled_at timestamptz,
     fulfilled_path text,
     cancelled_at timestamptz,
     cancelled_by uuid references auth.users(id) on delete set null,
     cancel_reason text check (cancel_reason in ('admin', 'expired')),
     constraint lq_reupload_state_check check (
       (status = 'open'      and fulfilled_at is null and fulfilled_path is null and cancelled_at is null)
       or (status = 'fulfilled' and fulfilled_at is not null and fulfilled_path is not null and cancelled_at is null)
       or (status = 'cancelled' and cancelled_at is not null and cancel_reason is not null and fulfilled_path is null)
     )
   );
   create unique index if not exists lq_reupload_one_open_per_answer
     on public."LQ_reupload_requests" (answer_id) where status = 'open';
   create index if not exists lq_reupload_attempt_idx
     on public."LQ_reupload_requests" (attempt_id, status);
   ```
   Deleting an attempt cascades to `LQ_answers` and `LQ_reupload_requests` (both FKs cascade), so `LQ_delete_attempt` needs no change (2.25, 3.11).

2. **RLS** (no student insert/update/delete policy exists, so those are denied):
   ```sql
   alter table public."LQ_reupload_requests" enable row level security;
   create policy lq_reupload_admin_all on public."LQ_reupload_requests"
     for all to authenticated
     using (public."LQ_is_admin"()) with check (public."LQ_is_admin"());
   create policy lq_reupload_student_read on public."LQ_reupload_requests"
     for select to authenticated
     using (public."LQ_workspace_ready"() and exists (
       select 1 from public."LQ_attempts" a
        where a.id = attempt_id and a.auth_user_id = auth.uid()
          and a.school_id = public."LQ_my_school_id"()));
   ```
   The admin policy matches the requested "admin full" access; the admin UI still writes only through the RPCs so every change gets an audit row.

3. **`LQ_request_reupload(p_answer_id uuid, p_deadline timestamptz default null) returns jsonb`** (security definer, `set search_path = public`):
   - `if not LQ_is_admin() then raise exception 'Only administrators can request re-uploads'`.
   - `select … for update` the answer joined to its attempt and question. Reject with distinct messages when: answer not found; `question_type <> 'upload'`; `attempt.status not in ('submitted','expired','reviewed')` (so `in_progress` and `cancelled` are rejected); `file_path` is null, blank, or contains `/` (not a legacy name); `p_deadline is not null and p_deadline <= now()`.
   - If an `open` request exists for the answer: when unexpired, raise 'A re-upload request is already open for this answer'; when lapsed, update it to `cancelled`, `cancelled_at = now()`, `cancelled_by = actor`, `cancel_reason = 'expired'`. The partial unique index is the backstop for races.
   - Insert the request with `original_file_name = answer.file_path`, `requested_by = auth.uid()`.
   - Audit: `insert into LQ_audit_logs (actor_id, event_type, entity_type, entity_id, metadata) values (actor, 'reupload_requested', 'attempt', attempt.id, jsonb_build_object('request_id', …, 'answer_id', …, 'question_id', …, 'school_id', attempt.school_id, 'deadline', p_deadline))`, same shape as `submission_reviewed`.
   - Returns the request row as JSON.

4. **`LQ_cancel_reupload(p_request_id uuid) returns jsonb`** (security definer): admin check; lock the request; reject unless `status = 'open'` (open-but-lapsed may be cancelled); set `cancelled`, `cancelled_at`, `cancelled_by`, `cancel_reason = 'admin'`; audit `reupload_cancelled` with the same metadata keys.

5. **Storage helpers** (security definer, stable, so policies need not join tables through the caller's RLS):
   ```sql
   -- true only for {own school}/{own attempt}/{question_id}_{request_id}_<anything>
   -- where the request is open and unexpired
   create or replace function public."LQ_can_upload_reupload_object"(p_name text) returns boolean
   language sql stable security definer set search_path = public as $$
     select public."LQ_workspace_ready"()
       and cardinality(storage.foldername(p_name)) = 2
       and exists (
         select 1
           from public."LQ_reupload_requests" r
           join public."LQ_attempts" a on a.id = r.attempt_id
          where a.auth_user_id = auth.uid()
            and a.school_id = public."LQ_my_school_id"()
            and a.status in ('submitted', 'expired', 'reviewed')
            and r.status = 'open'
            and (r.deadline is null or r.deadline > now())
            and (storage.foldername(p_name))[1] = a.school_id
            and (storage.foldername(p_name))[2] = a.id::text
            and starts_with(storage.filename(p_name), r.question_id::text || '_' || r.id::text || '_'));
   $$;

   -- cleanup of a failed fulfillment: own re-upload object, request not fulfilled,
   -- and the object is not referenced by any answer
   create or replace function public."LQ_can_discard_reupload_object"(p_name text) returns boolean
   language sql stable security definer set search_path = public as $$ … same ownership/name match,
     r.status <> 'fulfilled',
     and not exists (select 1 from public."LQ_answers" ans where ans.file_path = p_name) $$;
   ```
   Policies:
   ```sql
   create policy lq_submission_student_reupload on storage.objects
     for insert to authenticated
     with check (bucket_id = 'lq-submissions' and public."LQ_can_upload_reupload_object"(name));
   create policy lq_submission_student_discard_reupload on storage.objects
     for delete to authenticated
     using (bucket_id = 'lq-submissions' and public."LQ_can_discard_reupload_object"(name));
   ```
   Both are additional permissive policies. The tightened `in_progress` insert policy, the read policy, the admin delete policy, and the superseded-file delete policy are unchanged, so writes outside the student's folder or into a closed attempt without a matching request stay blocked (3.18). Bucket size and MIME limits still apply.

6. **`LQ_fulfill_reupload(p_request_id uuid, p_path text) returns jsonb`** (security definer):
   - `actor := auth.uid()`; require `LQ_workspace_ready()` and a student profile.
   - `select … for update` the request and its attempt. Reject with 'This re-upload request is no longer open' unless the request exists, `a.auth_user_id = actor`, `a.school_id = LQ_my_school_id()`, `r.status = 'open'`, and `r.deadline is null or r.deadline > now()`. A non-owner gets the same message, so request ids cannot be probed (2.24). Reject if `a.status not in ('submitted','expired','reviewed')`.
   - Path check: with `prefix := a.school_id || '/' || a.id || '/' || r.question_id || '_' || r.id || '_'`, require `starts_with(p_path, prefix) and substr(p_path, length(prefix) + 1) ~ '^[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'`. Literal prefix comparison avoids regex-escaping `school_id`, and the suffix pattern excludes `..`, extra segments, and other requests' names.
   - Object check: `exists (select 1 from storage.objects o where o.bucket_id = 'lq-submissions' and o.name = p_path and o.owner_id = actor::text and o.metadata->>'mimetype' in ('image/jpeg','image/png','image/webp') and (o.metadata->>'size')::bigint between 1 and 10485760)`. Reading `storage.objects` from a security-definer function is fine; only direct deletes are blocked. (`owner_id text` is the current Storage column; on an older local stack use `owner = actor`.)
   - Lock the answer `r.answer_id`; reject unless it still belongs to `r.attempt_id`/`r.question_id` and its `file_path` is still a legacy name (guards double fulfillment).
   - `update LQ_answers set file_path = p_path where id = r.answer_id`. `LQ_protect_student_answer` still runs and would reject any grading-field change, which is a second guard on 3.20.
   - `update LQ_reupload_requests set status = 'fulfilled', fulfilled_at = now(), fulfilled_path = p_path where id = r.id`.
   - Admin notification, same style as `submission_received`:
     ```sql
     insert into public."LQ_notifications" (recipient_role, type, title, message, metadata)
     values ('admin', 'reupload_fulfilled', 'Re-uploaded image received',
       format('%s re-uploaded the image for question %s of %s.', <roster name or school_id>, <question number>, quiz.title),
       jsonb_build_object('school_id', a.school_id, 'quiz_id', a.quiz_id::text, 'attempt_id', a.id::text,
                          'question_id', r.question_id::text, 'request_id', r.id::text));
     ```
     Question number is `row_number() over (order by position)` within the quiz, matching the drawer and the student list.
   - Audit `reupload_fulfilled` with `actor_id = actor` (the student), `entity_type = 'attempt'`, metadata `request_id`, `answer_id`, `question_id`, `path`.
   - Returns `{ status: 'fulfilled', file_path }`. The function contains no statement on `LQ_attempts` or `LQ_attempt_part_scores` and does not set `is_correct`, `points_awarded`, `feedback`, or `reviewed_*` (3.17, 3.20).

7. **`LQ_my_reupload_requests() returns table (...)`** (security definer, stable): rows for `auth.uid()`'s attempts only, `status = 'open'` and unexpired, with `request_id, attempt_id, quiz_id, quiz_title, question_id, question_number, prompt, original_file_name, deadline, requested_at`. It reads quizzes/questions as definer, so it works for archived quizzes or deactivated assignments without widening `lq_quizzes_student_read` or `lq_questions_assigned_read`. It returns no keys, options, points, correctness, or feedback (3.19).

8. **Grants**: `revoke all on function … from public, anon;` then `grant execute … to authenticated` for all five functions (role checks happen inside).

**File**: `src/lib/reuploads.ts` (new)

- Pure helpers: `isRequestOpen(r, now)`, `effectiveReuploadStatus(r, now)`, `canRequestReupload({ questionType, filePath, attemptStatus, requests, now })` (mirrors the RPC checks: upload question, legacy `filePath`, `attemptStatus` in `submitted`/`expired`/`reviewed`, no open unexpired request), `buildReuploadPath(schoolId, attemptId, questionId, requestId, ext)`, `isValidReuploadPath(path, ctx)` (same rule as the SQL regex), `isAwaitingImageReview(answer, latestRequest)`.
- `loadMyReuploadRequests()` → `rpc('LQ_my_reupload_requests')`.
- `submitReupload({ request, schoolId, file })`: `validateSubmissionImage` (reject with the same messages, nothing uploaded, 2.18) → `isRequestOpen` → `storage.upload(path, file, { contentType: file.type, upsert: false })` → `rpc('LQ_fulfill_reupload', { p_request_id, p_path })` → on RPC error, `storage.remove([path])` best effort (allowed by the discard policy) and return the error. A storage RLS denial maps to "This re-upload request is no longer open."
- Admin: `requestReupload(answerId, deadline | null)`, `cancelReupload(requestId)` (after success, best-effort `storage.list` of the attempt folder filtered by prefix `{question_id}_{request_id}_` and `storage.remove` of any orphans), `loadReuploadRequests(attemptIds)`.

**File**: `src/types.ts`

- `StudentView` adds `'reupload'`.
- `ReuploadRequest { id, attemptId, quizId, quizTitle, questionId, questionNumber, prompt, originalFileName, deadline: string | null, requestedAt }`.
- `SubmissionAnswer` adds `answerId?: string` and `reupload?: { id, status: 'open' | 'expired' | 'fulfilled' | 'cancelled', deadline, requestedAt, fulfilledAt, originalFileName, awaitingReview }` (latest request for the answer). `Submission` adds `attemptStatus` (raw) and `hasImageAwaitingReview: boolean`.

**File**: `src/lib/workspace.ts`

- `loadStudentWorkspace` also returns `reuploadRequests` from `loadMyReuploadRequests()`; a failure there logs and returns `[]` rather than breaking the dashboard.
- `loadAdminNotifications` is unchanged (it already filters `recipient_role = 'admin'`).

**File**: `src/lib/submissions.ts`

- `loadAdminSubmissions` also loads `LQ_reupload_requests` for the listed attempts, attaches the latest request per answer, computes `awaitingReview` and `hasImageAwaitingReview`. `mapSubmissionStatus` is unchanged.
- `deleteSubmission` is unchanged in behavior: re-uploaded objects already sit under `{school_id}/{attempt_id}/`, so `listAttemptObjectPaths` finds them, and `fulfilled_path` values are real paths that pass the prefix filter.

**File**: `src/App.tsx`

1. **Student state**: `App` keeps `reuploadRequests` from the workspace load and `selectedReuploadId`; `StudentApp` gets `reuploadRequests` and `onOpenReupload(request)`, which sets the id and navigates to `'reupload'`. Title "Re-upload image", eyebrow "Missing image".
2. **`ReuploadRequestsBanner`** on `StudentDashboard` and `StudentScoresPage` (above existing content; hidden when empty): `<section aria-labelledby>` heading "Image re-upload needed", one row per request with quiz title, "Question N", "Due {local date/time}" or "No deadline", and a "Re-upload image" button (2.16).
3. **`StudentReuploadPage`**: loads the request from `reuploadRequests` by id (if missing or no longer open, shows "This re-upload request is no longer open." with a back button). Shows quiz title, "Question N", the prompt, "Original file: {name}", the deadline, and one file picker with the normal upload copy and `accept`. No timer, no navigation to other questions, and no other answers (2.17). Validation errors render inline with `role="alert"` (2.18). While sending, the button reads "Uploading…" and is disabled. On success it shows a confirmation panel ("Image received. Your teacher will review it.", `role="status"`), refreshes the workspace so the banner entry disappears (2.19), and offers "Back to dashboard".
4. **`SubmissionReviewDrawer`** upload answers:
   - Legacy name and `canRequestReupload` true: the 2.13 notice plus "Request re-upload", which reveals an optional "Deadline" `datetime-local` and a confirm button; after success the drawer re-renders from `onSaved` (2.14).
   - Open request: "Re-upload requested {date}" and "Due {date}" / "No deadline", plus "Cancel request" behind a `ConfirmModal` (2.15). Lapsed open request: "Re-upload request expired {date}" and "Request re-upload" again.
   - Fulfilled: `SubmissionImage` already renders the signed URL because `file_path` is now a real path (2.21, with the 2.9 fallback); add "Re-uploaded {date} (original file: {name})", and when `awaitingReview` a "New image awaiting review" badge (2.26). Points and correctness controls are the existing ones; saving calls `LQ_review_attempt`, which sets `reviewed_at` on the answer and clears the flag.
   - Real object path with no request: unchanged, no request action (3.22). Cancelled history is shown as one muted line.
5. **Submissions list**: a "New image" badge on rows where `hasImageAwaitingReview` is true (2.26). The "needs review"/"graded" categories still come from `mapSubmissionStatus`; a fulfilled request on a `submitted`/`expired` attempt is already "needs review".
6. **`AdminApp.handleNotification`**: for `type === 'reupload_fulfilled'`, mark read and navigate to `'submissions'` with the drawer focused on `metadata.attempt_id`; every other type keeps today's behavior (3.24).

**Review status decision (2.21, 2.26)**: the flow never changes `LQ_attempts.status` or scores. A `submitted`/`expired` attempt is still pending review when the image arrives. A `reviewed` attempt (reviewed before the request was opened, or while it was open) stays `reviewed` with its current scores, and the derived "New image awaiting review" flag (drawer and list) tells the admin to re-grade; the next `LQ_review_attempt` save clears it. We rejected flipping the status back to `submitted` because it would discard a saved final score without an admin action, which conflicts with 3.20.

**Accepted residual risk**: while a request is open the student can upload several objects under its prefix (each up to 10 MB). Only the one passed to a successful `LQ_fulfill_reupload` is linked; the client removes failed ones, admin cancel cleans the prefix, and submission delete removes the whole folder.

## Testing Strategy

### Validation Approach

First surface counterexamples on the unfixed code to confirm the root causes, then verify the fix (Properties 1, 2, and 5) and preservation (Properties 3, 4, and 6). Pure logic is covered by unit and property-based tests; storage, RLS, the re-upload RPCs, and both edge functions are covered by an end-to-end test against a local or staging Supabase project. `npm run build` must pass.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Extract the current comparison (`normalize(a) === normalize(k)` against a single key) into the test as `originalGrade`, and drive the current `QuestionInput`/`saveAttemptAnswers`/`deleteSubmission` behavior against a Supabase test project. Run on the UNFIXED code.

**Test Cases**:
1. **Alternative key**: question with intended keys ["Central Processing Unit", "CPU"], answer "cpu"; unfixed code can only hold the first key and grades 0 (will fail).
2. **Expired path alternative**: same data, attempt `expires_at` in the past, invoke `finalize-expired-attempts`; grades 0 (will fail).
3. **Blank key save**: `saveQuiz` with an identification question whose answer is "  "; succeeds and stores `null` (will fail the expectation of rejection).
4. **Upload stores name only**: select `diagram.png`; `LQ_answers.file_path = 'diagram.png'` and `storage.list('<school>/<attempt>')` is empty (will fail).
5. **No validation**: select a 14 MB JPEG and a PDF; both accepted (will fail).
6. **Delete leaves objects**: seed an object under the attempt folder via service role, delete the submission; object still present (will fail).
7. **No re-upload request path**: seed a submitted attempt with `file_path = 'diagram.png'`; as admin, `rpc('LQ_request_reupload')` does not exist and the drawer offers no action (will fail).
8. **Student cannot provide the image**: as the owning student, upload a PNG into `{school}/{attempt}/` (the original insert policy allows it), then try to set `LQ_answers.file_path` to it; RLS rejects the update because the attempt is not `in_progress`, so the object can never be linked (will fail the expectation of 2.19).
9. **No student signal**: the student dashboard and scores page render nothing for the legacy answer, and `LQ_notifications` returns zero rows to the student (will fail 2.16).

**Expected Counterexamples**:
- `originalGrade('cpu', 'Central Processing Unit') === false`
- `file_path` without `/` and no stored object; no signed URL possible
- Legacy answer stays a bare name after any student action on a submitted attempt; an uploaded object in the student's folder is unreachable from the answer
- Possible causes confirmed: single-text schema, equality-only grading, name-only upload handler, missing storage calls, no request model or server-side write path for closed attempts

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL (keys, i, variant) WHERE validateAnswerKeys(keys).ok AND 0 <= i < len(keys) DO
  answer := variant(keys[i])                     // random case, padding, internal whitespace, NFKC-equivalent forms
  ASSERT matchesAnyKey(answer, keys) = true
  ASSERT grade_fixed(identificationQuestion(keys), answer) = { is_correct: true, points_awarded: points }
END FOR

FOR ALL fields WHERE emptyAfterTrim(fields) OR hasBlank(fields) OR hasNormalizedDuplicate(fields) DO
  ASSERT validateAnswerKeys(fields).ok = false
END FOR

FOR ALL file DO
  ASSERT validateSubmissionImage(file).ok
         = (file.type IN ALLOWED AND extMatches(file) AND 0 < file.size <= 10 MB)
END FOR

FOR ALL (question, attempt, answer) WHERE isBugCondition(ReuploadInput) AND no open unexpired request DO
  req := LQ_request_reupload(answer.id, deadline)              // admin
  ASSERT req.status = 'open' AND isRequestOpen(req, now)
  ASSERT req IN LQ_my_reupload_requests()                       // owning student only
  path := buildReuploadPath(school, attempt.id, question.id, req.id, ext)
  upload(path, validFile); LQ_fulfill_reupload(req.id, path)    // owning student
  ASSERT answer.file_path = path AND req.status = 'fulfilled' AND req.fulfilled_path = path
  ASSERT exactly one new LQ_notifications row (recipient_role 'admin', type 'reupload_fulfilled')
  ASSERT any further upload/fulfill against req is rejected
END FOR

FOR ALL (status, deadline, now) DO
  ASSERT uploadAllowed(status, deadline, now) = (status = 'open' AND (deadline IS NULL OR deadline > now))
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL (answer, key) : strings DO
  ASSERT matchesAnyKey(answer, [key]) = (normalize(answer) = normalize(key))
END FOR

FOR ALL attempt WHERE every identification question has exactly one key DO
  ASSERT grade_original(attempt) = grade_fixed(attempt)   // per-answer results, auto_score, part scores, final_score
END FOR

FOR ALL ops : sequence of {request, cancel, lapse, fulfill(valid|invalid path|other student|closed)} DO
  before := snapshot(LQ_answers minus target.file_path/updated_at, LQ_attempts, LQ_attempt_part_scores)
  apply(ops)
  ASSERT snapshot(...) = before
END FOR

FOR ALL (questionType, filePath, attemptStatus, requests) WHERE NOT isBugCondition(ReuploadInput) DO
  ASSERT canRequestReupload(...) = false AND LQ_request_reupload rejects
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss (Unicode compatibility forms, mixed whitespace, empty strings)
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first (single-key identification, MC, essay, upload manual-review routing, avatar upload, delete without uploads, student key access), then write tests capturing that behavior.

**Test Cases**:
1. **Single-key equivalence**: fast-check over arbitrary Unicode strings: `matchesAnyKey(a, [k]) === (normalize(a) === normalize(k))`.
2. **Grading loop equivalence**: a test-local copy of the original loop vs the fixed loop over generated quizzes (MC, single-key identification, essay, upload, manual-review flags, blank answers); identical outputs.
3. **Migration backfill**: for generated `answer_key` values (including padded, mixed case, Unicode), the backfill yields `array[answer_key]` unchanged (e2e against a scratch database, or SQL run in the local stack).
4. **Key secrecy**: as a student, `select * from "LQ_question_keys"` returns zero rows before and after.
5. **Avatar and non-upload delete**: avatar upload/remove still works; deleting an attempt without uploads writes one `submission_deleted` row and makes no storage removals.
6. **No regrade on key change (3.14)**: submit and review an attempt keyed ["Central Processing Unit"] with answer "cpu" (graded 0), snapshot `LQ_answers`, `LQ_attempts`, and part-score rows, then save the quiz with keys ["Central Processing Unit", "CPU"]; all snapshotted values are identical afterward. A new attempt answering "cpu" then scores full points.
7. **Migration leaves legacy `file_path` (3.15)**: seed `LQ_answers` rows with bare names (`'diagram.png'`, `'my photo (1).JPG'`, Unicode names) before the migration; after it runs, every `file_path` is byte-for-byte equal and the row count is unchanged.
8. **Legacy delete skips bare names (3.16)**: delete a seeded legacy submission whose uploads are bare names with a mocked storage client; assert `storage.remove` is never called with a path lacking `/`, rows and the `submission_deleted` audit row behave as before. Mixed case: a real object path plus a bare name; only the real path is removed.
9. **Closed attempts stay closed (3.17)**: with and without an open request, the student's direct `update` on `LQ_answers` (any column, including `file_path`) and on `LQ_attempts` for a submitted attempt is rejected, as on unfixed code.
10. **Storage boundaries (3.18)**: as a student, uploads into another school's folder, into an own submitted attempt folder with a normal `{question}_{uuid}` name, and with another student's request id are rejected; normal uploads into an own `in_progress` attempt still succeed.
11. **No secrets in the student list (3.19)**: `LQ_my_reupload_requests()` result columns are exactly the documented set; `LQ_question_keys` still returns zero rows to the student.
12. **No regrade across the lifecycle (3.20)**: snapshot answers, attempt, and part scores; run request → cancel → request → lapse → request → fulfill (and rejected fulfills in between); everything except the target `file_path`/`updated_at` is identical.
13. **Legacy and real paths in the drawer (3.21, 3.22)**: a legacy answer without a fulfilled request still shows the 2.13 notice and enabled grading controls; a real-path answer shows the signed-URL image and no request action.
14. **Normal flow and notifications untouched (3.23–3.25)**: with an open request on a past attempt, the student starts, autosaves, and submits a new attempt; timer and grading behave as before, one `submission_received` notification is created with the same title/message/metadata, and the student still reads zero `LQ_notifications` rows.

### Unit Tests

- `normalize` unchanged: fixed vectors (`"  CPU  "`, `"Ｃｐｕ"`, `"a\t\nb"`) produce the same output as the original.
- `validateAnswerKeys`: empty list, `['']`, `['A', ' ']`, `['RAM', ' ram ']`, `['ﬁ', 'fi']` (NFKC duplicate) rejected; `['CPU', 'Central Processing Unit']` accepted and trimmed in order.
- `saveQuiz` key payloads: identification → validated array; MC → one-element array; essay/upload → `null` or one-element array.
- `validateSubmissionImage`: JPEG/PNG/WEBP within limit accepted; PDF, GIF, SVG, mismatched extension, 0 bytes, 10 MB + 1 byte rejected.
- `buildSubmissionPath` format and `signedSubmissionUrl` short-circuit on legacy names.
- `isLegacyFileName`: `'diagram.png'` true; `'S-1001/<attempt>/<q>_<uuid>.png'`, `''`, `null` false.
- `SubmissionImage` with a legacy name renders the file name and the exact "Image not available: …" notice, makes no storage call, and the answer's points/correctness controls remain enabled (2.13).
- `QuestionInput` with a legacy value in an in-progress attempt shows the notice; picking a valid image uploads it and replaces `file_path`; `storage.remove` is not called with the bare name; removing the legacy value clears `file_path` without a storage call.
- `deleteSubmission` path collection drops bare names and keeps only `${schoolId}/${id}/…` paths (3.16).
- `isRequestOpen` / `effectiveReuploadStatus`: no deadline; deadline one second in the past, equal to `now` (expired), one second ahead (open); `fulfilled` and `cancelled` never open regardless of deadline.
- `canRequestReupload`: true for upload + legacy name + `submitted`/`expired`/`reviewed` + no open request; false for real paths, empty/null `file_path`, essay/MC/identification, `in_progress`/`cancelled`, and an open unexpired request; true again when the only open request has lapsed.
- `buildReuploadPath` / `isValidReuploadPath`: canonical paths accepted; wrong school, wrong attempt, swapped question/request ids, `..`, extra folder, uppercase or missing extension, `.gif` rejected.
- `isAwaitingImageReview`: `reviewed_at` null or earlier than `fulfilled_at` → true; later → false; non-fulfilled request → false; an answer on a `reviewed` attempt whose request was opened after the review and then fulfilled → true until a later `reviewed_at` (2.26).
- `submitReupload` with a mocked client: invalid file → no storage or RPC call and the shared validation message; upload error → no RPC; RPC error → `storage.remove([path])` called once; success → no remove.
- `ReuploadRequestsBanner`: hidden with no requests; one row per request with quiz title, "Question N", formatted deadline or "No deadline", and a "Re-upload image" button; rendered on both dashboard and scores page.
- `StudentReuploadPage`: shows prompt and "Original file: …", no timer element, no other questions or answers; shows the closed-request message for an unknown id; shows the confirmation after success.
- `SubmissionReviewDrawer`: request action only for eligible legacy answers; deadline in the past blocks submit with a message; open request shows due date and Cancel; lapsed shows "expired" and the request action; fulfilled shows the image, "Re-uploaded … (original file: …)", and the awaiting-review badge when applicable.
- `handleNotification`: `reupload_fulfilled` routes to submissions with the attempt focused; `submission_received` and `password_reset_request` keep routing to students.

### Property-Based Tests

- Fix property: generated valid key lists and case/whitespace/NFKC variants of a random key always match (Property 1).
- Preservation property: single-key `matchesAnyKey` equals the original comparison for arbitrary strings, and the grading loop is equivalent for generated single-key quizzes (Property 3).
- Validator property: any list with a blank or a normalized duplicate is rejected; any list of distinct non-blank normalized values is accepted (Property 1).
- Upload validation property: generated `{ type, name, size }` triples are accepted exactly when they satisfy the allow-list and size bounds (Property 2).
- Delete path property: for generated mixes of bare names, real attempt paths, and foreign-folder paths, the collected removal list contains only paths with `/` under `${schoolId}/${id}/` (Property 4).
- Request eligibility property: for generated (question type, `file_path` of legacy/real/empty forms, attempt status, list of requests with random statuses and deadlines, `now`), `canRequestReupload` equals the spec predicate (Property 5, Property 6).
- Request state machine property: for generated operation sequences against a pure model of the request lifecycle, uploads/fulfills succeed only for `open` and unexpired requests, `fulfilled`/`cancelled` are terminal, and at most one request per answer is open at any time (Property 5).
- Re-upload path property: for generated (school id, attempt id, question id, request id, suffix, extension) tuples with random mutations, `isValidReuploadPath` accepts exactly the unmutated canonical form; the same vectors run against `LQ_fulfill_reupload` in the e2e suite with a small `numRuns` (Property 5).
- No-regrade property (e2e, small `numRuns`): for generated operation sequences on a seeded legacy attempt, the snapshot of every grading and attempt column is unchanged (Property 6).

### Integration Tests

- End-to-end identification flow (local Supabase via `supabase start`, or a staging project): admin saves a quiz with an identification question keyed ["Central Processing Unit", "CPU"] and an MC question; student starts the attempt, answers "cpu", submits via `submit-attempt`; assert full points and unchanged MC grading. Repeat with an expired attempt through `finalize-expired-attempts`.
- End-to-end image submission: student uploads a PNG; assert the object exists at `{school}/{attempt}/…` and `file_path` matches; replace with a WEBP and assert the PNG is gone; try a PDF and a >10 MB file and assert rejection (client and bucket); try uploading into another student's folder or a submitted attempt and assert RLS denial; submit and assert the student can no longer delete the object.
- Admin review and deletion: admin creates a signed URL for the path and fetches it (HTTP 200, image content type); deletes the submission; assert the attempt rows are gone, the `submission_deleted` audit row exists, and `storage.list('{school}/{attempt}')` is empty.
- Legacy data: seed a submitted attempt with `file_path = 'diagram.png'`, run the migration, open it in the review drawer (notice shown, manual review save via `LQ_review_attempt` succeeds), then delete it (rows and audit row as before, no storage removal for the bare name).
- Re-upload happy path: seed a submitted attempt with `file_path = 'diagram.png'`; admin calls `LQ_request_reupload` with a deadline; the owning student sees it in `LQ_my_reupload_requests()` and in their `LQ_reupload_requests` select; the student uploads a PNG to `buildReuploadPath(...)` and calls `LQ_fulfill_reupload`; assert `file_path` equals the path, request `fulfilled` with `fulfilled_path`, one `reupload_fulfilled` admin notification with the expected metadata, `reupload_requested` and `reupload_fulfilled` audit rows, the request gone from the student list, an admin signed URL that returns HTTP 200 with an image content type, and unchanged grading/attempt snapshot. The admin then saves a review through `LQ_review_attempt`.
- Re-upload rejections: a second request while one is open; requests for a real path, an essay question, and `in_progress`/`cancelled` attempts; a past deadline; student insert/update/delete on `LQ_reupload_requests`; another student's select, storage upload, and `LQ_fulfill_reupload` (same "no longer open" message); upload and fulfill after cancel; after the deadline (set via service role to `now() - interval '1 second'`); a second fulfill; fulfill with a foreign-folder path, another request's prefix, a non-existent object, or an object uploaded by someone else.
- Lapsed request: an open request with a passed deadline is shown as expired in the drawer; a new `LQ_request_reupload` closes it as `cancelled`/`expired` and opens a fresh one.
- Failed-fulfill cleanup: force `LQ_fulfill_reupload` to fail after the upload (cancel the request in between); the client removes the object, and `storage.list` of the attempt folder no longer contains it.
- Reviewed-attempt case: open a request, save a review (attempt `reviewed`, final score set), fulfill; status and scores are unchanged and the submissions list and drawer show "New image awaiting review"; save a review again and the flag clears.
- Already-reviewed request case (2.14, 2.26, 3.20): seed a `reviewed` attempt with a final score and `file_path = 'photo.jpg'`; `LQ_request_reupload` succeeds; the student uploads and fulfills; status stays `reviewed`, `final_score`, `is_correct`, `points_awarded`, and part scores are unchanged, and the loaded submission has `hasImageAwaitingReview = true` until the next `LQ_review_attempt` save.
- Delete: delete a submission with one open and one fulfilled request; both request rows are gone, the attempt folder (including the re-uploaded object) is empty, and the `submission_deleted` audit row exists.
- Browser e2e (Playwright or manual script against the local stack): admin drawer "Request re-upload" → student dashboard banner and scores banner → re-upload page (no timer) → invalid file message → valid upload → confirmation → admin notification click opens the drawer with the image.
- `npm run build` passes, and `npm test` runs unit/PBT suites (e2e suite skipped unless its env vars are set).

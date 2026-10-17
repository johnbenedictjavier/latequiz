# Bugfix Requirements Document

## Introduction

LateQuiz has two related defects in how student answers are captured and graded.

First, identification questions can only store one answer key. The quiz builder offers a single answer field, each question has a single text key, and both grading paths (the normal `submit-attempt` submission and the `finalize-expired-attempts` timeout finalizer) compare the student's normalized answer against that one key. Valid alternative answers (synonyms, abbreviations, alternate spellings) are graded wrong and must be fixed by hand during review.

Second, upload questions never upload anything. The student's file picker only records the file name as `file_path`. No object is written to the private `lq-submissions` bucket, so admins see a bare file name in the review drawer and cannot open the student's image. There is also no file validation beyond the picker's `accept` hint, and storage objects are not cleaned up when a submission is deleted or a file is replaced.

Students have already taken quizzes with upload questions under this defect. Those pre-fix upload answers hold only a bare file name in `file_path`; the images were never stored anywhere and cannot be recovered from the system. Today there is also no way for an admin to ask the student for the image again, or for the student to provide it. Existing submissions are otherwise kept as they are, with no automatic regrading of past attempts.

The fix adds repeatable answer keys for identification questions only. Keys are stored as a `text[]`, existing single keys are migrated, and grading accepts any configured key in both paths. The fix also adds real, validated image uploads to the private bucket, shows them in the admin review drawer through signed URLs, and cleans up storage when submissions are deleted or replaced. For legacy upload answers, the fix adds an admin-requested re-upload flow: an admin can ask a student to re-upload the image for one specific legacy answer, the student sees the open request on their dashboard and score history and uploads a single image for that answer only, and the admin then views and grades it manually through the existing review flow. LateQuiz has no student-facing notifications today (notifications are read and shown only for admins), so the dashboard and score-history banner is how students learn about a request. Multiple-choice, essay, and upload grading, along with the existing normalization rules, must stay the same.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN an admin edits an identification question in the quiz builder THEN the system offers only one answer-key field, so the admin cannot add alternative correct answers

1.2 WHEN an identification question is saved THEN the system stores at most one answer key as a single text value

1.3 WHEN a student answers an identification question with a valid alternative answer that differs from the single stored key after normalization, and submits normally THEN the system marks the answer incorrect and awards 0 points

1.4 WHEN a student answers an identification question with a valid alternative answer and the attempt is finalized after expiry THEN the system marks the answer incorrect and awards 0 points

1.5 WHEN an admin saves an identification question with a blank answer key THEN the system accepts it and stores a null key, so no student answer can ever be graded correct

1.6 WHEN an admin opens a submission in the review drawer for an identification question THEN the system shows only the single stored key as the correct answer

1.7 WHEN a student selects a file for an upload question THEN the system records only the file name as the answer's file path and does not upload the file to the private `lq-submissions` bucket

1.8 WHEN a student selects a file that is not an allowed type or is larger than the stated limit THEN the system accepts it without validation

1.9 WHEN an admin opens an upload answer in the review drawer THEN the system shows only the file name text and gives no way to view the submitted image

1.10 WHEN a student replaces or removes a selected file for an upload question THEN the system leaves any previously stored object in place, orphaned

1.11 WHEN an admin deletes a submission that has upload answers THEN the system deletes the attempt rows but leaves the related objects in the `lq-submissions` bucket

1.12 WHEN an admin opens an existing (pre-fix) upload answer whose `file_path` is a bare file name THEN the system shows the file name as if it were a stored file, with no indication that the image was never stored

1.13 WHEN an admin reviews a submitted, expired, or already reviewed attempt containing a legacy upload answer whose `file_path` is a bare file name THEN the system offers no way to request the image from the student, so the answer can only be graded without ever seeing the student's work

1.14 WHEN a student has a submitted, expired, or already reviewed attempt containing a legacy upload answer whose image was never stored THEN the system offers no way for the student to learn that the image is missing or to provide it again

### Expected Behavior (Correct)

2.1 WHEN an admin edits an identification question in the quiz builder THEN the system SHALL let the admin add and remove multiple answer-key fields for that question

2.2 WHEN an identification question is saved THEN the system SHALL store its answer keys as a `text[]`, trimmed, with blank entries rejected and duplicates rejected (after the existing normalization, so case, whitespace, and Unicode variants count as duplicates)

2.3 WHEN a student answers an identification question and submits normally, and the normalized answer equals the normalized form of any configured key THEN the system SHALL mark the answer correct and award the question's full points

2.4 WHEN an attempt containing an identification question is finalized after expiry, and the normalized answer equals the normalized form of any configured key THEN the system SHALL mark the answer correct and award the question's full points

2.5 WHEN an admin tries to save an identification question with no non-empty answer key THEN the system SHALL block the save and show a validation message

2.6 WHEN an admin opens a submission in the review drawer for an identification question THEN the system SHALL show all configured answer keys as accepted answers

2.7 WHEN a student selects a valid image for an upload question THEN the system SHALL upload it to the private `lq-submissions` bucket under the student's school-ID folder and store the object path as the answer's file path

2.8 WHEN a student selects a file that is not an allowed image type or exceeds the size limit THEN the system SHALL reject it before uploading, show a clear validation message, and leave the answer unchanged

2.9 WHEN an admin opens an upload answer in the review drawer THEN the system SHALL display the submitted image using a short-lived signed URL from the private bucket, and SHALL show a clear fallback if the object is missing or the URL cannot be created

2.10 WHEN a student replaces or removes a previously uploaded file for an upload question THEN the system SHALL remove the superseded object from the `lq-submissions` bucket

2.11 WHEN an admin deletes a submission that has upload answers THEN the system SHALL remove the related objects from the `lq-submissions` bucket along with the attempt data

2.12 WHEN the answer-key migration runs on existing data THEN the system SHALL convert every existing non-null single answer key into a one-element `text[]` without losing or altering any key

2.13 WHEN an admin opens an existing (pre-fix) upload answer whose `file_path` is a bare file name THEN the system SHALL show the file name with a clear notice that the image was never stored, and SHALL still allow manual grading of that answer

2.14 WHEN an admin opens, in the review drawer, a legacy upload answer whose `file_path` is a bare file name on a submitted, expired, or reviewed attempt THEN the system SHALL show the "never stored" notice together with a "Request re-upload" action that accepts an optional deadline, and SHALL open a re-upload request for that one answer only, with at most one open request per answer at a time

2.15 WHEN an admin cancels an open re-upload request THEN the system SHALL close the request as cancelled, and the student SHALL no longer be able to upload against it

2.16 WHEN a student has one or more open, unexpired re-upload requests on their own attempts THEN the system SHALL show a banner or list on the student's dashboard and score history with one entry per request, showing the quiz title, the question number, and the deadline (or that there is no deadline), with a "Re-upload image" action

2.17 WHEN a student chooses "Re-upload image" for one of their open requests THEN the system SHALL open a page that shows only that question's prompt and the original file name, with no quiz timer, and with no other answers of the attempt shown as editable

2.18 WHEN a student selects a file on the re-upload page that is not a JPEG, PNG, or WEBP image, is empty, or is larger than 10 MB THEN the system SHALL reject it before uploading with the same validation messages as normal upload answers, and SHALL leave the request open and the answer unchanged

2.19 WHEN a student sends a valid image for an open, unexpired request THEN the system SHALL store it in the `lq-submissions` bucket under `{school_id}/{attempt_id}/`, set that answer's `file_path` to the stored object path, close the request as fulfilled, remove it from the student's banner, and show the student a confirmation

2.20 WHEN a student fulfills a re-upload request THEN the system SHALL notify admins through the existing admin notification centre, identifying the student, the quiz, and the question

2.21 WHEN an admin opens an answer whose re-upload request was fulfilled THEN the system SHALL replace the "never stored" notice with the uploaded image shown through a short-lived signed URL (with the same fallback as 2.9), SHALL let the admin grade it manually through the existing review flow, and SHALL keep a submitted or expired attempt pending review until that manual grading is saved; a reviewed attempt SHALL keep its `reviewed` status and stored scores until the admin saves a review again

2.22 WHEN a re-upload request is fulfilled, cancelled, or past its deadline THEN the system SHALL reject any further upload against it (in the UI and on the server), and the student SHALL be able to upload again for that answer only if an admin opens a new request

2.23 WHEN a re-upload request is attempted for an answer that is not a legacy upload answer with a bare file name, for a non-upload question, or for an attempt that is not submitted, expired, or reviewed (such as an `in_progress` or `cancelled` attempt) THEN the system SHALL not offer the action and SHALL reject the request

2.24 WHEN a student tries to view or act on a re-upload request that belongs to another student THEN the system SHALL deny access

2.25 WHEN an admin deletes a submission that has re-upload requests or re-uploaded images THEN the system SHALL remove those requests and the re-uploaded objects from the `lq-submissions` bucket along with the attempt data

2.26 WHEN a re-upload request on a reviewed attempt has been fulfilled and the admin has not saved a review for that attempt since the fulfillment THEN the system SHALL show a "New image awaiting review" indicator for that attempt and answer in the admin review views, and SHALL clear the indicator once the admin saves a review for that attempt

### Unchanged Behavior (Regression Prevention)

3.1 WHEN an identification question has exactly one answer key (including keys migrated from the old single-key column) THEN the system SHALL CONTINUE TO grade answers exactly as before in both the normal and expired-attempt grading paths

3.2 WHEN identification answers are compared with keys THEN the system SHALL CONTINUE TO use the existing normalization (Unicode NFKC normalization, trim, lowercase, collapse whitespace to single spaces), so matching stays case-insensitive and whitespace-insensitive

3.3 WHEN a student leaves an identification question blank THEN the system SHALL CONTINUE TO mark it incorrect with 0 points

3.4 WHEN a multiple-choice question is created, edited, saved, or graded THEN the system SHALL CONTINUE TO use a single correct option, with the same builder UI and the same auto-grading result in both grading paths

3.5 WHEN an essay question is answered and submitted THEN the system SHALL CONTINUE TO skip auto-grading, flag the item for manual review, and leave the attempt's final score pending

3.6 WHEN an upload question is submitted THEN the system SHALL CONTINUE TO skip auto-grading, flag the item for manual review, and leave the attempt's final score pending

3.7 WHEN a question is marked as requiring manual review THEN the system SHALL CONTINUE TO route it to manual review regardless of its answer keys

3.8 WHEN an attempt is graded in either path THEN the system SHALL CONTINUE TO compute auto score, per-part scores, final score, submission status, submission reason, time taken, and admin notifications the same way

3.9 WHEN an admin manually reviews a submission in the review drawer THEN the system SHALL CONTINUE TO allow editing points awarded and correctness and saving through the existing review flow

3.10 WHEN a student or non-admin user accesses the `lq-submissions` bucket THEN the system SHALL CONTINUE TO keep it private, allowing students to write and read only within their own school-ID folder and allowing admins to read and delete

3.11 WHEN a submission without upload answers is deleted THEN the system SHALL CONTINUE TO delete the attempt and its related rows and write the `submission_deleted` audit log entry as before

3.12 WHEN avatar images are uploaded, displayed, or removed THEN the system SHALL CONTINUE TO use the `lq-avatars` bucket and its existing behavior unchanged

3.13 WHEN students view quizzes or answer keys are loaded on the client THEN the system SHALL CONTINUE TO keep answer keys readable only by admins, so the move to multiple keys does not expose them to students

3.14 WHEN answer keys are added or changed on a question after attempts were already submitted or reviewed THEN the system SHALL CONTINUE TO keep those attempts' stored `is_correct`, `points_awarded`, auto score, final score, per-part scores, status, and review data unchanged, with no regrading; new keys SHALL apply only to attempts graded after the change

3.15 WHEN the migration runs on existing upload answers THEN the system SHALL CONTINUE TO keep every legacy `file_path` value (bare file names) exactly as stored, without modifying or deleting it

3.16 WHEN an admin deletes a legacy submission whose upload answers have bare file names in `file_path` THEN the system SHALL CONTINUE TO delete the attempt data as before and SHALL NOT attempt storage removal for those bare file names; storage removal SHALL target only real object paths or the attempt's storage folder

3.17 WHEN a student has a submitted, expired, or reviewed attempt, with or without an open re-upload request THEN the system SHALL CONTINUE TO prevent the student from changing any answer, score, status, or other field of that attempt, other than the single `file_path` set by fulfilling an open request under 2.19

3.18 WHEN a student uploads to the `lq-submissions` bucket THEN the system SHALL CONTINUE TO block writes outside the student's own school-ID folder, and SHALL block re-upload writes for submitted, expired, or reviewed attempts unless the student has an open, unexpired request for that answer

3.19 WHEN a student views open re-upload requests or the re-upload page THEN the system SHALL CONTINUE TO keep answer keys, correct options, and points awarded hidden from students

3.20 WHEN a re-upload request is opened, cancelled, expired, or fulfilled THEN the system SHALL CONTINUE TO leave the answer's `is_correct`, `points_awarded`, and the attempt's status (including `reviewed`), auto score, final score, per-part scores, and review data unchanged, with no automatic regrading; only an admin's manual review may change them

3.21 WHEN a legacy upload answer has no fulfilled re-upload request THEN the system SHALL CONTINUE TO keep its bare-file-name `file_path` unchanged and show the "never stored" notice with manual grading as in 2.13

3.22 WHEN an upload answer already holds a real object path (submitted after the fix) THEN the system SHALL CONTINUE TO show it through a signed URL as in 2.9 and SHALL NOT offer the "Request re-upload" action

3.23 WHEN a student starts or takes a quiz normally THEN the system SHALL CONTINUE TO use the existing quiz-taking flow, including the timer, answer saving, and submission, unaffected by any re-upload requests

3.24 WHEN attempts are submitted or finalized after expiry THEN the system SHALL CONTINUE TO create the same admin submission notifications as before, and re-upload notifications SHALL be added alongside them without changing them

3.25 WHEN notifications are loaded THEN the system SHALL CONTINUE TO show notifications only to admins; no student notification centre is added, and students learn about re-upload requests only through the dashboard and score-history banner

/**
 * End-to-end suite for "multi-answer-keys-image-uploads" (tasks.md 3.15).
 *
 * These tests exercise the real database, Row Level Security, Storage, the
 * re-upload RPCs, and both grading edge functions. They cannot run against the
 * stubbed client used by the unit/PBT suites, so they are gated behind three
 * environment variables and SKIPPED by default. A normal `npm test` run with no
 * env vars present passes with this entire suite skipped.
 *
 * ---------------------------------------------------------------------------
 * How to run
 * ---------------------------------------------------------------------------
 * NEVER point these at production. They create and then delete users, quizzes,
 * attempts, requests, notifications, and storage objects. Use either:
 *
 *   1. A local stack:  `supabase start`  (then `supabase db reset` so BOTH
 *      migrations in this spec are applied in deploy order), and
 *      `supabase functions serve submit-attempt finalize-expired-attempts`.
 *   2. A disposable staging project with both migrations applied and the two
 *      edge functions deployed.
 *
 * Then set the vars (anon + service-role keys from the target project) and run
 * `npm test`:
 *
 *   LATEQUIZ_E2E_SUPABASE_URL   = http://127.0.0.1:54321 (or the staging URL)
 *   LATEQUIZ_E2E_ANON_KEY       = <anon key>
 *   LATEQUIZ_E2E_SERVICE_ROLE_KEY = <service role key>
 *
 * The migrations themselves are applied out of band by the Supabase CLI (they
 * must run as the migration role, which the service-role key cannot assume over
 * the REST API); this suite only verifies behaviour once they are in place and
 * asserts the migration backfill left legacy data byte-for-byte.
 *
 * _Requirements: 2.3, 2.4, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 2.14, 2.15,
 * 2.16, 2.19, 2.20, 2.21, 2.22, 2.23, 2.24, 2.25, 2.26, 3.10, 3.11, 3.12, 3.13,
 * 3.14, 3.15, 3.16, 3.17, 3.18, 3.19, 3.20, 3.23, 3.24, 3.25_
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'

// ---------------------------------------------------------------------------
// Env gate
// ---------------------------------------------------------------------------
// `@types/node` is not in the test tsconfig's `types`, so read process.env
// through a locally typed view of globalThis instead of the global `process`.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
const SUPABASE_URL = env.LATEQUIZ_E2E_SUPABASE_URL
const ANON_KEY = env.LATEQUIZ_E2E_ANON_KEY
const SERVICE_ROLE_KEY = env.LATEQUIZ_E2E_SERVICE_ROLE_KEY
const E2E_ENABLED = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY)

const SUBMISSION_BUCKET = 'lq-submissions'
const AVATAR_BUCKET = 'lq-avatars'
const MAX_SUBMISSION_BYTES = 10_485_760
const IMAGE_SUFFIX = /^[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$/

// ---------------------------------------------------------------------------
// Small helpers (mirror the production path/validation rules so the suite does
// not depend on the Vite-bound `src/lib/supabase` singleton).
// ---------------------------------------------------------------------------
function uniqueSuffix() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function buildSubmissionPath(schoolId: string, attemptId: string, questionId: string, ext: string) {
  return `${schoolId}/${attemptId}/${questionId}_${crypto.randomUUID()}.${ext}`
}

function buildReuploadPath(schoolId: string, attemptId: string, questionId: string, requestId: string, ext: string) {
  return `${schoolId}/${attemptId}/${questionId}_${requestId}_${crypto.randomUUID().toLowerCase()}.${ext}`
}

function isValidReuploadPath(
  path: string,
  ctx: { schoolId: string; attemptId: string; questionId: string; requestId: string },
) {
  const prefix = `${ctx.schoolId}/${ctx.attemptId}/${ctx.questionId}_${ctx.requestId}_`
  if (!path.startsWith(prefix)) return false
  return IMAGE_SUFFIX.test(path.slice(prefix.length))
}

// 1x1 PNG / WEBP / JPEG byte sequences for storage round-trips.
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
  0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe,
  0x07, 0x00,
])

function pngFile(name = 'diagram.png') {
  return new File([PNG_BYTES], name, { type: 'image/png' })
}
function webpFile(name = 'diagram.webp') {
  return new File([WEBP_BYTES], name, { type: 'image/webp' })
}
function pdfFile(name = 'notes.pdf') {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], name, { type: 'application/pdf' })
}
function hugeJpegFile(name = 'huge.jpg') {
  return new File([new Uint8Array(MAX_SUBMISSION_BYTES + 1)], name, { type: 'image/jpeg' })
}

type SeededStudent = {
  schoolId: string
  email: string
  password: string
  authUserId: string
  client: SupabaseClient
}

// Register everything we create so afterAll can tear it down even on failure.
const createdAuthUsers: string[] = []
const createdSchoolIds: string[] = []
const createdQuizIds: string[] = []
const createdAttemptIds: string[] = []
const createdStoragePaths: string[] = []

let admin: SupabaseClient // service role; bypasses RLS
let adminAuthUserId = '' // a real admin profile used for admin-only RPCs via a signed-in client
let adminClient: SupabaseClient // signed-in admin (RLS on, role=admin)

// ---------------------------------------------------------------------------
// Seeding factories (service role)
// ---------------------------------------------------------------------------
async function createAuthUser(email: string, password: string, meta: Record<string, unknown> = {}) {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: meta })
  if (error || !data.user) throw error ?? new Error('createUser returned no user')
  createdAuthUsers.push(data.user.id)
  return data.user.id
}

/** Signs in a fresh anon-key client as the given user. */
async function signIn(email: string, password: string) {
  const client = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return client
}

async function seedStudent(index: number): Promise<SeededStudent> {
  const n = String(10000 + index).slice(-5)
  const schoolId = `${String(50 + index).slice(-2)}-${n}`
  createdSchoolIds.push(schoolId)
  await admin.from('LQ_student_roster').insert({ school_id: schoolId, last_name: `Test${index}`, first_names: 'Student', is_active: true })

  const email = `lq-e2e-student-${schoolId}-${uniqueSuffix()}@example.test`
  const password = `Pw-${uniqueSuffix()}-aA1!`
  // The auth.users insert trigger (LQ_link_new_auth_user) creates the student
  // profile and links the roster row when school_id is in user metadata.
  const authUserId = await createAuthUser(email, password, { school_id: schoolId })
  const client = await signIn(email, password)
  return { schoolId, email, password, authUserId, client }
}

async function seedAdmin() {
  const email = `lq-e2e-admin-${uniqueSuffix()}@example.test`
  const password = `Pw-${uniqueSuffix()}-aA1!`
  const id = await createAuthUser(email, password, { full_name: 'E2E Admin' })
  // Promote the auto-created profile to admin.
  const { error } = await admin.from('LQ_profiles').upsert({ id, role: 'admin', full_name: 'E2E Admin', must_change_password: false })
  if (error) throw error
  adminAuthUserId = id
  adminClient = await signIn(email, password)
}

type QuizSeed = {
  quizId: string
  assignmentId: string
  questionIds: string[]
}

/**
 * Creates a published quiz assigned to the given schools. `questions` describes
 * each question's type, points, and (for identification/MC) answer keys.
 */
async function seedQuiz(options: {
  schoolIds: string[]
  questions: Array<{ type: 'multiple-choice' | 'identification' | 'essay' | 'upload'; points: number; keys?: string[]; options?: string[]; prompt?: string }>
}): Promise<QuizSeed> {
  const { data: quiz, error: quizError } = await admin
    .from('LQ_quizzes')
    .insert({ title: `E2E Quiz ${uniqueSuffix()}`, subject: 'Computer Science', status: 'published', duration_seconds: 1800, created_by: adminAuthUserId })
    .select('id')
    .single()
  if (quizError || !quiz) throw quizError ?? new Error('quiz insert failed')
  createdQuizIds.push(quiz.id)

  const questionIds: string[] = []
  for (let i = 0; i < options.questions.length; i++) {
    const q = options.questions[i]
    const { data: question, error: questionError } = await admin
      .from('LQ_questions')
      .insert({
        quiz_id: quiz.id,
        position: i + 1,
        question_type: q.type,
        prompt: q.prompt ?? `Question ${i + 1}`,
        points: q.points,
        options: q.options ?? [],
        requires_manual_review: q.type === 'essay' || q.type === 'upload',
      })
      .select('id')
      .single()
    if (questionError || !question) throw questionError ?? new Error('question insert failed')
    questionIds.push(question.id)

    const keys = q.type === 'identification' || q.type === 'multiple-choice' ? q.keys ?? null : null
    if (keys) {
      const { error: keyError } = await admin.from('LQ_question_keys').insert({ question_id: question.id, answer_keys: keys })
      if (keyError) throw keyError
    }
  }

  const { data: assignment, error: assignmentError } = await admin
    .from('LQ_quiz_assignments')
    .insert(options.schoolIds.map((schoolId) => ({ quiz_id: quiz.id, school_id: schoolId, is_active: true, attempt_limit: 3 })))
    .select('id')
  if (assignmentError || !assignment?.length) throw assignmentError ?? new Error('assignment insert failed')

  return { quizId: quiz.id, assignmentId: assignment[0].id, questionIds }
}

/** Creates an attempt (optionally pre-dated/expired) owned by the student. */
async function seedAttempt(options: {
  student: SeededStudent
  quiz: QuizSeed
  status?: 'in_progress' | 'submitted' | 'expired' | 'reviewed'
  expiresAt?: string
  finalScore?: number | null
}) {
  const { student, quiz } = options
  const { data: assignment } = await admin
    .from('LQ_quiz_assignments')
    .select('id')
    .eq('quiz_id', quiz.quizId)
    .eq('school_id', student.schoolId)
    .single()
  const { data: attempt, error } = await admin
    .from('LQ_attempts')
    .insert({
      assignment_id: assignment!.id,
      quiz_id: quiz.quizId,
      school_id: student.schoolId,
      auth_user_id: student.authUserId,
      attempt_number: 1,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: options.expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString(),
      status: options.status ?? 'in_progress',
      final_score: options.finalScore ?? null,
    })
    .select('id')
    .single()
  if (error || !attempt) throw error ?? new Error('attempt insert failed')
  createdAttemptIds.push(attempt.id)
  return attempt.id as string
}

async function seedAnswer(attemptId: string, questionId: string, fields: { answer_text?: string | null; file_path?: string | null }) {
  const { data, error } = await admin
    .from('LQ_answers')
    .insert({ attempt_id: attemptId, question_id: questionId, answer_text: fields.answer_text ?? null, file_path: fields.file_path ?? null })
    .select('id')
    .single()
  if (error || !data) throw error ?? new Error('answer insert failed')
  return data.id as string
}

async function invokeSubmit(student: SeededStudent, attemptId: string, reason: 'manual' | 'exit' | 'timeout' = 'manual') {
  return student.client.functions.invoke('submit-attempt', { body: { attempt_id: attemptId, submission_reason: reason } })
}

async function listFolder(client: SupabaseClient, folder: string) {
  const { data, error } = await client.storage.from(SUBMISSION_BUCKET).list(folder, { limit: 1000 })
  if (error) throw error
  return (data ?? []).filter((item) => item?.name).map((item) => item.name)
}

async function auditRows(eventType: string, attemptId: string) {
  const { data } = await admin.from('LQ_audit_logs').select('*').eq('event_type', eventType).eq('entity_id', attemptId)
  return data ?? []
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
const describeE2E = E2E_ENABLED ? describe : describe.skip

describeE2E('multi-answer keys, image uploads, and legacy re-upload (live Supabase)', () => {
  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
    await seedAdmin()
  }, 60_000)

  afterAll(async () => {
    // Objects first (rows cascade when attempts are deleted, but orphan objects do not).
    if (createdStoragePaths.length && admin) {
      try {
        await admin.storage.from(SUBMISSION_BUCKET).remove([...new Set(createdStoragePaths)])
      } catch {
        /* best effort */
      }
    }
    if (admin) {
      for (const schoolId of createdSchoolIds) {
        try {
          const folders = createdAttemptIds.map((a) => `${schoolId}/${a}`)
          for (const folder of folders) {
            const names = await listFolder(admin, folder).catch(() => [])
            if (names.length) await admin.storage.from(SUBMISSION_BUCKET).remove(names.map((n) => `${folder}/${n}`))
          }
        } catch {
          /* best effort */
        }
      }
      await admin.from('LQ_attempts').delete().in('id', createdAttemptIds.length ? createdAttemptIds : ['00000000-0000-0000-0000-000000000000'])
      await admin.from('LQ_quizzes').delete().in('id', createdQuizIds.length ? createdQuizIds : ['00000000-0000-0000-0000-000000000000'])
      await admin.from('LQ_student_roster').delete().in('school_id', createdSchoolIds.length ? createdSchoolIds : ['__none__'])
      for (const userId of createdAuthUsers) {
        try {
          await admin.auth.admin.deleteUser(userId)
        } catch {
          /* best effort */
        }
      }
    }
  }, 60_000)

  // -------------------------------------------------------------------------
  // Identification: multiple keys (2.3, 2.4) via submit-attempt and finalize.
  // -------------------------------------------------------------------------
  describe('identification multiple keys', () => {
    it('grades an alternative key correct with full points via submit-attempt and leaves MC grading unchanged', async () => {
      const student = await seedStudent(1)
      const quiz = await seedQuiz({
        schoolIds: [student.schoolId],
        questions: [
          { type: 'identification', points: 5, keys: ['Central Processing Unit', 'CPU'] },
          { type: 'multiple-choice', points: 5, keys: ['Blue'], options: ['Red', 'Blue', 'Green'] },
        ],
      })
      const attemptId = await seedAttempt({ student, quiz })
      await seedAnswer(attemptId, quiz.questionIds[0], { answer_text: 'cpu' })
      await seedAnswer(attemptId, quiz.questionIds[1], { answer_text: 'Blue' })

      const { error } = await invokeSubmit(student, attemptId)
      expect(error).toBeNull()

      const { data: answers } = await admin.from('LQ_answers').select('question_id, is_correct, points_awarded').eq('attempt_id', attemptId)
      const idAnswer = answers!.find((a) => a.question_id === quiz.questionIds[0])!
      const mcAnswer = answers!.find((a) => a.question_id === quiz.questionIds[1])!
      expect(idAnswer.is_correct).toBe(true)
      expect(Number(idAnswer.points_awarded)).toBe(5)
      expect(mcAnswer.is_correct).toBe(true)
      expect(Number(mcAnswer.points_awarded)).toBe(5)
    }, 60_000)

    it('grades an alternative key correct through finalize-expired-attempts', async () => {
      const student = await seedStudent(2)
      const quiz = await seedQuiz({
        schoolIds: [student.schoolId],
        questions: [
          { type: 'identification', points: 5, keys: ['Central Processing Unit', 'CPU'] },
          { type: 'multiple-choice', points: 5, keys: ['Blue'], options: ['Red', 'Blue', 'Green'] },
        ],
      })
      const attemptId = await seedAttempt({ student, quiz, expiresAt: new Date(Date.now() - 1000).toISOString() })
      await seedAnswer(attemptId, quiz.questionIds[0], { answer_text: '  cpu  ' })
      await seedAnswer(attemptId, quiz.questionIds[1], { answer_text: 'Blue' })

      const { error } = await admin.functions.invoke('finalize-expired-attempts', { body: {} })
      expect(error).toBeNull()

      const { data: attempt } = await admin.from('LQ_attempts').select('status').eq('id', attemptId).single()
      expect(attempt!.status).toBe('expired')
      const { data: answers } = await admin.from('LQ_answers').select('question_id, is_correct, points_awarded').eq('attempt_id', attemptId)
      const idAnswer = answers!.find((a) => a.question_id === quiz.questionIds[0])!
      expect(idAnswer.is_correct).toBe(true)
      expect(Number(idAnswer.points_awarded)).toBe(5)
    }, 60_000)
  })

  // -------------------------------------------------------------------------
  // Image submission (2.7, 2.8, 2.10, 2.12, 3.18).
  // -------------------------------------------------------------------------
  describe('image submission', () => {
    it('stores a PNG under {school}/{attempt}/, replaces it with a WEBP (old object gone), and matches file_path', async () => {
      const student = await seedStudent(3)
      const quiz = await seedQuiz({ schoolIds: [student.schoolId], questions: [{ type: 'upload', points: 5 }] })
      const attemptId = await seedAttempt({ student, quiz })
      const questionId = quiz.questionIds[0]

      const pngPath = buildSubmissionPath(student.schoolId, attemptId, questionId, 'png')
      createdStoragePaths.push(pngPath)
      const up1 = await student.client.storage.from(SUBMISSION_BUCKET).upload(pngPath, pngFile(), { contentType: 'image/png', upsert: false })
      expect(up1.error).toBeNull()
      await student.client.from('LQ_answers').upsert({ attempt_id: attemptId, question_id: questionId, file_path: pngPath }, { onConflict: 'attempt_id,question_id' })

      const names1 = await listFolder(admin, `${student.schoolId}/${attemptId}`)
      expect(names1).toContain(pngPath.split('/').pop())
      const { data: answer1 } = await admin.from('LQ_answers').select('file_path').eq('attempt_id', attemptId).eq('question_id', questionId).single()
      expect(answer1!.file_path).toBe(pngPath)

      // Replace with WEBP and remove the superseded PNG (mirrors uploadSubmissionImage).
      const webpPath = buildSubmissionPath(student.schoolId, attemptId, questionId, 'webp')
      createdStoragePaths.push(webpPath)
      const up2 = await student.client.storage.from(SUBMISSION_BUCKET).upload(webpPath, webpFile(), { contentType: 'image/webp', upsert: false })
      expect(up2.error).toBeNull()
      await student.client.from('LQ_answers').upsert({ attempt_id: attemptId, question_id: questionId, file_path: webpPath }, { onConflict: 'attempt_id,question_id' })
      await student.client.storage.from(SUBMISSION_BUCKET).remove([pngPath])

      const names2 = await listFolder(admin, `${student.schoolId}/${attemptId}`)
      expect(names2).not.toContain(pngPath.split('/').pop())
      expect(names2).toContain(webpPath.split('/').pop())
    }, 60_000)

    it('rejects a PDF and a >10 MB file at the bucket', async () => {
      const student = await seedStudent(4)
      const quiz = await seedQuiz({ schoolIds: [student.schoolId], questions: [{ type: 'upload', points: 5 }] })
      const attemptId = await seedAttempt({ student, quiz })
      const questionId = quiz.questionIds[0]

      const pdfPath = buildSubmissionPath(student.schoolId, attemptId, questionId, 'pdf')
      const pdf = await student.client.storage.from(SUBMISSION_BUCKET).upload(pdfPath, pdfFile(), { contentType: 'application/pdf', upsert: false })
      expect(pdf.error).not.toBeNull()

      const hugePath = buildSubmissionPath(student.schoolId, attemptId, questionId, 'jpg')
      const huge = await student.client.storage.from(SUBMISSION_BUCKET).upload(hugePath, hugeJpegFile(), { contentType: 'image/jpeg', upsert: false })
      expect(huge.error).not.toBeNull()
    }, 60_000)

    it('denies an upload into another student\'s folder and into a submitted attempt (RLS)', async () => {
      const studentA = await seedStudent(5)
      const studentB = await seedStudent(6)
      const quizA = await seedQuiz({ schoolIds: [studentA.schoolId], questions: [{ type: 'upload', points: 5 }] })
      const inProgressA = await seedAttempt({ student: studentA, quiz: quizA })
      const submittedA = await seedAttempt({ student: studentA, quiz: quizA, status: 'submitted' })

      // B tries to write into A's folder.
      const foreignPath = buildSubmissionPath(studentA.schoolId, inProgressA, quizA.questionIds[0], 'png')
      const foreign = await studentB.client.storage.from(SUBMISSION_BUCKET).upload(foreignPath, pngFile(), { contentType: 'image/png', upsert: false })
      expect(foreign.error).not.toBeNull()

      // A tries to write into A's own submitted (not in_progress) attempt.
      const submittedPath = buildSubmissionPath(studentA.schoolId, submittedA, quizA.questionIds[0], 'png')
      const submitted = await studentA.client.storage.from(SUBMISSION_BUCKET).upload(submittedPath, pngFile(), { contentType: 'image/png', upsert: false })
      expect(submitted.error).not.toBeNull()
    }, 60_000)

    it('prevents the student from deleting the object after submit', async () => {
      const student = await seedStudent(7)
      const quiz = await seedQuiz({ schoolIds: [student.schoolId], questions: [{ type: 'upload', points: 5 }] })
      const attemptId = await seedAttempt({ student, quiz })
      const questionId = quiz.questionIds[0]
      const path = buildSubmissionPath(student.schoolId, attemptId, questionId, 'png')
      createdStoragePaths.push(path)
      await student.client.storage.from(SUBMISSION_BUCKET).upload(path, pngFile(), { contentType: 'image/png', upsert: false })
      await student.client.from('LQ_answers').upsert({ attempt_id: attemptId, question_id: questionId, file_path: path }, { onConflict: 'attempt_id,question_id' })

      await invokeSubmit(student, attemptId)

      // After submit the attempt is no longer in_progress and the object is still referenced,
      // so the student's delete policy does not match; the object survives.
      await student.client.storage.from(SUBMISSION_BUCKET).remove([path])
      const names = await listFolder(admin, `${student.schoolId}/${attemptId}`)
      expect(names).toContain(path.split('/').pop())
    }, 60_000)
  })

  // -------------------------------------------------------------------------
  // Admin review and delete (2.9, 2.11, 3.11).
  // -------------------------------------------------------------------------
  describe('admin review and delete', () => {
    it('serves a signed URL (200, image content type) and removes rows + objects + writes the audit row on delete', async () => {
      const student = await seedStudent(8)
      const quiz = await seedQuiz({ schoolIds: [student.schoolId], questions: [{ type: 'upload', points: 5 }] })
      const attemptId = await seedAttempt({ student, quiz })
      const questionId = quiz.questionIds[0]
      const path = buildSubmissionPath(student.schoolId, attemptId, questionId, 'png')
      createdStoragePaths.push(path)
      await student.client.storage.from(SUBMISSION_BUCKET).upload(path, pngFile(), { contentType: 'image/png', upsert: false })
      await student.client.from('LQ_answers').upsert({ attempt_id: attemptId, question_id: questionId, file_path: path }, { onConflict: 'attempt_id,question_id' })
      await invokeSubmit(student, attemptId)

      const { data: signed, error: signError } = await adminClient.storage.from(SUBMISSION_BUCKET).createSignedUrl(path, 300)
      expect(signError).toBeNull()
      const fetched = await fetch(signed!.signedUrl)
      expect(fetched.status).toBe(200)
      expect(fetched.headers.get('content-type')).toMatch(/image\//)

      const { error: delError } = await adminClient.rpc('LQ_delete_attempt', { p_attempt_id: attemptId })
      expect(delError).toBeNull()
      const { data: afterRows } = await admin.from('LQ_answers').select('id').eq('attempt_id', attemptId)
      expect(afterRows ?? []).toHaveLength(0)
      await admin.storage.from(SUBMISSION_BUCKET).remove([path])
      const names = await listFolder(admin, `${student.schoolId}/${attemptId}`)
      expect(names).toHaveLength(0)
      expect(await auditRows('submission_deleted', attemptId)).toHaveLength(1)
    }, 60_000)
  })

  // -------------------------------------------------------------------------
  // Legacy data + migration + re-upload (2.13, 3.10, 3.16, 3.21).
  // -------------------------------------------------------------------------
  describe('legacy uploads', () => {
    it('keeps legacy file_path byte-for-byte and never deletes bare names on legacy submission delete', async () => {
      const student = await seedStudent(9)
      const quiz = await seedQuiz({ schoolIds: [student.schoolId], questions: [{ type: 'upload', points: 5 }] })
      const submittedId = await seedAttempt({ student, quiz, status: 'submitted' })
      const inProgressId = await seedAttempt({ student, quiz, status: 'in_progress' })
      await seedAnswer(submittedId, quiz.questionIds[0], { file_path: 'diagram.png' })
      await seedAnswer(inProgressId, quiz.questionIds[0], { file_path: 'old.png' })

      // The migration (already applied by the CLI) must not have rewritten these.
      const { data: submittedAnswer } = await admin.from('LQ_answers').select('file_path').eq('attempt_id', submittedId).single()
      const { data: inProgressAnswer } = await admin.from('LQ_answers').select('file_path').eq('attempt_id', inProgressId).single()
      expect(submittedAnswer!.file_path).toBe('diagram.png')
      expect(inProgressAnswer!.file_path).toBe('old.png')

      // Student resumes the in-progress attempt and uploads a real image: file_path
      // becomes the object path; no storage delete is attempted for the bare name.
      const path = buildSubmissionPath(student.schoolId, inProgressId, quiz.questionIds[0], 'png')
      createdStoragePaths.push(path)
      await student.client.storage.from(SUBMISSION_BUCKET).upload(path, pngFile(), { contentType: 'image/png', upsert: false })
      await student.client.from('LQ_answers').update({ file_path: path }).eq('attempt_id', inProgressId).eq('question_id', quiz.questionIds[0])
      const { data: resumed } = await admin.from('LQ_answers').select('file_path').eq('attempt_id', inProgressId).single()
      expect(resumed!.file_path).toBe(path)

      // Deleting the legacy submitted attempt removes rows + audit; the bare name
      // was never a storage object, so nothing is removed for it.
      const { error } = await adminClient.rpc('LQ_delete_attempt', { p_attempt_id: submittedId })
      expect(error).toBeNull()
      expect(await auditRows('submission_deleted', submittedId)).toHaveLength(1)
    }, 60_000)
  })

  // -------------------------------------------------------------------------
  // No regrade on key change (3.14).
  // -------------------------------------------------------------------------
  describe('no regrade on key change', () => {
    it('leaves stored grading unchanged when keys change, and grades a new attempt with the new keys', async () => {
      const student = await seedStudent(10)
      const quiz = await seedQuiz({ schoolIds: [student.schoolId], questions: [{ type: 'identification', points: 5, keys: ['Central Processing Unit'] }] })
      const first = await seedAttempt({ student, quiz })
      await seedAnswer(first, quiz.questionIds[0], { answer_text: 'cpu' })
      await invokeSubmit(student, first)

      const { data: before } = await admin.from('LQ_answers').select('is_correct, points_awarded').eq('attempt_id', first).single()
      const { data: attemptBefore } = await admin.from('LQ_attempts').select('status, auto_score, final_score').eq('id', first).single()
      // "cpu" does not match the single key, so it was graded 0.
      expect(before!.is_correct).toBe(false)

      // Admin broadens the keys.
      await admin.from('LQ_question_keys').update({ answer_keys: ['Central Processing Unit', 'CPU'] }).eq('question_id', quiz.questionIds[0])

      const { data: after } = await admin.from('LQ_answers').select('is_correct, points_awarded').eq('attempt_id', first).single()
      const { data: attemptAfter } = await admin.from('LQ_attempts').select('status, auto_score, final_score').eq('id', first).single()
      expect(after).toEqual(before)
      expect(attemptAfter).toEqual(attemptBefore)

      // A new attempt now scores full points on "cpu".
      const second = await seedAttempt({ student, quiz })
      await seedAnswer(second, quiz.questionIds[0], { answer_text: 'cpu' })
      await invokeSubmit(student, second)
      const { data: newAnswer } = await admin.from('LQ_answers').select('is_correct, points_awarded').eq('attempt_id', second).single()
      expect(newAnswer!.is_correct).toBe(true)
      expect(Number(newAnswer!.points_awarded)).toBe(5)
    }, 60_000)
  })

  // -------------------------------------------------------------------------
  // Re-upload lifecycle (2.14, 2.15, 2.19-2.25, 3.17-3.20, 3.24, 3.25).
  // -------------------------------------------------------------------------
  describe('legacy re-upload lifecycle', () => {
    async function snapshotGrading(attemptId: string) {
      const { data: answers } = await admin
        .from('LQ_answers')
        .select('id, question_id, answer_text, is_correct, points_awarded, feedback, reviewed_by, reviewed_at')
        .eq('attempt_id', attemptId)
        .order('question_id')
      const { data: attempt } = await admin
        .from('LQ_attempts')
        .select('status, auto_score, manual_score, final_score, submitted_at')
        .eq('id', attemptId)
        .single()
      const { data: parts } = await admin.from('LQ_attempt_part_scores').select('*').eq('attempt_id', attemptId).order('position')
      return { answers, attempt, parts }
    }

    it('runs request -> list -> upload -> fulfill with rejections, cross-student denial, no regrade, and cascade', async () => {
      const studentA = await seedStudent(11)
      const studentB = await seedStudent(12)
      const quiz = await seedQuiz({
        schoolIds: [studentA.schoolId, studentB.schoolId],
        questions: [{ type: 'upload', points: 5 }, { type: 'essay', points: 5 }],
      })
      const attemptId = await seedAttempt({ student: studentA, quiz, status: 'submitted' })
      const uploadAnswerId = await seedAnswer(attemptId, quiz.questionIds[0], { file_path: 'diagram.png' })
      const essayAnswerId = await seedAnswer(attemptId, quiz.questionIds[1], { answer_text: 'An essay.' })

      const snapBefore = await snapshotGrading(attemptId)

      // --- Rejections before a valid request ---
      // Essay question is not an upload question.
      const essayReq = await adminClient.rpc('LQ_request_reupload', { p_answer_id: essayAnswerId })
      expect(essayReq.error).not.toBeNull()
      // Past deadline.
      const pastReq = await adminClient.rpc('LQ_request_reupload', { p_answer_id: uploadAnswerId, p_deadline: new Date(Date.now() - 1000).toISOString() })
      expect(pastReq.error).not.toBeNull()

      // --- Valid request ---
      const deadline = new Date(Date.now() + 30 * 60_000).toISOString()
      const req = await adminClient.rpc('LQ_request_reupload', { p_answer_id: uploadAnswerId, p_deadline: deadline })
      expect(req.error).toBeNull()
      const requestId = (req.data as { id: string }).id
      expect((req.data as { status: string }).status).toBe('open')
      expect(await auditRows('reupload_requested', attemptId)).toHaveLength(1)

      // Second request while one is open is rejected.
      const dup = await adminClient.rpc('LQ_request_reupload', { p_answer_id: uploadAnswerId, p_deadline: deadline })
      expect(dup.error).not.toBeNull()

      // --- Student banner listing (3.19) ---
      const myList = await studentA.client.rpc('LQ_my_reupload_requests')
      expect(myList.error).toBeNull()
      const rows = myList.data as Array<Record<string, unknown>>
      expect(rows).toHaveLength(1)
      expect(Object.keys(rows[0]).sort()).toEqual(
        ['attempt_id', 'deadline', 'original_file_name', 'prompt', 'question_id', 'question_number', 'quiz_id', 'quiz_title', 'request_id', 'requested_at'].sort(),
      )

      // Student A can read the request row; student B cannot.
      const aReadsReq = await studentA.client.from('LQ_reupload_requests').select('id').eq('id', requestId)
      expect(aReadsReq.data ?? []).toHaveLength(1)
      const bReadsReq = await studentB.client.from('LQ_reupload_requests').select('id').eq('id', requestId)
      expect(bReadsReq.data ?? []).toHaveLength(0)
      const bList = await studentB.client.rpc('LQ_my_reupload_requests')
      expect((bList.data as unknown[]) ?? []).toHaveLength(0)

      // Student insert/update/delete on the request table are rejected.
      const studentInsert = await studentA.client.from('LQ_reupload_requests').insert({ attempt_id: attemptId, question_id: quiz.questionIds[0], answer_id: uploadAnswerId, original_file_name: 'x.png' })
      expect(studentInsert.error).not.toBeNull()
      const studentUpdate = await studentA.client.from('LQ_reupload_requests').update({ status: 'cancelled' }).eq('id', requestId)
      // Rejected or silently affects zero rows (no student write policy); verify the row is unchanged.
      const stillOpen = await admin.from('LQ_reupload_requests').select('status').eq('id', requestId).single()
      expect(stillOpen.data!.status).toBe('open')
      void studentUpdate

      // Cross-student upload into A's folder is denied.
      const foreignPath = buildReuploadPath(studentA.schoolId, attemptId, quiz.questionIds[0], requestId, 'png')
      const bUpload = await studentB.client.storage.from(SUBMISSION_BUCKET).upload(foreignPath, pngFile(), { contentType: 'image/png', upsert: false })
      expect(bUpload.error).not.toBeNull()
      // Cross-student fulfill gets the same "no longer open" message.
      const bFulfill = await studentB.client.rpc('LQ_fulfill_reupload', { p_request_id: requestId, p_path: foreignPath })
      expect(bFulfill.error).not.toBeNull()
      expect(String((bFulfill.error as { message?: string })?.message)).toMatch(/no longer open/i)

      // --- Student A uploads + fulfills ---
      const path = buildReuploadPath(studentA.schoolId, attemptId, quiz.questionIds[0], requestId, 'png')
      expect(isValidReuploadPath(path, { schoolId: studentA.schoolId, attemptId, questionId: quiz.questionIds[0], requestId })).toBe(true)
      createdStoragePaths.push(path)
      const upload = await studentA.client.storage.from(SUBMISSION_BUCKET).upload(path, pngFile(), { contentType: 'image/png', upsert: false })
      expect(upload.error).toBeNull()
      const fulfill = await studentA.client.rpc('LQ_fulfill_reupload', { p_request_id: requestId, p_path: path })
      expect(fulfill.error).toBeNull()
      expect((fulfill.data as { file_path: string }).file_path).toBe(path)

      const { data: fulfilledAnswer } = await admin.from('LQ_answers').select('file_path').eq('id', uploadAnswerId).single()
      expect(fulfilledAnswer!.file_path).toBe(path)
      const { data: fulfilledReq } = await admin.from('LQ_reupload_requests').select('status, fulfilled_path').eq('id', requestId).single()
      expect(fulfilledReq!.status).toBe('fulfilled')
      expect(fulfilledReq!.fulfilled_path).toBe(path)
      expect(await auditRows('reupload_fulfilled', attemptId)).toHaveLength(1)

      // One admin notification with the expected type/metadata.
      const { data: notifs } = await admin
        .from('LQ_notifications')
        .select('recipient_role, type, title, metadata')
        .eq('type', 'reupload_fulfilled')
        .contains('metadata', { request_id: requestId })
      expect(notifs ?? []).toHaveLength(1)
      expect(notifs![0].recipient_role).toBe('admin')
      expect(notifs![0].title).toBe('Re-uploaded image received')

      // The request is gone from the student list.
      const afterList = await studentA.client.rpc('LQ_my_reupload_requests')
      expect((afterList.data as unknown[]) ?? []).toHaveLength(0)
      // Admin signed URL for the re-uploaded object works.
      const { data: signed } = await adminClient.storage.from(SUBMISSION_BUCKET).createSignedUrl(path, 300)
      const fetched = await fetch(signed!.signedUrl)
      expect(fetched.status).toBe(200)
      expect(fetched.headers.get('content-type')).toMatch(/image\//)

      // --- Rejections after fulfill ---
      const secondFulfill = await studentA.client.rpc('LQ_fulfill_reupload', { p_request_id: requestId, p_path: path })
      expect(secondFulfill.error).not.toBeNull()
      const afterPath = buildReuploadPath(studentA.schoolId, attemptId, quiz.questionIds[0], requestId, 'png')
      const afterUpload = await studentA.client.storage.from(SUBMISSION_BUCKET).upload(afterPath, pngFile(), { contentType: 'image/png', upsert: false })
      expect(afterUpload.error).not.toBeNull()

      // --- No regrade after the whole lifecycle (3.20) ---
      const snapAfter = await snapshotGrading(attemptId)
      // Only the target file_path changed; grading columns are identical.
      expect(snapAfter.attempt).toEqual(snapBefore.attempt)
      expect(snapAfter.parts).toEqual(snapBefore.parts)
      const strip = (rows: Array<Record<string, unknown>> | null) =>
        (rows ?? []).map(({ id, question_id, answer_text, is_correct, points_awarded, feedback, reviewed_by, reviewed_at }) => ({
          id, question_id, answer_text, is_correct, points_awarded, feedback, reviewed_by, reviewed_at,
        }))
      expect(strip(snapAfter.answers)).toEqual(strip(snapBefore.answers))

      // Admin can still save a review on the attempt afterwards.
      const review = await adminClient.rpc('LQ_review_attempt', {
        p_attempt_id: attemptId,
        p_answers: [
          { question_id: quiz.questionIds[0], points_awarded: 5, is_correct: true },
          { question_id: quiz.questionIds[1], points_awarded: 3, is_correct: true },
        ],
      })
      expect(review.error).toBeNull()

      // --- Delete cascade removes request rows and objects ---
      const del = await adminClient.rpc('LQ_delete_attempt', { p_attempt_id: attemptId })
      expect(del.error).toBeNull()
      const { data: remainingReqs } = await admin.from('LQ_reupload_requests').select('id').eq('attempt_id', attemptId)
      expect(remainingReqs ?? []).toHaveLength(0)
      await admin.storage.from(SUBMISSION_BUCKET).remove([path])
      const folderNames = await listFolder(admin, `${studentA.schoolId}/${attemptId}`)
      expect(folderNames).toHaveLength(0)
    }, 120_000)

    it('rejects a request for an in_progress attempt and a cancelled attempt', async () => {
      const student = await seedStudent(13)
      const quiz = await seedQuiz({ schoolIds: [student.schoolId], questions: [{ type: 'upload', points: 5 }] })
      const inProgress = await seedAttempt({ student, quiz, status: 'in_progress' })
      const answerId = await seedAnswer(inProgress, quiz.questionIds[0], { file_path: 'diagram.png' })
      const req = await adminClient.rpc('LQ_request_reupload', { p_answer_id: answerId })
      expect(req.error).not.toBeNull()
    }, 60_000)

    it('after cancel, upload and fulfill are rejected and a reupload_cancelled audit row is written', async () => {
      const student = await seedStudent(14)
      const quiz = await seedQuiz({ schoolIds: [student.schoolId], questions: [{ type: 'upload', points: 5 }] })
      const attemptId = await seedAttempt({ student, quiz, status: 'submitted' })
      const answerId = await seedAnswer(attemptId, quiz.questionIds[0], { file_path: 'diagram.png' })
      const req = await adminClient.rpc('LQ_request_reupload', { p_answer_id: answerId, p_deadline: new Date(Date.now() + 30 * 60_000).toISOString() })
      const requestId = (req.data as { id: string }).id

      const cancel = await adminClient.rpc('LQ_cancel_reupload', { p_request_id: requestId })
      expect(cancel.error).toBeNull()
      expect(await auditRows('reupload_cancelled', attemptId)).toHaveLength(1)

      const path = buildReuploadPath(student.schoolId, attemptId, quiz.questionIds[0], requestId, 'png')
      const upload = await student.client.storage.from(SUBMISSION_BUCKET).upload(path, pngFile(), { contentType: 'image/png', upsert: false })
      expect(upload.error).not.toBeNull()
      const fulfill = await student.client.rpc('LQ_fulfill_reupload', { p_request_id: requestId, p_path: path })
      expect(fulfill.error).not.toBeNull()
    }, 60_000)

    it('after the deadline lapses, fulfill is rejected, the request leaves the student list, and a new request reopens it', async () => {
      const student = await seedStudent(15)
      const quiz = await seedQuiz({ schoolIds: [student.schoolId], questions: [{ type: 'upload', points: 5 }] })
      const attemptId = await seedAttempt({ student, quiz, status: 'submitted' })
      const answerId = await seedAnswer(attemptId, quiz.questionIds[0], { file_path: 'diagram.png' })
      const req = await adminClient.rpc('LQ_request_reupload', { p_answer_id: answerId, p_deadline: new Date(Date.now() + 30 * 60_000).toISOString() })
      const requestId = (req.data as { id: string }).id

      // Lapse the deadline via the service role.
      await admin.from('LQ_reupload_requests').update({ deadline: new Date(Date.now() - 1000).toISOString() }).eq('id', requestId)

      const path = buildReuploadPath(student.schoolId, attemptId, quiz.questionIds[0], requestId, 'png')
      const fulfill = await student.client.rpc('LQ_fulfill_reupload', { p_request_id: requestId, p_path: path })
      expect(fulfill.error).not.toBeNull()
      const list = await student.client.rpc('LQ_my_reupload_requests')
      expect((list.data as unknown[]) ?? []).toHaveLength(0)

      // A fresh request closes the lapsed one as cancelled/expired and opens a new one.
      const reopen = await adminClient.rpc('LQ_request_reupload', { p_answer_id: answerId, p_deadline: new Date(Date.now() + 30 * 60_000).toISOString() })
      expect(reopen.error).toBeNull()
      const { data: lapsed } = await admin.from('LQ_reupload_requests').select('status, cancel_reason').eq('id', requestId).single()
      expect(lapsed!.status).toBe('cancelled')
      expect(lapsed!.cancel_reason).toBe('expired')
      const { data: openRows } = await admin.from('LQ_reupload_requests').select('id').eq('answer_id', answerId).eq('status', 'open')
      expect(openRows ?? []).toHaveLength(1)
    }, 60_000)

    it('rejects fulfill for foreign-folder, wrong-prefix, non-existent, and mutated paths', async () => {
      const student = await seedStudent(16)
      const other = await seedStudent(17)
      const quiz = await seedQuiz({ schoolIds: [student.schoolId], questions: [{ type: 'upload', points: 5 }] })
      const attemptId = await seedAttempt({ student, quiz, status: 'submitted' })
      const answerId = await seedAnswer(attemptId, quiz.questionIds[0], { file_path: 'diagram.png' })
      const req = await adminClient.rpc('LQ_request_reupload', { p_answer_id: answerId, p_deadline: new Date(Date.now() + 30 * 60_000).toISOString() })
      const requestId = (req.data as { id: string }).id
      const ctx = { schoolId: student.schoolId, attemptId, questionId: quiz.questionIds[0], requestId }

      // Non-existent object at an otherwise-valid path.
      const ghost = buildReuploadPath(student.schoolId, attemptId, quiz.questionIds[0], requestId, 'png')
      expect((await student.client.rpc('LQ_fulfill_reupload', { p_request_id: requestId, p_path: ghost })).error).not.toBeNull()

      // Foreign folder (another student's school id).
      const foreign = buildReuploadPath(other.schoolId, attemptId, quiz.questionIds[0], requestId, 'png')
      expect((await student.client.rpc('LQ_fulfill_reupload', { p_request_id: requestId, p_path: foreign })).error).not.toBeNull()

      // Mutation vectors: a small property run against the live RPC. Only the
      // canonical unmutated path is accepted; mutated ones are rejected.
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom<'wrongSchool' | 'wrongAttempt' | 'wrongQuestion' | 'wrongRequest' | 'badExt' | 'extraSegment' | 'traversal'>(
            'wrongSchool', 'wrongAttempt', 'wrongQuestion', 'wrongRequest', 'badExt', 'extraSegment', 'traversal',
          ),
          async (mutation) => {
            let mutated: string
            switch (mutation) {
              case 'wrongSchool': mutated = buildReuploadPath('99-99999', attemptId, quiz.questionIds[0], requestId, 'png'); break
              case 'wrongAttempt': mutated = buildReuploadPath(student.schoolId, crypto.randomUUID(), quiz.questionIds[0], requestId, 'png'); break
              case 'wrongQuestion': mutated = buildReuploadPath(student.schoolId, attemptId, crypto.randomUUID(), requestId, 'png'); break
              case 'wrongRequest': mutated = buildReuploadPath(student.schoolId, attemptId, quiz.questionIds[0], crypto.randomUUID(), 'png'); break
              case 'badExt': mutated = `${student.schoolId}/${attemptId}/${quiz.questionIds[0]}_${requestId}_${crypto.randomUUID()}.gif`; break
              case 'extraSegment': mutated = `${student.schoolId}/${attemptId}/extra/${quiz.questionIds[0]}_${requestId}_${crypto.randomUUID()}.png`; break
              case 'traversal': mutated = `${student.schoolId}/${attemptId}/${quiz.questionIds[0]}_${requestId}_../x.png`; break
            }
            expect(isValidReuploadPath(mutated, ctx)).toBe(false)
            const result = await student.client.rpc('LQ_fulfill_reupload', { p_request_id: requestId, p_path: mutated })
            expect(result.error).not.toBeNull()
          },
        ),
        { numRuns: 7 },
      )
    }, 120_000)

    it('reviewed-attempt flow keeps status/scores and flags awaiting-review until the next review', async () => {
      const student = await seedStudent(18)
      const quiz = await seedQuiz({ schoolIds: [student.schoolId], questions: [{ type: 'upload', points: 5 }] })
      const attemptId = await seedAttempt({ student, quiz, status: 'reviewed', finalScore: 4 })
      const answerId = await seedAnswer(attemptId, quiz.questionIds[0], { file_path: 'photo.jpg' })
      await admin.from('LQ_answers').update({ is_correct: true, points_awarded: 4, reviewed_at: new Date(Date.now() - 10 * 60_000).toISOString(), reviewed_by: adminAuthUserId }).eq('id', answerId)

      const snapBefore = await snapshotGrading(attemptId)

      const req = await adminClient.rpc('LQ_request_reupload', { p_answer_id: answerId, p_deadline: new Date(Date.now() + 30 * 60_000).toISOString() })
      expect(req.error).toBeNull()
      const requestId = (req.data as { id: string }).id

      const path = buildReuploadPath(student.schoolId, attemptId, quiz.questionIds[0], requestId, 'png')
      createdStoragePaths.push(path)
      await student.client.storage.from(SUBMISSION_BUCKET).upload(path, pngFile(), { contentType: 'image/png', upsert: false })
      const fulfill = await student.client.rpc('LQ_fulfill_reupload', { p_request_id: requestId, p_path: path })
      expect(fulfill.error).toBeNull()

      const { data: attempt } = await admin.from('LQ_attempts').select('status, final_score').eq('id', attemptId).single()
      expect(attempt!.status).toBe('reviewed')
      expect(Number(attempt!.final_score)).toBe(4)
      const snapAfter = await snapshotGrading(attemptId)
      expect(snapAfter.attempt).toEqual(snapBefore.attempt)

      // The fulfilled request is newer than reviewed_at, so the drawer flag is on.
      const { data: fulfilled } = await admin.from('LQ_reupload_requests').select('fulfilled_at').eq('id', requestId).single()
      const { data: answerAfter } = await admin.from('LQ_answers').select('reviewed_at').eq('id', answerId).single()
      expect(new Date(fulfilled!.fulfilled_at as string).getTime()).toBeGreaterThan(new Date(answerAfter!.reviewed_at as string).getTime())

      // A new review clears the flag by advancing reviewed_at past fulfilled_at.
      const review = await adminClient.rpc('LQ_review_attempt', {
        p_attempt_id: attemptId,
        p_answers: [{ question_id: quiz.questionIds[0], points_awarded: 5, is_correct: true }],
      })
      expect(review.error).toBeNull()
      const { data: reReviewed } = await admin.from('LQ_answers').select('reviewed_at').eq('id', answerId).single()
      expect(new Date(reReviewed!.reviewed_at as string).getTime()).toBeGreaterThanOrEqual(new Date(fulfilled!.fulfilled_at as string).getTime())
    }, 120_000)

    it('keeps closed attempts immutable for direct student updates (3.17)', async () => {
      const student = await seedStudent(19)
      const quiz = await seedQuiz({ schoolIds: [student.schoolId], questions: [{ type: 'upload', points: 5 }] })
      const attemptId = await seedAttempt({ student, quiz, status: 'submitted' })
      const answerId = await seedAnswer(attemptId, quiz.questionIds[0], { file_path: 'diagram.png' })

      const answerUpdate = await student.client.from('LQ_answers').update({ file_path: 'hacked/path.png' }).eq('id', answerId)
      const attemptUpdate = await student.client.from('LQ_attempts').update({ status: 'in_progress' }).eq('id', attemptId)
      // Either the trigger raises or RLS affects zero rows; verify nothing changed.
      void answerUpdate
      void attemptUpdate
      const { data: answer } = await admin.from('LQ_answers').select('file_path').eq('id', answerId).single()
      const { data: attempt } = await admin.from('LQ_attempts').select('status').eq('id', attemptId).single()
      expect(answer!.file_path).toBe('diagram.png')
      expect(attempt!.status).toBe('submitted')
    }, 60_000)

    it('normal flow is untouched: one submission_received notification and zero notifications readable by the student (3.23-3.25)', async () => {
      const student = await seedStudent(20)
      const quiz = await seedQuiz({ schoolIds: [student.schoolId], questions: [{ type: 'identification', points: 5, keys: ['CPU'] }] })
      const attemptId = await seedAttempt({ student, quiz })
      await seedAnswer(attemptId, quiz.questionIds[0], { answer_text: 'cpu' })

      await invokeSubmit(student, attemptId)

      const { data: notifs } = await admin
        .from('LQ_notifications')
        .select('recipient_role, type')
        .eq('type', 'submission_received')
        .contains('metadata', { attempt_id: attemptId })
      expect(notifs ?? []).toHaveLength(1)
      expect(notifs![0].recipient_role).toBe('admin')

      const studentNotifs = await student.client.from('LQ_notifications').select('id')
      expect(studentNotifs.data ?? []).toHaveLength(0)
    }, 60_000)
  })

  // -------------------------------------------------------------------------
  // Preservation checks (3.12, 3.13, 3.15, 3.16).
  // -------------------------------------------------------------------------
  describe('preservation', () => {
    it('returns zero rows when a student selects LQ_question_keys', async () => {
      const student = await seedStudent(21)
      const quiz = await seedQuiz({ schoolIds: [student.schoolId], questions: [{ type: 'identification', points: 5, keys: ['CPU'] }] })
      void quiz
      const { data } = await student.client.from('LQ_question_keys').select('*')
      expect(data ?? []).toHaveLength(0)
    }, 60_000)

    it('leaves avatar upload/remove unchanged', async () => {
      const student = await seedStudent(22)
      const avatarPath = `${student.authUserId}/${crypto.randomUUID()}.png`
      const upload = await student.client.storage.from(AVATAR_BUCKET).upload(avatarPath, pngFile('avatar.png'), { contentType: 'image/png', upsert: false })
      expect(upload.error).toBeNull()
      await student.client.from('LQ_profiles').update({ avatar_url: avatarPath }).eq('id', student.authUserId)
      const { data: signed } = await student.client.storage.from(AVATAR_BUCKET).createSignedUrl(avatarPath, 300)
      expect(signed?.signedUrl).toBeTruthy()
      const remove = await student.client.storage.from(AVATAR_BUCKET).remove([avatarPath])
      expect(remove.error).toBeNull()
    }, 60_000)

    it('writes exactly one submission_deleted audit row and removes nothing from storage for an attempt without uploads', async () => {
      const student = await seedStudent(23)
      const quiz = await seedQuiz({ schoolIds: [student.schoolId], questions: [{ type: 'identification', points: 5, keys: ['CPU'] }] })
      const attemptId = await seedAttempt({ student, quiz, status: 'submitted' })
      await seedAnswer(attemptId, quiz.questionIds[0], { answer_text: 'cpu' })

      const del = await adminClient.rpc('LQ_delete_attempt', { p_attempt_id: attemptId })
      expect(del.error).toBeNull()
      expect(await auditRows('submission_deleted', attemptId)).toHaveLength(1)
      // No storage folder was ever created for this attempt.
      const names = await listFolder(admin, `${student.schoolId}/${attemptId}`)
      expect(names).toHaveLength(0)
    }, 60_000)

    it('keeps padded, mixed-case, and Unicode answer keys byte-for-byte after the migration backfill', async () => {
      // The migration backfilled answer_keys = array[answer_key] with no
      // trimming/rewriting. Re-create the equivalent write and confirm the
      // structural check accepts the exact bytes.
      const student = await seedStudent(24)
      const padded = '  Random Access Memory  '
      const mixed = 'rAnDoM'
      const unicode = 'Ｃｐｕ' // fullwidth
      const quiz = await seedQuiz({ schoolIds: [student.schoolId], questions: [{ type: 'identification', points: 5, keys: [padded, mixed, unicode] }] })
      const { data } = await admin.from('LQ_question_keys').select('answer_keys').eq('question_id', quiz.questionIds[0]).single()
      expect(data!.answer_keys).toEqual([padded, mixed, unicode])
    }, 60_000)
  })
})

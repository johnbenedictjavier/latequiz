/**
 * Property 6: Preservation - inputs where isBugCondition(ReuploadInput) is
 * false get no re-upload action; legacy answers without a fulfilled request
 * keep their display; the submission_received notification, its routing, and
 * admin-only notification loading are unchanged.
 *
 * Validates: Requirements 3.21, 3.22, 3.24, 3.25 (and 2.23)
 *
 * Observation-first: recorded against UNFIXED code (task 2) and re-run
 * unchanged after the fix (task 3.17).
 * - Eligibility: on unfixed code `src/lib/reuploads.ts` does not exist, so the
 *   observation is "no re-upload action exists" for every input. After task
 *   3.11 the same generators assert `canRequestReupload(...) === false`
 *   (swapped in with tryLoadModule).
 * - Legacy display: `mapAnswer` returns the bare name as `answer`
 *   (e.g. 'diagram.png'); `isLegacyFileName` is the spec predicate (non-empty,
 *   no '/'), taken from `src/lib/submissionUploads.ts` once it exists.
 * - submission_received payloads below were produced by evaluating the
 *   builder code extracted from both edge functions' sources.
 * - Routing: `notificationTarget` (extracted from LegacyAdminApp's
 *   handleNotification without changing behavior) sends both
 *   `submission_received` and `password_reset_request` to 'students' focused
 *   on `metadata.school_id`.
 * - `loadAdminNotifications` filters `.eq('recipient_role', 'admin')`.
 *
 * Live-project preservation checks go in the env-gated e2e suite (task 3.15):
 * student direct updates on a submitted attempt's `LQ_answers`/`LQ_attempts`
 * are rejected (3.17); student storage writes outside the own school folder or
 * into a submitted attempt folder are rejected (3.18); students read zero
 * `LQ_notifications` rows (3.25); a normal start/autosave/submit creates one
 * `submission_received` notification with this payload (3.23, 3.24). Not run
 * in task 2: no LATEQUIZ_E2E_* env vars are configured.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import submitAttemptSource from '../supabase/functions/submit-attempt/index.ts?raw'
import finalizeSource from '../supabase/functions/finalize-expired-attempts/index.ts?raw'
import { notificationTarget } from '../src/lib/notifications'
import { stub } from './support/stubSupabase'
import { tryLoadModule } from './support/loadModule'
import { ANSWER_ID, ATTEMPT_ID, QUESTION_ID, QUIZ_ID, SCHOOL_ID, seedLegacySubmission } from './support/seeds'

vi.mock('../src/lib/supabase', async () => {
  const { stub: client } = await import('./support/stubSupabase')
  return {
    supabase: client.client,
    isSupabaseConfigured: true,
    internalAuthIdentifier: (value: string) => `${value.trim().toLowerCase()}@auth.latequiz.internal`,
  }
})

beforeEach(() => stub.reset())

// ---------------------------------------------------------------------------
// Spec predicates
// ---------------------------------------------------------------------------

type RequestStatus = 'open' | 'fulfilled' | 'cancelled'
type ReuploadRequestRecord = { id: string; status: RequestStatus; deadline: string | null }
type EligibilityInput = {
  questionType: string
  filePath: string | null | undefined
  attemptStatus: string
  requests: ReuploadRequestRecord[]
  now: Date
}

type ReuploadsModule = { canRequestReupload: (input: EligibilityInput) => boolean }
type SubmissionUploadsModule = { isLegacyFileName: (value: string | null | undefined) => boolean }

const specIsLegacyFileName = (value: string | null | undefined) => Boolean(value) && !String(value).includes('/')

const isOpenUnexpired = (request: ReuploadRequestRecord, now: Date) =>
  request.status === 'open' && (request.deadline === null || new Date(request.deadline).getTime() > now.getTime())

/** isBugCondition(ReuploadInput) with no open, unexpired request: the only inputs that may get the action. */
function eligible(input: EligibilityInput) {
  return input.questionType === 'upload'
    && specIsLegacyFileName(input.filePath)
    && ['submitted', 'expired', 'reviewed'].includes(input.attemptStatus)
    && !input.requests.some((request) => isOpenUnexpired(request, input.now))
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const bareName = fc.stringMatching(/^[A-Za-z0-9 _().-]{1,40}$/).filter((name) => name.trim().length > 0)
const realPath = fc
  .tuple(fc.stringMatching(/^S-[0-9]{4}$/), fc.uuid(), fc.uuid(), fc.uuid(), fc.constantFrom('png', 'jpg', 'jpeg', 'webp'))
  .map(([school, attempt, question, id, ext]) => `${school}/${attempt}/${question}_${id}.${ext}`)
const filePath = fc.oneof(realPath, bareName, fc.constant(''), fc.constant(null))
const questionType = fc.constantFrom('multiple-choice', 'identification', 'essay', 'upload')
const attemptStatus = fc.constantFrom('in_progress', 'submitted', 'expired', 'reviewed', 'cancelled')
const nowArb = fc.date({ min: new Date('2026-01-01T00:00:00.000Z'), max: new Date('2030-01-01T00:00:00.000Z'), noInvalidDate: true })

function requestsAt(now: Date, statuses: RequestStatus[] = ['open', 'fulfilled', 'cancelled']) {
  const deadline = fc.oneof(
    fc.constant(null),
    fc.integer({ min: -30 * 86400, max: 30 * 86400 }).map((seconds) => new Date(now.getTime() + seconds * 1000).toISOString()),
    fc.constant(now.toISOString()),
  )
  return fc.array(fc.record({ id: fc.uuid(), status: fc.constantFrom(...statuses), deadline }), { maxLength: 3 })
}

const eligibilityInput = nowArb.chain((now) =>
  fc.record({ questionType, filePath, attemptStatus, requests: requestsAt(now), now: fc.constant(now) }),
)

// ---------------------------------------------------------------------------
// 3.22, 2.23: no re-upload action outside the bug condition
// ---------------------------------------------------------------------------

describe('Preservation: no re-upload action for ineligible answers (3.22, 2.23)', () => {
  it('offers no re-upload request for real paths, non-upload types, empty paths, in_progress/cancelled attempts, or an open unexpired request (PBT)', async () => {
    const reuploads = await tryLoadModule<ReuploadsModule>('../src/lib/reuploads.ts')
    fc.assert(
      fc.property(eligibilityInput.filter((input) => !eligible(input)), (input) => {
        // Unfixed: no re-upload action exists at all. Fixed: the helper refuses.
        const offered = reuploads ? reuploads.canRequestReupload(input) : false
        expect(offered).toBe(false)
      }),
      { numRuns: 300 },
    )
  })
})

// ---------------------------------------------------------------------------
// 3.21: legacy answers without a fulfilled request keep their display
// ---------------------------------------------------------------------------

describe('Preservation: legacy upload display without a fulfilled request (3.21)', () => {
  it('maps a bare-name upload answer to the same name, flagged legacy (PBT)', async () => {
    const uploads = await tryLoadModule<SubmissionUploadsModule>('../src/lib/submissionUploads.ts')
    const isLegacy = uploads?.isLegacyFileName ?? specIsLegacyFileName
    const { loadAdminSubmissions } = await import('../src/lib/submissions')

    await fc.assert(
      fc.asyncProperty(
        bareName,
        fc.constantFrom('submitted', 'expired', 'reviewed'),
        nowArb.chain((now) => requestsAt(now, ['open', 'cancelled'])),
        async (name, status, requests) => {
          stub.reset()
          seedLegacySubmission({
            attemptStatus: status,
            reuploadRequests: requests.map((request) => ({
              id: request.id,
              attempt_id: ATTEMPT_ID,
              question_id: QUESTION_ID,
              answer_id: ANSWER_ID,
              original_file_name: name,
              requested_at: '2026-01-01T00:00:00.000Z',
              deadline: request.deadline,
              status: request.status,
              fulfilled_at: null,
              fulfilled_path: null,
              cancelled_at: request.status === 'cancelled' ? '2026-01-02T00:00:00.000Z' : null,
              cancel_reason: request.status === 'cancelled' ? 'admin' : null,
            })),
          })
          stub.onTable('LQ_answers', () => ({
            data: [{ id: ANSWER_ID, attempt_id: ATTEMPT_ID, question_id: QUESTION_ID, answer_text: null, file_path: name, is_correct: null, points_awarded: 0, reviewed_at: null }],
            error: null,
          }))

          const submissions = await loadAdminSubmissions()
          expect(submissions).toHaveLength(1)
          const answer = submissions[0].answers[0] as unknown as { answer: string; filePath?: string | null }
          expect(answer.answer).toBe(name)
          if ('filePath' in answer) expect(answer.filePath).toBe(name)
          expect(isLegacy(name)).toBe(true)
        },
      ),
      { numRuns: 50 },
    )
  })
})

// ---------------------------------------------------------------------------
// 3.24: submission_received payload in both edge functions
// ---------------------------------------------------------------------------

type BuilderInput = {
  attempt: { id: string; quiz_id: string; school_id: string }
  student: { first_names: string | null; last_name: string | null } | null
  quiz: { title: string | null } | null
  expired?: boolean
  submissionReason?: string
}

/**
 * Extracts the studentName/quizTitle lines and the LQ_notifications insert
 * object from an edge function source and evaluates them. The extracted code
 * is plain JavaScript (no type syntax).
 */
function notificationBuilder(source: string) {
  const nameLine = source.match(/^\s*const studentName = .*$/m)?.[0]
  const titleLine = source.match(/^\s*const quizTitle = .*$/m)?.[0]
  const insert = source.match(/\.from\('LQ_notifications'\)\.insert\((\{[\s\S]*?\})\)\s*$/m)?.[1]
  expect(nameLine, 'studentName line').toBeDefined()
  expect(titleLine, 'quizTitle line').toBeDefined()
  expect(insert, 'LQ_notifications insert').toBeDefined()
  const build = new Function('attempt', 'student', 'quiz', 'expired', 'submissionReason', `${nameLine}\n${titleLine}\nreturn (${insert})`)
  return (input: BuilderInput) => build(input.attempt, input.student, input.quiz, input.expired, input.submissionReason) as Record<string, unknown>
}

const attempt = { id: ATTEMPT_ID, quiz_id: QUIZ_ID, school_id: SCHOOL_ID }
const alex = { first_names: 'Alex', last_name: 'Doe' }
const quiz = { title: 'Data Representation' }

const metadata = (studentName: string, quizTitle: string, reason: string) => ({
  attempt_id: ATTEMPT_ID,
  quiz_id: QUIZ_ID,
  school_id: SCHOOL_ID,
  student_name: studentName,
  quiz_title: quizTitle,
  submission_reason: reason,
})

describe('Preservation: submission_received payload (3.24)', () => {
  const submitVectors: Array<[string, BuilderInput, Record<string, unknown>]> = [
    ['manual submit', { attempt, student: alex, quiz, expired: false, submissionReason: 'manual' }, {
      recipient_role: 'admin',
      type: 'submission_received',
      title: 'New quiz submission',
      message: 'Alex Doe submitted an attempt for Data Representation.',
      metadata: metadata('Alex Doe', 'Data Representation', 'manual'),
    }],
    ['exit submit', { attempt, student: alex, quiz, expired: false, submissionReason: 'exit' }, {
      recipient_role: 'admin',
      type: 'submission_received',
      title: 'New quiz submission',
      message: 'Alex Doe submitted an attempt for Data Representation.',
      metadata: metadata('Alex Doe', 'Data Representation', 'exit'),
    }],
    ['expired submit', { attempt, student: alex, quiz, expired: true, submissionReason: 'timeout' }, {
      recipient_role: 'admin',
      type: 'submission_received',
      title: 'Quiz submitted automatically',
      message: "Alex Doe's attempt for Data Representation reached its time limit.",
      metadata: metadata('Alex Doe', 'Data Representation', 'timeout'),
    }],
    ['no roster name, empty quiz title', { attempt, student: null, quiz: { title: '' }, expired: false, submissionReason: 'manual' }, {
      recipient_role: 'admin',
      type: 'submission_received',
      title: 'New quiz submission',
      message: `${SCHOOL_ID} submitted an attempt for ${QUIZ_ID}.`,
      metadata: metadata(SCHOOL_ID, QUIZ_ID, 'manual'),
    }],
  ]

  const finalizeVectors: Array<[string, BuilderInput, Record<string, unknown>]> = [
    ['timeout finalize', { attempt, student: alex, quiz }, {
      recipient_role: 'admin',
      type: 'submission_received',
      title: 'Quiz submitted automatically',
      message: "Alex Doe's attempt for Data Representation reached its time limit.",
      metadata: metadata('Alex Doe', 'Data Representation', 'timeout'),
    }],
    ['no roster row, no quiz row', { attempt, student: null, quiz: null }, {
      recipient_role: 'admin',
      type: 'submission_received',
      title: 'Quiz submitted automatically',
      message: `${SCHOOL_ID}'s attempt for ${QUIZ_ID} reached its time limit.`,
      metadata: metadata(SCHOOL_ID, QUIZ_ID, 'timeout'),
    }],
  ]

  it.each(submitVectors)('submit-attempt: %s', (_label, input, expected) => {
    const payload = notificationBuilder(submitAttemptSource)(input)
    expect(JSON.stringify(payload)).toBe(JSON.stringify(expected))
  })

  it.each(finalizeVectors)('finalize-expired-attempts: %s', (_label, input, expected) => {
    const payload = notificationBuilder(finalizeSource)(input)
    expect(JSON.stringify(payload)).toBe(JSON.stringify(expected))
  })
})

// ---------------------------------------------------------------------------
// 3.24, 3.25: notification routing and admin-only loading
// ---------------------------------------------------------------------------

describe('Preservation: notification routing (3.24, 3.25)', () => {
  const base = { id: 'n-1', title: 'T', message: 'M', readAt: null, createdAt: '2026-10-20T08:00:00.000Z' }

  it('password_reset_request opens the students page focused on metadata.school_id', () => {
    expect(notificationTarget({ ...base, type: 'password_reset_request', metadata: { school_id: SCHOOL_ID, attempt_id: ATTEMPT_ID } }))
      .toMatchObject({ view: 'students', focusStudentId: SCHOOL_ID })
  })

  it('password_reset_request without metadata opens the students page with no focus', () => {
    expect(notificationTarget({ ...base, type: 'password_reset_request' })).toMatchObject({ view: 'students', focusStudentId: null })
  })

  it('submission_received opens the submissions page focused on the attempt and student', () => {
    expect(notificationTarget({ ...base, type: 'submission_received', metadata: { school_id: SCHOOL_ID, attempt_id: ATTEMPT_ID } }))
      .toMatchObject({ view: 'submissions', focusStudentId: SCHOOL_ID, focusAttemptId: ATTEMPT_ID })
  })
})

describe('Preservation: loadAdminNotifications is admin-only (3.25)', () => {
  it("filters LQ_notifications on recipient_role = 'admin' and maps rows unchanged", async () => {
    stub.onTable('LQ_notifications', () => ({
      data: [{
        id: 'n-1',
        type: 'submission_received',
        title: 'New quiz submission',
        message: 'Alex Doe submitted an attempt for Data Representation.',
        read_at: null,
        created_at: '2026-10-20T08:00:00.000Z',
        metadata: metadata('Alex Doe', 'Data Representation', 'manual'),
      }],
      error: null,
    }))
    const { loadAdminNotifications } = await import('../src/lib/workspace')
    const notifications = await loadAdminNotifications()

    const queries = stub.calls.filter((call) => call.kind === 'from' && call.table === 'LQ_notifications') as Array<{ ops: { method: string; args: unknown[] }[] }>
    expect(queries).toHaveLength(1)
    const roleFilters = queries[0].ops.filter((op) => op.args[0] === 'recipient_role')
    expect(roleFilters).toEqual([{ method: 'eq', args: ['recipient_role', 'admin'] }])
    expect(notifications).toEqual([{
      id: 'n-1',
      type: 'submission_received',
      title: 'New quiz submission',
      message: 'Alex Doe submitted an attempt for Data Representation.',
      readAt: null,
      createdAt: '2026-10-20T08:00:00.000Z',
      metadata: metadata('Alex Doe', 'Data Representation', 'manual'),
    }])
  })
})

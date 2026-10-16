/**
 * Property 1 / Property 5: Bug Condition - legacy upload answers cannot be
 * recovered (isBugCondition(ReuploadInput): upload question, legacy bare-name
 * `file_path`, attempt `submitted`, `expired`, or `reviewed`).
 *
 * Validates: Requirements 1.13, 1.14 (expected behavior: 2.14, 2.16, 2.19, 2.23)
 *
 * These tests encode the EXPECTED behavior. On unfixed code they FAIL, which
 * confirms the bug. `src/lib/reuploads.ts` is loaded with a dynamic import
 * inside each test so the missing module fails only those tests.
 *
 * Counterexamples observed on UNFIXED code (npm test, task 1):
 * - `import('src/lib/reuploads.ts')` fails: the module does not exist, so
 *   `canRequestReupload`, `buildReuploadPath`, and `submitReupload` are
 *   missing ("Cannot find module .../src/lib/reuploads.ts"). The
 *   eligibility property fails before any case is generated, so every
 *   (legacy name, submitted|expired|reviewed, [], now) input is a
 *   counterexample: no request action exists.
 * - Admin drawer data (1.13): `mapAnswer` for a submitted attempt with
 *   `file_path = 'diagram.png'` returns neither `answerId` nor a `reupload`
 *   slot, so the drawer has nothing to offer "Request re-upload" with.
 * - Student discovery (1.14): `loadStudentWorkspace` returns only
 *   `{ quizzes, scores }` and never calls `LQ_my_reupload_requests`.
 * - The legacy answer stays a bare name after any student action on a
 *   submitted attempt: there is no client upload/fulfill path at all.
 *
 * Deferred to the env-gated e2e suite (task 3.15, needs a live Supabase
 * project; not run here because no LATEQUIZ_E2E_* env vars are configured):
 * `rpc('LQ_request_reupload')` missing for a seeded submitted attempt with
 * `file_path = 'diagram.png'`; the owning student can upload a PNG into
 * `{school}/{attempt}/` under the original insert policy, but the
 * `LQ_answers.file_path` update is rejected by RLS because the attempt is not
 * `in_progress`, so the object can never be linked; the student reads zero
 * `LQ_notifications` rows and has no request list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { stub } from './support/stubSupabase'
import { loadModule } from './support/loadModule'
import { ANSWER_ID, ATTEMPT_ID, QUESTION_ID, QUIZ_ID, REQUEST_ID, SCHOOL_ID, seedLegacySubmission } from './support/seeds'

vi.mock('../src/lib/supabase', async () => {
  const { stub: client } = await import('./support/stubSupabase')
  return {
    supabase: client.client,
    isSupabaseConfigured: true,
    internalAuthIdentifier: (value: string) => `${value.trim().toLowerCase()}@auth.latequiz.internal`,
  }
})

beforeEach(() => stub.reset())

type ReuploadRequestRecord = {
  id: string
  status: 'open' | 'fulfilled' | 'cancelled'
  deadline: string | null
}

type ReuploadRequest = {
  id: string
  attemptId: string
  quizId: string
  quizTitle: string
  questionId: string
  questionNumber: number
  prompt: string
  originalFileName: string
  deadline: string | null
  requestedAt: string
}

type ReuploadsModule = {
  canRequestReupload: (input: {
    questionType: string
    filePath: string | null | undefined
    attemptStatus: string
    requests: ReuploadRequestRecord[]
    now: Date
  }) => boolean
  buildReuploadPath: (schoolId: string, attemptId: string, questionId: string, requestId: string, ext: string) => string
  submitReupload: (input: { request: ReuploadRequest; schoolId: string; file: File }) => Promise<{ error?: unknown } | unknown>
}

const REUPLOADS = '../src/lib/reuploads.ts'
const loadReuploads = () => loadModule<ReuploadsModule>(REUPLOADS)

/** Legacy bare names: non-blank, no '/'. */
const legacyFileName = fc
  .stringMatching(/^[A-Za-z0-9 _().-]{1,40}$/)
  .filter((name) => name.trim().length > 0)

const closedStatus = fc.constantFrom('submitted', 'expired', 'reviewed')
const now = fc.date({ min: new Date('2026-01-01T00:00:00.000Z'), max: new Date('2030-01-01T00:00:00.000Z'), noInvalidDate: true })

describe('Bug condition: re-upload eligibility (2.14, 2.23)', () => {
  it('offers a re-upload request for legacy upload answers on submitted/expired/reviewed attempts (PBT)', async () => {
    const { canRequestReupload } = await loadReuploads()
    fc.assert(
      fc.property(legacyFileName, closedStatus, now, (filePath, attemptStatus, at) => {
        expect(filePath.includes('/')).toBe(false)
        expect(canRequestReupload({ questionType: 'upload', filePath, attemptStatus, requests: [], now: at })).toBe(true)
      }),
      { numRuns: 100 },
    )
  })
})

describe('Bug condition: admin drawer data (1.13)', () => {
  it('carries answerId and a reupload slot for a legacy upload answer on a submitted attempt', async () => {
    seedLegacySubmission({
      attemptStatus: 'submitted',
      reuploadRequests: [{
        id: REQUEST_ID,
        attempt_id: ATTEMPT_ID,
        question_id: QUESTION_ID,
        answer_id: ANSWER_ID,
        original_file_name: 'diagram.png',
        requested_at: '2026-10-20T08:00:00.000Z',
        deadline: '2099-10-30T09:00:00.000Z',
        status: 'open',
        fulfilled_at: null,
        fulfilled_path: null,
        cancelled_at: null,
        cancel_reason: null,
      }],
    })
    const { loadAdminSubmissions } = await import('../src/lib/submissions')
    const submissions = await loadAdminSubmissions()
    expect(submissions).toHaveLength(1)
    const answer = submissions[0].answers[0] as unknown as {
      answerId?: string
      reupload?: { id: string; status: string; originalFileName: string } | null
    }

    expect(answer.answerId).toBe(ANSWER_ID)
    expect(answer.reupload).toMatchObject({ id: REQUEST_ID, status: 'open', originalFileName: 'diagram.png' })
  })
})

describe('Bug condition: student discovery (1.14)', () => {
  it('returns open re-upload requests from LQ_my_reupload_requests in the student workspace load', async () => {
    stub.onRpc('LQ_my_reupload_requests', () => ({
      data: [{
        request_id: REQUEST_ID,
        attempt_id: ATTEMPT_ID,
        quiz_id: QUIZ_ID,
        quiz_title: 'Data Representation',
        question_id: QUESTION_ID,
        question_number: 4,
        prompt: 'Upload your diagram.',
        original_file_name: 'diagram.png',
        deadline: '2099-10-30T09:00:00.000Z',
        requested_at: '2026-10-20T08:00:00.000Z',
      }],
      error: null,
    }))
    const { loadStudentWorkspace } = await import('../src/lib/workspace')
    const workspace = (await loadStudentWorkspace(SCHOOL_ID)) as unknown as { reuploadRequests?: ReuploadRequest[] }

    expect(stub.calls.some((call) => call.kind === 'rpc' && call.name === 'LQ_my_reupload_requests')).toBe(true)
    expect(workspace.reuploadRequests).toHaveLength(1)
    expect(workspace.reuploadRequests?.[0]).toMatchObject({
      id: REQUEST_ID,
      quizTitle: 'Data Representation',
      questionNumber: 4,
      deadline: '2099-10-30T09:00:00.000Z',
    })
  })
})

describe('Bug condition: student re-upload (1.14 -> 2.19)', () => {
  const pathPattern = (ext: string) =>
    new RegExp(`^${SCHOOL_ID}/${ATTEMPT_ID}/${QUESTION_ID}_${REQUEST_ID}_[0-9a-f-]{36}\\.${ext}$`)

  it('builds {school}/{attempt}/{question}_{request}_{uuid}.png', async () => {
    const { buildReuploadPath } = await loadReuploads()
    expect(buildReuploadPath(SCHOOL_ID, ATTEMPT_ID, QUESTION_ID, REQUEST_ID, 'png')).toMatch(pathPattern('png'))
  })

  it('uploads a valid PNG then calls LQ_fulfill_reupload with the same path', async () => {
    const { submitReupload } = await loadReuploads()
    const request: ReuploadRequest = {
      id: REQUEST_ID,
      attemptId: ATTEMPT_ID,
      quizId: QUIZ_ID,
      quizTitle: 'Data Representation',
      questionId: QUESTION_ID,
      questionNumber: 4,
      prompt: 'Upload your diagram.',
      originalFileName: 'diagram.png',
      deadline: null,
      requestedAt: '2026-10-20T08:00:00.000Z',
    }
    stub.onRpc('LQ_fulfill_reupload', () => ({ data: { status: 'fulfilled' }, error: null }))
    const file = new File([new Uint8Array(4096)], 'diagram.png', { type: 'image/png' })

    await submitReupload({ request, schoolId: SCHOOL_ID, file })

    const uploadIndex = stub.calls.findIndex((call) => call.kind === 'storage' && call.method === 'upload')
    const fulfillIndex = stub.calls.findIndex((call) => call.kind === 'rpc' && call.name === 'LQ_fulfill_reupload')
    expect(uploadIndex).toBeGreaterThanOrEqual(0)
    expect(fulfillIndex).toBeGreaterThan(uploadIndex)

    const upload = stub.calls[uploadIndex] as { bucket: string; args: unknown[] }
    const path = String(upload.args[0])
    expect(upload.bucket).toBe('lq-submissions')
    expect(path).toMatch(pathPattern('png'))
    expect((stub.calls[fulfillIndex] as { args: unknown }).args).toEqual({ p_request_id: REQUEST_ID, p_path: path })
    expect(stub.calls.some((call) => call.kind === 'storage' && call.method === 'remove')).toBe(false)
  })
})

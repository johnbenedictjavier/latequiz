/**
 * Unit and property tests for src/lib/reuploads.ts (task 3.11).
 *
 * Validates: Requirements 2.14, 2.15, 2.18, 2.19, 2.21, 2.22, 2.23, 3.18, 3.20, 3.22
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { stub } from './support/stubSupabase'
import { ANSWER_ID, ATTEMPT_ID, QUESTION_ID, QUIZ_ID, REQUEST_ID, SCHOOL_ID } from './support/seeds'
import {
  REUPLOAD_CLOSED_MESSAGE,
  buildReuploadPath,
  canRequestReupload,
  cancelReupload,
  effectiveReuploadStatus,
  isAwaitingImageReview,
  isRequestOpen,
  isValidReuploadPath,
  loadMyReuploadRequests,
  requestReupload,
  submitReupload,
} from '../src/lib/reuploads'
import { validateSubmissionImage } from '../src/lib/submissionUploads'
import type { ReuploadRequest } from '../src/types'

vi.mock('../src/lib/supabase', async () => {
  const { stub: client } = await import('./support/stubSupabase')
  return {
    supabase: client.client,
    isSupabaseConfigured: true,
    internalAuthIdentifier: (value: string) => `${value.trim().toLowerCase()}@auth.latequiz.internal`,
  }
})

beforeEach(() => stub.reset())

const NOW = new Date('2026-10-20T12:00:00.000Z')
const at = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1000).toISOString()
const ctx = { schoolId: SCHOOL_ID, attemptId: ATTEMPT_ID, questionId: QUESTION_ID, requestId: REQUEST_ID }

const studentRequest = (deadline: string | null = null): ReuploadRequest => ({
  id: REQUEST_ID,
  attemptId: ATTEMPT_ID,
  quizId: QUIZ_ID,
  quizTitle: 'Data Representation',
  questionId: QUESTION_ID,
  questionNumber: 4,
  prompt: 'Upload your diagram.',
  originalFileName: 'diagram.png',
  deadline,
  requestedAt: '2026-10-19T08:00:00.000Z',
})

const png = () => new File([new Uint8Array(2048)], 'diagram.png', { type: 'image/png' })
const storageCalls = (method: string) =>
  stub.calls.filter((call) => call.kind === 'storage' && call.method === method) as Array<{ bucket: string; args: unknown[] }>
const rpcCalls = (name: string) => stub.calls.filter((call) => call.kind === 'rpc' && call.name === name)

// ---------------------------------------------------------------------------
// isRequestOpen / effectiveReuploadStatus
// ---------------------------------------------------------------------------

describe('isRequestOpen / effectiveReuploadStatus', () => {
  it.each([
    ['no deadline', null, true, 'open'],
    ['deadline 1 s in the past', at(-1), false, 'expired'],
    ['deadline equal to now', at(0), false, 'expired'],
    ['deadline 1 s ahead', at(1), true, 'open'],
  ] as const)('open request with %s', (_label, deadline, open, status) => {
    expect(isRequestOpen({ status: 'open', deadline }, NOW)).toBe(open)
    expect(effectiveReuploadStatus({ status: 'open', deadline }, NOW)).toBe(status)
  })

  it.each(['fulfilled', 'cancelled'] as const)('%s requests are never open regardless of deadline', (status) => {
    for (const deadline of [null, at(-1), at(0), at(3600)]) {
      expect(isRequestOpen({ status, deadline }, NOW)).toBe(false)
      expect(effectiveReuploadStatus({ status, deadline }, NOW)).toBe(status)
    }
  })
})

// ---------------------------------------------------------------------------
// canRequestReupload
// ---------------------------------------------------------------------------

describe('canRequestReupload', () => {
  const base = { questionType: 'upload', filePath: 'diagram.png', attemptStatus: 'submitted', requests: [], now: NOW }

  it.each(['submitted', 'expired', 'reviewed'])('true for a legacy upload answer on a %s attempt', (attemptStatus) => {
    expect(canRequestReupload({ ...base, attemptStatus })).toBe(true)
  })

  it.each(['in_progress', 'cancelled'])('false on a %s attempt', (attemptStatus) => {
    expect(canRequestReupload({ ...base, attemptStatus })).toBe(false)
  })

  it('false for real paths, empty paths, and non-upload questions', () => {
    for (const filePath of [`${SCHOOL_ID}/${ATTEMPT_ID}/${QUESTION_ID}_x.png`, '', '   ', null, undefined]) {
      expect(canRequestReupload({ ...base, filePath })).toBe(false)
    }
    for (const questionType of ['essay', 'multiple-choice', 'identification']) {
      expect(canRequestReupload({ ...base, questionType })).toBe(false)
    }
  })

  it('false with an open unexpired request, true again once it has lapsed', () => {
    expect(canRequestReupload({ ...base, requests: [{ status: 'open', deadline: at(60) }] })).toBe(false)
    expect(canRequestReupload({ ...base, requests: [{ status: 'open', deadline: null }] })).toBe(false)
    expect(canRequestReupload({ ...base, requests: [{ status: 'open', deadline: at(-60) }] })).toBe(true)
    expect(canRequestReupload({ ...base, requests: [{ status: 'cancelled', deadline: null }] })).toBe(true)
  })

  it('equals the spec eligibility predicate (PBT)', () => {
    const statuses = ['open', 'fulfilled', 'cancelled'] as const
    const input = fc.record({
      questionType: fc.constantFrom('multiple-choice', 'identification', 'essay', 'upload'),
      filePath: fc.oneof(
        fc.stringMatching(/^[A-Za-z0-9 _().-]{1,30}$/).filter((name) => name.trim().length > 0),
        fc.tuple(fc.uuid(), fc.uuid()).map(([a, b]) => `${SCHOOL_ID}/${a}/${b}.png`),
        fc.constant(''),
        fc.constant(null),
      ),
      attemptStatus: fc.constantFrom('in_progress', 'submitted', 'expired', 'reviewed', 'cancelled'),
      requests: fc.array(
        fc.record({
          status: fc.constantFrom(...statuses),
          deadline: fc.oneof(fc.constant(null), fc.integer({ min: -86400, max: 86400 }).map(at)),
        }),
        { maxLength: 3 },
      ),
    })
    fc.assert(
      fc.property(input, (value) => {
        const expected = value.questionType === 'upload'
          && Boolean(value.filePath) && !String(value.filePath).includes('/')
          && ['submitted', 'expired', 'reviewed'].includes(value.attemptStatus)
          && !value.requests.some((r) => r.status === 'open' && (r.deadline === null || new Date(r.deadline) > NOW))
        expect(canRequestReupload({ ...value, now: NOW })).toBe(expected)
      }),
      { numRuns: 300 },
    )
  })
})

// ---------------------------------------------------------------------------
// Request lifecycle model (PBT)
// ---------------------------------------------------------------------------

type ModelRequest = { status: 'open' | 'fulfilled' | 'cancelled'; deadline: string | null }
type Action =
  | { kind: 'request'; deadlineOffset: number | null }
  | { kind: 'cancel' }
  | { kind: 'fulfill' }
  | { kind: 'tick'; seconds: number }

describe('request lifecycle model (PBT)', () => {
  it('fulfills only open, unexpired requests; fulfilled/cancelled are terminal; at most one open per answer', () => {
    const action: fc.Arbitrary<Action> = fc.oneof(
      fc.record({ kind: fc.constant('request' as const), deadlineOffset: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 600 })) }),
      fc.constant({ kind: 'cancel' as const }),
      fc.constant({ kind: 'fulfill' as const }),
      fc.record({ kind: fc.constant('tick' as const), seconds: fc.integer({ min: 1, max: 900 }) }),
    )
    fc.assert(
      fc.property(fc.array(action, { maxLength: 25 }), (actions) => {
        let now = NOW
        let filePath = 'diagram.png'
        const requests: ModelRequest[] = []
        const openOne = () => requests.find((r) => r.status === 'open')

        for (const step of actions) {
          const terminalBefore = requests.map((r) => (r.status === 'open' ? null : r.status))
          if (step.kind === 'tick') now = new Date(now.getTime() + step.seconds * 1000)
          if (step.kind === 'request') {
            const allowed = canRequestReupload({ questionType: 'upload', filePath, attemptStatus: 'submitted', requests, now })
            if (allowed) {
              const lapsed = openOne()
              if (lapsed) lapsed.status = 'cancelled' // server closes a lapsed open request as cancelled/expired
              const deadline = step.deadlineOffset === null ? null : new Date(now.getTime() + step.deadlineOffset * 1000).toISOString()
              requests.push({ status: 'open', deadline })
            }
          }
          if (step.kind === 'cancel') {
            const current = openOne()
            if (current) current.status = 'cancelled'
          }
          if (step.kind === 'fulfill') {
            const current = requests[requests.length - 1]
            if (current && isRequestOpen(current, now)) {
              current.status = 'fulfilled'
              filePath = buildReuploadPath(SCHOOL_ID, ATTEMPT_ID, QUESTION_ID, REQUEST_ID, 'png')
            } else if (current) {
              expect(effectiveReuploadStatus(current, now)).not.toBe('open')
            }
          }

          expect(requests.filter((r) => r.status === 'open').length).toBeLessThanOrEqual(1)
          terminalBefore.forEach((status, index) => {
            if (status) expect(requests[index].status).toBe(status)
          })
          if (requests.some((r) => r.status === 'fulfilled')) {
            expect(canRequestReupload({ questionType: 'upload', filePath, attemptStatus: 'submitted', requests, now })).toBe(false)
          }
        }
      }),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// buildReuploadPath / isValidReuploadPath
// ---------------------------------------------------------------------------

describe('buildReuploadPath / isValidReuploadPath', () => {
  it('builds the canonical path with a lowercase uuid and accepts it', () => {
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      const path = buildReuploadPath(SCHOOL_ID, ATTEMPT_ID, QUESTION_ID, REQUEST_ID, ext)
      expect(path).toMatch(new RegExp(`^${SCHOOL_ID}/${ATTEMPT_ID}/${QUESTION_ID}_${REQUEST_ID}_[0-9a-f-]{36}\\.${ext}$`))
      expect(isValidReuploadPath(path, ctx)).toBe(true)
    }
  })

  it('rejects wrong school/attempt, swapped ids, traversal, extra folders, bad extensions', () => {
    const uuid = '0f0e0d0c-0b0a-4908-8706-050403020100'
    const good = `${SCHOOL_ID}/${ATTEMPT_ID}/${QUESTION_ID}_${REQUEST_ID}_${uuid}.png`
    expect(isValidReuploadPath(good, ctx)).toBe(true)
    const bad = [
      `S-9999/${ATTEMPT_ID}/${QUESTION_ID}_${REQUEST_ID}_${uuid}.png`,
      `${SCHOOL_ID}/${QUIZ_ID}/${QUESTION_ID}_${REQUEST_ID}_${uuid}.png`,
      `${SCHOOL_ID}/${ATTEMPT_ID}/${REQUEST_ID}_${QUESTION_ID}_${uuid}.png`,
      `${SCHOOL_ID}/${ATTEMPT_ID}/${QUESTION_ID}_${REQUEST_ID}_../${uuid}.png`,
      `${SCHOOL_ID}/${ATTEMPT_ID}/${QUESTION_ID}_${REQUEST_ID}_extra/${uuid}.png`,
      `${SCHOOL_ID}/extra/${ATTEMPT_ID}/${QUESTION_ID}_${REQUEST_ID}_${uuid}.png`,
      `${SCHOOL_ID}/${ATTEMPT_ID}/${QUESTION_ID}_${REQUEST_ID}_${uuid}.PNG`,
      `${SCHOOL_ID}/${ATTEMPT_ID}/${QUESTION_ID}_${REQUEST_ID}_${uuid}`,
      `${SCHOOL_ID}/${ATTEMPT_ID}/${QUESTION_ID}_${REQUEST_ID}_${uuid}.gif`,
      `${SCHOOL_ID}/${ATTEMPT_ID}/${QUESTION_ID}_${REQUEST_ID}_${uuid.toUpperCase()}.png`,
      null,
    ]
    for (const path of bad) expect(isValidReuploadPath(path, ctx)).toBe(false)
  })

  it('accepts exactly the unmutated canonical form across generated mutations (PBT)', () => {
    const mutation = fc.oneof(
      fc.record({ kind: fc.constant('insert' as const), at: fc.nat(), text: fc.constantFrom('/', '..', 'x', '_', 'A', '.') }),
      fc.record({ kind: fc.constant('delete' as const), at: fc.nat() }),
      fc.record({ kind: fc.constant('replace' as const), at: fc.nat(), text: fc.constantFrom('/', 'Z', '.', '_', ' ') }),
      fc.record({ kind: fc.constant('ext' as const), text: fc.constantFrom('gif', 'PNG', 'pdf', 'png.exe', '') }),
    )
    fc.assert(
      // 'jpeg' is left out: deleting its 'e' yields the also-canonical 'jpg'.
      fc.property(fc.constantFrom('jpg', 'png', 'webp'), mutation, (ext, m) => {
        const path = buildReuploadPath(SCHOOL_ID, ATTEMPT_ID, QUESTION_ID, REQUEST_ID, ext)
        expect(isValidReuploadPath(path, ctx)).toBe(true)
        let mutated: string
        if (m.kind === 'ext') {
          mutated = path.slice(0, path.lastIndexOf('.') + 1) + m.text
        } else {
          const index = m.at % (path.length + (m.kind === 'insert' ? 1 : 0))
          if (m.kind === 'insert') mutated = path.slice(0, index) + m.text + path.slice(index)
          else if (m.kind === 'delete') mutated = path.slice(0, index) + path.slice(index + 1)
          else mutated = path.slice(0, index) + m.text + path.slice(index + 1)
        }
        fc.pre(mutated !== path)
        expect(isValidReuploadPath(mutated, ctx)).toBe(false)
      }),
      { numRuns: 300 },
    )
  })
})

// ---------------------------------------------------------------------------
// isAwaitingImageReview
// ---------------------------------------------------------------------------

describe('isAwaitingImageReview', () => {
  const fulfilled = { status: 'fulfilled', fulfilledAt: at(0) }

  it('true when not reviewed or reviewed before the fulfillment', () => {
    expect(isAwaitingImageReview({ reviewedAt: null }, fulfilled)).toBe(true)
    expect(isAwaitingImageReview({}, fulfilled)).toBe(true)
    expect(isAwaitingImageReview({ reviewedAt: at(-3600) }, fulfilled)).toBe(true)
  })

  it('false when reviewed after the fulfillment or the latest request is not fulfilled', () => {
    expect(isAwaitingImageReview({ reviewedAt: at(60) }, fulfilled)).toBe(false)
    for (const status of ['open', 'cancelled']) {
      expect(isAwaitingImageReview({ reviewedAt: null }, { status, fulfilledAt: null })).toBe(false)
    }
    expect(isAwaitingImageReview({ reviewedAt: null }, null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// RPC wrappers
// ---------------------------------------------------------------------------

describe('loadMyReuploadRequests', () => {
  it('maps LQ_my_reupload_requests rows to ReuploadRequest', async () => {
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
        deadline: null,
        requested_at: '2026-10-19T08:00:00.000Z',
      }],
      error: null,
    }))
    expect(await loadMyReuploadRequests()).toEqual([studentRequest(null)])
  })

  it('throws the RPC error', async () => {
    stub.onRpc('LQ_my_reupload_requests', () => ({ data: null, error: { message: 'boom' } }))
    await expect(loadMyReuploadRequests()).rejects.toEqual({ message: 'boom' })
  })
})

describe('requestReupload / cancelReupload', () => {
  const row = {
    id: REQUEST_ID,
    attempt_id: ATTEMPT_ID,
    question_id: QUESTION_ID,
    answer_id: ANSWER_ID,
    original_file_name: 'diagram.png',
    requested_at: at(0),
    deadline: null,
    status: 'open',
    fulfilled_at: null,
    fulfilled_path: null,
    cancelled_at: null,
    cancel_reason: null,
  }

  it('calls LQ_request_reupload and maps the row', async () => {
    stub.onRpc('LQ_request_reupload', () => ({ data: row, error: null }))
    const deadline = at(3600)
    const result = await requestReupload(ANSWER_ID, deadline, NOW)
    expect(result.error).toBeNull()
    expect(result.request).toMatchObject({ id: REQUEST_ID, answerId: ANSWER_ID, status: 'open', originalFileName: 'diagram.png' })
    expect(rpcCalls('LQ_request_reupload').map((call) => (call as { args: unknown }).args)).toEqual([{ p_answer_id: ANSWER_ID, p_deadline: deadline }])
  })

  it('rejects a non-future deadline without calling the RPC', async () => {
    for (const deadline of [at(0), at(-1)]) {
      const result = await requestReupload(ANSWER_ID, deadline, NOW)
      expect(result.error).toBeInstanceOf(Error)
    }
    expect(stub.calls).toEqual([])
  })

  it('cancels and removes only orphaned objects in the request slot', async () => {
    stub.onRpc('LQ_cancel_reupload', () => ({ data: { ...row, status: 'cancelled', cancelled_at: at(1), cancel_reason: 'admin' }, error: null }))
    const orphan = `${QUESTION_ID}_${REQUEST_ID}_0f0e0d0c-0b0a-4908-8706-050403020100.png`
    stub.onStorage((method) => (method === 'list'
      ? { data: [{ name: orphan }, { name: `${QUESTION_ID}_other.png` }], error: null }
      : undefined))
    const result = await cancelReupload(REQUEST_ID, { schoolId: SCHOOL_ID })
    expect(result.error).toBeNull()
    expect(result.request?.status).toBe('cancelled')
    expect(rpcCalls('LQ_cancel_reupload').map((call) => (call as { args: unknown }).args)).toEqual([{ p_request_id: REQUEST_ID }])
    expect(storageCalls('list')[0].args[0]).toBe(`${SCHOOL_ID}/${ATTEMPT_ID}`)
    expect(storageCalls('remove').map((call) => call.args[0])).toEqual([[`${SCHOOL_ID}/${ATTEMPT_ID}/${orphan}`]])
  })
})

// ---------------------------------------------------------------------------
// submitReupload
// ---------------------------------------------------------------------------

describe('submitReupload', () => {
  it('uploads then fulfills with the same path and removes nothing on success', async () => {
    stub.onRpc('LQ_fulfill_reupload', () => ({ data: { status: 'fulfilled' }, error: null }))
    const result = await submitReupload({ request: studentRequest(), schoolId: SCHOOL_ID, file: png() })
    expect(result.error).toBeNull()
    expect(isValidReuploadPath(result.path, ctx)).toBe(true)
    const [upload] = storageCalls('upload')
    expect(upload.bucket).toBe('lq-submissions')
    expect(upload.args[0]).toBe(result.path)
    expect(upload.args[2]).toEqual({ contentType: 'image/png', upsert: false })
    expect(rpcCalls('LQ_fulfill_reupload').map((call) => (call as { args: unknown }).args)).toEqual([{ p_request_id: REQUEST_ID, p_path: result.path }])
    expect(storageCalls('remove')).toEqual([])
  })

  it('rejects an invalid file with the shared validation message and no storage or RPC call', async () => {
    const file = new File([new Uint8Array(10)], 'essay.pdf', { type: 'application/pdf' })
    const result = await submitReupload({ request: studentRequest(), schoolId: SCHOOL_ID, file })
    const expected = validateSubmissionImage(file)
    expect(expected.ok).toBe(false)
    if (!expected.ok) expect((result.error as Error).message).toBe(expected.message)
    expect(stub.calls).toEqual([])
  })

  it('rejects a lapsed request with no storage or RPC call', async () => {
    const result = await submitReupload({ request: studentRequest(at(0)), schoolId: SCHOOL_ID, file: png(), now: NOW })
    expect((result.error as Error).message).toBe(REUPLOAD_CLOSED_MESSAGE)
    expect(stub.calls).toEqual([])
  })

  it('does not call the RPC when the upload fails; maps an RLS denial to the closed message', async () => {
    stub.onStorage((method) => (method === 'upload' ? { data: null, error: { statusCode: '403', message: 'new row violates row-level security policy' } } : undefined))
    const result = await submitReupload({ request: studentRequest(), schoolId: SCHOOL_ID, file: png() })
    expect((result.error as Error).message).toBe(REUPLOAD_CLOSED_MESSAGE)
    expect(rpcCalls('LQ_fulfill_reupload')).toEqual([])
    expect(storageCalls('remove')).toEqual([])
  })

  it('removes the uploaded object once and returns the RPC error when fulfill fails (PBT)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('png', 'jpg', 'jpeg', 'webp'), fc.string({ minLength: 1, maxLength: 40 }), async (ext, message) => {
        stub.reset()
        const rpcError = { message }
        stub.onRpc('LQ_fulfill_reupload', () => ({ data: null, error: rpcError }))
        const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
        const file = new File([new Uint8Array(512)], `diagram.${ext}`, { type })
        const result = await submitReupload({ request: studentRequest(), schoolId: SCHOOL_ID, file })
        expect(result).toEqual({ path: null, error: rpcError })
        const uploaded = storageCalls('upload')[0].args[0]
        expect(storageCalls('remove').map((call) => call.args[0])).toEqual([[uploaded]])
      }),
      { numRuns: 50 },
    )
  })
})

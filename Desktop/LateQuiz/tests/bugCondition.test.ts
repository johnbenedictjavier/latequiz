/**
 * Property 1: Bug Condition - Alternative identification keys are rejected,
 * blank keys save, uploads store names only, legacy uploads cannot be recovered.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 1.8, 1.12
 * (expected behavior: 2.2, 2.3, 2.4, 2.5, 2.7, 2.8, 2.13)
 *
 * These tests encode the EXPECTED behavior. On unfixed code they FAIL, which
 * confirms the bug. They are re-run unchanged in task 3.16 to confirm the fix.
 *
 * Counterexamples observed on UNFIXED code (npm test, task 1):
 * - Grading (1.3/1.4): the schema stores one `answer_key`, and both edge
 *   functions compare `normalize(answer) === normalize(key)`.
 *   `originalGrade('cpu', 'Central Processing Unit') === false`, so keys
 *   ["Central Processing Unit", "CPU"] with answer "cpu" score 0 points.
 *   fast-check counterexample (shrunk): keys ["A", "B"], index 1, answer
 *   "b", points 1 -> { is_correct: false, points_awarded: 0 }.
 * - Save (1.5): `saveQuiz` accepts key fields ["  "], [], ["A", " "], and
 *   ["RAM", " ram "]: it returns a quiz id with `error: null` and upserts
 *   `answer_key: question.answer?.trim() || null` (null for blanks).
 * - Upload (1.7/1.8): `src/lib/submissionUploads.ts` does not exist
 *   ("Cannot find module .../src/lib/submissionUploads.ts"); the
 *   QuestionInput handler stores `file.name`, so `file_path === 'diagram.png'`
 *   with no stored object, and a PDF or a 14 MB JPEG is never validated.
 * - Legacy review (1.12): `mapAnswer` returns `answer: 'diagram.png'` as plain
 *   text with no `filePath` and no legacy flag, so the drawer cannot show the
 *   "never stored" notice.
 *
 * Deferred to the env-gated e2e suite (task 3.15, needs a live Supabase
 * project; not run here because no LATEQUIZ_E2E_* env vars are configured):
 * alternative key graded through `finalize-expired-attempts`; deleting a
 * submission leaves objects in `lq-submissions`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { Question } from '../src/types'
import { stub, isWrite, opArgs } from './support/stubSupabase'
import { loadModule, tryLoadModule } from './support/loadModule'
import { ATTEMPT_ID, QUESTION_ID, SCHOOL_ID, seedLegacySubmission } from './support/seeds'

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
// Original grading, copied verbatim from supabase/functions/submit-attempt/index.ts
// ---------------------------------------------------------------------------

function normalize(value: string | null | undefined) {
  return (value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

function originalGrade(answer: string | null | undefined, key: string | null | undefined) {
  return normalize(answer) === normalize(key)
}

type AnswerKeysModule = { matchesAnyKey: (answer: string | null | undefined, keys: string[]) => boolean }

/**
 * Grades one identification question the way the grading loop does
 * (`hasResponse && <comparison>`, full points when correct).
 *
 * Unfixed code: `LQ_question_keys.answer_key` holds a single text value, so
 * the grader only ever sees `keys[0]` and uses `originalGrade`.
 * Fixed code: the shared module `supabase/functions/_shared/answerKeys.ts`
 * provides `matchesAnyKey` over the stored `answer_keys` array.
 */
async function gradeIdentification(answerText: string, keys: string[], points: number) {
  const shared = await tryLoadModule<AnswerKeysModule>('../supabase/functions/_shared/answerKeys.ts')
  const hasResponse = Boolean(answerText)
  const correct = shared
    ? hasResponse && shared.matchesAnyKey(answerText, keys)
    : hasResponse && originalGrade(answerText, keys[0])
  return { is_correct: correct, points_awarded: correct ? points : 0 }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const word = fc.stringMatching(/^[A-Za-z0-9]{1,10}$/)
const keyText = fc.array(word, { minLength: 1, maxLength: 3 }).map((words) => words.join(' '))

/** 2-4 keys with pairwise distinct normalized forms (a valid key list). */
const keyList = fc.uniqueArray(keyText, { minLength: 2, maxLength: 4, selector: (key) => normalize(key) })

const whitespace = fc.constantFrom(' ', '  ', '\t', '\n', ' \t ')

/** Case, padding, and internal whitespace variants that normalize to the same value. */
function variantOf(key: string) {
  return fc
    .record({
      caseFlips: fc.array(fc.boolean(), { minLength: key.length, maxLength: key.length }),
      lead: fc.option(whitespace, { nil: '' }),
      trail: fc.option(whitespace, { nil: '' }),
      gap: whitespace,
    })
    .map(({ caseFlips, lead, trail, gap }) => {
      const cased = [...key].map((ch, index) => (caseFlips[index] ? ch.toUpperCase() : ch.toLowerCase())).join('')
      return `${lead}${cased.split(' ').join(gap)}${trail}`
    })
}

/** GradeInput satisfying isBugCondition: only an alternative key (index > 0) matches. */
const alternativeKeyCase = keyList.chain((keys) =>
  fc.integer({ min: 1, max: keys.length - 1 }).chain((index) =>
    fc.tuple(fc.constant(keys), fc.constant(index), variantOf(keys[index]), fc.integer({ min: 1, max: 10 })),
  ),
)

// ---------------------------------------------------------------------------
// GradeInput (1.3, 1.4 -> 2.3, 2.4)
// ---------------------------------------------------------------------------

describe('Bug condition: alternative identification keys', () => {
  it('grades any alternative key variant as correct with full points (PBT)', async () => {
    await fc.assert(
      fc.asyncProperty(alternativeKeyCase, async ([keys, index, answer, points]) => {
        // Preconditions of isBugCondition(GradeInput)
        expect(normalize(answer)).not.toBe('')
        expect(normalize(answer)).toBe(normalize(keys[index]))
        expect(normalize(answer)).not.toBe(normalize(keys[0]))

        const result = await gradeIdentification(answer, keys, points)
        expect(result).toEqual({ is_correct: true, points_awarded: points })
      }),
      { numRuns: 100 },
    )
  })

  it('grades "cpu" correct for keys ["Central Processing Unit", "CPU"]', async () => {
    const result = await gradeIdentification('cpu', ['Central Processing Unit', 'CPU'], 2)
    expect(result).toEqual({ is_correct: true, points_awarded: 2 })
  })
})

// ---------------------------------------------------------------------------
// SaveInput (1.2, 1.5 -> 2.2, 2.5)
// ---------------------------------------------------------------------------

describe('Bug condition: identification key validation on save', () => {
  const invalidKeyFields: Array<[string, string[]]> = [
    ['a single blank field', ['  ']],
    ['no key fields', []],
    ['a blank second field', ['A', ' ']],
    ['normalized duplicates', ['RAM', ' ram ']],
  ]

  it.each(invalidKeyFields)('rejects %s with a validation message', async (_label, keyFields) => {
    const { saveQuiz } = await import('../src/lib/admin')
    const question = {
      id: 'q-new-1',
      type: 'identification',
      prompt: 'What does CPU stand for?',
      points: 1,
      answer: keyFields[0] ?? '',
      answers: keyFields,
    } as Question & { answers: string[] }

    const result = await saveQuiz({
      title: 'Data Representation',
      subject: 'Computer Science',
      description: '',
      passingScore: 75,
      durationMinutes: 30,
      status: 'draft',
      parts: [{ id: 'part-new-1', title: 'Part 1', position: 1, questions: [question] }],
    })

    expect(result.id).toBeNull()
    expect(result.error).toBeInstanceOf(Error)
    expect((result.error as Error).message.length).toBeGreaterThan(0)
    const keyWrites = stub.calls.filter((call) => call.kind === 'from' && call.table === 'LQ_question_keys' && isWrite(call))
    expect(keyWrites).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// UploadInput (1.7, 1.8 -> 2.7, 2.8)
// ---------------------------------------------------------------------------

type ValidationResult = { ok: true; ext: string } | { ok: false; message: string }

type SubmissionUploadsModule = {
  validateSubmissionImage: (file: { name: string; type: string; size: number }) => ValidationResult
  isLegacyFileName: (value: string | null | undefined) => boolean
  uploadSubmissionImage: (input: {
    attemptId: string
    schoolId: string
    questionId: string
    file: File
    previousPath?: string | null
  }) => Promise<unknown>
}

const SUBMISSION_UPLOADS = '../src/lib/submissionUploads.ts'

describe('Bug condition: upload answers', () => {
  it('stores diagram.png under {school_id}/{attempt_id}/ and saves that object path as file_path', async () => {
    const { uploadSubmissionImage } = await loadModule<SubmissionUploadsModule>(SUBMISSION_UPLOADS)
    const file = new File([new Uint8Array(2048)], 'diagram.png', { type: 'image/png' })

    await uploadSubmissionImage({ attemptId: ATTEMPT_ID, schoolId: SCHOOL_ID, questionId: QUESTION_ID, file, previousPath: null })

    const uploads = stub.calls.filter((call) => call.kind === 'storage' && call.method === 'upload')
    expect(uploads).toHaveLength(1)
    const upload = uploads[0] as { bucket: string; args: unknown[] }
    expect(upload.bucket).toBe('lq-submissions')
    const objectPath = String(upload.args[0])
    expect(objectPath).toContain('/')
    expect(objectPath.startsWith(`${SCHOOL_ID}/${ATTEMPT_ID}/`)).toBe(true)

    const answerWrite = stub.calls.find((call) => call.kind === 'from' && call.table === 'LQ_answers' && isWrite(call))
    expect(answerWrite).toBeDefined()
    const payload = (opArgs(answerWrite as { ops: { method: string; args: unknown[] }[] }, 'upsert')
      ?? opArgs(answerWrite as { ops: { method: string; args: unknown[] }[] }, 'update'))?.[0] as { file_path?: string }
    expect(payload?.file_path).toBe(objectPath)
    expect(payload?.file_path).not.toBe('diagram.png')
  })

  it('rejects a PDF before uploading', async () => {
    const { validateSubmissionImage } = await loadModule<SubmissionUploadsModule>(SUBMISSION_UPLOADS)
    const result = validateSubmissionImage({ name: 'essay.pdf', type: 'application/pdf', size: 200_000 })
    expect(result.ok).toBe(false)
  })

  it('rejects a 14 MB JPEG before uploading', async () => {
    const { validateSubmissionImage } = await loadModule<SubmissionUploadsModule>(SUBMISSION_UPLOADS)
    const result = validateSubmissionImage({ name: 'photo.jpg', type: 'image/jpeg', size: 14 * 1024 * 1024 })
    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Legacy review (1.12 -> 2.13)
// ---------------------------------------------------------------------------

describe('Bug condition: legacy upload answers in review', () => {
  it('flags a bare file_path "diagram.png" as a legacy file name so the drawer shows the never-stored notice', async () => {
    seedLegacySubmission({ attemptStatus: 'submitted' })
    const { loadAdminSubmissions } = await import('../src/lib/submissions')
    const submissions = await loadAdminSubmissions()
    expect(submissions).toHaveLength(1)
    const answer = submissions[0].answers[0] as unknown as { filePath?: string | null }

    expect(answer.filePath).toBe('diagram.png')
    const { isLegacyFileName } = await loadModule<SubmissionUploadsModule>(SUBMISSION_UPLOADS)
    expect(isLegacyFileName(answer.filePath)).toBe(true)
  })
})

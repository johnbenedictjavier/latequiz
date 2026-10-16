/**
 * Property 2: Preservation - Single-key grading, normalization, MC/essay/upload
 * routing, scoring, and legacy-delete storage behavior unchanged.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.14, 3.16
 * (design Properties 3 and 4)
 *
 * Inputs here are those where isBugCondition returns false: single-key
 * identification, multiple-choice, essay, upload, manual-review-flagged, and
 * blank answers; deleting attempts whose upload answers hold bare names.
 *
 * Observation-first: the fixed vectors below were recorded by running this
 * file against UNFIXED code (task 2) and must keep passing after the fix
 * (task 3.17, re-run unchanged).
 *
 * Swap-in: the "fixed" side loads `supabase/functions/_shared/answerKeys.ts`
 * with tryLoadModule. On unfixed code the module does not exist and both sides
 * use the original comparison. After task 3.2/3.3 the fixed side uses
 * `normalize`, `matchesAnyKey`, and `toKeyList` from the shared module, and
 * `gradeFixed` mirrors the edited edge-function loop (`question_id,
 * answer_keys` rows, `matchesAnyKey(answer_text, keysByQuestion.get(id) ?? [])`).
 * `deleteSubmission` is called with `{ id, schoolId }` once task 3.9 changes
 * its signature (detected from the module source).
 *
 * Live-project preservation checks go in the env-gated e2e suite (task 3.15),
 * not here: student `select` on `LQ_question_keys` returns zero rows (3.13);
 * avatar upload/remove unchanged (3.12); deleting an attempt without uploads
 * writes one `submission_deleted` row and makes no storage removal (3.11);
 * `lq-submissions` stays private (3.10); stored attempts are not regraded
 * after key changes (3.14); the migration leaves `LQ_answers.file_path` bare
 * names byte-for-byte (3.15). Not run in task 2: no LATEQUIZ_E2E_* env vars
 * are configured, so no live baseline was recorded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import submissionsSource from '../src/lib/submissions.ts?raw'
import { stub } from './support/stubSupabase'
import { tryLoadModule } from './support/loadModule'
import { ATTEMPT_ID, SCHOOL_ID, seedLegacySubmission } from './support/seeds'

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
// Original code, copied verbatim from supabase/functions/submit-attempt/index.ts
// ---------------------------------------------------------------------------

function normalize(value: string | null | undefined) {
  return (value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

type QuestionRow = { id: string; part_id: string | null; question_type: string; points: number; requires_manual_review: boolean }
type AnswerRow = { id: string; question_id: string; answer_text: string | null; file_path: string | null }
type PartRow = { id: string; title: string; position: number }

type GradeOutput = {
  answerUpdates: Array<{ id: string; is_correct: boolean; points_awarded: number }>
  auto_score: number
  earned_points: number
  possible_points: number
  manual_review: boolean
  manual_items: number
  part_scores: Array<{ part_id: string | null; part_title: string; position: number; points_possible: number; auto_points: number; final_points: number | null }>
  status: 'expired' | 'submitted'
  final_score: number | null
}

/**
 * The grading loop and score math from submit-attempt, with the
 * `LQ_answers.update(...)` call recorded instead of sent, and the attempt
 * update reduced to the graded columns.
 */
function gradeOriginal(
  questions: QuestionRow[],
  answers: AnswerRow[],
  keyByQuestion: Map<string, string | null>,
  parts: PartRow[],
  expired: boolean,
): GradeOutput {
  const answerUpdates: GradeOutput['answerUpdates'] = []
  let awarded = 0
  let total = 0
  let manualReview = false
  let manualItems = 0
  const answerByQuestion = new Map((answers ?? []).map((answer) => [answer.question_id, answer]))
  const partById = new Map((parts ?? []).map((part) => [part.id, part]))
  const partStats = new Map<string, { partId: string | null; title: string; position: number; possible: number; awarded: number; pending: boolean }>()

  const getPartStats = (partId: string | null) => {
    const key = partId ?? 'general'
    const existing = partStats.get(key)
    if (existing) return existing
    const part = partId ? partById.get(partId) : null
    const created = {
      partId,
      title: part?.title ?? 'General',
      position: part?.position ?? (parts?.length ?? 0) + 1,
      possible: 0,
      awarded: 0,
      pending: false,
    }
    partStats.set(key, created)
    return created
  }

  for (const question of questions ?? []) {
    const points = Number(question.points)
    total += points
    const stats = getPartStats(question.part_id)
    stats.possible += points
    const answer = answerByQuestion.get(question.id)
    const hasResponse = Boolean(answer?.answer_text || answer?.file_path)
    if (question.requires_manual_review || question.question_type === 'essay' || question.question_type === 'upload') {
      manualReview = true
      manualItems += 1
      stats.pending = true
      continue
    }

    const correct = hasResponse && normalize(answer?.answer_text) === normalize(keyByQuestion.get(question.id))
    if (correct) {
      awarded += points
      stats.awarded += points
    }
    if (answer) {
      answerUpdates.push({ id: answer.id, is_correct: correct, points_awarded: correct ? points : 0 })
    }
  }

  const autoScore = total ? Math.round((awarded / total) * 10000) / 100 : 0
  const partScores = [...partStats.values()]
    .sort((a, b) => a.position - b.position)
    .map((part) => ({
      part_id: part.partId,
      part_title: part.title,
      position: part.position,
      points_possible: part.possible,
      auto_points: part.awarded,
      final_points: part.pending ? null : part.awarded,
    }))

  return {
    answerUpdates,
    auto_score: autoScore,
    earned_points: awarded,
    possible_points: total,
    manual_review: manualReview,
    manual_items: manualItems,
    part_scores: partScores,
    status: expired ? 'expired' : 'submitted',
    final_score: manualReview ? null : autoScore,
  }
}

// ---------------------------------------------------------------------------
// Fixed side (swapped in by import once the shared module exists)
// ---------------------------------------------------------------------------

type AnswerKeysModule = {
  normalize: (value: string | null | undefined) => string
  matchesAnyKey: (answer: string | null | undefined, keys: string[]) => boolean
  toKeyList: (row: { answer_keys?: string[] | null } | null | undefined) => string[]
}

const loadShared = () => tryLoadModule<AnswerKeysModule>('../supabase/functions/_shared/answerKeys.ts')

/** Single-key comparison: `matchesAnyKey(a, [k])` after the fix, the original equality before. */
async function singleKeyMatch(answer: string, key: string) {
  const shared = await loadShared()
  return shared ? shared.matchesAnyKey(answer, [key]) : normalize(answer) === normalize(key)
}

/**
 * The same loop with the task 3.3 comparison. Key rows are what the migration
 * produces from a legacy single key: `answer_keys = ARRAY[answer_key]`, or
 * null when `answer_key` was null.
 */
async function gradeFixed(
  questions: QuestionRow[],
  answers: AnswerRow[],
  keyByQuestion: Map<string, string | null>,
  parts: PartRow[],
  expired: boolean,
): Promise<GradeOutput> {
  const shared = await loadShared()
  if (!shared) return gradeOriginal(questions, answers, keyByQuestion, parts, expired)

  const keyRows = [...keyByQuestion].map(([question_id, key]) => ({ question_id, answer_keys: key === null ? null : [key] }))
  const keysByQuestion = new Map(keyRows.map((row) => [row.question_id, shared.toKeyList(row)]))

  const answerUpdates: GradeOutput['answerUpdates'] = []
  let awarded = 0
  let total = 0
  let manualReview = false
  let manualItems = 0
  const answerByQuestion = new Map((answers ?? []).map((answer) => [answer.question_id, answer]))
  const partById = new Map((parts ?? []).map((part) => [part.id, part]))
  const partStats = new Map<string, { partId: string | null; title: string; position: number; possible: number; awarded: number; pending: boolean }>()
  const getPartStats = (partId: string | null) => {
    const key = partId ?? 'general'
    const existing = partStats.get(key)
    if (existing) return existing
    const part = partId ? partById.get(partId) : null
    const created = { partId, title: part?.title ?? 'General', position: part?.position ?? (parts?.length ?? 0) + 1, possible: 0, awarded: 0, pending: false }
    partStats.set(key, created)
    return created
  }
  for (const question of questions ?? []) {
    const points = Number(question.points)
    total += points
    const stats = getPartStats(question.part_id)
    stats.possible += points
    const answer = answerByQuestion.get(question.id)
    const hasResponse = Boolean(answer?.answer_text || answer?.file_path)
    if (question.requires_manual_review || question.question_type === 'essay' || question.question_type === 'upload') {
      manualReview = true
      manualItems += 1
      stats.pending = true
      continue
    }
    const correct = hasResponse && shared.matchesAnyKey(answer?.answer_text, keysByQuestion.get(question.id) ?? [])
    if (correct) {
      awarded += points
      stats.awarded += points
    }
    if (answer) answerUpdates.push({ id: answer.id, is_correct: correct, points_awarded: correct ? points : 0 })
  }
  const autoScore = total ? Math.round((awarded / total) * 10000) / 100 : 0
  const partScores = [...partStats.values()].sort((a, b) => a.position - b.position).map((part) => ({
    part_id: part.partId,
    part_title: part.title,
    position: part.position,
    points_possible: part.possible,
    auto_points: part.awarded,
    final_points: part.pending ? null : part.awarded,
  }))
  return {
    answerUpdates,
    auto_score: autoScore,
    earned_points: awarded,
    possible_points: total,
    manual_review: manualReview,
    manual_items: manualItems,
    part_scores: partScores,
    status: expired ? 'expired' : 'submitted',
    final_score: manualReview ? null : autoScore,
  }
}

// ---------------------------------------------------------------------------
// Fixed vectors (observed on unfixed code)
// ---------------------------------------------------------------------------

describe('Preservation: normalization vectors (3.2)', () => {
  const vectors: Array<[string, string]> = [
    ['  CPU  ', 'cpu'],
    ['Ｃｐｕ', 'cpu'],
    ['a\t\nb', 'a b'],
  ]

  it.each(vectors)('normalize(%j) === %j', async (input, expected) => {
    expect(normalize(input)).toBe(expected)
    const shared = await loadShared()
    if (shared) expect(shared.normalize(input)).toBe(expected)
  })
})

describe('Preservation: grading vectors (3.1, 3.3-3.8)', () => {
  const parts: PartRow[] = [{ id: 'p1', title: 'Part 1', position: 1 }, { id: 'p2', title: 'Part 2', position: 2 }]
  const questions: QuestionRow[] = [
    { id: 'q1', part_id: 'p1', question_type: 'identification', points: 2, requires_manual_review: false },
    { id: 'q2', part_id: 'p1', question_type: 'identification', points: 3, requires_manual_review: false },
    { id: 'q3', part_id: 'p1', question_type: 'multiple-choice', points: 1, requires_manual_review: false },
    { id: 'q4', part_id: 'p1', question_type: 'multiple-choice', points: 1, requires_manual_review: false },
    { id: 'q5', part_id: 'p2', question_type: 'essay', points: 5, requires_manual_review: false },
    { id: 'q6', part_id: 'p2', question_type: 'upload', points: 5, requires_manual_review: true },
    { id: 'q7', part_id: 'p2', question_type: 'identification', points: 2, requires_manual_review: true },
  ]
  const keys = new Map<string, string | null>([
    ['q1', 'cpu'],
    ['q2', 'RAM'],
    ['q3', 'Binary'],
    ['q4', 'Binary'],
    ['q5', null],
    ['q6', null],
    ['q7', 'ALU'],
  ])
  const answers: AnswerRow[] = [
    { id: 'a1', question_id: 'q1', answer_text: '  CPU  ', file_path: null },
    { id: 'a2', question_id: 'q2', answer_text: '', file_path: null },
    { id: 'a3', question_id: 'q3', answer_text: 'Binary', file_path: null },
    { id: 'a4', question_id: 'q4', answer_text: 'Decimal', file_path: null },
    { id: 'a5', question_id: 'q5', answer_text: 'An essay.', file_path: null },
    { id: 'a6', question_id: 'q6', answer_text: null, file_path: 'diagram.png' },
    { id: 'a7', question_id: 'q7', answer_text: 'alu', file_path: null },
  ]

  const recorded: GradeOutput = {
    answerUpdates: [
      { id: 'a1', is_correct: true, points_awarded: 2 },
      { id: 'a2', is_correct: false, points_awarded: 0 },
      { id: 'a3', is_correct: true, points_awarded: 1 },
      { id: 'a4', is_correct: false, points_awarded: 0 },
    ],
    auto_score: 15.79,
    earned_points: 3,
    possible_points: 19,
    manual_review: true,
    manual_items: 3,
    part_scores: [
      { part_id: 'p1', part_title: 'Part 1', position: 1, points_possible: 7, auto_points: 3, final_points: 3 },
      { part_id: 'p2', part_title: 'Part 2', position: 2, points_possible: 12, auto_points: 0, final_points: null },
    ],
    status: 'submitted',
    final_score: null,
  }

  it('single-key "  CPU  " vs "cpu" is correct; blank is 0; MC exact/other; essay/upload/manual-review skipped', async () => {
    expect(gradeOriginal(questions, answers, keys, parts, false)).toEqual(recorded)
    expect(await gradeFixed(questions, answers, keys, parts, false)).toEqual(recorded)
  })

  it('auto-graded-only quiz sets final_score = auto_score and status expired on timeout', async () => {
    const autoOnly = questions.slice(0, 4)
    const expected: GradeOutput = {
      answerUpdates: recorded.answerUpdates,
      auto_score: 42.86,
      earned_points: 3,
      possible_points: 7,
      manual_review: false,
      manual_items: 0,
      part_scores: [{ part_id: 'p1', part_title: 'Part 1', position: 1, points_possible: 7, auto_points: 3, final_points: 3 }],
      status: 'expired',
      final_score: 42.86,
    }
    expect(gradeOriginal(autoOnly, answers, keys, parts, true)).toEqual(expected)
    expect(await gradeFixed(autoOnly, answers, keys, parts, true)).toEqual(expected)
  })

  it('blank single-key identification answer is incorrect with 0 points', async () => {
    const q = [questions[0]]
    for (const blank of [null, '', '   ']) {
      const a: AnswerRow[] = [{ id: 'a1', question_id: 'q1', answer_text: blank, file_path: null }]
      const out = await gradeFixed(q, a, keys, parts, false)
      expect(out.answerUpdates).toEqual([{ id: 'a1', is_correct: false, points_awarded: 0 }])
      expect(out.final_score).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const toFullwidth = (value: string) =>
  [...value].map((ch) => (ch >= '!' && ch <= '~' ? String.fromCharCode(ch.charCodeAt(0) + 0xfee0) : ch)).join('')

const whitespace = fc.constantFrom(' ', '  ', '\t', '\n', '\u00a0', '\u3000', '\u2003')

const unicodeText = fc.oneof(
  fc.string({ unit: 'grapheme', maxLength: 12 }),
  fc.string({ unit: 'grapheme-ascii', maxLength: 12 }),
  fc.stringMatching(/^[A-Za-z0-9 ]{0,12}$/),
)

/** Case, fullwidth (compatibility form), and padding variants of a string. */
function variantOf(value: string) {
  return fc
    .record({ upper: fc.boolean(), fullwidth: fc.boolean(), lead: fc.option(whitespace, { nil: '' }), trail: fc.option(whitespace, { nil: '' }) })
    .map(({ upper, fullwidth, lead, trail }) => {
      let out = upper ? value.toUpperCase() : value.toLowerCase()
      if (fullwidth) out = toFullwidth(out)
      return `${lead}${out}${trail}`
    })
}

const answerKeyPair = fc.oneof(
  fc.tuple(unicodeText, unicodeText),
  unicodeText.chain((key) => fc.tuple(variantOf(key), fc.constant(key))),
)

/** A non-blank key (a blank identification key is isBugCondition(SaveInput)). */
const nonBlankKey = fc.oneof(fc.stringMatching(/^[A-Za-z0-9]{1,8}( [A-Za-z0-9]{1,8}){0,2}$/), fc.string({ unit: 'grapheme', minLength: 1, maxLength: 8 }))
  .filter((key) => normalize(key) !== '')

type GenQuestion = { question: QuestionRow; key: string | null; answer: AnswerRow | null }

function questionArb(index: number, partIds: string[]) {
  const id = `q${index}`
  const base = fc.record({
    part_id: fc.constantFrom<string | null>(null, ...partIds),
    points: fc.integer({ min: 0, max: 10 }),
    requires_manual_review: fc.constantFrom(false, false, false, true),
  })
  const blankOrMissing = fc.constantFrom<'missing' | null | '' | '   '>('missing', null, '', '   ')
  const answerRow = (answer_text: string | null, file_path: string | null = null): AnswerRow => ({ id: `a${index}`, question_id: id, answer_text, file_path })

  const multipleChoice = fc
    .uniqueArray(nonBlankKey, { minLength: 2, maxLength: 4, selector: (option) => normalize(option) })
    .chain((options) =>
      fc.record({
        base,
        key: fc.constantFrom(...options),
        pick: fc.oneof(fc.constantFrom(...options).map((text) => ({ text })), blankOrMissing.map((text) => ({ text }))),
      }),
    )
    .map(({ base: b, key, pick }): GenQuestion => ({
      question: { id, question_type: 'multiple-choice', ...b },
      key,
      answer: pick.text === 'missing' ? null : answerRow(pick.text),
    }))

  const identification = nonBlankKey
    .chain((key) =>
      fc.record({
        base,
        key: fc.constant(key),
        text: fc.oneof(variantOf(key), unicodeText, blankOrMissing),
        filePath: fc.constantFrom<string | null>(null, null, 'stray.png'),
      }),
    )
    .map(({ base: b, key, text, filePath }): GenQuestion => ({
      question: { id, question_type: 'identification', ...b },
      key,
      answer: text === 'missing' ? null : answerRow(text, filePath),
    }))

  const manual = fc
    .record({
      base,
      type: fc.constantFrom('essay', 'upload'),
      key: fc.option(nonBlankKey, { nil: null }),
      text: fc.oneof(unicodeText, blankOrMissing),
      filePath: fc.constantFrom<string | null>(null, 'diagram.png', `${SCHOOL_ID}/${ATTEMPT_ID}/q_x.png`),
    })
    .map(({ base: b, type, key, text, filePath }): GenQuestion => ({
      question: { id, question_type: type, ...b },
      key,
      answer: text === 'missing' ? null : type === 'upload' ? answerRow(null, filePath) : answerRow(text),
    }))

  return fc.oneof(multipleChoice, identification, manual)
}

const quizArb = fc
  .integer({ min: 0, max: 3 })
  .map((count) => Array.from({ length: count }, (_, i): PartRow => ({ id: `p${i + 1}`, title: `Part ${i + 1}`, position: i + 1 })))
  .chain((parts) =>
    fc.integer({ min: 1, max: 8 }).chain((count) =>
      fc.tuple(
        fc.constant(parts),
        fc.tuple(...Array.from({ length: count }, (_, i) => questionArb(i + 1, parts.map((part) => part.id)))),
        fc.boolean(),
      ),
    ),
  )

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('Preservation: single-key comparison (3.1, 3.2)', () => {
  it('matchesAnyKey(a, [k]) === (normalize(a) === normalize(k)) for Unicode strings (PBT)', async () => {
    await fc.assert(
      fc.asyncProperty(answerKeyPair, async ([answer, key]) => {
        expect(await singleKeyMatch(answer, key)).toBe(normalize(answer) === normalize(key))
        const shared = await loadShared()
        if (shared) {
          expect(shared.normalize(answer)).toBe(normalize(answer))
          expect(shared.normalize(key)).toBe(normalize(key))
        }
      }),
      { numRuns: 300 },
    )
  })
})

describe('Preservation: generated quiz grading (3.1, 3.3-3.8)', () => {
  it('fixed grading matches gradeOriginal for MC, single-key identification, essay, upload, manual-review, and blank answers (PBT)', async () => {
    await fc.assert(
      fc.asyncProperty(quizArb, async ([parts, generated, expired]) => {
        const questions = generated.map((item) => item.question)
        const answers = generated.flatMap((item) => (item.answer ? [item.answer] : []))
        const keys = new Map(generated.map((item) => [item.question.id, item.key]))

        const original = gradeOriginal(questions, answers, keys, parts, expired)
        // Routing invariants of the original code
        for (const item of generated) {
          const skipped = item.question.requires_manual_review || item.question.question_type === 'essay' || item.question.question_type === 'upload'
          const update = item.answer ? original.answerUpdates.find((row) => row.id === item.answer?.id) : undefined
          if (skipped) expect(update).toBeUndefined()
          const blank = !item.answer?.answer_text && !item.answer?.file_path
          if (!skipped && item.answer && blank) expect(update).toEqual({ id: item.answer.id, is_correct: false, points_awarded: 0 })
        }
        if (original.manual_review) expect(original.final_score).toBeNull()

        expect(await gradeFixed(questions, answers, keys, parts, expired)).toEqual(original)
      }),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// Legacy delete (3.16)
// ---------------------------------------------------------------------------

/** Task 3.9 changes the signature to `deleteSubmission({ id, schoolId })`. */
const deleteTakesObject = /export async function deleteSubmission\(\s*\{/.test(submissionsSource)

async function callDeleteSubmission(id: string, schoolId: string) {
  const { deleteSubmission } = await import('../src/lib/submissions')
  const call = deleteSubmission as unknown as (arg: unknown) => Promise<{ error: unknown }>
  return call(deleteTakesObject ? { id, schoolId } : id)
}

function storageRemovePaths() {
  return stub.calls.flatMap((call) =>
    call.kind === 'storage' && call.method === 'remove' ? ((call.args[0] as string[] | undefined) ?? []) : [],
  )
}

function deleteRpcCalls() {
  return stub.calls.filter((call) => call.kind === 'rpc' && call.name === 'LQ_delete_attempt') as Array<{ args: unknown }>
}

describe('Preservation: deleting legacy submissions (3.16)', () => {
  it('fixed vector: file_path "diagram.png" -> LQ_delete_attempt once, no storage.remove', async () => {
    seedLegacySubmission({ attemptStatus: 'submitted' })
    const result = await callDeleteSubmission(ATTEMPT_ID, SCHOOL_ID)
    expect(result.error).toBeNull()
    expect(deleteRpcCalls().map((call) => call.args)).toEqual([{ p_attempt_id: ATTEMPT_ID }])
    expect(stub.calls.some((call) => call.kind === 'storage' && call.method === 'remove')).toBe(false)
  })

  const bareName = fc.stringMatching(/^[A-Za-z0-9 _().-]{1,40}$/).filter((name) => name.trim().length > 0)

  it('never passes a bare name to storage.remove and calls LQ_delete_attempt once (PBT)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.stringMatching(/^S-[0-9]{4}$/),
        fc.array(bareName, { minLength: 1, maxLength: 4 }),
        async (attemptId, schoolId, names) => {
          stub.reset()
          seedLegacySubmission({ attemptStatus: 'submitted' })
          stub.onTable('LQ_attempts', () => ({ data: [{ id: attemptId, school_id: schoolId, status: 'submitted' }], error: null }))
          stub.onTable('LQ_answers', () => ({
            data: names.map((name, i) => ({ id: `ans-${i}`, attempt_id: attemptId, question_id: `q-${i}`, answer_text: null, file_path: name, is_correct: null, points_awarded: 0 })),
            error: null,
          }))

          const result = await callDeleteSubmission(attemptId, schoolId)

          expect(result.error).toBeNull()
          expect(deleteRpcCalls().map((call) => call.args)).toEqual([{ p_attempt_id: attemptId }])
          for (const path of storageRemovePaths()) {
            expect(names).not.toContain(path)
            expect(path).toContain('/')
            expect(path.startsWith(`${schoolId}/${attemptId}/`)).toBe(true)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

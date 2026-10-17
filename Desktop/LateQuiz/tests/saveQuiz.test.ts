/**
 * Unit tests for `saveQuiz` answer-key payloads and validation (task 3.5).
 *
 * Validates: Requirements 2.1, 2.2, 2.5, 3.4, 3.14
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Question } from '../src/types'
import { stub, isWrite, opArgs, type StubCall } from './support/stubSupabase'

vi.mock('../src/lib/supabase', async () => {
  const { stub: client } = await import('./support/stubSupabase')
  return {
    supabase: client.client,
    isSupabaseConfigured: true,
    internalAuthIdentifier: (value: string) => `${value.trim().toLowerCase()}@auth.latequiz.internal`,
  }
})

beforeEach(() => stub.reset())

const QUIZ_ID = '11111111-1111-4111-8111-111111111111'
const PART_ID = '22222222-2222-4222-8222-222222222222'
const Q_ID = '33333333-3333-4333-8333-333333333333'

type FromCall = Extract<StubCall, { kind: 'from' }>

function fromCalls(table: string) {
  return stub.calls.filter((call): call is FromCall => call.kind === 'from' && call.table === table)
}

function keyPayloads() {
  return fromCalls('LQ_question_keys')
    .filter(isWrite)
    .map((call) => opArgs(call, 'upsert')?.[0] as { question_id: string; answer_keys: string[] | null })
}

async function save(questions: Question[], ids: { quizId?: string; partId?: string } = {}) {
  const { saveQuiz } = await import('../src/lib/admin')
  return saveQuiz({
    id: ids.quizId,
    title: 'Data Representation',
    subject: 'Computer Science',
    description: '',
    passingScore: 75,
    durationMinutes: 30,
    status: 'draft',
    parts: [{ id: ids.partId ?? 'part-new-1', title: 'Part 1', position: 1, questions }],
  })
}

describe('identificationKeyFields', () => {
  it('prefers answers, falls back to answer, then to one blank field', async () => {
    const { identificationKeyFields } = await import('../src/lib/admin')
    expect(identificationKeyFields({ answers: ['CPU', 'Processor'], answer: 'CPU' })).toEqual(['CPU', 'Processor'])
    expect(identificationKeyFields({ answer: 'RAM' })).toEqual(['RAM'])
    expect(identificationKeyFields({})).toEqual([''])
    expect(identificationKeyFields({ answers: [] })).toEqual([])
  })
})

describe('saveQuiz answer key payloads', () => {
  it('stores trimmed identification keys in admin order', async () => {
    const result = await save([
      { id: 'q-1', type: 'identification', prompt: 'CPU?', points: 1, answers: [' Central Processing Unit ', 'CPU'] },
    ])
    expect(result.error).toBeNull()
    expect(keyPayloads()).toEqual([
      { question_id: expect.any(String), answer_keys: ['Central Processing Unit', 'CPU'] },
    ])
  })

  it('stores a PDF-imported identification answer (answer only) as a one-element array', async () => {
    const result = await save([{ id: 'q-1', type: 'identification', prompt: 'Memory?', points: 1, answer: ' RAM ' }])
    expect(result.error).toBeNull()
    expect(keyPayloads()[0].answer_keys).toEqual(['RAM'])
  })

  it('stores the multiple-choice answer as a one-element array', async () => {
    const result = await save([
      { id: 'q-1', type: 'multiple-choice', prompt: 'Pick', points: 1, options: ['A', 'B'], answer: ' B ' },
    ])
    expect(result.error).toBeNull()
    expect(keyPayloads()[0].answer_keys).toEqual(['B'])
  })

  it('stores essay/upload keys as an array when set and null when blank', async () => {
    const result = await save([
      { id: 'q-1', type: 'essay', prompt: 'Explain', points: 5, answer: ' Rubric ' },
      { id: 'q-2', type: 'essay', prompt: 'Explain more', points: 5, answer: '  ' },
      { id: 'q-3', type: 'upload', prompt: 'Draw', points: 5 },
    ])
    expect(result.error).toBeNull()
    expect(keyPayloads().map((payload) => payload.answer_keys)).toEqual([['Rubric'], null, null])
  })

  it('never sends the legacy answer_key column', async () => {
    await save([{ id: 'q-1', type: 'identification', prompt: 'CPU?', points: 1, answers: ['CPU'] }])
    for (const payload of keyPayloads()) expect(payload).not.toHaveProperty('answer_key')
  })

  it('rejects invalid identification keys before any write, naming the part and question', async () => {
    const result = await save([
      { id: 'q-1', type: 'multiple-choice', prompt: 'Pick', points: 1, options: ['A', 'B'], answer: 'A' },
      { id: 'q-2', type: 'identification', prompt: 'CPU?', points: 1, answers: ['RAM', ' ram '] },
    ])
    expect(result.id).toBeNull()
    expect((result.error as Error).message).toMatch(/^Part 1, question 2: .*duplicates/)
    expect(stub.calls.filter((call) => call.kind === 'from' && isWrite(call))).toEqual([])
  })
})

describe('saveQuiz key changes leave attempts untouched', () => {
  it('editing keys on an existing quiz writes no LQ_answers, LQ_attempts, or part-score rows', async () => {
    stub.onTable('LQ_quiz_parts', (log) =>
      log.ops.some((op) => op.method === 'select') && !isWrite(log) ? { data: [{ id: PART_ID }], error: null } : undefined)
    stub.onTable('LQ_questions', (log) => {
      if (log.ops.some((op) => op.method === 'single')) return { data: { id: Q_ID }, error: null }
      if (log.ops.some((op) => op.method === 'select') && !isWrite(log)) return { data: [{ id: Q_ID }], error: null }
      return undefined
    })

    const result = await save(
      [{ id: Q_ID, type: 'identification', prompt: 'CPU?', points: 1, answers: ['Central Processing Unit', 'CPU', 'Processor'] }],
      { quizId: QUIZ_ID, partId: PART_ID },
    )

    expect(result).toEqual({ id: QUIZ_ID, error: null })
    expect(keyPayloads()).toEqual([{ question_id: Q_ID, answer_keys: ['Central Processing Unit', 'CPU', 'Processor'] }])
    for (const table of ['LQ_answers', 'LQ_attempts', 'LQ_attempt_part_scores']) {
      expect(fromCalls(table)).toEqual([])
    }
    const rpcNames = stub.calls.filter((call) => call.kind === 'rpc').map((call) => (call as { name: string }).name)
    expect(rpcNames).toEqual(['LQ_sync_quiz_collaborators'])
  })
})

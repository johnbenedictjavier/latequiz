/**
 * Unit tests for the quiz builder's identification key list helpers (task 3.6).
 *
 * Validates: Requirements 2.1, 2.2, 2.5, 3.4
 */
import { describe, expect, it } from 'vitest'
import {
  addAnswerKey,
  answerKeysPatch,
  builderKeyFields,
  identificationKeysError,
  removeAnswerKey,
  updateAnswerKey,
} from '../src/lib/builderKeys'
import type { Question } from '../src/types'

function q(patch: Partial<Question>): Question {
  return { id: 'q', type: 'identification', prompt: 'Prompt', points: 1, ...patch }
}

describe('builder key list', () => {
  it('seeds fields from answers, then answer, and always shows one input', () => {
    expect(builderKeyFields({ answers: ['CPU', 'Processor'], answer: 'CPU' })).toEqual(['CPU', 'Processor'])
    expect(builderKeyFields({ answer: 'RAM' })).toEqual(['RAM'])
    expect(builderKeyFields({})).toEqual([''])
    expect(builderKeyFields({ answers: [] })).toEqual([''])
  })

  it('adds, updates, and removes keys without removing the last one', () => {
    const keys = addAnswerKey(['CPU'])
    expect(keys).toEqual(['CPU', ''])
    expect(updateAnswerKey(keys, 1, 'Processor')).toEqual(['CPU', 'Processor'])
    expect(removeAnswerKey(['CPU', 'Processor'], 0)).toEqual(['Processor'])
    expect(removeAnswerKey(['CPU'], 0)).toEqual(['CPU'])
  })

  it('keeps answer in sync with the first key', () => {
    expect(answerKeysPatch(['CPU', 'Processor'])).toEqual({ answers: ['CPU', 'Processor'], answer: 'CPU' })
    expect(answerKeysPatch([])).toEqual({ answers: [], answer: '' })
  })
})

describe('identificationKeysError', () => {
  it('names the part and question of the first invalid identification question', () => {
    const parts = [
      { questions: [q({ answers: ['CPU'] })] },
      { questions: [q({ type: 'multiple-choice', answer: 'A', options: ['A', 'B'] }), q({ answers: ['A'] }), q({ answers: ['  '] })] },
    ]
    expect(identificationKeysError(parts)).toBe('Part 2, question 3: answer key 1 is blank. Fill it in or remove it.')
  })

  it('reports empty and duplicate key lists', () => {
    expect(identificationKeysError([{ questions: [q({ answers: [] })] }])).toBe(
      'Part 1, question 1: identification questions need at least one answer key.',
    )
    expect(identificationKeysError([{ questions: [q({ answers: ['RAM', ' ram '] })] }])).toBe(
      "Part 1, question 1: answer keys 'RAM' and ' ram ' are duplicates.",
    )
  })

  it('returns null for valid identification keys and ignores other types', () => {
    const parts = [{ questions: [q({ answers: ['CPU', 'Central Processing Unit'] }), q({ type: 'essay', answer: '' })] }]
    expect(identificationKeysError(parts)).toBeNull()
  })
})

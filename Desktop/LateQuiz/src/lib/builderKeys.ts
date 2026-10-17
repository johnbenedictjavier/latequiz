// Pure helpers for the quiz builder's identification "Accepted answers" list.
// Kept free of React so they can be unit tested in the node environment.
import { validateAnswerKeys } from '../../supabase/functions/_shared/answerKeys.ts'
import { identificationKeyFields } from './admin'
import type { Question, QuizPart } from '../types'

/** Key fields shown in the builder: the saved/seeded fields, never fewer than one input. */
export function builderKeyFields(question: Pick<Question, 'answer' | 'answers'>): string[] {
  const fields = identificationKeyFields(question)
  return fields.length ? fields : ['']
}

/** Question patch that stores the key list and keeps `answer` in sync with the first key. */
export function answerKeysPatch(keys: string[]): Pick<Question, 'answers' | 'answer'> {
  return { answers: keys, answer: keys[0] ?? '' }
}

export function addAnswerKey(keys: readonly string[]): string[] {
  return [...keys, '']
}

/** Removes the key at `index`; the last remaining key cannot be removed. */
export function removeAnswerKey(keys: readonly string[], index: number): string[] {
  if (keys.length <= 1 || index < 0 || index >= keys.length) return [...keys]
  return keys.filter((_, keyIndex) => keyIndex !== index)
}

export function updateAnswerKey(keys: readonly string[], index: number, value: string): string[] {
  return keys.map((key, keyIndex) => (keyIndex === index ? value : key))
}

/**
 * First identification key problem in builder order, formatted for the save toast
 * (e.g. "Part 1, question 3: identification questions need at least one answer key."),
 * or null when every identification question has a valid key list.
 */
export function identificationKeysError(parts: readonly Pick<QuizPart, 'questions'>[]): string | null {
  for (const [partIndex, part] of parts.entries()) {
    for (const [questionIndex, question] of part.questions.entries()) {
      if (question.type !== 'identification') continue
      const validation = validateAnswerKeys(identificationKeyFields(question))
      if (!validation.ok) {
        const message = validation.message.charAt(0).toLowerCase() + validation.message.slice(1)
        return `Part ${partIndex + 1}, question ${questionIndex + 1}: ${message}`
      }
    }
  }
  return null
}

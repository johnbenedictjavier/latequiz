// Pure helpers for the admin submission review drawer and submission delete (task 3.9).
// Kept free of React so they can be unit tested in the node environment.
import { isLegacyFileName } from './submissionUploads'
import type { QuestionType } from '../types'

export const LEGACY_REVIEW_NOTICE =
  'Image not available: this answer was submitted before image uploads were enabled, so only the file name was saved.'

export const NO_FIXED_ANSWER = 'No fixed answer provided'

export type AnswerKeyDisplay =
  | { kind: 'list'; label: 'Accepted answers'; values: string[] }
  | { kind: 'single'; label: 'Correct answer'; value: string }

/** Identification lists every accepted key; other types keep the single "Correct answer" line. */
export function answerKeyDisplay(type: QuestionType, keys: readonly string[]): AnswerKeyDisplay {
  if (type === 'identification') return { kind: 'list', label: 'Accepted answers', values: [...keys] }
  return { kind: 'single', label: 'Correct answer', value: keys[0] || NO_FIXED_ANSWER }
}

export type SubmissionImageMode = 'empty' | 'legacy' | 'stored'

/** Legacy bare names never had an object, so the drawer must not ask storage for them. */
export function submissionImageMode(path: string | null | undefined): SubmissionImageMode {
  if (!path) return 'empty'
  return isLegacyFileName(path) ? 'legacy' : 'stored'
}

/**
 * Paths to remove when an attempt is deleted: referenced `file_path` values (bare names dropped)
 * plus listed folder objects, kept only under `${schoolId}/${attemptId}/`, deduplicated in order.
 */
export function collectDeletePaths(
  schoolId: string,
  attemptId: string,
  referenced: ReadonlyArray<string | null | undefined>,
  listed: readonly string[] = [],
): string[] {
  const prefix = `${schoolId}/${attemptId}/`
  const paths = new Set<string>()
  for (const value of [...referenced, ...listed]) {
    if (!value || isLegacyFileName(value)) continue
    if (!value.startsWith(prefix) || value.length === prefix.length) continue
    paths.add(value)
  }
  return [...paths]
}

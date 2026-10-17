/**
 * Unit tests for the student re-upload banner and page view helpers (task 3.13).
 *
 * Validates: Requirements 2.16, 2.17, 2.19
 */
import { describe, expect, it } from 'vitest'

import {
  NO_DEADLINE_LABEL,
  reuploadBannerRows,
  reuploadDeadlineLabel,
  reuploadPageState,
} from '../src/lib/reuploadView'
import type { ReuploadRequest } from '../src/types'

function makeRequest(overrides: Partial<ReuploadRequest> = {}): ReuploadRequest {
  return {
    id: 'req-1',
    attemptId: 'attempt-1',
    quizId: 'quiz-1',
    quizTitle: 'Data Representation',
    questionId: 'question-4',
    questionNumber: 4,
    prompt: 'Draw the binary tree for the given expression.',
    originalFileName: 'diagram.png',
    deadline: null,
    requestedAt: '2026-10-20T09:00:00.000Z',
    ...overrides,
  }
}

describe('reuploadDeadlineLabel', () => {
  it('returns "No deadline" for null, undefined, and empty values', () => {
    expect(reuploadDeadlineLabel(null)).toBe(NO_DEADLINE_LABEL)
    expect(reuploadDeadlineLabel(undefined)).toBe(NO_DEADLINE_LABEL)
    expect(reuploadDeadlineLabel('')).toBe(NO_DEADLINE_LABEL)
  })

  it('falls back to "No deadline" for an unparseable value instead of "Invalid Date"', () => {
    expect(reuploadDeadlineLabel('not-a-date')).toBe(NO_DEADLINE_LABEL)
  })

  it('formats a real deadline as a readable local date/time', () => {
    const label = reuploadDeadlineLabel('2026-10-30T17:00:00.000Z')
    expect(label).not.toBe(NO_DEADLINE_LABEL)
    expect(label).toMatch(/2026/)
    expect(label).not.toMatch(/Invalid/)
  })
})

describe('reuploadBannerRows', () => {
  it('returns one row per request with title, question number, and deadline label', () => {
    const rows = reuploadBannerRows([
      makeRequest(),
      makeRequest({ id: 'req-2', questionNumber: 7, quizTitle: 'Networks', deadline: '2026-10-30T17:00:00.000Z' }),
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: 'req-1',
      quizTitle: 'Data Representation',
      questionNumber: 4,
      questionLabel: 'Question 4',
      deadlineLabel: NO_DEADLINE_LABEL,
      hasDeadline: false,
    })
    expect(rows[1]).toMatchObject({
      id: 'req-2',
      quizTitle: 'Networks',
      questionNumber: 7,
      questionLabel: 'Question 7',
      hasDeadline: true,
    })
    expect(rows[1].deadlineLabel).not.toBe(NO_DEADLINE_LABEL)
  })

  it('preserves the order of the incoming requests', () => {
    const rows = reuploadBannerRows([
      makeRequest({ id: 'a', questionNumber: 2 }),
      makeRequest({ id: 'b', questionNumber: 1 }),
    ])
    expect(rows.map((row) => row.id)).toEqual(['a', 'b'])
  })

  it('returns an empty array for no requests', () => {
    expect(reuploadBannerRows([])).toEqual([])
  })
})

describe('reuploadPageState', () => {
  const requests = [
    makeRequest(),
    makeRequest({ id: 'req-2', questionNumber: 7, deadline: '2026-10-30T17:00:00.000Z' }),
  ]
  const now = new Date('2026-10-25T12:00:00.000Z')

  it('resolves an open request by id with only page-relevant fields', () => {
    const state = reuploadPageState(requests, 'req-1', now)
    expect(state.status).toBe('open')
    expect(state.request).toMatchObject({
      id: 'req-1',
      quizTitle: 'Data Representation',
      questionNumber: 4,
      questionLabel: 'Question 4',
      prompt: 'Draw the binary tree for the given expression.',
      originalFileName: 'diagram.png',
      deadlineLabel: NO_DEADLINE_LABEL,
    })
  })

  it('carries no answer keys, options, points, or sibling answers', () => {
    const state = reuploadPageState(requests, 'req-1', now)
    const keys = Object.keys(state.request ?? {})
    expect(keys).not.toContain('answers')
    expect(keys).not.toContain('correctAnswers')
    expect(keys).not.toContain('options')
    expect(keys).not.toContain('points')
    expect(keys.sort()).toEqual(
      ['deadline', 'deadlineLabel', 'hasDeadline', 'id', 'originalFileName', 'prompt', 'questionLabel', 'questionNumber', 'quizTitle'].sort(),
    )
  })

  it('returns a closed state for an unknown id', () => {
    expect(reuploadPageState(requests, 'missing', now)).toEqual({ status: 'closed', request: null })
  })

  it('returns a closed state for a null or empty id', () => {
    expect(reuploadPageState(requests, null, now)).toEqual({ status: 'closed', request: null })
    expect(reuploadPageState(requests, '', now)).toEqual({ status: 'closed', request: null })
  })

  it('treats a request whose deadline has already lapsed as closed', () => {
    const lapsed = reuploadPageState(requests, 'req-2', new Date('2026-10-31T00:00:00.000Z'))
    expect(lapsed).toEqual({ status: 'closed', request: null })
  })

  it('keeps a request open when the deadline is still in the future', () => {
    const open = reuploadPageState(requests, 'req-2', new Date('2026-10-30T16:59:59.000Z'))
    expect(open.status).toBe('open')
    expect(open.request?.id).toBe('req-2')
  })
})

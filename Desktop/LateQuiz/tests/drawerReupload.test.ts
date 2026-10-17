/**
 * Unit tests for the admin drawer re-upload state helper (task 3.14).
 *
 * Validates: Requirements 2.14, 2.15, 2.20, 2.21, 2.22, 2.23, 2.26, 3.21, 3.22
 */
import { describe, expect, it } from 'vitest'

import { drawerReuploadState } from '../src/lib/drawerReupload'
import type { SubmissionAnswer, SubmissionReupload } from '../src/types'

const NOW = new Date('2026-10-25T12:00:00.000Z')
const FUTURE = '2026-10-30T17:00:00.000Z'
const PAST = '2026-10-20T17:00:00.000Z'

function uploadAnswer(overrides: Partial<SubmissionAnswer> = {}): SubmissionAnswer {
  return {
    questionId: 'q-4',
    prompt: 'Upload your diagram',
    type: 'upload',
    answer: '',
    correctAnswers: [],
    filePath: 'diagram.png',
    points: 5,
    pointsAwarded: 0,
    isCorrect: null,
    requiresReview: true,
    answerId: 'answer-1',
    reupload: null,
    ...overrides,
  }
}

function reupload(overrides: Partial<SubmissionReupload> = {}): SubmissionReupload {
  return {
    id: 'req-1',
    status: 'open',
    deadline: FUTURE,
    requestedAt: '2026-10-24T09:00:00.000Z',
    fulfilledAt: null,
    originalFileName: 'diagram.png',
    awaitingReview: false,
    ...overrides,
  }
}

describe('drawerReuploadState', () => {
  it('offers the request control for an eligible legacy answer with no request', () => {
    expect(drawerReuploadState(uploadAnswer(), 'submitted', NOW)).toEqual({ kind: 'request' })
    expect(drawerReuploadState(uploadAnswer(), 'expired', NOW)).toEqual({ kind: 'request' })
    expect(drawerReuploadState(uploadAnswer(), 'reviewed', NOW)).toEqual({ kind: 'request' })
  })

  it('offers nothing for a real object path with no request (3.22)', () => {
    const answer = uploadAnswer({ filePath: 'S-1001/attempt-1/q-4_uuid.png' })
    expect(drawerReuploadState(answer, 'submitted', NOW)).toEqual({ kind: 'none' })
  })

  it('offers nothing for a non-upload answer type', () => {
    const answer = uploadAnswer({ type: 'identification' })
    expect(drawerReuploadState(answer, 'submitted', NOW)).toEqual({ kind: 'none' })
  })

  it('offers nothing for in_progress or cancelled attempts (3.22)', () => {
    expect(drawerReuploadState(uploadAnswer(), 'in_progress', NOW)).toEqual({ kind: 'none' })
    expect(drawerReuploadState(uploadAnswer(), 'cancelled', NOW)).toEqual({ kind: 'none' })
  })

  it('offers nothing when the answer has no answerId', () => {
    expect(drawerReuploadState(uploadAnswer({ answerId: undefined }), 'submitted', NOW)).toEqual({ kind: 'none' })
  })

  it('shows the open request with its deadline and cancel', () => {
    const answer = uploadAnswer({ reupload: reupload() })
    expect(drawerReuploadState(answer, 'submitted', NOW)).toEqual({
      kind: 'open',
      requestId: 'req-1',
      deadline: FUTURE,
      requestedAt: '2026-10-24T09:00:00.000Z',
    })
  })

  it('shows an expired request and allows requesting again (2.22)', () => {
    const answer = uploadAnswer({ reupload: reupload({ status: 'expired', deadline: PAST }) })
    const state = drawerReuploadState(answer, 'submitted', NOW)
    expect(state).toEqual({ kind: 'expired', requestId: 'req-1', requestedAt: '2026-10-24T09:00:00.000Z', canRequest: true })
  })

  it('shows a cancelled request as a muted line and allows requesting again', () => {
    const answer = uploadAnswer({ reupload: reupload({ status: 'cancelled', deadline: null }) })
    const state = drawerReuploadState(answer, 'submitted', NOW)
    expect(state).toEqual({ kind: 'cancelled', requestId: 'req-1', requestedAt: '2026-10-24T09:00:00.000Z', canRequest: true })
  })

  it('does not re-offer a request for a cancelled request on a real path', () => {
    const answer = uploadAnswer({ filePath: 'S-1001/attempt-1/q-4_uuid.png', reupload: reupload({ status: 'cancelled' }) })
    const state = drawerReuploadState(answer, 'submitted', NOW)
    expect(state).toEqual({ kind: 'cancelled', requestId: 'req-1', requestedAt: '2026-10-24T09:00:00.000Z', canRequest: false })
  })

  it('shows a fulfilled request with the awaiting-review badge (2.26)', () => {
    const answer = uploadAnswer({
      filePath: 'S-1001/attempt-1/q-4_req-1_uuid.png',
      reupload: reupload({ status: 'fulfilled', fulfilledAt: '2026-10-26T10:00:00.000Z', awaitingReview: true }),
    })
    expect(drawerReuploadState(answer, 'reviewed', NOW)).toEqual({
      kind: 'fulfilled',
      requestId: 'req-1',
      fulfilledAt: '2026-10-26T10:00:00.000Z',
      originalFileName: 'diagram.png',
      awaitingReview: true,
    })
  })

  it('shows a fulfilled request without the badge once reviewed', () => {
    const answer = uploadAnswer({
      filePath: 'S-1001/attempt-1/q-4_req-1_uuid.png',
      reupload: reupload({ status: 'fulfilled', fulfilledAt: '2026-10-26T10:00:00.000Z', awaitingReview: false }),
    })
    const state = drawerReuploadState(answer, 'reviewed', NOW)
    expect(state).toMatchObject({ kind: 'fulfilled', awaitingReview: false })
  })
})

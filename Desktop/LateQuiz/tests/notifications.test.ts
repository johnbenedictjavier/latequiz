/**
 * Unit tests for notificationTarget routing (task 3.14).
 *
 * - `reupload_fulfilled` and `submission_received` open the submissions view
 *   focused on the attempt and filtered to the student.
 * - `password_reset_request` keeps today's students-page routing.
 *
 * Validates: Requirements 3.24, 3.25
 */
import { describe, expect, it } from 'vitest'

import { notificationTarget } from '../src/lib/notifications'
import type { Notification } from '../src/types'

const base = { id: 'n-1', title: 'T', message: 'M', readAt: null, createdAt: '2026-10-25T08:00:00.000Z' }

function notification(type: string, metadata?: Record<string, string>): Notification {
  return { ...base, type, metadata }
}

describe('notificationTarget', () => {
  it('routes reupload_fulfilled to the submissions view focused on the attempt', () => {
    expect(notificationTarget(notification('reupload_fulfilled', { school_id: 'S-1001', attempt_id: 'attempt-9' })))
      .toEqual({ view: 'submissions', focusStudentId: 'S-1001', focusAttemptId: 'attempt-9' })
  })

  it('routes reupload_fulfilled to submissions with null focus when metadata is missing', () => {
    expect(notificationTarget(notification('reupload_fulfilled')))
      .toEqual({ view: 'submissions', focusStudentId: null, focusAttemptId: null })
  })

  it('routes submission_received to the submissions view focused on the attempt and student', () => {
    expect(notificationTarget(notification('submission_received', { school_id: 'S-1001', attempt_id: 'attempt-9' })))
      .toEqual({ view: 'submissions', focusStudentId: 'S-1001', focusAttemptId: 'attempt-9' })
  })

  it('routes submission_received to submissions with null focus when metadata is missing', () => {
    expect(notificationTarget(notification('submission_received')))
      .toEqual({ view: 'submissions', focusStudentId: null, focusAttemptId: null })
  })

  it('keeps password_reset_request on the students page focused on school_id', () => {
    expect(notificationTarget(notification('password_reset_request', { school_id: 'S-2002' })))
      .toEqual({ view: 'students', focusStudentId: 'S-2002', focusAttemptId: null })
  })

  it('keeps an unknown type on the students page with no focus when metadata is missing', () => {
    expect(notificationTarget(notification('something_else')))
      .toEqual({ view: 'students', focusStudentId: null, focusAttemptId: null })
  })
})

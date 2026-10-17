import type { AdminView, Notification } from '../types'

export type NotificationTarget = {
  view: AdminView
  focusStudentId: string | null
  /** Attempt to open in the submission review drawer, when the view supports it. */
  focusAttemptId: string | null
}

/**
 * Where the admin lands after opening a notification. Pure so it can be tested
 * without React.
 *
 * - `reupload_fulfilled` opens the submissions view, focused on the submission
 *   for `metadata.attempt_id` (and `metadata.school_id` so the row is found).
 * - Every other type keeps today's behavior: the students page focused on
 *   `metadata.school_id`. This preserves `submission_received` and
 *   `password_reset_request` routing (tests/reuploadPreservation.test.ts).
 */
export function notificationTarget(notification: Notification): NotificationTarget {
  const schoolId = notification.metadata?.school_id ?? null
  if (notification.type === 'reupload_fulfilled') {
    return {
      view: 'submissions',
      focusStudentId: schoolId,
      focusAttemptId: notification.metadata?.attempt_id ?? null,
    }
  }
  return { view: 'students', focusStudentId: schoolId, focusAttemptId: null }
}

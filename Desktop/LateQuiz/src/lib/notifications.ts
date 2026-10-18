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
 * - `reupload_fulfilled` and `submission_received` open the submissions view,
 *   focused on the submission for `metadata.attempt_id` and filtered to the
 *   student via `metadata.school_id`, so the admin lands on just that student's
 *   submission.
 * - Every other type keeps today's behavior: the students page focused on
 *   `metadata.school_id`. This preserves `password_reset_request` routing.
 */
export function notificationTarget(notification: Notification): NotificationTarget {
  const schoolId = notification.metadata?.school_id ?? null
  if (notification.type === 'reupload_fulfilled' || notification.type === 'submission_received') {
    return {
      view: 'submissions',
      focusStudentId: schoolId,
      focusAttemptId: notification.metadata?.attempt_id ?? null,
    }
  }
  return { view: 'students', focusStudentId: schoolId, focusAttemptId: null }
}

import type { AdminView, Notification } from '../types'

export type NotificationTarget = {
  view: AdminView
  focusStudentId: string | null
}

/**
 * Where the admin lands after opening a notification. Pure so it can be
 * tested without React. Every notification type opens the students page
 * focused on `metadata.school_id`.
 */
export function notificationTarget(notification: Notification): NotificationTarget {
  return { view: 'students', focusStudentId: notification.metadata?.school_id ?? null }
}

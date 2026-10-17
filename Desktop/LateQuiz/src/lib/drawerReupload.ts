// Pure state helper for the admin submission review drawer's re-upload controls
// (task 3.14). Kept free of React so it can be unit tested in the node environment.
import { canRequestReupload } from './reuploads'
import type { SubmissionAnswer } from '../types'

/**
 * What the drawer renders for one upload answer's re-upload state.
 *
 * - `none`      real object path (or non-legacy) with no request: no request action.
 * - `request`   legacy bare name, eligible, no prior request: the 2.13 notice plus "Request re-upload".
 * - `open`      an open, unexpired request: the deadline and "Cancel request".
 * - `expired`   an open request past its deadline: an "expired" line; `canRequest` offers a new one.
 * - `fulfilled` the student re-uploaded: the image, a re-upload line, and the
 *               awaiting-review badge when the answer has not been reviewed since.
 * - `cancelled` a cancelled request shown as one muted history line; `canRequest` offers a new one.
 */
export type DrawerReuploadState =
  | { kind: 'none' }
  | { kind: 'request' }
  | { kind: 'open'; requestId: string; deadline: string | null; requestedAt: string }
  | { kind: 'expired'; requestId: string; requestedAt: string; canRequest: boolean }
  | {
    kind: 'fulfilled'
    requestId: string
    fulfilledAt: string | null
    originalFileName: string
    awaitingReview: boolean
  }
  | { kind: 'cancelled'; requestId: string; requestedAt: string; canRequest: boolean }

/**
 * Mirrors the drawer's decision tree. `attemptStatus` is the raw
 * `LQ_attempts.status` the request RPC gates on; `now` lets tests pin the clock.
 */
export function drawerReuploadState(
  answer: Pick<SubmissionAnswer, 'type' | 'filePath' | 'answerId' | 'reupload'>,
  attemptStatus: string,
  now: Date = new Date(),
): DrawerReuploadState {
  if (answer.type !== 'upload') return { kind: 'none' }

  const request = answer.reupload ?? null

  // Server-mirrored eligibility to open a (new) request for this answer. When the
  // latest request is open/unexpired this is false, so `open` always wins below.
  const canRequest = Boolean(
    answer.answerId
    && canRequestReupload({
      questionType: answer.type,
      filePath: answer.filePath,
      attemptStatus,
      requests: request ? [{ status: request.status, deadline: request.deadline }] : [],
      now,
    }),
  )

  if (request) {
    switch (request.status) {
      case 'open':
        return { kind: 'open', requestId: request.id, deadline: request.deadline, requestedAt: request.requestedAt }
      case 'expired':
        return { kind: 'expired', requestId: request.id, requestedAt: request.requestedAt, canRequest }
      case 'fulfilled':
        return {
          kind: 'fulfilled',
          requestId: request.id,
          fulfilledAt: request.fulfilledAt,
          originalFileName: request.originalFileName,
          awaitingReview: request.awaitingReview,
        }
      case 'cancelled':
        return { kind: 'cancelled', requestId: request.id, requestedAt: request.requestedAt, canRequest }
    }
  }

  return canRequest ? { kind: 'request' } : { kind: 'none' }
}

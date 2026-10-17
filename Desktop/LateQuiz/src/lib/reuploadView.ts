// Pure view helpers for the student re-upload banner and page (task 3.13).
// Kept free of React so they can be unit tested in the node environment.
import type { ReuploadRequest } from '../types'

/** Shown in the banner and on the page when a request has no deadline. */
export const NO_DEADLINE_LABEL = 'No deadline'

/**
 * Human-readable local deadline, or {@link NO_DEADLINE_LABEL} when a request
 * has no deadline. An unparseable value falls back to the no-deadline label so
 * the banner never renders "Invalid Date".
 */
export function reuploadDeadlineLabel(deadline: string | null | undefined): string {
  if (deadline === null || deadline === undefined || deadline === '') return NO_DEADLINE_LABEL
  const at = new Date(deadline).getTime()
  if (!Number.isFinite(at)) return NO_DEADLINE_LABEL
  return new Date(at).toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** One banner row per open request: quiz title, question number, and a deadline label. */
export interface ReuploadBannerRow {
  id: string
  quizTitle: string
  questionNumber: number
  questionLabel: string
  deadlineLabel: string
  hasDeadline: boolean
}

/** One row per request, in the order the server returned them. */
export function reuploadBannerRows(requests: readonly ReuploadRequest[]): ReuploadBannerRow[] {
  return requests.map((request) => ({
    id: request.id,
    quizTitle: request.quizTitle,
    questionNumber: request.questionNumber,
    questionLabel: `Question ${request.questionNumber}`,
    deadlineLabel: reuploadDeadlineLabel(request.deadline),
    hasDeadline: Boolean(request.deadline),
  }))
}

/** The data a single re-upload page needs: nothing about keys, options, points, or other answers. */
export interface ReuploadPageState {
  status: 'open' | 'closed'
  request: {
    id: string
    quizTitle: string
    questionNumber: number
    questionLabel: string
    prompt: string
    originalFileName: string
    deadline: string | null
    deadlineLabel: string
    hasDeadline: boolean
  } | null
}

/**
 * Resolve a request by id for the re-upload page. A missing id, or one whose
 * deadline has already lapsed, yields a closed state (the page then shows the
 * "no longer open" message). The returned request carries only the fields the
 * single-question page renders — never answer keys, options, points, or sibling
 * answers.
 */
export function reuploadPageState(
  requests: readonly ReuploadRequest[],
  id: string | null | undefined,
  now: Date = new Date(),
): ReuploadPageState {
  if (!id) return { status: 'closed', request: null }
  const request = requests.find((candidate) => candidate.id === id)
  if (!request) return { status: 'closed', request: null }

  // The student list only carries open requests, but a deadline can lapse
  // between the load and opening the page.
  if (request.deadline) {
    const at = new Date(request.deadline).getTime()
    if (Number.isFinite(at) && at <= now.getTime()) return { status: 'closed', request: null }
  }

  return {
    status: 'open',
    request: {
      id: request.id,
      quizTitle: request.quizTitle,
      questionNumber: request.questionNumber,
      questionLabel: `Question ${request.questionNumber}`,
      prompt: request.prompt,
      originalFileName: request.originalFileName,
      deadline: request.deadline,
      deadlineLabel: reuploadDeadlineLabel(request.deadline),
      hasDeadline: Boolean(request.deadline),
    },
  }
}

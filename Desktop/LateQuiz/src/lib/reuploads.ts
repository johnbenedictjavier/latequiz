import { supabase } from './supabase'
import { SUBMISSION_BUCKET, isLegacyFileName, validateSubmissionImage } from './submissionUploads'
import type {
  ReuploadEffectiveStatus,
  ReuploadRequest,
  ReuploadRequestRecord,
  ReuploadRequestStatus,
} from '../types'

export const REUPLOAD_CLOSED_MESSAGE = 'This re-upload request is no longer open.'
export const REUPLOAD_DEADLINE_MESSAGE = 'The deadline must be in the future.'

/** Attempt statuses on which a legacy upload answer can be re-requested (mirrors LQ_request_reupload). */
export const REUPLOAD_ATTEMPT_STATUSES: readonly string[] = ['submitted', 'expired', 'reviewed']

/** Same suffix rule as LQ_fulfill_reupload: uuid plus an allowed image extension, nothing else. */
const REUPLOAD_SUFFIX = /^[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$/

type RequestState = { status: ReuploadRequestStatus | string; deadline: string | null | undefined }

function notConfigured() {
  return new Error('Supabase is not configured.')
}

function toTime(value: Date | string | number) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Open and unexpired. A deadline equal to `now` has lapsed (server uses `deadline > now()`). */
export function isRequestOpen(request: RequestState, now: Date): boolean {
  if (request.status !== 'open') return false
  if (request.deadline === null || request.deadline === undefined || request.deadline === '') return true
  const deadline = toTime(request.deadline)
  return Number.isFinite(deadline) && deadline > now.getTime()
}

/** Stored status, with an open request whose deadline has passed reported as `expired`. */
export function effectiveReuploadStatus(request: RequestState, now: Date): ReuploadEffectiveStatus {
  if (request.status === 'fulfilled' || request.status === 'cancelled') return request.status
  return isRequestOpen(request, now) ? 'open' : 'expired'
}

/**
 * Client mirror of the LQ_request_reupload checks: upload question, legacy bare
 * file name, closed attempt (`submitted`/`expired`/`reviewed`), and no open,
 * unexpired request for the answer.
 */
export function canRequestReupload(input: {
  questionType: string
  filePath: string | null | undefined
  attemptStatus: string
  requests: readonly RequestState[]
  now: Date
}): boolean {
  const { questionType, filePath, attemptStatus, requests, now } = input
  if (questionType !== 'upload') return false
  if (!isLegacyFileName(filePath) || String(filePath).trim() === '') return false
  if (!REUPLOAD_ATTEMPT_STATUSES.includes(attemptStatus)) return false
  return !requests.some((request) => isRequestOpen(request, now))
}

export type ReuploadPathContext = { schoolId: string; attemptId: string; questionId: string; requestId: string }

function reuploadPrefix(ctx: ReuploadPathContext) {
  return `${ctx.schoolId}/${ctx.attemptId}/${ctx.questionId}_${ctx.requestId}_`
}

/** `{school}/{attempt}/{question}_{request}_{uuid}.{ext}` */
export function buildReuploadPath(schoolId: string, attemptId: string, questionId: string, requestId: string, ext: string) {
  return `${reuploadPrefix({ schoolId, attemptId, questionId, requestId })}${crypto.randomUUID().toLowerCase()}.${ext}`
}

/** Same rule as LQ_fulfill_reupload: literal prefix plus the strict uuid/extension suffix. */
export function isValidReuploadPath(path: string | null | undefined, ctx: ReuploadPathContext): boolean {
  if (typeof path !== 'string') return false
  const prefix = reuploadPrefix(ctx)
  if (!path.startsWith(prefix)) return false
  return REUPLOAD_SUFFIX.test(path.slice(prefix.length))
}

/**
 * True when the latest request was fulfilled and the answer has not been
 * reviewed since (`reviewedAt` null or earlier than `fulfilledAt`).
 */
export function isAwaitingImageReview(
  answer: { reviewedAt?: string | null },
  latestRequest: { status: string; fulfilledAt?: string | null } | null | undefined,
): boolean {
  if (!latestRequest || latestRequest.status !== 'fulfilled' || !latestRequest.fulfilledAt) return false
  if (!answer.reviewedAt) return true
  return toTime(answer.reviewedAt) < toTime(latestRequest.fulfilledAt)
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type MyRequestRow = {
  request_id: string
  attempt_id: string
  quiz_id: string
  quiz_title: string | null
  question_id: string
  question_number: number | string | null
  prompt: string | null
  original_file_name: string | null
  deadline: string | null
  requested_at: string
}

type RequestRow = {
  id: string
  attempt_id: string
  question_id: string
  answer_id: string
  original_file_name: string | null
  requested_at: string
  deadline: string | null
  status: ReuploadRequestStatus
  fulfilled_at: string | null
  fulfilled_path: string | null
  cancelled_at: string | null
  cancel_reason: 'admin' | 'expired' | null
}

export function mapMyReuploadRow(row: MyRequestRow): ReuploadRequest {
  return {
    id: row.request_id,
    attemptId: row.attempt_id,
    quizId: row.quiz_id,
    quizTitle: row.quiz_title ?? '',
    questionId: row.question_id,
    questionNumber: Number(row.question_number ?? 0),
    prompt: row.prompt ?? '',
    originalFileName: row.original_file_name ?? '',
    deadline: row.deadline ?? null,
    requestedAt: row.requested_at,
  }
}

export function mapReuploadRequestRow(row: RequestRow): ReuploadRequestRecord {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    questionId: row.question_id,
    answerId: row.answer_id,
    originalFileName: row.original_file_name ?? '',
    requestedAt: row.requested_at,
    deadline: row.deadline ?? null,
    status: row.status,
    fulfilledAt: row.fulfilled_at ?? null,
    fulfilledPath: row.fulfilled_path ?? null,
    cancelledAt: row.cancelled_at ?? null,
    cancelReason: row.cancel_reason ?? null,
  }
}

// ---------------------------------------------------------------------------
// Student
// ---------------------------------------------------------------------------

/** The caller's open, unexpired requests. */
export async function loadMyReuploadRequests(): Promise<ReuploadRequest[]> {
  if (!supabase) throw notConfigured()
  const { data, error } = await supabase.rpc('LQ_my_reupload_requests')
  if (error) throw error
  return ((data ?? []) as MyRequestRow[]).map(mapMyReuploadRow)
}

function isStorageDenial(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const { statusCode, status, message } = error as { statusCode?: unknown; status?: unknown; message?: unknown }
  if (String(statusCode) === '403' || String(status) === '403') return true
  return typeof message === 'string' && /row-level security|unauthorized|permission denied/i.test(message)
}

/**
 * Validate → check the request is still open → upload to the request's slot →
 * link it with LQ_fulfill_reupload. A failed fulfill removes the uploaded
 * object (best effort) so nothing is orphaned.
 */
export async function submitReupload(input: {
  request: ReuploadRequest
  schoolId: string
  file: File
  now?: Date
}): Promise<{ path: string | null; error: Error | unknown | null }> {
  const { request, schoolId, file } = input
  const validation = validateSubmissionImage(file)
  if (!validation.ok) return { path: null, error: new Error(validation.message) }

  // Requests in the student list are open by construction; only the deadline can lapse.
  if (!isRequestOpen({ status: 'open', deadline: request.deadline }, input.now ?? new Date())) {
    return { path: null, error: new Error(REUPLOAD_CLOSED_MESSAGE) }
  }
  if (!supabase) return { path: null, error: notConfigured() }

  const path = buildReuploadPath(schoolId, request.attemptId, request.questionId, request.id, validation.ext)
  const { error: uploadError } = await supabase.storage
    .from(SUBMISSION_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false })
  if (uploadError) {
    return { path: null, error: isStorageDenial(uploadError) ? new Error(REUPLOAD_CLOSED_MESSAGE) : uploadError }
  }

  const { error: rpcError } = await supabase.rpc('LQ_fulfill_reupload', { p_request_id: request.id, p_path: path })
  if (rpcError) {
    try {
      await supabase.storage.from(SUBMISSION_BUCKET).remove([path])
    } catch {
      // Best effort: the discard policy allows this, but a failure must not hide the RPC error.
    }
    return { path: null, error: rpcError }
  }

  return { path, error: null }
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export async function requestReupload(
  answerId: string,
  deadline: string | null = null,
  now: Date = new Date(),
): Promise<{ request: ReuploadRequestRecord | null; error: Error | unknown | null }> {
  if (deadline !== null && deadline !== '') {
    const at = toTime(deadline)
    if (!Number.isFinite(at) || at <= now.getTime()) return { request: null, error: new Error(REUPLOAD_DEADLINE_MESSAGE) }
  }
  if (!supabase) return { request: null, error: notConfigured() }
  const { data, error } = await supabase.rpc('LQ_request_reupload', {
    p_answer_id: answerId,
    p_deadline: deadline === '' ? null : deadline,
  })
  if (error) return { request: null, error }
  return { request: data ? mapReuploadRequestRow(data as RequestRow) : null, error: null }
}

/**
 * Cancels the request. When `schoolId` is given, also removes (best effort)
 * any object left in the request's slot by an unfinished student upload.
 */
export async function cancelReupload(
  requestId: string,
  options: { schoolId?: string } = {},
): Promise<{ request: ReuploadRequestRecord | null; error: Error | unknown | null }> {
  if (!supabase) return { request: null, error: notConfigured() }
  const { data, error } = await supabase.rpc('LQ_cancel_reupload', { p_request_id: requestId })
  if (error) return { request: null, error }
  const request = data ? mapReuploadRequestRow(data as RequestRow) : null

  if (request && options.schoolId) {
    try {
      const folder = `${options.schoolId}/${request.attemptId}`
      const prefix = `${request.questionId}_${request.id}_`
      const { data: items, error: listError } = await supabase.storage.from(SUBMISSION_BUCKET).list(folder, { limit: 1000 })
      const orphans = listError
        ? []
        : ((items ?? []) as Array<{ name?: string }>)
          .filter((item) => item?.name?.startsWith(prefix))
          .map((item) => `${folder}/${item.name}`)
      if (orphans.length) await supabase.storage.from(SUBMISSION_BUCKET).remove(orphans)
    } catch {
      // Best effort cleanup only.
    }
  }

  return { request, error: null }
}

/** All requests (any status) for the given attempts, oldest first. */
export async function loadReuploadRequests(attemptIds: readonly string[]): Promise<ReuploadRequestRecord[]> {
  if (!attemptIds.length) return []
  if (!supabase) throw notConfigured()
  const { data, error } = await supabase
    .from('LQ_reupload_requests')
    .select('id, attempt_id, question_id, answer_id, original_file_name, requested_at, deadline, status, fulfilled_at, fulfilled_path, cancelled_at, cancel_reason')
    .in('attempt_id', [...attemptIds])
    .order('requested_at', { ascending: true })
  if (error) throw error
  return ((data ?? []) as RequestRow[]).map(mapReuploadRequestRow)
}

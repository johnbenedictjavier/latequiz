// Pure helpers for the student quiz upload answer (task 3.8).
// Kept free of React so they can be unit tested in the node environment.
import { isLegacyFileName } from './submissionUploads'

export const UPLOAD_ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'
export const UPLOAD_HINT = 'JPG, PNG, or WEBP image up to 10 MB'
export const LEGACY_UPLOAD_NOTICE =
  'Image not available: this answer was saved before image uploads were enabled, so only the file name was kept and the image was never stored. Choose the image again to upload it.'

export type UploadAnswerState = 'empty' | 'legacy' | 'stored'

/** Empty, a pre-upload bare file name (no stored object), or a real object path. */
export function uploadAnswerState(value: string | null | undefined): UploadAnswerState {
  if (!value) return 'empty'
  return isLegacyFileName(value) ? 'legacy' : 'stored'
}

const STORED_NAME = /^[^_/]+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.([a-z0-9]+)$/i

/**
 * Name shown for an upload answer. Prefers the original file name picked in this session;
 * otherwise the object path's basename, with the generated `{question_id}_{uuid}` name
 * replaced by a readable label because the original name is not part of the path.
 */
export function uploadDisplayName(value: string | null | undefined, originalName?: string | null): string {
  if (!value) return ''
  if (originalName) return originalName
  if (isLegacyFileName(value)) return value
  const basename = value.slice(value.lastIndexOf('/') + 1)
  const match = STORED_NAME.exec(basename)
  return match ? `Uploaded image (${match[1].toUpperCase()})` : basename
}

/** Manual submit and exit wait for uploads; the timeout auto-submit always proceeds. */
export function isSubmitBlockedByUploads(uploadsInFlight: number, reason: 'manual' | 'exit' | 'timeout'): boolean {
  return uploadsInFlight > 0 && reason !== 'timeout'
}

export function nextUploadCount(count: number, busy: boolean): number {
  return Math.max(0, count + (busy ? 1 : -1))
}

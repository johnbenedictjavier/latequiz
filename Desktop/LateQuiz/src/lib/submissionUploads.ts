import { supabase } from './supabase'

export const SUBMISSION_BUCKET = 'lq-submissions'
export const MAX_SUBMISSION_BYTES = 10 * 1024 * 1024 // 10485760
export const ALLOWED_SUBMISSION_TYPES: Readonly<Record<string, readonly string[]>> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
}

const SIGNED_URL_SECONDS = 300

export type SubmissionFileInfo = { name: string; type: string; size: number }
export type SubmissionValidation = { ok: true; ext: string } | { ok: false; message: string }

function notConfigured() {
  return new Error('Supabase is not configured.')
}

/** Pure check: MIME in the allow-list, extension matches that MIME, and 0 < size <= 10 MB. */
export function validateSubmissionImage(file: SubmissionFileInfo): SubmissionValidation {
  const allowed = Object.prototype.hasOwnProperty.call(ALLOWED_SUBMISSION_TYPES, file.type)
    ? ALLOWED_SUBMISSION_TYPES[file.type]
    : undefined
  if (!allowed) return { ok: false, message: 'Only JPG, PNG, or WEBP images can be uploaded.' }

  const dot = file.name.lastIndexOf('.')
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : ''
  if (!allowed.includes(ext)) {
    return { ok: false, message: `The file extension does not match its type. Use a .${allowed.join(' or .')} file.` }
  }

  if (!Number.isFinite(file.size) || file.size <= 0) return { ok: false, message: 'The selected image is empty.' }
  if (file.size > MAX_SUBMISSION_BYTES) return { ok: false, message: 'Images must be 10 MB or smaller.' }

  return { ok: true, ext }
}

/** A pre-upload answer stored only a bare file name (no folder), so no object exists for it. */
export function isLegacyFileName(value: string | null | undefined): boolean {
  return Boolean(value) && !String(value).includes('/')
}

function isObjectPath(value: string | null | undefined): value is string {
  return Boolean(value) && String(value).includes('/')
}

export function buildSubmissionPath(schoolId: string, attemptId: string, questionId: string, ext: string) {
  return `${schoolId}/${attemptId}/${questionId}_${crypto.randomUUID()}.${ext}`
}

export async function uploadSubmissionImage(input: {
  attemptId: string
  schoolId: string
  questionId: string
  file: File
  previousPath?: string | null
}): Promise<{ path: string | null; error: Error | unknown | null }> {
  const { attemptId, schoolId, questionId, file, previousPath } = input
  const validation = validateSubmissionImage(file)
  if (!validation.ok) return { path: null, error: new Error(validation.message) }
  if (!supabase) return { path: null, error: notConfigured() }

  const path = buildSubmissionPath(schoolId, attemptId, questionId, validation.ext)
  const bucket = supabase.storage.from(SUBMISSION_BUCKET)
  const { error: uploadError } = await bucket.upload(path, file, { contentType: file.type, upsert: false })
  if (uploadError) return { path: null, error: uploadError }

  const { error: rowError } = await supabase
    .from('LQ_answers')
    .upsert(
      { attempt_id: attemptId, question_id: questionId, answer_text: null, file_path: path },
      { onConflict: 'attempt_id,question_id' },
    )
  if (rowError) {
    await supabase.storage.from(SUBMISSION_BUCKET).remove([path])
    return { path: null, error: rowError }
  }

  // Best effort: a legacy bare name has no object, so it is only overwritten in the row.
  if (isObjectPath(previousPath) && previousPath !== path) {
    await supabase.storage.from(SUBMISSION_BUCKET).remove([previousPath])
  }

  return { path, error: null }
}

export async function removeSubmissionImage(input: {
  attemptId: string
  questionId: string
  path: string | null | undefined
}): Promise<{ error: Error | unknown | null }> {
  if (!supabase) return { error: notConfigured() }
  const { attemptId, questionId, path } = input

  const { error: rowError } = await supabase
    .from('LQ_answers')
    .update({ file_path: null })
    .eq('attempt_id', attemptId)
    .eq('question_id', questionId)
  if (rowError) return { error: rowError }

  if (isObjectPath(path)) {
    const { error: removeError } = await supabase.storage.from(SUBMISSION_BUCKET).remove([path])
    if (removeError) return { error: removeError }
  }
  return { error: null }
}

export async function signedSubmissionUrl(path: string | null | undefined): Promise<{ url: string | null; error: Error | unknown | null }> {
  if (!isObjectPath(path)) {
    return { url: null, error: new Error('This answer has no stored image.') }
  }
  if (!supabase) return { url: null, error: notConfigured() }
  const { data, error } = await supabase.storage.from(SUBMISSION_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS)
  return { url: data?.signedUrl ?? null, error }
}

export async function listAttemptObjectPaths(schoolId: string, attemptId: string): Promise<{ paths: string[]; error: Error | unknown | null }> {
  if (!supabase) return { paths: [], error: notConfigured() }
  const folder = `${schoolId}/${attemptId}`
  const { data, error } = await supabase.storage.from(SUBMISSION_BUCKET).list(folder, { limit: 1000 })
  if (error) return { paths: [], error }
  const paths = (data ?? []).filter((item) => item?.name).map((item) => `${folder}/${item.name}`)
  return { paths, error: null }
}

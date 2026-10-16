/**
 * Unit and property tests for src/lib/submissionUploads.ts (task 3.7).
 *
 * Validates: Requirements 2.7, 2.8, 2.9, 2.10, 2.13, 3.10, 3.12, 3.16
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { stub, isWrite, opArgs } from './support/stubSupabase'
import {
  ALLOWED_SUBMISSION_TYPES,
  MAX_SUBMISSION_BYTES,
  SUBMISSION_BUCKET,
  buildSubmissionPath,
  isLegacyFileName,
  listAttemptObjectPaths,
  removeSubmissionImage,
  signedSubmissionUrl,
  uploadSubmissionImage,
  validateSubmissionImage,
} from '../src/lib/submissionUploads'

vi.mock('../src/lib/supabase', async () => {
  const { stub: client } = await import('./support/stubSupabase')
  return {
    supabase: client.client,
    isSupabaseConfigured: true,
    internalAuthIdentifier: (value: string) => `${value.trim().toLowerCase()}@auth.latequiz.internal`,
  }
})

beforeEach(() => stub.reset())

const SCHOOL = '11111111-1111-4111-8111-111111111111'
const ATTEMPT = '22222222-2222-4222-8222-222222222222'
const QUESTION = '33333333-3333-4333-8333-333333333333'
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

function png(name = 'diagram.png') {
  return new File([new Uint8Array(1024)], name, { type: 'image/png' })
}

function storageCalls(method: string) {
  return stub.calls.filter((call) => call.kind === 'storage' && call.method === method) as Array<{ bucket: string; args: unknown[] }>
}

function answerWrites() {
  return stub.calls.filter((call) => call.kind === 'from' && call.table === 'LQ_answers' && isWrite(call)) as Array<{ ops: { method: string; args: unknown[] }[] }>
}

describe('validateSubmissionImage', () => {
  it('accepts allowed images and returns the lowercase extension', () => {
    expect(validateSubmissionImage({ name: 'a.PNG', type: 'image/png', size: 1 })).toEqual({ ok: true, ext: 'png' })
    expect(validateSubmissionImage({ name: 'b.jpeg', type: 'image/jpeg', size: MAX_SUBMISSION_BYTES })).toEqual({ ok: true, ext: 'jpeg' })
    expect(validateSubmissionImage({ name: 'c.webp', type: 'image/webp', size: 500 })).toEqual({ ok: true, ext: 'webp' })
  })

  it('rejects wrong types, mismatched extensions, empty and oversize files with a message', () => {
    const cases = [
      { name: 'essay.pdf', type: 'application/pdf', size: 200_000 },
      { name: 'photo.png', type: 'image/jpeg', size: 100 },
      { name: 'noext', type: 'image/png', size: 100 },
      { name: 'empty.png', type: 'image/png', size: 0 },
      { name: 'big.jpg', type: 'image/jpeg', size: MAX_SUBMISSION_BYTES + 1 },
    ]
    for (const file of cases) {
      const result = validateSubmissionImage(file)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message.length).toBeGreaterThan(0)
    }
  })

  it('accepts exactly the files that satisfy the allow-list and size bounds (PBT)', () => {
    const types = [...Object.keys(ALLOWED_SUBMISSION_TYPES), 'application/pdf', 'image/gif', 'text/plain', '']
    const exts = ['jpg', 'jpeg', 'JPG', 'png', 'PNG', 'webp', 'gif', 'pdf', 'txt', '']
    const file = fc.record({
      type: fc.constantFrom(...types),
      base: fc.stringMatching(/^[A-Za-z0-9_-]{0,12}$/),
      ext: fc.constantFrom(...exts),
      size: fc.oneof(
        fc.integer({ min: -10, max: 10 }),
        fc.integer({ min: MAX_SUBMISSION_BYTES - 10, max: MAX_SUBMISSION_BYTES + 10 }),
        fc.integer({ min: 0, max: 20 * 1024 * 1024 }),
      ),
    })
    fc.assert(
      fc.property(file, ({ type, base, ext, size }) => {
        const name = ext ? `${base}.${ext}` : base
        const allowedExts = ALLOWED_SUBMISSION_TYPES[type]
        const expected = Boolean(allowedExts) && allowedExts.includes(ext.toLowerCase()) && ext !== '' && size > 0 && size <= MAX_SUBMISSION_BYTES
        const result = validateSubmissionImage({ name, type, size })
        expect(result.ok).toBe(expected)
        if (result.ok) expect(result.ext).toBe(ext.toLowerCase())
      }),
      { numRuns: 300 },
    )
  })
})

describe('path helpers', () => {
  it('builds {school}/{attempt}/{question}_{uuid}.{ext}', () => {
    const path = buildSubmissionPath(SCHOOL, ATTEMPT, QUESTION, 'png')
    expect(path).toMatch(new RegExp(`^${SCHOOL}/${ATTEMPT}/${QUESTION}_${UUID.source}\\.png$`))
    expect(buildSubmissionPath(SCHOOL, ATTEMPT, QUESTION, 'png')).not.toBe(path)
  })

  it('detects legacy bare file names', () => {
    expect(isLegacyFileName('diagram.png')).toBe(true)
    expect(isLegacyFileName(`${SCHOOL}/${ATTEMPT}/x.png`)).toBe(false)
    expect(isLegacyFileName('')).toBe(false)
    expect(isLegacyFileName(null)).toBe(false)
    expect(isLegacyFileName(undefined)).toBe(false)
  })
})

describe('uploadSubmissionImage', () => {
  it('uploads to lq-submissions and upserts the answer row with the object path', async () => {
    const file = png()
    const result = await uploadSubmissionImage({ attemptId: ATTEMPT, schoolId: SCHOOL, questionId: QUESTION, file, previousPath: null })

    expect(result.error).toBeNull()
    const [upload] = storageCalls('upload')
    expect(upload.bucket).toBe(SUBMISSION_BUCKET)
    expect(upload.args[0]).toBe(result.path)
    expect(upload.args[2]).toMatchObject({ contentType: 'image/png', upsert: false })
    const [write] = answerWrites()
    expect(opArgs(write, 'upsert')).toEqual([
      { attempt_id: ATTEMPT, question_id: QUESTION, answer_text: null, file_path: result.path },
      { onConflict: 'attempt_id,question_id' },
    ])
    expect(storageCalls('remove')).toEqual([])
  })

  it('rejects invalid files without any storage or row call', async () => {
    const file = new File([new Uint8Array(10)], 'essay.pdf', { type: 'application/pdf' })
    const result = await uploadSubmissionImage({ attemptId: ATTEMPT, schoolId: SCHOOL, questionId: QUESTION, file })
    expect(result.path).toBeNull()
    expect(result.error).toBeInstanceOf(Error)
    expect(stub.calls).toEqual([])
  })

  it('removes a superseded real object after a successful replace', async () => {
    const previousPath = `${SCHOOL}/${ATTEMPT}/${QUESTION}_old.png`
    const result = await uploadSubmissionImage({ attemptId: ATTEMPT, schoolId: SCHOOL, questionId: QUESTION, file: png(), previousPath })
    expect(result.error).toBeNull()
    expect(storageCalls('remove').map((call) => call.args[0])).toEqual([[previousPath]])
  })

  it('replaces a legacy bare-name previousPath without calling storage.remove', async () => {
    const result = await uploadSubmissionImage({ attemptId: ATTEMPT, schoolId: SCHOOL, questionId: QUESTION, file: png(), previousPath: 'diagram.png' })
    expect(result.error).toBeNull()
    expect(storageCalls('remove')).toEqual([])
    expect((opArgs(answerWrites()[0], 'upsert')?.[0] as { file_path: string }).file_path).toBe(result.path)
  })

  it('removes the new object and returns the error when the row write fails', async () => {
    const rowError = { message: 'row write failed' }
    stub.onTable('LQ_answers', () => ({ data: null, error: rowError }))
    const previousPath = `${SCHOOL}/${ATTEMPT}/${QUESTION}_old.png`
    const result = await uploadSubmissionImage({ attemptId: ATTEMPT, schoolId: SCHOOL, questionId: QUESTION, file: png(), previousPath })

    expect(result).toEqual({ path: null, error: rowError })
    const uploadedPath = storageCalls('upload')[0].args[0]
    expect(storageCalls('remove').map((call) => call.args[0])).toEqual([[uploadedPath]])
  })
})

describe('removeSubmissionImage', () => {
  it('nulls the row then removes the object', async () => {
    const path = `${SCHOOL}/${ATTEMPT}/${QUESTION}_x.png`
    const result = await removeSubmissionImage({ attemptId: ATTEMPT, questionId: QUESTION, path })
    expect(result.error).toBeNull()
    const [write] = answerWrites()
    expect(opArgs(write, 'update')).toEqual([{ file_path: null }])
    expect(write.ops.filter((op) => op.method === 'eq').map((op) => op.args)).toEqual([
      ['attempt_id', ATTEMPT],
      ['question_id', QUESTION],
    ])
    expect(storageCalls('remove').map((call) => call.args[0])).toEqual([[path]])
    expect(stub.calls.findIndex((call) => call.kind === 'from')).toBeLessThan(stub.calls.findIndex((call) => call.kind === 'storage'))
  })

  it('only nulls the row for a legacy bare name', async () => {
    const result = await removeSubmissionImage({ attemptId: ATTEMPT, questionId: QUESTION, path: 'diagram.png' })
    expect(result.error).toBeNull()
    expect(answerWrites()).toHaveLength(1)
    expect(storageCalls('remove')).toEqual([])
  })
})

describe('signedSubmissionUrl and listAttemptObjectPaths', () => {
  it('signs real paths for 300 seconds', async () => {
    const path = `${SCHOOL}/${ATTEMPT}/${QUESTION}_x.png`
    const result = await signedSubmissionUrl(path)
    expect(result).toEqual({ url: `https://signed.example/${path}`, error: null })
    expect(storageCalls('createSignedUrl')[0].args).toEqual([path, 300])
  })

  it('short-circuits legacy names without a storage call', async () => {
    const result = await signedSubmissionUrl('diagram.png')
    expect(result.url).toBeNull()
    expect(result.error).toBeInstanceOf(Error)
    expect(stub.calls).toEqual([])
  })

  it('lists the attempt folder and maps to full paths', async () => {
    stub.onStorage((method) => (method === 'list' ? { data: [{ name: 'a.png' }, { name: 'b.jpg' }], error: null } : undefined))
    const result = await listAttemptObjectPaths(SCHOOL, ATTEMPT)
    expect(result).toEqual({ paths: [`${SCHOOL}/${ATTEMPT}/a.png`, `${SCHOOL}/${ATTEMPT}/b.jpg`], error: null })
    expect(storageCalls('list')[0].args).toEqual([`${SCHOOL}/${ATTEMPT}`, { limit: 1000 }])
  })
})

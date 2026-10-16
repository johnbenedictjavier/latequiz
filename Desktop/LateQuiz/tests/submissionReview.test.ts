/**
 * Unit tests for the submission review drawer helpers and deleteSubmission (task 3.9).
 *
 * Validates: Requirements 2.6, 2.9, 2.11, 2.13, 3.11, 3.16
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stub } from './support/stubSupabase'
import { answerKeyDisplay, collectDeletePaths, LEGACY_REVIEW_NOTICE, NO_FIXED_ANSWER, submissionImageMode } from '../src/lib/submissionReview'
import { DELETE_STORAGE_WARNING, deleteSubmission } from '../src/lib/submissions'
import { SUBMISSION_BUCKET } from '../src/lib/submissionUploads'

vi.mock('../src/lib/supabase', async () => {
  const { stub: client } = await import('./support/stubSupabase')
  return {
    supabase: client.client,
    isSupabaseConfigured: true,
    internalAuthIdentifier: (value: string) => `${value.trim().toLowerCase()}@auth.latequiz.internal`,
  }
})

beforeEach(() => stub.reset())

const SCHOOL = 'S-1001'
const ATTEMPT = '22222222-2222-4222-8222-222222222222'
const PREFIX = `${SCHOOL}/${ATTEMPT}/`
const realA = `${PREFIX}q1_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`
const realB = `${PREFIX}q2_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp`
const foreign = `S-2002/${ATTEMPT}/q1_cccccccc-cccc-4ccc-8ccc-cccccccccccc.png`
const otherAttempt = `${SCHOOL}/99999999-9999-4999-8999-999999999999/q1_x.png`

function storageCalls(method?: string) {
  return stub.calls.filter((call) => call.kind === 'storage' && (!method || call.method === method)) as Array<{ bucket: string; method: string; args: unknown[] }>
}

function seedAnswers(paths: Array<string | null>) {
  stub.onTable('LQ_answers', () => ({ data: paths.map((file_path) => ({ file_path })), error: null }))
}

describe('answerKeyDisplay', () => {
  it('lists every accepted key for identification, in admin order', () => {
    expect(answerKeyDisplay('identification', ['Central Processing Unit', 'CPU'])).toEqual({ kind: 'list', label: 'Accepted answers', values: ['Central Processing Unit', 'CPU'] })
    expect(answerKeyDisplay('identification', [])).toEqual({ kind: 'list', label: 'Accepted answers', values: [] })
  })

  it('shows the first key as "Correct answer" for other types', () => {
    expect(answerKeyDisplay('multiple-choice', ['B', 'C'])).toEqual({ kind: 'single', label: 'Correct answer', value: 'B' })
    expect(answerKeyDisplay('upload', [])).toEqual({ kind: 'single', label: 'Correct answer', value: NO_FIXED_ANSWER })
  })
})

describe('submissionImageMode', () => {
  it('classifies empty, legacy bare names, and object paths', () => {
    expect(submissionImageMode(null)).toBe('empty')
    expect(submissionImageMode('')).toBe('empty')
    expect(submissionImageMode('diagram.png')).toBe('legacy')
    expect(submissionImageMode(realA)).toBe('stored')
  })

  it('uses the exact legacy notice text', () => {
    expect(LEGACY_REVIEW_NOTICE).toBe('Image not available: this answer was submitted before image uploads were enabled, so only the file name was saved.')
  })
})

describe('collectDeletePaths', () => {
  it('keeps only real paths under the attempt folder, deduplicated', () => {
    const paths = collectDeletePaths(SCHOOL, ATTEMPT, ['diagram.png', realA, null, foreign, realA, otherAttempt, ''], [realA, realB, PREFIX])
    expect(paths).toEqual([realA, realB])
  })

  it('returns nothing for bare names only', () => {
    expect(collectDeletePaths(SCHOOL, ATTEMPT, ['diagram.png', 'photo.jpg'], [])).toEqual([])
  })
})

describe('deleteSubmission', () => {
  it('returns the RPC error and touches no storage removal when LQ_delete_attempt fails', async () => {
    seedAnswers([realA])
    stub.onRpc('LQ_delete_attempt', () => ({ data: null, error: { message: 'permission denied' } }))
    const result = await deleteSubmission({ id: ATTEMPT, schoolId: SCHOOL })
    expect(result).toEqual({ error: { message: 'permission denied' } })
    expect(storageCalls('remove')).toEqual([])
  })

  it('removes only prefixed real paths (deduped) after a successful delete', async () => {
    seedAnswers(['diagram.png', realA, foreign, null])
    stub.onStorage((method) => (method === 'list' ? { data: [{ name: realA.slice(PREFIX.length) }, { name: realB.slice(PREFIX.length) }], error: null } : undefined))
    const result = await deleteSubmission({ id: ATTEMPT, schoolId: SCHOOL })

    expect(result).toEqual({ error: null })
    const rpcIndex = stub.calls.findIndex((call) => call.kind === 'rpc' && call.name === 'LQ_delete_attempt')
    const removeIndex = stub.calls.findIndex((call) => call.kind === 'storage' && call.method === 'remove')
    expect(stub.calls[rpcIndex]).toMatchObject({ args: { p_attempt_id: ATTEMPT } })
    expect(rpcIndex).toBeLessThan(removeIndex)
    const removes = storageCalls('remove')
    expect(removes).toHaveLength(1)
    expect(removes[0].bucket).toBe(SUBMISSION_BUCKET)
    expect(removes[0].args[0]).toEqual([realA, realB])
  })

  it('makes no storage.remove call when there is nothing to remove', async () => {
    seedAnswers(['diagram.png', null])
    const result = await deleteSubmission({ id: ATTEMPT, schoolId: SCHOOL })
    expect(result).toEqual({ error: null })
    expect(storageCalls('remove')).toEqual([])
  })

  it('reports a warning when storage removal fails after the delete succeeds', async () => {
    seedAnswers([realA])
    stub.onStorage((method) => (method === 'remove' ? { data: null, error: { message: 'storage down' } } : undefined))
    const result = await deleteSubmission({ id: ATTEMPT, schoolId: SCHOOL })
    expect(result).toEqual({ error: null, warning: DELETE_STORAGE_WARNING })
  })
})

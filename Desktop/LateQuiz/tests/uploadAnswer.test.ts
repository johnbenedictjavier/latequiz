/**
 * Unit tests for the student quiz upload answer helpers (task 3.8).
 *
 * Validates: Requirements 2.7, 2.8, 2.10, 2.13, 3.6, 3.16
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/supabase', () => ({ supabase: null, isSupabaseConfigured: false }))

import {
  LEGACY_UPLOAD_NOTICE,
  UPLOAD_ACCEPT,
  UPLOAD_HINT,
  isSubmitBlockedByUploads,
  nextUploadCount,
  uploadAnswerState,
  uploadDisplayName,
} from '../src/lib/uploadAnswer'

const uuid = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b'
const questionId = '7d1e2f3a-4b5c-4d6e-8f70-112233445566'
const objectPath = `S-1001/attempt-1/${questionId}_${uuid}.png`

describe('picker copy', () => {
  it('advertises images only, up to 10 MB', () => {
    expect(UPLOAD_HINT).toBe('JPG, PNG, or WEBP image up to 10 MB')
    expect(UPLOAD_ACCEPT).toBe('image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp')
    expect(UPLOAD_ACCEPT).not.toContain('pdf')
  })
})

describe('uploadAnswerState', () => {
  it('classifies empty, legacy bare names, and stored object paths', () => {
    expect(uploadAnswerState('')).toBe('empty')
    expect(uploadAnswerState(null)).toBe('empty')
    expect(uploadAnswerState(undefined)).toBe('empty')
    expect(uploadAnswerState('diagram.png')).toBe('legacy')
    expect(uploadAnswerState(objectPath)).toBe('stored')
  })

  it('the legacy notice says the image was not stored and asks for it again', () => {
    expect(LEGACY_UPLOAD_NOTICE).toMatch(/^Image not available/)
    expect(LEGACY_UPLOAD_NOTICE).toMatch(/never stored/)
    expect(LEGACY_UPLOAD_NOTICE).toMatch(/Choose the image again/)
  })
})

describe('uploadDisplayName', () => {
  it('prefers the original file name picked this session', () => {
    expect(uploadDisplayName(objectPath, 'diagram.png')).toBe('diagram.png')
  })

  it('shows a legacy bare name unchanged', () => {
    expect(uploadDisplayName('diagram.png')).toBe('diagram.png')
  })

  it('replaces the generated {question_id}_{uuid} name after reload', () => {
    expect(uploadDisplayName(objectPath)).toBe('Uploaded image (PNG)')
    expect(uploadDisplayName(`S-1001/a/${questionId}_${uuid}.jpeg`)).toBe('Uploaded image (JPEG)')
  })

  it('falls back to the basename for other paths', () => {
    expect(uploadDisplayName('S-1001/a/custom-name.webp')).toBe('custom-name.webp')
  })

  it('returns an empty string for no answer', () => {
    expect(uploadDisplayName('')).toBe('')
  })
})

describe('upload in-flight tracking', () => {
  it('blocks manual submit and exit while an upload runs, never the timeout', () => {
    expect(isSubmitBlockedByUploads(1, 'manual')).toBe(true)
    expect(isSubmitBlockedByUploads(2, 'exit')).toBe(true)
    expect(isSubmitBlockedByUploads(1, 'timeout')).toBe(false)
    expect(isSubmitBlockedByUploads(0, 'manual')).toBe(false)
    expect(isSubmitBlockedByUploads(0, 'exit')).toBe(false)
  })

  it('counts busy transitions and never goes negative', () => {
    expect(nextUploadCount(0, true)).toBe(1)
    expect(nextUploadCount(1, true)).toBe(2)
    expect(nextUploadCount(2, false)).toBe(1)
    expect(nextUploadCount(0, false)).toBe(0)
  })
})

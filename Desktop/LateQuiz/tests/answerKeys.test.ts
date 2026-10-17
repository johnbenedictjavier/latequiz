import { describe, expect, it } from 'vitest'
import {
  matchesAnyKey,
  normalize,
  toKeyList,
  validateAnswerKeys,
} from '../supabase/functions/_shared/answerKeys.ts'

describe('validateAnswerKeys', () => {
  it('rejects zero fields', () => {
    expect(validateAnswerKeys([])).toEqual({
      ok: false,
      message: 'Identification questions need at least one answer key.',
    })
  })

  it.each([[['']], [['A', ' ']]])('rejects a blank field in %j', (fields) => {
    const result = validateAnswerKeys(fields)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/blank/i)
  })

  it('rejects keys that are duplicates after trimming and case folding', () => {
    expect(validateAnswerKeys(['RAM', ' ram '])).toEqual({
      ok: false,
      message: "Answer keys 'RAM' and ' ram ' are duplicates.",
    })
  })

  it('rejects keys that are duplicates after NFKC normalization', () => {
    const result = validateAnswerKeys(['\uFB01', 'fi'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/duplicates/)
  })

  it('accepts distinct keys and returns them trimmed in admin order', () => {
    expect(validateAnswerKeys([' CPU', 'Central Processing Unit '])).toEqual({
      ok: true,
      keys: ['CPU', 'Central Processing Unit'],
    })
    expect(validateAnswerKeys(['CPU', 'Central Processing Unit'])).toEqual({
      ok: true,
      keys: ['CPU', 'Central Processing Unit'],
    })
  })
})

describe('matchesAnyKey / toKeyList / normalize', () => {
  it('matches any key after normalization', () => {
    const keys = ['CPU', 'Central Processing Unit']
    expect(matchesAnyKey('  central   processing unit ', keys)).toBe(true)
    expect(matchesAnyKey('cpu', keys)).toBe(true)
    expect(matchesAnyKey('GPU', keys)).toBe(false)
    expect(matchesAnyKey('anything', [])).toBe(false)
  })

  it('toKeyList returns [] for missing rows or keys', () => {
    expect(toKeyList(null)).toEqual([])
    expect(toKeyList(undefined)).toEqual([])
    expect(toKeyList({ answer_keys: null })).toEqual([])
    expect(toKeyList({ answer_keys: ['a', 'b'] })).toEqual(['a', 'b'])
  })

  it('normalize keeps the original edge-function behavior', () => {
    expect(normalize(null)).toBe('')
    expect(normalize('  Hello\t  World ')).toBe('hello world')
    expect(normalize('\uFB01')).toBe('fi')
  })
})

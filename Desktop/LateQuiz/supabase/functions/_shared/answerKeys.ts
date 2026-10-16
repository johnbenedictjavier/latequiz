// Shared answer-key helpers used by the submit-attempt / finalize-expired-attempts
// edge functions (Deno) and the admin quiz editor (Vite). No imports so the
// module loads unchanged in both runtimes.

/** Canonical comparison form for identification answers and keys. */
export function normalize(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Returns the stored answer keys for a `LQ_question_keys` row, or [] when absent. */
export function toKeyList(row: { answer_keys?: string[] | null } | null | undefined): string[] {
  return row?.answer_keys ?? []
}

/** True when the normalized answer equals the normalized form of any key. */
export function matchesAnyKey(answer: string | null | undefined, keys: readonly string[]): boolean {
  const normalizedAnswer = normalize(answer)
  return keys.some((key) => normalize(key) === normalizedAnswer)
}

export type AnswerKeysValidation = { ok: true; keys: string[] } | { ok: false; message: string }

/**
 * Validates the admin-entered answer key fields for an identification question.
 * Rejects zero fields, any blank field, and keys that collide after normalization.
 * On success returns the trimmed keys in admin order.
 */
export function validateAnswerKeys(fields: readonly string[]): AnswerKeysValidation {
  if (fields.length === 0) {
    return { ok: false, message: 'Identification questions need at least one answer key.' }
  }

  const keys = fields.map((field) => (field ?? '').trim())
  const blankIndex = keys.findIndex((key) => normalize(key) === '')
  if (blankIndex !== -1) {
    return { ok: false, message: `Answer key ${blankIndex + 1} is blank. Fill it in or remove it.` }
  }

  const seen = new Map<string, number>()
  for (let index = 0; index < keys.length; index += 1) {
    const normalized = normalize(keys[index])
    const firstIndex = seen.get(normalized)
    if (firstIndex !== undefined) {
      return {
        ok: false,
        message: `Answer keys '${fields[firstIndex]}' and '${fields[index]}' are duplicates.`,
      }
    }
    seen.set(normalized, index)
  }

  return { ok: true, keys }
}

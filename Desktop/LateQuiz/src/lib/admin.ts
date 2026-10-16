import { supabase } from './supabase'
import { validateAnswerKeys } from '../../supabase/functions/_shared/answerKeys.ts'
import type { Question, QuizPart, Student, TemporaryCredential } from '../types'

/**
 * The answer key fields for an identification question in admin order.
 * Falls back to the single `answer` (e.g. PDF-imported questions) and to one
 * empty field when nothing is set, so validation reports a blank key.
 */
export function identificationKeyFields(question: Pick<Question, 'answer' | 'answers'>): string[] {
  return question.answers ?? (question.answer ? [question.answer] : [''])
}

/** `answer_keys` value stored in `LQ_question_keys` for a non-identification question. */
function nonIdentificationKeys(question: Question): string[] | null {
  const answer = question.answer?.trim() ?? ''
  if (question.type === 'multiple-choice') return [answer]
  return answer ? [answer] : null
}

export const DEFAULT_STUDENT_PASSWORD = 'LQ@Architect2026'

export async function provisionStudentAccounts(students: Student[]) {
  if (!supabase) {
    return {
      credentials: students.map((student, index): TemporaryCredential => ({
        schoolId: student.schoolId,
        name: `${student.firstNames} ${student.lastName}`,
        password: DEFAULT_STUDENT_PASSWORD,
      })),
      error: new Error('Supabase is not configured.'),
    }
  }

  const { data, error } = await supabase.functions.invoke('provision-students', {
    body: { students: students.map(({ schoolId, lastName, firstNames }) => ({ schoolId, lastName, firstNames })) },
  })

  return {
    credentials: (data?.credentials ?? []) as TemporaryCredential[],
    error,
  }
}

type SaveQuizInput = {
  id?: string
  title: string
  subject: string
  description: string
  passingScore: number
  durationMinutes: number
  status: 'draft' | 'published'
  parts?: QuizPart[]
  questions?: Question[]
  collaboratorSchoolIds?: string[]
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function fallbackParts(input: SaveQuizInput) {
  if (input.parts?.length) return input.parts
  return [{ id: 'legacy-part', title: 'General', position: 1, questions: input.questions ?? [] }]
}

export async function saveQuiz(input: SaveQuizInput) {
  if (!supabase) return { id: null, error: new Error('Supabase is not configured.') }

  const parts = fallbackParts(input)

  // Validate identification keys before any write (defense in depth behind the builder check).
  const validatedKeys = new Map<Question, string[]>()
  for (const [partIndex, part] of parts.entries()) {
    for (const [questionIndex, question] of part.questions.entries()) {
      if (question.type !== 'identification') continue
      const validation = validateAnswerKeys(identificationKeyFields(question))
      if (!validation.ok) {
        return { id: null, error: new Error(`Part ${partIndex + 1}, question ${questionIndex + 1}: ${validation.message}`) }
      }
      validatedKeys.set(question, validation.keys)
    }
  }

  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) return { id: null, error: userError ?? new Error('You must be signed in to save a quiz.') }

  const quizPayload = {
    title: input.title.trim(),
    subject: input.subject,
    description: input.description.trim(),
    duration_seconds: Math.max(1, Math.round(input.durationMinutes * 60)),
    passing_score: input.passingScore,
    status: input.status,
    created_by: userData.user.id,
    published_at: input.status === 'published' ? new Date().toISOString() : null,
  }

  let quizId = input.id
  if (quizId) {
    const { error } = await supabase.from('LQ_quizzes').update(quizPayload).eq('id', quizId)
    if (error) return { id: null, error }
  } else {
    const { data, error } = await supabase.from('LQ_quizzes').insert(quizPayload).select('id').single()
    if (error) return { id: null, error }
    quizId = data.id as string
  }

  const { data: existingPartRows, error: existingPartError } = await supabase
    .from('LQ_quiz_parts')
    .select('id')
    .eq('quiz_id', quizId)
  if (existingPartError) return { id: null, error: existingPartError }

  const existingPartIds = new Set((existingPartRows ?? []).map((row) => row.id as string))
  const persistedPartIds = new Map<string, string>()

  // Move existing rows out of the way before applying a reordered part list.
  for (const [index, row] of (existingPartRows ?? []).entries()) {
    const { error } = await supabase.from('LQ_quiz_parts').update({ position: 100000 + index }).eq('id', row.id)
    if (error) return { id: null, error }
  }

  for (const [index, part] of parts.entries()) {
    const partPayload = { quiz_id: quizId, position: index + 1, title: part.title.trim() || `Part ${index + 1}` }
    if (isUuid(part.id) && existingPartIds.has(part.id)) {
      const { error } = await supabase.from('LQ_quiz_parts').update(partPayload).eq('id', part.id)
      if (error) return { id: null, error }
      persistedPartIds.set(part.id, part.id)
    } else {
      const { data, error } = await supabase.from('LQ_quiz_parts').insert(partPayload).select('id').single()
      if (error) return { id: null, error }
      persistedPartIds.set(part.id, data.id as string)
    }
  }

  const activePartIds = new Set(persistedPartIds.values())
  const removedPartIds = [...existingPartIds].filter((id) => !activePartIds.has(id))

  const { data: existingQuestionRows, error: existingQuestionError } = await supabase
    .from('LQ_questions')
    .select('id')
    .eq('quiz_id', quizId)
  if (existingQuestionError) return { id: null, error: existingQuestionError }

  const questions = parts.flatMap((part) => part.questions)
  const existingQuestionIds = new Set((existingQuestionRows ?? []).map((row) => row.id as string))
  const incomingQuestionIds = new Set(questions.filter((question) => isUuid(question.id)).map((question) => question.id))
  const removedQuestionIds = [...existingQuestionIds].filter((id) => !incomingQuestionIds.has(id))
  if (removedQuestionIds.length) {
    const { error } = await supabase.from('LQ_questions').delete().in('id', removedQuestionIds)
    if (error) return { id: null, error }
  }

  // Questions reference parts with ON DELETE RESTRICT, so remove their
  // questions before deleting parts removed from the builder.
  if (removedPartIds.length) {
    const { error } = await supabase.from('LQ_quiz_parts').delete().in('id', removedPartIds)
    if (error) return { id: null, error }
  }

  // Avoid unique-position conflicts while questions are reordered.
  for (const [index, row] of (existingQuestionRows ?? []).entries()) {
    const { error } = await supabase.from('LQ_questions').update({ position: 100000 + index }).eq('id', row.id)
    if (error) return { id: null, error }
  }

  let globalPosition = 0
  for (const [partIndex, part] of parts.entries()) {
    const persistedPartId = persistedPartIds.get(part.id)
    if (!persistedPartId) return { id: null, error: new Error(`Could not save ${part.title}.`) }
    for (const [partPosition, question] of part.questions.entries()) {
      globalPosition += 1
      const questionRow = {
        quiz_id: quizId,
        part_id: persistedPartId,
        position: globalPosition,
        part_position: partPosition + 1,
        question_type: question.type,
        prompt: question.prompt.trim(),
        points: question.points,
        options: question.type === 'multiple-choice' ? (question.options ?? []).map((option) => option.trim()) : [],
        requires_manual_review: question.requiresReview ?? (question.type === 'essay' || question.type === 'upload'),
      }
      const shouldUpdate = isUuid(question.id) && existingQuestionIds.has(question.id)
      const result = shouldUpdate
        ? await supabase.from('LQ_questions').update(questionRow).eq('id', question.id).eq('quiz_id', quizId).select('id').single()
        : await supabase.from('LQ_questions').insert(questionRow).select('id').single()
      if (result.error) return { id: null, error: result.error }
      const persistedQuestionId = (result.data?.id as string | undefined) ?? question.id
      const { error: keyError } = await supabase.from('LQ_question_keys').upsert({
        question_id: persistedQuestionId,
        answer_keys: question.type === 'identification'
          ? validatedKeys.get(question) ?? []
          : nonIdentificationKeys(question),
      }, { onConflict: 'question_id' })
      if (keyError) return { id: null, error: keyError }
    }
    if (!part.questions.length) {
      const { error } = await supabase.from('LQ_quiz_parts').update({ position: partIndex + 1 }).eq('id', persistedPartId)
      if (error) return { id: null, error }
    }
  }

  const { error: collaboratorError } = await supabase.rpc('LQ_sync_quiz_collaborators', {
    p_quiz_id: quizId,
    p_school_ids: input.collaboratorSchoolIds ?? [],
  })
  if (collaboratorError) return { id: null, error: collaboratorError }

  return { id: quizId, error: null }
}

export async function assignQuiz(quizId: string, schoolIds: string[], attemptLimit: number) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase.rpc('LQ_sync_quiz_assignments', {
    p_quiz_id: quizId,
    p_school_ids: schoolIds,
    p_attempt_limit: Math.max(1, Math.floor(attemptLimit)),
  })
  return { data, error }
}

export async function loadQuizAssignments(quizId: string) {
  if (!supabase) return { data: [], error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase
    .from('LQ_quiz_assignments')
    .select('school_id, attempt_limit')
    .eq('quiz_id', quizId)
    .eq('is_active', true)
  return { data: data ?? [], error }
}

export async function loadQuizCollaborators(quizId: string) {
  if (!supabase) return { data: [] as string[], error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase
    .from('LQ_quiz_collaborators')
    .select('school_id')
    .eq('quiz_id', quizId)
    .eq('role', 'reporter')
  return { data: (data ?? []).map((row) => row.school_id as string), error }
}

export async function deleteQuiz(quizId: string) {
  if (!supabase) return { result: null, error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase.rpc('LQ_delete_quiz', { p_quiz_id: quizId })
  return { result: data as 'deleted' | 'archived' | null, error }
}

export async function setQuizStatus(quizId: string, status: 'draft' | 'published' | 'archived') {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const { error } = await supabase
    .from('LQ_quizzes')
    .update({ status, published_at: status === 'published' ? new Date().toISOString() : null })
    .eq('id', quizId)
  return { error }
}

export async function saveStudent(student: Student, originalSchoolId?: string) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const schoolId = student.schoolId.trim().toUpperCase()
  const lastName = student.lastName.trim()
  const firstNames = student.firstNames.trim()
  if (!/^\d{2}-\d{5}$/.test(schoolId)) return { error: new Error('Use a valid school ID in the format 24-00000.') }
  if (!lastName || !firstNames) return { error: new Error('First names and last name are required.') }
  const payload = {
    school_id: schoolId,
    last_name: lastName,
    first_names: firstNames,
    is_active: student.active ?? true,
  }
  if (originalSchoolId) {
    const { data, error } = await supabase
      .from('LQ_student_roster')
      .update(payload)
      .eq('school_id', originalSchoolId.trim().toUpperCase())
      .select('school_id')
      .maybeSingle()
    if (error) return { error }
    if (!data) return { error: new Error('The student record no longer exists.') }
  } else {
    const { error } = await supabase.from('LQ_student_roster').insert(payload)
    if (error) return { error }
  }

  if ((!originalSchoolId && payload.is_active) || (originalSchoolId && payload.is_active && student.accountReady === false)) {
    const provisioned = await provisionStudentAccounts([{ ...student, schoolId }])
    if (provisioned.error) return { error: provisioned.error }
  }
  return { error: null }
}

export async function deleteStudent(schoolId: string) {
  if (!supabase) return { result: null as 'deleted' | 'deactivated' | null, warning: undefined as string | undefined, error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase.functions.invoke('delete-student', { body: { schoolId } })
  return {
    result: (data?.result ?? null) as 'deleted' | 'deactivated' | null,
    warning: typeof data?.warning === 'string' ? data.warning : undefined,
    error,
  }
}

export async function resetStudentPassword(schoolId: string) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase.functions.invoke('reset-student-password', { body: { schoolId } })
  return { data, error }
}

import { supabase } from './supabase'
import type { Question, QuizPart, Student, TemporaryCredential } from '../types'

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

  const parts = fallbackParts(input)
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
        answer_key: question.answer?.trim() || null,
        requires_manual_review: question.requiresReview ?? (question.type === 'essay' || question.type === 'upload'),
      }
      const shouldUpdate = isUuid(question.id) && existingQuestionIds.has(question.id)
      const result = shouldUpdate
        ? await supabase.from('LQ_questions').update(questionRow).eq('id', question.id).eq('quiz_id', quizId)
        : await supabase.from('LQ_questions').insert(questionRow)
      if (result.error) return { id: null, error: result.error }
    }
    if (!part.questions.length) {
      const { error } = await supabase.from('LQ_quiz_parts').update({ position: partIndex + 1 }).eq('id', persistedPartId)
      if (error) return { id: null, error }
    }
  }

  return { id: quizId, error: null }
}

export async function assignQuiz(quizId: string, schoolIds: string[], attemptLimit: number) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) return { error: userError ?? new Error('Session expired.') }
  if (!schoolIds.length) return { error: new Error('Select at least one student.') }

  const rows = schoolIds.map((schoolId) => ({
    quiz_id: quizId,
    school_id: schoolId,
    attempt_limit: Math.max(1, Math.floor(attemptLimit)),
    assigned_by: userData.user.id,
    is_active: true,
  }))
  const { error } = await supabase
    .from('LQ_quiz_assignments')
    .upsert(rows, { onConflict: 'quiz_id,school_id' })
  return { error }
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
  const payload = {
    school_id: schoolId,
    last_name: student.lastName.trim(),
    first_names: student.firstNames.trim(),
    is_active: student.active ?? true,
  }
  const query = originalSchoolId
    ? supabase.from('LQ_student_roster').update(payload).eq('school_id', originalSchoolId)
    : supabase.from('LQ_student_roster').insert(payload)
  const { error } = await query
  if (error) return { error }

  if (!originalSchoolId) {
    const provisioned = await provisionStudentAccounts([{ ...student, schoolId }])
    if (provisioned.error) return { error: provisioned.error }
  }
  return { error: null }
}

export async function resetStudentPassword(schoolId: string) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase.functions.invoke('reset-student-password', { body: { schoolId } })
  return { data, error }
}

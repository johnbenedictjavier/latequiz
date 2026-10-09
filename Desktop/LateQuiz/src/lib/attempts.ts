import { supabase } from './supabase'
import type { PartScore, Question } from '../types'

export type AttemptSubmissionResult = {
  auto_score: number
  earned_points: number
  possible_points: number
  manual_review: boolean
  manual_items: number
  expired: boolean
  part_scores: PartScore[]
}

export async function startAttempt(quizId: string, schoolId: string) {
  if (!supabase) return { attemptId: null, expiresAt: null, error: new Error('Supabase is not configured.') }
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) return { attemptId: null, expiresAt: null, error: userError ?? new Error('Session expired') }

  const { data: assignment, error: assignmentError } = await supabase
    .from('LQ_quiz_assignments')
    .select('id, attempt_limit')
    .eq('quiz_id', quizId)
    .eq('school_id', schoolId)
    .eq('is_active', true)
    .maybeSingle()
  if (assignmentError || !assignment) return { attemptId: null, expiresAt: null, error: assignmentError ?? new Error('Quiz is not assigned to this school ID') }

  const { data: quiz, error: quizError } = await supabase
    .from('LQ_quizzes')
    .select('duration_seconds')
    .eq('id', quizId)
    .single()
  if (quizError || !quiz) return { attemptId: null, expiresAt: null, error: quizError ?? new Error('Quiz duration is unavailable') }

  const { data: existing, error: existingError } = await supabase
    .from('LQ_attempts')
    .select('id, attempt_number, status, expires_at')
    .eq('assignment_id', assignment.id)
    .eq('auth_user_id', userData.user.id)
    .order('attempt_number', { ascending: false })
  if (existingError) return { attemptId: null, expiresAt: null, error: existingError }

  const activeAttempt = existing?.find((attempt) => attempt.status === 'in_progress' && new Date(attempt.expires_at).getTime() > Date.now())
  if (activeAttempt) return { attemptId: activeAttempt.id, expiresAt: activeAttempt.expires_at, error: null }

  const nextNumber = (existing?.[0]?.attempt_number ?? 0) + 1
  if (nextNumber > assignment.attempt_limit) return { attemptId: null, expiresAt: null, error: new Error('You have used all attempts for this quiz') }

  const startedAt = new Date()
  const durationSeconds = Number(quiz.duration_seconds ?? 1800)
  const expiresAt = new Date(startedAt.getTime() + durationSeconds * 1000)
  const { data: created, error: createError } = await supabase
    .from('LQ_attempts')
    .insert({
      assignment_id: assignment.id,
      quiz_id: quizId,
      school_id: schoolId,
      auth_user_id: userData.user.id,
      attempt_number: nextNumber,
      started_at: startedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    })
    .select('id')
    .single()

  return { attemptId: created?.id ?? null, expiresAt: expiresAt.toISOString(), error: createError }
}

export async function saveAttemptAnswers(attemptId: string, questions: Question[], answers: Record<string, string>) {
  if (!supabase) return { error: null }
  const records = questions.map((question) => ({
    attempt_id: attemptId,
    question_id: question.id,
    answer_text: question.type === 'upload' ? null : answers[question.id] || null,
    file_path: question.type === 'upload' ? answers[question.id] || null : null,
  }))
  const { error } = await supabase.from('LQ_answers').upsert(records, { onConflict: 'attempt_id,question_id' })
  return { error }
}

export async function submitAttempt(attemptId: string) {
  if (!supabase) return { error: null }
  const { data, error } = await supabase.functions.invoke('submit-attempt', { body: { attempt_id: attemptId } })
  const raw = data as (Omit<AttemptSubmissionResult, 'part_scores'> & {
    earned_points?: number
    possible_points?: number
    part_scores?: Array<{ part_id: string | null; title: string; position: number; earned: number; possible: number; percentage: number; pending_review?: boolean }>
  }) | null
  const normalized = raw ? {
    ...raw,
    part_scores: (raw.part_scores ?? []).map((part) => ({
      partId: part.part_id,
      title: part.title,
      position: part.position,
      earned: part.earned,
      possible: part.possible,
      percentage: part.percentage,
      pendingReview: part.pending_review,
    })),
  } : null
  return { data: normalized as AttemptSubmissionResult | null, error }
}

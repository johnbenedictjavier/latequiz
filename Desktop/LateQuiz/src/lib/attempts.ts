import { supabase } from './supabase'
import type { PartScore, Question } from '../types'

export type AttemptSubmissionResult = {
  auto_score: number
  earned_points: number
  possible_points: number
  manual_review: boolean
  manual_items: number
  expired: boolean
  time_taken_seconds?: number
  remaining_attempts?: number
  part_scores: PartScore[]
}

export async function startAttempt(quizId: string, schoolId: string) {
  if (!supabase) return { attemptId: null, expiresAt: null, error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase.rpc('LQ_start_attempt', { p_quiz_id: quizId })
  if (error || !data) return { attemptId: null, expiresAt: null, error: error ?? new Error('Unable to start the quiz attempt') }
  return {
    attemptId: data.attempt_id as string,
    expiresAt: data.expires_at as string,
    attemptNumber: Number(data.attempt_number),
    remainingAttempts: Number(data.remaining_attempts ?? 0),
    schoolId,
    error: null,
  }
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

export async function submitAttempt(attemptId: string, submissionReason: 'manual' | 'exit' | 'timeout' = 'manual') {
  if (!supabase) return { error: null }
  const { data, error } = await supabase.functions.invoke('submit-attempt', { body: { attempt_id: attemptId, submission_reason: submissionReason } })
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

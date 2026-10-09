import { supabase } from './supabase'
import { compareStudents } from './sorting'
import type { PartScore, QuestionType, Student, Submission, SubmissionAnswer } from '../types'

type AttemptRow = {
  id: string
  quiz_id: string
  school_id: string
  attempt_number: number
  status: 'in_progress' | 'submitted' | 'expired' | 'reviewed' | 'cancelled'
  auto_score: number
  manual_score: number
  final_score: number | null
  started_at: string
  submitted_at: string | null
}

type QuizRow = {
  id: string
  title: string
  subject: string
}

type QuestionRow = {
  id: string
  quiz_id: string
  position: number
  part_id: string | null
  question_type: QuestionType
  prompt: string
  points: number
  requires_manual_review: boolean
}

type AnswerRow = {
  id: string
  attempt_id: string
  question_id: string
  answer_text: string | null
  file_path: string | null
  is_correct: boolean | null
  points_awarded: number
  feedback: string | null
}

type PartRow = {
  attempt_id: string
  part_id: string | null
  part_title: string
  position: number
  points_possible: number
  auto_points: number
  final_points: number | null
}

type RosterRow = {
  school_id: string
  last_name: string
  first_names: string
  is_active: boolean
}

function mapSubmissionStatus(attempt: AttemptRow): Submission['status'] {
  if (attempt.status === 'in_progress') return 'in-progress'
  if (attempt.status === 'reviewed' || attempt.final_score !== null) return 'graded'
  return 'needs-review'
}

function mapPartScore(row: PartRow): PartScore {
  const earned = Number(row.final_points ?? row.auto_points)
  const possible = Number(row.points_possible)
  return {
    partId: row.part_id,
    title: row.part_title,
    position: Number(row.position),
    earned,
    possible,
    percentage: possible ? Math.round((earned / possible) * 10000) / 100 : 0,
    pendingReview: row.final_points === null,
  }
}

function mapAnswer(question: QuestionRow, answer?: AnswerRow): SubmissionAnswer {
  return {
    id: answer?.id,
    questionId: question.id,
    prompt: question.prompt,
    type: question.question_type,
    answer: answer?.answer_text || answer?.file_path || '',
    points: Number(question.points),
    pointsAwarded: Number(answer?.points_awarded ?? 0),
    isCorrect: answer?.is_correct ?? null,
    feedback: answer?.feedback ?? '',
    requiresReview: question.requires_manual_review || question.question_type === 'essay' || question.question_type === 'upload',
  }
}

export async function loadAdminSubmissions() {
  if (!supabase) return [] as Submission[]

  const [
    { data: attemptRows, error: attemptError },
    { data: rosterRows, error: rosterError },
    { data: quizRows, error: quizError },
  ] = await Promise.all([
    supabase
      .from('LQ_attempts')
      .select('id, quiz_id, school_id, attempt_number, status, auto_score, manual_score, final_score, started_at, submitted_at')
      .neq('status', 'cancelled')
      .order('started_at', { ascending: false }),
    supabase.from('LQ_student_roster').select('school_id, last_name, first_names, is_active'),
    supabase.from('LQ_quizzes').select('id, title, subject'),
  ])

  if (attemptError) throw attemptError
  if (rosterError) throw rosterError
  if (quizError) throw quizError

  const attempts = (attemptRows ?? []) as AttemptRow[]
  if (!attempts.length) return [] as Submission[]

  const quizIds = [...new Set(attempts.map((attempt) => attempt.quiz_id))]
  const attemptIds = attempts.map((attempt) => attempt.id)
  const [
    { data: questionRows, error: questionError },
    { data: answerRows, error: answerError },
    { data: partRows, error: partError },
  ] = await Promise.all([
    supabase.from('LQ_questions').select('id, quiz_id, position, part_id, question_type, prompt, points, requires_manual_review').in('quiz_id', quizIds),
    supabase.from('LQ_answers').select('id, attempt_id, question_id, answer_text, file_path, is_correct, points_awarded, feedback').in('attempt_id', attemptIds),
    supabase.from('LQ_attempt_part_scores').select('attempt_id, part_id, part_title, position, points_possible, auto_points, final_points').in('attempt_id', attemptIds).order('position'),
  ])

  if (questionError) throw questionError
  if (answerError) throw answerError
  if (partError) throw partError

  const questionsByQuiz = new Map<string, QuestionRow[]>()
  for (const question of (questionRows ?? []) as QuestionRow[]) {
    const questions = questionsByQuiz.get(question.quiz_id) ?? []
    questions.push(question)
    questionsByQuiz.set(question.quiz_id, questions)
  }
  for (const questions of questionsByQuiz.values()) questions.sort((left, right) => Number(left.position) - Number(right.position))

  const answersByAttempt = new Map<string, Map<string, AnswerRow>>()
  for (const answer of (answerRows ?? []) as AnswerRow[]) {
    const answers = answersByAttempt.get(answer.attempt_id) ?? new Map<string, AnswerRow>()
    answers.set(answer.question_id, answer)
    answersByAttempt.set(answer.attempt_id, answers)
  }

  const partsByAttempt = new Map<string, PartScore[]>()
  for (const row of (partRows ?? []) as PartRow[]) {
    const parts = partsByAttempt.get(row.attempt_id) ?? []
    parts.push(mapPartScore(row))
    partsByAttempt.set(row.attempt_id, parts)
  }

  const rosters = new Map(((rosterRows ?? []) as RosterRow[]).map((student) => [student.school_id, student]))
  const quizzes = new Map(((quizRows ?? []) as QuizRow[]).map((quiz) => [quiz.id, quiz]))

  return attempts.map((attempt) => {
    const quiz = quizzes.get(attempt.quiz_id)
    const roster = rosters.get(attempt.school_id)
    const questions = questionsByQuiz.get(attempt.quiz_id) ?? []
    const answers = answersByAttempt.get(attempt.id) ?? new Map<string, AnswerRow>()
    const mappedAnswers = questions.map((question) => mapAnswer(question, answers.get(question.id)))
    const possiblePoints = mappedAnswers.reduce((sum, answer) => sum + answer.points, 0)
    const earnedPoints = mappedAnswers.reduce((sum, answer) => sum + answer.pointsAwarded, 0)
    const student: Student = {
      schoolId: attempt.school_id,
      lastName: roster?.last_name ?? 'Unknown',
      firstNames: roster?.first_names ?? attempt.school_id,
      active: roster?.is_active,
    }
    return {
      id: attempt.id,
      quizId: attempt.quiz_id,
      student,
      quizTitle: quiz?.title ?? 'LateQuiz assessment',
      quizSubject: quiz?.subject ?? 'Recovery assessment',
      attemptNumber: Number(attempt.attempt_number),
      startedAt: attempt.started_at,
      submittedAt: attempt.submitted_at,
      autoScore: Number(attempt.auto_score ?? 0),
      manualScore: Number(attempt.manual_score ?? 0),
      score: attempt.final_score === null ? null : Number(attempt.final_score),
      status: mapSubmissionStatus(attempt),
      manualItems: mappedAnswers.filter((answer) => answer.requiresReview).length,
      totalItems: mappedAnswers.length,
      earnedPoints,
      possiblePoints,
      answers: mappedAnswers,
      parts: partsByAttempt.get(attempt.id) ?? [],
    } satisfies Submission
  }).sort((left, right) => compareStudents(left.student, right.student) || new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())
}

export async function reviewSubmission(submissionId: string, answers: SubmissionAnswer[]) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const { error } = await supabase.rpc('LQ_review_attempt', {
    p_attempt_id: submissionId,
    p_answers: answers.map((answer) => ({
      question_id: answer.questionId,
      points_awarded: answer.pointsAwarded,
      is_correct: answer.isCorrect,
      feedback: answer.feedback,
    })),
  })
  return { error }
}

export async function deleteSubmission(submissionId: string) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const { error } = await supabase.rpc('LQ_delete_attempt', { p_attempt_id: submissionId })
  return { error }
}

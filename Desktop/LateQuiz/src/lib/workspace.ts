import { supabase } from './supabase'
import type { Notification, PartScore, Question, Quiz, QuizPart, ScoreRecord, Student, Subject } from '../types'

type QuizRow = {
  id: string
  title: string
  subject: string
  description: string
  duration_seconds: number
  passing_score: number
  status: 'draft' | 'published' | 'archived'
}

type QuestionRow = {
  id: string
  quiz_id: string
  position: number
  part_id: string | null
  part_position: number | null
  question_type: Question['type']
  prompt: string
  points: number
  options: string[] | null
  answer_key?: string | null
  requires_manual_review: boolean
}

type PartRow = {
  id: string
  quiz_id: string
  position: number
  title: string
}

type AttemptPartScoreRow = {
  attempt_id: string
  part_id: string | null
  part_title: string
  position: number
  points_possible: number
  auto_points: number
  final_points: number | null
}

type NotificationRow = {
  id: string
  type: string
  title: string
  message: string
  read_at: string | null
  created_at: string
  metadata: Record<string, string> | null
}

function mapQuestion(row: QuestionRow): Question {
  return {
    id: row.id,
    type: row.question_type,
    prompt: row.prompt,
    points: Number(row.points),
    options: row.options ?? undefined,
    answer: undefined,
    requiresReview: row.requires_manual_review,
    partId: row.part_id ?? undefined,
    partPosition: row.part_position ?? undefined,
  }
}

function mapAdminQuestion(row: QuestionRow): Question {
  return {
    ...mapQuestion(row),
    answer: row.answer_key ?? undefined,
  }
}

function mapParts(partRows: PartRow[], questions: Question[], quizId: string): QuizPart[] {
  const parts: QuizPart[] = partRows
    .filter((part) => part.quiz_id === quizId)
    .sort((a, b) => a.position - b.position)
    .map((part) => ({ id: part.id, title: part.title, position: part.position, questions: [] }))
  const partsById = new Map(parts.map((part) => [part.id, part]))

  for (const question of questions) {
    let part = question.partId ? partsById.get(question.partId) : undefined
    if (!part) {
      part = parts.find((candidate) => candidate.title === 'General')
      if (!part) {
        part = { id: `general-${quizId}`, title: 'General', position: parts.length + 1, questions: [] }
        parts.push(part)
      }
    }
    part.questions.push(question)
  }

  return parts.map((part, index) => ({
    ...part,
    position: index + 1,
    questions: part.questions.sort((a, b) => (a.partPosition ?? 0) - (b.partPosition ?? 0)),
  }))
}

function mapPartScore(row: AttemptPartScoreRow): PartScore {
  const earned = Number(row.final_points ?? row.auto_points)
  const possible = Number(row.points_possible)
  return {
    partId: row.part_id,
    title: row.part_title,
    position: row.position,
    earned,
    possible,
    percentage: possible ? Math.round((earned / possible) * 10000) / 100 : 0,
    pendingReview: row.final_points === null,
  }
}

function mapAdminQuizStatus(status: QuizRow['status']): Quiz['status'] {
  if (status === 'published') return 'ready'
  if (status === 'archived') return 'archived'
  return 'draft'
}

export async function loadStudentWorkspace(schoolId: string) {
  if (!supabase) return { quizzes: [], scores: [] as ScoreRecord[] }

  const [{ data: quizRows, error: quizError }, { data: assignments, error: assignmentError }] = await Promise.all([
    supabase.from('LQ_quizzes').select('id, title, subject, description, duration_seconds, passing_score, status').eq('status', 'published').order('created_at', { ascending: false }),
    supabase.from('LQ_quiz_assignments').select('quiz_id, attempt_limit').eq('school_id', schoolId).eq('is_active', true),
  ])

  if (quizError) throw quizError
  if (assignmentError) throw assignmentError

  const quizzes = (quizRows ?? []) as QuizRow[]
  const quizIds = quizzes.map((quiz) => quiz.id)
  const assignedIds = new Set((assignments ?? []).map((assignment) => assignment.quiz_id))
  const [{ data: questionRows, error: questionError }, { data: partRows, error: partError }, { data: attemptRows, error: attemptError }] = await Promise.all([
    quizIds.length ? supabase.from('LQ_questions').select('id, quiz_id, position, part_id, part_position, question_type, prompt, points, options, requires_manual_review').in('quiz_id', quizIds).order('position') : Promise.resolve({ data: [], error: null }),
    quizIds.length ? supabase.from('LQ_quiz_parts').select('id, quiz_id, position, title').in('quiz_id', quizIds).order('position') : Promise.resolve({ data: [], error: null }),
    supabase.from('LQ_attempts').select('id, quiz_id, attempt_number, status, auto_score, manual_score, final_score, started_at, expires_at').eq('school_id', schoolId).order('started_at', { ascending: false }),
  ])

  if (questionError) throw questionError
  if (partError) throw partError
  if (attemptError) throw attemptError

  const attempts = attemptRows ?? []
  const attemptIds = attempts.map((attempt) => attempt.id)
  const { data: answerRows, error: answerError } = attemptIds.length
    ? await supabase.from('LQ_answers').select('attempt_id, question_id, answer_text, file_path').in('attempt_id', attemptIds)
    : { data: [], error: null }
  if (answerError) throw answerError
  const { data: partScoreRows, error: partScoreError } = attemptIds.length
    ? await supabase.from('LQ_attempt_part_scores').select('attempt_id, part_id, part_title, position, points_possible, auto_points, final_points').in('attempt_id', attemptIds).order('position')
    : { data: [], error: null }
  if (partScoreError) throw partScoreError

  const questionsByQuiz = new Map<string, Question[]>()
  for (const row of (questionRows ?? []) as QuestionRow[]) {
    const current = questionsByQuiz.get(row.quiz_id) ?? []
    current.push(mapQuestion(row))
    questionsByQuiz.set(row.quiz_id, current)
  }

  const partsByQuiz = new Map<string, QuizPart[]>()
  for (const quiz of quizzes) {
    partsByQuiz.set(quiz.id, mapParts((partRows ?? []) as PartRow[], questionsByQuiz.get(quiz.id) ?? [], quiz.id))
  }

  const partScoresByAttempt = new Map<string, PartScore[]>()
  for (const row of (partScoreRows ?? []) as AttemptPartScoreRow[]) {
    const current = partScoresByAttempt.get(row.attempt_id) ?? []
    current.push(mapPartScore(row))
    partScoresByAttempt.set(row.attempt_id, current)
  }

  const attemptsByQuiz = new Map<string, typeof attempts[number]>()
  for (const attempt of attempts) {
    if (!attemptsByQuiz.has(attempt.quiz_id)) attemptsByQuiz.set(attempt.quiz_id, attempt)
  }

  const answersByAttempt = new Map<string, number>()
  const answerTextByAttempt = new Map<string, Map<string, string>>()
  for (const answer of answerRows ?? []) {
    const value = answer.answer_text || answer.file_path
    if (value) {
      answersByAttempt.set(answer.attempt_id, (answersByAttempt.get(answer.attempt_id) ?? 0) + 1)
      const current = answerTextByAttempt.get(answer.attempt_id) ?? new Map<string, string>()
      current.set(answer.question_id, value)
      answerTextByAttempt.set(answer.attempt_id, current)
    }
  }

  const mappedQuizzes: Quiz[] = quizzes.map((row) => {
    const questions = questionsByQuiz.get(row.id) ?? []
    const parts = partsByQuiz.get(row.id) ?? []
    const attempt = attemptsByQuiz.get(row.id)
    const isAssigned = assignedIds.has(row.id)
    const isSubmitted = attempt?.status === 'submitted' || attempt?.status === 'reviewed' || attempt?.status === 'expired'
    const hasFinalScore = attempt?.final_score !== null && attempt?.final_score !== undefined
    const score = attempt ? Number(attempt.final_score ?? attempt.auto_score ?? 0) : undefined
    return {
      id: row.id,
      title: row.title,
      subject: row.subject,
      description: row.description,
      questions: questions.length,
      points: questions.reduce((sum, question) => sum + question.points, 0),
      durationMinutes: Math.round(row.duration_seconds / 60),
      dueLabel: isAssigned ? 'Assigned to your school ID' : 'Not assigned to you',
      status: !isAssigned ? 'locked' : !attempt ? 'ready' : isSubmitted ? (hasFinalScore ? 'completed' : 'in-review') : 'ready',
      progress: attempt ? Math.round(((answersByAttempt.get(attempt.id) ?? 0) / Math.max(questions.length, 1)) * 100) : 0,
      score,
      passingScore: Number(row.passing_score),
      questionsList: questions.map((question) => ({
        ...question,
        response: attempt ? answerTextByAttempt.get(attempt.id)?.get(question.id) : undefined,
      })),
      parts,
      answeredCount: attempt ? answersByAttempt.get(attempt.id) ?? 0 : 0,
      attemptLimit: Number((assignments ?? []).find((assignment) => assignment.quiz_id === row.id)?.attempt_limit ?? 1),
      expiresAt: attempt?.status === 'in_progress' ? attempt.expires_at : undefined,
    }
  })

  const scores: ScoreRecord[] = attempts
    .filter((attempt) => attempt.status !== 'in_progress' && attempt.final_score !== null && attempt.final_score !== undefined)
    .map((attempt) => {
      const quiz = quizzes.find((item) => item.id === attempt.quiz_id)
      const score = Number(attempt.final_score ?? attempt.auto_score ?? 0)
      const parts = partScoresByAttempt.get(attempt.id) ?? []
      const possiblePoints = parts.reduce((sum, part) => sum + part.possible, 0)
      const earnedPoints = parts.reduce((sum, part) => sum + part.earned, 0)
      return {
        id: attempt.id,
        title: quiz?.title ?? 'LateQuiz assessment',
        subject: quiz?.subject ?? 'Recovery assessment',
        date: new Date(attempt.started_at).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }),
        score,
        total: 100,
        earnedPoints: possiblePoints ? earnedPoints : undefined,
        possiblePoints: possiblePoints || undefined,
        parts,
        status: attempt.final_score === null || attempt.final_score === undefined ? 'reviewing' : score >= Number(quiz?.passing_score ?? 75) ? 'passed' : 'needs-retake',
        reviewed: attempt.status === 'reviewed',
      }
    })

  return { quizzes: mappedQuizzes, scores }
}

export async function loadAdminQuizzes() {
  if (!supabase) return []

  const [{ data: quizRows, error: quizError }, { data: questionRows, error: questionError }, { data: partRows, error: partError }, { data: assignmentRows, error: assignmentError }] = await Promise.all([
    supabase.from('LQ_quizzes').select('id, title, subject, description, duration_seconds, passing_score, status').order('created_at', { ascending: false }),
    supabase.from('LQ_questions').select('id, quiz_id, position, part_id, part_position, question_type, prompt, points, options, answer_key, requires_manual_review').order('position'),
    supabase.from('LQ_quiz_parts').select('id, quiz_id, position, title').order('position'),
    supabase.from('LQ_quiz_assignments').select('quiz_id, is_active'),
  ])

  if (quizError) throw quizError
  if (questionError) throw questionError
  if (partError) throw partError
  if (assignmentError) throw assignmentError

  const questionsByQuiz = new Map<string, Question[]>()
  for (const row of (questionRows ?? []) as QuestionRow[]) {
    const current = questionsByQuiz.get(row.quiz_id) ?? []
    current.push(mapAdminQuestion(row))
    questionsByQuiz.set(row.quiz_id, current)
  }

  const assignmentCounts = new Map<string, number>()
  for (const row of assignmentRows ?? []) {
    if (row.is_active !== false) assignmentCounts.set(row.quiz_id, (assignmentCounts.get(row.quiz_id) ?? 0) + 1)
  }

  return ((quizRows ?? []) as QuizRow[]).map((row) => {
    const questions = questionsByQuiz.get(row.id) ?? []
    const parts = mapParts((partRows ?? []) as PartRow[], questions, row.id)
    return {
      id: row.id,
      title: row.title,
      subject: row.subject,
      description: row.description,
      questions: questions.length,
      points: questions.reduce((sum, question) => sum + question.points, 0),
      durationMinutes: Math.round(row.duration_seconds / 60),
      dueLabel: row.status === 'published' ? 'Published' : row.status === 'draft' ? 'Draft' : 'Archived',
      status: mapAdminQuizStatus(row.status),
      passingScore: Number(row.passing_score),
      questionsList: questions,
      parts,
      assignedCount: assignmentCounts.get(row.id) ?? 0,
    } satisfies Quiz
  })
}

export async function loadRoster() {
  if (!supabase) return null
  const { data, error } = await supabase.from('LQ_student_roster').select('school_id, last_name, first_names, is_active, auth_user_id, must_change_password').eq('is_active', true).order('school_id')
  if (error) throw error
  return (data ?? []).map((student) => ({
    schoolId: student.school_id,
    lastName: student.last_name,
    firstNames: student.first_names,
    active: student.is_active,
    accountReady: Boolean(student.auth_user_id),
    mustChangePassword: student.must_change_password,
  })) as Student[]
}

export async function loadAdminRoster() {
  if (!supabase) return [] as Student[]
  const [{ data, error }, { data: assignments, error: assignmentError }] = await Promise.all([
    supabase.from('LQ_student_roster').select('school_id, last_name, first_names, is_active, auth_user_id, must_change_password').order('school_id'),
    supabase.from('LQ_quiz_assignments').select('school_id, is_active'),
  ])
  if (error) throw error
  if (assignmentError) throw assignmentError
  const assignmentCounts = new Map<string, number>()
  for (const assignment of assignments ?? []) {
    if (assignment.is_active !== false) assignmentCounts.set(assignment.school_id, (assignmentCounts.get(assignment.school_id) ?? 0) + 1)
  }
  return (data ?? []).map((student) => ({
    schoolId: student.school_id,
    lastName: student.last_name,
    firstNames: student.first_names,
    active: student.is_active,
    accountReady: Boolean(student.auth_user_id),
    mustChangePassword: student.must_change_password,
    assignmentCount: assignmentCounts.get(student.school_id) ?? 0,
  })) as Student[]
}

export async function loadSubjects() {
  if (!supabase) return [] as Subject[]
  const { data, error } = await supabase.from('LQ_subjects').select('id, name, is_active').eq('is_active', true).order('name')
  if (error) throw error
  return (data ?? []).map((subject) => ({ id: subject.id, name: subject.name, isActive: subject.is_active })) as Subject[]
}

export async function createSubject(name: string) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const { error } = await supabase.from('LQ_subjects').insert({ name: name.trim(), is_active: true })
  return { error }
}

export async function loadAdminNotifications() {
  if (!supabase) return [] as Notification[]
  const { data, error } = await supabase
    .from('LQ_notifications')
    .select('id, type, title, message, read_at, created_at, metadata')
    .eq('recipient_role', 'admin')
    .order('created_at', { ascending: false })
    .limit(30)
  if (error) throw error
  return ((data ?? []) as NotificationRow[]).map((notification) => ({
    id: notification.id,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    readAt: notification.read_at,
    createdAt: notification.created_at,
    metadata: notification.metadata ?? undefined,
  }))
}

export async function markNotificationRead(id: string) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const { error } = await supabase.from('LQ_notifications').update({ read_at: new Date().toISOString() }).eq('id', id)
  return { error }
}

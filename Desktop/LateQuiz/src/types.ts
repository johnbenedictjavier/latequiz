export type Role = 'student' | 'admin'

export type StudentView =
  | 'dashboard'
  | 'quizzes'
  | 'quiz'
  | 'scores'
  | 'account'

export type AdminView =
  | 'overview'
  | 'quizzes'
  | 'builder'
  | 'submissions'
  | 'students'

export type QuestionType = 'multiple-choice' | 'identification' | 'essay' | 'upload'
export type QuizStatus = 'ready' | 'locked' | 'completed' | 'in-review' | 'draft' | 'archived'

export interface Student {
  schoolId: string
  lastName: string
  firstNames: string
  avatar?: string
  avatarPath?: string
  active?: boolean
  accountReady?: boolean
  mustChangePassword?: boolean
  assignmentCount?: number
}

export interface Subject {
  id: string
  name: string
  isActive?: boolean
}

export interface Notification {
  id: string
  type: string
  title: string
  message: string
  readAt?: string | null
  createdAt: string
  metadata?: Record<string, string>
}

export interface Question {
  id: string
  type: QuestionType
  prompt: string
  points: number
  options?: string[]
  answer?: string
  response?: string
  requiresReview?: boolean
  partId?: string
  partPosition?: number
}

export interface QuizPart {
  id: string
  title: string
  position: number
  questions: Question[]
}

export interface PartScore {
  partId: string | null
  title: string
  position: number
  earned: number
  possible: number
  percentage: number
  pendingReview?: boolean
}

export interface Quiz {
  id: string
  title: string
  subject: string
  description: string
  questions: number
  points: number
  durationMinutes: number
  dueLabel: string
  status: QuizStatus
  progress?: number
  score?: number
  passingScore: number
  questionsList?: Question[]
  parts?: QuizPart[]
  earnedPoints?: number
  possiblePoints?: number
  assignedCount?: number
  answeredCount?: number
  attemptLimit?: number
  expiresAt?: string
}

export interface ScoreRecord {
  id: string
  title: string
  subject: string
  date: string
  score: number
  total: number
  earnedPoints?: number
  possiblePoints?: number
  parts?: PartScore[]
  status: 'passed' | 'reviewing' | 'needs-retake'
  reviewed?: boolean
}

export type SubmissionStatus = 'needs-review' | 'graded' | 'in-progress'

export interface SubmissionAnswer {
  id?: string
  questionId: string
  prompt: string
  type: QuestionType
  answer: string
  points: number
  pointsAwarded: number
  isCorrect: boolean | null
  requiresReview: boolean
}

export interface SubmissionPartColumn {
  partId: string | null
  title: string
  position: number
  possiblePoints: number
}

export interface Submission {
  id: string
  quizId: string
  student: Student
  quizTitle: string
  quizSubject: string
  attemptNumber: number
  startedAt: string
  submittedAt: string | null
  autoScore: number
  manualScore: number
  score: number | null
  status: SubmissionStatus
  manualItems: number
  totalItems: number
  earnedPoints: number
  possiblePoints: number
  answers: SubmissionAnswer[]
  partColumns: SubmissionPartColumn[]
  parts?: PartScore[]
}

export interface ToastMessage {
  title: string
  message?: string
  tone?: 'success' | 'info' | 'warning'
}

export interface TemporaryCredential {
  schoolId: string
  name: string
  password: string
}

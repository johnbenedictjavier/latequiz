export type Role = 'student' | 'admin'

export type StudentView =
  | 'dashboard'
  | 'quizzes'
  | 'reporters'
  | 'quiz'
  | 'scores'
  | 'account'
  | 'reupload'

export type AdminView =
  | 'overview'
  | 'quizzes'
  | 'builder'
  | 'submissions'
  | 'students'

export type QuestionType = 'multiple-choice' | 'identification' | 'essay' | 'upload'
export type QuizStatus = 'ready' | 'locked' | 'completed' | 'in-review' | 'reported' | 'draft' | 'archived'

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

export interface QuizReporter {
  schoolId: string
  firstNames: string
  lastName: string
  avatar?: string
  avatarPath?: string
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
  /** Identification answer keys in admin order (admin loaders only). */
  answers?: string[]
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
  attemptsRemaining?: number
  expiresAt?: string
  startedAt?: string
  submittedAt?: string
  timeTakenSeconds?: number
  isAssigned?: boolean
  isReporter?: boolean
  canAnswer?: boolean
  reporters?: QuizReporter[]
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
  timeTakenSeconds?: number
}

export type SubmissionStatus = 'needs-review' | 'graded' | 'in-progress'

/** Raw `LQ_attempts.status` value. */
export type AttemptStatus = 'in_progress' | 'submitted' | 'expired' | 'reviewed' | 'cancelled'

export interface SubmissionAnswer {
  id?: string
  questionId: string
  prompt: string
  type: QuestionType
  answer: string
  /** Configured answer keys in admin order; empty when none are stored. */
  correctAnswers: string[]
  /** Raw `LQ_answers.file_path` (object path or legacy bare file name). */
  filePath?: string | null
  points: number
  pointsAwarded: number
  isCorrect: boolean | null
  requiresReview: boolean
  /** `LQ_answers.id` for the answer row; the key the re-upload RPCs act on. */
  answerId?: string
  /** Latest re-upload request for this answer, or null when none exists. */
  reupload?: SubmissionReupload | null
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
  timeTakenSeconds: number | null
  submissionReason?: 'manual' | 'exit' | 'timeout' | 'admin'
  /** Raw `LQ_attempts.status`, used for re-upload eligibility in the drawer. */
  attemptStatus: AttemptStatus
  /** True when any answer has a fulfilled re-upload image not yet reviewed (2.26). */
  hasImageAwaitingReview: boolean
  answers: SubmissionAnswer[]
  partColumns: SubmissionPartColumn[]
  parts?: PartScore[]
}

/** Stored `LQ_reupload_requests.status`. */
export type ReuploadRequestStatus = 'open' | 'fulfilled' | 'cancelled'
/** Stored status with an open request past its deadline reported as `expired`. */
export type ReuploadEffectiveStatus = ReuploadRequestStatus | 'expired'

/** A student's open re-upload request (from `LQ_my_reupload_requests`). */
export interface ReuploadRequest {
  id: string
  attemptId: string
  quizId: string
  quizTitle: string
  questionId: string
  questionNumber: number
  prompt: string
  originalFileName: string
  deadline: string | null
  requestedAt: string
}

/** A full `LQ_reupload_requests` row (admin reads). */
export interface ReuploadRequestRecord {
  id: string
  attemptId: string
  questionId: string
  answerId: string
  originalFileName: string
  requestedAt: string
  deadline: string | null
  status: ReuploadRequestStatus
  fulfilledAt: string | null
  fulfilledPath: string | null
  cancelledAt: string | null
  cancelReason: 'admin' | 'expired' | null
}

/** Latest re-upload request for a submission answer, as shown in the review drawer. */
export interface SubmissionReupload {
  id: string
  status: ReuploadEffectiveStatus
  deadline: string | null
  requestedAt: string
  fulfilledAt: string | null
  originalFileName: string
  awaitingReview: boolean
}

export interface SubmissionAssignment {
  quizId: string
  schoolId: string
  attemptLimit: number
}

export type SubmissionDashboardCategory = 'assigned' | 'started' | 'answered' | 'not-answered' | 'needs-review'

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

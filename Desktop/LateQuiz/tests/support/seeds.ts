import { stub } from './stubSupabase'

export const SCHOOL_ID = 'S-1001'
export const QUIZ_ID = '33333333-3333-4333-8333-333333333333'
export const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111'
export const QUESTION_ID = '22222222-2222-4222-8222-222222222222'
export const ANSWER_ID = '44444444-4444-4444-8444-444444444444'
export const REQUEST_ID = '55555555-5555-4555-8555-555555555555'

/**
 * Seeds the stubbed client with one closed attempt for SCHOOL_ID whose only
 * question is an upload question (question 4 of "Data Representation") and
 * whose stored answer holds the legacy bare name `diagram.png`.
 */
export function seedLegacySubmission(options: { attemptStatus: string; reuploadRequests?: Record<string, unknown>[] }) {
  stub.onTable('LQ_attempts', () => ({
    data: [{
      id: ATTEMPT_ID,
      quiz_id: QUIZ_ID,
      school_id: SCHOOL_ID,
      attempt_number: 1,
      status: options.attemptStatus,
      auto_score: 0,
      manual_score: 0,
      final_score: null,
      started_at: '2026-10-01T08:00:00.000Z',
      submitted_at: '2026-10-01T08:20:00.000Z',
      time_taken_seconds: 1200,
      submission_reason: 'manual',
    }],
    error: null,
  }))
  stub.onTable('LQ_student_roster', () => ({ data: [{ school_id: SCHOOL_ID, last_name: 'Doe', first_names: 'Alex', is_active: true }], error: null }))
  stub.onTable('LQ_quizzes', () => ({ data: [{ id: QUIZ_ID, title: 'Data Representation', subject: 'Computer Science' }], error: null }))
  stub.onTable('LQ_questions', () => ({
    data: [{ id: QUESTION_ID, quiz_id: QUIZ_ID, position: 4, part_id: null, question_type: 'upload', prompt: 'Upload your diagram.', points: 5, requires_manual_review: true }],
    error: null,
  }))
  stub.onTable('LQ_answers', () => ({
    data: [{ id: ANSWER_ID, attempt_id: ATTEMPT_ID, question_id: QUESTION_ID, answer_text: null, file_path: 'diagram.png', is_correct: null, points_awarded: 0, reviewed_at: null }],
    error: null,
  }))
  stub.onTable('LQ_reupload_requests', () => ({ data: options.reuploadRequests ?? [], error: null }))
}

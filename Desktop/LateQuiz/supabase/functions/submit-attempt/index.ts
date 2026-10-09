import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function normalize(value: string | null | undefined) {
  return (value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const authorization = request.headers.get('Authorization')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!authorization || !supabaseUrl || !anonKey || !serviceRoleKey) return response({ error: 'Unauthorized' }, 401)

  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } })
  const { data: userData } = await userClient.auth.getUser()
  if (!userData.user) return response({ error: 'Invalid session' }, 401)

  let body: { attempt_id?: string }
  try {
    body = await request.json()
  } catch {
    return response({ error: 'Invalid request body' }, 400)
  }
  if (!body.attempt_id) return response({ error: 'Attempt ID required' }, 400)

  const serviceClient = createClient(supabaseUrl, serviceRoleKey)
  const { data: attempt, error: attemptError } = await serviceClient
    .from('LQ_attempts')
    .select('id, assignment_id, quiz_id, school_id, auth_user_id, expires_at, status')
    .eq('id', body.attempt_id)
    .maybeSingle()
  if (attemptError || !attempt) return response({ error: 'Attempt not found' }, 404)
  if (attempt.auth_user_id !== userData.user.id) return response({ error: 'This attempt does not belong to you' }, 403)
  if (attempt.status !== 'in_progress') return response({ error: 'Attempt has already been submitted' }, 409)

  const [{ data: assignment, error: assignmentError }, { data: quiz, error: quizError }] = await Promise.all([
    serviceClient.from('LQ_quiz_assignments').select('id, is_active, quiz_id, school_id').eq('id', attempt.assignment_id).maybeSingle(),
    serviceClient.from('LQ_quizzes').select('id, status').eq('id', attempt.quiz_id).maybeSingle(),
  ])
  if (assignmentError || quizError) return response({ error: 'Could not validate the quiz assignment' }, 500)
  if (!assignment || assignment.is_active !== true || assignment.quiz_id !== attempt.quiz_id || assignment.school_id !== attempt.school_id || !quiz || quiz.status !== 'published') {
    return response({ error: 'This quiz assignment is no longer active' }, 409)
  }

  const expired = new Date(attempt.expires_at).getTime() <= Date.now()
  const [{ data: questions, error: questionsError }, { data: answers, error: answersError }, { data: parts, error: partsError }] = await Promise.all([
    serviceClient.from('LQ_questions').select('id, part_id, question_type, points, answer_key, requires_manual_review').eq('quiz_id', attempt.quiz_id),
    serviceClient.from('LQ_answers').select('id, question_id, answer_text, file_path').eq('attempt_id', attempt.id),
    serviceClient.from('LQ_quiz_parts').select('id, title, position').eq('quiz_id', attempt.quiz_id).order('position'),
  ])
  if (questionsError || answersError || partsError) return response({ error: 'Could not load answers for grading' }, 500)

  let awarded = 0
  let total = 0
  let manualReview = false
  let manualItems = 0
  const answerByQuestion = new Map((answers ?? []).map((answer) => [answer.question_id, answer]))
  const partById = new Map((parts ?? []).map((part) => [part.id, part]))
  const partStats = new Map<string, { partId: string | null; title: string; position: number; possible: number; awarded: number; pending: boolean }>()

  const getPartStats = (partId: string | null) => {
    const key = partId ?? 'general'
    const existing = partStats.get(key)
    if (existing) return existing
    const part = partId ? partById.get(partId) : null
    const created = {
      partId,
      title: part?.title ?? 'General',
      position: part?.position ?? (parts?.length ?? 0) + 1,
      possible: 0,
      awarded: 0,
      pending: false,
    }
    partStats.set(key, created)
    return created
  }

  for (const question of questions ?? []) {
    const points = Number(question.points)
    total += points
    const stats = getPartStats(question.part_id)
    stats.possible += points
    const answer = answerByQuestion.get(question.id)
    const hasResponse = Boolean(answer?.answer_text || answer?.file_path)
    if (question.requires_manual_review || question.question_type === 'essay' || question.question_type === 'upload') {
      manualReview = true
      manualItems += 1
      stats.pending = true
      continue
    }

    const correct = hasResponse && normalize(answer?.answer_text) === normalize(question.answer_key)
    if (correct) {
      awarded += points
      stats.awarded += points
    }
    if (answer) {
      await serviceClient.from('LQ_answers').update({ is_correct: correct, points_awarded: correct ? points : 0 }).eq('id', answer.id)
    }
  }

  const autoScore = total ? Math.round((awarded / total) * 10000) / 100 : 0
  const partScores = [...partStats.values()]
    .sort((a, b) => a.position - b.position)
    .map((part) => ({
      attempt_id: attempt.id,
      part_id: part.partId,
      part_title: part.title,
      position: part.position,
      points_possible: part.possible,
      auto_points: part.awarded,
      final_points: part.pending ? null : part.awarded,
    }))
  if (partScores.length) {
    const { error: partScoreError } = await serviceClient
      .from('LQ_attempt_part_scores')
      .upsert(partScores, { onConflict: 'attempt_id,position' })
    if (partScoreError) return response({ error: partScoreError.message }, 500)
  }
  const { error: updateError } = await serviceClient
    .from('LQ_attempts')
    .update({
      status: expired ? 'expired' : 'submitted',
      submitted_at: new Date().toISOString(),
      auto_score: autoScore,
      final_score: manualReview ? null : autoScore,
    })
    .eq('id', attempt.id)
  if (updateError) return response({ error: updateError.message }, 500)

  return response({
    auto_score: autoScore,
    earned_points: awarded,
    possible_points: total,
    manual_review: manualReview,
    manual_items: manualItems,
    expired,
    part_scores: partScores.map((part) => ({
      part_id: part.part_id,
      title: part.part_title,
      position: part.position,
      earned: part.final_points ?? part.auto_points,
      possible: part.points_possible,
      percentage: part.points_possible ? Math.round(((part.final_points ?? part.auto_points) / part.points_possible) * 10000) / 100 : 0,
      pending_review: part.final_points === null,
    })),
  })
})

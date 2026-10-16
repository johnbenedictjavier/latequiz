import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
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

async function finalizeAttempt(serviceClient: ReturnType<typeof createClient>, attempt: {
  id: string
  quiz_id: string
  school_id: string
  started_at: string
  expires_at: string
}) {
  const [{ data: questions, error: questionsError }, { data: answers, error: answersError }, { data: parts, error: partsError }, { data: quiz, error: quizError }, { data: student, error: studentError }] = await Promise.all([
    serviceClient.from('LQ_questions').select('id, part_id, question_type, points, requires_manual_review').eq('quiz_id', attempt.quiz_id),
    serviceClient.from('LQ_answers').select('id, question_id, answer_text, file_path').eq('attempt_id', attempt.id),
    serviceClient.from('LQ_quiz_parts').select('id, title, position').eq('quiz_id', attempt.quiz_id).order('position'),
    serviceClient.from('LQ_quizzes').select('id, title').eq('id', attempt.quiz_id).maybeSingle(),
    serviceClient.from('LQ_student_roster').select('first_names, last_name').eq('school_id', attempt.school_id).maybeSingle(),
  ])
  if (questionsError || answersError || partsError || quizError || studentError) throw questionsError ?? answersError ?? partsError ?? quizError ?? studentError

  const questionIds = (questions ?? []).map((question) => question.id)
  const { data: keyRows, error: keyError } = questionIds.length
    ? await serviceClient.from('LQ_question_keys').select('question_id, answer_key').in('question_id', questionIds)
    : { data: [], error: null }
  if (keyError) throw keyError

  let awarded = 0
  let total = 0
  let manualReview = false
  let manualItems = 0
  const answerByQuestion = new Map((answers ?? []).map((answer) => [answer.question_id, answer]))
  const keyByQuestion = new Map((keyRows ?? []).map((key) => [key.question_id, key.answer_key]))
  const partById = new Map((parts ?? []).map((part) => [part.id, part]))
  const partStats = new Map<string, { partId: string | null; title: string; position: number; possible: number; awarded: number; pending: boolean }>()

  const getPartStats = (partId: string | null) => {
    const key = partId ?? 'general'
    const existing = partStats.get(key)
    if (existing) return existing
    const part = partId ? partById.get(partId) : null
    const created = { partId, title: part?.title ?? 'General', position: part?.position ?? (parts?.length ?? 0) + 1, possible: 0, awarded: 0, pending: false }
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

    const correct = hasResponse && normalize(answer?.answer_text) === normalize(keyByQuestion.get(question.id))
    if (correct) {
      awarded += points
      stats.awarded += points
    }
    if (answer) {
      await serviceClient.from('LQ_answers').update({ is_correct: correct, points_awarded: correct ? points : 0 }).eq('id', answer.id)
    }
  }

  const autoScore = total ? Math.round((awarded / total) * 10000) / 100 : 0
  const partScores = [...partStats.values()].sort((left, right) => left.position - right.position).map((part) => ({
    attempt_id: attempt.id,
    part_id: part.partId,
    part_title: part.title,
    position: part.position,
    points_possible: part.possible,
    auto_points: part.awarded,
    final_points: part.pending ? null : part.awarded,
  }))
  if (partScores.length) {
    const { error } = await serviceClient.from('LQ_attempt_part_scores').upsert(partScores, { onConflict: 'attempt_id,position' })
    if (error) throw error
  }

  const timeTakenSeconds = Math.max(0, Math.round((new Date(attempt.expires_at).getTime() - new Date(attempt.started_at).getTime()) / 1000))
  const { error: updateError } = await serviceClient
    .from('LQ_attempts')
    .update({
      status: 'expired',
      submitted_at: new Date(attempt.expires_at).toISOString(),
      time_taken_seconds: timeTakenSeconds,
      submission_reason: 'timeout',
      auto_score: autoScore,
      final_score: manualReview ? null : autoScore,
    })
    .eq('id', attempt.id)
    .eq('status', 'in_progress')
  if (updateError) throw updateError

  const studentName = [student?.first_names, student?.last_name].filter(Boolean).join(' ') || attempt.school_id
  const quizTitle = quiz?.title ?? attempt.quiz_id
  await serviceClient.from('LQ_notifications').insert({
    recipient_role: 'admin',
    type: 'submission_received',
    title: 'Quiz submitted automatically',
    message: `${studentName}'s attempt for ${quizTitle} reached its time limit.`,
    metadata: { attempt_id: attempt.id, quiz_id: attempt.quiz_id, school_id: attempt.school_id, student_name: studentName, quiz_title: quizTitle, submission_reason: 'timeout' },
  })
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const cronSecret = Deno.env.get('LATEQUIZ_CRON_SECRET')
  if (!supabaseUrl || !serviceRoleKey) return response({ error: 'Function environment is incomplete' }, 500)

  const suppliedSecret = request.headers.get('x-cron-secret')
  const authorization = request.headers.get('Authorization')
  if (cronSecret ? suppliedSecret !== cronSecret : authorization !== `Bearer ${serviceRoleKey}`) {
    return response({ error: 'Unauthorized' }, 401)
  }

  const serviceClient = createClient(supabaseUrl, serviceRoleKey)
  const { data: attempts, error } = await serviceClient
    .from('LQ_attempts')
    .select('id, quiz_id, school_id, started_at, expires_at')
    .eq('status', 'in_progress')
    .lte('expires_at', new Date().toISOString())
    .order('expires_at')
    .limit(100)
  if (error) return response({ error: error.message }, 500)

  let processed = 0
  const failures: string[] = []
  for (const attempt of attempts ?? []) {
    try {
      await finalizeAttempt(serviceClient, attempt)
      processed += 1
    } catch (attemptError) {
      failures.push(`${attempt.id}: ${(attemptError as Error).message}`)
    }
  }

  return response({ processed, failures })
})

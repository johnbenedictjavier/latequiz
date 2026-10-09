import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type StudentInput = {
  schoolId: string
  lastName: string
  firstNames: string
}

const DEFAULT_STUDENT_PASSWORD = 'LQ@Architect2026'

function internalIdentifier(schoolId: string) {
  return `${schoolId.toLowerCase()}@auth.latequiz.internal`
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const authorization = request.headers.get('Authorization')
  if (!authorization) return response({ error: 'Authorization required' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return response({ error: 'Function environment is incomplete' }, 500)

  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } })
  const { data: userData, error: userError } = await userClient.auth.getUser()
  if (userError || !userData.user) return response({ error: 'Invalid session' }, 401)

  const serviceClient = createClient(supabaseUrl, serviceRoleKey)
  const { data: profile, error: profileError } = await serviceClient
    .from('LQ_profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle()

  if (profileError || profile?.role !== 'admin') return response({ error: 'Admin access required' }, 403)

  let body: { students?: StudentInput[] }
  try {
    body = await request.json()
  } catch {
    return response({ error: 'Invalid request body' }, 400)
  }

  const students = body.students ?? []
  if (!students.length || students.length > 500) return response({ error: 'Provide between 1 and 500 students' }, 400)

  const credentials: Array<{ schoolId: string; name: string; password: string }> = []

  for (const student of students) {
    const schoolId = student.schoolId.trim().toUpperCase()
    if (!/^\d{2}-\d{5}$/.test(schoolId)) continue

    const password = DEFAULT_STUDENT_PASSWORD
    const fullName = `${student.firstNames.trim()} ${student.lastName.trim()}`.trim()
    const email = internalIdentifier(schoolId)
    const { data: roster, error: rosterError } = await serviceClient
      .from('LQ_student_roster')
      .upsert({ school_id: schoolId, last_name: student.lastName.trim(), first_names: student.firstNames.trim(), is_active: true }, { onConflict: 'school_id' })
      .select('auth_user_id')
      .single()
    if (rosterError || !roster) return response({ error: `Could not save ${schoolId}: ${rosterError?.message ?? 'Roster record missing'}` }, 422)

    let userId = roster?.auth_user_id ?? null
    if (userId) {
      const { error } = await serviceClient.auth.admin.updateUserById(userId, {
        password,
        user_metadata: { school_id: schoolId, full_name: fullName },
      })
      if (error) return response({ error: `Could not reset ${schoolId}: ${error.message}` }, 422)
    } else {
      const { data: created, error } = await serviceClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { school_id: schoolId, full_name: fullName },
      })
      if (error || !created.user) return response({ error: `Could not create ${schoolId}: ${error?.message ?? 'Unknown error'}` }, 422)
      userId = created.user.id
    }

    await serviceClient
      .from('LQ_student_roster')
      .update({ auth_user_id: userId, must_change_password: true })
      .eq('school_id', schoolId)
    await serviceClient
      .from('LQ_profiles')
      .update({ must_change_password: true })
      .eq('school_id', schoolId)

    credentials.push({ schoolId, name: fullName, password })
  }

  return response({ credentials })
})

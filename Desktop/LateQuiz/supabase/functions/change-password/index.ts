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

const DEFAULT_STUDENT_PASSWORD = 'LQ@Architect2026'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const authorization = request.headers.get('Authorization')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!authorization || !supabaseUrl || !anonKey || !serviceRoleKey) return response({ error: 'Unauthorized' }, 401)

  let body: { password?: string }
  try {
    body = await request.json()
  } catch {
    return response({ error: 'Invalid request body' }, 400)
  }

  const password = body.password ?? ''
  if (password.length < 8) return response({ error: 'Password must contain at least 8 characters' }, 400)
  if (password === DEFAULT_STUDENT_PASSWORD) return response({ error: 'The default password cannot be reused' }, 400)

  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } })
  const { data: userData, error: userError } = await userClient.auth.getUser()
  if (userError || !userData.user) return response({ error: 'Invalid session' }, 401)

  const serviceClient = createClient(supabaseUrl, serviceRoleKey)
  const { error: passwordError } = await serviceClient.auth.admin.updateUserById(userData.user.id, { password })
  if (passwordError) return response({ error: passwordError.message }, 422)

  const { data: profile, error: profileError } = await serviceClient
    .from('LQ_profiles')
    .select('school_id')
    .eq('id', userData.user.id)
    .maybeSingle()
  if (profileError) return response({ error: profileError.message }, 500)

  const { error: updateProfileError } = await serviceClient
    .from('LQ_profiles')
    .update({ must_change_password: false })
    .eq('id', userData.user.id)
  if (updateProfileError) return response({ error: updateProfileError.message }, 500)

  if (profile?.school_id) {
    const { error: updateRosterError } = await serviceClient
      .from('LQ_student_roster')
      .update({ must_change_password: false })
      .eq('school_id', profile.school_id)
    if (updateRosterError) return response({ error: updateRosterError.message }, 500)
  }

  return response({ message: 'Password updated' })
})

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

  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } })
  const { data: userData } = await userClient.auth.getUser()
  if (!userData.user) return response({ error: 'Invalid session' }, 401)

  const serviceClient = createClient(supabaseUrl, serviceRoleKey)
  const { data: profile } = await serviceClient.from('LQ_profiles').select('role').eq('id', userData.user.id).maybeSingle()
  if (profile?.role !== 'admin') return response({ error: 'Admin access required' }, 403)

  const { schoolId } = await request.json()
  if (typeof schoolId !== 'string' || !/^\d{2}-\d{5}$/.test(schoolId.trim())) return response({ error: 'Valid school ID required' }, 400)

  const { data: roster } = await serviceClient
    .from('LQ_student_roster')
    .select('school_id, auth_user_id, first_names, last_name')
    .eq('school_id', schoolId.trim().toUpperCase())
    .maybeSingle()
  if (!roster?.auth_user_id) return response({ error: 'Student account has not been provisioned' }, 404)

  const password = DEFAULT_STUDENT_PASSWORD
  const { error } = await serviceClient.auth.admin.updateUserById(roster.auth_user_id, { password })
  if (error) return response({ error: error.message }, 422)

  await serviceClient.from('LQ_student_roster').update({ must_change_password: true }).eq('school_id', roster.school_id)
  await serviceClient.from('LQ_profiles').update({ must_change_password: true }).eq('school_id', roster.school_id)
  return response({ schoolId: roster.school_id, name: `${roster.first_names} ${roster.last_name}`, password })
})

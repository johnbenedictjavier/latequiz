import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type DeleteResult = {
  result: 'deleted' | 'deactivated'
  school_id: string
  name: string
  auth_user_id: string | null
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
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!authorization || !supabaseUrl || !anonKey || !serviceRoleKey) return response({ error: 'Unauthorized' }, 401)

  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } })
  const { data: userData, error: userError } = await userClient.auth.getUser()
  if (userError || !userData.user) return response({ error: 'Invalid session' }, 401)

  const serviceClient = createClient(supabaseUrl, serviceRoleKey)
  const { data: profile, error: profileError } = await serviceClient
    .from('LQ_profiles')
    .select('role, must_change_password')
    .eq('id', userData.user.id)
    .maybeSingle()
  if (profileError || profile?.role !== 'admin' || profile.must_change_password) return response({ error: 'Admin access required' }, 403)

  let body: { schoolId?: string }
  try {
    body = await request.json()
  } catch {
    return response({ error: 'Invalid request body' }, 400)
  }

  const schoolId = typeof body.schoolId === 'string' ? body.schoolId.trim().toUpperCase() : ''
  if (!/^\d{2}-\d{5}$/.test(schoolId)) return response({ error: 'Valid school ID required' }, 400)

  const { data, error } = await userClient.rpc('LQ_delete_student', { p_school_id: schoolId })
  if (error) return response({ error: error.message }, 422)

  const deletion = data as DeleteResult | null
  if (!deletion?.result) return response({ error: 'The student deletion did not return a result' }, 422)

  if (deletion.result === 'deleted' && deletion.auth_user_id) {
    const { error: authError } = await serviceClient.auth.admin.deleteUser(deletion.auth_user_id)
    if (authError) {
      return response({
        result: deletion.result,
        schoolId: deletion.school_id,
        warning: `The roster record was removed, but the login account could not be cleaned up: ${authError.message}`,
      })
    }
  }

  return response({ result: deletion.result, schoolId: deletion.school_id, name: deletion.name })
})

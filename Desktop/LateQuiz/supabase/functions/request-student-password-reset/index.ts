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

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) return response({ error: 'Function environment is incomplete' }, 500)

  let body: { schoolId?: string }
  try {
    body = await request.json()
  } catch {
    return response({ error: 'Invalid request body' }, 400)
  }

  const schoolId = body.schoolId?.trim().toUpperCase()
  if (!schoolId || !/^\d{2}-\d{5}$/.test(schoolId)) return response({ error: 'Valid school ID required' }, 400)

  const serviceClient = createClient(supabaseUrl, serviceRoleKey)
  const { data: roster, error: rosterError } = await serviceClient
    .from('LQ_student_roster')
    .select('school_id, first_names, last_name, is_active')
    .eq('school_id', schoolId)
    .maybeSingle()
  if (rosterError) return response({ error: rosterError.message }, 500)

  // Keep the response neutral so the endpoint cannot be used to enumerate students.
  if (!roster || !roster.is_active) return response({ message: 'If the account exists, the administrator has been notified.' })

  const name = `${roster.first_names} ${roster.last_name}`.trim()
  const { error: notificationError } = await serviceClient.from('LQ_notifications').insert({
    recipient_role: 'admin',
    type: 'password_reset_request',
    title: 'Password reset requested',
    message: `${name} (${roster.school_id}) requested a password reset.`,
    metadata: { school_id: roster.school_id },
  })
  if (notificationError) return response({ error: notificationError.message }, 500)

  return response({ message: 'If the account exists, the administrator has been notified.' })
})

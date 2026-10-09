import { internalAuthIdentifier, supabase } from './supabase'

export async function signInWithSchoolId(schoolId: string, password: string) {
  if (!supabase) {
    return { error: new Error('Supabase is not configured.') }
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: internalAuthIdentifier(schoolId),
    password,
  })

  return { data, error }
}

export async function signInWithAdminUsername(username: string, password: string) {
  if (!supabase) {
    return { error: new Error('Supabase is not configured.') }
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: internalAuthIdentifier(username),
    password,
  })

  return { data, error }
}

export async function changePassword(password: string) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }

  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) return { error: userError ?? new Error('Session expired.') }

  const { error: passwordError } = await supabase.auth.updateUser({ password })
  if (passwordError) return { error: passwordError }

  const { error: profileError } = await supabase
    .from('LQ_profiles')
    .update({ must_change_password: false })
    .eq('id', userData.user.id)
  if (profileError) return { error: profileError }

  const { data: profile } = await supabase
    .from('LQ_profiles')
    .select('school_id')
    .eq('id', userData.user.id)
    .maybeSingle()
  if (profile?.school_id) {
    const { error: rosterError } = await supabase
      .from('LQ_student_roster')
      .update({ must_change_password: false })
      .eq('school_id', profile.school_id)
    if (rosterError) return { error: rosterError }
  }

  return { error: null }
}

export async function requestPasswordReset(schoolId: string) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase.functions.invoke('request-student-password-reset', {
    body: { schoolId },
  })
  return { data, error }
}

export async function signOut() {
  if (!supabase) return { error: null }
  const { error } = await supabase.auth.signOut()
  return { error }
}

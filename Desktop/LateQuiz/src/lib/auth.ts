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
  const { error } = await supabase.functions.invoke('change-password', { body: { password } })
  return { error }
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

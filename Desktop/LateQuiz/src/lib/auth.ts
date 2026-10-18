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
  if (error) return { error }
  // The Edge Function rotates the account password via the admin API, which leaves the
  // browser holding a stale access token. Refresh the session so the next authenticated
  // call (start/submit attempt) carries a valid JWT instead of a 401. Without this, a
  // brand-new student who just set their password gets "edge function returned a non-2xx
  // status code" on submit until they log out and back in.
  const { error: refreshError } = await supabase.auth.refreshSession()
  return { error: refreshError }
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

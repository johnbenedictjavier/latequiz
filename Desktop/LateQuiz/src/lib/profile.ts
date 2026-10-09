import { supabase } from './supabase'

const AVATAR_BUCKET = 'lq-avatars'

export async function signedAvatarUrl(path: string | null | undefined) {
  if (!supabase || !path) return { url: null, error: null }
  const { data, error } = await supabase.storage.from(AVATAR_BUCKET).createSignedUrl(path, 60 * 60)
  return { url: data?.signedUrl ?? null, error }
}

export async function uploadAvatar(file: File) {
  if (!supabase) return { path: null, url: null, error: new Error('Supabase is not configured.') }
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) return { path: null, url: null, error: userError ?? new Error('Session expired.') }

  const { data: profile, error: profileError } = await supabase
    .from('LQ_profiles')
    .select('avatar_url')
    .eq('id', userData.user.id)
    .maybeSingle()
  if (profileError) return { path: null, url: null, error: profileError }

  const extension = file.name.split('.').pop()?.toLowerCase() || 'jpg'
  const path = `${userData.user.id}/${crypto.randomUUID()}.${extension}`
  const { error: uploadError } = await supabase.storage.from(AVATAR_BUCKET).upload(path, file, {
    cacheControl: '3600',
    contentType: file.type,
    upsert: false,
  })
  if (uploadError) return { path: null, url: null, error: uploadError }

  const { error: updateError } = await supabase
    .from('LQ_profiles')
    .update({ avatar_url: path })
    .eq('id', userData.user.id)
  if (updateError) {
    await supabase.storage.from(AVATAR_BUCKET).remove([path])
    return { path: null, url: null, error: updateError }
  }

  if (profile?.avatar_url && profile.avatar_url !== path) {
    await supabase.storage.from(AVATAR_BUCKET).remove([profile.avatar_url])
  }

  const signed = await signedAvatarUrl(path)
  return { path, url: signed.url, error: signed.error }
}

export async function removeAvatar() {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) return { error: userError ?? new Error('Session expired.') }

  const { data: profile, error: profileError } = await supabase
    .from('LQ_profiles')
    .select('avatar_url')
    .eq('id', userData.user.id)
    .maybeSingle()
  if (profileError) return { error: profileError }

  const { error: updateError } = await supabase
    .from('LQ_profiles')
    .update({ avatar_url: null })
    .eq('id', userData.user.id)
  if (updateError) return { error: updateError }
  if (profile?.avatar_url) await supabase.storage.from(AVATAR_BUCKET).remove([profile.avatar_url])
  return { error: null }
}

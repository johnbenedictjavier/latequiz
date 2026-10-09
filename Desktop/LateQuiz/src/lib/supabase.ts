import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const supabase: SupabaseClient | null =
  supabaseUrl && supabasePublishableKey
    ? createClient(supabaseUrl, supabasePublishableKey)
    : null

export const isSupabaseConfigured = Boolean(supabase)

export function internalAuthIdentifier(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
  return `${normalized}@auth.latequiz.internal`
}

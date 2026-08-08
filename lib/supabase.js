import { createClient } from '@supabase/supabase-js'
import { SUPA_URL, SUPA_ANON, EMPRESA_ID } from './supabaseConfig'

const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

// Cliente para el browser (anon key)
let browserClient = null
export function getClient() {
  if (!browserClient) browserClient = createClient(SUPA_URL, SUPA_ANON)
  return browserClient
}

// Cliente para el servidor (service role - bypasa RLS)
export function getServerClient() {
  return createClient(SUPA_URL, SERVICE || SUPA_ANON, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
}

export { EMPRESA_ID }

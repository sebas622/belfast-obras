import { createClient } from '@supabase/supabase-js'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

function requireConfig() {
  if (!URL || !ANON) {
    throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL y/o NEXT_PUBLIC_SUPABASE_ANON_KEY')
  }
}

// Cliente para el browser (anon key)
let browserClient = null
export function getClient() {
  requireConfig()
  if (!browserClient) browserClient = createClient(URL, ANON)
  return browserClient
}

// Cliente para el servidor (service role - bypasa RLS)
export function getServerClient() {
  requireConfig()
  if (!SERVICE) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY')
  return createClient(URL, SERVICE, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
}

export const EMPRESA_ID = process.env.EMPRESA_ID || '00000000-0000-0000-0000-000000000001'

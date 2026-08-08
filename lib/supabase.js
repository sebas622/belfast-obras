import { createClient } from '@supabase/supabase-js'
import { logWarning } from './errors'

const URL = 'https://gibfrivfjtjjijihaxwh.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdpYmZyaXZmanRqamlqaWhheHdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NTgwOTIsImV4cCI6MjA5MjUzNDA5Mn0.gPOHrcQgjpspadROpAIlNbGlhRNi48sRiEr2BjJeQ-4'
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

// Cliente para el browser (anon key)
let browserClient = null
export function getClient() {
  if (!browserClient) browserClient = createClient(URL, ANON)
  return browserClient
}

// Cliente para el servidor (service role - bypasa RLS)
// Sin service key el cliente cae en la anon key y las escrituras fallan por RLS
// con errores confusos, así que se avisa una sola vez al arrancar.
let warnedMissingService = false
export function getServerClient() {
  if (!SERVICE && !warnedMissingService) {
    warnedMissingService = true
    logWarning('supabase', 'Falta SUPABASE_SERVICE_ROLE_KEY: se usa la anon key y RLS puede rechazar las escrituras')
  }
  return createClient(URL, SERVICE || ANON, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
}

export const EMPRESA_ID = '00000000-0000-0000-0000-000000000001'

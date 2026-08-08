// Configuración compartida de Supabase (cliente y servidor).
export const SUPA_URL = 'https://gibfrivfjtjjijihaxwh.supabase.co'
export const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdpYmZyaXZmanRqamlqaWhheHdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NTgwOTIsImV4cCI6MjA5MjUzNDA5Mn0.gPOHrcQgjpspadROpAIlNbGlhRNi48sRiEr2BjJeQ-4'

export const EMPRESA_ID = '00000000-0000-0000-0000-000000000001'

export const SUPA_REST_URL = SUPA_URL + '/rest/v1'
export const SUPA_STORAGE_URL = SUPA_URL + '/storage/v1'

export const SUPA_BUCKET = 'bcm-media'
export const SUPA_BUCKET_ARCHIVOS = 'archivos'

export const TABLA_STORAGE = 'bcm_storage'

// Headers para la API REST (PostgREST)
export function supaHeaders(extra = {}) {
    return {
        'Content-Type': 'application/json',
        'apikey': SUPA_ANON,
        'Authorization': 'Bearer ' + SUPA_ANON,
        'x-client-info': 'belfast-cm/1.0',
        ...extra,
    }
}

// Headers para subir archivos al bucket de Storage
export function supaUploadHeaders(contentType) {
    return {
        'apikey': SUPA_ANON,
        'Authorization': 'Bearer ' + SUPA_ANON,
        'Content-Type': contentType,
        'x-upsert': 'true',
    }
}

// Headers para operaciones simples sobre el bucket (DELETE, etc.)
export function supaAuthHeaders() {
    return { 'apikey': SUPA_ANON, 'Authorization': 'Bearer ' + SUPA_ANON }
}

// URL pública de un archivo del bucket
export function urlPublica(path, bucket = SUPA_BUCKET) {
    return `${SUPA_STORAGE_URL}/object/public/${bucket}/${path}`
}

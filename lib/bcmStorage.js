import {
    SUPA_REST_URL,
    SUPA_STORAGE_URL,
    SUPA_BUCKET,
    TABLA_STORAGE,
    supaHeaders,
    supaUploadHeaders,
    supaAuthHeaders,
    urlPublica,
} from './supabaseConfig'

// ── STORAGE ROBUSTO ────────────────────────────────────────────────────
// Principio: localStorage es la fuente de verdad local (síncrona, instantánea).
// Supabase es la nube (asíncrona, para sincronización entre dispositivos).
// NUNCA se pisa un dato nuevo con uno viejo del servidor.

const TABLA_URL = `${SUPA_REST_URL}/${TABLA_STORAGE}`
const UPSERT_HEADERS = () => supaHeaders({ 'Prefer': 'resolution=merge-duplicates' })

// Escribe una fila key/value en la tabla bcm_storage (upsert)
async function upsertFila(key, value) {
    await fetch(TABLA_URL, {
        method: 'POST',
        headers: UPSERT_HEADERS(),
        body: JSON.stringify({ key, value }),
    })
}

export const storage = {
    // Escribe SIEMPRE en localStorage primero (síncrono, instantáneo)
    // Luego intenta Supabase en background sin bloquear
    set: async (key, value) => {
        setLocal(key, value)
        try {
            await upsertFila(key, value)
            // Timestamp global para que otros dispositivos detecten el cambio
            await upsertFila('bop_last_update', Date.now().toString())
        } catch { }
        return { value }
    },
    // Lee: intenta Supabase, fallback a localStorage
    get: async (key) => {
        try {
            const r = await fetch(`${TABLA_URL}?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, {
                method: 'GET', headers: supaHeaders(), mode: 'cors'
            })
            if (r.ok) { const d = await r.json(); if (d && d.length > 0) return { value: d[0].value } }
        } catch { }
        return storage.getLocal(key)
    },
    // Lee SOLO desde localStorage — síncrono, cero latencia
    getLocal: (key) => {
        const v = getLocal(key)
        return v ? { value: v } : null
    },
    delete: async (key) => {
        removeLocal(key)
        await borrarClave(key)
        return { deleted: true }
    },
    list: async (prefix) => {
        try {
            const url = prefix ? `${TABLA_URL}?key=like.${encodeURIComponent(prefix)}*&select=key` : `${TABLA_URL}?select=key`
            const r = await fetch(url, { headers: supaHeaders() })
            if (r.ok) { const d = await r.json(); return { keys: d.map(x => x.key) } }
        } catch { }
        try { return { keys: Object.keys(localStorage).filter(k => !prefix || k.startsWith(prefix)) } } catch { return { keys: [] } }
    }
}

// ── BORRADO REMOTO ────────────────────────────────────────
async function borrarRemoto(filtro) {
    try { await fetch(`${TABLA_URL}?${filtro}`, { method: 'DELETE', headers: supaHeaders() }) } catch { }
}

export function borrarClave(key) {
    return borrarRemoto(`key=eq.${encodeURIComponent(key)}`)
}

// Borra todas las filas cuya clave empieza con el prefijo (LIKE prefijo%)
export function borrarPrefijo(prefijo) {
    return borrarRemoto(`key=like.${encodeURIComponent(prefijo)}%25`)
}

// ── HELPERS localStorage (nunca tiran excepción) ─────────────────────
export function setLocal(key, value) {
    try { localStorage.setItem(key, value); return true } catch { return false }
}

export function getLocal(key) {
    try { return localStorage.getItem(key) } catch { return null }
}

export function removeLocal(key) {
    try { localStorage.removeItem(key) } catch { }
}

export function setLocalJSON(key, value) {
    const json = JSON.stringify(value)
    setLocal(key, json)
    return json
}

export function getLocalStr(key, fallback = '') {
    return getLocal(key) || fallback
}

// Algunas claves viejas quedaron guardadas como { _ts, data } — se desempaquetan
export function getLocalJSON(key, fallback = null) {
    const raw = getLocal(key)
    if (!raw) return fallback
    try {
        const p = JSON.parse(raw)
        if (p && typeof p === 'object' && p._ts && Array.isArray(p.data)) return p.data
        return p
    } catch { return fallback }
}

// ── PERSISTENCIA (localStorage + Supabase en background) ─────────────
// Devuelve el string guardado para poder reusarlo (comparaciones, refs).
export function persist(key, value) {
    setLocal(key, value)
    storage.set(key, value).catch(() => { })
    return value
}

export function persistJSON(key, value) {
    return persist(key, JSON.stringify(value))
}

// Las obras y proyectos se guardan sin adjuntos: las fotos y archivos viven
// en sus propias claves para no reventar el límite de localStorage.
export function persistObras(key, obras) {
    return persistJSON(key, obras.map(o => ({ ...o, fotos: [], archivos: [] })))
}

export function persistLics(key, lics) {
    return persistJSON(key, lics.map(l => ({ ...l, visitas: [] })))
}

// Reconstruye las obras con sus adjuntos, que viven en claves aparte
export function hidratarObras(obras, prefijo = 'bop_') {
    return (Array.isArray(obras) ? obras : []).map(o => ({
        ...o,
        fotos: getLocalJSON(`${prefijo}fotos_${o.id}`, []),
        archivos: getLocalJSON(`${prefijo}archs_${o.id}`, []),
        gastos: o.gastos || [],
    }))
}

// Marca cuándo se editó localmente una clave, para que el sync no la pise
export function markLastEdit(key) {
    setLocal('_lastEdit_' + key, Date.now().toString())
}

// ── SUPABASE STORAGE (bucket bcm-media) ─────────────────────────────
// Las fotos se suben como archivos reales al bucket público.
// La URL pública reemplaza al base64 — reduce el egress drásticamente.
export const mediaStorage = {
    // Subir un archivo (recibe dataURL base64) → devuelve URL pública
    upload: async (path, dataUrl) => {
        try {
            const res = await fetch(dataUrl)
            const blob = await res.blob()
            const ext = blob.type.split('/')[1] || 'jpg'
            const filePath = `${path}.${ext}`
            const url = await subirBlob(filePath, blob, SUPA_BUCKET)
            return url
        } catch { return null }
    },
    // Eliminar archivo del bucket
    remove: async (path) => {
        try {
            await fetch(`${SUPA_STORAGE_URL}/object/${SUPA_BUCKET}/${path}`, {
                method: 'DELETE',
                headers: supaAuthHeaders(),
            })
        } catch { }
    },
    // Detectar si una URL es del bucket (ya subida) o base64 local
    isRemoteUrl: (url) => url && (url.startsWith('http://') || url.startsWith('https://')),
}

// Sube un Blob al bucket indicado y devuelve la URL pública (o null)
export async function subirBlob(path, blob, bucket = SUPA_BUCKET) {
    const r = await fetch(`${SUPA_STORAGE_URL}/object/${bucket}/${path}`, {
        method: 'POST',
        headers: supaUploadHeaders(blob.type || 'application/octet-stream'),
        body: blob,
    })
    if (!r.ok) return null
    return urlPublica(path, bucket)
}

// ── CHUNKS ──────────────────────────────────────────────────────────
// Los dataURL grandes no entran en una sola fila: se parten en chunks.
export const CHUNK_SIZE = 3800000

export async function guardarChunks(key, value, chunkSize = CHUNK_SIZE) {
    if (value.length <= chunkSize) {
        try { await upsertFila(key, value); return { archivoKey: key, ok: true } } catch { }
        return { archivoKey: key, ok: false }
    }
    const chunks = Math.ceil(value.length / chunkSize)
    for (let i = 0; i < chunks; i++) {
        try { await upsertFila(`${key}_c${i}`, value.slice(i * chunkSize, (i + 1) * chunkSize)) } catch { }
    }
    try { await upsertFila(`${key}_n`, String(chunks)) } catch { }
    return { archivoKey: key, chunks, ok: true }
}

// Reconstruye un valor partido en chunks (o lo lee derecho si es uno solo)
export async function leerChunks(key, nChunks = 0) {
    if (nChunks > 1) {
        let full = ''
        for (let i = 0; i < nChunks; i++) {
            const r = await storage.get(`${key}_c${i}`)
            if (!r?.value) return null
            full += r.value
        }
        return full
    }
    const r = await storage.get(key)
    return r?.value || null
}

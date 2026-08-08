import { getServerClient, EMPRESA_ID } from '../../../lib/supabase'
import { isAuthorized, unauthorized } from '../../../lib/api-auth'

const MAX_BYTES = 10 * 1024 * 1024
const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/gif': 'gif',
}
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export async function POST(req) {
  if (!isAuthorized(req)) return unauthorized()

  try {
    const formData = await req.formData()
    const file = formData.get('file')
    const obraId = formData.get('obraId') || 'general'
    const descripcion = String(formData.get('descripcion') || '').slice(0, 500)

    if (!file || typeof file.arrayBuffer !== 'function') {
      return Response.json({ error: 'No se recibió archivo' }, { status: 400 })
    }
    if (obraId !== 'general' && !UUID_RE.test(obraId)) {
      return Response.json({ error: 'obraId inválido' }, { status: 400 })
    }
    const ext = ALLOWED_TYPES[file.type]
    if (!ext) return Response.json({ error: 'Tipo de archivo no permitido' }, { status: 415 })
    if (file.size > MAX_BYTES) return Response.json({ error: 'Archivo demasiado grande' }, { status: 413 })

    const sb = getServerClient()
    const buffer = Buffer.from(await file.arrayBuffer())
    if (buffer.byteLength > MAX_BYTES) {
      return Response.json({ error: 'Archivo demasiado grande' }, { status: 413 })
    }
    const path = `${EMPRESA_ID}/${obraId}/${Date.now()}.${ext}`

    const { error: uploadError } = await sb.storage
      .from('bcm-media')
      .upload(path, buffer, { contentType: file.type, upsert: false })

    if (uploadError) throw uploadError

    const { data } = sb.storage.from('bcm-media').getPublicUrl(path)

    await sb.from('fotos').insert({
      empresa_id: EMPRESA_ID,
      obra_id: obraId !== 'general' ? obraId : null,
      nombre: String(file.name || '').slice(0, 200),
      url: data.publicUrl,
      descripcion,
    })

    return Response.json({ ok: true, url: data.publicUrl })
  } catch (e) {
    console.error('Error fotos:', e)
    return Response.json({ error: 'Error interno' }, { status: 500 })
  }
}

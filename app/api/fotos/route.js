import { getServerClient, EMPRESA_ID } from '../../../lib/supabase'
import { errorMessage, logError } from '../../../lib/errors'

export async function POST(req) {
  try {
    const formData = await req.formData()
    const file = formData.get('file')
    const obraId = formData.get('obraId') || 'general'
    const descripcion = formData.get('descripcion') || ''

    if (!file) return Response.json({ error: 'No se recibió archivo' }, { status: 400 })

    const sb = getServerClient()
    const buffer = Buffer.from(await file.arrayBuffer())
    const ext = file.name.split('.').pop()
    const path = `${EMPRESA_ID}/${obraId}/${Date.now()}.${ext}`

    const { error: uploadError } = await sb.storage
      .from('bcm-media')
      .upload(path, buffer, { contentType: file.type, upsert: false })

    if (uploadError) throw uploadError

    const { data } = sb.storage.from('bcm-media').getPublicUrl(path)

    // Si falla el insert, la foto queda en el bucket pero invisible en la app:
    // hay que avisarlo en vez de responder ok.
    const { error: insertError } = await sb.from('fotos').insert({
      empresa_id: EMPRESA_ID,
      obra_id: obraId !== 'general' ? obraId : null,
      nombre: file.name,
      url: data.publicUrl,
      descripcion,
    })
    if (insertError) {
      logError('api/fotos insert', insertError, path)
      return Response.json(
        { error: `La foto se subió pero no se pudo registrar: ${insertError.message}`, url: data.publicUrl },
        { status: 500 }
      )
    }

    return Response.json({ ok: true, url: data.publicUrl })
  } catch (e) {
    logError('api/fotos', e)
    return Response.json({ error: errorMessage(e) }, { status: 500 })
  }
}

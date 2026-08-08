import Anthropic from '@anthropic-ai/sdk'
import { getServerClient, EMPRESA_ID } from '../../../lib/supabase'
import { errorMessage, logError, logWarning } from '../../../lib/errors'

const ACCIONES_SOPORTADAS = ['agregar_personal', 'agregar_licitacion', 'agregar_obra', 'update_avance']

export async function POST(req) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return Response.json({ error: 'Falta configurar ANTHROPIC_API_KEY en el servidor' }, { status: 503 })
    }
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    const { messages } = await req.json()
    if (!Array.isArray(messages) || messages.length === 0) {
      return Response.json({ error: 'messages es requerido' }, { status: 400 })
    }
    const sb = getServerClient()

    // Cargar contexto completo desde Supabase
    const tablas = [
      { nombre: 'obras', query: () => sb.from('obras').select('*').eq('empresa_id', EMPRESA_ID) },
      { nombre: 'personal', query: () => sb.from('personal').select('*').eq('empresa_id', EMPRESA_ID).eq('activo', true) },
      { nombre: 'licitaciones', query: () => sb.from('licitaciones').select('*').eq('empresa_id', EMPRESA_ID) },
      { nombre: 'alertas', query: () => sb.from('alertas').select('*').eq('empresa_id', EMPRESA_ID).eq('resuelta', false) },
    ]
    const resultados = await Promise.all(tablas.map(t => t.query()))
    // Una tabla que falla no puede quedar como "sin datos": la IA respondería
    // con información falsa. Se corta y se avisa.
    const fallidas = resultados
      .map((r, i) => (r.error ? `${tablas[i].nombre}: ${r.error.message}` : null))
      .filter(Boolean)
    if (fallidas.length) {
      const detalle = fallidas.join('; ')
      logError('api/chat contexto', new Error(detalle))
      return Response.json({ error: `No se pudo cargar el contexto desde Supabase (${detalle})` }, { status: 502 })
    }
    const [obras, personal, lics, alertas] = resultados.map(r => r.data || [])

    const ctx = `
OBRAS (${obras.length}): ${obras.map(o => `${o.nombre} — ${o.avance}% avance, estado: ${o.estado}`).join(' | ') || 'Sin obras'}
PERSONAL (${personal.length}): ${personal.map(p => `${p.nombre} (${p.rol})`).join(', ') || 'Sin personal'}
LICITACIONES (${lics.length}): ${lics.map(l => `${l.nombre} — ${l.estado}`).join(' | ') || 'Sin licitaciones'}
ALERTAS (${alertas.length}): ${alertas.map(a => `[${a.prioridad}] ${a.mensaje}`).join(' | ') || 'Sin alertas'}
`

    const system = `Sos el asistente IA de Belfast Construction Management. Respondés en español rioplatense, de forma directa y concisa. Sos parte del equipo de obra.

DATOS ACTUALES:
${ctx}

PODÉS EJECUTAR ACCIONES. Cuando te pidan agregar algo, incluí al final de tu respuesta UNA línea con este formato exacto:
[[ACTION:{"tipo":"agregar_personal","nombre":"Juan Pérez","rol":"Electricista","telefono":"","dni":""}]]
[[ACTION:{"tipo":"agregar_licitacion","nombre":"Licitación X","estado":"pendiente","monto":""}]]
[[ACTION:{"tipo":"agregar_obra","nombre":"Obra X","ubicacion":"","avance":0}]]
[[ACTION:{"tipo":"update_avance","obraId":"ID_AQUI","avance":75}]]

IMPORTANTE: Siempre incluí el [[ACTION:...]] cuando el usuario pida agregar o modificar algo. No lo expliques, simplemente hacelo.`

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system,
      messages,
    })

    const fullText = response.content.find(b => b.type === 'text')?.text || ''

    // Procesar y ejecutar acciones
    const acciones = []
    const actionRegex = /\[\[ACTION:(.*?)\]\]/g
    let match
    while ((match = actionRegex.exec(fullText)) !== null) {
      const raw = match[1]
      let accion
      try {
        accion = JSON.parse(raw)
      } catch (e) {
        logError('api/chat accion JSON inválido', e, raw)
        acciones.push({ tipo: 'desconocida', ok: false, error: `Acción con JSON inválido: ${errorMessage(e)}` })
        continue
      }

      if (!ACCIONES_SOPORTADAS.includes(accion.tipo)) {
        logWarning('api/chat accion no soportada', new Error(String(accion.tipo)))
        acciones.push({ tipo: accion.tipo || 'desconocida', ok: false, error: 'Tipo de acción no soportado' })
        continue
      }

      try {
        let error = null

        if (accion.tipo === 'agregar_personal') {
          ({ error } = await sb.from('personal').insert({
            empresa_id: EMPRESA_ID,
            nombre: accion.nombre,
            rol: accion.rol || 'Operario',
            telefono: accion.telefono || '',
            dni: accion.dni || '',
            activo: true,
          }))
        } else if (accion.tipo === 'agregar_licitacion') {
          ({ error } = await sb.from('licitaciones').insert({
            empresa_id: EMPRESA_ID,
            nombre: accion.nombre,
            estado: accion.estado || 'pendiente',
            monto: accion.monto || '',
          }))
        } else if (accion.tipo === 'agregar_obra') {
          ({ error } = await sb.from('obras').insert({
            empresa_id: EMPRESA_ID,
            nombre: accion.nombre,
            ubicacion: accion.ubicacion || '',
            avance: accion.avance || 0,
            estado: 'curso',
          }))
        } else if (accion.tipo === 'update_avance') {
          ({ error } = await sb.from('obras').update({
            avance: accion.avance,
            updated_at: new Date().toISOString(),
          }).eq('id', accion.obraId).eq('empresa_id', EMPRESA_ID))
        }

        if (error) logError(`api/chat ${accion.tipo}`, error)
        acciones.push({ tipo: accion.tipo, ok: !error, nombre: accion.nombre, error: error?.message })
      } catch (e) {
        logError(`api/chat ${accion.tipo}`, e)
        acciones.push({ tipo: accion.tipo, ok: false, nombre: accion.nombre, error: errorMessage(e) })
      }
    }

    // Limpiar el texto de los bloques ACTION
    const texto = fullText.replace(/\[\[ACTION:.*?\]\]/g, '').trim()

    return Response.json({ texto, acciones })

  } catch (error) {
    logError('api/chat', error)
    return Response.json({ error: errorMessage(error) }, { status: 500 })
  }
}

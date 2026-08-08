import Anthropic from '@anthropic-ai/sdk'
import { getServerClient, EMPRESA_ID } from '../../../lib/supabase'
import { parseAccionesIA, limpiarAcciones } from '../../../lib/accionesIA'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(req) {
  try {
    const { messages } = await req.json()
    const sb = getServerClient()

    // Cargar contexto completo desde Supabase
    const [{ data: obras }, { data: personal }, { data: lics }, { data: alertas }] = await Promise.all([
      sb.from('obras').select('*').eq('empresa_id', EMPRESA_ID),
      sb.from('personal').select('*').eq('empresa_id', EMPRESA_ID).eq('activo', true),
      sb.from('licitaciones').select('*').eq('empresa_id', EMPRESA_ID),
      sb.from('alertas').select('*').eq('empresa_id', EMPRESA_ID).eq('resuelta', false),
    ])

    const ctx = `
OBRAS (${obras?.length || 0}): ${obras?.map(o => `${o.nombre} — ${o.avance}% avance, estado: ${o.estado}`).join(' | ') || 'Sin obras'}
PERSONAL (${personal?.length || 0}): ${personal?.map(p => `${p.nombre} (${p.rol})`).join(', ') || 'Sin personal'}
LICITACIONES (${lics?.length || 0}): ${lics?.map(l => `${l.nombre} — ${l.estado}`).join(' | ') || 'Sin licitaciones'}
ALERTAS (${alertas?.length || 0}): ${alertas?.map(a => `[${a.prioridad}] ${a.mensaje}`).join(' | ') || 'Sin alertas'}
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
    for (const { accion, error: parseError } of parseAccionesIA(fullText)) {
      if (!accion) {
        acciones.push({ tipo: 'unknown', ok: false, error: parseError?.message })
        continue
      }
      try {
        let resultado = { tipo: accion.tipo, ok: false }

        if (accion.tipo === 'agregar_personal') {
          const { error } = await sb.from('personal').insert({
            empresa_id: EMPRESA_ID,
            nombre: accion.nombre,
            rol: accion.rol || 'Operario',
            telefono: accion.telefono || '',
            dni: accion.dni || '',
            activo: true,
          })
          resultado = { tipo: accion.tipo, ok: !error, nombre: accion.nombre, error: error?.message }
        }

        if (accion.tipo === 'agregar_licitacion') {
          const { error } = await sb.from('licitaciones').insert({
            empresa_id: EMPRESA_ID,
            nombre: accion.nombre,
            estado: accion.estado || 'pendiente',
            monto: accion.monto || '',
          })
          resultado = { tipo: accion.tipo, ok: !error, nombre: accion.nombre, error: error?.message }
        }

        if (accion.tipo === 'agregar_obra') {
          const { error } = await sb.from('obras').insert({
            empresa_id: EMPRESA_ID,
            nombre: accion.nombre,
            ubicacion: accion.ubicacion || '',
            avance: accion.avance || 0,
            estado: 'curso',
          })
          resultado = { tipo: accion.tipo, ok: !error, nombre: accion.nombre, error: error?.message }
        }

        if (accion.tipo === 'update_avance') {
          const { error } = await sb.from('obras').update({
            avance: accion.avance,
            updated_at: new Date().toISOString(),
          }).eq('id', accion.obraId).eq('empresa_id', EMPRESA_ID)
          resultado = { tipo: accion.tipo, ok: !error, error: error?.message }
        }

        acciones.push(resultado)
      } catch (e) {
        acciones.push({ tipo: 'unknown', ok: false, error: e.message })
      }
    }

    // Limpiar el texto de los bloques ACTION
    const texto = limpiarAcciones(fullText)

    return Response.json({ texto, acciones })

  } catch (error) {
    console.error('Error chat:', error)
    return Response.json({ error: error.message }, { status: 500 })
  }
}

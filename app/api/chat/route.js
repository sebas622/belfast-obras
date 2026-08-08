import Anthropic from '@anthropic-ai/sdk'
import { getServerClient, EMPRESA_ID } from '../../../lib/supabase'
import { isAuthorized, unauthorized } from '../../../lib/api-auth'

const MAX_MESSAGES = 40
const MAX_CHARS = 20000
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function validarMensajes(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return null
  const total = JSON.stringify(messages).length
  if (total > MAX_CHARS) return null
  const limpios = messages.map(m => ({
    role: m?.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m?.content === 'string' ? m.content : '',
  }))
  return limpios.every(m => m.content) ? limpios : null
}

export async function POST(req) {
  if (!isAuthorized(req)) return unauthorized()
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: 'Falta configuración del servidor' }, { status: 500 })
  }
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  try {
    const { messages: raw } = await req.json()
    const messages = validarMensajes(raw)
    if (!messages) return Response.json({ error: 'messages inválido' }, { status: 400 })
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
    const actionRegex = /\[\[ACTION:(.*?)\]\]/g
    let match
    while ((match = actionRegex.exec(fullText)) !== null) {
      try {
        const accion = JSON.parse(match[1])
        let resultado = { tipo: accion.tipo, ok: false }
        const texto = (v, max) => String(v ?? '').slice(0, max)

        if (accion.tipo === 'agregar_personal') {
          const { error } = await sb.from('personal').insert({
            empresa_id: EMPRESA_ID,
            nombre: texto(accion.nombre, 120),
            rol: texto(accion.rol, 60) || 'Operario',
            telefono: texto(accion.telefono, 40),
            dni: texto(accion.dni, 20),
            activo: true,
          })
          resultado = { tipo: accion.tipo, ok: !error, nombre: accion.nombre, error: error?.message }
        }

        if (accion.tipo === 'agregar_licitacion') {
          const { error } = await sb.from('licitaciones').insert({
            empresa_id: EMPRESA_ID,
            nombre: texto(accion.nombre, 200),
            estado: texto(accion.estado, 40) || 'pendiente',
            monto: texto(accion.monto, 40),
          })
          resultado = { tipo: accion.tipo, ok: !error, nombre: accion.nombre, error: error?.message }
        }

        if (accion.tipo === 'agregar_obra') {
          const { error } = await sb.from('obras').insert({
            empresa_id: EMPRESA_ID,
            nombre: texto(accion.nombre, 200),
            ubicacion: texto(accion.ubicacion, 200),
            avance: Math.min(100, Math.max(0, Number(accion.avance) || 0)),
            estado: 'curso',
          })
          resultado = { tipo: accion.tipo, ok: !error, nombre: accion.nombre, error: error?.message }
        }

        if (accion.tipo === 'update_avance' && UUID_RE.test(String(accion.obraId || ''))) {
          const avance = Number(accion.avance)
          if (!Number.isFinite(avance) || avance < 0 || avance > 100) {
            acciones.push({ tipo: accion.tipo, ok: false, error: 'avance inválido' })
            continue
          }
          const { error } = await sb.from('obras').update({
            avance,
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
    const texto = fullText.replace(/\[\[ACTION:.*?\]\]/g, '').trim()

    return Response.json({ texto, acciones })

  } catch (error) {
    console.error('Error chat:', error)
    return Response.json({ error: 'Error interno' }, { status: 500 })
  }
}

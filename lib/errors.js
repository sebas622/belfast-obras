// Reporte centralizado de errores.
// Regla: ningún catch se queda vacío. O se maneja el error de forma útil
// (mostrándoselo al usuario) o se reporta acá para que quede en la consola.

export function errorMessage(error) {
  if (!error) return 'Error desconocido'
  if (typeof error === 'string') return error
  if (error.message) return error.message
  try { return JSON.stringify(error) } catch { return String(error) }
}

export function logError(context, error, extra) {
  const msg = `[${context}] ${errorMessage(error)}`
  if (extra !== undefined) console.error(msg, extra, error)
  else console.error(msg, error)
}

// Errores esperables y no accionables (ej: cuota de localStorage llena, red
// caída con fallback local). Se registran sin ensuciar la consola de errores.
export function logWarning(context, error, extra) {
  const msg = `[${context}] ${errorMessage(error)}`
  if (extra !== undefined) console.warn(msg, extra)
  else console.warn(msg)
}

// Construye un Error con el detalle del body a partir de una respuesta HTTP fallida.
export async function httpError(context, res) {
  let detail = ''
  try {
    const text = await res.text()
    if (text) {
      try {
        const json = JSON.parse(text)
        detail = json.error?.message || json.message || json.msg || text
      } catch { detail = text }
    }
  } catch (e) {
    detail = `no se pudo leer el body: ${errorMessage(e)}`
  }
  return new Error(`${context}: HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`)
}

// La IA devuelve acciones embebidas en el texto: [[ACTION:{...}]]
const ACCION_RE = /\[\[ACTION:([\s\S]*?)\]\]/
const ACCION_RE_ALL = /\[\[ACTION:([\s\S]*?)\]\]/g

// Los modelos meten comillas curvas y rompen JSON.parse
function parsearJSON(raw) {
    return JSON.parse(raw
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .trim())
}

// Quita los bloques [[ACTION:...]] del texto que se le muestra al usuario
export function limpiarAcciones(texto) {
    return (texto || '').replace(ACCION_RE_ALL, '').trim()
}

// Devuelve { accion, texto }: accion es null si no hay o si el JSON es inválido
export function parseAccionIA(respuesta) {
    const texto = limpiarAcciones(respuesta)
    const match = (respuesta || '').match(ACCION_RE)
    if (!match) return { accion: null, texto }
    try {
        return { accion: parsearJSON(match[1]), texto }
    } catch (e) {
        return { accion: null, texto, error: e }
    }
}

// Igual que parseAccionIA pero para respuestas con varias acciones
export function parseAccionesIA(respuesta) {
    return [...(respuesta || '').matchAll(ACCION_RE_ALL)].map(m => {
        try {
            return { accion: parsearJSON(m[1]) }
        } catch (e) {
            return { accion: null, error: e }
        }
    })
}

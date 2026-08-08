// Formatos de fecha/hora usados en toda la app (locale es-AR).
export function hoyAR(d = new Date()) {
    return d.toLocaleDateString('es-AR')
}

export function horaAR(d = new Date()) {
    return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
}

// Fecha apta para nombres de archivo: 08-08-2026
export function hoyArchivo(d = new Date()) {
    return hoyAR(d).replace(/\//g, '-')
}

// Helpers de archivos: dataURL ↔ Blob, apertura y descarga.

export function getBase64(d) { return d.split(',')[1] }

export function getMediaType(d) { const m = d.match(/data:([^;]+);/); return m ? m[1] : 'image/jpeg' }

// Bloque de imagen con el formato que espera la API de Anthropic
export function imagenIA(dataUrl) {
    return { type: 'image', source: { type: 'base64', media_type: getMediaType(dataUrl), data: getBase64(dataUrl) } }
}

// dataURL → Blob (sin fetch, funciona en iOS Safari)
export function dataUrlToBlob(dataUrl) {
    const arr = dataUrl.split(',')
    const mime = arr[0].match(/:(.*?);/)[1]
    const bstr = atob(arr[1])
    const u8 = new Uint8Array(bstr.length)
    for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i)
    return new Blob([u8], { type: mime })
}

// Abre un dataURL en la misma pestaña — window.open no funciona en PWA iOS
export function abrirDataUrl(dataUrl) {
    try {
        window.location.href = URL.createObjectURL(dataUrlToBlob(dataUrl))
        return true
    } catch { return false }
}

// Dispara la descarga de un blob y libera la URL
export function descargarBlob(blob, nombre, { revocarEnMs = 3000 } = {}) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = nombre
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), revocarEnMs)
    return url
}

// Descarga contenido de texto (csv, html, txt…) como archivo
export function descargarTexto(contenido, nombre, tipo = 'text/plain;charset=utf-8') {
    return descargarBlob(new Blob([contenido], { type: tipo }), nombre)
}

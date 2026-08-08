import { timingSafeEqual } from 'crypto'

function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

// Autenticación para las rutas /api: token compartido en el header
// `x-api-token` (o `Authorization: Bearer <token>`), comparado con ADMIN_API_TOKEN.
// Si no hay token configurado, la ruta queda cerrada.
export function isAuthorized(request) {
  const expected = process.env.ADMIN_API_TOKEN
  if (!expected) return false
  const header = request.headers.get('x-api-token') ||
    (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  return Boolean(header) && safeEqual(header, expected)
}

export function unauthorized() {
  return Response.json({ error: 'No autorizado' }, { status: 401 })
}

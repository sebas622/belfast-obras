// Helpers puros compartidos por la app.

// ── PERMISOS POR USUARIO ─────────────────────────────────────────────
// 'ambas' → ve el selector y puede entrar a las dos
// 'belfast' → entra directo a Belfast sin ver el selector
// 'vv' → entra directo a V+V sin ver el selector
export const PERMISOS_EMPRESA = {
    // Super admins — ven las dos empresas
    'sebas622@gmail.com': 'ambas',
    // Usuarios solo Belfast
    'usuario.belfast@ejemplo.com': 'belfast',
    // Usuarios solo V+V
    'usuario.vv@ejemplo.com': 'vv',
};
// Email por defecto si no está en la lista → accede a ambas
export const PERMISO_DEFAULT = 'ambas';

export function getPermisoEmpresa(email) {
    if (!email) return PERMISO_DEFAULT;
    const key = email.toLowerCase().trim();
    return PERMISOS_EMPRESA[key] || PERMISO_DEFAULT;
}

export function isDirectivo(user) {
    if (!user) return false;
    const nivel = user.nivel || '';
    const rol = (user.rol || '').toLowerCase();
    return nivel === 'directivo' || ['administrador', 'supervisor', 'gerente', 'director'].some(r => rol.includes(r));
}

export function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
}

export function uid() { return Math.random().toString(36).slice(2, 9); }

export function getBase64(d) { return d.split(',')[1]; }

export function getMediaType(d) { const m = d.match(/data:([^;]+);/); return m ? m[1] : 'image/jpeg'; }

export function daysSince(s) { if (!s) return 999; const [d, m, y] = s.split("/"); return Math.ceil((new Date(`20${y}`, m - 1, d) - new Date()) / (1000 * 60 * 60 * 24)); }

export function hexLight(hex) { try { const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16); return `#${Math.round(r * .12 + 255 * .88).toString(16).padStart(2, '0')}${Math.round(g * .12 + 255 * .88).toString(16).padStart(2, '0')}${Math.round(b * .12 + 255 * .88).toString(16).padStart(2, '0')}`; } catch { return '#EFF6FF'; } }

export function parseMontoNum(m) { if (!m) return 0; return parseInt(String(m).replace(/\./g, '').replace(/[^0-9]/g, '')) || 0; }

export function formatMonto(val) {
    const nums = String(val).replace(/[^\d]/g, '');
    if (!nums) return '';
    return nums.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' $';
}

export function parseMonto(val) { return String(val).replace(/[^\d]/g, ''); }

// Helpers GPS
export function distanciaMetros(lat1, lon1, lat2, lon2) {
    const R = 6371000; // metros
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

export function formatDuration(ms) {
    if (!ms || ms < 0) return '—';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
}

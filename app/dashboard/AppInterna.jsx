'use client'
import React, { useState, useRef, useEffect, useCallback, memo } from "react";
import { createClient } from '@supabase/supabase-js'

const SUPA_URL = 'https://gibfrivfjtjjijihaxwh.supabase.co'
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdpYmZyaXZmanRqamlqaWhheHdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NTgwOTIsImV4cCI6MjA5MjUzNDA5Mn0.gPOHrcQgjpspadROpAIlNbGlhRNi48sRiEr2BjJeQ-4'
const EMPRESA_ID = '00000000-0000-0000-0000-000000000001'

let _sb = null
function getSB() {
  if (!_sb) _sb = createClient(SUPA_URL, SUPA_ANON)
  return _sb
}


// ── SUPABASE CONFIG ─────────────────────────────────────────────
const SUPA_KEY = SUPA_ANON;
const SH = () => ({ 
    "Content-Type": "application/json", 
    "apikey": SUPA_KEY, 
    "Authorization": "Bearer " + SUPA_KEY,
    "x-client-info": "belfast-cm/1.0"
});

// Storage adapter: Supabase (cloud) con fallback a localStorage
// ── STORAGE ROBUSTO ────────────────────────────────────────────────────
// Principio: localStorage es la fuente de verdad local (síncrona, instantánea).
// Supabase es la nube (asíncrona, para sincronización entre dispositivos).
// NUNCA se pisa un dato nuevo con uno viejo del servidor.

const storage = {
    // Escribe SIEMPRE en localStorage primero (síncrono, instantáneo)
    // Luego intenta Supabase en background sin bloquear
    set: async (key, value) => {
        // 1. localStorage primero — nunca falla, inmediato
        try { localStorage.setItem(key, value); } catch { }
        // 2. Supabase en background
        try {
            await fetch(SUPA_URL + "/rest/v1/bcm_storage", {
                method: "POST",
                headers: { ...SH(), "Prefer": "resolution=merge-duplicates" },
                body: JSON.stringify({ key, value })
            });
        } catch { }
        return { value };
    },
    // Lee: intenta Supabase, fallback a localStorage
    get: async (key) => {
        try {
            const r = await fetch(SUPA_URL + "/rest/v1/bcm_storage?key=eq." + encodeURIComponent(key) + "&select=value&limit=1", {
                method: "GET", headers: SH(), mode: "cors"
            });
            if (r.ok) { const d = await r.json(); if (d && d.length > 0) return { value: d[0].value }; }
        } catch { }
        // Fallback localStorage
        try { const v = localStorage.getItem(key); return v ? { value: v } : null; } catch { return null; }
    },
    // Lee SOLO desde localStorage — síncrono, cero latencia
    getLocal: (key) => {
        try { const v = localStorage.getItem(key); return v ? { value: v } : null; } catch { return null; }
    },
    delete: async (key) => {
        try { localStorage.removeItem(key); } catch { }
        try { await fetch(SUPA_URL + "/rest/v1/bcm_storage?key=eq." + encodeURIComponent(key), { method: "DELETE", headers: SH() }); } catch { }
        return { deleted: true };
    },
    list: async (prefix) => {
        try {
            const url = prefix ? SUPA_URL + "/rest/v1/bcm_storage?key=like." + encodeURIComponent(prefix) + "*&select=key" : SUPA_URL + "/rest/v1/bcm_storage?select=key";
            const r = await fetch(url, { headers: SH() });
            if (r.ok) { const d = await r.json(); return { keys: d.map(x => x.key) }; }
        } catch { }
        try { return { keys: Object.keys(localStorage).filter(k => !prefix || k.startsWith(prefix)) }; } catch { return { keys: [] }; }
    }
};

// ── SUPABASE STORAGE (bucket bcm-media) ─────────────────────────────
// Las fotos se suben como archivos reales al bucket público.
// La URL pública reemplaza al base64 — reduce el egress drásticamente.
const SUPA_BUCKET = "bcm-media";
const SUPA_STORAGE_URL = SUPA_URL + "/storage/v1";

const mediaStorage = {
    // Subir un archivo (recibe dataURL base64) → devuelve URL pública
    upload: async (path, dataUrl) => {
        try {
            // Convertir dataURL a Blob
            const res = await fetch(dataUrl);
            const blob = await res.blob();
            const ext = blob.type.split('/')[1] || 'jpg';
            const filePath = `${path}.${ext}`;

            // Subir al bucket
            const r = await fetch(`${SUPA_STORAGE_URL}/object/${SUPA_BUCKET}/${filePath}`, {
                method: "POST",
                headers: {
                    "apikey": SUPA_KEY,
                    "Authorization": "Bearer " + SUPA_KEY,
                    "Content-Type": blob.type,
                    "x-upsert": "true"
                },
                body: blob
            });
            if (!r.ok) return null;
            // Devolver URL pública
            return `${SUPA_STORAGE_URL}/object/public/${SUPA_BUCKET}/${filePath}`;
        } catch { return null; }
    },
    // Eliminar archivo del bucket
    remove: async (path) => {
        try {
            await fetch(`${SUPA_STORAGE_URL}/object/${SUPA_BUCKET}/${path}`, {
                method: "DELETE",
                headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY }
            });
        } catch { }
    },
    // Detectar si una URL es del bucket (ya subida) o base64 local
    isRemoteUrl: (url) => url && (url.startsWith('http://') || url.startsWith('https://')),
};

// ── UPLOAD DE FOTOS ─────────────────────────────────────────────────
// 1) Supabase Storage bucket → URL pública permanente (ideal)
// 2) Tabla bcm_storage → base64 en BD (fallback garantizado)  
// 3) base64 en memoria → solo sesión actual (último recurso)
async function uploadFoto(dataUrl, carpeta, nombre) {
    if (!dataUrl) return null;
    if (mediaStorage.isRemoteUrl(dataUrl)) return dataUrl;
    const fotoId = nombre || uid();
    // 1. Intentar Supabase Storage bucket (URL pública — ideal)
    try {
        const remoteUrl = await mediaStorage.upload(`${carpeta}/${fotoId}`, dataUrl);
        if (remoteUrl) return remoteUrl; // URL pública permanente
    } catch { }
    // 2. Devolver base64 directamente — se guarda junto con la obra en Supabase
    // Esto garantiza que todos los usuarios vean la foto via sync
    return dataUrl;
}

// Resolver URL de foto — supakey:xxx carga desde Supabase/localStorage
async function resolverUrlFoto(url) {
    if (!url || !url.startsWith('supakey:')) return url;
    const key = url.replace('supakey:', '');
    try {
        const local = localStorage.getItem(key);
        if (local) return local;
        const r = await storage.get(key);
        if (r?.value) { try { localStorage.setItem(key, r.value); } catch {} return r.value; }
    } catch {}
    return null;
}
// Carga desde localStorage SINCRÓNICAMENTE (sin flash), persiste en ambos lados
function useStoredState(key, defaultValue) {
    const [state, setState] = useState(() => {
        const local = storage.getLocal(key);
        if (local?.value) { try { return JSON.parse(local.value); } catch { } }
        return defaultValue;
    });
    const [cloudSynced, setCloudSynced] = useState(false);

    // Al montar: sincronizar con Supabase una sola vez
    useEffect(() => {
        (async () => {
            try {
                const r = await storage.get(key);
                if (r?.value) {
                    const cloudData = JSON.parse(r.value);
                    // Usar Supabase solo si tiene más datos que el local
                    setState(local => {
                        const localSize = JSON.stringify(local).length;
                        const cloudSize = JSON.stringify(cloudData).length;
                        return cloudSize > localSize ? cloudData : local;
                    });
                }
            } catch { }
            setCloudSynced(true);
        })();
    }, [key]);

    // Persiste cada vez que cambia el estado
    const setAndPersist = useCallback((updater) => {
        setState(prev => {
            const next = typeof updater === 'function' ? updater(prev) : updater;
            // Guardar inmediatamente en ambos lados
            const json = JSON.stringify(next);
            try { localStorage.setItem(key, json); } catch { }
            storage.set(key, json).catch(() => {});
            return next;
        });
    }, [key]);

    return [state, setAndPersist, cloudSynced];
}

// ── CONSTANTES ─────────────────────────────────────────────────────────
const AIRPORTS = [{ id: "aep", code: "AEP", name: "Aeroparque Jorge Newbery" }, { id: "eze", code: "EZE", name: "Aerop. Int'l Ministro Pistarini" }];
const LIC_ESTADOS = [{ id: "visitar", label: "A Visitar", color: "#F59E0B", bg: "#FFFBEB" }, { id: "presupuesto", label: "Presupuesto", color: "#3B82F6", bg: "#EFF6FF" }, { id: "curso", label: "En Curso", color: "#8B5CF6", bg: "#F5F3FF" }, { id: "presentada", label: "Presentada", color: "#F97316", bg: "#FFF7ED" }, { id: "adjudicada", label: "Adjudicada", color: "#10B981", bg: "#ECFDF5" }, { id: "descartada", label: "Descartada", color: "#EF4444", bg: "#FEF2F2" }];
const OBRA_ESTADOS = [{ id: "pendiente", label: "Pendiente", color: "#94A3B8", bg: "#F8FAFC" }, { id: "curso", label: "En Curso", color: "#10B981", bg: "#ECFDF5" }, { id: "pausada", label: "Pausada", color: "#F59E0B", bg: "#FFFBEB" }, { id: "terminada", label: "Terminada", color: "#6366F1", bg: "#EEF2FF" }];
const ROLES = ["Arquitecto a cargo", "Ingeniero a cargo", "Directivos", "Dirección de obra", "Sobreestante de Obra", "Jefe de Obra", "Capataz", "Técnico", "Proveedor", "Contratista", "Administrativo"];
const DOC_TYPES = [{ id: "art", label: "ART", acceptsExp: true }, { id: "antec", label: "Antecedentes", acceptsExp: false }, { id: "preoc", label: "Preocupacional", acceptsExp: true }, { id: "dni", label: "DNI", acceptsExp: false }, { id: "sicop", label: "SiCoP", acceptsExp: false }, { id: "alta", label: "Alta Temprana", acceptsExp: false }];
const LIC_DOC_TYPES = [{ id: "planos", label: "Planos", accept: ".pdf,.png,.jpg,.dwg,.zip" }, { id: "pliego", label: "Pliego", accept: ".pdf,.doc,.docx" }, { id: "excel", label: "Excel", accept: ".xlsx,.xls,.csv,.pdf" }, { id: "otros", label: "Otros", accept: "*" }];
const EMAIL_IA = "ia.belfastcm@gmail.com";

// ── PERMISOS POR USUARIO ─────────────────────────────────────────────
// 'ambas' → ve el selector y puede entrar a las dos
// 'belfast' → entra directo a Belfast sin ver el selector
// 'vv' → entra directo a V+V sin ver el selector
const PERMISOS_EMPRESA = {
    // Super admins — ven las dos empresas
    'sebas622@gmail.com': 'ambas',
    // Usuarios solo Belfast
    'usuario.belfast@ejemplo.com': 'belfast',
    // Usuarios solo V+V
    'usuario.vv@ejemplo.com': 'vv',
};
// Email por defecto si no está en la lista → accede a ambas
const PERMISO_DEFAULT = 'ambas';

function getPermisoEmpresa(email) {
    if (!email) return PERMISO_DEFAULT;
    const key = email.toLowerCase().trim();
    return PERMISOS_EMPRESA[key] || PERMISO_DEFAULT;
}

const ADMIN_CREDS = [{ user: "admin", pass: "belfast2025", rol: "Administrador", nivel: "directivo" }, { user: "supervisor", pass: "obra2025", rol: "Supervisor", nivel: "directivo" }];
const USERS = ADMIN_CREDS;

function isDirectivo(user) {
    if (!user) return false;
    const nivel = user.nivel || '';
    const rol = (user.rol || '').toLowerCase();
    return nivel === 'directivo' || ['administrador', 'supervisor', 'gerente', 'director'].some(r => rol.includes(r));
}

// ── TEMA ───────────────────────────────────────────────────────────────
const THEME_PRESETS = [
    { id: "azul", label: "Azul", accent: "#1D4ED8", al: "#EFF6FF", bg: "#F1F5F9", card: "#fff", border: "#E2E8F0", text: "#0F172A", sub: "#475569", muted: "#94A3B8", navy: "#0F172A" },
    { id: "oscuro", label: "Oscuro", accent: "#60A5FA", al: "#172554", bg: "#0F172A", card: "#1E293B", border: "#334155", text: "#F1F5F9", sub: "#94A3B8", muted: "#475569", navy: "#020617" },
    { id: "verde", label: "Verde", accent: "#16A34A", al: "#DCFCE7", bg: "#F0FDF4", card: "#fff", border: "#BBF7D0", text: "#0F172A", sub: "#475569", muted: "#94A3B8", navy: "#14532D" },
    { id: "violeta", label: "Violeta", accent: "#7C3AED", al: "#F5F3FF", bg: "#FAF5FF", card: "#fff", border: "#E9D5FF", text: "#0F172A", sub: "#475569", muted: "#94A3B8", navy: "#3B0764" },
    { id: "rojo", label: "Rojo", accent: "#DC2626", al: "#FEF2F2", bg: "#FFF5F5", card: "#fff", border: "#FECACA", text: "#0F172A", sub: "#475569", muted: "#94A3B8", navy: "#7F1D1D" },
    { id: "naranja", label: "Naranja", accent: "#EA580C", al: "#FFF7ED", bg: "#FFFBF5", card: "#fff", border: "#FED7AA", text: "#0F172A", sub: "#475569", muted: "#94A3B8", navy: "#431407" },
    { id: "minimal", label: "Mínimal", accent: "#111111", al: "#F5F5F5", bg: "#FAFAFA", card: "#fff", border: "#E8E8E8", text: "#111", sub: "#555", muted: "#aaa", navy: "#111" },
    { id: "cyan", label: "Cyan", accent: "#0891B2", al: "#ECFEFF", bg: "#F0FDFF", card: "#fff", border: "#A5F3FC", text: "#0F172A", sub: "#475569", muted: "#94A3B8", navy: "#164E63" },
    { id: "rosa", label: "Rosa", accent: "#DB2777", al: "#FDF2F8", bg: "#FDF4FF", card: "#fff", border: "#FBCFE8", text: "#0F172A", sub: "#475569", muted: "#94A3B8", navy: "#500724" },
];
const FONTS = [
    { id: "jakarta", label: "Jakarta", value: "'Plus Jakarta Sans'" },
    { id: "inter", label: "Inter", value: "'Inter'" },
    { id: "poppins", label: "Poppins", value: "'Poppins'" },
    { id: "roboto", label: "Roboto", value: "'Roboto'" },
    { id: "montserrat", label: "Montserrat", value: "'Montserrat'" },
    { id: "system", label: "Sistema", value: "-apple-system,BlinkMacSystemFont" },
];
const RADIUS_OPTS = [{ id: "sharp", label: "Recto", r: 4 }, { id: "normal", label: "Normal", r: 14 }, { id: "suave", label: "Suave", r: 20 }, { id: "round", label: "Redondo", r: 28 }];
const COLOR_KEYS = [{ k: "accent", label: "Principal" }, { k: "bg", label: "Fondo" }, { k: "card", label: "Tarjetas" }, { k: "text", label: "Texto" }, { k: "navy", label: "Encabezado" }, { k: "border", label: "Bordes" }];
const DEFAULT_COLORS = { accent: "#1D4ED8", al: "#EFF6FF", bg: "#F1F5F9", card: "#ffffff", border: "#E2E8F0", text: "#0F172A", sub: "#475569", muted: "#94A3B8", navy: "#0F172A" };
const DEFAULT_UBICACIONES = [{ id: "aep", code: "AEP", name: "Aeroparque Jorge Newbery" }, { id: "eze", code: "EZE", name: "Aerop. Int'l Ministro Pistarini" }];

const DEFAULT_TEXTOS = {
    nav_ia: "IA", nav_inicio: "Inicio", nav_licitaciones: "Licitaciones", nav_obras: "Obras", nav_personal: "Personal", nav_mensajes: "Mensajes", nav_cargar: "Cargar", nav_mas: "Más",
    dash_titulo: "Panel operativo", dash_subtitulo: "BelfastCM × AA2000",
    dash_licitaciones: "Licitaciones", dash_obras_activas: "Obras activas", dash_alertas: "Alertas", dash_personal: "Personal",
    dash_obras_curso: "Obras en curso", dash_ver_todas: "Ver todas →", dash_acciones: "Acciones rápidas",
    dash_nueva_lic: "Nueva licitación", dash_nueva_obra: "Nueva obra", dash_presup_mat: "Presupuesto materiales", dash_subcontratos: "Subcontratos",
    obras_titulo: "Obras", obras_nueva: "Nueva obra", obras_avance: "Avance", obras_inicio: "Inicio", obras_cierre: "Cierre est.",
    obras_sector: "Sector", obras_estado: "Estado", obras_info: "Info", obras_notas: "Notas", obras_fotos: "Fotos", obras_archivos: "Archivos",
    obras_obs_placeholder: "Registrar observación...", obras_sin_notas: "Sin notas", obras_sin_fotos: "Sin fotos", obras_sin_archivos: "Sin archivos",
    obras_agregar_fotos: "Agregar fotos", obras_agregar_arch: "Agregar archivo", obras_eliminar: "Eliminar obra",
    lic_titulo: "Licitaciones", lic_nueva: "Nueva licitación", lic_nombre: "Nombre", lic_monto: "Monto", lic_fecha: "Fecha", lic_sector: "Sector",
    lic_crear: "Crear licitación", lic_eliminar: "Eliminar",
    pers_titulo: "Personal de Obra", pers_nuevo: "Nuevo trabajador", pers_nombre: "Nombre", pers_rol: "Rol", pers_empresa: "Empresa",
    pers_obra: "Obra", pers_whatsapp: "WhatsApp", pers_documentacion: "Documentación", pers_sin_personal: "Sin personal registrado",
    pers_eliminar: "Eliminar trabajador", pers_agregar: "Agregar",
    carg_titulo: "Registro de Avance", carg_sub: "Fotos + Informe IA", carg_sel_obra: "Seleccioná la obra",
    carg_fotos: "Cargá fotos nuevas", carg_tomar: "Tomar foto", carg_galeria: "Galería / PC",
    carg_generar: "Comparar y generar informe", carg_analizando: "Analizando...",
    carg_informe: "Informe generado", carg_nuevo: "+ Nuevo", carg_descargar: "⬇ Descargar",
    chat_titulo: "Asistente IA", chat_placeholder: "Escribí o usá el micrófono…",
    chat_hablar: "Hablar", chat_escuchando: "Escuchando…", chat_pausar: "Pausar", chat_voz_auto: "Voz auto",
    mas_titulo: "Más opciones", mas_config: "Configuración", mas_config_sub: "Estética · Logos · Empresa · Admin",
    mas_cerrar_sesion: "Cerrar sesión",
    cfg_cuenta: "Cuenta y empresa", cfg_tema: "Tema visual", cfg_tipografia: "Tipografía",
    cfg_forma: "Forma de los elementos", cfg_logos: "Logos y textos", cfg_textos: "Textos de la app",
    cfg_guardar: "✓ Guardar y cerrar", cfg_restaurar: "↺ Restaurar tema por defecto",
};

const DEFAULT_CONFIG = { email: EMAIL_IA, empresa: "Belfast Obras", cargo: "Gerencia de Obra", telefono: "", ciudad: "Buenos Aires, Argentina", logoBelfast: "", logoAA2000: "", logoAsistente: "", logoCentral: "", tituloAsistente: "Asistente BelfastCM", subtituloAsistente: "Lee todos los datos de la app en tiempo real", themeId: "azul", colors: { ...DEFAULT_COLORS }, fontId: "jakarta", radiusId: "normal", ubicaciones: DEFAULT_UBICACIONES, labelUbicacion: "Aeropuerto", textos: { ...DEFAULT_TEXTOS } };

// ── HELPERS ───────────────────────────────────────────────────────────
function t(cfg, key) { return cfg?.textos?.[key] || DEFAULT_TEXTOS[key] || key; }
function getUbics(cfg) { return (cfg?.ubicaciones?.length ? cfg.ubicaciones : DEFAULT_UBICACIONES); }
function getLabelUbic(cfg) { return cfg?.labelUbicacion || "Aeropuerto"; }
function uid() { return Math.random().toString(36).slice(2, 9); }

function toDataUrl(f, maxW = 600) {
    return new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = e => {
            if (!f.type.startsWith('image/')) { res(e.target.result); return; }
            const img = new Image();
            img.onload = () => {
                // Siempre comprimir agresivamente para caber en localStorage
                const c = document.createElement('canvas');
                const ratio = img.width > maxW ? maxW / img.width : 1;
                c.width = Math.round(img.width * ratio);
                c.height = Math.round(img.height * ratio);
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                res(c.toDataURL('image/jpeg', 0.6)); // 60% calidad ~100KB por foto
            };
            img.onerror = () => res(e.target.result);
            img.src = e.target.result;
        };
        reader.onerror = rej;
        reader.readAsDataURL(f);
    });
}
function getBase64(d) { return d.split(',')[1]; }
function getMediaType(d) { const m = d.match(/data:([^;]+);/); return m ? m[1] : 'image/jpeg'; }

// callAI con soporte de web_search real
// useSearch=true activa búsqueda en internet (precios, proveedores, noticias, etc.)
// Streaming — llama a la IA y va actualizando el mensaje en tiempo real
async function callAIStream(msgs, sys, apiKey, onChunk) {
    try {
        const headers = {
            "Content-Type": "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
            "anthropic-version": "2023-06-01",
            "x-api-key": apiKey,
        };
        const body = { model: "claude-sonnet-4-20250514", max_tokens: 1500, stream: true, messages: msgs };
        if (sys) body.system = sys;
        const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
        if (!r.ok) { const d = await r.json(); return d.error?.message || `Error ${r.status}`; }
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let texto = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const lines = decoder.decode(value).split('\n');
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                        texto += parsed.delta.text;
                        onChunk(texto);
                    }
                } catch {}
            }
        }
        return texto;
    } catch(e) { return '⚠ Error de conexión: ' + e.message; }
}

async function callAI(msgs, sys, apiKey, useSearch = false) {
    try {
        const headers = {
            "Content-Type": "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "web-search-2025-03-05"
        };
        if (apiKey) headers["x-api-key"] = apiKey;
        else return "⚠ Para usar el asistente, ingresá tu API Key en Más → Configuración → API Key de Claude.";

        const body = {
            model: "claude-sonnet-4-20250514",
            max_tokens: useSearch ? 3000 : 1500,
            messages: msgs,
        };
        if (sys) body.system = sys;
        if (useSearch) {
            body.tools = [{ type: "web_search_20250305", name: "web_search" }];
        }

        // Primera llamada
        const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST", headers, body: JSON.stringify(body)
        });
        if (!r.ok) {
            let msg = "Error de conexión.";
            try { const d = await r.json(); msg = d.error?.message || `Error ${r.status}`; } catch { }
            return msg;
        }
        const d = await r.json();
        if (d.error) return `Error: ${d.error.message || 'Sin respuesta.'}`;

        // Si el modelo usó web_search, hay que hacer una segunda vuelta con los resultados
        if (useSearch && d.stop_reason === 'tool_use') {
            // Construir mensajes con los resultados de las herramientas
            const toolResults = d.content
                .filter(b => b.type === 'tool_use')
                .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: b.input?.query ? `Búsqueda: ${b.input.query}` : 'Búsqueda completada' }));

            if (toolResults.length > 0) {
                const msgsConResultados = [
                    ...msgs,
                    { role: 'assistant', content: d.content },
                    { role: 'user', content: toolResults }
                ];
                const r2 = await fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST", headers,
                    body: JSON.stringify({ ...body, messages: msgsConResultados })
                });
                if (r2.ok) {
                    const d2 = await r2.json();
                    const texto2 = d2.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
                    if (texto2) return texto2;
                }
            }
        }

        // Extraer todo el texto de la respuesta
        return d.content?.filter(b => b.type === 'text').map(b => b.text).join('') || 'Sin respuesta.';
    } catch (e) {
        return `Error de conexión: ${e.message || 'Verificá tu API Key en Configuración.'}`;
    }
}

function daysSince(s) { if (!s) return 999; const [d, m, y] = s.split("/"); return Math.ceil((new Date(`20${y}`, m - 1, d) - new Date()) / (1000 * 60 * 60 * 24)); }
function hexLight(hex) { try { const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16); return `#${Math.round(r * .12 + 255 * .88).toString(16).padStart(2, '0')}${Math.round(g * .12 + 255 * .88).toString(16).padStart(2, '0')}${Math.round(b * .12 + 255 * .88).toString(16).padStart(2, '0')}`; } catch { return '#EFF6FF'; } }
function buildThemeCSS(cfg) {
    const c = cfg.colors || DEFAULT_COLORS;
    const fv = FONTS.find(f => f.id === cfg.fontId)?.value || "'Plus Jakarta Sans'";
    const rv = RADIUS_OPTS.find(r => r.id === cfg.radiusId)?.r || 14;
    return `:root{--bg:${c.bg};--card:${c.card};--border:${c.border};--text:${c.text};--sub:${c.sub || '#475569'};--muted:${c.muted || '#94A3B8'};--accent:${c.accent};--al:${c.al || hexLight(c.accent)};--navy:${c.navy};--r:${rv}px;--rsm:${Math.max(4, rv - 4)}px;--font:${fv};}`;
}
function parseMontoNum(m) { if (!m) return 0; return parseInt(String(m).replace(/\./g, '').replace(/[^0-9]/g, '')) || 0; }
function formatMonto(val) {
    const nums = String(val).replace(/[^\d]/g, '');
    if (!nums) return '';
    return nums.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' $';
}
function parseMonto(val) { return String(val).replace(/[^\d]/g, ''); }

const T = { bg: "var(--bg,#F1F5F9)", card: "var(--card,#fff)", border: "var(--border,#E2E8F0)", text: "var(--text,#0F172A)", sub: "var(--sub,#475569)", muted: "var(--muted,#94A3B8)", accent: "var(--accent,#1D4ED8)", accentLight: "var(--al,#EFF6FF)", navy: "var(--navy,#0F172A)", r: "var(--r,14px)", rsm: "var(--rsm,10px)", shadow: "0 1px 3px rgba(0,0,0,.06),0 2px 8px rgba(0,0,0,.04)" };

const css = `
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700&family=Poppins:wght@400;500;600;700&family=Roboto:wght@400;500;700&family=Montserrat:wght@400;600;700;800&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--bg,#F1F5F9);overscroll-behavior:none;}
  input,textarea,select,button{font-family:var(--font,'Plus Jakarta Sans'),sans-serif;font-size:16px;}
  input,textarea,select{font-size:16px !important;}
  input:focus,textarea:focus,select:focus{outline:none;}textarea{resize:none;}button{cursor:pointer;}::-webkit-scrollbar{display:none;}
  @keyframes up{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
  @keyframes scanSweep{0%{top:-100%}100%{top:200%}}
`;

// ── COMPONENTES BASE ─────────────────────────────────────────────────
const BelfastLogo = ({ size = 44 }) => (
    <svg width={Math.round(size * 1.12)} height={size} viewBox="0 0 278 212" fill="none" stroke="#111" strokeWidth="5.5" strokeLinejoin="miter">
        <polygon points="8,84 98,84 126,54 36,54" />
        <path d="M8,84 L8,200 L98,200 L98,174 L52,174 L52,132 L98,132 L98,117 L57,117 L57,88 L98,88 L98,84 Z" />
        <line x1="98" y1="84" x2="126" y2="54" />
        <rect x="120" y="6" width="150" height="194" />
        <rect x="138" y="22" width="114" height="72" />
        <rect x="179" y="128" width="21" height="72" />
    </svg>
);
const AA2000Symbol = ({ size = 54 }) => (
    <svg width={size} height={Math.round(size * .52)} viewBox="0 0 130 68" fill="none">
        <ellipse cx="48" cy="34" rx="44" ry="20" stroke="#6b7280" strokeWidth="9" fill="none" />
        <polygon points="22,18 22,50 70,34" fill="#6b7280" />
    </svg>
);
function AppBrand({ cfg }) {
    const lb = cfg?.logoBelfast, la = cfg?.logoAA2000;
    return (
        <div style={{ background: "#fff", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "stretch", flexShrink: 0, minHeight: 72 }}>
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "8px 12px" }}>
                {lb ? <img src={lb} alt="Belfast" style={{ maxHeight: 54, maxWidth: "100%", objectFit: "contain" }} />
                    : <div style={{ display: "flex", alignItems: "center", gap: 8 }}><BelfastLogo size={46} /><div style={{ lineHeight: 1.2 }}><div style={{ fontSize: 13, fontWeight: 900, color: "#111", letterSpacing: "0.06em" }}>BELFAST</div><div style={{ fontSize: 8, fontWeight: 600, color: "#555", letterSpacing: "0.08em", textTransform: "uppercase" }}>Construction Mgmt</div></div></div>}
            </div>
            <div style={{ width: 1, background: T.border, flexShrink: 0 }} />
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "8px 12px" }}>
                {la ? <img src={la} alt="AA2000" style={{ maxHeight: 54, maxWidth: "100%", objectFit: "contain" }} />
                    : <div style={{ display: "flex", alignItems: "center", gap: 8 }}><AA2000Symbol size={58} /><div style={{ lineHeight: 1.35 }}><div style={{ fontSize: 12, color: "#6b7280", fontWeight: 400 }}>Aeropuertos</div><div style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>Argentina</div></div></div>}
            </div>
        </div>
    );
}

function Card({ children, style = {}, onClick }) { return <div onClick={onClick} style={{ background: T.card, borderRadius: T.r, border: `1px solid ${T.border}`, boxShadow: T.shadow, ...style }}>{children}</div>; }
function Badge({ color, bg, children, style = {} }) { return <span style={{ display: "inline-flex", alignItems: "center", fontSize: 10, fontWeight: 700, color, background: bg, borderRadius: 20, padding: "3px 8px", textTransform: "uppercase", letterSpacing: "0.04em", ...style }}>{children}</span>; }
function PBtn({ children, onClick, disabled, full, style = {}, variant = "primary" }) {
    const v = { primary: { background: disabled ? "#E2E8F0" : "var(--accent,#1D4ED8)", color: disabled ? "#94A3B8" : "#fff", boxShadow: disabled ? "none" : "0 2px 8px rgba(0,0,0,.18)", border: "none" }, ghost: { background: "none", border: `1.5px solid ${T.border}`, color: T.sub, boxShadow: "none" }, danger: { background: "#FEF2F2", border: "1.5px solid #FECACA", color: "#EF4444", boxShadow: "none" } };
    return <button onClick={onClick} disabled={disabled} style={{ ...v[variant], borderRadius: T.rsm, padding: "11px 20px", fontSize: 14, fontWeight: 600, width: full ? "100%" : "auto", transition: "all .15s", ...style }}>{children}</button>;
}
function Sheet({ title, onClose, children }) { return (<div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.5)", zIndex: 200, display: "flex", alignItems: "flex-end", backdropFilter: "blur(2px)" }}><div style={{ background: T.card, borderRadius: "20px 20px 0 0", width: "100%", maxHeight: "90vh", overflow: "auto", animation: "up .25s ease", paddingBottom: 32 }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px 0" }}><span style={{ fontSize: 16, fontWeight: 700, color: T.text }}>{title}</span><button onClick={onClose} style={{ background: T.bg, border: "none", borderRadius: 20, width: 32, height: 32, fontSize: 18, color: T.muted, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button></div><div style={{ padding: "14px 20px 0" }}>{children}</div></div></div>); }
function Lbl({ children }) { return <div style={{ fontSize: 11, fontWeight: 700, color: T.sub, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.05em" }}>{children}</div>; }
function TInput({ value, onChange, placeholder, type = "text", extraStyle = {} }) { return <input type={type} value={value} onChange={onChange} placeholder={placeholder} style={{ width: "100%", background: T.bg, border: `1.5px solid ${T.border}`, borderRadius: T.rsm, padding: "11px 14px", fontSize: 14, color: T.text, ...extraStyle }} />; }
function Sel({ value, onChange, children }) { return <select value={value} onChange={onChange} style={{ width: "100%", background: T.bg, border: `1.5px solid ${T.border}`, borderRadius: T.rsm, padding: "11px 14px", fontSize: 14, color: T.text }}>{children}</select>; }
function FieldRow({ children }) { return <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>{children}</div>; }
function Field({ label, children }) { return <div style={{ marginBottom: 12 }}><Lbl>{label}</Lbl>{children}</div>; }
function PlusBtn({ onClick }) { return <button onClick={onClick} style={{ background: "var(--accent,#1D4ED8)", color: "#fff", border: "none", borderRadius: 20, width: 34, height: 34, fontSize: 22, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 8px rgba(0,0,0,.2)" }}>+</button>; }
function AppHeader({ title, sub, right, back, onBack }) { return (<div style={{ background: T.card, borderBottom: `1px solid ${T.border}`, padding: "12px 18px", flexShrink: 0, position: "sticky", top: 0, zIndex: 10 }}><div style={{ display: "flex", alignItems: "center", gap: 10 }}>{back && <button onClick={onBack} style={{ background: T.bg, border: "none", borderRadius: 10, width: 32, height: 32, fontSize: 16, color: T.sub, display: "flex", alignItems: "center", justifyContent: "center" }}>←</button>}<div style={{ flex: 1 }}><div style={{ fontSize: 17, fontWeight: 700, color: T.text, lineHeight: 1.2 }}>{title}</div>{sub && <div style={{ fontSize: 11, color: T.muted, marginTop: 1 }}>{sub}</div>}</div>{right}</div></div>); }

function MontoInput({ value, onChange, placeholder }) {
    // Extraer solo el número puro desde cualquier formato
    function toNum(v) { return parseInt(String(v || '').replace(/\./g, '').replace(/[^0-9]/g, '')) || 0; }
    // Formatear con puntos de millar: 1500000 → "1.500.000"
    function fmt(n) { return n > 0 ? n.toLocaleString('es-AR', { maximumFractionDigits: 0 }) : ''; }

    const [display, setDisplay] = useState(() => fmt(toNum(value)));
    const [editing, setEditing] = useState(false);

    useEffect(() => { if (!editing) setDisplay(fmt(toNum(value))); }, [value]);

    function handleFocus() {
        // Al entrar: mostrar solo el número sin puntos para editar fácil
        setEditing(true);
        const n = toNum(display);
        setDisplay(n > 0 ? String(n) : '');
    }
    function handleChange(e) {
        const raw = e.target.value.replace(/[^0-9]/g, '');
        setDisplay(raw);
        const n = parseInt(raw) || 0;
        onChange(n > 0 ? fmt(n) : '');
    }
    function handleBlur() {
        setEditing(false);
        const n = toNum(display);
        const formatted = fmt(n);
        setDisplay(formatted);
        onChange(formatted);
    }
    return <input
        value={display}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={placeholder || '0'}
        inputMode="numeric"
        style={{ width: "100%", background: T.bg, border: `1.5px solid ${T.border}`, borderRadius: T.rsm, padding: "11px 14px", fontSize: 16, color: T.text }}
    />;
}

function LoginModal({ titulo, onSuccess, onClose }) {
    const [u, setU] = useState('');
    const [p, setP] = useState('');
    const [err, setErr] = useState('');
    const [showPass, setShowPass] = useState(false);
    function login() {
        const usuario = u.trim().toLowerCase();
        const contra = p.trim();
        if (!usuario || !contra) { setErr('Completá usuario y contraseña'); return; }
        const f = ADMIN_CREDS.find(c => c.user === usuario && c.pass === contra);
        if (f) { setErr(''); onSuccess(f); } else { setErr('Usuario o contraseña incorrectos'); }
    }
    return (<Sheet title={titulo || "Acceso requerido"} onClose={onClose}>
        <div style={{ background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: 12, padding: "12px 14px", marginBottom: 16, display: "flex", gap: 10, alignItems: "center" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#15803D"><path fillRule="evenodd" clipRule="evenodd" d="M12 1.5a5.25 5.25 0 00-5.25 5.25v3a3 3 0 00-3 3v6.75a3 3 0 003 3h10.5a3 3 0 003-3v-6.75a3 3 0 00-3-3v-3c0-2.9-2.35-5.25-5.25-5.25zm3.75 8.25v-3a3.75 3.75 0 10-7.5 0v3h7.5z" /></svg>
            <span style={{ fontSize: 12, color: "#15803D", fontWeight: 600 }}>Área protegida – Acceso administrativo</span>
        </div>
        <Field label="Usuario">
            <input value={u} onChange={e => { setU(e.target.value); setErr(''); }} placeholder="Ingresá tu usuario"
                autoCapitalize="none" autoCorrect="off" autoComplete="username"
                onKeyDown={e => e.key === 'Enter' && login()}
                style={{ width: "100%", background: T.bg, border: `1.5px solid ${err ? '#FECACA' : T.border}`, borderRadius: T.rsm, padding: "11px 14px", fontSize: 14, color: T.text }} />
        </Field>
        <Field label="Contraseña">
            <div style={{ position: "relative" }}>
                <input type={showPass ? "text" : "password"} value={p} onChange={e => { setP(e.target.value); setErr(''); }}
                    placeholder="••••••••" autoComplete="current-password"
                    onKeyDown={e => e.key === 'Enter' && login()}
                    style={{ width: "100%", background: T.bg, border: `1.5px solid ${err ? '#FECACA' : T.border}`, borderRadius: T.rsm, padding: "11px 44px 11px 14px", fontSize: 14, color: T.text }} />
                <button onClick={() => setShowPass(v => !v)} type="button"
                    style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: showPass ? "var(--accent,#1D4ED8)" : T.muted, display: "flex", alignItems: "center", padding: 4 }}>
                    {showPass
                        ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        : <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" stroke="currentColor" strokeWidth="1.5" /><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" strokeWidth="1.5" /></svg>
                    }
                </button>
            </div>
        </Field>
        {err && <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#EF4444", marginBottom: 12, fontWeight: 600 }}>{err}</div>}
        <PBtn full onClick={login}>Ingresar</PBtn>
    </Sheet>);
}

// ── NAVEGACIÓN ─────────────────────────────────────────────────────────
const NAV_DEFS = [
    { id: "chat", tk: "nav_ia", icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0112 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 01-3.476.383.39.39 0 00-.297.17l-2.755 4.133a.75.75 0 01-1.248 0l-2.755-4.133a.39.39 0 00-.297-.17 48.9 48.9 0 01-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97z" /></svg> },
    { id: "dashboard", tk: "nav_inicio", icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M11.47 3.841a.75.75 0 011.06 0l8.69 8.69a.75.75 0 101.06-1.061l-8.689-8.69a2.25 2.25 0 00-3.182 0l-8.69 8.69a.75.75 0 101.061 1.061l8.69-8.69z" /><path d="M12 5.432l8.159 8.159.091.086v6.198c0 1.035-.84 1.875-1.875 1.875H15a.75.75 0 01-.75-.75v-4.5a.75.75 0 00-.75-.75h-3a.75.75 0 00-.75.75V21a.75.75 0 01-.75.75H5.625a1.875 1.875 0 01-1.875-1.875v-6.198l.091-.086L12 5.432z" /></svg> },
    { id: "obras", tk: "nav_obras", icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M4.5 2.25a.75.75 0 000 1.5v16.5h-.75a.75.75 0 000 1.5h16.5a.75.75 0 000-1.5h-.75V3.75a.75.75 0 000-1.5h-15zM9 6a.75.75 0 000 1.5h1.5a.75.75 0 000-1.5H9zm-.75 3.75A.75.75 0 019 9h1.5a.75.75 0 010 1.5H9a.75.75 0 01-.75-.75zM9 12a.75.75 0 000 1.5h1.5a.75.75 0 000-1.5H9zm3.75-5.25A.75.75 0 0113.5 6H15a.75.75 0 010 1.5h-1.5a.75.75 0 01-.75-.75zM13.5 9a.75.75 0 000 1.5H15A.75.75 0 0015 9h-1.5zm-.75 3.75a.75.75 0 01.75-.75H15a.75.75 0 010 1.5h-1.5a.75.75 0 01-.75-.75zM9 19.5v-2.25a.75.75 0 01.75-.75h4.5a.75.75 0 01.75.75V19.5H9z" /></svg> },
    { id: "personal", tk: "nav_personal", icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M18.685 19.097A9.723 9.723 0 0021.75 12c0-5.385-4.365-9.75-9.75-9.75S2.25 6.615 2.25 12a9.723 9.723 0 003.065 7.097A9.716 9.716 0 0012 21.75a9.716 9.716 0 006.685-2.653zm-12.54-1.285A7.486 7.486 0 0112 15a7.486 7.486 0 015.855 2.812A8.224 8.224 0 0112 20.25a8.224 8.224 0 01-5.855-2.438zM15.75 9a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" /></svg> },
    { id: "mensajes", tk: "nav_mensajes", icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0112 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 01-3.476.383.39.39 0 00-.297.17l-2.755 4.133a.75.75 0 01-1.248 0l-2.755-4.133a.39.39 0 00-.297-.17 48.9 48.9 0 01-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97z" /></svg> },
    { id: "cargar", tk: "nav_cargar", icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 9a3.75 3.75 0 100 7.5A3.75 3.75 0 0012 9z" /><path fillRule="evenodd" clipRule="evenodd" d="M9.344 3.071a49.52 49.52 0 015.312 0c.967.052 1.83.585 2.332 1.39l.821 1.317c.24.383.645.643 1.11.71.386.054.77.113 1.152.177 1.432.239 2.429 1.493 2.429 2.909V18a3 3 0 01-3 3H6a3 3 0 01-3-3V9.574c0-1.416.997-2.67 2.429-2.909.382-.064.766-.123 1.151-.178a1.56 1.56 0 001.11-.71l.822-1.315a2.942 2.942 0 012.332-1.39zM6.75 12.75a5.25 5.25 0 1110.5 0 5.25 5.25 0 01-10.5 0zm12-1.5a.75.75 0 100-1.5.75.75 0 000 1.5z" /></svg> },
    { id: "mas", tk: "nav_mas", icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M4.5 12a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0zm6 0a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0zm6 0a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0z" /></svg> },
];

function BottomNav({ view, setView, alerts, cfg, unreadMsgs = 0 }) {
    return (<nav style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 480, background: T.card, borderTop: `1px solid ${T.border}`, display: "flex", padding: "6px 0 max(8px,env(safe-area-inset-bottom))", zIndex: 100, boxShadow: "0 -2px 16px rgba(0,0,0,.06)" }}>
        {NAV_DEFS.map(n => {
            const active = view === n.id;
            const badge = (n.id === "dashboard" && alerts.length > 0) || (n.id === "mensajes" && unreadMsgs > 0);
            const badgeNum = n.id === "mensajes" ? unreadMsgs : alerts.length;
            const label = t(cfg, n.tk); return (
                <button key={n.id} onClick={() => setView(n.id)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, background: "none", border: "none", color: n.id === "cargar" ? "#fff" : active ? "var(--accent,#1D4ED8)" : T.muted, padding: "4px 0", position: "relative" }}>
                    {n.id === "cargar" ? <div style={{ width: 46, height: 46, borderRadius: "50%", background: "var(--accent,#1D4ED8)", display: "flex", alignItems: "center", justifyContent: "center", marginTop: -16, boxShadow: "0 4px 14px rgba(0,0,0,.25)", border: `3px solid ${T.card}` }}>{n.icon}</div> : n.icon}
                    <span style={{ fontSize: 9, fontWeight: active ? 700 : 500, color: n.id === "cargar" ? "var(--accent,#1D4ED8)" : undefined }}>{label}</span>
                    {badge && <div style={{ position: "absolute", top: 2, right: "calc(50% - 14px)", background: "#EF4444", color: "#fff", borderRadius: 20, minWidth: badgeNum > 0 ? 16 : 8, height: badgeNum > 0 ? 16 : 8, fontSize: 9, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", border: `1.5px solid ${T.card}`, padding: badgeNum > 0 ? "0 4px" : 0 }}>{badgeNum > 0 ? badgeNum : ''}</div>}
                </button>
            );
        })}
    </nav>);
}

function Dashboard({ lics, obras, personal, alerts, setView, setDetailObraId, requireAuth, cfg, customIcons = {}, planes, setPlanes }) {
    const UBICS = getUbics(cfg);
    const [showNuevoPlan, setShowNuevoPlan] = useState(false);
    const [planDetalle, setPlanDetalle] = useState(null);
    const [formPlan, setFormPlan] = useState({ obra: '', semana: '', notas: '', dias: { lun: { activo: false, desde: '', hasta: '', tareas: '' }, mar: { activo: false, desde: '', hasta: '', tareas: '' }, mie: { activo: false, desde: '', hasta: '', tareas: '' }, jue: { activo: false, desde: '', hasta: '', tareas: '' }, vie: { activo: false, desde: '', hasta: '', tareas: '' }, sab: { activo: false, desde: '', hasta: '', tareas: '' }, dom: { activo: false, desde: '', hasta: '', tareas: '' } } });

    const DIAS = [
        { id: 'lun', label: 'Lunes' }, { id: 'mar', label: 'Martes' },
        { id: 'mie', label: 'Miércoles' }, { id: 'jue', label: 'Jueves' },
        { id: 'vie', label: 'Viernes' }, { id: 'sab', label: 'Sábado' },
        { id: 'dom', label: 'Domingo' }
    ];

    // Semana actual
    const hoy = new Date();
    const diaSemana = hoy.getDay(); // 0=dom, 1=lun...
    const diasHastaLunes = diaSemana === 0 ? 6 : diaSemana - 1;
    const lunes = new Date(hoy); lunes.setDate(hoy.getDate() - diasHastaLunes);
    const semanaActual = lunes.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });

    function crearPlan() {
        if (!formPlan.obra.trim()) return;
        const nuevo = { id: uid(), ...formPlan, fechaCreacion: new Date().toLocaleDateString('es-AR') };
        setPlanes(p => [nuevo, ...p]);
        setShowNuevoPlan(false);
        setFormPlan({ obra: '', semana: semanaActual, notas: '', dias: { lun: { activo: false, desde: '', hasta: '', tareas: '' }, mar: { activo: false, desde: '', hasta: '', tareas: '' }, mie: { activo: false, desde: '', hasta: '', tareas: '' }, jue: { activo: false, desde: '', hasta: '', tareas: '' }, vie: { activo: false, desde: '', hasta: '', tareas: '' }, sab: { activo: false, desde: '', hasta: '', tareas: '' }, dom: { activo: false, desde: '', hasta: '', tareas: '' } } });
    }

    const planActual = planDetalle ? planes.find(p => p.id === planDetalle) : null;

    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <div style={{ background: T.navy, padding: "16px 18px 20px" }}>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,.6)", marginBottom: 3 }}>{t(cfg, 'dash_subtitulo')}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#fff" }}>{t(cfg, 'dash_titulo')}</div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginTop: 4 }}>{new Date().toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" })}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginTop: 16 }}>
                {[{ l: t(cfg, 'dash_obras_activas'), v: obras.filter(o => o.estado === "curso").length, c: "#34D399" }, { l: t(cfg, 'dash_licitaciones'), v: lics.filter(l => !["adjudicada","descartada"].includes(l.estado)).length, c: "#60A5FA" }, { l: t(cfg, 'dash_alertas'), v: alerts.length, c: "#FBBF24" }, { l: t(cfg, 'dash_personal'), v: personal.length, c: "#A78BFA" }].map(k => (
                    <div key={k.l} style={{ background: "rgba(255,255,255,.08)", borderRadius: 10, padding: "10px 8px", textAlign: "center" }}>
                        <div style={{ fontSize: 22, fontWeight: 800, color: k.c }}>{k.v}</div>
                        <div style={{ fontSize: 9, color: "rgba(255,255,255,.5)", marginTop: 2, lineHeight: 1.3 }}>{k.l}</div>
                    </div>
                ))}
            </div>
        </div>
        <div style={{ padding: "14px 18px" }}>

            {/* ── PLANES SEMANALES ─────────────────────────────── */}
            <div style={{ marginBottom: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: T.sub, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        📋 Planes semanales ({planes.length})
                    </div>
                    <button onClick={() => { setFormPlan(f => ({ ...f, semana: semanaActual })); setShowNuevoPlan(true); }} style={{ background: T.accent, border: "none", borderRadius: 8, padding: "5px 12px", fontSize: 11, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
                        + Nuevo plan
                    </button>
                </div>

                {planes.length === 0 ? (
                    <button onClick={() => { setFormPlan(f => ({ ...f, semana: semanaActual })); setShowNuevoPlan(true); }} style={{ width: "100%", background: T.bg, border: `1.5px dashed ${T.border}`, borderRadius: 12, padding: "18px", textAlign: "center", cursor: "pointer" }}>
                        <div style={{ fontSize: 24, marginBottom: 6 }}>📋</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: T.sub }}>Crear primer plan semanal</div>
                        <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>Organizá el trabajo por obra, día y horario</div>
                    </button>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {planes.map(plan => {
                            const diasActivos = DIAS.filter(d => plan.dias?.[d.id]?.activo);
                            const obraObj = obras.find(o => o.id === plan.obra || o.nombre === plan.obra);
                            const isExpanded = planDetalle === plan.id;
                            return (<Card key={plan.id} style={{ padding: 0, overflow: "hidden" }}>
                                {/* Header del plan — siempre visible */}
                                <div onClick={() => setPlanDetalle(isExpanded ? null : plan.id)}
                                    style={{ padding: "13px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <div>
                                        <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{obraObj?.nombre || plan.obra}</div>
                                        <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>Semana del {plan.semana} · {diasActivos.length} días</div>
                                    </div>
                                    <div style={{ fontSize: 18, color: T.muted, transform: isExpanded ? 'rotate(180deg)' : 'none', transition: '0.2s' }}>▾</div>
                                </div>
                                {/* Barra de días — siempre visible */}
                                <div style={{ display: "flex", gap: 3, padding: "0 14px 10px" }}>
                                    {DIAS.map(d => (
                                        <div key={d.id} style={{ flex: 1, textAlign: "center" }}>
                                            <div style={{ height: 4, borderRadius: 2, background: plan.dias?.[d.id]?.activo ? T.accent : T.border, marginBottom: 3 }} />
                                            <div style={{ fontSize: 8, color: plan.dias?.[d.id]?.activo ? T.accent : T.muted, fontWeight: plan.dias?.[d.id]?.activo ? 700 : 400 }}>
                                                {d.label.slice(0, 1)}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                {/* Detalle expandido — todos los días juntos */}
                                {isExpanded && (
                                    <div style={{ borderTop: '1px solid ' + T.border, padding: "10px 14px 14px" }}>
                                        {diasActivos.map(d => {
                                            const dia = plan.dias[d.id];
                                            return (
                                                <div key={d.id} style={{ marginBottom: 14 }}>
                                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                                                        <div style={{ fontSize: 12, fontWeight: 800, color: T.accent, textTransform: "uppercase", letterSpacing: "0.05em" }}>{d.label}</div>
                                                        {dia.desde && dia.hasta && (
                                                            <div style={{ background: T.accentLight, borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 700, color: T.accent }}>
                                                                {dia.desde} — {dia.hasta}
                                                            </div>
                                                        )}
                                                    </div>
                                                    {dia.tareas ? (
                                                        <div style={{ fontSize: 12, color: T.text, lineHeight: 1.7 }}>
                                                            {dia.tareas.split('\n').map((t, i) => t.trim() && (
                                                                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 3 }}>
                                                                    <div style={{ width: 5, height: 5, borderRadius: "50%", background: T.accent, flexShrink: 0, marginTop: 6 }} />
                                                                    <span>{t.trim()}</span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    ) : (
                                                        <div style={{ fontSize: 11, color: T.muted, fontStyle: "italic" }}>Sin tareas cargadas</div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                        {plan.notas && (
                                            <div style={{ background: T.bg, borderRadius: 8, padding: "10px 12px", marginTop: 8 }}>
                                                <div style={{ fontSize: 10, fontWeight: 700, color: T.sub, marginBottom: 4, textTransform: "uppercase" }}>Notas</div>
                                                <div style={{ fontSize: 12, color: T.text, lineHeight: 1.6 }}>{plan.notas}</div>
                                            </div>
                                        )}
                                        <button onClick={() => { setPlanes(p => p.filter(x => x.id !== plan.id)); setPlanDetalle(null); }}
                                            style={{ marginTop: 10, background: "none", border: "none", fontSize: 11, color: "#EF4444", cursor: "pointer", padding: 0 }}>
                                            Eliminar plan
                                        </button>
                                    </div>
                                )}
                            </Card>);
                        })}
                    </div>
                )}
            </div>

            {/* Alertas */}
            {alerts.length > 0 && (<div style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: T.sub, textTransform: "uppercase", letterSpacing: "0.05em" }}>Alertas ({alerts.length})</div>
                    <button onClick={() => setView("seguimiento")} style={{ fontSize: 12, color: T.accent, background: "none", border: "none", fontWeight: 600, cursor: "pointer" }}>Ver todas →</button>
                </div>
                {alerts.filter(a => a.prioridad === 'alta').slice(0, 3).map(a => (
                    <div key={a.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 10, padding: "10px 12px", marginBottom: 6 }}>
                        <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#EF4444", flexShrink: 0, marginTop: 4 }} />
                        <div style={{ fontSize: 12, color: T.text, lineHeight: 1.5, flex: 1 }}>{a.msg}</div>
                    </div>
                ))}
            </div>)}
            {alerts.length === 0 && (
                <div style={{ background: "#ECFDF5", border: "1px solid #86EFAC", borderRadius: 10, padding: "12px 14px", marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#10B981", flexShrink: 0 }} />
                    <div style={{ fontSize: 12, color: "#15803D", fontWeight: 600 }}>✓ Todo en orden — sin alertas activas</div>
                </div>
            )}

            {/* Obras en curso */}
            <div style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: T.sub, textTransform: "uppercase", letterSpacing: "0.05em" }}>{t(cfg, 'dash_obras_curso')}</div>
                    <button onClick={() => setView("obras")} style={{ fontSize: 12, color: T.accent, background: "none", border: "none", fontWeight: 600 }}>{t(cfg, 'dash_ver_todas')}</button>
                </div>
                {obras.filter(o => o.estado === "curso").map(o => (<Card key={o.id} onClick={() => { setDetailObraId(o.id); setView("obras"); }} style={{ padding: "12px 14px", marginBottom: 8, cursor: "pointer" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><div style={{ fontSize: 13, fontWeight: 600, color: T.text, flex: 1, paddingRight: 8 }}>{o.nombre}</div><Badge color="#10B981" bg="#ECFDF5">{o.avance}%</Badge></div>
                    <div style={{ height: 4, background: T.bg, borderRadius: 4, marginBottom: 6 }}><div style={{ height: 4, background: T.accent, borderRadius: 4, width: `${o.avance}%` }} /></div>
                    <div style={{ fontSize: 11, color: T.muted }}>{UBICS.find(a => a.id === o.ap)?.code || o.ap} · {t(cfg, 'obras_cierre')}: {o.cierre}</div>
                </Card>))}
            </div>
        </div>

        {/* Sheet nuevo plan */}
        {showNuevoPlan && (<Sheet title="Nuevo plan semanal" onClose={() => setShowNuevoPlan(false)}>
            <Field label="Obra">
                <Sel value={formPlan.obra} onChange={e => setFormPlan(f => ({ ...f, obra: e.target.value }))}>
                    <option value="">Seleccionar obra...</option>
                    {obras.map(o => <option key={o.id} value={o.nombre}>{o.nombre}</option>)}
                    <option value="__otro">Otra / Proyecto nuevo</option>
                </Sel>
            </Field>
            {formPlan.obra === '__otro' && (
                <Field label="Nombre de la obra/proyecto">
                    <TInput value={formPlan.obraCustom || ''} onChange={e => setFormPlan(f => ({ ...f, obraCustom: e.target.value, obra: e.target.value }))} placeholder="Ej: Refacción Suipacha 1234" />
                </Field>
            )}
            <Field label="Semana (lunes de inicio)">
                <TInput value={formPlan.semana} onChange={e => setFormPlan(f => ({ ...f, semana: e.target.value }))} placeholder="dd/mm/aaaa" />
            </Field>

            <div style={{ marginBottom: 14 }}>
                <Lbl>Horarios y tareas por día</Lbl>
                {DIAS.map(d => (<div key={d.id} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: formPlan.dias[d.id]?.activo ? 8 : 0 }}>
                        <button onClick={() => setFormPlan(f => ({ ...f, dias: { ...f.dias, [d.id]: { ...f.dias[d.id], activo: !f.dias[d.id]?.activo } } }))}
                            style={{ width: 22, height: 22, borderRadius: 6, border: `2px solid ${formPlan.dias[d.id]?.activo ? T.accent : T.border}`, background: formPlan.dias[d.id]?.activo ? T.accent : "transparent", cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                            {formPlan.dias[d.id]?.activo && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M4.5 12.75l6 6 9-13.5" /></svg>}
                        </button>
                        <span style={{ fontSize: 13, fontWeight: 600, color: formPlan.dias[d.id]?.activo ? T.text : T.muted }}>{d.label}</span>
                        {formPlan.dias[d.id]?.activo && (
                            <div style={{ display: "flex", gap: 6, flex: 1 }}>
                                <input type="time" value={formPlan.dias[d.id]?.desde || ''} onChange={e => setFormPlan(f => ({ ...f, dias: { ...f.dias, [d.id]: { ...f.dias[d.id], desde: e.target.value } } }))} style={{ flex: 1, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "5px 8px", fontSize: 12, color: T.text }} />
                                <span style={{ color: T.muted, fontSize: 12, alignSelf: "center" }}>a</span>
                                <input type="time" value={formPlan.dias[d.id]?.hasta || ''} onChange={e => setFormPlan(f => ({ ...f, dias: { ...f.dias, [d.id]: { ...f.dias[d.id], hasta: e.target.value } } }))} style={{ flex: 1, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "5px 8px", fontSize: 12, color: T.text }} />
                            </div>
                        )}
                    </div>
                    {formPlan.dias[d.id]?.activo && (
                        <textarea value={formPlan.dias[d.id]?.tareas || ''} onChange={e => setFormPlan(f => ({ ...f, dias: { ...f.dias, [d.id]: { ...f.dias[d.id], tareas: e.target.value } } }))}
                            placeholder="Tareas del día (una por línea)..."
                            rows={2} style={{ width: "100%", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 10px", fontSize: 12, color: T.text, resize: "none", marginLeft: 32 }} />
                    )}
                </div>))}
            </div>
            <Field label="Notas generales">
                <textarea value={formPlan.notas} onChange={e => setFormPlan(f => ({ ...f, notas: e.target.value }))} placeholder="Observaciones, materiales necesarios, etc." rows={2} style={{ width: "100%", background: T.bg, border: `1.5px solid ${T.border}`, borderRadius: T.rsm, padding: "8px 12px", fontSize: 13, color: T.text, resize: "none" }} />
            </Field>
            <PBtn full onClick={crearPlan} disabled={!formPlan.obra.trim()}>Crear plan semanal</PBtn>
        </Sheet>)}

        {/* Detalle del plan */}
    </div>);
}

// DocMultiGrid: múltiples archivos por categoría (planos, pliegos, excel, otros)
function DocMultiGrid({ docs, onUpload, onRemove, refs, prefix }) {
    // docs es ahora un objeto { planos: [{id,nombre,url},...], pliego: [...], ... }
    return (<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {LIC_DOC_TYPES.map(d => {
            const lista = Array.isArray(docs?.[d.id]) ? docs[d.id] : docs?.[d.id] ? [docs[d.id]] : [];
            const rk = `${prefix}_${d.id}`;
            return (<div key={d.id}>
                <input type="file" accept={d.accept} multiple style={{ display: "none" }} ref={el => refs.current[rk] = el}
                    onChange={async e => {
                        for (const f of Array.from(e.target.files)) { await onUpload(d.id, f); }
                        e.target.value = "";
                    }} />
                {/* Header de categoría + botón agregar */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#10B981" }} />
                        <span style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{d.label}</span>
                        {lista.length > 0 && <span style={{ fontSize: 10, color: T.muted }}>({lista.length})</span>}
                    </div>
                    <button onClick={() => refs.current[rk]?.click()} style={{ background: T.accentLight, border: `1px solid ${T.border}`, borderRadius: 8, padding: "4px 10px", fontSize: 11, fontWeight: 700, color: T.accent, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontSize: 14, lineHeight: 1 }}>+</span> Agregar
                    </button>
                </div>
                {/* Lista de archivos */}
                {lista.length === 0 ? (
                    <button onClick={() => refs.current[rk]?.click()} style={{ width: "100%", background: T.bg, border: `1.5px dashed ${T.border}`, borderRadius: 10, padding: "10px", cursor: "pointer", textAlign: "center", color: T.muted, fontSize: 11 }}>
                        Sin archivos — tocá para subir
                    </button>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        {lista.map((f, i) => (
                            <div key={f.id || i} style={{ display: "flex", alignItems: "center", gap: 8, background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: 9, padding: "8px 10px" }}>
                                <div style={{ width: 28, height: 28, borderRadius: 6, background: "#ECFDF5", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                                    <span style={{ fontSize: 8, fontWeight: 800, color: "#15803D" }}>{(f.nombre || '').split('.').pop().toUpperCase().slice(0,4)}</span>
                                </div>
                                <span style={{ flex: 1, fontSize: 11, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.nombre}</span>
                                <a href={f.url} download={f.nombre} style={{ textDecoration: "none", flexShrink: 0 }}>
                                    <button style={{ background: "none", border: "1px solid #86EFAC", borderRadius: 6, padding: "4px 8px", fontSize: 10, color: "#15803D", fontWeight: 600, cursor: "pointer" }}>↓</button>
                                </a>
                                <button onClick={() => onRemove(d.id, f.id || i)} style={{ background: "none", border: "1px solid #FCA5A5", borderRadius: 6, padding: "4px 7px", fontSize: 10, color: "#EF4444", cursor: "pointer", flexShrink: 0 }}>✕</button>
                            </div>
                        ))}
                    </div>
                )}
            </div>);
        })}
    </div>);
}

// Mantener DocGrid viejo para compatibilidad con otros módulos que lo usen
function DocGrid({ docs, onUpload, onRemove, refs, prefix }) {
    return (<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>{LIC_DOC_TYPES.map(d => {
        const doc = docs?.[d.id]; const rk = `${prefix}_${d.id}`; return (<div key={d.id}><input type="file" accept={d.accept} style={{ display: "none" }} ref={el => refs.current[rk] = el} onChange={async e => { if (e.target.files[0]) await onUpload(d.id, e.target.files[0]); e.target.value = ""; }} />
            {doc ? (<div style={{ background: "#F0FDF4", border: "1.5px solid #86EFAC", borderRadius: 10, padding: "9px 10px" }}><div style={{ fontSize: 10, fontWeight: 700, color: "#15803D", marginBottom: 2 }}>{d.label}</div><div style={{ fontSize: 10, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 5 }}>{doc.nombre}</div><div style={{ display: "flex", gap: 4 }}><a href={doc.url} download={doc.nombre} style={{ textDecoration: "none", flex: 1 }}><button style={{ width: "100%", background: "none", border: "1px solid #86EFAC", borderRadius: 6, padding: "4px 0", fontSize: 9, color: "#15803D", fontWeight: 600, cursor: "pointer" }}>↓ Ver</button></a><button onClick={() => onRemove(d.id)} style={{ background: "none", border: "1px solid #FCA5A5", borderRadius: 6, padding: "4px 7px", fontSize: 9, color: "#EF4444", cursor: "pointer" }}>✕</button></div></div>
            ) : (<button onClick={() => refs.current[rk]?.click()} style={{ width: "100%", background: T.bg, border: "1.5px dashed #86EFAC", borderRadius: 10, padding: "10px 6px", cursor: "pointer", textAlign: "center" }}><div style={{ fontSize: 10, fontWeight: 700, color: "#15803D", marginBottom: 2 }}>{d.label.slice(0, 3).toUpperCase()}</div><div style={{ fontSize: 11, fontWeight: 600, color: T.sub }}>{d.label}</div><div style={{ fontSize: 9, color: T.muted, marginTop: 2 }}>Subir</div></button>)}</div>);
    })}</div>);
}

// ── LICITACIONES ─────────────────────────────────────────────────────
function Licitaciones({ lics, setLics, requireAuth, cfg, obras, setObras }) {
    const SP = localStorage.getItem('bop_auth_empresa') === 'vv' ? 'vv_' : 'bcm_';
    const UBICS = getUbics(cfg);
    const [ap, setAp] = useState("todos");
    const [showNew, setShowNew] = useState(false);
    const [showDetail, setShowDetail] = useState(null);
    const [form, setForm] = useState({ nombre: "", ap: "", estado: "visitar", monto: "", fecha: "", sector: "", docs: {} });
    const docRefs = useRef({}); const newDocRefs = useRef({});
    const filtered = lics.filter(l => ap === "todos" || l.ap === ap);

    // Asegurar que form.ap tenga un valor válido cuando cambien las UBICS
    useEffect(() => {
        if (!form.ap && UBICS.length > 0) setForm(f => ({ ...f, ap: UBICS[0].id }));
    }, [UBICS.length]);

    function autoCrearObra(lic) {
        const yaExiste = obras.some(o => o.lic_id === lic.id);
        if (yaExiste) return;
        const nuevaObra = {
            id: uid(), lic_id: lic.id, nombre: lic.nombre, ap: lic.ap, sector: lic.sector || "",
            estado: "curso", avance: 0, inicio: new Date().toLocaleDateString("es-AR"), cierre: "",
            obs: [{ id: uid(), txt: `Obra creada automáticamente al adjudicar la licitación.`, fecha: new Date().toLocaleDateString("es-AR") }],
            fotos: [], archivos: [], informes: [], docs: {},
        };
        setObras(p => [...p, nuevaObra]);
    }

    function cambiarEstado(licId, nuevoEstado) {
        setLics(p => p.map(l => {
            if (l.id !== licId) return l;
            if ((nuevoEstado === "adjudicada" || nuevoEstado === "curso") && l.estado !== nuevoEstado) autoCrearObra({ ...l, estado: nuevoEstado });
            return { ...l, estado: nuevoEstado };
        }));
    }
    function add() {
        if (!form.nombre.trim()) return;
        const apFinal = form.ap || UBICS[0]?.id || 'aep';
        setLics(p => [...p, { ...form, ap: apFinal, id: uid() }]);
        setForm({ nombre: "", ap: UBICS[0]?.id || '', estado: "visitar", monto: "", fecha: "", sector: "", docs: {} });
        setShowNew(false);
    }
    function del(id) { setLics(p => p.filter(l => l.id !== id)); setShowDetail(null); }
    // handleDoc: agrega un archivo a la lista de esa categoría (no reemplaza)
    async function handleDoc(licId, did, file) {
        const url = await toDataUrl(file);
        const nuevo = { id: uid(), nombre: file.name, url };
        setLics(p => p.map(l => {
            if (l.id !== licId) return l;
            const docsActuales = l.docs || {};
            const listaActual = Array.isArray(docsActuales[did]) ? docsActuales[did] : docsActuales[did] ? [docsActuales[did]] : [];
            return { ...l, docs: { ...docsActuales, [did]: [...listaActual, nuevo] } };
        }));
    }
    async function handleNewDoc(did, file) {
        const url = await toDataUrl(file);
        const nuevo = { id: uid(), nombre: file.name, url };
        setForm(f => {
            const listaActual = Array.isArray(f.docs?.[did]) ? f.docs[did] : f.docs?.[did] ? [f.docs[did]] : [];
            return { ...f, docs: { ...f.docs, [did]: [...listaActual, nuevo] } };
        });
    }
    function removeDoc(licId, did, fileId) {
        setLics(p => p.map(l => {
            if (l.id !== licId) return l;
            const docsActuales = l.docs || {};
            const lista = Array.isArray(docsActuales[did]) ? docsActuales[did] : docsActuales[did] ? [docsActuales[did]] : [];
            return { ...l, docs: { ...docsActuales, [did]: lista.filter((f, i) => (f.id || i) !== fileId) } };
        }));
    }
    function removeNewDoc(did, fileId) {
        setForm(f => {
            const lista = Array.isArray(f.docs?.[did]) ? f.docs[did] : f.docs?.[did] ? [f.docs[did]] : [];
            return { ...f, docs: { ...f.docs, [did]: lista.filter((x, i) => (x.id || i) !== fileId) } };
        });
    }
    const detail = showDetail ? lics.find(l => l.id === showDetail) : null;

    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title={t(cfg, 'lic_titulo')} sub={`${filtered.length} registros`} right={<PlusBtn onClick={() => requireAuth(() => setShowNew(true), t(cfg, 'lic_nueva'))} />} />
        {/* Filtros por ubicación — usa UBICS configuradas */}
        <div style={{ padding: "10px 18px", display: "flex", gap: 6, overflowX: "auto" }}>
            {[{ id: "todos", label: "Todos" }, ...UBICS.map(a => ({ id: a.id, label: a.code }))].map(f => (
                <button key={f.id} onClick={() => setAp(f.id)} style={{ flexShrink: 0, padding: "6px 14px", borderRadius: 20, border: `1.5px solid ${ap === f.id ? "var(--accent,#1D4ED8)" : T.border}`, background: ap === f.id ? T.accentLight : T.card, color: ap === f.id ? T.accent : T.sub, fontSize: 12, fontWeight: 600 }}>{f.label}</button>
            ))}
        </div>
        <div style={{ padding: "0 18px" }}>
            {LIC_ESTADOS.map(est => {
                const items = filtered.filter(l => l.estado === est.id);
                if (!items.length) return null;
                return (<div key={est.id} style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}><div style={{ width: 7, height: 7, borderRadius: "50%", background: est.color }} /><span style={{ fontSize: 11, fontWeight: 700, color: est.color, textTransform: "uppercase", letterSpacing: "0.06em" }}>{est.label}</span><span style={{ fontSize: 11, color: T.muted }}>({items.length})</span></div>
                    {items.map(lic => {
                        const obraVinc = obras.find(o => o.lic_id === lic.id);
                        const ubicLabel = UBICS.find(a => a.id === lic.ap)?.code || lic.ap || '—';
                        return (<Card key={lic.id} onClick={() => setShowDetail(lic.id)} style={{ padding: "13px 14px", marginBottom: 7, cursor: "pointer" }}>
                            <div style={{ display: "flex", justifyContent: "space-between" }}>
                                <div style={{ flex: 1, paddingRight: 8 }}>
                                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 3, display: "flex", alignItems: "center", gap: 6 }}>{lic.nombre}{obraVinc && <span style={{ fontSize: 9, fontWeight: 700, background: "#ECFDF5", color: "#10B981", border: "1px solid #86EFAC", borderRadius: 20, padding: "1px 6px" }}>🏗 EN OBRA</span>}</div>
                                    <div style={{ fontSize: 11, color: T.muted }}>{ubicLabel}{lic.sector ? ` · ${lic.sector}` : ""}</div>
                                </div>
                                <div style={{ textAlign: "right", flexShrink: 0 }}>
                                    <div style={{ fontSize: 12, fontWeight: 700, color: T.accent }}>{lic.monto}</div>
                                    <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>{lic.fecha}</div>
                                </div>
                            </div>
                        </Card>);
                    })}
                </div>);
            })}
            {/* Licitaciones con estado inválido o sin estado */}
            {(() => {
                const estadosValidos = LIC_ESTADOS.map(e => e.id);
                const sinEstado = filtered.filter(l => !estadosValidos.includes(l.estado));
                if (!sinEstado.length) return null;
                return (<div style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                        <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#94A3B8" }} />
                        <span style={{ fontSize: 11, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.06em" }}>Sin estado</span>
                        <span style={{ fontSize: 11, color: T.muted }}>({sinEstado.length})</span>
                    </div>
                    {sinEstado.map(lic => (
                        <Card key={lic.id} onClick={() => setShowDetail(lic.id)} style={{ padding: "13px 14px", marginBottom: 7, cursor: "pointer" }}>
                            <div style={{ display: "flex", justifyContent: "space-between" }}>
                                <div style={{ flex: 1, paddingRight: 8 }}>
                                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{lic.nombre}</div>
                                    <div style={{ fontSize: 11, color: T.muted }}>{lic.ap || "—"}{lic.sector ? " · " + lic.sector : ""}</div>
                                </div>
                                <div style={{ textAlign: "right", flexShrink: 0 }}>
                                    <div style={{ fontSize: 12, fontWeight: 700, color: T.accent }}>{lic.monto}</div>
                                    <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>{lic.fecha}</div>
                                </div>
                            </div>
                        </Card>
                    ))}
                </div>);
            })()}
        </div>
        {showNew && (<Sheet title="Nueva licitación" onClose={() => setShowNew(false)}>
            <Field label="Nombre"><TInput value={form.nombre} onChange={e => setForm(p => ({ ...p, nombre: e.target.value }))} placeholder="Ej: Refacción Terminal B" /></Field>
            <FieldRow>
                <Field label={getLabelUbic(cfg)}>
                    <Sel value={form.ap || UBICS[0]?.id || ''} onChange={e => setForm(p => ({ ...p, ap: e.target.value }))}>
                        {UBICS.map(a => <option key={a.id} value={a.id}>{a.code} – {a.name}</option>)}
                    </Sel>
                </Field>
                <Field label="Estado"><Sel value={form.estado} onChange={e => setForm(p => ({ ...p, estado: e.target.value }))}>{LIC_ESTADOS.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</Sel></Field>
            </FieldRow>
            <FieldRow>
                <Field label="Monto"><MontoInput value={form.monto} onChange={v => setForm(p => ({ ...p, monto: v }))} placeholder="0 $" /></Field>
                <Field label="Sector"><TInput value={form.sector} onChange={e => setForm(p => ({ ...p, sector: e.target.value }))} placeholder="Terminal A" /></Field>
            </FieldRow>
            <Field label="Fecha"><TInput value={form.fecha} onChange={e => setForm(p => ({ ...p, fecha: e.target.value }))} placeholder="dd/mm/aa" /></Field>
            <div style={{ marginBottom: 14 }}><Lbl>Documentos</Lbl><DocMultiGrid docs={form.docs} onUpload={handleNewDoc} onRemove={(did, fileId) => removeNewDoc(did, fileId)} refs={newDocRefs} prefix="new" /></div>
            <PBtn full onClick={add} disabled={!form.nombre.trim()}>Crear licitación</PBtn>
        </Sheet>)}
        {detail && (<Sheet title={detail.nombre} onClose={() => setShowDetail(null)}>
            <Field label="Nombre"><TInput value={detail.nombre} onChange={e => { const nuevoNombre = e.target.value; setLics(p => p.map(l => l.id === detail.id ? { ...l, nombre: nuevoNombre } : l)); setObras(p => p.map(o => o.lic_id === detail.id ? { ...o, nombre: nuevoNombre } : o)); }} placeholder="Nombre de la licitación" /></Field>
            <FieldRow>
                <Field label={getLabelUbic(cfg)}>
                    <Sel value={detail.ap} onChange={e => setLics(p => p.map(l => l.id === detail.id ? { ...l, ap: e.target.value } : l))}>
                        {UBICS.map(a => <option key={a.id} value={a.id}>{a.code} – {a.name}</option>)}
                    </Sel>
                </Field>
                <Field label="Monto"><MontoInput value={detail.monto || ''} onChange={v => setLics(p => p.map(l => l.id === detail.id ? { ...l, monto: v } : l))} placeholder="0 $" /></Field>
            </FieldRow>
            <FieldRow>
                <Field label="Sector"><TInput value={detail.sector || ''} onChange={e => setLics(p => p.map(l => l.id === detail.id ? { ...l, sector: e.target.value } : l))} placeholder="Terminal A" /></Field>
                <Field label="Fecha"><TInput value={detail.fecha || ''} onChange={e => setLics(p => p.map(l => l.id === detail.id ? { ...l, fecha: e.target.value } : l))} placeholder="dd/mm/aa" /></Field>
            </FieldRow>
            <div style={{ marginBottom: 16 }}><Lbl>Documentos</Lbl><DocMultiGrid docs={detail.docs || {}} onUpload={(did, file) => handleDoc(detail.id, did, file)} onRemove={(did, fileId) => removeDoc(detail.id, did, fileId)} refs={docRefs} prefix={`det_${detail.id}`} /></div>
            <Field label="Estado">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                    {LIC_ESTADOS.map(e => (<button key={e.id} onClick={() => cambiarEstado(detail.id, e.id)} style={{ padding: "7px 4px", borderRadius: T.rsm, border: `1.5px solid ${detail.estado === e.id ? e.color : T.border}`, background: detail.estado === e.id ? e.bg : T.card, color: e.color, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>{e.label}</button>))}
                </div>
            </Field>
            {(detail.estado === "adjudicada" || detail.estado === "curso") && (() => {
                const obraVinc = obras.find(o => o.lic_id === detail.id);
                return obraVinc ? (
                    <div style={{ background: "#ECFDF5", border: "1px solid #86EFAC", borderRadius: 10, padding: "10px 14px", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="#10B981"><path fillRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm13.36-1.814a.75.75 0 10-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.14-.094l3.75-5.25z" clipRule="evenodd" /></svg>
                        <div style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 700, color: "#15803D" }}>✅ Obra creada automáticamente</div><div style={{ fontSize: 11, color: "#166534", marginTop: 1 }}>{obraVinc.nombre} — En Curso ({obraVinc.avance}%)</div></div>
                    </div>
                ) : (
                    <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "10px 14px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <div style={{ fontSize: 12, color: "#92400E", fontWeight: 600 }}>⚠ Sin obra vinculada</div>
                        <button onClick={() => autoCrearObra(detail)} style={{ background: "#F59E0B", border: "none", borderRadius: 8, padding: "5px 12px", fontSize: 11, fontWeight: 700, color: "#fff", cursor: "pointer" }}>Crear obra ahora</button>
                    </div>
                );
            })()}

            {/* ── REGISTRO FOTOGRÁFICO DE VISITAS ────────────────────── */}
            <RegistroVisitas
                licId={detail.id}
                visitas={detail.visitas || []}
                onUpdate={nuevasVisitas => {
                    const key = `${SP}lic_vis_${detail.id}`;
                    const json = JSON.stringify(nuevasVisitas);
                    try {
                        localStorage.setItem(key, json);
                    } catch {
                        // Si falla por tamaño, guardar solo las últimas 5 visitas
                        try { localStorage.setItem(key, JSON.stringify(nuevasVisitas.slice(-5))); } catch { }
                    }
                    storage.set(key, json).catch(() => { });
                    setLics(p => p.map(l => l.id === detail.id ? { ...l, visitas: nuevasVisitas } : l));
                }}
            />

            <PBtn full variant="danger" onClick={() => { if (window.confirm(`¿Eliminar "${detail.nombre}"? Esta acción no se puede deshacer.`)) del(detail.id); }} style={{ marginTop: 8 }}>Eliminar licitación</PBtn>
        </Sheet>)}
    </div>);
}

// ── REGISTRO FOTOGRÁFICO DE VISITAS (usado en Licitaciones) ──────────
const ETAPAS_VISITA = [
    { id: 'antes', label: 'Antes', color: '#F59E0B', bg: '#FFFBEB' },
    { id: 'durante', label: 'Durante', color: '#3B82F6', bg: '#EFF6FF' },
    { id: 'despues', label: 'Después', color: '#10B981', bg: '#ECFDF5' },
];

function RegistroVisitas({ visitas, onUpdate, licId }) {
    const camRef = useRef(null);
    const galRef = useRef(null);
    const [nuevaDesc, setNuevaDesc] = useState('');
    const [nuevaEtapa, setNuevaEtapa] = useState('antes');
    const [cargando, setCargando] = useState(false);
    const [vistaFoto, setVistaFoto] = useState(null);
    const [filtroEtapa, setFiltroEtapa] = useState('todas');

    async function subirFotos(e) {
        const files = Array.from(e.target.files);
        if (!files.length) return;
        setCargando(true);
        const nuevas = await Promise.all(files.map(async f => {
            const dataUrl = await toDataUrl(f);
            const fotoId = uid();
            // Subir al bucket Supabase Storage
            const url = await uploadFoto(dataUrl, `licitaciones/${licId || 'general'}`, fotoId);
            return {
                id: fotoId,
                url,
                nombre: f.name,
                desc: nuevaDesc.trim(),
                etapa: nuevaEtapa,
                fecha: new Date().toLocaleDateString('es-AR'),
                hora: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
            };
        }));
        onUpdate([...visitas, ...nuevas]);
        setNuevaDesc('');
        setCargando(false);
        e.target.value = '';
    }

    function editarDesc(id, desc) {
        onUpdate(visitas.map(v => v.id === id ? { ...v, desc } : v));
    }
    function cambiarEtapa(id, etapa) {
        onUpdate(visitas.map(v => v.id === id ? { ...v, etapa } : v));
    }
    function eliminar(id) {
        onUpdate(visitas.filter(v => v.id !== id));
    }

    const filtradas = filtroEtapa === 'todas' ? visitas : visitas.filter(v => v.etapa === filtroEtapa);
    const contPorEtapa = etapa => visitas.filter(v => v.etapa === etapa).length;

    return (<div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <Lbl>Registro fotográfico de visitas ({visitas.length})</Lbl>
        </div>

        {/* Selector de etapa + descripción + botones de subida */}
        <div style={{ background: T.bg, borderRadius: T.rsm, padding: "12px", marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 5, marginBottom: 8 }}>
                {ETAPAS_VISITA.map(et => (
                    <button key={et.id} onClick={() => setNuevaEtapa(et.id)}
                        style={{ flex: 1, padding: "7px 4px", borderRadius: T.rsm, border: `1.5px solid ${nuevaEtapa === et.id ? et.color : T.border}`, background: nuevaEtapa === et.id ? et.bg : T.card, color: et.color, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                        {et.label}
                    </button>
                ))}
            </div>
            <textarea
                value={nuevaDesc}
                onChange={e => setNuevaDesc(e.target.value)}
                placeholder="Descripción de la visita (opcional)..."
                rows={2}
                style={{ width: "100%", background: T.card, border: `1.5px solid ${T.border}`, borderRadius: T.rsm, padding: "8px 12px", fontSize: 12, color: T.text, marginBottom: 8, resize: "none" }}
            />
            <input ref={camRef} type="file" accept="image/*" capture="environment" multiple onChange={subirFotos} style={{ display: "none" }} />
            <input ref={galRef} type="file" accept="image/*" multiple onChange={subirFotos} style={{ display: "none" }} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <button onClick={() => camRef.current?.click()} disabled={cargando}
                    style={{ background: T.navy, border: "none", borderRadius: T.rsm, padding: "10px", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 9a3.75 3.75 0 100 7.5A3.75 3.75 0 0012 9z" /><path fillRule="evenodd" d="M9.344 3.071a49.52 49.52 0 015.312 0c.967.052 1.83.585 2.332 1.39l.821 1.317c.24.383.645.643 1.11.71.386.054.77.113 1.152.177 1.432.239 2.429 1.493 2.429 2.909V18a3 3 0 01-3 3H6a3 3 0 01-3-3V9.574c0-1.416.997-2.67 2.429-2.909.382-.064.766-.123 1.151-.178a1.56 1.56 0 001.11-.71l.822-1.315a2.942 2.942 0 012.332-1.39zM6.75 12.75a5.25 5.25 0 1110.5 0 5.25 5.25 0 01-10.5 0z" clipRule="evenodd" /></svg>
                    {cargando ? 'Subiendo...' : 'Tomar foto'}
                </button>
                <button onClick={() => galRef.current?.click()} disabled={cargando}
                    style={{ background: T.card, border: `1.5px solid ${T.border}`, borderRadius: T.rsm, padding: "10px", color: T.text, fontSize: 12, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" d="M1.5 6a2.25 2.25 0 012.25-2.25h16.5A2.25 2.25 0 0122.5 6v12a2.25 2.25 0 01-2.25 2.25H3.75A2.25 2.25 0 011.5 18V6zM3 16.06V18c0 .414.336.75.75.75h16.5A.75.75 0 0021 18v-1.94l-2.69-2.689a1.5 1.5 0 00-2.12 0l-.88.879.97.97a.75.75 0 11-1.06 1.06l-5.16-5.159a1.5 1.5 0 00-2.12 0L3 16.061zm10.125-7.81a1.125 1.125 0 112.25 0 1.125 1.125 0 01-2.25 0z" clipRule="evenodd" /></svg>
                    Galería / PC
                </button>
            </div>
        </div>

        {/* Filtros por etapa */}
        {visitas.length > 0 && (<div style={{ display: "flex", gap: 5, marginBottom: 10, overflowX: "auto" }}>
            <button onClick={() => setFiltroEtapa('todas')} style={{ flexShrink: 0, padding: "5px 12px", borderRadius: 20, border: `1.5px solid ${filtroEtapa === 'todas' ? T.accent : T.border}`, background: filtroEtapa === 'todas' ? T.accentLight : T.card, color: filtroEtapa === 'todas' ? T.accent : T.sub, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                Todas ({visitas.length})
            </button>
            {ETAPAS_VISITA.map(et => (
                <button key={et.id} onClick={() => setFiltroEtapa(et.id)} style={{ flexShrink: 0, padding: "5px 12px", borderRadius: 20, border: `1.5px solid ${filtroEtapa === et.id ? et.color : T.border}`, background: filtroEtapa === et.id ? et.bg : T.card, color: et.color, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                    {et.label} ({contPorEtapa(et.id)})
                </button>
            ))}
        </div>)}

        {/* Comparación Antes/Después si hay fotos de ambas etapas */}
        {visitas.some(v => v.etapa === 'antes') && visitas.some(v => v.etapa === 'despues') && filtroEtapa === 'todas' && (<div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.sub, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Comparación antes / después</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#F59E0B", marginBottom: 4, textAlign: "center", textTransform: "uppercase" }}>Antes</div>
                    {visitas.filter(v => v.etapa === 'antes').slice(-1).map(f => (
                        <div key={f.id} onClick={() => setVistaFoto(f)} style={{ cursor: "pointer" }}>
                            <img src={f.url} alt="" style={{ width: "100%", aspectRatio: "4/3", objectFit: "cover", borderRadius: 10, border: "2px solid #F59E0B" }} />
                            <div style={{ fontSize: 9, color: T.muted, marginTop: 3, textAlign: "center" }}>{f.fecha} {f.hora}</div>
                        </div>
                    ))}
                </div>
                <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#10B981", marginBottom: 4, textAlign: "center", textTransform: "uppercase" }}>Después</div>
                    {visitas.filter(v => v.etapa === 'despues').slice(-1).map(f => (
                        <div key={f.id} onClick={() => setVistaFoto(f)} style={{ cursor: "pointer" }}>
                            <img src={f.url} alt="" style={{ width: "100%", aspectRatio: "4/3", objectFit: "cover", borderRadius: 10, border: "2px solid #10B981" }} />
                            <div style={{ fontSize: 9, color: T.muted, marginTop: 3, textAlign: "center" }}>{f.fecha} {f.hora}</div>
                        </div>
                    ))}
                </div>
            </div>
        </div>)}

        {/* Galería historial */}
        {filtradas.length === 0 && visitas.length > 0 && (
            <div style={{ textAlign: "center", padding: "16px 0", color: T.muted, fontSize: 12 }}>Sin fotos en esta etapa</div>
        )}
        {filtradas.length === 0 && visitas.length === 0 && (
            <div style={{ textAlign: "center", padding: "16px 0", color: T.muted, fontSize: 12 }}>Aún no hay fotos de visita. Subí la primera para iniciar el historial.</div>
        )}
        {filtradas.map((foto, idx) => {
            const etapa = ETAPAS_VISITA.find(e => e.id === foto.etapa) || ETAPAS_VISITA[0];
            return (<div key={foto.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.rsm, overflow: "hidden", marginBottom: 10 }}>
                <div onClick={() => setVistaFoto(foto)} style={{ cursor: "pointer", position: "relative" }}>
                    <img src={foto.url} alt="" style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover", display: "block" }} />
                    {/* Badge de etapa */}
                    <div style={{ position: "absolute", top: 8, left: 8, background: etapa.bg, border: `1px solid ${etapa.color}`, borderRadius: 20, padding: "3px 10px", fontSize: 10, fontWeight: 700, color: etapa.color }}>
                        {etapa.label}
                    </div>
                    {/* Fecha + hora */}
                    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "linear-gradient(transparent, rgba(0,0,0,.6))", padding: "16px 10px 6px", fontSize: 10, color: "#fff" }}>
                        {foto.fecha} · {foto.hora}
                    </div>
                </div>
                <div style={{ padding: "10px 12px" }}>
                    {/* GPS si tiene */}
                    {foto.gps && (
                        <a href={foto.gps.mapsUrl || `https://maps.google.com/?q=${foto.gps.lat},${foto.gps.lon}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5, background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 7, padding: '5px 8px', marginBottom: 8 }}>
                            <span style={{ fontSize: 12 }}>📍</span>
                            <span style={{ fontSize: 10, color: '#1E40AF', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {foto.gps.direccion || `${foto.gps.lat}, ${foto.gps.lon}`}
                            </span>
                            <span style={{ fontSize: 9, color: '#3B82F6', flexShrink: 0 }}>Ver mapa →</span>
                        </a>
                    )}
                    {/* Descripción editable */}
                    <textarea
                        value={foto.desc || ''}
                        onChange={e => editarDesc(foto.id, e.target.value)}
                        placeholder="Agregar descripción..."
                        rows={2}
                        style={{ width: "100%", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "7px 10px", fontSize: 12, color: T.text, resize: "none", marginBottom: 8 }}
                    />
                    {/* Cambiar etapa + borrar */}
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {ETAPAS_VISITA.map(et => (
                            <button key={et.id} onClick={() => cambiarEtapa(foto.id, et.id)}
                                style={{ padding: "4px 10px", borderRadius: 20, border: `1.5px solid ${foto.etapa === et.id ? et.color : T.border}`, background: foto.etapa === et.id ? et.bg : T.card, color: et.color, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
                                {et.label}
                            </button>
                        ))}
                        <button onClick={() => eliminar(foto.id)}
                            style={{ marginLeft: "auto", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 20, padding: "4px 10px", fontSize: 10, fontWeight: 700, color: "#EF4444", cursor: "pointer" }}>
                            Eliminar
                        </button>
                    </div>
                </div>
            </div>);
        })}

        {/* Vista ampliada de foto */}
        {vistaFoto && (
            <div onClick={() => setVistaFoto(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.92)", zIndex: 999, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16 }}>
                <img src={vistaFoto.url} alt="" style={{ maxWidth: "100%", maxHeight: "75vh", objectFit: "contain", borderRadius: 10 }} />
                {vistaFoto.desc && <div style={{ color: "#fff", fontSize: 13, marginTop: 12, textAlign: "center", maxWidth: 340, lineHeight: 1.5 }}>{vistaFoto.desc}</div>}
                <div style={{ color: "rgba(255,255,255,.6)", fontSize: 11, marginTop: 6 }}>
                    {ETAPAS_VISITA.find(e => e.id === vistaFoto.etapa)?.label} · {vistaFoto.fecha} {vistaFoto.hora}
                </div>
                <div style={{ color: "rgba(255,255,255,.5)", fontSize: 11, marginTop: 16 }}>Tocá para cerrar</div>
            </div>
        )}
    </div>);
}

// ── OBRAS: TABS ──────────────────────────────────────────────────────
function TabFotos({ detail, upd, fileRef, handleFoto, apiKey, cfg }) {
    const [loadingIA, setLoadingIA] = useState(false);
    const [informe, setInforme] = useState('');
    const [selFotos, setSelFotos] = useState([]);
    const [modoSel, setModoSel] = useState(false);
    const fotos = detail.fotos || [];

    function toggleSel(id) { setSelFotos(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]); }

    async function analizarFotos() {
        if (!apiKey) { setInforme('⚠ Configurá tu API Key en Más → Configuración para usar esta función.'); return; }
        const fotosAAnalizar = selFotos.length > 0 ? fotos.filter(f => selFotos.includes(f.id)) : fotos.slice(-8);
        if (!fotosAAnalizar.length) { setInforme('Agregá al menos una foto para analizar.'); return; }
        setLoadingIA(true); setInforme('');
        try {
            const content = [];
            fotosAAnalizar.forEach(f => {
                try { content.push({ type: 'image', source: { type: 'base64', media_type: getMediaType(f.url), data: getBase64(f.url) } }); } catch { }
            });
            content.push({
                type: 'text', text: `Analizá estas ${fotosAAnalizar.length} fotos de la obra "${detail.nombre}" (${detail.sector || '—'}, avance declarado: ${detail.avance}%).

Generá un informe profesional AA2000 con:
1. **Estado general de la obra**
2. **Avance estimado** — ¿coincide con el ${detail.avance}% declarado?
3. **Trabajos en ejecución**
4. **Correcciones y recomendaciones**
5. **Alertas de seguridad**
6. **Conclusión**

Usá un tono técnico y profesional. Respondé en español rioplatense.`});

            const r = await callAI([{ role: 'user', content }],
                `Sos un inspector de obras aeroportuarias para AA2000. Analizás fotos y generás informes técnicos precisos y profesionales en español rioplatense. Si identificás materiales o trabajos, podés buscar precios actualizados en internet para incluir estimaciones de costo.`,
                apiKey, true);
            setInforme(r);
            const nuevoInf = { id: uid(), titulo: `Análisis IA — ${new Date().toLocaleDateString('es-AR')}`, tipo: 'diario', fecha: new Date().toLocaleDateString('es-AR'), notas: 'Generado automáticamente por IA a partir de fotos', nombre: 'informe_ia.txt', ext: 'IA', url: 'data:text/plain;base64,' + btoa(unescape(encodeURIComponent(r))), size: '—', cargado: new Date().toLocaleDateString('es-AR') };
            upd(detail.id, { informes: [nuevoInf, ...(detail.informes || [])] });
        } catch (e) { setInforme('Error al analizar: ' + e.message); }
        setLoadingIA(false); setModoSel(false); setSelFotos([]);
    }

    return (<div>
        <input ref={fileRef} type="file" accept="image/*" multiple onChange={handleFoto} style={{ display: "none" }} />
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <PBtn onClick={() => fileRef.current?.click()} style={{ flex: 1, padding: "11px 0", fontSize: 13 }}>{t(cfg, 'obras_agregar_fotos')}</PBtn>
            {fotos.length > 0 && <button onClick={() => { setModoSel(v => !v); setSelFotos([]); }} style={{ background: modoSel ? T.accent : T.accentLight, border: `1.5px solid ${T.accent}`, borderRadius: T.rsm, padding: "11px 14px", fontSize: 12, fontWeight: 700, color: modoSel ? "#fff" : T.accent, cursor: "pointer", flexShrink: 0 }}>
                {modoSel ? "Cancelar" : "Seleccionar"}
            </button>}
        </div>
        {fotos.length > 0 && (<button onClick={analizarFotos} disabled={loadingIA} style={{ width: "100%", background: loadingIA ? "#94A3B8" : T.navy, border: "none", borderRadius: T.rsm, padding: "13px", marginBottom: 14, cursor: loadingIA ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "#fff", fontSize: 13, fontWeight: 700 }}>
            {loadingIA
                ? <><div style={{ width: 16, height: 16, border: "2px solid rgba(255,255,255,.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin .8s linear infinite" }} />Analizando fotos con IA…</>
                : <>{modoSel && selFotos.length > 0 ? `Analizar ${selFotos.length} foto${selFotos.length > 1 ? 's' : ''} seleccionada${selFotos.length > 1 ? 's' : ''}` : "Analizar fotos con IA"}</>}
        </button>)}
        {modoSel && <div style={{ fontSize: 11, color: T.muted, textAlign: "center", marginBottom: 10 }}>{selFotos.length === 0 ? "Tocá las fotos que querés analizar" : `${selFotos.length} seleccionada${selFotos.length > 1 ? "s" : ""}`}</div>}
        {fotos.length === 0
            ? <div style={{ textAlign: "center", padding: "32px 0", color: T.muted, fontSize: 13 }}>{t(cfg, 'obras_sin_fotos')}</div>
            : <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: informe ? 14 : 0 }}>
                {fotos.map(f => {
                    const sel = selFotos.includes(f.id);
                    return (<div key={f.id} onClick={() => modoSel && toggleSel(f.id)} style={{ borderRadius: T.rsm, overflow: "hidden", border: `2px solid ${sel ? "#10B981" : T.border}`, cursor: modoSel ? "pointer" : "default", position: "relative" }}>
                        {sel && <div style={{ position: "absolute", top: 5, right: 5, width: 20, height: 20, borderRadius: "50%", background: "#10B981", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1, color: "#fff", fontSize: 11, fontWeight: 700 }}>✓</div>}
                        <img src={f.url} alt="" style={{ width: "100%", aspectRatio: "4/3", objectFit: "cover", opacity: modoSel && !sel ? .6 : 1, transition: "opacity .2s" }} />
                        <div style={{ padding: "5px 8px", fontSize: 9, color: T.muted, background: T.card }}>{f.fecha}</div>
                        <button onClick={e => { e.stopPropagation(); upd(detail.id, { fotos: fotos.filter(x => x.id !== f.id) }); }} style={{ position: "absolute", top: 5, left: 5, width: 20, height: 20, borderRadius: "50%", background: "rgba(0,0,0,.5)", border: "none", color: "#fff", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1 }}>✕</button>
                    </div>);
                })}
            </div>}
        {informe && (<Card style={{ padding: "14px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 8, height: 8, borderRadius: "50%", background: "#10B981" }} /><span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Informe IA generado</span></div>
                <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => { try { navigator.clipboard.writeText(informe); } catch { } }} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 7, padding: "4px 10px", fontSize: 11, color: T.sub, cursor: "pointer" }}>📋 Copiar</button>
                    <button onClick={() => setInforme('')} style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 7, padding: "4px 8px", fontSize: 11, color: "#EF4444", cursor: "pointer" }}>✕</button>
                </div>
            </div>
            <div style={{ background: T.bg, borderRadius: T.rsm, padding: "12px 14px", fontSize: 12, color: T.text, lineHeight: 1.7, whiteSpace: "pre-wrap", maxHeight: 320, overflowY: "auto" }}>{informe}</div>
        </Card>)}
    </div>);
}

function TabInformes({ detail, upd }) {
    const [subTab, setSubTab] = useState("diario");
    const [showNew, setShowNew] = useState(false);
    const [form, setForm] = useState({ titulo: '', tipo: 'diario', fecha: '', notas: '' });
    const fileRef = useRef(null);
    const informes = detail.informes || [];
    const TIPOS_INF = [
        { id: 'diario', label: 'Diario', color: '#3B82F6', bg: '#EFF6FF' },
        { id: 'semanal', label: 'Semanal', color: '#7C3AED', bg: '#F5F3FF' },
        { id: 'ingeniero', label: 'Ingeniero', color: '#10B981', bg: '#ECFDF5' },
        { id: 'reunion', label: 'Reunión', color: '#F59E0B', bg: '#FFFBEB' },
    ];
    async function handleFile(e) {
        const files = Array.from(e.target.files);
        const nuevos = [];
        for (const f of files) {
            const url = await toDataUrl(f);
            nuevos.push({
                id: uid(), titulo: form.titulo || f.name.replace(/\.[^.]+$/, ''),
                tipo: form.tipo || subTab, fecha: form.fecha || new Date().toLocaleDateString('es-AR'),
                notas: form.notas, nombre: f.name, ext: f.name.split('.').pop().toUpperCase(),
                url, size: (f.size / 1024).toFixed(0) + 'KB', cargado: new Date().toLocaleDateString('es-AR'),
            });
        }
        upd(detail.id, { informes: [...nuevos, ...informes] });
        setForm({ titulo: '', tipo: 'diario', fecha: '', notas: '' });
        setShowNew(false);
        e.target.value = '';
    }
    const filtered = informes.filter(i => i.tipo === subTab);
    const tp = TIPOS_INF.find(x => x.id === subTab);

    return (<div>
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            {TIPOS_INF.map(tipo => (<button key={tipo.id} onClick={() => setSubTab(tipo.id)} style={{ flex: 1, padding: "8px 4px", borderRadius: 20, border: `1.5px solid ${subTab === tipo.id ? tipo.color : T.border}`, background: subTab === tipo.id ? tipo.bg : T.card, color: tipo.color, fontSize: 11, fontWeight: subTab === tipo.id ? 700 : 500, cursor: "pointer" }}>{tipo.label} ({informes.filter(i => i.tipo === tipo.id).length})</button>))}
        </div>
        <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.xlsx,.xls,.txt,.jpg,.png" multiple onChange={handleFile} style={{ display: "none" }} />
        <button onClick={() => setShowNew(true)} style={{ width: "100%", background: tp?.bg, border: `1.5px dashed ${tp?.color}`, borderRadius: T.rsm, padding: "12px", marginBottom: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <span style={{ fontSize: 18, color: tp?.color }}>+</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: tp?.color }}>Subir informe {tp?.label}</span>
        </button>
        {filtered.length === 0
            ? <div style={{ textAlign: "center", padding: "28px 0", color: T.muted, fontSize: 12 }}>Sin informes {tp?.label?.toLowerCase()}s cargados</div>
            : filtered.map(inf => (<div key={inf.id} style={{ display: "flex", alignItems: "center", gap: 10, background: T.card, border: `1px solid ${T.border}`, borderRadius: T.rsm, padding: "11px 13px", marginBottom: 8 }}>
                <div style={{ width: 38, height: 38, borderRadius: 9, background: tp?.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <span style={{ fontSize: 9, fontWeight: 800, color: tp?.color }}>{inf.ext}</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inf.titulo}</div>
                    <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>{inf.fecha} · {inf.size}</div>
                </div>
                <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                    <a href={inf.url} download={inf.nombre} style={{ textDecoration: "none" }}>
                        <button style={{ background: T.accentLight, border: `1px solid ${T.border}`, borderRadius: 7, width: 30, height: 30, cursor: "pointer", color: T.accent, fontSize: 12 }}>↓</button>
                    </a>
                    <button onClick={() => upd(detail.id, { informes: informes.filter(x => x.id !== inf.id) })} style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 7, width: 30, height: 30, cursor: "pointer", color: "#EF4444", fontSize: 12 }}>✕</button>
                </div>
            </div>))}
        {showNew && (<Sheet title={`Subir informe ${tp?.label}`} onClose={() => setShowNew(false)}>
            <Field label="Título (opcional)"><TInput value={form.titulo} onChange={e => setForm(p => ({ ...p, titulo: e.target.value }))} placeholder="Título del informe" /></Field>
            <FieldRow>
                <Field label="Tipo"><Sel value={form.tipo} onChange={e => setForm(p => ({ ...p, tipo: e.target.value }))}>{TIPOS_INF.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</Sel></Field>
                <Field label="Fecha"><TInput value={form.fecha} onChange={e => setForm(p => ({ ...p, fecha: e.target.value }))} placeholder="dd/mm/aa" /></Field>
            </FieldRow>
            <Field label="Notas"><textarea value={form.notas} onChange={e => setForm(p => ({ ...p, notas: e.target.value }))} placeholder="Observaciones..." rows={3} style={{ width: "100%", background: T.bg, border: `1.5px solid ${T.border}`, borderRadius: T.rsm, padding: "10px 12px", fontSize: 13, color: T.text }} /></Field>
            <PBtn full onClick={() => fileRef.current?.click()}>📎 Seleccionar archivo</PBtn>
        </Sheet>)}
    </div>);
}

// ── OBRAS ────────────────────────────────────────────────────────────
// ── TAB GASTOS (dentro de cada Obra) ─────────────────────────────────
const TIPOS_GASTO = [
    { id: 'general', label: 'Gastos generales', color: '#1D4ED8', bg: '#EFF6FF' },
    { id: 'viatico', label: 'Viático', color: '#F59E0B', bg: '#FFFBEB' },
    { id: 'compra', label: 'Compras', color: '#3B82F6', bg: '#EFF6FF' },
    { id: 'pago', label: 'Pago', color: '#10B981', bg: '#ECFDF5' },
    { id: 'personal', label: 'Personal', color: '#8B5CF6', bg: '#F5F3FF' },
    { id: 'combustible', label: 'Combustible', color: '#F97316', bg: '#FFF7ED' },
    { id: 'subcontrato', label: 'Subcontrato', color: '#EC4899', bg: '#FDF2F8' },
    { id: 'herramienta', label: 'Herramienta', color: '#14B8A6', bg: '#F0FDFA' },
    { id: 'otro', label: 'Otros', color: '#6B7280', bg: '#F9FAFB' },
];

function TabFaltantes({ detail, upd }) {
    const [tipo, setTipo] = useState('doc'); // 'doc' | 'def'
    const [nuevo, setNuevo] = useState('');
    const [nota, setNota] = useState('');
    const faltantesDoc = detail.faltantes_doc || [];
    const faltantesDef = detail.faltantes_def || [];

    function agregar() {
        if (!nuevo.trim()) return;
        const item = { id: uid(), titulo: nuevo.trim(), nota: nota.trim(), fecha: new Date().toLocaleDateString('es-AR') };
        if (tipo === 'doc') upd(detail.id, { faltantes_doc: [...faltantesDoc, item] });
        else upd(detail.id, { faltantes_def: [...faltantesDef, item] });
        setNuevo(''); setNota('');
    }
    function eliminar(id, t) {
        if (t === 'doc') upd(detail.id, { faltantes_doc: faltantesDoc.filter(f => f.id !== id) });
        else upd(detail.id, { faltantes_def: faltantesDef.filter(f => f.id !== id) });
    }

    const lista = tipo === 'doc' ? faltantesDoc : faltantesDef;
    const color = tipo === 'doc' ? '#B91C1C' : '#92400E';
    const bg = tipo === 'doc' ? '#FEF2F2' : '#FFFBEB';
    const border = tipo === 'doc' ? '#FECACA' : '#FDE68A';

    return (<div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {[['doc', '📄 Documentación'], ['def', '❓ Definiciones']].map(([id, lbl]) => (
                <button key={id} onClick={() => setTipo(id)} style={{ flex: 1, padding: '9px', borderRadius: T.rsm, border: `1.5px solid ${tipo === id ? T.accent : T.border}`, background: tipo === id ? T.accentLight : T.card, color: tipo === id ? T.accent : T.sub, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>{lbl}</button>
            ))}
        </div>
        <TInput value={nuevo} onChange={e => setNuevo(e.target.value)} placeholder={tipo === 'doc' ? 'Ej: Plano de instalación eléctrica' : 'Ej: Color de pintura living'} />
        <TInput value={nota} onChange={e => setNota(e.target.value)} placeholder="Nota adicional (opcional)" style={{ marginTop: 8 }} />
        <PBtn full onClick={agregar} disabled={!nuevo.trim()} style={{ marginTop: 8, marginBottom: 16 }}>+ Agregar faltante</PBtn>
        {lista.length === 0 && <div style={{ textAlign: 'center', padding: '30px 0', color: '#10B981', fontWeight: 700, fontSize: 13 }}>✅ Sin faltantes</div>}
        {lista.map(f => (
            <div key={f.id} style={{ background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 8, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color }}>{f.titulo}</div>
                    {f.nota && <div style={{ fontSize: 11, color, opacity: 0.8, marginTop: 3 }}>{f.nota}</div>}
                    <div style={{ fontSize: 10, color: T.muted, marginTop: 4 }}>{f.fecha}</div>
                </div>
                <button onClick={() => eliminar(f.id, tipo)} style={{ background: 'none', border: 'none', color: T.muted, fontSize: 16, cursor: 'pointer', flexShrink: 0 }}>✕</button>
            </div>
        ))}
    </div>);
}

function TabSubcontratos({ detail, upd }) {
    const [showNew, setShowNew] = useState(false);
    const [form, setForm] = useState({ nombre: '', empresa: '', contacto: '', estado: 'activo' });
    const subcontratos = detail.subcontratos || [];
    const TIPOS = ['Interiorismo', 'Carpintería', 'Paisajismo', 'Electricidad', 'Plomería', 'Pintura', 'Vidriería', 'Herrería', 'Yesería', 'Climatización', 'Seguridad', 'Domótica'];

    function agregar() {
        if (!form.nombre.trim()) return;
        upd(detail.id, { subcontratos: [...subcontratos, { id: uid(), ...form }] });
        setForm({ nombre: '', empresa: '', contacto: '', estado: 'activo' }); setShowNew(false);
    }
    function eliminar(id) { if (window.confirm('¿Eliminar?')) upd(detail.id, { subcontratos: subcontratos.filter(s => s.id !== id) }); }

    return (<div>
        {!showNew && <PBtn full onClick={() => setShowNew(true)} style={{ marginBottom: 14 }}>+ Agregar subcontrato</PBtn>}
        {showNew && (<div style={{ background: T.bg, borderRadius: 12, padding: 14, marginBottom: 14 }}>
            <Lbl>Especialidad</Lbl>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {TIPOS.map(t => (<button key={t} onClick={() => setForm(p => ({ ...p, nombre: t }))} style={{ padding: '6px 10px', borderRadius: 20, border: `1.5px solid ${form.nombre === t ? T.accent : T.border}`, background: form.nombre === t ? T.accentLight : T.card, color: form.nombre === t ? T.accent : T.sub, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>{t}</button>))}
            </div>
            <TInput value={form.nombre} onChange={e => setForm(p => ({ ...p, nombre: e.target.value }))} placeholder="O escribí una especialidad..." />
            <TInput value={form.empresa} onChange={e => setForm(p => ({ ...p, empresa: e.target.value }))} placeholder="Empresa / Profesional" style={{ marginTop: 8 }} />
            <TInput value={form.contacto} onChange={e => setForm(p => ({ ...p, contacto: e.target.value }))} placeholder="Contacto / Teléfono" style={{ marginTop: 8 }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                {[['activo', '✅ Activo'], ['pendiente', '⏳ Pendiente'], ['finalizado', '✓ Finalizado']].map(([v, l]) => (
                    <button key={v} onClick={() => setForm(p => ({ ...p, estado: v }))} style={{ flex: 1, padding: '8px', borderRadius: T.rsm, border: `1.5px solid ${form.estado === v ? T.accent : T.border}`, background: form.estado === v ? T.accentLight : T.card, color: form.estado === v ? T.accent : T.sub, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>{l}</button>
                ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button onClick={() => setShowNew(false)} style={{ flex: 1, padding: 10, background: T.bg, border: `1px solid ${T.border}`, borderRadius: T.rsm, fontSize: 13, cursor: 'pointer' }}>Cancelar</button>
                <PBtn onClick={agregar} disabled={!form.nombre.trim()} style={{ flex: 2 }}>Guardar</PBtn>
            </div>
        </div>)}
        {subcontratos.length === 0 && !showNew && <div style={{ textAlign: 'center', padding: '40px 0', color: T.muted, fontSize: 13 }}>🔨 Sin subcontratos asignados</div>}
        {subcontratos.map(s => (
            <div key={s.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: '14px 16px', marginBottom: 8, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{ width: 38, height: 38, borderRadius: 10, background: T.accentLight, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>🔨</div>
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{s.nombre}</div>
                    {s.empresa && <div style={{ fontSize: 12, color: T.sub }}>{s.empresa}</div>}
                    {s.contacto && <div style={{ fontSize: 11, color: T.muted }}>{s.contacto}</div>}
                    <div style={{ fontSize: 10, background: s.estado === 'activo' ? '#ECFDF5' : s.estado === 'finalizado' ? '#F0FDF4' : '#FFFBEB', color: s.estado === 'activo' ? '#10B981' : s.estado === 'finalizado' ? '#16A34A' : '#92400E', borderRadius: 20, padding: '2px 8px', display: 'inline-block', marginTop: 4, fontWeight: 700 }}>{s.estado}</div>
                </div>
                <button onClick={() => eliminar(s.id)} style={{ background: 'none', border: 'none', color: T.muted, fontSize: 16, cursor: 'pointer' }}>✕</button>
            </div>
        ))}
    </div>);
}

function TabGastos({ detail, upd, apiKey }) {
    const [showNew, setShowNew] = useState(false);
    const [escaneando, setEscaneando] = useState(false);
    const [form, setForm] = useState({ desc: '', tipo: 'general', monto: '', fecha: new Date().toLocaleDateString('es-AR'), quien: '', comprobante: null });
    const compRef = useRef(null);
    const ticketRef = useRef(null);
    const gastos = detail.gastos || [];

    const total = gastos.reduce((s, g) => s + parseMontoNum(g.monto), 0);
    const porTipo = TIPOS_GASTO.map(t => ({ ...t, total: gastos.filter(g => g.tipo === t.id).reduce((s, g) => s + parseMontoNum(g.monto), 0) })).filter(t => t.total > 0);

    async function handleComp(e) {
        const f = e.target.files?.[0]; if (!f) return;
        const url = await toDataUrl(f);
        setForm(p => ({ ...p, comprobante: { url, nombre: f.name, ext: f.name.split('.').pop().toUpperCase() } }));
        e.target.value = '';
    }

    // Escanear ticket con IA
    async function escanearTicket(e) {
        const f = e.target.files?.[0]; if (!f) return;
        const url = await toDataUrl(f);
        e.target.value = '';
        setEscaneando(true);
        try {
            const headers = { "Content-Type": "application/json", "anthropic-dangerous-direct-browser-access": "true", "anthropic-version": "2023-06-01" };
            if (apiKey) headers["x-api-key"] = apiKey;
            const body = {
                model: "claude-sonnet-4-20250514", max_tokens: 500,
                messages: [{ role: 'user', content: [
                    { type: 'image', source: { type: 'base64', media_type: getMediaType(url), data: getBase64(url) } },
                    { type: 'text', text: 'Analizá este ticket o factura. Extraé SOLO estos datos en JSON sin markdown:\n{"desc":"descripción corta del gasto","monto":"número sin símbolos","tipo":"general|viatico|compra|pago|personal|combustible|subcontrato|herramienta|otro","fecha":"dd/mm/aaaa","quien":"nombre del proveedor o persona si aparece"}\nSi no encontrás un campo, dejalo vacío. Respondé SOLO con el JSON.' }
                ]}],
            };
            const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
            if (r.ok) {
                const d = await r.json();
                const txt = d.content?.[0]?.text || '{}';
                const datos = JSON.parse(txt.replace(/```json|```/g,'').trim());
                setForm(p => ({
                    ...p,
                    desc: datos.desc || p.desc,
                    monto: datos.monto || p.monto,
                    tipo: datos.tipo || p.tipo,
                    fecha: datos.fecha || p.fecha,
                    quien: datos.quien || p.quien,
                    comprobante: { url, nombre: f.name, ext: f.name.split('.').pop().toUpperCase() }
                }));
                setShowNew(true);
            }
        } catch(e) { alert('Error escaneando ticket: ' + e.message); }
        setEscaneando(false);
    }

    function agregar() {
        if (!form.desc.trim() || !form.monto) return;
        const nuevo = { id: uid(), ...form };
        upd(detail.id, { gastos: [...gastos, nuevo] });
        setForm({ desc: '', tipo: 'general', monto: '', fecha: new Date().toLocaleDateString('es-AR'), quien: '', comprobante: null });
        setShowNew(false);
    }

    const [editandoId, setEditandoId] = useState(null);

    function eliminar(id) { if (window.confirm('¿Eliminar este gasto?')) upd(detail.id, { gastos: gastos.filter(g => g.id !== id) }); }

    function editarGasto(g) {
        setForm({ desc: g.desc, tipo: g.tipo, monto: g.monto, fecha: g.fecha, quien: g.quien || '', comprobante: g.comprobante || null });
        setEditandoId(g.id);
        setShowNew(true);
    }

    function guardar() {
        if (!form.desc.trim() || !form.monto) return;
        if (editandoId) {
            upd(detail.id, { gastos: gastos.map(g => g.id === editandoId ? { ...g, ...form } : g) });
            setEditandoId(null);
        } else {
            upd(detail.id, { gastos: [...gastos, { id: uid(), ...form }] });
        }
        setForm({ desc: '', tipo: 'viatico', monto: '', fecha: new Date().toLocaleDateString('es-AR'), quien: '', comprobante: null });
        setShowNew(false);
    }

    // Exportar a Excel (CSV descargable)
    function exportarExcel() {
        const filas = [
            ['Obra', 'Descripción', 'Categoría', 'Monto ($)', 'Fecha', 'Proveedor/Quien', 'Comprobante'],
            ...gastos.map(g => [
                detail.nombre,
                g.desc,
                TIPOS_GASTO.find(t => t.id === g.tipo)?.label || g.tipo,
                parseMontoNum(g.monto).toString(),
                g.fecha,
                g.quien || '',
                g.comprobante?.nombre || ''
            ]),
            ['', '', 'TOTAL', total.toString(), '', '', '']
        ];
        const csv = filas.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `Gastos_${detail.nombre}_${new Date().toLocaleDateString('es-AR').replace(/\//g,'-')}.csv`;
        a.click();
    }

    return (<div>
        {/* Resumen */}
        <div style={{ background: T.navy, borderRadius: T.rsm, padding: "14px 16px", marginBottom: 14, color: "#fff" }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.6)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Total gastos — {detail.nombre}</div>
            <div style={{ fontSize: 26, fontWeight: 800 }}>${total.toLocaleString('es-AR')}</div>
            {porTipo.length > 0 && <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                {porTipo.map(t => (
                    <div key={t.id} style={{ background: "rgba(255,255,255,.1)", borderRadius: 8, padding: "4px 10px" }}>
                        <div style={{ fontSize: 9, color: "rgba(255,255,255,.6)" }}>{t.label}</div>
                        <div style={{ fontSize: 12, fontWeight: 700 }}>${t.total.toLocaleString('es-AR')}</div>
                    </div>
                ))}
            </div>}
        </div>

        {/* Botones de acción */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
            <input type="file" accept="image/*" ref={ticketRef} style={{ display: 'none' }} onChange={escanearTicket} />
            <button onClick={() => ticketRef.current?.click()} disabled={escaneando} style={{ background: escaneando ? '#94A3B8' : '#F59E0B', border: "none", borderRadius: T.rsm, padding: "12px 8px", fontSize: 12, fontWeight: 700, color: "#fff", cursor: escaneando ? 'not-allowed' : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                {escaneando ? '⏳ Escaneando...' : '📷 Escanear ticket'}
            </button>
            <button onClick={() => setShowNew(true)} style={{ background: T.accent, border: "none", borderRadius: T.rsm, padding: "12px 8px", fontSize: 12, fontWeight: 700, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                ✏️ Cargar manual
            </button>
        </div>

        {/* Exportar Excel */}
        {gastos.length > 0 && (
            <button onClick={exportarExcel} style={{ width: '100%', background: '#ECFDF5', border: '1.5px solid #86EFAC', borderRadius: T.rsm, padding: "10px", fontSize: 12, fontWeight: 700, color: '#15803D', cursor: "pointer", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                📊 Exportar planilla Excel ({gastos.length} gastos · ${total.toLocaleString('es-AR')})
            </button>
        )}

        {gastos.length === 0 ? (
            <div style={{ textAlign: "center", padding: "30px 0", color: T.muted, fontSize: 13 }}>Sin gastos registrados<br/><span style={{fontSize:11}}>Escaneá un ticket o cargá manualmente</span></div>
        ) : (
            [...gastos].reverse().map(g => {
                const tipo = TIPOS_GASTO.find(t => t.id === g.tipo) || TIPOS_GASTO[8];
                return (<div key={g.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.rsm, padding: "12px 14px", marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                        <div style={{ flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
                                <span style={{ background: tipo.bg, color: tipo.color, borderRadius: 20, padding: "2px 9px", fontSize: 10, fontWeight: 700, border: `1px solid ${tipo.color}22` }}>{tipo.label}</span>
                                <span style={{ fontSize: 11, color: T.muted }}>{g.fecha}</span>
                            </div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{g.desc}</div>
                            {g.quien && <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>👤 {g.quien}</div>}
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 10 }}>
                            <div style={{ fontSize: 15, fontWeight: 800, color: T.accent }}>${parseMontoNum(g.monto).toLocaleString('es-AR')}</div>
                        </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        {g.comprobante && (
                            g.comprobante.ext?.match(/^(JPG|JPEG|PNG|WEBP|HEIC)$/i) ? (
                                <div style={{ flex: 1, borderRadius: 8, overflow: 'hidden', maxHeight: 120 }}>
                                    <img src={g.comprobante.url} alt="ticket" style={{ width: '100%', objectFit: 'cover', borderRadius: 8 }} />
                                </div>
                            ) : (
                                <a href={g.comprobante.url} download={g.comprobante.nombre} style={{ textDecoration: "none", flex: 1 }}>
                                    <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "6px 10px", display: "flex", alignItems: "center", gap: 6 }}>
                                        <div style={{ width: 24, height: 24, borderRadius: 5, background: T.accentLight, color: T.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 800 }}>{g.comprobante.ext}</div>
                                        <span style={{ fontSize: 11, color: T.sub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.comprobante.nombre}</span>
                                        <span style={{ fontSize: 10, color: T.accent, fontWeight: 600, marginLeft: "auto" }}>↓</span>
                                    </div>
                                </a>
                            )
                        )}
                        <button onClick={() => editarGasto(g)} style={{ background: T.accentLight, border: `1px solid ${T.border}`, borderRadius: 8, padding: "6px 10px", fontSize: 11, color: T.accent, cursor: "pointer", fontWeight: 700, flexShrink: 0 }}>✏️</button>
                        <button onClick={() => eliminar(g.id)} style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "6px 10px", fontSize: 11, color: "#EF4444", cursor: "pointer", fontWeight: 700, flexShrink: 0 }}>✕</button>
                    </div>
                </div>);
            })
        )}

        {showNew && (<Sheet title={editandoId ? "Editar gasto" : "Cargar gasto"} onClose={() => { setShowNew(false); setEditandoId(null); setForm({ desc: '', tipo: 'viatico', monto: '', fecha: new Date().toLocaleDateString('es-AR'), quien: '', comprobante: null }); }}>
            <Field label="Descripción">
                <TInput value={form.desc} onChange={e => setForm(p => ({ ...p, desc: e.target.value }))} placeholder="Ej: Estacionamiento, cemento, etc." />
            </Field>
            <Lbl>Categoría</Lbl>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 12 }}>
                {TIPOS_GASTO.map(t => (
                    <button key={t.id} onClick={() => setForm(p => ({ ...p, tipo: t.id }))} style={{ padding: "8px 4px", borderRadius: T.rsm, border: `1.5px solid ${form.tipo === t.id ? t.color : T.border}`, background: form.tipo === t.id ? t.bg : T.card, color: t.color, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>{t.label}</button>
                ))}
            </div>
            <FieldRow>
                <Field label="Monto ($)">
                    <MontoInput value={form.monto} onChange={v => setForm(p => ({ ...p, monto: v }))} placeholder="0 $" />
                </Field>
                <Field label="Fecha">
                    <TInput value={form.fecha} onChange={e => setForm(p => ({ ...p, fecha: e.target.value }))} placeholder="dd/mm/aa" />
                </Field>
            </FieldRow>
            <Field label="Quién realizó el gasto (opcional)">
                <TInput value={form.quien} onChange={e => setForm(p => ({ ...p, quien: e.target.value }))} placeholder="Nombre del trabajador" />
            </Field>
            <Field label="Comprobante (foto o PDF)">
                <input ref={compRef} type="file" accept="image/*,.pdf" onChange={handleComp} style={{ display: "none" }} />
                {form.comprobante ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#ECFDF5", border: "1px solid #86EFAC", borderRadius: T.rsm, padding: "10px 12px" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#15803D", flex: 1 }}>✓ {form.comprobante.nombre}</div>
                        <button onClick={() => setForm(p => ({ ...p, comprobante: null }))} style={{ background: "none", border: "none", color: "#EF4444", cursor: "pointer", fontSize: 14 }}>✕</button>
                    </div>
                ) : (
                    <button onClick={() => compRef.current?.click()} style={{ width: "100%", background: T.bg, border: `1.5px dashed ${T.border}`, borderRadius: T.rsm, padding: "11px", fontSize: 12, fontWeight: 600, color: T.sub, cursor: "pointer" }}>
                        📎 Adjuntar comprobante
                    </button>
                )}
            </Field>
            <PBtn full onClick={guardar} disabled={!form.desc.trim() || !form.monto}>{editandoId ? 'Guardar cambios' : 'Guardar gasto'}</PBtn>
        </Sheet>)}
    </div>);
}

function Obras({ obras, setObras, lics, detailId, setDetailId, requireAuth, cfg, apiKey }) {
    const SP = localStorage.getItem('bop_auth_empresa') === 'vv' ? 'vv_' : 'bcm_';
    const UBICS = getUbics(cfg);
    const defaultAp = UBICS[0]?.id || 'aep';
    const [showNew, setShowNew] = useState(false);
    const [tab, setTab] = useState("info");
    const [form, setForm] = useState({ nombre: "", ap: defaultAp, sector: "", estado: "pendiente", avance: 0, inicio: "", cierre: "" });
    const [newObs, setNewObs] = useState("");
    const fileRef = useRef(null); const archRef = useRef(null);
    const detail = detailId ? obras.find(o => o.id === detailId) : null;

    // Actualizar form.ap si cambian las UBICS
    useEffect(() => {
        setForm(f => ({ ...f, ap: UBICS[0]?.id || f.ap }));
    }, [UBICS.length]);

    function add() {
        if (!form.nombre.trim()) return;
        const apFinal = form.ap || UBICS[0]?.id || defaultAp;
        setObras(p => [...p, { ...form, ap: apFinal, id: uid(), avance: parseInt(form.avance) || 0, pagado: 0, obs: [], fotos: [], archivos: [], informes: [], docs: {} }]);
        setForm({ nombre: "", ap: UBICS[0]?.id || defaultAp, sector: "", estado: "pendiente", avance: 0, inicio: "", cierre: "" });
        setShowNew(false);
    }
    function upd(id, patch) {
        setObras(p => p.map(o => {
            if (o.id !== id) return o;
            const updated = { ...o, ...patch };
            if (patch.fotos !== undefined) {
                const key = `${SP}fotos_${id}`;
                // Guardar metadata de fotos (sin base64) para el sync entre usuarios
                const metaFotos = patch.fotos.map(f => ({
                    id: f.id,
                    url: f.url,
                    nombre: f.nombre,
                    fecha: f.fecha
                }));
                const json = JSON.stringify(metaFotos);
                // localStorage: guardar CON base64 para este dispositivo
                const jsonConBase64 = JSON.stringify(patch.fotos);
                try { localStorage.setItem(key, jsonConBase64); } catch {
                    try {
                        localStorage.removeItem(SP+'chat_msgs');
                        localStorage.setItem(key, jsonConBase64);
                    } catch {
                        try { localStorage.setItem(key, JSON.stringify(patch.fotos.slice(-3))); } catch {}
                    }
                }
                // Supabase: fusionar metadata con lo que ya hay remoto
                storage.get(key).then(remoto => {
                    let final = metaFotos;
                    if (remoto?.value) {
                        try {
                            const remotas = JSON.parse(remoto.value);
                            const idsLocales = new Set(metaFotos.map(f => f.id));
                            const soloRemoto = remotas.filter(f => !idsLocales.has(f.id));
                            final = [...metaFotos, ...soloRemoto];
                        } catch {}
                    }
                    storage.set(key, JSON.stringify(final)).catch(() => {});
                    // Guardar cada foto nueva individualmente para que otros puedan descargarla
                    patch.fotos.forEach(f => {
                        if (f.url && f.url.startsWith('data:')) {
                            storage.set(`fotodata_${f.id}`, f.url).catch(() => {});
                            try { localStorage.setItem(`fotodata_${f.id}`, f.url); } catch {}
                        }
                    });
                }).catch(() => { storage.set(key, json).catch(() => {}); });
            }
            if (patch.archivos !== undefined) {
                const key = `${SP}archs_${id}`;
                try { localStorage.setItem(key, JSON.stringify(patch.archivos)); } catch {}
                storage.set(key, JSON.stringify(patch.archivos)).catch(() => {});
            }
            return updated;
        }));
    }
    async function handleFoto(e) {
        if (!detail) return;
        const files = Array.from(e.target.files);
        if (!files.length) return;
        const nuevas = await Promise.all(files.map(async f => {
            const dataUrl = await toDataUrl(f);
            const fotoId = uid();
            // Subir al bucket — devuelve URL pública o base64 como fallback
            const url = await uploadFoto(dataUrl, `obras/${detail.id}`, fotoId);
            return { id: fotoId, url, nombre: f.name, fecha: new Date().toLocaleDateString("es-AR") };
        }));
        upd(detail.id, { fotos: [...(detail.fotos || []), ...nuevas] });
        e.target.value = "";
    }
    async function handleArch(e) {
        if (!detail) return;
        for (const f of Array.from(e.target.files)) {
            const dataUrl = await toDataUrl(f);
            const archId = uid();
            const url = await uploadFoto(dataUrl, `obras/${detail.id}/archivos`, archId);
            upd(detail.id, { archivos: [...detail.archivos, { id: archId, url, nombre: f.name, ext: f.name.split(".").pop().toUpperCase(), fecha: new Date().toLocaleDateString("es-AR") }] });
        }
        e.target.value = "";
    }
    const ec = id => OBRA_ESTADOS.find(e => e.id === id) || OBRA_ESTADOS[0];

    if (detail) {
        const e = ec(detail.estado);
        return (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <AppHeader title={detail.nombre} sub={`${UBICS.find(a => a.id === detail.ap)?.code || detail.ap} · ${detail.sector || t(cfg, 'obras_sector')}`} back onBack={() => setDetailId(null)} right={<Badge color={e.color} bg={e.bg}>{e.label}</Badge>} />
                <div style={{ background: T.card, borderBottom: `1px solid ${T.border}`, padding: "12px 18px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><span style={{ fontSize: 12, color: T.sub, fontWeight: 600 }}>{t(cfg, 'obras_avance')}</span><span style={{ fontSize: 14, fontWeight: 800, color: T.accent }}>{detail.avance}%</span></div>
                    <div style={{ height: 8, background: T.bg, borderRadius: 4 }}><div style={{ height: 8, background: T.accent, borderRadius: 4, width: `${detail.avance}%`, transition: "width .5s" }} /></div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}><span style={{ fontSize: 11, color: T.muted }}>{t(cfg, 'obras_inicio')}: {detail.inicio || "—"}</span><span style={{ fontSize: 11, color: T.muted }}>{t(cfg, 'obras_cierre')}: {detail.cierre || "—"}</span></div>
                    <input type="range" min="0" max="100" value={detail.avance} onChange={e => upd(detail.id, { avance: parseInt(e.target.value) })} style={{ width: "100%", accentColor: "var(--accent,#1D4ED8)", marginTop: 10 }} />
                </div>
                <div style={{ background: T.card, borderBottom: `1px solid ${T.border}`, display: "flex", overflowX: "auto" }}>
                    {[[`info`, t(cfg, 'obras_info')], [`obs`, t(cfg, 'obras_notas')], [`fotos`, t(cfg, 'obras_fotos')], [`archivos`, t(cfg, 'obras_archivos')], [`informes`, 'Informes'], [`gastos`, 'Gastos'], [`faltantes`, '📄 Faltantes'], [`subcontratos`, '🔨 Subcontratos']].map(([id, label]) => (
                        <button key={id} onClick={() => setTab(id)} style={{ flex: 1, minWidth: 52, padding: "10px 4px", background: "none", border: "none", fontSize: 11, fontWeight: tab === id ? 700 : 500, color: tab === id ? T.accent : T.muted, borderBottom: `2px solid ${tab === id ? "var(--accent,#1D4ED8)" : "transparent"}`, whiteSpace: "nowrap" }}>{label}</button>
                    ))}
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px", paddingBottom: 80 }}>
                    {tab === "info" && (<div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
                            <div style={{ background: T.bg, borderRadius: T.rsm, padding: "10px 12px" }}>
                                <div style={{ fontSize: 10, color: T.muted, marginBottom: 5, textTransform: "uppercase" }}>{getLabelUbic(cfg)}</div>
                                <select value={detail.ap} onChange={e => upd(detail.id, { ap: e.target.value })} style={{ width: "100%", background: "transparent", border: "none", fontSize: 12, fontWeight: 600, color: T.text, padding: 0, cursor: "pointer" }}>
                                    {UBICS.map(a => <option key={a.id} value={a.id}>{a.code} – {a.name}</option>)}
                                </select>
                            </div>
                            <div style={{ background: T.bg, borderRadius: T.rsm, padding: "10px 12px" }}>
                                <div style={{ fontSize: 10, color: T.muted, marginBottom: 5, textTransform: "uppercase" }}>{t(cfg, 'obras_sector')}</div>
                                <input value={detail.sector || ''} onChange={e => upd(detail.id, { sector: e.target.value })} placeholder="Sin sector" style={{ width: "100%", background: "transparent", border: "none", fontSize: 12, fontWeight: 600, color: T.text, padding: 0 }} />
                            </div>
                            <div style={{ background: T.bg, borderRadius: T.rsm, padding: "10px 12px" }}>
                                <div style={{ fontSize: 10, color: T.muted, marginBottom: 5, textTransform: "uppercase" }}>{t(cfg, 'obras_inicio')}</div>
                                <input value={detail.inicio || ''} onChange={e => upd(detail.id, { inicio: e.target.value })} placeholder="dd/mm/aa" style={{ width: "100%", background: "transparent", border: "none", fontSize: 12, fontWeight: 600, color: T.text, padding: 0 }} />
                            </div>
                            <div style={{ background: T.bg, borderRadius: T.rsm, padding: "10px 12px" }}>
                                <div style={{ fontSize: 10, color: T.muted, marginBottom: 5, textTransform: "uppercase" }}>{t(cfg, 'obras_cierre')}</div>
                                <input value={detail.cierre || ''} onChange={e => upd(detail.id, { cierre: e.target.value })} placeholder="dd/mm/aa" style={{ width: "100%", background: "transparent", border: "none", fontSize: 12, fontWeight: 600, color: T.text, padding: 0 }} />
                            </div>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
                            <div style={{ background: T.bg, borderRadius: T.rsm, padding: "10px 12px" }}>
                                <div style={{ fontSize: 10, color: T.muted, marginBottom: 5, textTransform: "uppercase" }}>Presupuesto</div>
                                {(() => {
                                    const lic = lics?.find(l => l.id === detail.lic_id);
                                    const montoLic = lic?.monto;
                                    const montoObra = detail.monto;
                                    // Mostrar monto de licitación si existe, sino el de la obra
                                    const montoMostrar = montoLic || montoObra;
                                    return montoLic ? (
                                        <div>
                                            <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{montoLic}</div>
                                            <div style={{ fontSize: 9, color: T.muted, marginTop: 2 }}>Desde licitación</div>
                                        </div>
                                    ) : (
                                        <input value={detail.monto || ''} onChange={e => upd(detail.id, { monto: e.target.value })} placeholder="$ 0" style={{ width: "100%", background: "transparent", border: "none", fontSize: 12, fontWeight: 600, color: T.text, padding: 0 }} />
                                    );
                                })()}
                            </div>
                            <div style={{ background: "#ECFDF5", borderRadius: T.rsm, padding: "10px 12px" }}>
                                <div style={{ fontSize: 10, color: T.muted, marginBottom: 5, textTransform: "uppercase" }}>💰 Saldo</div>
                                {(() => {
                                    const totalGastos = (detail.gastos || []).reduce((s, g) => s + parseMontoNum(g.monto), 0);
                                    const lic = lics?.find(l => l.id === detail.lic_id);
                                    const presup = parseMontoNum(lic?.monto || detail.monto || 0);
                                    const saldo = presup - totalGastos;
                                    const enRojo = saldo < 0;
                                    const fmt = n => '$' + Math.abs(n).toLocaleString('es-AR', { maximumFractionDigits: 0 });
                                    return (<div>
                                        <div style={{ fontSize: 12, fontWeight: 700, color: enRojo ? "#EF4444" : "#10B981" }}>
                                            {enRojo ? '-' : ''}{fmt(saldo)}
                                        </div>
                                        {presup > 0 && <div style={{ fontSize: 9, color: T.muted, marginTop: 2 }}>
                                            {fmt(presup)} − {fmt(totalGastos)}
                                        </div>}
                                        {presup === 0 && <div style={{ fontSize: 9, color: T.muted, marginTop: 2 }}>
                                            Gastos: {fmt(totalGastos)}
                                        </div>}
                                    </div>);
                                })()}
                            </div>
                        </div>
                        <Lbl>{t(cfg, 'obras_estado')}</Lbl>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 14 }}>
                            {OBRA_ESTADOS.map(e => (<button key={e.id} onClick={() => upd(detail.id, { estado: e.id })} style={{ padding: "9px", borderRadius: T.rsm, border: `1.5px solid ${detail.estado === e.id ? e.color : T.border}`, background: detail.estado === e.id ? e.bg : T.card, color: e.color, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{e.label}</button>))}
                        </div>
                        <button onClick={() => { if (window.confirm(`¿Eliminar "${detail.nombre}"? Esta acción no se puede deshacer.`)) { setObras(p => p.filter(o => o.id !== detail.id)); setDetailId(null); } }} style={{ width: "100%", background: "#FEF2F2", border: "1.5px solid #FECACA", borderRadius: T.rsm, padding: "9px", fontSize: 12, fontWeight: 600, color: "#EF4444", cursor: "pointer" }}>{t(cfg, 'obras_eliminar')}</button>
                    </div>)}
                    {tab === "obs" && (<div>
                        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                            <TInput value={newObs} onChange={e => setNewObs(e.target.value)} placeholder={t(cfg, 'obras_obs_placeholder')} />
                            <PBtn onClick={() => { if (!newObs.trim()) return; const tx = newObs; setNewObs(""); upd(detail.id, { obs: [...detail.obs, { id: uid(), txt: tx, fecha: new Date().toLocaleDateString("es-AR") }] }); }} disabled={!newObs.trim()} style={{ padding: "11px 16px", flexShrink: 0 }}>+</PBtn>
                        </div>
                        {[...detail.obs].reverse().map(o => (<Card key={o.id} style={{ padding: "12px 14px", marginBottom: 8 }}><div style={{ fontSize: 13, color: T.text, lineHeight: 1.5 }}>{o.txt}</div><div style={{ fontSize: 10, color: T.muted, marginTop: 6 }}>{o.fecha}</div></Card>))}
                        {detail.obs.length === 0 && <div style={{ textAlign: "center", padding: "32px 0", color: T.muted, fontSize: 13 }}>{t(cfg, 'obras_sin_notas')}</div>}
                    </div>)}
                    {tab === "fotos" && (<TabFotos detail={detail} upd={upd} fileRef={fileRef} handleFoto={handleFoto} apiKey={apiKey} cfg={cfg} />)}
                    {tab === "archivos" && (<div>
                        <input ref={archRef} type="file" accept=".pdf,.xlsx,.xls,.docx,.doc" multiple onChange={handleArch} style={{ display: "none" }} />
                        <PBtn full onClick={() => archRef.current?.click()} style={{ marginBottom: 14 }}>{t(cfg, 'obras_agregar_arch')}</PBtn>
                        {detail.archivos.map(f => (<div key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, background: T.card, border: `1px solid ${T.border}`, borderRadius: T.rsm, padding: "11px 13px", marginBottom: 7 }}>
                            <div style={{ width: 36, height: 36, borderRadius: 8, background: T.accentLight, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><span style={{ fontSize: 9, fontWeight: 700, color: T.accent }}>{f.ext}</span></div>
                            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.nombre}</div><div style={{ fontSize: 10, color: T.muted }}>{f.fecha}</div></div>
                            <a href={f.url} download={f.nombre} style={{ textDecoration: "none" }}><button style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, width: 30, height: 30, fontSize: 13, color: T.sub, cursor: "pointer" }}>↓</button></a>
                        </div>))}
                        {detail.archivos.length === 0 && <div style={{ textAlign: "center", padding: "32px 0", color: T.muted, fontSize: 13 }}>{t(cfg, 'obras_sin_archivos')}</div>}
                    </div>)}
                    {tab === "informes" && <TabInformes detail={detail} upd={upd} />}
                    {tab === "gastos" && <TabGastos detail={detail} upd={upd} apiKey={apiKey} />}
                    {tab === "faltantes" && <TabFaltantes detail={detail} upd={upd} />}
                    {tab === "subcontratos" && <TabSubcontratos detail={detail} upd={upd} />}
                </div>
            </div>
        );
    }

    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title={t(cfg, 'obras_titulo')} sub={`${obras.length} registros`} right={<PlusBtn onClick={() => requireAuth(() => setShowNew(true), t(cfg, 'obras_nueva'))} />} />
        <div style={{ padding: "14px 18px" }}>
            {OBRA_ESTADOS.map(est => {
                const items = obras.filter(o => o.estado === est.id);
                if (!items.length) return null;
                return (<div key={est.id} style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}><div style={{ width: 7, height: 7, borderRadius: "50%", background: est.color }} /><span style={{ fontSize: 11, fontWeight: 700, color: est.color, textTransform: "uppercase", letterSpacing: "0.06em" }}>{est.label}</span><span style={{ fontSize: 11, color: T.muted }}>({items.length})</span></div>
                    {items.map(o => (<Card key={o.id} onClick={() => setDetailId(o.id)} style={{ padding: "13px 14px", marginBottom: 7, cursor: "pointer" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{o.nombre}</div><span style={{ fontSize: 12, fontWeight: 700, color: T.accent }}>{o.avance}%</span></div>
                        <div style={{ height: 4, background: T.bg, borderRadius: 4, marginBottom: 6 }}><div style={{ height: 4, background: T.accent, borderRadius: 4, width: `${o.avance}%` }} /></div>
                        <div style={{ fontSize: 11, color: T.muted }}>{UBICS.find(a => a.id === o.ap)?.code || o.ap} · {o.sector || "Sin sector"} · {o.cierre || "—"}</div>
                    </Card>))}
                </div>);
            })}
        </div>
        {showNew && (<Sheet title={t(cfg, 'obras_nueva')} onClose={() => setShowNew(false)}>
            <Field label={t(cfg, 'obras_titulo')}><TInput value={form.nombre} onChange={e => setForm(p => ({ ...p, nombre: e.target.value }))} placeholder="Ej: Refacción Terminal B" /></Field>
            <FieldRow>
                <Field label={getLabelUbic(cfg)}><Sel value={form.ap} onChange={e => setForm(p => ({ ...p, ap: e.target.value }))}>{UBICS.map(a => <option key={a.id} value={a.id}>{a.code} – {a.name}</option>)}</Sel></Field>
                <Field label={t(cfg, 'obras_estado')}><Sel value={form.estado} onChange={e => setForm(p => ({ ...p, estado: e.target.value }))}>{OBRA_ESTADOS.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</Sel></Field>
            </FieldRow>
            <FieldRow>
                <Field label={t(cfg, 'obras_sector')}><TInput value={form.sector} onChange={e => setForm(p => ({ ...p, sector: e.target.value }))} placeholder="Sector A" /></Field>
                <Field label={`${t(cfg, 'obras_avance')} %`}><TInput type="number" value={form.avance} onChange={e => setForm(p => ({ ...p, avance: e.target.value }))} placeholder="0" /></Field>
            </FieldRow>
            <FieldRow>
                <Field label={t(cfg, 'obras_inicio')}><TInput value={form.inicio} onChange={e => setForm(p => ({ ...p, inicio: e.target.value }))} placeholder="dd/mm/aa" /></Field>
                <Field label={t(cfg, 'obras_cierre')}><TInput value={form.cierre} onChange={e => setForm(p => ({ ...p, cierre: e.target.value }))} placeholder="dd/mm/aa" /></Field>
            </FieldRow>
            <PBtn full onClick={add} disabled={!form.nombre.trim()}>{t(cfg, 'obras_nueva')}</PBtn>
        </Sheet>)}
    </div>);
}

// ── PERSONAL ─────────────────────────────────────────────────────────
function Personal({ personal, setPersonal, obras, cfg }) {
    const SP = localStorage.getItem('bop_auth_empresa') === 'vv' ? 'vv_' : 'bcm_';
    const [expanded, setExpanded] = useState(null);
    const [tabPersona, setTabPersona] = useState({}); // tab activo por persona: 'info' | 'historial'
    const [presentismo, setPresentismo] = useState({});
    const [presentismoLoaded, setPresentismoLoaded] = useState(false);
    const fileRefs = useRef({}); const fotoRefs = useRef({}); const newFotoRef = useRef(null);
    const [nuevaTarea, setNuevaTarea] = useState({});
    const [showNew, setShowNew] = useState(false);
    const [form, setForm] = useState({ nombre: "", rol: "Técnico", empresa: "Belfast Obras", obra_id: "", telefono: "", foto: "", tareas: [] });

    // Cargar datos de presentismo para ver historial
    useEffect(() => {
        (async () => {
            try {
                const r = await storage.get(('bop_')+'presentismo');
                if (r?.value) { const d = JSON.parse(r.value); setPresentismo(d.registros || {}); }
            } catch { }
            setPresentismoLoaded(true);
        })();
    }, []);

    function getTabPersona(id) { return tabPersona[id] || 'info'; }
    function setTabFor(id, tab) { setTabPersona(prev => ({ ...prev, [id]: tab })); }

    // Obtener historial de presencia de una persona
    function getHistorialPersona(personaId) {
        const registros = [];
        Object.entries(presentismo).forEach(([key, val]) => {
            if (!key.startsWith(personaId + '_')) return;
            const fecha = key.replace(personaId + '_', '');
            const sesiones = val.sesiones || [];
            sesiones.forEach(s => {
                registros.push({
                    fecha,
                    obraNombre: s.obraNombre || '—',
                    inicio: s.inicio,
                    fin: s.fin,
                    auto: s.auto,
                    duracionMs: s.fin ? s.fin - s.inicio : null,
                });
            });
        });
        // Ordenar por inicio descendente
        return registros.sort((a, b) => (b.inicio || 0) - (a.inicio || 0));
    }

    function totalHorasPersona(personaId) {
        const hist = getHistorialPersona(personaId);
        const ms = hist.reduce((t, r) => t + (r.duracionMs || 0), 0);
        return formatDuration(ms);
    }

    function ini(n) { return n.split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase(); }
    function add() { if (!form.nombre.trim()) return; setPersonal(p => [...p, { ...form, id: uid(), docs: {} }]); setForm({ nombre: "", rol: "Técnico", empresa: "Belfast Obras", obra_id: "", telefono: "", foto: "", tareas: [] }); setShowNew(false); }
    function upd(id, patch) { setPersonal(p => p.map(x => x.id === id ? { ...x, ...patch } : x)); }
    async function handleDoc(pid, did, file) { const url = await toDataUrl(file); setPersonal(p => p.map(x => x.id === pid ? { ...x, docs: { ...x.docs, [did]: { nombre: file.name, url, vence: "" } } } : x)); }
    function setVence(pid, did, val) { setPersonal(p => p.map(x => x.id === pid ? { ...x, docs: { ...x.docs, [did]: { ...x.docs[did], vence: val } } } : x)); }

    const Av = ({ p, size = 38, showCam = false, onClick }) => (<div onClick={onClick} style={{ width: size, height: size, borderRadius: "50%", flexShrink: 0, position: "relative", overflow: "hidden", background: p.foto ? "transparent" : T.accentLight, border: `1.5px solid ${T.border}`, cursor: onClick ? "pointer" : "default" }}>
        {p.foto ? <img src={p.foto} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * .32, fontWeight: 700, color: T.accent }}>{ini(p.nombre)}</div>}
        {showCam && <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "rgba(0,0,0,.45)", padding: "4px 0", display: "flex", alignItems: "center", justifyContent: "center" }}><span style={{ color: "#fff", fontSize: 8, fontWeight: 600 }}>📷</span></div>}
    </div>);

    async function importarDesdeAgenda() {
        // Contact Picker API — disponible en Android Chrome y algunos browsers
        if (!('contacts' in navigator && 'ContactsManager' in window)) {
            alert('Tu dispositivo no soporta importar contactos directamente.\n\nEn Android: funciona en Chrome.\nEn iPhone: no está disponible aún en iOS Safari.');
            return;
        }
        try {
            const props = ['name', 'tel', 'email'];
            const opts = { multiple: true };
            const contactos = await navigator.contacts.select(props, opts);
            if (!contactos.length) return;
            const nuevos = contactos.map(c => ({
                id: uid(),
                nombre: c.name?.[0] || 'Sin nombre',
                rol: 'Operario',
                empresa: '',
                telefono: (c.tel?.[0] || '').replace(/\D/g, ''),
                email: c.email?.[0] || '',
                foto: '',
                obra_id: '',
                tareas: [],
                docs: {}
            }));
            // Filtrar duplicados por nombre
            const nombresExistentes = new Set(personal.map(p => p.nombre.toLowerCase()));
            const sinDuplicados = nuevos.filter(n => !nombresExistentes.has(n.nombre.toLowerCase()));
            if (!sinDuplicados.length) {
                alert('Todos los contactos seleccionados ya están en el personal.');
                return;
            }
            setPersonal(p => [...p, ...sinDuplicados]);
            alert(`✅ ${sinDuplicados.length} contacto${sinDuplicados.length > 1 ? 's' : ''} importado${sinDuplicados.length > 1 ? 's' : ''} correctamente.`);
        } catch (e) {
            if (e.name !== 'AbortError') alert('No se pudo acceder a los contactos: ' + e.message);
        }
    }

    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title={t(cfg, 'pers_titulo')} sub={`${personal.length} trabajadores`} right={
            <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={importarDesdeAgenda} style={{ background: '#ECFDF5', border: '1px solid #86EFAC', borderRadius: 10, padding: '7px 12px', fontSize: 12, fontWeight: 700, color: '#16A34A', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 14 }}>📱</span> Agenda
                </button>
                <PlusBtn onClick={() => setShowNew(true)} />
            </div>
        } />
        <div style={{ padding: "14px 18px" }}>
            {personal.length === 0 && <div style={{ textAlign: "center", padding: "48px 0", color: T.muted, fontSize: 14 }}>{t(cfg, 'pers_sin_personal')}</div>}
            {personal.map(p => {
                const docsOk = Object.values(p.docs || {}).filter(Boolean).length;
                const isOpen = expanded === p.id;
                const obraAsig = obras.find(o => o.id === p.obra_id);
                const hist = getHistorialPersona(p.id);
                const tabActivo = getTabPersona(p.id);
                return (<Card key={p.id} style={{ marginBottom: 10, overflow: "hidden" }}>
                    <div onClick={() => setExpanded(isOpen ? null : p.id)} style={{ display: "flex", alignItems: "center", gap: 11, padding: "13px 14px", cursor: "pointer" }}>
                        <Av p={p} size={40} />
                        <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{p.nombre}</div>
                            <div style={{ fontSize: 11, color: T.muted }}>{p.rol}{obraAsig ? ` · ${obraAsig.nombre}` : ""}</div>
                        </div>
                        <div style={{ display: "flex", gap: 3, marginRight: 4 }}>{DOC_TYPES.map(d => { const doc = p.docs?.[d.id]; const exp = doc?.vence && daysSince(doc.vence) <= 5; return <div key={d.id} style={{ width: 7, height: 7, borderRadius: "50%", background: exp ? "#F59E0B" : doc ? "#22c55e" : T.border }} />; })}</div>
                        <span style={{ fontSize: 11, color: T.muted }}>{docsOk}/{DOC_TYPES.length}</span>
                        <span style={{ fontSize: 14, color: T.muted, marginLeft: 2 }}>{isOpen ? "⌃" : "⌄"}</span>
                    </div>
                    {isOpen && (<div style={{ borderTop: `1px solid ${T.border}` }}>
                        {/* Tabs Info / Historial */}
                        <div style={{ display: "flex", borderBottom: `1px solid ${T.border}` }}>
                            {[['info', 'Info y docs'], ['historial', `Historial (${hist.length})`]].map(([id, label]) => (
                                <button key={id} onClick={() => setTabFor(p.id, id)} style={{ flex: 1, padding: "10px 6px", background: "none", border: "none", fontSize: 12, fontWeight: tabActivo === id ? 700 : 500, color: tabActivo === id ? T.accent : T.muted, borderBottom: `2px solid ${tabActivo === id ? T.accent : "transparent"}`, cursor: "pointer" }}>{label}</button>
                            ))}
                        </div>

                        {/* TAB INFO */}
                        {tabActivo === 'info' && (<div style={{ padding: "14px 14px 14px" }}>
                            <div style={{ display: "flex", gap: 14, marginBottom: 12, alignItems: "flex-start" }}>
                                <div style={{ flexShrink: 0 }}>
                                    <input type="file" accept="image/*" style={{ display: "none" }} ref={el => fotoRefs.current[p.id] = el} onChange={async e => { if (e.target.files[0]) { const dataUrl = await toDataUrl(e.target.files[0]); upd(p.id, { foto: dataUrl }); const fotoId = uid(); uploadFoto(dataUrl, `personal/${p.id}`, fotoId).then(remoteUrl => { if (remoteUrl && remoteUrl !== dataUrl) upd(p.id, { foto: remoteUrl }); }).catch(() => {}); } e.target.value = ""; }} />
                                    <Av p={p} size={76} showCam onClick={() => fotoRefs.current[p.id]?.click()} />
                                </div>
                                <div style={{ flex: 1 }}>
                                    <Lbl>Nombre</Lbl>
                                    <input value={p.nombre || ""} onChange={e => upd(p.id, { nombre: e.target.value })} placeholder="Nombre completo" style={{ width: "100%", background: T.bg, border: `1.5px solid ${T.border}`, borderRadius: T.rsm, padding: "8px 12px", fontSize: 13, color: T.text, marginBottom: 8 }} />
                                    <Lbl>Rol</Lbl>
                                    <select value={p.rol || ""} onChange={e => upd(p.id, { rol: e.target.value })} style={{ width: "100%", background: T.bg, border: `1.5px solid ${T.border}`, borderRadius: T.rsm, padding: "8px 12px", fontSize: 13, color: T.text }}>
                                        {ROLES.map(r => <option key={r}>{r}</option>)}
                                    </select>
                                </div>
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                                <div>
                                    <Lbl>Obra asignada</Lbl>
                                    <select value={p.obra_id || ""} onChange={e => upd(p.id, { obra_id: e.target.value })} style={{ width: "100%", background: T.bg, border: `1.5px solid ${T.border}`, borderRadius: T.rsm, padding: "8px 10px", fontSize: 12, color: T.text }}>
                                        <option value="">Sin asignar</option>
                                        {obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <Lbl>WhatsApp</Lbl>
                                    <div style={{ display: "flex", gap: 6 }}>
                                        <input type="tel" value={p.telefono || ""} onChange={e => upd(p.id, { telefono: e.target.value.replace(/\D/g, '') })} placeholder="5491155556666" style={{ flex: 1, background: T.bg, border: `1.5px solid ${T.border}`, borderRadius: T.rsm, padding: "8px 10px", fontSize: 12, color: T.text }} />
                                        {p.telefono && <a href={`https://wa.me/${p.telefono}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}><button style={{ background: "#25D366", border: "none", borderRadius: 9, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "white", fontSize: 13 }}>💬</button></a>}
                                    </div>
                                </div>
                            </div>
                            <Lbl>Documentación</Lbl>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, margin: "6px 0 12px" }}>
                                {DOC_TYPES.map(d => {
                                    const doc = p.docs?.[d.id]; const rk = `${p.id}_${d.id}`;
                                    const exp = doc?.vence && daysSince(doc.vence) <= 5;
                                    return (<div key={d.id}>
                                        <input type="file" style={{ display: "none" }} ref={el => fileRefs.current[rk] = el} onChange={e => { if (e.target.files[0]) handleDoc(p.id, d.id, e.target.files[0]); e.target.value = ""; }} />
                                        {doc ? (<div style={{ background: exp ? "#FFFBEB" : "#F0FDF4", border: `1.5px solid ${exp ? "#FDE68A" : "#86EFAC"}`, borderRadius: 10, padding: "9px 10px" }}>
                                            <div style={{ fontSize: 10, fontWeight: 700, color: exp ? "#92400E" : "#15803D", marginBottom: 2 }}>{d.label}</div>
                                            <div style={{ fontSize: 10, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 4 }}>{doc.nombre}</div>
                                            {d.acceptsExp && <input type="text" placeholder="Vence dd/mm/aa" value={doc.vence || ""} onChange={e => setVence(p.id, d.id, e.target.value)} style={{ width: "100%", fontSize: 10, padding: "4px 6px", border: `1px solid ${T.border}`, borderRadius: 6, background: "#fff", color: T.text, marginBottom: 6 }} />}
                                            <div style={{ display: "flex", gap: 4 }}>
                                                <a href={doc.url} download={doc.nombre} style={{ textDecoration: "none", flex: 1 }}><button style={{ width: "100%", background: "none", border: `1px solid ${exp ? "#FDE68A" : "#86EFAC"}`, borderRadius: 6, padding: "4px 0", fontSize: 9, color: exp ? "#92400E" : "#15803D", fontWeight: 600, cursor: "pointer" }}>↓ Ver</button></a>
                                                <button onClick={() => setPersonal(prev => prev.map(x => x.id === p.id ? { ...x, docs: { ...x.docs, [d.id]: null } } : x))} style={{ background: "none", border: "1px solid #FCA5A5", borderRadius: 6, padding: "4px 7px", fontSize: 9, color: "#EF4444", cursor: "pointer" }}>✕</button>
                                            </div>
                                        </div>) : (<button onClick={() => fileRefs.current[rk]?.click()} style={{ width: "100%", background: T.bg, border: `1.5px dashed ${T.border}`, borderRadius: 10, padding: "10px 6px", cursor: "pointer", textAlign: "center" }}>
                                            <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, marginBottom: 3 }}>{d.label.slice(0, 3).toUpperCase()}</div>
                                            <div style={{ fontSize: 10, fontWeight: 600, color: T.sub }}>{d.label}</div>
                                        </button>)}
                                    </div>);
                                })}
                            </div>
                            <div style={{ marginBottom: 10 }}>
                                <Lbl>Tareas asignadas</Lbl>
                                <div style={{ display: 'flex', gap: 6, marginBottom: 8, marginTop: 4 }}>
                                    <input value={nuevaTarea[p.id] || ''} onChange={e => setNuevaTarea(prev => ({ ...prev, [p.id]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter' && nuevaTarea[p.id]?.trim()) { setPersonal(prev => prev.map(x => x.id === p.id ? { ...x, tareas: [...(x.tareas || []), { id: uid(), txt: nuevaTarea[p.id].trim(), done: false, fecha: new Date().toLocaleDateString('es-AR') }] } : x)); setNuevaTarea(prev => ({ ...prev, [p.id]: '' })); } }} placeholder="Nueva tarea..." style={{ flex: 1, background: T.bg, border: `1.5px solid ${T.border}`, borderRadius: T.rsm, padding: '8px 12px', fontSize: 12, color: T.text }} />
                                    <button onClick={() => { if (!nuevaTarea[p.id]?.trim()) return; setPersonal(prev => prev.map(x => x.id === p.id ? { ...x, tareas: [...(x.tareas || []), { id: uid(), txt: nuevaTarea[p.id].trim(), done: false, fecha: new Date().toLocaleDateString('es-AR') }] } : x)); setNuevaTarea(prev => ({ ...prev, [p.id]: '' })); }} style={{ background: T.accent, border: 'none', borderRadius: T.rsm, padding: '8px 14px', fontSize: 12, fontWeight: 700, color: '#fff', cursor: 'pointer', flexShrink: 0 }}>+</button>
                                </div>
                                {(p.tareas || []).length === 0 && <div style={{ fontSize: 12, color: T.muted, fontStyle: 'italic' }}>Sin tareas asignadas</div>}
                                {(p.tareas || []).map(tk => (
                                    <div key={tk.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: tk.done ? '#F0FDF4' : '#FFFBEB', border: `1px solid ${tk.done ? '#86EFAC' : '#FDE68A'}`, borderRadius: 8, padding: '7px 10px', marginBottom: 5 }}>
                                        <input type="checkbox" checked={tk.done} onChange={() => setPersonal(prev => prev.map(x => x.id === p.id ? { ...x, tareas: x.tareas.map(t2 => t2.id === tk.id ? { ...t2, done: !t2.done } : t2) } : x))} style={{ accentColor: T.accent, width: 15, height: 15, flexShrink: 0 }} />
                                        <span style={{ flex: 1, fontSize: 12, color: T.text, textDecoration: tk.done ? 'line-through' : 'none' }}>{tk.txt}</span>
                                        <span style={{ fontSize: 10, color: T.muted }}>{tk.fecha}</span>
                                        <button onClick={() => setPersonal(prev => prev.map(x => x.id === p.id ? { ...x, tareas: x.tareas.filter(t2 => t2.id !== tk.id) } : x))} style={{ background: 'none', border: 'none', color: '#EF4444', cursor: 'pointer', fontSize: 12, padding: 2 }}>✕</button>
                                    </div>
                                ))}
                            </div>
                            <button onClick={() => { if (window.confirm(`¿Eliminar a ${p.nombre}? Esta acción no se puede deshacer.`)) { setPersonal(prev => prev.filter(x => x.id !== p.id)); if (expanded === p.id) setExpanded(null); } }} style={{ width: "100%", background: "#FEF2F2", border: "1.5px solid #FECACA", borderRadius: T.rsm, padding: "9px", fontSize: 12, fontWeight: 600, color: "#EF4444", cursor: "pointer" }}>{t(cfg, 'pers_eliminar')}</button>
                        </div>)}

                        {/* TAB HISTORIAL DE PRESENCIA */}
                        {tabActivo === 'historial' && (<div style={{ padding: "14px" }}>
                            {/* KPIs resumen */}
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
                                <div style={{ background: T.bg, borderRadius: T.rsm, padding: "10px 8px", textAlign: "center" }}>
                                    <div style={{ fontSize: 18, fontWeight: 800, color: T.accent }}>{hist.length}</div>
                                    <div style={{ fontSize: 9, color: T.muted, marginTop: 2 }}>Visitas</div>
                                </div>
                                <div style={{ background: T.bg, borderRadius: T.rsm, padding: "10px 8px", textAlign: "center" }}>
                                    <div style={{ fontSize: 18, fontWeight: 800, color: "#10B981" }}>{totalHorasPersona(p.id)}</div>
                                    <div style={{ fontSize: 9, color: T.muted, marginTop: 2 }}>Tiempo total</div>
                                </div>
                                <div style={{ background: T.bg, borderRadius: T.rsm, padding: "10px 8px", textAlign: "center" }}>
                                    <div style={{ fontSize: 18, fontWeight: 800, color: "#8B5CF6" }}>{[...new Set(hist.map(h => h.obraNombre))].length}</div>
                                    <div style={{ fontSize: 9, color: T.muted, marginTop: 2 }}>Obras</div>
                                </div>
                            </div>

                            {hist.length === 0 ? (
                                <div style={{ textAlign: "center", padding: "24px 0", color: T.muted, fontSize: 13 }}>
                                    <div style={{ fontSize: 32, marginBottom: 10 }}>🕐</div>
                                    Sin registros de presencia.<br />
                                    <span style={{ fontSize: 11 }}>Usá Presentismo GPS para registrar entradas y salidas.</span>
                                </div>
                            ) : (
                                hist.map((r, i) => {
                                    const entrada = r.inicio ? new Date(r.inicio) : null;
                                    const salida = r.fin ? new Date(r.fin) : null;
                                    const durMs = r.duracionMs;
                                    return (<div key={i} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.rsm, padding: "12px 14px", marginBottom: 8 }}>
                                        {/* Obra y fecha */}
                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{r.obraNombre}</div>
                                                <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>{r.fecha}{r.auto ? ' · automático' : ' · manual'}</div>
                                            </div>
                                            {durMs ? (
                                                <div style={{ background: T.accentLight, borderRadius: 8, padding: "4px 10px", textAlign: "center", flexShrink: 0 }}>
                                                    <div style={{ fontSize: 13, fontWeight: 800, color: T.accent }}>{formatDuration(durMs)}</div>
                                                </div>
                                            ) : (
                                                <div style={{ background: "#ECFDF5", borderRadius: 8, padding: "4px 10px" }}>
                                                    <div style={{ fontSize: 11, fontWeight: 700, color: "#10B981" }}>● En obra</div>
                                                </div>
                                            )}
                                        </div>
                                        {/* Timeline entrada/salida */}
                                        <div style={{ display: "flex", gap: 0, alignItems: "center" }}>
                                            <div style={{ background: "#ECFDF5", border: "1px solid #86EFAC", borderRadius: "8px 0 0 8px", padding: "6px 12px", flex: 1 }}>
                                                <div style={{ fontSize: 9, color: "#15803D", fontWeight: 700, textTransform: "uppercase", marginBottom: 2 }}>Entrada</div>
                                                <div style={{ fontSize: 13, fontWeight: 800, color: "#15803D" }}>
                                                    {entrada ? entrada.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '—'}
                                                </div>
                                            </div>
                                            <div style={{ width: 28, height: 28, background: T.border, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.muted} strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                                            </div>
                                            <div style={{ background: salida ? "#FEF2F2" : "#FFFBEB", border: `1px solid ${salida ? "#FECACA" : "#FDE68A"}`, borderRadius: "0 8px 8px 0", padding: "6px 12px", flex: 1, textAlign: "right" }}>
                                                <div style={{ fontSize: 9, color: salida ? "#B91C1C" : "#92400E", fontWeight: 700, textTransform: "uppercase", marginBottom: 2 }}>Salida</div>
                                                <div style={{ fontSize: 13, fontWeight: 800, color: salida ? "#B91C1C" : "#92400E" }}>
                                                    {salida ? salida.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : 'En obra'}
                                                </div>
                                            </div>
                                        </div>
                                    </div>);
                                })
                            )}
                        </div>)}
                    </div>)}
                </Card>);
            })}
        </div>
        {showNew && (<Sheet title={t(cfg, 'pers_nuevo')} onClose={() => setShowNew(false)}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
                <input type="file" accept="image/*" ref={newFotoRef} style={{ display: "none" }} onChange={async e => { if (e.target.files[0]) { const url = await toDataUrl(e.target.files[0]); setForm(f => ({ ...f, foto: url })); } e.target.value = ""; }} />
                <div onClick={() => newFotoRef.current?.click()} style={{ width: 84, height: 84, borderRadius: "50%", cursor: "pointer", overflow: "hidden", background: form.foto ? "transparent" : T.bg, border: `2px dashed ${T.border}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {form.foto ? <img src={form.foto} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <div style={{ textAlign: "center" }}><div style={{ fontSize: 28 }}>📷</div><div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>Foto</div></div>}
                </div>
            </div>
            <Field label={t(cfg, 'pers_nombre')}><TInput value={form.nombre} onChange={e => setForm(p => ({ ...p, nombre: e.target.value }))} placeholder="Ej: Juan García" /></Field>
            <FieldRow>
                <Field label={t(cfg, 'pers_rol')}><Sel value={form.rol} onChange={e => setForm(p => ({ ...p, rol: e.target.value }))}>{ROLES.map(r => <option key={r}>{r}</option>)}</Sel></Field>
                <Field label={t(cfg, 'pers_empresa')}><TInput value={form.empresa} onChange={e => setForm(p => ({ ...p, empresa: e.target.value }))} placeholder="Belfast Obras" /></Field>
            </FieldRow>
            <Field label={t(cfg, 'pers_whatsapp')}><TInput value={form.telefono} onChange={e => setForm(p => ({ ...p, telefono: e.target.value.replace(/\D/g, '') }))} placeholder="5491155556666" /></Field>
            <Field label={t(cfg, 'pers_obra')}><Sel value={form.obra_id} onChange={e => setForm(p => ({ ...p, obra_id: e.target.value }))}><option value="">Sin asignar</option>{obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}</Sel></Field>
            <div style={{ background: "#F0F9FF", border: "1px solid #BAE6FD", borderRadius: 10, padding: "12px 14px", marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#0369A1", marginBottom: 8 }}>🔑 Acceso a la app</div>
                <FieldRow>
                    <Field label="Usuario"><TInput value={form.appUser || ''} onChange={e => setForm(p => ({ ...p, appUser: e.target.value.toLowerCase().trim() }))} placeholder="usuario" /></Field>
                    <Field label="Contraseña"><TInput value={form.appPass || ''} onChange={e => setForm(p => ({ ...p, appPass: e.target.value }))} placeholder="••••••" /></Field>
                </FieldRow>
                <Field label="Panel"><Sel value={form.nivel || 'empleado'} onChange={e => setForm(p => ({ ...p, nivel: e.target.value }))}><option value="empleado">👷 Empleado</option><option value="directivo">👔 Directivo</option><option value="cliente">👤 Cliente</option></Sel></Field>
            </div>
            <PBtn full onClick={add} disabled={!form.nombre.trim()}>{t(cfg, 'pers_agregar')}</PBtn>
        </Sheet>)}
    </div>);
}

// ── CARGAR (Registro de avance) ─────────────────────────────────────
function CargarView({ obras, setObras, cargarState, setCargarState, apiKey }) {
    const SP = localStorage.getItem('bop_auth_empresa') === 'vv' ? 'vv_' : 'bcm_';
    const { obraId, newFotos, report } = cargarState;
    const [loading, setLoading] = useState(false);
    const camRef = useRef(null); const galRef = useRef(null);
    const setObraId = v => setCargarState(s => ({ ...s, obraId: v, newFotos: [], report: '' }));
    const setNewFotos = fn => setCargarState(s => ({ ...s, newFotos: typeof fn === 'function' ? fn(s.newFotos) : fn }));
    const setReport = v => setCargarState(s => ({ ...s, report: v }));
    const obra = obras.find(o => o.id === obraId);
    const prevFotos = obra?.fotos || [];

    async function handleFotos(e) {
        for (const f of Array.from(e.target.files)) {
            const dataUrl = await toDataUrl(f);
            const fotoId = uid();
            // Subir al bucket — usar base64 localmente para el análisis IA, URL remota para guardar
            const url = await uploadFoto(dataUrl, `obras/${obraId || 'general'}`, fotoId);
            setNewFotos(p => [...p, { id: fotoId, url, urlLocal: dataUrl, nombre: f.name, fecha: new Date().toLocaleDateString('es-AR') }]);
        }
        e.target.value = '';
    }
    async function generateReport() {
        if (!obra || !newFotos.length) return;
        setLoading(true); setReport('');
        try {
            const content = [];
            const prevLim = prevFotos.slice(-4);
            const newLim = newFotos.slice(0, 16); // máximo 16 nuevas para no exceder el límite de la API (20 imágenes por turno)
            prevLim.forEach(f => { try { const src = f.urlLocal || f.url; if (src.startsWith('data:')) content.push({ type: 'image', source: { type: 'base64', media_type: getMediaType(src), data: getBase64(src) } }); } catch { } });
            newLim.forEach(f => { try { const src = f.urlLocal || f.url; if (src.startsWith('data:')) content.push({ type: 'image', source: { type: 'base64', media_type: getMediaType(src), data: getBase64(src) } }); } catch { } });
            const pTxt = prevFotos.length > 0 ? `Las primeras ${prevLim.length} imágenes son ANTERIORES y las siguientes ${newLim.length} son ACTUALES. Comparalas.` : `Las ${newLim.length} imágenes son del estado actual.`;
            const notaTruncado = newFotos.length > 16 ? `\n\n(Nota: se analizan solo 16 de las ${newFotos.length} fotos cargadas por límite de la API. El resto se guardará en la obra igualmente.)` : '';
            content.push({ type: 'text', text: `Generá informe de avance para "${obra.nombre}" (${AIRPORTS.find(a => a.id === obra.ap)?.code || obra.ap}). Avance: ${obra.avance}%. ${pTxt}${notaTruncado}

Incluí:
1. **Estado general**
2. **Trabajos observados**
3. **Comparación con el estado anterior** (si aplica)
4. **Alertas de seguridad**
5. **Recomendaciones**

Formato profesional AA2000, español rioplatense.` });

            if (!apiKey) { setReport('⚠ Configurá tu API Key en Más → Configuración.'); setLoading(false); return; }
            const headers = { "Content-Type": "application/json", "anthropic-dangerous-direct-browser-access": "true", "anthropic-version": "2023-06-01", "x-api-key": apiKey };
            const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 2000, messages: [{ role: "user", content }] }) });
            const d = await r.json();
            const reportText = d.content?.map(b => b.text || '').join('') || d.error?.message || 'Error al generar el informe.';
            setReport(reportText);

            // Agrupar las fotos en una "carpeta" por fecha (tag) y guardarlas TODAS en la obra
            const fechaTag = new Date().toLocaleDateString('es-AR');
            const fotosConTag = newFotos.map(f => ({ ...f, carpeta: fechaTag, fecha: fechaTag }));

            // Guardar el informe como archivo dentro de la obra
            const nuevoInforme = {
                id: uid(),
                titulo: `Informe de avance — ${fechaTag}`,
                tipo: 'diario',
                fecha: fechaTag,
                notas: `Generado automáticamente a partir de ${newFotos.length} fotos`,
                nombre: `informe_${fechaTag.replace(/\//g, '-')}.txt`,
                ext: 'IA',
                url: 'data:text/plain;base64,' + btoa(unescape(encodeURIComponent(reportText))),
                size: '—',
                cargado: fechaTag,
            };

            setObras(p => p.map(o => o.id === obraId ? {
                ...o,
                fotos: [...(o.fotos || []), ...fotosConTag],
                informes: [nuevoInforme, ...(o.informes || [])],
            } : o));
            setNewFotos([]);
        } catch (e) { setReport('Error de conexión: ' + (e.message || '')); }
        setLoading(false);
    }

    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title="Registro de Avance" sub="Fotos + Informe IA" />
        <div style={{ padding: "14px 18px" }}>
            <Card style={{ padding: "16px", marginBottom: 12 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}><div style={{ width: 28, height: 28, borderRadius: "50%", background: obraId ? T.accent : "#E2E8F0", color: obraId ? "#fff" : T.muted, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>1</div><span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Seleccioná la obra</span></div>
                <Sel value={obraId} onChange={e => setObraId(e.target.value)}><option value="">— Elegir obra —</option>{obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}</Sel>
                {obra && <div style={{ marginTop: 10, background: T.accentLight, borderRadius: 10, padding: "10px 12px" }}><div style={{ fontSize: 12, fontWeight: 700, color: T.accent }}>{obra.nombre}</div><div style={{ fontSize: 11, color: T.sub, marginTop: 2 }}>Avance: {obra.avance}% · {prevFotos.length} fotos anteriores</div></div>}
            </Card>
            {obra && (<Card style={{ padding: "16px", marginBottom: 12 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}><div style={{ width: 28, height: 28, borderRadius: "50%", background: T.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>2</div><span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Cargá fotos nuevas</span></div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                    <input ref={camRef} type="file" accept="image/*" capture="environment" multiple onChange={handleFotos} style={{ display: "none" }} />
                    <input ref={galRef} type="file" accept="image/*" multiple onChange={handleFotos} style={{ display: "none" }} />
                    <button onClick={() => camRef.current?.click()} style={{ background: "#111", border: "none", borderRadius: T.rsm, padding: "13px", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>📷 Tomar foto</button>
                    <button onClick={() => galRef.current?.click()} style={{ background: "#f8fafc", border: `1.5px solid ${T.border}`, borderRadius: T.rsm, padding: "13px", color: T.text, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>🖼️ Galería / PC</button>
                </div>
                {newFotos.length > 0 && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
                    {newFotos.map(f => (<div key={f.id} style={{ position: "relative", borderRadius: 9, overflow: "hidden", border: `1px solid ${T.border}` }}>
                        <img src={f.url} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover" }} />
                        <button onClick={() => setNewFotos(p => p.filter(x => x.id !== f.id))} style={{ position: "absolute", top: 3, right: 3, width: 20, height: 20, borderRadius: "50%", background: "rgba(0,0,0,.6)", border: "none", color: "#fff", fontSize: 11, cursor: "pointer" }}>×</button>
                    </div>))}
                </div>}
                {prevFotos.length > 0 && <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: T.muted, marginBottom: 6, textTransform: "uppercase" }}>Anteriores ({prevFotos.length})</div>
                    <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>{prevFotos.slice(-6).map(f => (<img key={f.id} src={f.url} alt="" style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 8, flexShrink: 0, border: `1px solid ${T.border}`, opacity: .6 }} />))}</div>
                </div>}
            </Card>)}
            {obra && (<Card style={{ padding: "16px", marginBottom: 12 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}><div style={{ width: 28, height: 28, borderRadius: "50%", background: T.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>3</div><span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Generar informe IA</span></div>
                <button onClick={generateReport} disabled={!newFotos.length || loading} style={{ width: "100%", background: newFotos.length && !loading ? T.accent : "#E2E8F0", border: "none", borderRadius: T.rsm, padding: "14px", fontSize: 14, fontWeight: 700, color: newFotos.length && !loading ? "#fff" : "#94A3B8", cursor: newFotos.length && !loading ? "pointer" : "not-allowed" }}>
                    {loading ? "Analizando..." : "Comparar y generar informe"}
                </button>
            </Card>)}
            {report && (<Card style={{ padding: "16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>✅ Informe generado</span>
                    <button onClick={() => { try { navigator.clipboard.writeText(report); } catch { } }} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "5px 10px", fontSize: 11, color: T.sub, cursor: "pointer" }}>📋 Copiar</button>
                </div>
                <div style={{ background: T.bg, borderRadius: T.rsm, padding: "14px", fontSize: 12, color: T.text, lineHeight: 1.7, whiteSpace: "pre-wrap", maxHeight: 280, overflowY: "auto" }}>{report}</div>
            </Card>)}
            {!obra && <div style={{ textAlign: "center", padding: "48px 0" }}><div style={{ fontSize: 40, marginBottom: 12 }}>📸</div><div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 6 }}>Registro Fotográfico</div><div style={{ fontSize: 12, color: T.muted }}>Seleccioná una obra para comenzar</div></div>}
        </div>
    </div>);
}

// ── PRESUPUESTO ──────────────────────────────────────────────────────
function PresupuestoView({ tipo, setView }) {
    const titulo = tipo === 'materiales' ? 'Presupuesto Materiales' : 'Subcontratos';
    const key = `bcm_presup_${tipo}`;
    const [items, setItems] = useStoredState(key, []);
    const [showNew, setShowNew] = useState(false);
    const [form, setForm] = useState({ descripcion: '', proveedor: '', monto: '', obra: '', estado: 'pendiente' });

    const ESTADOS = [{ id: 'pendiente', label: 'Pendiente', color: '#F59E0B', bg: '#FFFBEB' }, { id: 'revision', label: 'En revisión', color: '#3B82F6', bg: '#EFF6FF' }, { id: 'aprobado', label: 'Aprobado', color: '#10B981', bg: '#ECFDF5' }, { id: 'rechazado', label: 'Rechazado', color: '#EF4444', bg: '#FEF2F2' }];
    const total = items.reduce((s, i) => s + parseMontoNum(i.monto), 0);

    function add() {
        if (!form.descripcion.trim()) return;
        setItems(p => [...p, { ...form, id: uid(), fecha: new Date().toLocaleDateString('es-AR') }]);
        setForm({ descripcion: '', proveedor: '', monto: '', obra: '', estado: 'pendiente' });
        setShowNew(false);
    }

    return (<div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <AppHeader title={titulo} back onBack={() => setView('dashboard')} sub={`${items.length} ítems`} right={<PlusBtn onClick={() => setShowNew(true)} />} />
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px", paddingBottom: 80 }}>
            <Card style={{ padding: "16px", marginBottom: 14, background: T.navy, color: "#fff", border: "none" }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,.6)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>Total {tipo}</div>
                <div style={{ fontSize: 26, fontWeight: 800 }}>${total.toLocaleString('es-AR')}</div>
            </Card>
            {items.length === 0 ? <div style={{ textAlign: "center", padding: "40px 0", color: T.muted, fontSize: 13 }}>Tocá + para agregar</div> :
                ESTADOS.map(est => {
                    const ei = items.filter(i => i.estado === est.id);
                    if (!ei.length) return null;
                    return (<div key={est.id} style={{ marginBottom: 16 }}>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}><div style={{ width: 7, height: 7, borderRadius: "50%", background: est.color }} /><span style={{ fontSize: 11, fontWeight: 700, color: est.color, textTransform: "uppercase", letterSpacing: "0.06em" }}>{est.label}</span></div>
                        {ei.map(item => (<Card key={item.id} style={{ padding: "13px 14px", marginBottom: 8 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                                <div style={{ flex: 1, paddingRight: 8 }}>
                                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{item.descripcion}</div>
                                    {item.proveedor && <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>{item.proveedor}{item.obra ? ` · ${item.obra}` : ""}</div>}
                                </div>
                                <div style={{ fontSize: 14, fontWeight: 800, color: T.accent, flexShrink: 0 }}>{item.monto || "—"}</div>
                            </div>
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                {ESTADOS.map(e => (<button key={e.id} onClick={() => setItems(p => p.map(i => i.id === item.id ? { ...i, estado: e.id } : i))} style={{ padding: "3px 8px", borderRadius: 20, border: `1.5px solid ${item.estado === e.id ? e.color : T.border}`, background: item.estado === e.id ? e.bg : T.card, color: e.color, fontSize: 9, fontWeight: 700, cursor: "pointer" }}>{e.label}</button>))}
                                <button onClick={() => setItems(p => p.filter(i => i.id !== item.id))} style={{ padding: "3px 8px", borderRadius: 20, border: "1px solid #FECACA", background: "#FEF2F2", color: "#EF4444", fontSize: 9, fontWeight: 700, cursor: "pointer", marginLeft: "auto" }}>✕</button>
                            </div>
                        </Card>))}
                    </div>);
                })}
        </div>
        {showNew && (<Sheet title={`Nuevo – ${titulo}`} onClose={() => setShowNew(false)}>
            <Field label="Descripción"><TInput value={form.descripcion} onChange={e => setForm(p => ({ ...p, descripcion: e.target.value }))} placeholder={tipo === 'materiales' ? "Cemento Portland" : "Subcontrato pintura"} /></Field>
            <FieldRow>
                <Field label={tipo === 'materiales' ? "Proveedor" : "Empresa"}><TInput value={form.proveedor} onChange={e => setForm(p => ({ ...p, proveedor: e.target.value }))} placeholder="Holcim" /></Field>
                <Field label="Monto"><MontoInput value={form.monto} onChange={v => setForm(p => ({ ...p, monto: v }))} placeholder="0 $" /></Field>
            </FieldRow>
            <Field label="Obra"><TInput value={form.obra} onChange={e => setForm(p => ({ ...p, obra: e.target.value }))} placeholder="Terminal A" /></Field>
            <Field label="Estado"><Sel value={form.estado} onChange={e => setForm(p => ({ ...p, estado: e.target.value }))}>{ESTADOS.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</Sel></Field>
            <PBtn full onClick={add} disabled={!form.descripcion.trim()}>Agregar</PBtn>
        </Sheet>)}
    </div>);
}

// ── VIGILANCIA · PRESENTISMO ─────────────────────────────────────────
function PanelVigilancia({ setView }) {
    const [camaras, setCamaras] = useStoredState(('bop_')+'camaras', []);
    const [showNew, setShowNew] = useState(false);
    const [form, setForm] = useState({ nombre: '', url: '', sector: '', ap: 'aep', tipo: 'ip' });
    function add() { if (!form.nombre || !form.url) return; setCamaras(p => [...p, { ...form, id: uid() }]); setForm({ nombre: '', url: '', sector: '', ap: 'aep', tipo: 'ip' }); setShowNew(false); }

    return (<div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <AppHeader title="Panel de Vigilancia" back onBack={() => setView("mas")} sub="Cámaras en vivo" right={<PlusBtn onClick={() => setShowNew(true)} />} />
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px", paddingBottom: 80 }}>
            <div style={{ background: T.navy, borderRadius: 14, padding: "16px", marginBottom: 16, color: "#fff" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}><div style={{ width: 10, height: 10, borderRadius: "50%", background: "#22c55e", animation: "pulse 2s infinite" }} /><span style={{ fontSize: 13, fontWeight: 700 }}>Sistema activo</span></div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    {[{ l: "Total", v: camaras.length }, { l: "AEP", v: camaras.filter(c => c.ap === "aep").length }, { l: "EZE", v: camaras.filter(c => c.ap === "eze").length }].map(k => (<div key={k.l} style={{ background: "rgba(255,255,255,.1)", borderRadius: 8, padding: "8px", textAlign: "center" }}><div style={{ fontSize: 20, fontWeight: 800 }}>{k.v}</div><div style={{ fontSize: 9, color: "rgba(255,255,255,.6)", marginTop: 2 }}>{k.l}</div></div>))}
                </div>
            </div>
            {camaras.length === 0 ? <div style={{ textAlign: "center", padding: "40px 0", color: T.muted, fontSize: 13 }}>Sin cámaras configuradas</div> :
                camaras.map(cam => (<Card key={cam.id} style={{ padding: "14px 16px", marginBottom: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ width: 46, height: 46, borderRadius: 10, background: T.navy, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 20 }}>📹</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{cam.nombre}</div>
                            <div style={{ fontSize: 11, color: T.muted }}>{AIRPORTS.find(a => a.id === cam.ap)?.code} · {cam.sector || "—"} · {cam.tipo?.toUpperCase()}</div>
                        </div>
                        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                            <a href={cam.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}><button style={{ background: T.accent, border: "none", borderRadius: 8, width: 34, height: 34, cursor: "pointer", color: "#fff" }}>↗</button></a>
                            <button onClick={() => setCamaras(p => p.filter(c => c.id !== cam.id))} style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, width: 34, height: 34, cursor: "pointer", color: "#EF4444", fontSize: 14 }}>✕</button>
                        </div>
                    </div>
                </Card>))}
        </div>
        {showNew && (<Sheet title="Agregar cámara" onClose={() => setShowNew(false)}>
            <Field label="Nombre"><TInput value={form.nombre} onChange={e => setForm(p => ({ ...p, nombre: e.target.value }))} placeholder="Cámara Terminal A" /></Field>
            <Field label="URL"><TInput value={form.url} onChange={e => setForm(p => ({ ...p, url: e.target.value }))} placeholder="http://192.168.1.100:8080" /></Field>
            <FieldRow>
                <Field label="Aeropuerto"><Sel value={form.ap} onChange={e => setForm(p => ({ ...p, ap: e.target.value }))}>{AIRPORTS.map(a => <option key={a.id} value={a.id}>{a.code}</option>)}</Sel></Field>
                <Field label="Sistema"><Sel value={form.tipo} onChange={e => setForm(p => ({ ...p, tipo: e.target.value }))}><option value="ip">Cámara IP</option><option value="nvr">NVR Web</option><option value="hikvision">Hikvision</option><option value="dahua">Dahua</option></Sel></Field>
            </FieldRow>
            <Field label="Sector"><TInput value={form.sector} onChange={e => setForm(p => ({ ...p, sector: e.target.value }))} placeholder="Terminal A" /></Field>
            <PBtn full onClick={add} disabled={!form.nombre || !form.url}>Agregar cámara</PBtn>
        </Sheet>)}
    </div>);
}

// Helpers GPS
function distanciaMetros(lat1, lon1, lat2, lon2) {
    const R = 6371000; // metros
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}
function formatDuration(ms) {
    if (!ms || ms < 0) return '—';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
}
async function getCurrentPosition() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) { reject(new Error('Geolocalización no soportada')); return; }
        navigator.geolocation.getCurrentPosition(
            pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
            err => reject(err),
            { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
        );
    });
}

function Presentismo({ personal, setPersonal, obras, setObras, currentUser, setView }) {
    const [presentismoData, setPresentismoData] = useStoredState(('bop_')+'presentismo', { registros: {}, bioLink: '', trackingAuto: false });
    const registros = presentismoData.registros || {};
    const bioLink = presentismoData.bioLink || '';
    const trackingAuto = !!presentismoData.trackingAuto;
    function setRegistros(fn) { setPresentismoData(d => ({ ...d, registros: typeof fn === 'function' ? fn(d.registros || {}) : fn })); }
    function setBioLink(v) { setPresentismoData(d => ({ ...d, bioLink: v })); }
    function setTrackingAuto(v) { setPresentismoData(d => ({ ...d, trackingAuto: typeof v === 'function' ? v(d.trackingAuto) : v })); }
    const [gpsLoading, setGpsLoading] = useState(false);
    const [gpsMsg, setGpsMsg] = useState(null);
    const [showObraConfig, setShowObraConfig] = useState(null);
    const watchRef = useRef(null);

    const today = new Date().toLocaleDateString('es-AR');
    const todayKey = today;

    // Identificar al usuario actual dentro del personal
    const miPersona = currentUser && !isDirectivo(currentUser)
        ? personal.find(p => p.appUser === (currentUser.user || currentUser.appUser))
        : null;
    const obrasConGPS = obras.filter(o => o.lat && o.lng);

    // Tracking automático: comprueba cada 60s si estoy cerca de alguna obra
    useEffect(() => {
        if (!trackingAuto || !miPersona) {
            if (watchRef.current) { clearInterval(watchRef.current); watchRef.current = null; }
            return;
        }
        async function check() {
            try {
                const pos = await getCurrentPosition();
                // Encontrar obra más cercana dentro del radio
                let obraCercana = null, distMin = Infinity;
                for (const o of obrasConGPS) {
                    const d = distanciaMetros(pos.lat, pos.lng, parseFloat(o.lat), parseFloat(o.lng));
                    if (d < (o.radio || 100) && d < distMin) { obraCercana = o; distMin = d; }
                }
                const key = `${miPersona.id}_${todayKey}`;
                setRegistros(r => {
                    const cur = r[key] || { nombre: miPersona.nombre, sesiones: [] };
                    const sesiones = cur.sesiones || [];
                    const abierta = sesiones.find(s => !s.fin);
                    if (obraCercana) {
                        // Estoy en obra
                        if (!abierta || abierta.obraId !== obraCercana.id) {
                            // Cerrar sesión abierta si existía
                            if (abierta) abierta.fin = Date.now();
                            sesiones.push({ id: uid(), obraId: obraCercana.id, obraNombre: obraCercana.nombre, inicio: Date.now(), fin: null, lat: pos.lat, lng: pos.lng, auto: true });
                        }
                    } else if (abierta) {
                        // Salí de la obra
                        abierta.fin = Date.now();
                    }
                    return { ...r, [key]: { ...cur, sesiones } };
                });
            } catch { }
        }
        check();
        watchRef.current = setInterval(check, 60000);
        return () => { if (watchRef.current) clearInterval(watchRef.current); };
    }, [trackingAuto, miPersona?.id, obrasConGPS.length]);

    async function checkInManual(personaId, obraId) {
        setGpsLoading(true); setGpsMsg(null);
        try {
            const persona = personal.find(p => p.id === personaId);
            const obra = obras.find(o => o.id === obraId);
            if (!obra) throw new Error('Obra no encontrada');
            const pos = await getCurrentPosition();
            let distancia = null;
            if (obra.lat && obra.lng) {
                distancia = distanciaMetros(pos.lat, pos.lng, parseFloat(obra.lat), parseFloat(obra.lng));
                if (distancia > (obra.radio || 100)) {
                    setGpsMsg({ tipo: 'error', txt: `Estás a ${Math.round(distancia)}m de la obra (radio permitido: ${obra.radio || 100}m). No se registra.` });
                    setGpsLoading(false);
                    return;
                }
            }
            const key = `${personaId}_${todayKey}`;
            const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
            setRegistros(r => {
                const cur = r[key] || { nombre: persona.nombre, sesiones: [] };
                const sesiones = cur.sesiones || [];
                const abierta = sesiones.find(s => !s.fin);
                if (abierta) {
                    abierta.fin = Date.now();
                    return { ...r, [key]: { ...cur, sesiones } };
                } else {
                    sesiones.push({ id: uid(), obraId, obraNombre: obra.nombre, inicio: Date.now(), fin: null, lat: pos.lat, lng: pos.lng, auto: false, hora });
                    return { ...r, [key]: { ...cur, sesiones } };
                }
            });
            const abiertaAntes = (registros[key]?.sesiones || []).find(s => !s.fin);
            setGpsMsg({ tipo: 'ok', txt: abiertaAntes ? `Salida registrada a las ${hora}${distancia !== null ? ` (a ${Math.round(distancia)}m de la obra)` : ''}` : `Entrada registrada en ${obra.nombre} a las ${hora}${distancia !== null ? ` (a ${Math.round(distancia)}m)` : ''}` });
        } catch (e) {
            setGpsMsg({ tipo: 'error', txt: 'No se pudo obtener tu ubicación. ' + (e.message || '') });
        }
        setGpsLoading(false);
    }

    async function fijarUbicacionObra(obraId) {
        setGpsLoading(true); setGpsMsg(null);
        try {
            const pos = await getCurrentPosition();
            setObras(p => p.map(o => o.id === obraId ? { ...o, lat: pos.lat.toFixed(6), lng: pos.lng.toFixed(6), radio: o.radio || 150 } : o));
            setGpsMsg({ tipo: 'ok', txt: `Ubicación guardada: ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` });
        } catch (e) {
            setGpsMsg({ tipo: 'error', txt: 'No se pudo obtener ubicación. ' + (e.message || '') });
        }
        setGpsLoading(false);
    }

    const registrosHoy = Object.entries(registros).filter(([k]) => k.endsWith(todayKey));

    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title="Presentismo GPS" back onBack={() => setView("mas")} sub="Geolocalización · Check-in" right={
            <button onClick={() => setShowObraConfig(true)} title="Configurar obras" style={{ background: T.accentLight, border: `1px solid ${T.accent}`, borderRadius: 8, padding: "6px 10px", fontSize: 11, fontWeight: 700, color: T.accent, cursor: "pointer" }}>
                Obras GPS
            </button>
        } />
        <div style={{ padding: "14px 18px" }}>
            {gpsMsg && <div style={{ background: gpsMsg.tipo === 'ok' ? "#ECFDF5" : "#FEF2F2", border: `1px solid ${gpsMsg.tipo === 'ok' ? "#86EFAC" : "#FECACA"}`, borderRadius: 10, padding: "10px 14px", fontSize: 12, color: gpsMsg.tipo === 'ok' ? "#15803D" : "#EF4444", fontWeight: 600, marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{gpsMsg.txt}</span>
                <button onClick={() => setGpsMsg(null)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 15 }}>✕</button>
            </div>}

            {/* Tracking auto toggle (solo si sos el empleado logueado) */}
            {miPersona && (<Card style={{ padding: "14px 16px", marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Tracking automático</div>
                        <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>Registra tu presencia cada minuto</div>
                    </div>
                    <button onClick={() => setTrackingAuto(v => !v)} style={{ width: 48, height: 28, borderRadius: 14, background: trackingAuto ? "#10B981" : T.border, border: "none", cursor: "pointer", position: "relative", transition: "all .2s" }}>
                        <div style={{ position: "absolute", top: 2, left: trackingAuto ? 22 : 2, width: 24, height: 24, borderRadius: "50%", background: "#fff", boxShadow: "0 2px 4px rgba(0,0,0,.2)", transition: "all .2s" }} />
                    </button>
                </div>
                {trackingAuto && <div style={{ background: "#ECFDF5", borderRadius: 8, padding: "8px 12px", fontSize: 11, color: "#15803D", marginTop: 6 }}>
                    ● Tracking activo. Tu ubicación se chequea cada 60 segundos.
                </div>}
            </Card>)}

            {/* Mi check-in (si soy empleado) */}
            {miPersona && obrasConGPS.length > 0 && (<Card style={{ padding: "16px", marginBottom: 12 }}>
                <Lbl>Mi check-in manual</Lbl>
                <div style={{ fontSize: 12, color: T.sub, marginBottom: 12 }}>Seleccioná la obra en la que estás:</div>
                <div style={{ display: "grid", gap: 8 }}>
                    {obrasConGPS.map(o => {
                        const key = `${miPersona.id}_${todayKey}`;
                        const abierta = (registros[key]?.sesiones || []).find(s => !s.fin && s.obraId === o.id);
                        return (<button key={o.id} onClick={() => checkInManual(miPersona.id, o.id)} disabled={gpsLoading} style={{ background: abierta ? "#FFFBEB" : T.bg, border: `1.5px solid ${abierta ? "#FDE68A" : T.border}`, borderRadius: T.rsm, padding: "12px 14px", textAlign: "left", cursor: gpsLoading ? "wait" : "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                                <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{o.nombre}</div>
                                <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>Radio: {o.radio || 100}m</div>
                            </div>
                            <span style={{ fontSize: 11, fontWeight: 700, color: abierta ? "#92400E" : T.accent, background: abierta ? "#FDE68A" : T.accentLight, padding: "4px 10px", borderRadius: 20 }}>
                                {gpsLoading ? 'GPS...' : abierta ? 'Salir' : 'Entrar'}
                            </span>
                        </button>);
                    })}
                </div>
            </Card>)}

            {/* Sistema biométrico externo */}
            <Card style={{ padding: "14px 16px", marginBottom: 12 }}>
                <Lbl>Sistema biométrico externo (opcional)</Lbl>
                <div style={{ display: "flex", gap: 8 }}>
                    <TInput value={bioLink} onChange={e => setBioLink(e.target.value)} placeholder="https://sistema-biometrico.com" />
                    {bioLink && <a href={bioLink} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none", flexShrink: 0 }}><button style={{ background: T.navy, border: "none", borderRadius: T.rsm, padding: "11px 14px", fontSize: 12, fontWeight: 700, color: "#fff", cursor: "pointer" }}>Abrir →</button></a>}
                </div>
            </Card>

            {/* Panel admin: check-in de cualquiera */}
            {isDirectivo(currentUser) && obrasConGPS.length > 0 && personal.length > 0 && (<Card style={{ padding: "14px 16px", marginBottom: 12 }}>
                <Lbl>Check-in rápido (administrador)</Lbl>
                <div style={{ fontSize: 11, color: T.muted, marginBottom: 10 }}>Toca un trabajador para marcar entrada/salida manual:</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    {personal.map(p => {
                        const key = `${p.id}_${todayKey}`;
                        const sesiones = registros[key]?.sesiones || [];
                        const abierta = sesiones.find(s => !s.fin);
                        const totalMs = sesiones.reduce((t, s) => t + ((s.fin || Date.now()) - s.inicio), 0);
                        return (<div key={p.id} style={{ background: abierta ? "#ECFDF5" : T.bg, border: `1.5px solid ${abierta ? "#86EFAC" : T.border}`, borderRadius: T.rsm, padding: "9px 10px" }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 2 }}>{p.nombre.split(' ')[0]}</div>
                            <div style={{ fontSize: 9, color: T.muted, marginBottom: 5 }}>{p.rol} · {formatDuration(totalMs)}</div>
                            <div style={{ fontSize: 9, color: abierta ? "#15803D" : T.muted, fontWeight: 700 }}>{abierta ? `● En ${abierta.obraNombre}` : sesiones.length ? `${sesiones.length} sesión(es)` : 'Sin registro'}</div>
                        </div>);
                    })}
                </div>
            </Card>)}

            {/* Resumen del día */}
            {registrosHoy.length > 0 && (<Card style={{ padding: "14px 16px" }}>
                <Lbl>Jornada · {today}</Lbl>
                {registrosHoy.map(([k, v]) => {
                    const ses = v.sesiones || [];
                    const totalMs = ses.reduce((t, s) => t + ((s.fin || Date.now()) - s.inicio), 0);
                    const abierta = ses.find(s => !s.fin);
                    return (<div key={k} style={{ padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                            <span style={{ fontSize: 13, color: T.text, fontWeight: 700 }}>{v.nombre}</span>
                            <span style={{ fontSize: 12, color: abierta ? "#10B981" : T.sub, fontWeight: 700 }}>{formatDuration(totalMs)}{abierta ? ' · en obra' : ''}</span>
                        </div>
                        {ses.map(s => (<div key={s.id} style={{ fontSize: 10, color: T.muted, marginLeft: 6 }}>
                            → {s.obraNombre} · {new Date(s.inicio).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                            {s.fin ? ` – ${new Date(s.fin).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}` : ' – ahora'}
                            {s.auto ? ' (auto)' : ''}
                        </div>))}
                    </div>);
                })}
            </Card>)}
        </div>

        {/* Sheet: configurar ubicación de obras */}
        {showObraConfig && (<Sheet title="Obras con GPS" onClose={() => setShowObraConfig(null)}>
            <div style={{ fontSize: 12, color: T.sub, marginBottom: 14, lineHeight: 1.5 }}>Parate en cada obra y tocá <b>Fijar acá</b> para guardar las coordenadas. Después podés ajustar el radio permitido (en metros) para el check-in.</div>
            {obras.length === 0 && <div style={{ textAlign: "center", padding: "20px 0", color: T.muted, fontSize: 13 }}>No hay obras aún</div>}
            {obras.map(o => (<div key={o.id} style={{ background: T.bg, borderRadius: T.rsm, padding: "12px 14px", marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{o.nombre}</div>
                        <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>{o.lat && o.lng ? `📍 ${o.lat}, ${o.lng}` : 'Sin GPS configurado'}</div>
                    </div>
                    <button onClick={() => fijarUbicacionObra(o.id)} disabled={gpsLoading} style={{ background: T.accent, border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 700, color: "#fff", cursor: gpsLoading ? "wait" : "pointer", flexShrink: 0, height: 32 }}>
                        {gpsLoading ? '...' : 'Fijar acá'}
                    </button>
                </div>
                {o.lat && <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: T.sub }}>Radio (m):</span>
                    <input type="number" value={o.radio || 100} onChange={e => setObras(p => p.map(x => x.id === o.id ? { ...x, radio: parseInt(e.target.value) || 100 } : x))} min="10" max="2000" style={{ flex: 1, background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, padding: "5px 10px", fontSize: 12, color: T.text }} />
                    <button onClick={() => setObras(p => p.map(x => x.id === o.id ? { ...x, lat: null, lng: null, radio: null } : x))} style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 6, padding: "5px 10px", fontSize: 11, color: "#EF4444", cursor: "pointer" }}>Borrar</button>
                </div>}
            </div>))}
        </Sheet>)}
    </div>);
}

// ── ARCHIVOS · SEGUIMIENTO · RESUMEN ────────────────────────────────
function Archivos({ setView }) {
    const [files, setFiles] = useStoredState(('bop_')+'archivos', []);
    const inputRef = useRef(null);

    async function handleUp(e) {
        const nuevos = [...files];
        for (const f of Array.from(e.target.files)) {
            const url = await toDataUrl(f);
            nuevos.push({ id: uid(), nombre: f.name, ext: f.name.split(".").pop().toUpperCase(), url, fecha: new Date().toLocaleDateString("es-AR"), size: (f.size / 1024).toFixed(0) + "KB" });
        }
        setFiles(nuevos);
        e.target.value = "";
    }

    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title="Archivos" back onBack={() => setView("mas")} right={<><input type="file" ref={inputRef} multiple onChange={handleUp} style={{ display: "none" }} /><PlusBtn onClick={() => inputRef.current?.click()} /></>} />
        <div style={{ padding: "12px 18px" }}>
            {files.length === 0 ? <div style={{ textAlign: "center", padding: "40px 0", color: T.muted, fontSize: 13 }}>Subí tu primer archivo</div> :
                files.map(f => (<div key={f.id} style={{ display: "flex", alignItems: "center", gap: 11, background: T.card, border: `1px solid ${T.border}`, borderRadius: T.rsm, padding: "11px 13px", marginBottom: 7 }}>
                    <div style={{ width: 38, height: 38, borderRadius: 9, background: T.accentLight, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><span style={{ fontSize: 9, fontWeight: 800, color: T.accent }}>{f.ext}</span></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.nombre}</div>
                        <div style={{ fontSize: 10, color: T.muted }}>{f.size} · {f.fecha}</div>
                    </div>
                    <a href={f.url} download={f.nombre} style={{ textDecoration: "none" }}><button style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, width: 30, height: 30, fontSize: 13, color: T.sub, cursor: "pointer" }}>↓</button></a>
                    <button onClick={() => setFiles(files.filter(x => x.id !== f.id))} style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, width: 30, height: 30, fontSize: 12, color: "#EF4444", cursor: "pointer" }}>✕</button>
                </div>))}
        </div>
    </div>);
}

function Seguimiento({ alerts, setAlerts, setView }) {
    function dismiss(id) { setAlerts(p => p.filter(a => a.id !== id)); }
    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title="Seguimiento" back onBack={() => setView("mas")} />
        <div style={{ padding: "14px 18px" }}>
            {["alta", "media"].map(prio => alerts.filter(a => a.prioridad === prio).length > 0 && (
                <div key={prio} style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: prio === "alta" ? "#EF4444" : "#F59E0B", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>{prio === "alta" ? "Crítico" : "Atención"}</div>
                    {alerts.filter(a => a.prioridad === prio).map(a => (<div key={a.id} style={{ background: prio === "alta" ? "#FEF2F2" : "#FFFBEB", border: `1px solid ${prio === "alta" ? "#FECACA" : "#FDE68A"}`, borderRadius: 10, padding: "11px 13px", marginBottom: 6, display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ flex: 1, fontSize: 12, color: T.text, lineHeight: 1.4 }}>{a.msg}</div>
                        <button onClick={() => dismiss(a.id)} style={{ background: "none", border: "none", fontSize: 14, color: T.muted, cursor: "pointer" }}>✕</button>
                    </div>))}
                </div>
            ))}
            {alerts.length === 0 && <div style={{ textAlign: "center", padding: "60px 0" }}><div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 6 }}>✅ Todo en orden</div><div style={{ fontSize: 13, color: T.muted }}>Sin alertas</div></div>}
        </div>
    </div>);
}

function ResumenView({ lics, obras, personal, alerts, setView }) {
    const kpis = [{ label: "Licitaciones", val: lics.filter(l => !['adjudicada', 'descartada'].includes(l.estado)).length, color: "#3B82F6" }, { label: "Obras activas", val: obras.filter(o => o.estado === "curso").length, color: "#10B981" }, { label: "Personal", val: personal.length, color: "#8B5CF6" }, { label: "Alertas", val: alerts.length, color: "#EF4444" }];
    const obrasEnCurso = obras.filter(o => o.estado === "curso");
    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title="Resumen Ejecutivo" back onBack={() => setView("mas")} />
        <div style={{ padding: "14px 18px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
                {kpis.map(k => (<Card key={k.label} style={{ padding: "14px", textAlign: "center" }}><div style={{ fontSize: 28, fontWeight: 800, color: k.color }}>{k.val}</div><div style={{ fontSize: 10, color: T.muted, lineHeight: 1.3, marginTop: 2 }}>{k.label}</div></Card>))}
            </div>
            {obrasEnCurso.length > 0 && <Card style={{ padding: "14px 16px", marginBottom: 12 }}>
                <Lbl>Avance y presupuesto por obra</Lbl>
                {obrasEnCurso.map(o => {
                    const ec = OBRA_ESTADOS.find(e => e.id === o.estado) || OBRA_ESTADOS[0];
                    const lic = lics.find(l => l.id === o.lic_id);
                    const presupTotal = parseMontoNum(lic?.monto || o.monto);
                    // Pagado = suma de todos los gastos cargados
                    const pagado = (o.gastos || []).reduce((s, g) => s + parseMontoNum(g.monto), 0);
                    const pct = presupTotal > 0 ? Math.min(100, Math.round(pagado / presupTotal * 100)) : o.avance;
                    return (<div key={o.id} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: `1px solid ${T.border}` }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                            <span style={{ fontSize: 12, color: T.text, fontWeight: 600 }}>{o.nombre}</span>
                            <span style={{ fontSize: 13, fontWeight: 800, color: ec.color }}>{o.avance}%</span>
                        </div>
                        <div style={{ height: 7, background: T.bg, borderRadius: 4, marginBottom: 6 }}>
                            <div style={{ height: 7, background: ec.color, borderRadius: 4, width: `${o.avance}%`, transition: "width .6s" }} />
                        </div>
                        {presupTotal > 0 && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                            <span style={{ color: T.muted }}>Presupuesto: <b style={{ color: T.text }}>${presupTotal.toLocaleString('es-AR')}</b></span>
                            <span style={{ color: pct > 80 ? "#EF4444" : "#10B981", fontWeight: 700 }}>Consumido: {pct}%</span>
                        </div>}
                    </div>);
                })}
            </Card>}
        </div>
    </div>);
}

// ── COTIZACIÓN IA ─────────────────────────────────────────────────────
function CotizacionView({ setView, apiKey, cfg }) {
    const [foto, setFoto] = useState(null);
    const [superficie, setSuperficie] = useState('');
    const [zona, setZona] = useState('');
    const [tipologia, setTipologia] = useState('refaccion');
    const [loading, setLoading] = useState(false);
    const [resultado, setResultado] = useState(null);
    const [historial, setHistorial] = useStoredState(('bop_')+'cotizaciones', []);
    const camRef = useRef(null);
    const galRef = useRef(null);

    const TIPOLOGIAS = [
        { id: 'refaccion', label: 'Refacción' },
        { id: 'demolicion', label: 'Demolición' },
        { id: 'construccion', label: 'Construcción nueva' },
        { id: 'pintura', label: 'Pintura' },
        { id: 'instalaciones', label: 'Instalaciones' },
        { id: 'terminaciones', label: 'Terminaciones' },
        { id: 'estructura', label: 'Estructura' },
        { id: 'exterior', label: 'Exterior/Fachada' },
    ];

    async function handleFoto(e) {
        const f = e.target.files?.[0]; if (!f) return;
        setFoto({ url: await toDataUrl(f), name: f.name });
        e.target.value = '';
    }

    async function cotizar() {
        if (!apiKey) { alert('Configurá tu API Key en Más → Configuración'); return; }
        setLoading(true); setResultado(null);
        try {
            const hoy = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
            const promptBase = `Sos un experto en costos de construcción en Argentina. Hoy es ${hoy}.

Tipología de trabajo: ${TIPOLOGIAS.find(t => t.id === tipologia)?.label || tipologia}
${superficie ? `Superficie aproximada: ${superficie} m²` : ''}
${zona ? `Zona/Localidad: ${zona}` : 'Zona: Buenos Aires / AMBA'}

${foto ? 'Analizá la imagen adjunta para identificar el tipo y estado del espacio.' : ''}

Generá una cotización profesional detallada incluyendo:

## 1. ANÁLISIS DEL TRABAJO
Describí qué tipo de trabajo se requiere basándote en ${foto ? 'la imagen' : 'la tipología indicada'}.

## 2. PRECIOS DE MATERIALES (Argentina, ${hoy})
Lista los materiales principales con precio unitario actualizado. Tomá como referencia:
- Revista Cifras (valores publicados este mes)
- MercadoLibre Argentina (precios de vendedores destacados)
- Catálogos de Sodimac, Easy, Ferreterías del país
Formato: | Material | Unidad | Precio unitario | Cantidad est. | Subtotal |

## 3. MANO DE OBRA
- Precio por m² según gremio correspondiente
- Jornal oficial actualizado (CCT vigente Argentina)
- Horas estimadas de trabajo

## 4. RESUMEN DE COSTOS
| Rubro | Costo por m² | Total estimado |
|-------|-------------|----------------|
| Materiales | | |
| Mano de obra | | |
| Gastos indirectos (15%) | | |
| **TOTAL** | | |

## 5. RANGO DE PRECIOS
- Mínimo (categoría económica): $X/m²
- Estándar (calidad media): $X/m²  
- Premium (primera calidad): $X/m²

## 6. OBSERVACIONES
Alertas de precios, variaciones regionales, plazos estimados.

Todos los precios en PESOS ARGENTINOS ($). Indicá la fuente de referencia de cada precio.`;

            const msgs = foto
                ? [{ role: 'user', content: [
                    { type: 'image', source: { type: 'base64', media_type: getMediaType(foto.url), data: getBase64(foto.url) } },
                    { type: 'text', text: promptBase }
                ]}]
                : [{ role: 'user', content: promptBase }];

            // useSearch=true: busca en internet precios reales de Argentina
            const texto = await callAI(
                msgs,
                `Sos un experto en costos de construcción en Argentina. Siempre buscá en internet los precios actualizados antes de responder. Fuentes: MercadoLibre Argentina, Sodimac, Easy, Ferreterías, Revista Cifras de Arquitectura. Respondé en español rioplatense con precios reales en pesos argentinos.`,
                apiKey, true
            );

            const nueva = {
                id: uid(),
                fecha: new Date().toLocaleDateString('es-AR'),
                hora: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
                tipologia: TIPOLOGIAS.find(t => t.id === tipologia)?.label,
                zona: zona || 'AMBA',
                superficie: superficie || '—',
                foto: foto?.url || null,
                texto,
            };
            setResultado(nueva);
            setHistorial(h => [nueva, ...h].slice(0, 20));
        } catch (e) {
            setResultado({ id: uid(), texto: 'Error: ' + e.message, fecha: new Date().toLocaleDateString('es-AR') });
        }
        setLoading(false);
    }

    function descargarPDF(item) {
        const contenido = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Cotización BelfastCM</title>
<style>
  body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;padding:0 30px;color:#1a1a1a;font-size:13px;line-height:1.6}
  h1{color:#1D4ED8;font-size:22px;border-bottom:3px solid #1D4ED8;padding-bottom:10px;margin-bottom:6px}
  .meta{color:#666;font-size:12px;margin-bottom:24px}
  h2{color:#1D4ED8;font-size:15px;margin-top:24px;margin-bottom:8px;border-left:4px solid #1D4ED8;padding-left:10px}
  table{width:100%;border-collapse:collapse;margin:10px 0}
  th{background:#1D4ED8;color:#fff;padding:8px 10px;text-align:left;font-size:12px}
  td{padding:7px 10px;border-bottom:1px solid #e5e7eb;font-size:12px}
  tr:nth-child(even) td{background:#f8fafc}
  .footer{margin-top:40px;padding-top:16px;border-top:2px solid #e5e7eb;font-size:11px;color:#9ca3af;text-align:center}
  pre{white-space:pre-wrap;font-family:Arial,sans-serif;font-size:12px}
</style>
</head>
<body>
<h1>Cotización de Obra</h1>
<div class="meta">
  <b>BelfastCM × AA2000</b> &nbsp;|&nbsp; Fecha: ${item.fecha} ${item.hora || ''} &nbsp;|&nbsp;
  Tipología: ${item.tipologia || '—'} &nbsp;|&nbsp; Zona: ${item.zona || 'AMBA'} &nbsp;|&nbsp; Superficie: ${item.superficie || '—'} m²
</div>
${item.foto ? `<img src="${item.foto}" style="max-width:100%;max-height:280px;object-fit:contain;border-radius:8px;margin-bottom:20px;border:1px solid #e5e7eb">` : ''}
<div>${item.texto
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\|(.+)\|/g, (m) => {
        const cells = m.split('|').filter(c => c.trim());
        const isHeader = cells.every(c => /^[-\s]+$/.test(c.trim()));
        if (isHeader) return '';
        return '<tr>' + cells.map(c => `<td>${c.trim()}</td>`).join('') + '</tr>';
    })
    .replace(/(<tr>.*?<\/tr>)/gs, '<table>$1</table>')
    .replace(/\n/g, '<br>')
}</div>
<div class="footer">Generado por BelfastCM × AA2000 — Precios de referencia, consultar con proveedores para cotización final.</div>
</body></html>`;

        const blob = new Blob([contenido], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cotizacion_${item.tipologia?.replace(/\s/g, '_')}_${item.fecha.replace(/\//g, '-')}.html`;
        a.click();
        URL.revokeObjectURL(url);
    }

    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title="Cotización IA" back onBack={() => setView("mas")} sub="Precios Argentina en tiempo real" />
        <div style={{ padding: "14px 18px" }}>
            <Card style={{ padding: "16px", marginBottom: 12 }}>
                <Lbl>Tipo de trabajo</Lbl>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 14 }}>
                    {TIPOLOGIAS.map(t => (
                        <button key={t.id} onClick={() => setTipologia(t.id)} style={{ padding: "8px 6px", borderRadius: T.rsm, border: `1.5px solid ${tipologia === t.id ? T.accent : T.border}`, background: tipologia === t.id ? T.accentLight : T.card, color: tipologia === t.id ? T.accent : T.sub, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>{t.label}</button>
                    ))}
                </div>
                <FieldRow>
                    <Field label="Superficie (m²)"><TInput value={superficie} onChange={e => setSuperficie(e.target.value)} placeholder="ej: 80" type="number" /></Field>
                    <Field label="Zona / Localidad"><TInput value={zona} onChange={e => setZona(e.target.value)} placeholder="ej: Palermo" /></Field>
                </FieldRow>
                <Lbl>Foto del espacio (opcional pero recomendado)</Lbl>
                <input ref={camRef} type="file" accept="image/*" capture="environment" onChange={handleFoto} style={{ display: "none" }} />
                <input ref={galRef} type="file" accept="image/*" onChange={handleFoto} style={{ display: "none" }} />
                {foto ? (
                    <div style={{ position: "relative", marginBottom: 14 }}>
                        <img src={foto.url} alt="" style={{ width: "100%", maxHeight: 200, objectFit: "cover", borderRadius: T.rsm, border: `1px solid ${T.border}` }} />
                        <button onClick={() => setFoto(null)} style={{ position: "absolute", top: 6, right: 6, width: 26, height: 26, borderRadius: "50%", background: "rgba(0,0,0,.6)", border: "none", color: "#fff", fontSize: 13, cursor: "pointer" }}>✕</button>
                        <div style={{ position: "absolute", bottom: 6, left: 8, background: "rgba(0,0,0,.5)", borderRadius: 6, padding: "2px 8px", fontSize: 10, color: "#fff", fontWeight: 600 }}>IA analizará esta imagen</div>
                    </div>
                ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
                        <button onClick={() => camRef.current?.click()} style={{ background: "#111", border: "none", borderRadius: T.rsm, padding: "10px", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>📷 Tomar foto</button>
                        <button onClick={() => galRef.current?.click()} style={{ background: T.bg, border: `1.5px solid ${T.border}`, borderRadius: T.rsm, padding: "10px", color: T.text, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>🖼 Galería</button>
                    </div>
                )}
                <button onClick={cotizar} disabled={loading} style={{ width: "100%", background: loading ? "#94A3B8" : T.accent, border: "none", borderRadius: T.rsm, padding: "14px", fontSize: 14, fontWeight: 800, color: "#fff", cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                    {loading ? <><div style={{ width: 18, height: 18, border: "2.5px solid rgba(255,255,255,.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin .8s linear infinite" }} />Consultando precios en Argentina…</> : 'Generar cotización con IA'}
                </button>
            </Card>

            {resultado && (<Card style={{ padding: "16px", marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div>
                        <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>Cotización generada</div>
                        <div style={{ fontSize: 11, color: T.muted }}>{resultado.fecha} · {resultado.tipologia} · {resultado.zona}</div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => { try { navigator.clipboard.writeText(resultado.texto); } catch {} }} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "6px 10px", fontSize: 11, color: T.sub, cursor: "pointer", fontWeight: 600 }}>Copiar</button>
                        <button onClick={() => descargarPDF(resultado)} style={{ background: T.accent, border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11, color: "#fff", cursor: "pointer", fontWeight: 700 }}>⬇ HTML/PDF</button>
                    </div>
                </div>
                <div style={{ background: T.bg, borderRadius: T.rsm, padding: "14px", fontSize: 12, color: T.text, lineHeight: 1.8, whiteSpace: "pre-wrap", maxHeight: 420, overflowY: "auto" }}>{resultado.texto}</div>
            </Card>)}

            {historial.length > 0 && (<Card style={{ padding: "14px 16px" }}>
                <Lbl>Historial de cotizaciones ({historial.length})</Lbl>
                {historial.slice(0, 8).map(h => (
                    <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `1px solid ${T.border}` }}>
                        {h.foto && <img src={h.foto} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />}
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{h.tipologia}</div>
                            <div style={{ fontSize: 10, color: T.muted }}>{h.fecha} · {h.zona} · {h.superficie !== '—' ? h.superficie + 'm²' : ''}</div>
                        </div>
                        <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                            <button onClick={() => setResultado(h)} style={{ background: T.accentLight, border: `1px solid ${T.border}`, borderRadius: 7, padding: "4px 8px", fontSize: 10, color: T.accent, cursor: "pointer", fontWeight: 700 }}>Ver</button>
                            <button onClick={() => descargarPDF(h)} style={{ background: T.accent, border: "none", borderRadius: 7, padding: "4px 8px", fontSize: 10, color: "#fff", cursor: "pointer", fontWeight: 700 }}>PDF</button>
                        </div>
                    </div>
                ))}
            </Card>)}
        </div>
    </div>);
}

// ── MATERIALES POR ZONA ───────────────────────────────────────────────
function MaterialesZonaView({ setView, apiKey }) {
    const [zona, setZona] = useState('');
    const [material, setMaterial] = useState('');
    const [categoria, setCategoria] = useState('todos');
    const [loading, setLoading] = useState(false);
    const [resultado, setResultado] = useState(null);

    const CATEGORIAS = [
        { id: 'todos', label: 'Todo' },
        { id: 'cemento', label: 'Cemento y hormigón' },
        { id: 'hierro', label: 'Hierro y acero' },
        { id: 'ceramica', label: 'Cerámica y pisos' },
        { id: 'pintura', label: 'Pinturas' },
        { id: 'sanitarios', label: 'Sanitarios' },
        { id: 'electrico', label: 'Eléctrico' },
        { id: 'madera', label: 'Maderas' },
        { id: 'aislacion', label: 'Aislación' },
    ];

    async function buscar() {
        if (!zona.trim() && !material.trim()) { alert('Ingresá una zona o un material a buscar'); return; }
        if (!apiKey) { alert('Configurá tu API Key en Más → Configuración'); return; }
        setLoading(true); setResultado(null);
        const hoy = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const prompt = `Sos un experto en el mercado de materiales de construcción en Argentina. Hoy es ${hoy}.

Zona/Localidad buscada: ${zona || 'Buenos Aires / AMBA'}
${material ? `Material específico: ${material}` : `Categoría: ${CATEGORIAS.find(c => c.id === categoria)?.label || 'General'}`}

Generá un informe actualizado con:

## PRECIOS DE MATERIALES — ${zona || 'AMBA'} — ${hoy}

Para cada material relevante en la categoría indicada:
- Precio actual en pesos argentinos
- Fuente de referencia (MercadoLibre, Sodimac, Easy, Ferreterías locales, Revista Cifras, etc.)
- Variación estimada respecto al mes anterior
- Formato: | Material | Marca/Calidad | Precio | Unidad | Fuente |

## PROVEEDORES POR ZONA

Lista de proveedores/ferreterías recomendados en ${zona || 'Buenos Aires y alrededores'}:
- Nombre del proveedor
- Especialidad
- Contacto o página web si disponible
- Por qué es recomendable

## TIPS DE COMPRA

Consejos específicos para comprar en ${zona || 'AMBA'}:
- Dónde conseguir mejor precio
- Diferencia barrio/zona de precios
- Materiales con alta inflación últimos 30 días
- Sustitutos más económicos si aplica

## ÍNDICE DE PRECIOS REFERENCIAL

Ranking de los 10 materiales más consultados en Argentina con sus precios al ${hoy}.

Todos los precios en PESOS ARGENTINOS ($). Indicá siempre la fuente.`;

        const r = await callAI([{ role: 'user', content: prompt }],
            `Sos un asistente experto en costos de construcción en Argentina. Buscá en internet los precios actualizados de MercadoLibre Argentina, Sodimac, Easy, Ferreterías locales y Revista Cifras. Respondés siempre en español rioplatense con precios reales y actualizados al día de hoy. Siempre buscá en internet antes de responder.`,
            apiKey, true);
        setResultado({ texto: r, zona: zona || 'AMBA', material, categoria, fecha: new Date().toLocaleDateString('es-AR') });
        setLoading(false);
    }

    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title="Materiales por zona" back onBack={() => setView("mas")} sub="Precios y proveedores en Argentina" />
        <div style={{ padding: "14px 18px" }}>
            <Card style={{ padding: "16px", marginBottom: 12 }}>
                <Field label="Zona / Localidad">
                    <TInput value={zona} onChange={e => setZona(e.target.value)} placeholder="ej: Palermo, Belgrano, La Plata, Rosario..." />
                </Field>
                <Field label="Material específico (opcional)">
                    <TInput value={material} onChange={e => setMaterial(e.target.value)} placeholder="ej: cemento portland, porcellanato 60x60..." />
                </Field>
                <Lbl>Categoría</Lbl>
                <div style={{ display: "flex", gap: 5, overflowX: "auto", paddingBottom: 4, marginBottom: 14 }}>
                    {CATEGORIAS.map(c => (
                        <button key={c.id} onClick={() => setCategoria(c.id)} style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 20, border: `1.5px solid ${categoria === c.id ? T.accent : T.border}`, background: categoria === c.id ? T.accentLight : T.card, color: categoria === c.id ? T.accent : T.sub, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>{c.label}</button>
                    ))}
                </div>
                <button onClick={buscar} disabled={loading} style={{ width: "100%", background: loading ? "#94A3B8" : T.accent, border: "none", borderRadius: T.rsm, padding: "14px", fontSize: 14, fontWeight: 800, color: "#fff", cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                    {loading ? <><div style={{ width: 18, height: 18, border: "2.5px solid rgba(255,255,255,.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin .8s linear infinite" }} />Buscando precios y proveedores…</> : 'Buscar precios y proveedores'}
                </button>
            </Card>

            {resultado && (<Card style={{ padding: "16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div>
                        <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>Resultados para {resultado.zona}</div>
                        <div style={{ fontSize: 11, color: T.muted }}>{resultado.fecha} · {resultado.material || CATEGORIAS.find(c => c.id === resultado.categoria)?.label}</div>
                    </div>
                    <button onClick={() => { try { navigator.clipboard.writeText(resultado.texto); } catch {} }} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "6px 10px", fontSize: 11, color: T.sub, cursor: "pointer", fontWeight: 600 }}>Copiar</button>
                </div>
                <div style={{ background: T.bg, borderRadius: T.rsm, padding: "14px", fontSize: 12, color: T.text, lineHeight: 1.8, whiteSpace: "pre-wrap", maxHeight: 500, overflowY: "auto" }}>{resultado.texto}</div>
            </Card>)}

            {!resultado && !loading && (<div style={{ textAlign: "center", padding: "40px 0" }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>🔍</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 6 }}>Buscador de precios</div>
                <div style={{ fontSize: 12, color: T.muted, maxWidth: 280, margin: "0 auto", lineHeight: 1.6 }}>
                    Ingresá una zona y la IA busca precios actualizados de MercadoLibre, Sodimac, Easy, Revista Cifras y proveedores locales.
                </div>
            </div>)}
        </div>
    </div>);
}

// ── MENSAJES · CONTACTOS · WHATSAPP ─────────────────────────────────
function MensajesView({ setView, currentUser, personal, obras }) {
    const SP = localStorage.getItem('bop_auth_empresa') === 'vv' ? 'vv_' : 'bcm_';
    const [mensajes, setMensajes] = useState([]);
    const [tab, setTab] = useState('privados'); // 'privados' | 'obras'
    const [selChat, setSelChat] = useState(null); // { tipo: 'user'|'obra', id, nombre }
    const [txt, setTxt] = useState('');
    const scrollRef = useRef(null);

    const myId = currentUser?.usuario || currentUser?.user || currentUser?.appUser || 'anon';
    const myName = currentUser?.nombre || currentUser?.rol || 'Usuario';

    // Todos los usuarios disponibles para chat
    // - Con appUser: chat interno en la app
    // - Sin appUser pero con teléfono: abre WhatsApp
    const allUsers = [
        { id: 'sebastian', nombre: 'Sebastián (Admin)', rol: 'Administrador', tipo: 'admin', tieneApp: true },
        ...personal
            .filter(p => p.id !== myId && p.nombre)
            .map(p => ({
                id: p.appUser || ('personal_' + p.id),
                personalId: p.id,
                nombre: p.nombre,
                rol: p.rol,
                telefono: p.telefono,
                tipo: 'empleado',
                tieneApp: !!p.appUser,
            }))
    ].filter(u => u.id !== myId);

    // Cargar mensajes y polling cada 3s
    async function loadMensajes() {
        try {
            const r = await storage.get(SP+'mensajes');
            if (r?.value) setMensajes(JSON.parse(r.value));
        } catch {}
    }
    useEffect(() => { loadMensajes(); const iv = setInterval(loadMensajes, 3000); return () => clearInterval(iv); }, []);
    useEffect(() => { setTimeout(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, 50); }, [mensajes, selChat]);

    // Mensajes no leídos totales
    const totalUnread = mensajes.filter(m => m.para === myId && !m.leido).length +
        mensajes.filter(m => m.tipo === 'obra' && !m.leidoPor?.includes(myId)).length;

    async function enviar() {
        if (!txt.trim() || !selChat) return;
        const nuevo = {
            id: uid(),
            tipo: selChat.tipo, // 'privado' | 'obra'
            de: myId, deName: myName,
            para: selChat.tipo === 'privado' ? selChat.id : null,
            obraId: selChat.tipo === 'obra' ? selChat.id : null,
            obraNombre: selChat.tipo === 'obra' ? selChat.nombre : null,
            txt: txt.trim(),
            fecha: new Date().toISOString(),
            leido: false,
            leidoPor: [myId], // para mensajes de obra
        };
        const actualizados = [...mensajes, nuevo];
        setMensajes(actualizados);
        setTxt('');
        try { await storage.set(SP+'mensajes', JSON.stringify(actualizados)); } catch {}
    }

    async function marcarLeidos(chat) {
        if (!chat) return;
        let cambio = false;
        const actualizados = mensajes.map(m => {
            if (chat.tipo === 'privado' && m.de === chat.id && m.para === myId && !m.leido) {
                cambio = true; return { ...m, leido: true };
            }
            if (chat.tipo === 'obra' && m.obraId === chat.id && !m.leidoPor?.includes(myId)) {
                cambio = true; return { ...m, leidoPor: [...(m.leidoPor||[]), myId] };
            }
            return m;
        });
        if (cambio) { setMensajes(actualizados); try { await storage.set(SP+'mensajes', JSON.stringify(actualizados)); } catch {} }
    }
    useEffect(() => { if (selChat) marcarLeidos(selChat); }, [selChat, mensajes.length]);

    function getUnreadPrivado(userId) {
        return mensajes.filter(m => m.tipo === 'privado' && m.de === userId && m.para === myId && !m.leido).length;
    }
    function getUnreadObra(obraId) {
        return mensajes.filter(m => m.tipo === 'obra' && m.obraId === obraId && !m.leidoPor?.includes(myId)).length;
    }
    function getLastMsg(chatId, tipo) {
        return mensajes.filter(m => tipo === 'privado'
            ? ((m.de === myId && m.para === chatId) || (m.de === chatId && m.para === myId))
            : m.obraId === chatId
        ).sort((a, b) => new Date(b.fecha) - new Date(a.fecha))[0];
    }

    // Vista de conversación
    if (selChat) {
        const conv = mensajes.filter(m => selChat.tipo === 'privado'
            ? ((m.de === myId && m.para === selChat.id) || (m.de === selChat.id && m.para === myId))
            : m.obraId === selChat.id
        ).sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

        return (<div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <AppHeader title={selChat.nombre} sub={selChat.tipo === 'obra' ? 'Chat de obra — visible para todos' : 'Chat privado'} back onBack={() => setSelChat(null)} />
            <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "14px", display: "flex", flexDirection: "column", gap: 8, paddingBottom: 80 }}>
                {conv.length === 0 && <div style={{ textAlign: "center", padding: "40px 0", color: T.muted, fontSize: 13 }}>
                    {selChat.tipo === 'obra' ? '💬 Empezá la conversación sobre esta obra' : 'Enviá el primer mensaje'}
                </div>}
                {conv.map(m => {
                    const mine = m.de === myId;
                    return (<div key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: "82%" }}>
                        {!mine && selChat.tipo === 'obra' && (
                            <div style={{ fontSize: 10, color: T.muted, marginBottom: 3, marginLeft: 4, fontWeight: 700 }}>{m.deName}</div>
                        )}
                        <div style={{ background: mine ? T.accent : T.card, color: mine ? "#fff" : T.text, borderRadius: mine ? "18px 18px 4px 18px" : "18px 18px 18px 4px", padding: "10px 14px", fontSize: 14, lineHeight: 1.5, border: mine ? "none" : `1px solid ${T.border}` }}>
                            {m.txt}
                        </div>
                        <div style={{ fontSize: 10, color: T.muted, marginTop: 3, textAlign: mine ? 'right' : 'left', marginLeft: mine ? 0 : 4, marginRight: mine ? 4 : 0 }}>
                            {new Date(m.fecha).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                            {mine && selChat.tipo === 'privado' && <span style={{ marginLeft: 4 }}>{m.leido ? ' ✓✓' : ' ✓'}</span>}
                        </div>
                    </div>);
                })}
            </div>
            <div style={{ padding: "10px 14px", background: T.card, borderTop: `1px solid ${T.border}`, display: "flex", gap: 8, position: "fixed", bottom: 72, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 480, zIndex: 99 }}>
                <textarea value={txt} onChange={e => setTxt(e.target.value)} placeholder="Escribí un mensaje..." rows={1} style={{ flex: 1, background: T.bg, border: `1.5px solid ${T.border}`, borderRadius: 20, padding: "10px 14px", fontSize: 14, color: T.text, resize: "none", lineHeight: 1.4, fontFamily: "inherit" }} />
                <button onClick={enviar} disabled={!txt.trim()} style={{ background: txt.trim() ? T.accent : T.border, border: "none", borderRadius: "50%", width: 42, height: 42, fontSize: 18, color: "#fff", cursor: txt.trim() ? "pointer" : "not-allowed", flexShrink: 0, alignSelf: "flex-end" }}>➤</button>
            </div>
        </div>);
    }

    // Lista de chats
    return (<div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <AppHeader title="Mensajes" back onBack={() => setView("mas")}
            right={totalUnread > 0 ? <div style={{ background: "#EF4444", color: "#fff", borderRadius: 20, minWidth: 24, height: 24, fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 8px" }}>{totalUnread}</div> : null}
        />
        {/* Tabs */}
        <div style={{ display: "flex", background: T.bg, borderBottom: `1px solid ${T.border}` }}>
            {[['privados', '💬 Privados'], ['obras', '🏗 Por obra']].map(([id, label]) => (
                <button key={id} onClick={() => setTab(id)} style={{ flex: 1, padding: "12px", border: "none", background: "none", fontSize: 13, fontWeight: tab === id ? 700 : 500, color: tab === id ? T.accent : T.muted, borderBottom: `2px solid ${tab === id ? T.accent : 'transparent'}`, cursor: "pointer" }}>{label}</button>
            ))}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px", paddingBottom: 80 }}>
            {tab === 'privados' && (<>
                {allUsers.length === 0 && <div style={{ textAlign: "center", padding: "40px 0", color: T.muted, fontSize: 13 }}>No hay otros usuarios registrados</div>}
                {allUsers.map(u => {
                    const unread = getUnreadPrivado(u.id);
                    const last = getLastMsg(u.id, 'privado');
                    return (<Card key={u.id} onClick={() => {
                        if (u.tieneApp) {
                            setSelChat({ tipo: 'privado', id: u.id, nombre: u.nombre });
                        } else if (u.telefono) {
                            // Sin app — abrir WhatsApp
                            window.open(`https://wa.me/${u.telefono}`, '_blank');
                        } else {
                            alert(`${u.nombre} no tiene app ni teléfono registrado`);
                        }
                    }} style={{ padding: "13px 14px", marginBottom: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ width: 46, height: 46, borderRadius: "50%", background: u.tipo === 'admin' ? T.navy : T.accentLight, color: u.tipo === 'admin' ? "#fff" : T.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, flexShrink: 0 }}>
                            {u.nombre.split(' ').slice(0,2).map(w => w[0]||'').join('').toUpperCase()}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: T.text, display: 'flex', alignItems: 'center', gap: 6 }}>
                                {u.nombre}
                                {!u.tieneApp && u.telefono && <span style={{ fontSize: 10, background: '#DCFCE7', color: '#16A34A', borderRadius: 20, padding: '2px 7px', fontWeight: 700 }}>WhatsApp</span>}
                                {!u.tieneApp && !u.telefono && <span style={{ fontSize: 10, background: '#FEF2F2', color: '#EF4444', borderRadius: 20, padding: '2px 7px', fontWeight: 700 }}>Sin contacto</span>}
                            </div>
                            <div style={{ fontSize: 11, color: T.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {u.tieneApp ? (last ? (last.de === myId ? 'Vos: ' : '') + last.txt : u.rol) : u.rol}
                            </div>
                        </div>
                        {unread > 0 && u.tieneApp && <div style={{ background: "#EF4444", color: "#fff", borderRadius: 12, minWidth: 22, height: 22, fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 7px" }}>{unread}</div>}
                    </Card>);
                })}
            </>)}
            {tab === 'obras' && (<>
                {obras.length === 0 && <div style={{ textAlign: "center", padding: "40px 0", color: T.muted, fontSize: 13 }}>No hay obras</div>}
                {obras.map(o => {
                    const unread = getUnreadObra(o.id);
                    const last = getLastMsg(o.id, 'obra');
                    return (<Card key={o.id} onClick={() => setSelChat({ tipo: 'obra', id: o.id, nombre: o.nombre })} style={{ padding: "13px 14px", marginBottom: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ width: 46, height: 46, borderRadius: 12, background: T.accentLight, color: T.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🏗</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{o.nombre}</div>
                            <div style={{ fontSize: 11, color: T.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {last ? last.deName + ': ' + last.txt : 'Sin mensajes aún'}
                            </div>
                        </div>
                        {unread > 0 && <div style={{ background: "#EF4444", color: "#fff", borderRadius: 12, minWidth: 22, height: 22, fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 7px" }}>{unread}</div>}
                    </Card>);
                })}
            </>)}
        </div>
    </div>);
}

function ContactosView({ setView }) {
    const [contactos, setContactos] = useStoredState(('bop_')+'contactos', []);
    const [showNew, setShowNew] = useState(false);
    const [form, setForm] = useState({ nombre: '', empresa: '', telefono: '', email: '', notas: '' });
    function add() { if (!form.nombre.trim()) return; setContactos(p => [...p, { ...form, id: uid() }]); setForm({ nombre: '', empresa: '', telefono: '', email: '', notas: '' }); setShowNew(false); }
    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title="Contactos" back onBack={() => setView("mas")} right={<PlusBtn onClick={() => setShowNew(true)} />} sub={`${contactos.length} contactos`} />
        <div style={{ padding: "14px 18px" }}>
            {contactos.length === 0 ? <div style={{ textAlign: "center", padding: "40px 0", color: T.muted, fontSize: 13 }}>Agregá tu primer contacto</div> :
                contactos.map(c => (<Card key={c.id} style={{ padding: "12px 14px", marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{c.nombre}</div>
                            {c.empresa && <div style={{ fontSize: 11, color: T.muted }}>{c.empresa}</div>}
                            {c.telefono && <div style={{ fontSize: 11, color: T.sub, marginTop: 3 }}>📞 {c.telefono}</div>}
                            {c.email && <div style={{ fontSize: 11, color: T.sub }}>✉ {c.email}</div>}
                            {c.notas && <div style={{ fontSize: 11, color: T.muted, marginTop: 4, fontStyle: "italic" }}>{c.notas}</div>}
                        </div>
                        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                            {c.telefono && <a href={`https://wa.me/${c.telefono.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}><button style={{ background: "#25D366", border: "none", borderRadius: 7, width: 30, height: 30, cursor: "pointer", color: "#fff", fontSize: 12 }}>💬</button></a>}
                            {c.email && <a href={`mailto:${c.email}`} style={{ textDecoration: "none" }}><button style={{ background: T.accentLight, border: `1px solid ${T.border}`, borderRadius: 7, width: 30, height: 30, cursor: "pointer", color: T.accent }}>✉</button></a>}
                            <button onClick={() => setContactos(p => p.filter(x => x.id !== c.id))} style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 7, width: 30, height: 30, cursor: "pointer", color: "#EF4444" }}>✕</button>
                        </div>
                    </div>
                </Card>))}
        </div>
        {showNew && (<Sheet title="Nuevo contacto" onClose={() => setShowNew(false)}>
            <Field label="Nombre"><TInput value={form.nombre} onChange={e => setForm(p => ({ ...p, nombre: e.target.value }))} placeholder="Juan Pérez" /></Field>
            <Field label="Empresa"><TInput value={form.empresa} onChange={e => setForm(p => ({ ...p, empresa: e.target.value }))} placeholder="Belfast Obras" /></Field>
            <FieldRow>
                <Field label="Teléfono"><TInput value={form.telefono} onChange={e => setForm(p => ({ ...p, telefono: e.target.value }))} placeholder="549115555" /></Field>
                <Field label="Email"><TInput value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} placeholder="juan@ejemplo.com" /></Field>
            </FieldRow>
            <Field label="Notas"><TInput value={form.notas} onChange={e => setForm(p => ({ ...p, notas: e.target.value }))} placeholder="Comercial · Proveedor cemento" /></Field>
            <PBtn full onClick={add} disabled={!form.nombre.trim()}>Agregar contacto</PBtn>
        </Sheet>)}
    </div>);
}

function ProveedoresView({ setView }) {
    const [provs, setProvs] = useStoredState(('bop_')+'proveedores', []);
    const [showNew, setShowNew] = useState(false);
    const [form, setForm] = useState({ nombre: '', rubro: '', telefono: '', email: '', cuit: '', notas: '' });
    const RUBROS = ['Materiales', 'Eléctrico', 'Plomería', 'Aberturas', 'Pintura', 'Herrería', 'Servicios', 'Transporte', 'Otros'];
    function add() { if (!form.nombre.trim()) return; setProvs(p => [...p, { ...form, id: uid() }]); setForm({ nombre: '', rubro: '', telefono: '', email: '', cuit: '', notas: '' }); setShowNew(false); }
    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title="Proveedores" back onBack={() => setView("mas")} right={<PlusBtn onClick={() => setShowNew(true)} />} sub={`${provs.length} proveedores`} />
        <div style={{ padding: "14px 18px" }}>
            {provs.length === 0 ? <div style={{ textAlign: "center", padding: "40px 0", color: T.muted, fontSize: 13 }}>Agregá tu primer proveedor</div> :
                provs.map(p => (<Card key={p.id} style={{ padding: "12px 14px", marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{p.nombre}</div>
                        {p.rubro && <Badge color={T.accent} bg={T.accentLight}>{p.rubro}</Badge>}
                    </div>
                    {p.cuit && <div style={{ fontSize: 10, color: T.muted, marginBottom: 3 }}>CUIT: {p.cuit}</div>}
                    {p.telefono && <div style={{ fontSize: 11, color: T.sub }}>📞 {p.telefono}</div>}
                    {p.email && <div style={{ fontSize: 11, color: T.sub }}>✉ {p.email}</div>}
                    {p.notas && <div style={{ fontSize: 11, color: T.muted, marginTop: 4, fontStyle: "italic" }}>{p.notas}</div>}
                    <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                        {p.telefono && <a href={`https://wa.me/${p.telefono.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none", flex: 1 }}><button style={{ width: "100%", background: "#25D366", border: "none", borderRadius: 7, padding: "6px", fontSize: 11, color: "#fff", fontWeight: 600, cursor: "pointer" }}>WhatsApp</button></a>}
                        {p.email && <a href={`mailto:${p.email}`} style={{ textDecoration: "none", flex: 1 }}><button style={{ width: "100%", background: T.accentLight, border: `1px solid ${T.border}`, borderRadius: 7, padding: "6px", fontSize: 11, color: T.accent, fontWeight: 600, cursor: "pointer" }}>Email</button></a>}
                        <button onClick={() => setProvs(ps => ps.filter(x => x.id !== p.id))} style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 7, padding: "6px 10px", fontSize: 11, color: "#EF4444", cursor: "pointer", flexShrink: 0 }}>✕</button>
                    </div>
                </Card>))}
        </div>
        {showNew && (<Sheet title="Nuevo proveedor" onClose={() => setShowNew(false)}>
            <Field label="Nombre / Razón social"><TInput value={form.nombre} onChange={e => setForm(p => ({ ...p, nombre: e.target.value }))} placeholder="Holcim SA" /></Field>
            <FieldRow>
                <Field label="Rubro"><Sel value={form.rubro} onChange={e => setForm(p => ({ ...p, rubro: e.target.value }))}><option value="">— Elegir —</option>{RUBROS.map(r => <option key={r}>{r}</option>)}</Sel></Field>
                <Field label="CUIT"><TInput value={form.cuit} onChange={e => setForm(p => ({ ...p, cuit: e.target.value }))} placeholder="30-12345678-9" /></Field>
            </FieldRow>
            <FieldRow>
                <Field label="Teléfono"><TInput value={form.telefono} onChange={e => setForm(p => ({ ...p, telefono: e.target.value }))} placeholder="5491155556666" /></Field>
                <Field label="Email"><TInput value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} placeholder="ventas@proveedor.com" /></Field>
            </FieldRow>
            <Field label="Notas"><TInput value={form.notas} onChange={e => setForm(p => ({ ...p, notas: e.target.value }))} placeholder="Entrega 48hs" /></Field>
            <PBtn full onClick={add} disabled={!form.nombre.trim()}>Agregar proveedor</PBtn>
        </Sheet>)}
    </div>);
}

// ── INFO EXTERNA · GANTT ─────────────────────────────────────────────
function InfoExternaView({ setView, cfg }) {
    const [dolar, setDolar] = useState(null);
    const [clima, setClima] = useState({});
    const [loading, setLoading] = useState(true);
    const UBICS = getUbics(cfg);

    useEffect(() => { (async () => {
        try { const r = await fetch('https://dolarapi.com/v1/dolares'); if (r.ok) setDolar(await r.json()); } catch { }
        const climaData = {};
        for (const u of UBICS) {
            try {
                const r = await fetch(`https://wttr.in/${encodeURIComponent(u.name || u.code)}?format=j1&lang=es`);
                if (r.ok) { const d = await r.json(); climaData[u.id] = { temp: d.current_condition?.[0]?.temp_C, desc: d.current_condition?.[0]?.lang_es?.[0]?.value || d.current_condition?.[0]?.weatherDesc?.[0]?.value, humedad: d.current_condition?.[0]?.humidity, viento: d.current_condition?.[0]?.windspeedKmph }; }
            } catch { }
        }
        setClima(climaData); setLoading(false);
    })(); }, []);

    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title="Info Externa" back onBack={() => setView("mas")} sub="Tiempo real" />
        <div style={{ padding: "14px 18px" }}>
            <Card style={{ padding: "14px 16px", marginBottom: 12 }}>
                <Lbl>💵 Cotización dólar</Lbl>
                {loading ? <div style={{ fontSize: 12, color: T.muted, padding: "10px 0" }}>Cargando…</div> :
                    dolar ? <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
                        {dolar.slice(0, 6).map(d => (<div key={d.casa} style={{ background: T.bg, borderRadius: 9, padding: "8px 10px" }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{d.nombre}</div>
                            <div style={{ fontSize: 14, fontWeight: 800, color: T.accent, marginTop: 2 }}>${d.venta?.toLocaleString('es-AR')}</div>
                            <div style={{ fontSize: 9, color: T.muted }}>Compra: ${d.compra?.toLocaleString('es-AR')}</div>
                        </div>))}
                    </div> : <div style={{ fontSize: 12, color: T.muted }}>No disponible</div>
                }
            </Card>
            <Card style={{ padding: "14px 16px", marginBottom: 12 }}>
                <Lbl>🌤 Clima en obras</Lbl>
                {UBICS.map(u => {
                    const c = clima[u.id];
                    return (<div key={u.id} style={{ padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                                <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{u.name}</div>
                                <div style={{ fontSize: 10, color: T.muted }}>{u.code}</div>
                            </div>
                            {c ? <div style={{ textAlign: "right" }}>
                                <div style={{ fontSize: 20, fontWeight: 800, color: T.accent }}>{c.temp}°C</div>
                                <div style={{ fontSize: 10, color: T.muted }}>{c.desc}</div>
                                <div style={{ fontSize: 9, color: T.muted }}>💧 {c.humedad}% · 💨 {c.viento}km/h</div>
                            </div> : <div style={{ fontSize: 11, color: T.muted }}>—</div>}
                        </div>
                    </div>);
                })}
            </Card>
            <Card style={{ padding: "14px 16px" }}>
                <Lbl>📍 Mapas de obras</Lbl>
                {UBICS.map(u => (<a key={u.id} href={`https://www.google.com/maps/search/${encodeURIComponent(u.name)}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${T.border}`, cursor: "pointer" }}>
                        <div>
                            <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{u.code} — {u.name}</div>
                            <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>Ver en Google Maps</div>
                        </div>
                        <span style={{ fontSize: 14, color: T.accent }}>→</span>
                    </div>
                </a>))}
            </Card>
        </div>
    </div>);
}

function GanttView({ obras, setView, cfg }) {
    const [rain, setRain] = useState({});
    const activas = obras.filter(o => o.estado === 'curso' || o.estado === 'pendiente');
    const UBICS = getUbics(cfg);
    useEffect(() => { (async () => {
        const data = {};
        for (const u of UBICS.slice(0, 2)) {
            const coords = u.code === 'AEP' ? '-34.56,-58.41' : '-34.82,-58.54';
            try {
                const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${coords.split(',')[0]}&longitude=${coords.split(',')[1]}&daily=precipitation_probability_max&forecast_days=14&timezone=auto`);
                if (r.ok) { const d = await r.json(); data[u.id] = d.daily?.precipitation_probability_max || []; }
            } catch { }
        }
        setRain(data);
    })(); }, []);

    function parseFecha(s) { if (!s) return null; const p = s.split('/'); if (p.length !== 3) return null; return new Date(`20${p[2]}`, p[1] - 1, p[0]); }
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const proxDias = Array.from({ length: 14 }, (_, i) => { const d = new Date(hoy); d.setDate(d.getDate() + i); return d; });

    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title="Diagrama Gantt" back onBack={() => setView("mas")} sub="Con pronóstico 14 días" />
        <div style={{ padding: "14px 18px" }}>
            <Card style={{ padding: "14px 16px", marginBottom: 12 }}>
                <Lbl>Pronóstico de lluvia — próximos 14 días</Lbl>
                {UBICS.slice(0, 2).map(u => (<div key={u.id} style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: T.sub, marginBottom: 4 }}>{u.code} – {u.name}</div>
                    <div style={{ display: "flex", gap: 2 }}>
                        {proxDias.map((d, i) => {
                            const p = rain[u.id]?.[i] ?? null;
                            const bg = p === null ? T.bg : p > 70 ? "#EF4444" : p > 40 ? "#F59E0B" : p > 20 ? "#60A5FA" : "#86EFAC";
                            return (<div key={i} title={`${d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })} - ${p ?? '?'}%`} style={{ flex: 1, height: 28, background: bg, borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: p > 40 ? "#fff" : T.text }}>{p !== null ? p : '—'}</div>);
                        })}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, color: T.muted, marginTop: 3 }}>
                        <span>Hoy</span><span>+7</span><span>+14 días</span>
                    </div>
                </div>))}
            </Card>
            {activas.length === 0 ? <div style={{ textAlign: "center", padding: "40px 0", color: T.muted, fontSize: 13 }}>Sin obras activas</div> :
                activas.map(o => {
                    const ini = parseFecha(o.inicio);
                    const fin = parseFecha(o.cierre);
                    const ec = OBRA_ESTADOS.find(e => e.id === o.estado) || OBRA_ESTADOS[0];
                    let progreso = 0, totalDias = 0, diasHechos = 0;
                    if (ini && fin) {
                        totalDias = Math.max(1, Math.round((fin - ini) / 86400000));
                        diasHechos = Math.max(0, Math.round((hoy - ini) / 86400000));
                        progreso = Math.min(100, Math.max(0, (diasHechos / totalDias) * 100));
                    }
                    return (<Card key={o.id} style={{ padding: "14px 16px", marginBottom: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: T.text, flex: 1 }}>{o.nombre}</div>
                            <Badge color={ec.color} bg={ec.bg}>{ec.label}</Badge>
                        </div>
                        <div style={{ fontSize: 10, color: T.muted, marginBottom: 8 }}>{UBICS.find(u => u.id === o.ap)?.code} · {o.sector || '—'}</div>
                        <div style={{ position: "relative", height: 22, background: T.bg, borderRadius: 5, overflow: "hidden" }}>
                            <div style={{ position: "absolute", left: 0, top: 0, height: "100%", background: ec.color, opacity: .25, width: `${progreso}%` }} />
                            <div style={{ position: "absolute", left: 0, top: 0, height: "100%", background: T.accent, width: `${o.avance}%` }} />
                            <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#fff", textShadow: "0 1px 2px rgba(0,0,0,.5)" }}>{o.avance}% real / {Math.round(progreso)}% tiempo</div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: T.muted, marginTop: 6 }}>
                            <span>Inicio: {o.inicio || '—'}</span>
                            <span>{totalDias > 0 ? `${diasHechos}/${totalDias} días` : ''}</span>
                            <span>Fin: {o.cierre || '—'}</span>
                        </div>
                    </Card>);
                })}
        </div>
    </div>);
}

// ── INFORMES IA (Diarios/Semanales) ───────────────────────────────────
function InformesIA({ obras, setObras, setView, apiKey }) {
    const [obraId, setObraId] = useState('');
    const [tipo, setTipo] = useState('diario');
    const [notas, setNotas] = useState('');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState('');
    const [error, setError] = useState('');
    const obra = obras.find(o => o.id === obraId);
    const informesObra = (obra?.informes || []).filter(i => i.tipo === tipo);

    async function generar() {
        if (!obra) return;
        setError('');
        if (!apiKey) { setError('⚠ Configurá tu API Key en Más → Configuración.'); return; }
        setLoading(true); setResult('');
        const template = tipo === 'diario'
            ? `Generá un INFORME DIARIO para "${obra.nombre}" (AA2000 ${AIRPORTS.find(a => a.id === obra.ap)?.code || obra.ap}). Avance actual: ${obra.avance}%. Fecha: ${new Date().toLocaleDateString('es-AR')}.

Estructura:
1. **Resumen del día** (trabajos ejecutados)
2. **Personal en obra**
3. **Materiales consumidos / ingresados**
4. **Condiciones climáticas y seguridad**
5. **Incidencias o novedades**
6. **Plan para mañana**

${notas ? 'Notas del usuario: ' + notas : ''}

Tono profesional AA2000, español rioplatense.`
            : `Generá un INFORME SEMANAL para "${obra.nombre}" (AA2000 ${AIRPORTS.find(a => a.id === obra.ap)?.code || obra.ap}). Avance: ${obra.avance}%. Semana del ${new Date().toLocaleDateString('es-AR')}.

Estructura:
1. **Avance físico de la semana**
2. **Hitos cumplidos**
3. **Desvíos respecto del plan**
4. **Estado de insumos y subcontratos**
5. **Riesgos identificados y mitigaciones**
6. **Plan de la próxima semana**

${notas ? 'Notas del usuario: ' + notas : ''}

Tono profesional AA2000, español rioplatense.`;
        const r = await callAI([{ role: 'user', content: template }],
            'Sos ingeniero de obra para AA2000. Generás informes técnicos claros y profesionales en español rioplatense. Si el informe requiere datos de precios o mercado, buscalos en internet.', apiKey, true);

        // Detectar errores (no guardar como informe si falló)
        if (!r || r.startsWith('⚠') || r.toLowerCase().includes('error') && r.length < 200) {
            setError(r || 'No se pudo generar el informe. Revisá tu API Key.');
            setLoading(false);
            return;
        }

        setResult(r);
        const nuevoInf = { id: uid(), titulo: `Informe ${tipo} — ${new Date().toLocaleDateString('es-AR')}`, tipo, fecha: new Date().toLocaleDateString('es-AR'), notas, texto: r, nombre: `informe_${tipo}_${Date.now()}.txt`, ext: 'IA', url: 'data:text/plain;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent(r))), size: (r.length / 1024).toFixed(1) + 'KB', cargado: new Date().toLocaleDateString('es-AR') };
        setObras(p => p.map(o => o.id === obraId ? { ...o, informes: [nuevoInf, ...(o.informes || [])] } : o));
        setLoading(false);
    }

    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title="Informes IA" back onBack={() => setView("mas")} sub="Diarios y semanales" />
        <div style={{ padding: "14px 18px" }}>
            <Card style={{ padding: "14px 16px", marginBottom: 12 }}>
                <Field label="Obra"><Sel value={obraId} onChange={e => setObraId(e.target.value)}><option value="">— Elegir —</option>{obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}</Sel></Field>
                <Field label="Tipo de informe">
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                        {[{ id: 'diario', label: 'Diario' }, { id: 'semanal', label: 'Semanal' }].map(t => (<button key={t.id} onClick={() => setTipo(t.id)} style={{ padding: "9px", borderRadius: T.rsm, border: `1.5px solid ${tipo === t.id ? T.accent : T.border}`, background: tipo === t.id ? T.accentLight : T.card, color: tipo === t.id ? T.accent : T.sub, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{t.label}</button>))}
                    </div>
                </Field>
                <Field label="Notas adicionales (opcional)">
                    <textarea value={notas} onChange={e => setNotas(e.target.value)} placeholder="Ej: se trabajó en fundaciones, se recibió el hormigón H21..." rows={3} style={{ width: "100%", background: T.bg, border: `1.5px solid ${T.border}`, borderRadius: T.rsm, padding: "10px 12px", fontSize: 13, color: T.text }} />
                </Field>
                {error && <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#EF4444", marginBottom: 10, fontWeight: 600 }}>{error}</div>}
                <PBtn full onClick={generar} disabled={!obra || loading}>{loading ? 'Generando...' : 'Generar informe con IA'}</PBtn>
            </Card>
            {result && (<Card style={{ padding: "14px 16px", marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#10B981" }}>✓ Informe generado y guardado en la obra</span>
                    <button onClick={() => { try { navigator.clipboard.writeText(result); } catch { } }} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 7, padding: "4px 10px", fontSize: 11, color: T.sub, cursor: "pointer" }}>Copiar</button>
                </div>
                <div style={{ background: T.bg, borderRadius: T.rsm, padding: "12px", fontSize: 12, color: T.text, lineHeight: 1.7, whiteSpace: "pre-wrap", maxHeight: 320, overflowY: "auto" }}>{result}</div>
            </Card>)}
            {obra && informesObra.length > 0 && (<Card style={{ padding: "14px 16px" }}>
                <Lbl>Informes {tipo}s guardados en {obra.nombre}</Lbl>
                {informesObra.map(inf => (<div key={inf.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `1px solid ${T.border}` }}>
                    <div style={{ width: 34, height: 34, borderRadius: 7, background: T.accentLight, color: T.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, flexShrink: 0 }}>{inf.ext || 'IA'}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inf.titulo}</div>
                        <div style={{ fontSize: 10, color: T.muted }}>{inf.fecha} · {inf.size || '—'}</div>
                    </div>
                    <a href={inf.url} download={inf.nombre} style={{ textDecoration: "none" }}>
                        <button style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 7, width: 30, height: 30, fontSize: 12, color: T.sub, cursor: "pointer" }}>↓</button>
                    </a>
                    <button onClick={() => setObras(p => p.map(o => o.id === obraId ? { ...o, informes: (o.informes || []).filter(x => x.id !== inf.id) } : o))} style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 7, width: 30, height: 30, fontSize: 12, color: "#EF4444", cursor: "pointer" }}>✕</button>
                </div>))}
            </Card>)}
        </div>
    </div>);
}

// ── CHAT IA ────────────────────────────────────────────────────────
// Límite de mensajes guardados: 60 (30 intercambios) — borra los más viejos automáticamente
const CHAT_MAX_MSGS = 60;
const CHAT_EXPIRE_MS = 60 * 60 * 1000; // 1 hora de inactividad → resetea

function Chat({ lics, setLics, obras, setObras, personal, setPersonal, planes, setPlanes, alerts, cfg, apiKey, setView, SP = 'bcm_' }) {
    // Refs para closures — garantizan que las funciones siempre estén actualizadas
    const setPersonalRef = useRef(setPersonal);
    const setLicsRef = useRef(setLics);
    const setObrasRef = useRef(setObras);
    const setPlanesRef = useRef(setPlanes);
    const setViewRef = useRef(setView);
    const obrasRef = useRef(obras);
    const licsRef = useRef(lics);
    const personalRef = useRef(personal);
    useEffect(() => { setPersonalRef.current = setPersonal; }, [setPersonal]);
    useEffect(() => { setLicsRef.current = setLics; }, [setLics]);
    useEffect(() => { setObrasRef.current = setObras; }, [setObras]);
    useEffect(() => { setPlanesRef.current = setPlanes; }, [setPlanes]);
    useEffect(() => { setViewRef.current = setView; }, [setView]);
    useEffect(() => { obrasRef.current = obras; }, [obras]);
    useEffect(() => { licsRef.current = lics; }, [lics]);
    useEffect(() => { personalRef.current = personal; }, [personal]);
    // Grabación de reunión
    const [grabando, setGrabando] = useState(false);
    const [tiempoGrabacion, setTiempoGrabacion] = useState(0);
    const [obraReunion, setObraReunion] = useState('');
    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);
    const timerRef = useRef(null);

    // Cargar mensajes desde localStorage sincrónicamente
    const [msgs, setMsgs] = useState(() => {
        try {
            const saved = localStorage.getItem(('bop_')+'chat_msgs');
            if (!saved) return [];
            const { msgs: m, lastAt } = JSON.parse(saved);
            // Si pasó más de 1 hora sin actividad, empezar de cero
            if (Date.now() - lastAt > CHAT_EXPIRE_MS) return [];
            return m || [];
        } catch { return []; }
    });
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [listening, setListening] = useState(false);
    const [gpsPos, setGpsPos] = useState(null); // ubicación GPS en tiempo real
    const [userName, setUserName] = useState(() => {
        try { return localStorage.getItem(('bop_')+'chat_user') || ''; } catch { return ''; }
    });
    const [askedName, setAskedName] = useState(() => {
        try { return !!localStorage.getItem(('bop_')+'chat_user'); } catch { return false; }
    });
    const [chatLoaded, setChatLoaded] = useState(false);

    // Obtener GPS al abrir el chat — pedir permiso explícito
    useEffect(() => {
        if (!navigator.geolocation) return;
        // Intentar obtener posición fresca (sin caché)
        navigator.geolocation.getCurrentPosition(
            pos => setGpsPos({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) }),
            () => {}, // silencioso si el permiso está denegado
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 0 }
        );
        // Watch continuo para mantener actualizado
        const watcher = navigator.geolocation.watchPosition(
            pos => setGpsPos({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) }),
            () => {},
            { enableHighAccuracy: false, maximumAge: 60000 }
        );
        return () => navigator.geolocation.clearWatch(watcher);
    }, []);
    const [attach, setAttach] = useState(null);
    const [showSaveDialog, setShowSaveDialog] = useState(null);
    const [showAttachMenu, setShowAttachMenu] = useState(false);
    const scrollRef = useRef(null);
    const camRef = useRef(null);
    const galRef = useRef(null);
    const fileRef = useRef(null);
    const recognitionRef = useRef(null);

    // Persistir mensajes cada vez que cambian
    useEffect(() => {
        if (msgs.length === 0) return;
        try {
            // Guardar solo los últimos CHAT_MAX_MSGS mensajes — sin fotos (muy pesadas)
            const msgsLimpios = msgs.slice(-CHAT_MAX_MSGS).map(m => ({
                ...m,
                attach: m.attach?.isImage ? null : m.attach, // no guardar imágenes
            }));
            localStorage.setItem(('bop_')+'chat_msgs', JSON.stringify({ msgs: msgsLimpios, lastAt: Date.now() }));
        } catch { }
    }, [msgs]);

    // Función para agregar mensaje y persistir
    function addMsg(msg) {
        setMsgs(prev => {
            const next = [...prev, msg];
            return next;
        });
    }

    // Botón para limpiar chat manualmente
    function limpiarChat() {
        setMsgs([]);
        try { localStorage.removeItem(('bop_')+'chat_msgs'); } catch { }
    }

    // También consultar Supabase por si fue guardado desde otro dispositivo
    useEffect(() => {
        (async () => {
            try {
                const r = await storage.get(('bop_')+'chat_user');
                if (r?.value && r.value !== userName) {
                    setUserName(r.value);
                    setAskedName(true);
                    try { localStorage.setItem(('bop_')+'chat_user', r.value); } catch { }
                }
            } catch { }
            setChatLoaded(true);
        })();
    }, []);
    useEffect(() => {
        if (!scrollRef.current) return;
        // setTimeout garantiza que el DOM ya renderizó el nuevo mensaje
        setTimeout(() => {
            if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
        }, 50);
    }, [msgs]);

    function buildContext(txt) {
        // Contexto mínimo siempre
        const base = `Empresa: ${cfg.empresa || 'Belfast Obras'} · ${cfg.cargo || ''} · ${new Date().toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' })}`;

        // Solo incluir detalles relevantes según la pregunta
        const q = (txt || '').toLowerCase();
        const quiereObras = /obra|avance|construc|sector|plazo|cierre/i.test(q);
        const quiereLics = /licitac|presupuest|oferta|adjudic|visita/i.test(q);
        const quierePersonal = /personal|trabajador|empleado|quien|equipo/i.test(q);
        const quiereAlertas = /alerta|vencido|faltante|problema|urgente/i.test(q);
        const quiereTodo = !quiereObras && !quiereLics && !quierePersonal && !quiereAlertas;

        let ctx = base + '\n';

        if (quiereObras || quiereTodo) {
            const obrasCurso = obras.filter(o => o.estado === 'curso');
            ctx += `\nOBRAS en curso (${obrasCurso.length}/${obras.length}):\n`;
            ctx += obrasCurso.slice(0, 8).map(o =>
                `• [ID:${o.id}] ${o.nombre} · ${o.avance}% · cierre: ${o.cierre || '-'} · presupuesto: ${o.monto || '-'}`
            ).join('\n') || '(ninguna)';
        }

        if (quiereLics || quiereTodo) {
            const licsActivas = lics.filter(l => !['adjudicada', 'descartada'].includes(l.estado));
            ctx += `\nLICITACIONES activas (${licsActivas.length}):\n`;
            ctx += licsActivas.slice(0, 6).map(l =>
                `• [ID:${l.id}] ${l.nombre} · ${l.estado} · ${l.monto || '-'} · fecha: ${l.fecha || '-'}`
            ).join('\n') || '(ninguna)';
        }

        if (quierePersonal || quiereTodo) {
            ctx += `\nPERSONAL (${personal.length}):\n`;
            ctx += personal.slice(0, 10).map(p => {
                const obraA = obras.find(o => o.id === p.obra_id);
                return `• [ID:${p.id}] ${p.nombre} (${p.rol}) · obra: ${obraA?.nombre || 'sin asignar'} · tel: ${p.telefono || '-'}`;
            }).join('\n') || '(ninguno)';
        }

        if ((quiereAlertas || quiereTodo) && alerts.length > 0) {
            ctx += `\nALERTAS (${alerts.length}):\n`;
            ctx += alerts.slice(0, 6).map(a => `• [${a.prioridad}] ${a.msg}`).join('\n');
        }

        return ctx;
    }

    // Detectar si la pregunta necesita búsqueda en internet
    function necesitaBusqueda(txt) {
        return /precio|costo|cuánto sale|cuanto vale|presupuest|material|proveedor|ferretería|ferreteria|mercadolibre|sodimac|easy|cemento|hierro|pintura|porcelanato|cotizaci|m2|metro cuadrado|mano de obra|jornal|honorario|norma|reglamento|código|decreto|resolución|pliego|inflaci|dólar|dolar|índice|índic|IPC|CAC/i.test(txt);
    }

    const [loadingMsg, setLoadingMsg] = useState('');

    async function enviar() {
        const txt = input.trim();
        if (!txt && !attach) return;
        if (!askedName && !userName) {
            setMsgs(p => [...p, { id: uid(), role: 'user', text: txt }]);
            setUserName(txt);
            setAskedName(true);
            try { await storage.set(('bop_')+'chat_user', txt); } catch { }
            try { localStorage.setItem(('bop_')+'chat_user', txt); } catch { }
            setInput('');
            setTimeout(() => setMsgs(p => [...p, { id: uid(), role: 'assistant', text: `Hola ${txt}, soy tu asistente IA para BelfastCM. Tengo acceso en tiempo real a todas tus obras, licitaciones, personal y alertas. ¿En qué puedo ayudarte?` }]), 400);
            return;
        }
        const userMsg = { id: uid(), role: 'user', text: txt, attach };
        setMsgs(p => [...p, userMsg]);
        setInput(''); setAttach(null);
        setLoading(true);

        const usarBusqueda = necesitaBusqueda(txt) || (attach?.isImage && /precio|costo|presupuest|cuánto/i.test(txt));

        // Historial comprimido — solo últimos 8 mensajes (4 intercambios) para reducir tokens
        const historialReciente = [...msgs, userMsg].slice(-8);
        const history = historialReciente.map(m => {
            if (m.attach && m.role === 'user' && m.attach.isImage) {
                return { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: getMediaType(m.attach.url), data: getBase64(m.attach.url) } }, { type: 'text', text: m.text || 'Analizá esta imagen' }] };
            }
            const prefix = m.attach && !m.attach.isImage ? `[Archivo: ${m.attach.name}] ` : '';
            return { role: m.role, content: prefix + (m.text || '') };
        });

        // Mostrar estado progresivo
        if (usarBusqueda) {
            setLoadingMsg('Buscando en internet…');
        } else {
            setLoadingMsg('Pensando…');
        }

        let extraInfo = '';
        if (/dólar|dolar/i.test(txt)) {
            try { const r = await fetch('https://dolarapi.com/v1/dolares'); if (r.ok) { const d = await r.json(); extraInfo = '\nDólar HOY: ' + d.slice(0, 3).map(x => `${x.nombre}: $${x.venta}`).join(' · '); } } catch { }
        }
        if (/clima|lluvia|temperatura/i.test(txt)) {
            try { const r = await fetch('https://wttr.in/Buenos+Aires?format=j1'); if (r.ok) { const d = await r.json(); const c = d.current_condition?.[0]; if (c) extraInfo += `\nClima BsAs: ${c.temp_C}°C, ${c.weatherDesc?.[0]?.value}`; } } catch { }
        }
        // GPS — intentar SIEMPRE, usar caché si está disponible
        {
            let pos = gpsPos;
            if (!pos && navigator.geolocation) {
                try {
                    const result = await Promise.race([
                        new Promise((resolve, reject) =>
                            navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 4000, enableHighAccuracy: true, maximumAge: 30000 })
                        ),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4500))
                    ]);
                    if (result?.coords) {
                        pos = { lat: result.coords.latitude, lng: result.coords.longitude, acc: Math.round(result.coords.accuracy) };
                        setGpsPos(pos);
                    }
                } catch { }
            }
            if (pos) {
                // Incluir ubicación y link a Google Maps para que la IA pueda calcular distancias
                extraInfo += `\nUbicación GPS del usuario: ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)} (precisión ±${pos.acc}m)\nGoogle Maps: https://maps.google.com/?q=${pos.lat},${pos.lng}\nUsá estas coordenadas para calcular distancias y tiempos a cualquier lugar.`;
            }
        }

        const sys = 'Sos el asistente IA de BelfastCM, una app de gestión de obras de construcción en aeropuertos. IMPORTANTE: Sos parte de la app — tenés acceso directo a todos los datos y podés modificarlos.\n\n' +
            '=== DATOS ACTUALES DE LA APP ===\n' +
            buildContext(txt) + extraInfo + '\n\n' +
            '=== INSTRUCCIONES ===\n' +
            'Sos Beto, el asistente de BelfastCM. Hablás en argentino rioplatense, sos masculino, directo y con humor. Nunca decís "¡Claro!" ni "¡Por supuesto!". Hablás como un tipo que sabe de obras, sin vueltas. Cuando algo te da gracia, lo decís. Cuando hay que laburar, laburás.\n' +
            'Cuando el usuario pida agregar, crear, modificar o editar algo: HACELO INMEDIATAMENTE sin preguntar, incluyendo el bloque [[ACTION:...]] al final de tu respuesta.\n' +
            'NUNCA expliques cómo funciona el código. NUNCA digas que necesitás ver el código. NUNCA sugieras refrescar. SOLO actuá.\n\n' +
            '=== ACCIONES QUE PODÉS EJECUTAR ===\n' +
            'Agregar personal (uno): [[ACTION:{"tipo":"agregar_personal","datos":{"nombre":"Juan Pérez","rol":"Albañil","telefono":"","obra_id":""}}]]\n' +
            'Agregar varios personales: [[ACTION:{"tipo":"agregar_personal_multiple","lista":[{"nombre":"Juan Pérez","rol":"Albañil","telefono":""},{"nombre":"Pedro García","rol":"Capataz","telefono":""}]}]]\n' +
            'Editar personal: [[ACTION:{"tipo":"editar_personal","id":"ID_DEL_CONTEXTO","datos":{"nombre":"","rol":"","telefono":""}}]]\n' +
            'Eliminar personal: [[ACTION:{"tipo":"eliminar_personal","id":"ID_DEL_CONTEXTO","nombre":"nombre"}]]\n' +
            'Agregar licitación: [[ACTION:{"tipo":"agregar_licitacion","datos":{"nombre":"Nombre","estado":"pendiente","monto":"","fecha":""}}]]\n' +
            'Editar licitación: [[ACTION:{"tipo":"editar_licitacion","id":"ID_DEL_CONTEXTO","datos":{"nombre":"","estado":"","monto":""}}]]\n' +
            'Eliminar licitación: [[ACTION:{"tipo":"eliminar_licitacion","id":"ID_DEL_CONTEXTO","nombre":"nombre"}]]\n' +
            'Eliminar obra: [[ACTION:{"tipo":"eliminar_obra","id":"ID_DEL_CONTEXTO","nombre":"nombre"}]]\n' +
            'Actualizar obra: [[ACTION:{"tipo":"update_obra","id":"ID_DEL_CONTEXTO","campo":"avance","valor":75}]]\n' +
            'Agregar plan semanal: [[ACTION:{"tipo":"agregar_plan","datos":{"obra":"Nombre obra","semana":"dd/mm/aaaa","notas":"","dias":{"lun":{"activo":true,"desde":"08:00","hasta":"17:00","tareas":""},"mar":{"activo":false,"desde":"","hasta":"","tareas":""},"mie":{"activo":false,"desde":"","hasta":"","tareas":""},"jue":{"activo":false,"desde":"","hasta":"","tareas":""},"vie":{"activo":false,"desde":"","hasta":"","tareas":""},"sab":{"activo":false,"desde":"","hasta":"","tareas":""},"dom":{"activo":false,"desde":"","hasta":"","tareas":""}}}}]]\n' +
            'Modificar código de la app (SOLO si el usuario lo pide explícitamente): [[ACTION:{"tipo":"modificar_codigo","descripcion":"qué cambio hacer","preview":true}]]\n' +
            'Agregar gasto a obra: [[ACTION:{"tipo":"agregar_gasto","obraId":"ID_DEL_CONTEXTO","datos":{"desc":"Estacionamiento","monto":"50000","tipo":"general","fecha":"dd/mm/aaaa","quien":""}}]]\n' +
            'Crear resumen fotográfico de avance: [[ACTION:{"tipo":"crear_resumen_fotos","obraId":"ID_DEL_CONTEXTO"}]]\n' +
            'Grabar reunión: [[ACTION:{"tipo":"grabar_reunion","obra":"Nombre de la obra"}]]\n' +
            'Subir minuta (archivo): [[ACTION:{"tipo":"subir_minuta","obraId":"ID_DEL_CONTEXTO","titulo":"Minuta reunión"}]]\n' +
            'Navegar: [[ACTION:{"tipo":"navegar","destino":"obras"}]] — destinos: obras, personal, licitaciones, dashboard, cargar\n\n' +
            'REGLAS:\n' +
            '1) Cuando el usuario pida hacer algo → hacelo con [[ACTION:...]], no expliques.\n' +
            '2) Usá los IDs EXACTOS del contexto de arriba.\n' +
            '3) El JSON del ACTION debe ser válido: sin comillas curvas, sin saltos de línea adentro.\n' +
            '4) Si analizás un DNI o documento → extraé los datos y agregá la persona automáticamente.\n' +
            '5) Si el usuario pregunta por datos → respondé con la info del contexto de arriba.';

        // Streaming para respuestas más rápidas
        let r;
        if (!usarBusqueda) {
            const streamMsgId = uid();
            setMsgs(p => [...p, { id: streamMsgId, role: 'assistant', text: '…' }]);
            setLoading(false);
            r = await callAIStream(history, sys, apiKey, (texto) => {
                setMsgs(p => p.map(m => m.id === streamMsgId ? { ...m, text: texto.replace(/\[\[ACTION:[\s\S]*?\]\]/g,'').trim() || '…' } : m));
            });
            setMsgs(p => p.filter(m => m.id !== streamMsgId));
        } else {
            r = await callAI(history, sys, apiKey, usarBusqueda);
        }

        // Procesar acciones que la IA quiera ejecutar
        const actionTag = String.fromCharCode(96,96,96) + 'action';
        const closeTag = String.fromCharCode(96,96,96);
        // Detectar [[ACTION:{...}]] en la respuesta
        const accionRegex = /\[\[ACTION:([\s\S]*?)\]\]/;
        const cleanRegex = /\[\[ACTION:[\s\S]*?\]\]/g;
        const accionMatch = r.match(accionRegex);
        let textoLimpio = r.replace(cleanRegex, '').trim();
        let mensajeExtra = '';

        if (accionMatch) {
            try {
                let jsonStr = accionMatch[1]
                    .replace(/[\u2018\u2019]/g, "'")
                    .replace(/[\u201C\u201D]/g, '"')
                    .trim();
                const accion = JSON.parse(jsonStr);

                if (accion.tipo === 'agregar_personal' && accion.datos?.nombre) {
                    const nueva = { id: uid(), nombre: accion.datos.nombre, rol: accion.datos.rol || 'Operario', empresa: accion.datos.empresa || 'Belfast Obras', telefono: accion.datos.telefono || '', foto: '', obra_id: accion.datos.obra_id || '', tareas: [], docs: {} };
                    setPersonalRef.current(p => {
                        const nuevo = [...p, nueva];
                        const json = JSON.stringify(nuevo);
                        try { localStorage.setItem(SP+'personal', json); } catch {}
                        storage.set(SP+'personal', json).catch(() => {});
                        return nuevo;
                    });
                    mensajeExtra = '\n\n✅ ' + accion.datos.nombre + ' agregado al personal.';
                }
                else if (accion.tipo === 'agregar_personal_multiple' && accion.lista?.length) {
                    const nuevos = accion.lista.map(d => ({ id: uid(), nombre: d.nombre, rol: d.rol || 'Operario', empresa: d.empresa || 'Belfast Obras', telefono: d.telefono || '', foto: '', obra_id: d.obra_id || '', tareas: [], docs: {} }));
                    setPersonalRef.current(p => {
                        const nuevo = [...p, ...nuevos];
                        const json = JSON.stringify(nuevo);
                        try { localStorage.setItem(SP+'personal', json); } catch {}
                        storage.set(SP+'personal', json).catch(() => {});
                        return nuevo;
                    });
                    mensajeExtra = '\n\n✅ ' + nuevos.length + ' personas agregadas al personal:\n' + nuevos.map(n => '• ' + n.nombre + ' (' + n.rol + ')').join('\n');
                }
                else if (accion.tipo === 'editar_personal' && accion.id) {
                    setPersonalRef.current(p => p.map(x => x.id === accion.id ? { ...x, ...accion.datos } : x));
                    mensajeExtra = '\n\n✅ Personal actualizado.';
                }
                else if (accion.tipo === 'eliminar_personal' && accion.id) {
                    setPersonalRef.current(p => {
                        const nuevo = p.filter(x => x.id !== accion.id);
                        const json = JSON.stringify(nuevo);
                        try { localStorage.setItem(SP+'personal', json); } catch {}
                        storage.set(SP+'personal', json).catch(() => {});
                        return nuevo;
                    });
                    mensajeExtra = '\n\n✅ ' + (accion.nombre || 'Persona') + ' eliminado del personal.';
                }
                else if (accion.tipo === 'eliminar_licitacion' && accion.id) {
                    setLicsRef.current(p => {
                        const nuevo = p.filter(l => l.id !== accion.id);
                        const json = JSON.stringify(nuevo.map(l => ({ ...l, visitas: [] })));
                        try { localStorage.setItem(SP+'lics', json); } catch {}
                        storage.set(SP+'lics', json).catch(() => {});
                        return nuevo;
                    });
                    mensajeExtra = '\n\n✅ ' + (accion.nombre || 'Licitación') + ' eliminada.';
                }
                else if (accion.tipo === 'eliminar_obra' && accion.id) {
                    setObrasRef.current(p => {
                        const nuevo = p.filter(o => o.id !== accion.id);
                        const json = JSON.stringify(nuevo.map(o => ({ ...o, fotos: [], archivos: [] })));
                        try { localStorage.setItem(SP+'obras', json); } catch {}
                        storage.set(SP+'obras', json).catch(() => {});
                        return nuevo;
                    });
                    mensajeExtra = '\n\n✅ ' + (accion.nombre || 'Obra') + ' eliminada.';
                }
                else if (accion.tipo === 'agregar_licitacion' && accion.datos?.nombre) {
                    const nueva = { id: uid(), nombre: accion.datos.nombre, estado: accion.datos.estado || 'pendiente', monto: accion.datos.monto || '', fecha: accion.datos.fecha || new Date().toLocaleDateString('es-AR'), ap: '', visitas: [], archivos: {}, notas: '' };
                    setLicsRef.current(p => {
                        const nuevasLics = [...p, nueva];
                        const json = JSON.stringify(nuevasLics.map(l => ({ ...l, visitas: [] })));
                        try { localStorage.setItem(SP+'lics', json); } catch {}
                        storage.set(SP+'lics', json).catch(() => {});
                        return nuevasLics;
                    });
                    // Navegar a licitaciones para que el usuario la vea
                    setTimeout(() => setViewRef.current('licitaciones'), 1000);
                    mensajeExtra = '\n\n✅ Licitación "' + accion.datos.nombre + '" agregada. Navegando a Licitaciones...';
                }
                else if (accion.tipo === 'editar_licitacion' && accion.id) {
                    setLicsRef.current(p => p.map(l => l.id === accion.id ? { ...l, ...accion.datos } : l));
                    mensajeExtra = '\n\n✅ Licitación actualizada.';
                }
                else if (accion.tipo === 'agregar_obra' && accion.datos?.nombre) {
                    const nueva = { id: uid(), nombre: accion.datos.nombre, estado: accion.datos.estado || 'curso', avance: accion.datos.avance || 0, monto: accion.datos.monto || '', cierre: accion.datos.cierre || '', ap: accion.datos.ap || '', notas: accion.datos.notas || '', fotos: [], archivos: [], gastos: [] };
                    setObrasRef.current(p => {
                        const nuevo = [...p, nueva];
                        const json = JSON.stringify(nuevo.map(o => ({ ...o, fotos: [], archivos: [] })));
                        try { localStorage.setItem(SP+'obras', json); } catch {}
                        storage.set(SP+'obras', json).catch(() => {});
                        return nuevo;
                    });
                    mensajeExtra = '\n\n✅ Obra "' + accion.datos.nombre + '" agregada.';
                }
                else if (accion.tipo === 'update_obra' && (accion.id || accion.obraId)) {
                    const id = accion.id || accion.obraId;
                    setObrasRef.current(p => p.map(o => o.id === id ? { ...o, [accion.campo]: accion.valor } : o));
                    mensajeExtra = '\n\n✅ Obra actualizada.';
                }
                else if (accion.tipo === 'agregar_plan' && accion.datos?.obra) {
                    const diasBase = { lun: { activo: false, desde: '', hasta: '', tareas: '' }, mar: { activo: false, desde: '', hasta: '', tareas: '' }, mie: { activo: false, desde: '', hasta: '', tareas: '' }, jue: { activo: false, desde: '', hasta: '', tareas: '' }, vie: { activo: false, desde: '', hasta: '', tareas: '' }, sab: { activo: false, desde: '', hasta: '', tareas: '' }, dom: { activo: false, desde: '', hasta: '', tareas: '' } };
                    const nuevo = { id: uid(), obra: accion.datos.obra, semana: accion.datos.semana || new Date().toLocaleDateString('es-AR'), notas: accion.datos.notas || '', dias: { ...diasBase, ...(accion.datos.dias || {}) }, fechaCreacion: new Date().toLocaleDateString('es-AR') };
                    setPlanesRef.current(p => {
                        const nuevos = [nuevo, ...p];
                        const json = JSON.stringify(nuevos);
                        try { localStorage.setItem(SP+'planes_semanales', json); } catch {}
                        storage.set(SP+'planes_semanales', json).catch(() => {});
                        return nuevos;
                    });
                    mensajeExtra = '\n\n✅ Plan semanal para "' + accion.datos.obra + '" creado.';
                }
                else if (accion.tipo === 'modificar_codigo' && accion.descripcion) {
                    mensajeExtra = '\n\n⚙️ Generando el cambio de código...';
                    setMsgs(p => [...p, { id: uid(), role: 'assistant', text: textoLimpio + mensajeExtra }]);
                    // Pedir a la IA que genere el código específico
                    const codeSys = 'Sos un desarrollador experto en React y Next.js. Generás código limpio y funcional. Respondé SOLO con el código completo del archivo modificado, sin explicaciones ni markdown.';
                    const codeHistory = [{ role: 'user', content: `El archivo actual es AppInterna.jsx con ${obras.length} obras, ${lics.length} licitaciones y ${personal.length} personas en el contexto. Realizá este cambio: ${accion.descripcion}. Devolvé el archivo completo modificado.` }];
                    try {
                        const res = await fetch('/api/update-code', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                filePath: 'app/dashboard/AppInterna.jsx',
                                content: accion.codigo || '// pendiente',
                                message: `🤖 IA: ${accion.descripcion}`,
                                preview: accion.preview !== false
                            })
                        });
                        const data = await res.json();
                        if (data.ok) {
                            mensajeExtra = `\n\n✅ Cambio generado en rama preview.\n🔗 Probalo en: ${data.previewUrl}\n\nCuando confirmes que funciona, decime "aplicar a producción".`;
                        } else {
                            mensajeExtra = '\n\n⚠️ Error al aplicar el cambio: ' + (data.error || 'desconocido');
                        }
                    } catch(e) { mensajeExtra = '\n\n⚠️ Error: ' + e.message; }
                }
                else if (accion.tipo === 'agregar_gasto' && accion.obraId && accion.datos?.desc) {
                    const nuevoGasto = { id: uid(), desc: accion.datos.desc, monto: accion.datos.monto || '0', tipo: accion.datos.tipo || 'general', fecha: accion.datos.fecha || new Date().toLocaleDateString('es-AR'), quien: accion.datos.quien || '', comprobante: null };
                    setObrasRef.current(p => {
                        const nuevo = p.map(o => o.id === accion.obraId ? { ...o, gastos: [...(o.gastos||[]), nuevoGasto] } : o);
                        const obraName = nuevo.find(o => o.id === accion.obraId)?.nombre || 'la obra';
                        const json = JSON.stringify(nuevo.map(o => ({ ...o, fotos: [], archivos: [] })));
                        try { localStorage.setItem(SP+'obras', json); } catch {}
                        storage.set(SP+'obras', json).catch(() => {});
                        mensajeExtra = '\n\n✅ Gasto "$' + Number(accion.datos.monto||0).toLocaleString('es-AR') + ' — ' + accion.datos.desc + '" guardado en "' + obraName + '".';
                        return nuevo;
                    });
                }
                else if (accion.tipo === 'crear_resumen_fotos' && accion.obraId) {
                    const obra = obrasRef.current.find(o => o.id === accion.obraId);
                    if (obra) {
                        setLoading(true); setLoadingMsg('Generando resumen fotográfico…');
                        const fotos = obra.fotos || [];
                        const content = [];
                        fotos.slice(-8).forEach(f => { try { if (f.url?.startsWith('data:')) content.push({ type: 'image', source: { type: 'base64', media_type: getMediaType(f.url), data: getBase64(f.url) } }); } catch {} });
                        content.push({ type: 'text', text: `Generá un resumen fotográfico profesional de avance de obra para "${obra.nombre}". Describí el estado actual, los trabajos visibles, el avance estimado y las observaciones técnicas. Formato: título, fecha, estado general, descripción por foto, conclusiones.` });
                        const rFotos = await callAI([{ role: 'user', content }], 'Sos inspector de obras AA2000. Generás informes técnicos en español rioplatense.', apiKey, false);
                        const nuevoInforme = { id: uid(), tipo: 'semanal', titulo: 'Resumen fotográfico ' + new Date().toLocaleDateString('es-AR'), texto: rFotos, fecha: new Date().toLocaleDateString('es-AR'), generadoPorIA: true };
                        setObrasRef.current(p => {
                            const nuevo = p.map(o => o.id === accion.obraId ? { ...o, informes: [nuevoInforme, ...(o.informes||[])] } : o);
                            const json = JSON.stringify(nuevo.map(o => ({ ...o, fotos: [], archivos: [] })));
                            try { localStorage.setItem(SP+'obras', json); } catch {}
                            storage.set(SP+'obras', json).catch(() => {});
                            return nuevo;
                        });
                        mensajeExtra = '\n\n✅ Resumen fotográfico generado y guardado en "' + obra.nombre + '" → Informes.';
                        setLoading(false); setLoadingMsg('');
                    }
                }
                else if (accion.tipo === 'subir_minuta' && accion.obraId) {
                    const nuevoInforme = { id: uid(), tipo: 'reunion', titulo: accion.titulo || ('Minuta reunión ' + new Date().toLocaleDateString('es-AR')), texto: textoLimpio, fecha: new Date().toLocaleDateString('es-AR'), hora: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }), generadoPorIA: true };
                    setObrasRef.current(p => {
                        const nuevo = p.map(o => o.id === accion.obraId ? { ...o, informes: [nuevoInforme, ...(o.informes || [])] } : o);
                        const json = JSON.stringify(nuevo.map(o => ({ ...o, fotos: [], archivos: [] })));
                        try { localStorage.setItem(SP+'obras', json); } catch {}
                        storage.set(SP+'obras', json).catch(() => {});
                        return nuevo;
                    });
                    const nombreObra = obrasRef.current.find(o => o.id === accion.obraId)?.nombre || 'la obra';
                    mensajeExtra = '\n\n✅ Minuta guardada en "' + nombreObra + '" → Informes → Reunión.';
                }
                else if (accion.tipo === 'grabar_reunion') {
                    const obraId = accion.obraId || (obrasRef.current.find(o => o.nombre?.toLowerCase().includes((accion.obra || '').toLowerCase()))?.id) || '';
                    setTimeout(() => iniciarReunion(obraId), 500);
                    mensajeExtra = '\n\n🎙️ Iniciando grabación...';
                }
                else if (accion.tipo === 'navegar' && accion.destino) {
                    const mapa = { obras: 'obras', personal: 'personal', licitaciones: 'licitaciones', inicio: 'dashboard', dashboard: 'dashboard', cargar: 'cargar', mas: 'mas', chat: 'chat' };
                    const dest = mapa[accion.destino.toLowerCase()] || accion.destino;
                    setTimeout(() => setViewRef.current(dest), 800);
                    mensajeExtra = '\n\n✅ Navegando a ' + accion.destino + '...';
                }
            } catch(e) {
                mensajeExtra = '\n\n⚠️ Error al ejecutar: ' + e.message;
            }
        }

        setMsgs(p => [...p, { id: uid(), role: 'assistant', text: textoLimpio + mensajeExtra }]);
        setLoading(false);
        setLoadingMsg('');
        hablarTexto(textoLimpio);
    }

    async function handleAttach(e) {
        const f = e.target.files?.[0]; if (!f) return;
        const url = await toDataUrl(f);
        const isImage = f.type.startsWith('image/');
        const isPDF = f.type === 'application/pdf';
        const nuevoAttach = { url, name: f.name, type: f.type, isImage, size: f.size };
        setAttach(nuevoAttach);
        e.target.value = '';

        // Si es imagen → capturar GPS + analizar con IA
        if (isImage) {
            const obrasList = obrasRef.current.map(o => `• [ID:${o.id}] ${o.nombre}`).join('\n') || '(sin obras)';
            const licsList = licsRef.current.map(l => `• [ID:${l.id}] ${l.nombre}`).join('\n') || '(sin licitaciones)';

            // Capturar ubicación GPS en paralelo
            let gpsInfo = '';
            let gpsData = null;
            try {
                const pos = await new Promise((res, rej) =>
                    navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000, enableHighAccuracy: true })
                );
                const lat = pos.coords.latitude.toFixed(6);
                const lon = pos.coords.longitude.toFixed(6);
                const acc = Math.round(pos.coords.accuracy);
                gpsData = { lat, lon, acc };
                // Buscar dirección via API gratuita
                try {
                    const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=es`);
                    if (geoRes.ok) {
                        const geo = await geoRes.json();
                        const dir = geo.display_name || `${lat}, ${lon}`;
                        gpsInfo = `\n📍 Ubicación GPS: ${dir}\nCoordenadas: ${lat}, ${lon} (precisión: ${acc}m)\nGoogle Maps: https://maps.google.com/?q=${lat},${lon}`;
                        gpsData.direccion = dir;
                        gpsData.mapsUrl = `https://maps.google.com/?q=${lat},${lon}`;
                    }
                } catch { gpsInfo = `\n📍 GPS: ${lat}, ${lon} (precisión: ${acc}m)`; }
            } catch { gpsInfo = ''; } // Si no hay GPS, continuar igual
            setInput('');
            setTimeout(async () => {
                setLoading(true);
                setLoadingMsg('Analizando imagen y ubicación…');
                const userMsg = { id: uid(), role: 'user', text: '📷 [Foto adjunta]' + (gpsInfo ? '\n' + gpsInfo : ''), attach: nuevoAttach };
                setMsgs(p => [...p, userMsg]);
                setAttach(null);
                const history = [{
                    role: 'user',
                    content: [
                        { type: 'image', source: { type: 'base64', media_type: getMediaType(url), data: getBase64(url) } },
                        { type: 'text', text: `Analizá esta foto en detalle.${gpsInfo ? '\n\nUBICACIÓN CAPTURADA:' + gpsInfo : ''}

OBRAS disponibles:\n${obrasList}

LICITACIONES disponibles:\n${licsList}

Tu análisis debe incluir:
1. **Qué ves** — describí el terreno/predio/obra/documento en detalle
2. **Estado general** — si es terreno: baldío, con construcción, urbanizado, etc.
3. **Observaciones técnicas** — accesos, infraestructura visible, estado de avance
${gpsData ? '4. **Ubicación** — usá las coordenadas para contextualizar geográficamente el lugar' : ''}

Luego determiná dónde guardar y ejecutá la acción correspondiente.` }
                    ]
                }];
                const sys = `Sos el asistente IA de BelfastCM, especializado en construcción y desarrollo inmobiliario.\nCuando guardás foto en obra: [[ACTION:{"tipo":"guardar_foto_obra","obraId":"ID_EXACTO","descripcion":"...","gps":${gpsData ? JSON.stringify(gpsData) : 'null'}}]]\nCuando guardás foto en licitación: [[ACTION:{"tipo":"guardar_foto_lic","licId":"ID_EXACTO","descripcion":"...","gps":${gpsData ? JSON.stringify(gpsData) : 'null'}}]]\nCuando es DNI/documento de personal: [[ACTION:{"tipo":"agregar_personal","datos":{"nombre":"...","rol":"Operario","telefono":"","dni":"..."}}]]\nRespondé en español rioplatense. Sé técnico y detallado en el análisis visual.`;
                const r = await callAI(history, sys, apiKey, false);
                // Procesar acción
                const accionMatch = r.match(/\[\[ACTION:([\s\S]*?)\]\]/);
                let texto = r.replace(/\[\[ACTION:[\s\S]*?\]\]/g, '').trim();
                if (accionMatch) {
                    try {
                        const accion = JSON.parse(accionMatch[1].replace(/[\u2018\u2019]/g,"'").replace(/[\u201C\u201D]/g,'"').trim());
                        if (accion.tipo === 'guardar_foto_obra' && accion.obraId) {
                            const fotoId = uid();
                            const fotoUrl = await uploadFoto(url, 'obras/' + accion.obraId, fotoId);
                            const nuevaFoto = { id: fotoId, url: fotoUrl, nombre: f.name, fecha: new Date().toLocaleDateString('es-AR'), desc: accion.descripcion || '', gps: accion.gps || gpsData || null };
                            setObrasRef.current(p => {
                                const nuevo = p.map(o => o.id === accion.obraId ? { ...o, fotos: [...(o.fotos||[]), nuevaFoto] } : o);
                                const obraName = nuevo.find(o => o.id === accion.obraId)?.nombre || 'la obra';
                                const json = JSON.stringify(nuevo.map(o => ({ ...o, fotos: [], archivos: [] })));
                                try { localStorage.setItem(SP+'obras', json); } catch {}
                                storage.set(SP+'obras', json).catch(() => {});
                                const fotosObra = nuevo.find(o => o.id === accion.obraId)?.fotos || [];
                                const fkey = SP+'fotos_' + accion.obraId;
                                try { localStorage.setItem(fkey, JSON.stringify(fotosObra)); } catch {}
                                storage.set(fkey, JSON.stringify(fotosObra)).catch(() => {});
                                texto += '\n\n✅ Foto guardada en "' + obraName + '" → Fotos.' + (gpsData ? '\n📍 ' + (gpsData.direccion || gpsData.lat + ', ' + gpsData.lon) : '');
                                return nuevo;
                            });
                        }
                        else if (accion.tipo === 'guardar_foto_lic' && accion.licId) {
                            const fotoId = uid();
                            const fotoUrl = await uploadFoto(url, 'licitaciones/' + accion.licId, fotoId);
                            const nuevaVisita = { id: fotoId, url: fotoUrl, nombre: f.name, desc: accion.descripcion || '', etapa: 'durante', fecha: new Date().toLocaleDateString('es-AR'), hora: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }), gps: accion.gps || gpsData || null };
                            setLicsRef.current(p => {
                                const nuevo = p.map(l => l.id === accion.licId ? { ...l, visitas: [...(l.visitas||[]), nuevaVisita] } : l);
                                const licName = nuevo.find(l => l.id === accion.licId)?.nombre || 'la licitación';
                                const json = JSON.stringify(nuevo.map(l => ({ ...l, visitas: [] })));
                                try { localStorage.setItem(SP+'lics', json); } catch {}
                                storage.set(SP+'lics', json).catch(() => {});
                                const visitas = nuevo.find(l => l.id === accion.licId)?.visitas || [];
                                const vkey = SP+'lic_vis_' + accion.licId;
                                try { localStorage.setItem(vkey, JSON.stringify(visitas)); } catch {}
                                storage.set(vkey, JSON.stringify(visitas)).catch(() => {});
                                texto += '\n\n✅ Foto guardada en "' + licName + '" → Visitas.' + (gpsData ? '\n📍 ' + (gpsData.direccion || gpsData.lat + ', ' + gpsData.lon) : '');
                                return nuevo;
                            });
                        }
                        else if (accion.tipo === 'agregar_personal' && accion.datos?.nombre) {
                            const nueva = { id: uid(), nombre: accion.datos.nombre, rol: accion.datos.rol || 'Operario', empresa: 'Belfast Obras', telefono: accion.datos.telefono || '', foto: url, obra_id: '', tareas: [], docs: {}, _dni: accion.datos.dni || '' };
                            setPersonalRef.current(p => {
                                const nuevo = [...p, nueva];
                                const json = JSON.stringify(nuevo);
                                try { localStorage.setItem(SP+'personal', json); } catch {}
                                storage.set(SP+'personal', json).catch(() => {});
                                return nuevo;
                            });
                            texto += '\n\n✅ ' + accion.datos.nombre + ' agregado al personal con la foto.';
                        }
                    } catch(err) { texto += '\n\n⚠ ' + err.message; }
                }
                setMsgs(p => [...p, { id: uid(), role: 'assistant', text: texto }]);
                setLoading(false);
                setLoadingMsg('');
                hablarTexto(texto);
            }, 100);
        }
    }

    // Analizar DNI o documento desde foto/PDF
    async function analizarDocumentoPersonal(att) {
        const esDNI = /dni|documento|cedula|id\b/i.test(att.name) || att.isImage;
        const prompt = esDNI
            ? 'Analizá esta imagen. Si es un DNI argentino o documento de identidad, extraé: nombre completo, número de DNI, fecha de nacimiento, y cualquier otro dato relevante. Luego agregá a la persona al sistema de personal.'
            : 'Analizá este documento. Identificá de qué tipo es (póliza de seguro, ART, carnet, etc.) y extraé los datos más importantes como nombre, número de póliza, vigencia, etc.';
        setInput(prompt);
        setAttach(att);
        setTimeout(() => enviar(), 80);
    }

    async function analizarFotoAhora(att) {
        setInput('Analizá esta imagen y describí qué ves. Si es de una obra de construcción, identificá trabajos, estado, avance estimado y cualquier observación relevante.');
        setAttach(att);
        setTimeout(() => enviar(), 80);
    }

    async function guardarEnObra(att, obraId) {
        if (att.isImage) {
            const fotoId = uid();
            const url = await uploadFoto(att.url, 'obras/' + obraId, fotoId);
            setObras(p => p.map(o => o.id === obraId ? { ...o, fotos: [...(o.fotos || []), { id: fotoId, url, nombre: att.name, fecha: new Date().toLocaleDateString('es-AR') }] } : o));
        } else {
            const archId = uid();
            const url = await uploadFoto(att.url, 'obras/' + obraId + '/archivos', archId);
            setObras(p => p.map(o => o.id === obraId ? { ...o, archivos: [...(o.archivos || []), { id: archId, url, nombre: att.name, ext: att.name.split('.').pop().toUpperCase(), fecha: new Date().toLocaleDateString('es-AR') }] } : o));
        }
        setShowSaveDialog(null);
    }

    async function guardarEnArchivos(att) {
        try {
            // Leer del localStorage primero (síncrono y confiable)
            const localVal = storage.getLocal(('bop_')+'archivos');
            const arr = localVal?.value ? JSON.parse(localVal.value) : [];
            arr.push({ id: uid(), nombre: att.name, ext: att.name.split('.').pop().toUpperCase(), url: att.url, fecha: new Date().toLocaleDateString('es-AR'), size: att.size ? (att.size / 1024).toFixed(0) + 'KB' : '—' });
            // Guardar inmediatamente en localStorage + Supabase en background
            try { localStorage.setItem(('bop_')+'archivos', JSON.stringify(arr)); } catch { }
            storage.set(('bop_')+'archivos', JSON.stringify(arr)).catch(() => {});
        } catch { }
        setShowSaveDialog(null);
        setShowAttachMenu(false);
    }

    function startListening() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { alert('Tu navegador no soporta reconocimiento de voz'); return; }
        window.speechSynthesis?.cancel();
        const rec = new SR();
        rec.lang = 'es-AR';
        rec.continuous = true;      // NO se corta solo
        rec.interimResults = true;  // Muestra texto mientras hablás

        let textoAcumulado = '';
        let silencioTimer = null;
        let ultimoInterim = '';

        rec.onresult = e => {
            let finalNuevo = '';
            let interimActual = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                if (e.results[i].isFinal) {
                    finalNuevo += e.results[i][0].transcript + ' ';
                } else {
                    interimActual += e.results[i][0].transcript;
                }
            }
            if (finalNuevo) textoAcumulado += finalNuevo;
            ultimoInterim = interimActual;
            setInput((textoAcumulado + interimActual).trim());

            // Reiniciar timer de silencio — envía después de 2.5s sin hablar
            clearTimeout(silencioTimer);
            silencioTimer = setTimeout(() => {
                const textoFinal = (textoAcumulado + ultimoInterim).trim();
                if (textoFinal) {
                    rec.stop();
                    setListening(false);
                    setInput('');
                    enviarConTexto(textoFinal);
                }
            }, 2500);
        };

        rec.onend = () => {
            // Si el usuario tocó stop manualmente y hay texto, enviar
            const textoFinal = textoAcumulado.trim();
            if (textoFinal && listening) {
                setListening(false);
                setInput('');
                enviarConTexto(textoFinal);
            } else {
                setListening(false);
            }
        };
        rec.onerror = e => {
            if (e.error !== 'no-speech') setListening(false);
            // Si se corta por silencio, reiniciar automáticamente
            if (e.error === 'no-speech' && listening) {
                try { rec.start(); } catch {}
            }
        };
        rec.start();
        recognitionRef.current = rec;
        setListening(true);
    }

    function stopListening() {
        clearTimeout(recognitionRef.current?._silencioTimer);
        recognitionRef.current?.stop();
        setListening(false);
    }

    // ── GRABACIÓN DE REUNIÓN ──────────────────────────────────────────
    async function iniciarReunion(obraId) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mr = new MediaRecorder(stream);
            audioChunksRef.current = [];
            mr.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
            mr.start(1000);
            mediaRecorderRef.current = mr;
            setGrabando(true);
            setObraReunion(obraId);
            setTiempoGrabacion(0);
            timerRef.current = setInterval(() => setTiempoGrabacion(t => t + 1), 1000);
            addMsg({ id: uid(), role: 'assistant', text: '🎙️ Grabando reunión' + (obraId ? ' para "' + (obrasRef.current.find(o => o.id === obraId)?.nombre || obraId) + '"' : '') + '...\n\nCuando termines, tocá **Finalizar reunión**.' });
        } catch(e) {
            addMsg({ id: uid(), role: 'assistant', text: '⚠️ No se pudo acceder al micrófono: ' + e.message });
        }
    }

    async function finalizarReunion() {
        if (!mediaRecorderRef.current) return;
        clearInterval(timerRef.current);
        const mr = mediaRecorderRef.current;
        mr.stream?.getTracks().forEach(t => t.stop());

        await new Promise(resolve => { mr.onstop = resolve; mr.stop(); });

        setGrabando(false);
        addMsg({ id: uid(), role: 'assistant', text: '⏳ Procesando la grabación y generando la minuta...' });

        try {
            const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
            // Convertir a base64 para enviar a la IA
            const base64Audio = await new Promise(resolve => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.readAsDataURL(audioBlob);
            });

            // Usar Web Speech API para transcribir si está disponible
            // Si no, generar minuta basada en el contexto de la obra
            const obraObj = obrasRef.current.find(o => o.id === obraReunion);
            const nombreObra = obraObj?.nombre || 'la obra';
            const durMin = Math.floor(tiempoGrabacion / 60);
            const durSeg = tiempoGrabacion % 60;

            const promptMinuta = `Generá una minuta de reunión profesional para la obra "${nombreObra}". 
La reunión duró ${durMin}m ${durSeg}s.
Datos actuales de la obra: avance ${obraObj?.avance || 0}%, cierre: ${obraObj?.cierre || 'sin definir'}, estado: ${obraObj?.estado || 'en curso'}.
Generá una minuta con: fecha, obra, participantes (campo vacío), temas tratados, acuerdos y próximos pasos.
Al final incluí: [[ACTION:{"tipo":"subir_minuta","obraId":"${obraReunion}","titulo":"Minuta reunión ${new Date().toLocaleDateString('es-AR')}"}]]`;

            const history = [{ role: 'user', content: promptMinuta }];
            const sys = 'Sos asistente de BelfastCM. Generá minutas de reunión profesionales y concisas en español rioplatense. Siempre incluí el ACTION al final.';
            const r = await callAI(history, sys, apiKey, false);

            // Procesar acción de subir minuta
            const accionMatch = r.match(/\[\[ACTION:([\s\S]*?)\]\]/);
            let textoMinuta = r.replace(/\[\[ACTION:[\s\S]*?\]\]/g, '').trim();

            if (accionMatch && obraReunion) {
                try {
                    const accion = JSON.parse(accionMatch[1].replace(/[\u2018\u2019]/g,"'").replace(/[\u201C\u201D]/g,'"').trim());
                    const nuevoInforme = {
                        id: uid(),
                        tipo: 'reunion',
                        titulo: accion.titulo || ('Minuta reunión ' + new Date().toLocaleDateString('es-AR')),
                        texto: textoMinuta,
                        fecha: new Date().toLocaleDateString('es-AR'),
                        hora: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
                        duracion: durMin + 'm ' + durSeg + 's',
                        generadoPorIA: true,
                    };
                    setObrasRef.current(p => {
                        const nuevo = p.map(o => o.id === obraReunion ? { ...o, informes: [nuevoInforme, ...(o.informes || [])] } : o);
                        const json = JSON.stringify(nuevo.map(o => ({ ...o, fotos: [], archivos: [] })));
                        try { localStorage.setItem(SP+'obras', json); } catch {}
                        storage.set(SP+'obras', json).catch(() => {});
                        return nuevo;
                    });
                    textoMinuta += '\n\n✅ Minuta guardada en la obra "' + nombreObra + '" (pestaña Informes → Reunión).';
                } catch(e) {}
            }

            addMsg({ id: uid(), role: 'assistant', text: textoMinuta });
        } catch(e) {
            addMsg({ id: uid(), role: 'assistant', text: '⚠️ Error procesando la grabación: ' + e.message });
        }
        setObraReunion('');
        audioChunksRef.current = [];
    }

    // Leer respuesta en voz alta
    function hablarTexto(texto) {
        if (!window.speechSynthesis) return;
        window.speechSynthesis.cancel();
        // Limpiar markdown para que suene natural
        const limpio = texto
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/\*(.*?)\*/g, '$1')
            .replace(/#{1,6}\s/g, '')
            .replace(/[\u0060](.*?)[\u0060]/g, '$1')
            .replace(/\n+/g, '. ')
            .slice(0, 800);
        const utt = new SpeechSynthesisUtterance(limpio);
        utt.lang = 'es-AR';
        utt.rate = 1.05;
        utt.pitch = 1;
        // Buscar voz en español
        const voces = window.speechSynthesis.getVoices();
        const vozES = voces.find(v => v.lang.startsWith('es')) || voces[0];
        if (vozES) utt.voice = vozES;
        window.speechSynthesis.speak(utt);
    }

    // Enviar con texto específico (para auto-envío por voz)
    async function enviarConTexto(txt) {
        if (!txt?.trim()) return;
        if (!askedName && !userName) {
            setMsgs(p => [...p, { id: uid(), role: 'user', text: txt }]);
            setUserName(txt);
            setAskedName(true);
            try { await storage.set(('bop_')+'chat_user', txt); } catch { }
            try { localStorage.setItem(('bop_')+'chat_user', txt); } catch { }
            const resp = 'Hola ' + txt + ', soy tu asistente IA para BelfastCM. Tengo acceso en tiempo real a todas tus obras, licitaciones, personal y alertas. ¿En qué puedo ayudarte?';
            setTimeout(() => {
                setMsgs(p => [...p, { id: uid(), role: 'assistant', text: resp }]);
                hablarTexto(resp);
            }, 400);
            return;
        }
        const userMsg = { id: uid(), role: 'user', text: txt, attach };
        setMsgs(p => [...p, userMsg]);
        setAttach(null);
        setLoading(true);
        setLoadingMsg('Pensando…');

        const historialReciente = [...msgs, userMsg].slice(-8);
        const history = historialReciente.map(m => {
            if (m.attach && m.role === 'user' && m.attach.isImage) {
                return { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: getMediaType(m.attach.url), data: getBase64(m.attach.url) } }, { type: 'text', text: m.text || 'Analizá esta imagen' }] };
            }
            return { role: m.role, content: (m.attach && !m.attach.isImage ? '[Archivo: ' + m.attach.name + '] ' : '') + (m.text || '') };
        });

        const usarBusqueda = true;
        if (usarBusqueda) setLoadingMsg('Buscando en internet…');

        let extraInfo = '';
        if (/dólar|dolar/i.test(txt)) {
            try { const r = await fetch('https://dolarapi.com/v1/dolares'); if (r.ok) { const d = await r.json(); extraInfo = '\nDólar HOY: ' + d.slice(0, 3).map(x => x.nombre + ': $' + x.venta).join(' · '); } } catch { }
        }

        const sys = 'Sos el asistente IA de BelfastCM. Sos parte de la app — tenés acceso directo a todos los datos y podés modificarlos.\n\n' +
            '=== DATOS ACTUALES ===\n' +
            buildContext(txt) + extraInfo + '\n\n' +
            'Respondé en español rioplatense, corto y directo.\n' +
            'Cuando el usuario pida hacer algo: HACELO con [[ACTION:...]], no expliques ni preguntes.\n' +
            'NUNCA expliques código ni sugieras refrescar la página.\n\n' +
            'ACCIONES:\n' +
            'Agregar personal: [[ACTION:{"tipo":"agregar_personal","datos":{"nombre":"...","rol":"...","telefono":"","dni":""}}]]\n' +
            'Editar personal: [[ACTION:{"tipo":"editar_personal","id":"ID_DEL_CONTEXTO","datos":{"nombre":"...","rol":"..."}}]]\n' +
            'Agregar licitación: [[ACTION:{"tipo":"agregar_licitacion","datos":{"nombre":"...","estado":"pendiente","monto":"","fecha":""}}]]\n' +
            'Editar licitación: [[ACTION:{"tipo":"editar_licitacion","id":"ID_DEL_CONTEXTO","datos":{"nombre":"...","estado":"..."}}]]\n' +
            'Agregar obra: [[ACTION:{"tipo":"agregar_obra","datos":{"nombre":"...","estado":"curso","avance":0,"monto":"","cierre":""}}]]\n' +
            'Actualizar obra: [[ACTION:{"tipo":"update_obra","id":"ID_DEL_CONTEXTO","campo":"avance","valor":75}]]\n' +
            'Agregar plan: [[ACTION:{"tipo":"agregar_plan","datos":{"obra":"Nombre","semana":"dd/mm/aaaa","notas":"","dias":{"lun":{"activo":true,"desde":"08:00","hasta":"17:00","tareas":""},"mar":{"activo":false,"desde":"","hasta":"","tareas":""},"mie":{"activo":false,"desde":"","hasta":"","tareas":""},"jue":{"activo":false,"desde":"","hasta":"","tareas":""},"vie":{"activo":false,"desde":"","hasta":"","tareas":""},"sab":{"activo":false,"desde":"","hasta":"","tareas":""},"dom":{"activo":false,"desde":"","hasta":"","tareas":""}}}}]]\n' +
            'Navegar: [[ACTION:{"tipo":"navegar","destino":"obras"}]]\n' +
            'JSON del ACTION sin comillas curvas ni saltos de línea.';

        const r = await callAI(history, sys, apiKey, usarBusqueda);
        // Procesar acciones del [[ACTION:...]]
        const accionMatchV = r.match(/\[\[ACTION:([\s\S]*?)\]\]/);
        let textoFinal = r.replace(/\[\[ACTION:[\s\S]*?\]\]/g, '').trim();
        if (accionMatchV) {
            try {
                let jsonStrV = accionMatchV[1].replace(/[\u2018\u2019]/g,"'").replace(/[\u201C\u201D]/g,'"').trim();
                const accion = JSON.parse(jsonStrV);
                if (accion.tipo === 'agregar_personal' && accion.datos?.nombre) {
                    const nueva = { id: uid(), nombre: accion.datos.nombre, rol: accion.datos.rol || 'Operario', empresa: 'Belfast Obras', telefono: accion.datos.telefono || '', foto: '', obra_id: '', tareas: [], docs: {}, _dni: accion.datos.dni || '' };
                    setPersonalRef.current(p => [...p, nueva]);
                    textoFinal += '\n\n✅ ' + accion.datos.nombre + ' agregado al personal.';
                }
                else if (accion.tipo === 'editar_personal' && accion.id) {
                    setPersonalRef.current(p => p.map(x => x.id === accion.id ? { ...x, ...accion.datos } : x));
                    textoFinal += '\n\n✅ Personal actualizado.';
                }
                else if (accion.tipo === 'agregar_licitacion' && accion.datos?.nombre) {
                    const nueva = { id: uid(), nombre: accion.datos.nombre, estado: accion.datos.estado || 'pendiente', monto: accion.datos.monto || '', fecha: accion.datos.fecha || new Date().toLocaleDateString('es-AR'), ap: '', visitas: [], archivos: {}, notas: '' };
                    setLicsRef.current(p => {
                        const nuevasLics = [...p, nueva];
                        const json = JSON.stringify(nuevasLics.map(l => ({ ...l, visitas: [] })));
                        try { localStorage.setItem(SP+'lics', json); } catch {}
                        storage.set(SP+'lics', json).catch(() => {});
                        return nuevasLics;
                    });
                    textoFinal += '\n\n✅ Licitación "' + accion.datos.nombre + '" agregada.';
                }
                else if (accion.tipo === 'editar_licitacion' && accion.id) {
                    setLicsRef.current(p => p.map(l => l.id === accion.id ? { ...l, ...accion.datos } : l));
                    textoFinal += '\n\n✅ Licitación actualizada.';
                }
                else if (accion.tipo === 'agregar_obra' && accion.datos?.nombre) {
                    const nueva = { id: uid(), nombre: accion.datos.nombre, estado: accion.datos.estado || 'curso', avance: accion.datos.avance || 0, monto: accion.datos.monto || '', cierre: accion.datos.cierre || '', ap: accion.datos.ap || '', notas: accion.datos.notas || '', fotos: [], archivos: [], gastos: [] };
                    setObrasRef.current(p => {
                        const nuevo = [...p, nueva];
                        const json = JSON.stringify(nuevo.map(o => ({ ...o, fotos: [], archivos: [] })));
                        try { localStorage.setItem(SP+'obras', json); } catch {}
                        storage.set(SP+'obras', json).catch(() => {});
                        return nuevo;
                    });
                    textoFinal += '\n\n✅ Obra "' + accion.datos.nombre + '" agregada.';
                }
                else if (accion.tipo === 'update_obra' && (accion.id || accion.obraId)) {
                    const id = accion.id || accion.obraId;
                    setObrasRef.current(p => p.map(o => o.id === id ? { ...o, [accion.campo]: accion.valor } : o));
                    textoFinal += '\n\n✅ Obra actualizada.';
                }
                else if (accion.tipo === 'agregar_plan' && accion.datos?.obra) {
                    const diasBase = { lun: { activo: false, desde: '', hasta: '', tareas: '' }, mar: { activo: false, desde: '', hasta: '', tareas: '' }, mie: { activo: false, desde: '', hasta: '', tareas: '' }, jue: { activo: false, desde: '', hasta: '', tareas: '' }, vie: { activo: false, desde: '', hasta: '', tareas: '' }, sab: { activo: false, desde: '', hasta: '', tareas: '' }, dom: { activo: false, desde: '', hasta: '', tareas: '' } };
                    const nuevo = { id: uid(), obra: accion.datos.obra, semana: accion.datos.semana || new Date().toLocaleDateString('es-AR'), notas: accion.datos.notas || '', dias: { ...diasBase, ...(accion.datos.dias || {}) }, fechaCreacion: new Date().toLocaleDateString('es-AR') };
                    setPlanesRef.current(p => {
                        const nuevos = [nuevo, ...p];
                        const json = JSON.stringify(nuevos);
                        try { localStorage.setItem(SP+'planes_semanales', json); } catch {}
                        storage.set(SP+'planes_semanales', json).catch(() => {});
                        return nuevos;
                    });
                    textoFinal += '\n\n✅ Plan semanal para "' + accion.datos.obra + '" creado.';
                }
                else if (accion.tipo === 'navegar' && accion.destino) {
                    const mapa = { obras: 'obras', personal: 'personal', licitaciones: 'licitaciones', inicio: 'dashboard', dashboard: 'dashboard', cargar: 'cargar', mas: 'mas' };
                    const dest = mapa[accion.destino.toLowerCase()] || accion.destino;
                    setTimeout(() => setViewRef.current(dest), 800);
                    textoFinal += '\n\n✅ Navegando a ' + accion.destino + '...';
                }
            } catch(e) {
                textoFinal += '\n\n⚠️ Error al ejecutar: ' + e.message;
            }
        }
        setMsgs(p => [...p, { id: uid(), role: 'assistant', text: textoFinal }]);
        setLoading(false);
        setLoadingMsg('');
        hablarTexto(textoFinal);
    }

    if (!askedName && !userName && msgs.length === 0) {
        return (<div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <AppHeader title={cfg.tituloAsistente || 'Asistente IA'} sub={cfg.subtituloAsistente || 'Lee todos los datos de la app'} right={
                msgs.length > 0 ? (
                    <button onClick={() => { if (window.confirm('¿Limpiar la conversación actual?')) limpiarChat(); }} style={{ background: 'none', border: '1px solid ' + T.border, borderRadius: 8, padding: '5px 10px', fontSize: 11, color: T.muted, cursor: 'pointer', fontWeight: 600 }}>
                        Nueva conversación
                    </button>
                ) : null
            } />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "30px", textAlign: "center" }}>
                {cfg.logoAsistente ? <img src={cfg.logoAsistente} alt="" style={{ width: 90, height: 90, objectFit: "contain", marginBottom: 20 }} />
                    : <div style={{ width: 90, height: 90, borderRadius: "50%", background: 'linear-gradient(135deg, ' + T.accent + ', ' + T.navy + ')', display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 20, color: "#fff" }}>
                        <svg width="46" height="46" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0112 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 01-3.476.383.39.39 0 00-.297.17l-2.755 4.133a.75.75 0 01-1.248 0l-2.755-4.133a.39.39 0 00-.297-.17 48.9 48.9 0 01-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97zM6.75 8.25a.75.75 0 01.75-.75h9a.75.75 0 010 1.5h-9a.75.75 0 01-.75-.75zm.75 2.25a.75.75 0 000 1.5H12a.75.75 0 000-1.5H7.5z" /></svg>
                    </div>}
                <div style={{ fontSize: 18, fontWeight: 800, color: T.text, marginBottom: 8 }}>¡Hola! 👋</div>
                <div style={{ fontSize: 14, color: T.sub, marginBottom: 24, lineHeight: 1.5 }}>Antes de empezar, ¿cómo te llamás?</div>
                <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && enviar()} placeholder="Tu nombre" autoFocus style={{ width: "100%", maxWidth: 280, background: T.bg, border: '1.5px solid ' + T.border, borderRadius: T.rsm, padding: "12px 16px", fontSize: 15, color: T.text, marginBottom: 14 }} />
                <PBtn onClick={enviar} disabled={!input.trim()}>Continuar →</PBtn>
            </div>
        </div>);
    }
    return (<div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: T.bg }}>
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", paddingBottom: 68 }}>
            {msgs.length === 0 ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "30px 24px", textAlign: "center", minHeight: "100%" }}>
                    <div style={{ fontSize: 17, color: T.sub, marginBottom: 8 }}>
                        Hola, <b style={{ color: T.text }}>{userName || 'tu asistente'}</b> <span style={{ fontSize: 18 }}>👋</span>
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: T.text, marginBottom: 6, letterSpacing: "-0.02em" }}>{cfg.tituloAsistente || 'IA'}</div>
                    <div style={{ fontSize: 13, color: T.muted, marginBottom: 28, maxWidth: 300, lineHeight: 1.5 }}>
                        {cfg.subtituloAsistente || 'Lee todos los datos de la app en tiempo real'}
                    </div>
                    <button onClick={listening ? stopListening : startListening} style={{ background: T.card, border: '1.5px solid ' + T.border, borderRadius: 28, padding: 0, width: 180, height: 180, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 12px rgba(0,0,0,.06)", marginBottom: 14, transition: "all .2s" }}>
                        {cfg.logoAsistente ? <img src={cfg.logoAsistente} alt="" style={{ width: 130, height: 130, objectFit: "contain" }} />
                            : <BelfastLogo size={110} />}
                    </button>
                    <button onClick={listening ? stopListening : startListening} style={{ background: "none", border: "none", color: listening ? "#EF4444" : T.accent, fontSize: 15, fontWeight: 700, cursor: "pointer", padding: "6px 14px", marginBottom: 24 }}>
                        {listening ? 'Escuchando…' : 'Tocar para hablar'}
                    </button>
                    <div style={{ width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 10 }}>
                        {[
                            '¿Qué obras tenemos activas' + (userName ? ', ' + userName : '') + '?',
                            '¿Qué documentación le falta al personal?',
                            'Resumen del avance de todas las obras',
                            'Total de materiales y subcontratos',
                        ].map((q, i) => (
                            <button key={i} onClick={() => { setInput(q); setTimeout(() => enviar(), 50); }} style={{ width: "100%", background: T.card, border: '1px solid ' + T.border, borderRadius: T.rsm, padding: "13px 16px", textAlign: "left", fontSize: 13, color: T.text, cursor: "pointer", boxShadow: "0 1px 2px rgba(0,0,0,.03)" }}>
                                {q}
                            </button>
                        ))}
                    </div>
                    {userName && <button onClick={async () => { setUserName(''); setAskedName(false); try { await storage.delete(('bop_')+'chat_user'); } catch { } try { localStorage.removeItem(('bop_')+'chat_user'); } catch { } }} style={{ background: "none", border: "none", color: T.muted, fontSize: 12, cursor: "pointer", textDecoration: "underline", marginTop: 20 }}>
                        No soy {userName}
                    </button>}
                </div>
            ) : (<div style={{ padding: "14px", display: "flex", flexDirection: "column", gap: 10 }}>
                {msgs.map(m => (<div key={m.id} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: "82%" }}>
                    {m.attach && m.attach.isImage && <img src={m.attach.url} alt="" style={{ width: "100%", borderRadius: 10, marginBottom: 6, maxHeight: 200, objectFit: "cover" }} />}
                    {m.attach && !m.attach.isImage && (<a href={m.attach.url} download={m.attach.name} style={{ textDecoration: "none" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#F0F9FF", border: "1px solid #BAE6FD", borderRadius: 10, padding: "8px 12px", marginBottom: 6 }}>
                            <div style={{ width: 32, height: 32, borderRadius: 6, background: "#0369A1", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, flexShrink: 0 }}>{m.attach.name.split('.').pop().toUpperCase().slice(0,4)}</div>
                            <span style={{ fontSize: 11, color: "#0369A1", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.attach.name}</span>
                        </div>
                    </a>)}
                    {m.text && <div>
                        <div style={{ background: m.role === 'user' ? T.accent : T.card, color: m.role === 'user' ? "#fff" : T.text, borderRadius: 14, padding: "9px 13px", fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", border: m.role === 'user' ? "none" : '1px solid ' + T.border, boxShadow: "0 1px 2px rgba(0,0,0,.05)" }}>{m.text}</div>
                        {m.role === 'assistant' && m.text.length > 50 && (
                            <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
                                <button onClick={() => hablarTexto(m.text)} style={{ background: T.accentLight, border: '1px solid ' + T.accent, borderRadius: 20, padding: "5px 14px", fontSize: 11, fontWeight: 700, color: T.accent, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 4.06c0-1.336-1.616-2.005-2.56-1.06l-4.5 4.5H4.508c-1.141 0-2.318.664-2.66 1.905A9.76 9.76 0 001.5 12c0 .898.121 1.768.35 2.595.341 1.24 1.518 1.905 2.659 1.905h1.93l4.5 4.5c.945.945 2.561.276 2.561-1.06V4.06zM18.584 5.106a.75.75 0 011.06 0c3.808 3.807 3.808 9.98 0 13.788a.75.75 0 11-1.06-1.06 8.25 8.25 0 000-11.668.75.75 0 010-1.06z"/><path d="M15.932 7.757a.75.75 0 011.061 0 6 6 0 010 8.486.75.75 0 01-1.06-1.061 4.5 4.5 0 000-6.364.75.75 0 010-1.061z"/></svg>
                                    Escuchar
                                </button>
                                <button onClick={() => window.speechSynthesis?.cancel()} style={{ background: T.bg, border: '1px solid ' + T.border, borderRadius: 20, padding: "5px 10px", fontSize: 11, color: T.muted, cursor: "pointer" }}>
                                    ⏹ Parar
                                </button>
                                {m.text.length > 200 && <button onClick={() => {
                                    const fecha = new Date().toLocaleDateString('es-AR');
                                    const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
                                    const titulo = m.text.slice(0, 60).replace(/[#*\n]/g, '').trim() + '...';
                                    const html = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>' + titulo + '</title><style>body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;padding:0 30px;color:#1a1a1a;font-size:14px;line-height:1.7}h1{color:#1D4ED8;font-size:18px}h2{color:#1D4ED8;font-size:15px;margin-top:24px}.meta{color:#666;font-size:11px;margin-bottom:24px}.footer{margin-top:40px;font-size:11px;color:#9ca3af;text-align:center}</style></head><body><h1>BelfastCM — Asistente IA</h1><div class="meta">Fecha: ' + fecha + ' ' + hora + '</div><div>' + m.text.replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>') + '</div><div class="footer">Generado por BelfastCM × AA2000</div></body></html>';
                                    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
                                    const url = URL.createObjectURL(blob);
                                    const nombre = 'IA_' + titulo.slice(0,30).replace(/\s/g,'_') + '_' + fecha.replace(/\//g,'-') + '.html';
                                    const localVal = storage.getLocal(('bop_')+'archivos');
                                    const arr = localVal?.value ? JSON.parse(localVal.value) : [];
                                    arr.unshift({ id: uid(), nombre, ext: 'HTML', url, fecha, size: (blob.size/1024).toFixed(0)+'KB' });
                                    try { localStorage.setItem(('bop_')+'archivos', JSON.stringify(arr)); } catch {}
                                    storage.set(('bop_')+'archivos', JSON.stringify(arr)).catch(()=>{});
                                    const a = document.createElement('a'); a.href = url; a.download = nombre; a.click();
                                    setTimeout(()=>URL.revokeObjectURL(url), 3000);
                                }} style={{ background: "none", border: "none", fontSize: 10, color: T.muted, cursor: "pointer", padding: "5px 0", display: "flex", alignItems: "center", gap: 4 }}>
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                                    Guardar
                                </button>}
                            </div>
                        )}
                    </div>}
                </div>))}
                {loading && <div style={{ alignSelf: 'flex-start', padding: "10px 14px", background: T.card, border: '1px solid ' + T.border, borderRadius: 14, display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ display: "flex", gap: 4 }}>
                        {[0, .15, .3].map(d => <div key={d} style={{ width: 6, height: 6, borderRadius: "50%", background: T.accent, animation: 'pulse 1.2s infinite ' + d + 's' }} />)}
                    </div>
                    {loadingMsg && <span style={{ fontSize: 11, color: T.muted, fontWeight: 600 }}>{loadingMsg}</span>}
                </div>}
            </div>)}
        </div>
        {attach && <div style={{ padding: "6px 14px 0" }}>
            {attach.isImage ? (
                <div style={{ background: T.card, border: '1px solid ' + T.border, borderRadius: 12, padding: "10px", display: "flex", gap: 10, alignItems: "center" }}>
                    <img src={attach.url} alt="" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8, flexShrink: 0, border: '1px solid ' + T.border }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, color: T.sub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 6 }}>{attach.name}</div>
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                            <button onClick={() => analizarDocumentoPersonal(attach)} style={{ flex: 1, background: "#7C3AED", border: "none", borderRadius: 8, padding: "6px 8px", fontSize: 10, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
                                👤 Leer DNI / Doc
                            </button>
                            <button onClick={() => analizarFotoAhora(attach)} style={{ flex: 1, background: T.accent, border: "none", borderRadius: 8, padding: "6px 8px", fontSize: 10, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
                                🔍 Analizar
                            </button>
                            <button onClick={() => setShowSaveDialog(attach)} style={{ background: T.bg, border: '1px solid ' + T.border, borderRadius: 8, padding: "6px 8px", fontSize: 10, fontWeight: 600, color: T.sub, cursor: "pointer" }}>
                                💾
                            </button>
                            <button onClick={() => setAttach(null)} style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "6px 8px", fontSize: 12, color: "#EF4444", cursor: "pointer" }}>✕</button>
                        </div>
                    </div>
                </div>
            ) : attach.type === 'application/pdf' ? (
                <div style={{ background: T.card, border: '1px solid ' + T.border, borderRadius: 12, padding: "10px", display: "flex", gap: 10, alignItems: "center" }}>
                    <div style={{ width: 44, height: 44, borderRadius: 8, background: "#FEF2F2", border: "1px solid #FECACA", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <span style={{ fontSize: 10, fontWeight: 800, color: "#EF4444" }}>PDF</span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, color: T.sub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 6 }}>{attach.name}</div>
                        <div style={{ display: "flex", gap: 5 }}>
                            <button onClick={() => analizarDocumentoPersonal(attach)} style={{ flex: 1, background: "#7C3AED", border: "none", borderRadius: 8, padding: "6px 8px", fontSize: 10, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
                                👤 Analizar doc personal
                            </button>
                            <button onClick={() => setShowSaveDialog(attach)} style={{ background: T.bg, border: '1px solid ' + T.border, borderRadius: 8, padding: "6px 10px", fontSize: 11, fontWeight: 600, color: T.sub, cursor: "pointer" }}>
                                Guardar
                            </button>
                            <button onClick={() => setAttach(null)} style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "6px 8px", fontSize: 12, color: "#EF4444", cursor: "pointer" }}>✕</button>
                        </div>
                    </div>
                </div>
            ) : (
                <div style={{ display: "inline-flex", gap: 8, alignItems: "center", background: T.accentLight, border: '1px solid ' + T.accent, borderRadius: 10, padding: "5px 10px" }}>
                    <div style={{ width: 30, height: 30, borderRadius: 6, background: T.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700 }}>{attach.name.split('.').pop().toUpperCase().slice(0,4)}</div>
                    <span style={{ fontSize: 11, color: T.accent, fontWeight: 600, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{attach.name}</span>
                    <button onClick={() => setShowSaveDialog(attach)} style={{ background: T.accent, border: "none", color: "#fff", cursor: "pointer", fontSize: 10, fontWeight: 700, borderRadius: 6, padding: "3px 8px" }}>Guardar</button>
                    <button onClick={() => setAttach(null)} style={{ background: "none", border: "none", color: T.accent, cursor: "pointer", fontSize: 14, padding: 2 }}>✕</button>
                </div>
            )}
        </div>}
        <div style={{ padding: "8px 10px", background: T.card, borderTop: '1px solid ' + T.border, display: "flex", gap: 6, alignItems: "center", position: "fixed", bottom: 72, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 480, zIndex: 99 }}>
            <input ref={camRef} type="file" accept="image/*" capture="environment" onChange={handleAttach} style={{ display: "none" }} />
            <input ref={galRef} type="file" accept="image/*" onChange={handleAttach} style={{ display: "none" }} />
            <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.xlsx,.xls,.txt,.csv,.ppt,.pptx,.zip" onChange={handleAttach} style={{ display: "none" }} />
            {grabando && (
                <div style={{ position: 'absolute', bottom: 70, left: 0, right: 0, background: '#FEF2F2', borderTop: '2px solid #EF4444', padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#EF4444', animation: 'pulse 1s infinite' }} />
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#B91C1C' }}>
                            Grabando reunión • {Math.floor(tiempoGrabacion/60)}:{String(tiempoGrabacion%60).padStart(2,'0')}
                        </span>
                    </div>
                    <button onClick={finalizarReunion} style={{ background: '#EF4444', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 12, fontWeight: 700, color: '#fff', cursor: 'pointer' }}>
                        Finalizar y generar minuta
                    </button>
                </div>
            )}
            <button onClick={() => setShowAttachMenu(v => !v)} title="Adjuntar" style={{ background: T.bg, border: '1px solid ' + T.border, borderRadius: "50%", width: 36, height: 36, cursor: "pointer", flexShrink: 0, color: T.sub, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M18.97 3.659a2.25 2.25 0 00-3.182 0l-10.94 10.94a3.75 3.75 0 105.304 5.303l7.693-7.693a.75.75 0 011.06 1.06l-7.693 7.693a5.25 5.25 0 11-7.424-7.424l10.939-10.94a3.75 3.75 0 115.303 5.303L9.097 18.835l-.008.008-.007.007-.002.002-.003.002A2.25 2.25 0 015.91 15.66l7.81-7.81a.75.75 0 011.061 1.06l-7.81 7.81a.75.75 0 001.054 1.068L18.97 6.84a2.25 2.25 0 000-3.182z" /></svg>
            </button>

            <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { /* Enter solo baja línea — enviar con botón */ }} placeholder={listening ? 'Escuchando…' : 'Escribí o usá el micrófono…'} rows={2} style={{ flex: 1, background: T.bg, border: '1.5px solid ' + T.border, borderRadius: 16, padding: "10px 14px", fontSize: 15, color: T.text, minWidth: 0, resize: "none", lineHeight: 1.5, fontFamily: "inherit" }} />
            <button onClick={listening ? stopListening : startListening} title="Hablar" style={{ background: listening ? "#EF4444" : T.bg, border: '1px solid ' + listening ? "#EF4444" : T.border, borderRadius: "50%", width: 36, height: 36, cursor: "pointer", flexShrink: 0, color: listening ? "#fff" : T.sub, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8.25 4.5a3.75 3.75 0 117.5 0v8.25a3.75 3.75 0 11-7.5 0V4.5z" /><path d="M6 10.5a.75.75 0 01.75.75v1.5a5.25 5.25 0 1010.5 0v-1.5a.75.75 0 011.5 0v1.5a6.751 6.751 0 01-6 6.709v2.291h3a.75.75 0 010 1.5h-7.5a.75.75 0 010-1.5h3v-2.291a6.751 6.751 0 01-6-6.709v-1.5A.75.75 0 016 10.5z" /></svg>
            </button>
            <button onClick={enviar} disabled={!input.trim() && !attach} title="Enviar" style={{ background: (input.trim() || attach) ? T.accent : T.border, border: "none", borderRadius: "50%", width: 36, height: 36, color: "#fff", cursor: (input.trim() || attach) ? "pointer" : "not-allowed", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" /></svg>
            </button>
        </div>
        {showAttachMenu && (<Sheet title="Adjuntar" onClose={() => setShowAttachMenu(false)}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <button onClick={() => { setShowAttachMenu(false); camRef.current?.click(); }} style={{ background: T.bg, border: '1.5px solid ' + T.border, borderRadius: T.rsm, padding: "18px 10px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 44, height: 44, borderRadius: 12, background: T.accentLight, color: T.accent, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 9a3.75 3.75 0 100 7.5A3.75 3.75 0 0012 9z"/><path fillRule="evenodd" d="M9.344 3.071a49.52 49.52 0 015.312 0c.967.052 1.83.585 2.332 1.39l.821 1.317c.24.383.645.643 1.11.71.386.054.77.113 1.152.177 1.432.239 2.429 1.493 2.429 2.909V18a3 3 0 01-3 3H6a3 3 0 01-3-3V9.574c0-1.416.997-2.67 2.429-2.909.382-.064.766-.123 1.151-.178a1.56 1.56 0 001.11-.71l.822-1.315a2.942 2.942 0 012.332-1.39zM6.75 12.75a5.25 5.25 0 1110.5 0 5.25 5.25 0 01-10.5 0z" clipRule="evenodd" /></svg>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: T.text }}>Cámara</span>
                </button>
                <button onClick={() => { setShowAttachMenu(false); galRef.current?.click(); }} style={{ background: T.bg, border: '1.5px solid ' + T.border, borderRadius: T.rsm, padding: "18px 10px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 44, height: 44, borderRadius: 12, background: hexLight("#10B981"), color: "#10B981", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" d="M1.5 6a2.25 2.25 0 012.25-2.25h16.5A2.25 2.25 0 0122.5 6v12a2.25 2.25 0 01-2.25 2.25H3.75A2.25 2.25 0 011.5 18V6zM3 16.06V18c0 .414.336.75.75.75h16.5A.75.75 0 0021 18v-1.94l-2.69-2.689a1.5 1.5 0 00-2.12 0l-.88.879.97.97a.75.75 0 11-1.06 1.06l-5.16-5.159a1.5 1.5 0 00-2.12 0L3 16.061zm10.125-7.81a1.125 1.125 0 112.25 0 1.125 1.125 0 01-2.25 0z" clipRule="evenodd" /></svg>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: T.text }}>Galería</span>
                </button>
                <button onClick={() => { setShowAttachMenu(false); fileRef.current?.click(); }} style={{ background: T.bg, border: '1.5px solid ' + T.border, borderRadius: T.rsm, padding: "18px 10px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 44, height: 44, borderRadius: 12, background: hexLight("#F59E0B"), color: "#F59E0B", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0016.5 9h-1.875a1.875 1.875 0 01-1.875-1.875V5.25A3.75 3.75 0 009 1.5H5.625z" /><path d="M12.971 1.816A5.23 5.23 0 0114.25 5.25v1.875c0 .207.168.375.375.375H16.5a5.23 5.23 0 013.434 1.279 9.768 9.768 0 00-6.963-6.963z" /></svg>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: T.text }}>Archivo</span>
                </button>
            </div>
        </Sheet>)}
        {showSaveDialog && (<Sheet title="Guardar adjunto" onClose={() => setShowSaveDialog(null)}>
            <div style={{ fontSize: 12, color: T.sub, marginBottom: 14 }}>Elegí dónde guardar <b>{showSaveDialog.name}</b>:</div>
            <button onClick={() => guardarEnArchivos(showSaveDialog)} style={{ width: "100%", background: T.accentLight, border: '1.5px solid ' + T.accent, borderRadius: T.rsm, padding: "12px 14px", textAlign: "left", cursor: "pointer", marginBottom: 8, display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: T.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19.5 21a3 3 0 003-3v-4.5a3 3 0 00-3-3h-15a3 3 0 00-3 3V18a3 3 0 003 3h15zM1.5 10.146V6a3 3 0 013-3h5.379a2.25 2.25 0 011.59.659l2.122 2.121c.14.141.331.22.53.22H19.5a3 3 0 013 3v1.146A4.483 4.483 0 0019.5 9h-15a4.483 4.483 0 00-3 1.146z" /></svg>
                </div>
                <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: T.accent }}>Archivos generales</div>
                    <div style={{ fontSize: 11, color: T.sub, marginTop: 2 }}>Guardar en la carpeta "Archivos" de la app</div>
                </div>
            </button>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.05em", margin: "10px 0 6px" }}>O guardar en una obra:</div>
            {obras.length === 0 && <div style={{ fontSize: 12, color: T.muted, fontStyle: "italic", padding: "10px 0" }}>No hay obras disponibles</div>}
            {obras.map(o => (
                <button key={o.id} onClick={() => guardarEnObra(showSaveDialog, o.id)} style={{ width: "100%", background: T.card, border: '1px solid ' + T.border, borderRadius: T.rsm, padding: "10px 14px", textAlign: "left", cursor: "pointer", marginBottom: 6, display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 30, height: 30, borderRadius: 7, background: hexLight(T.navy), color: T.navy, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M4.5 2.25a.75.75 0 000 1.5v16.5h-.75a.75.75 0 000 1.5h16.5a.75.75 0 000-1.5h-.75V3.75a.75.75 0 000-1.5h-15zM9 6a.75.75 0 000 1.5h1.5a.75.75 0 000-1.5H9zm-.75 3.75A.75.75 0 019 9h1.5a.75.75 0 010 1.5H9a.75.75 0 01-.75-.75zM9 12a.75.75 0 000 1.5h1.5a.75.75 0 000-1.5H9zm3.75-5.25A.75.75 0 0113.5 6H15a.75.75 0 010 1.5h-1.5a.75.75 0 01-.75-.75zM13.5 9a.75.75 0 000 1.5H15A.75.75 0 0015 9h-1.5zm-.75 3.75a.75.75 0 01.75-.75H15a.75.75 0 010 1.5h-1.5a.75.75 0 01-.75-.75zM9 19.5v-2.25a.75.75 0 01.75-.75h4.5a.75.75 0 01.75.75V19.5H9z" /></svg>
                    </div>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{o.nombre}</div>
                        <div style={{ fontSize: 10, color: T.muted }}>{AIRPORTS.find(a => a.id === o.ap)?.code || o.ap} · {o.sector || '—'} · {showSaveDialog.isImage ? 'en Fotos' : 'en Archivos'}</div>
                    </div>
                </button>
            ))}
        </Sheet>)}
    </div>);
}

// ── ALERTAS WHATSAPP ─────────────────────────────────────────────────
async function enviarWA(phoneId, token, telefono, mensaje) {
    // Formatear número: agregar 549 si es argentino sin código
    let numero = telefono.replace(/\D/g, '');
    if (numero.startsWith('0')) numero = '54' + numero.slice(1);
    if (numero.startsWith('11') || numero.startsWith('351') || numero.startsWith('261')) numero = '54' + numero;
    if (!numero.startsWith('54')) numero = '54' + numero;
    if (numero.startsWith('549')) numero = numero; // ya tiene formato correcto
    else if (numero.startsWith('54') && !numero.startsWith('549')) numero = '549' + numero.slice(2);

    const r = await fetch('https://graph.facebook.com/v19.0/' + phoneId + '/messages', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: numero,
            type: 'text',
            text: { body: mensaje }
        })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Error ' + r.status);
    return d;
}

function AlertasWA({ cfg, personal, lics, obras, alerts, setView }) {
    const [enviando, setEnviando] = useState(false);
    const [resultados, setResultados] = useState([]);
    const [msgCustom, setMsgCustom] = useState('');
    const [destinos, setDestinos] = useState([]);
    const [tipoAlerta, setTipoAlerta] = useState('criticas');
    const [showCustom, setShowCustom] = useState(false);

    const waOk = cfg.waPhoneId && cfg.waToken;

    // Construir lista de destinatarios desde personal con teléfono
    const personalConTel = personal.filter(p => p.telefono);

    const TIPOS = [
        { id: 'criticas', label: 'Alertas críticas', color: '#EF4444', bg: '#FEF2F2' },
        { id: 'documentacion', label: 'Documentación faltante', color: '#F59E0B', bg: '#FFFBEB' },
        { id: 'licitaciones', label: 'Licitaciones urgentes', color: '#3B82F6', bg: '#EFF6FF' },
        { id: 'personalizada', label: 'Mensaje personalizado', color: '#8B5CF6', bg: '#F5F3FF' },
    ];

    function getMensajesParaTipo(tipo) {
        const hoy = new Date().toLocaleDateString('es-AR');
        switch (tipo) {
            case 'criticas':
                return alerts.filter(a => a.prioridad === 'alta').map(a => '\u26a0 BelfastCM \u2014 ALERTA CR\u00cdTICA\n' + a.msg + '\nFecha: ' + hoy);
            case 'documentacion':
                return alerts.filter(a => a.id.startsWith('docfalta') || a.id.startsWith('doc_')).map(a => '\uD83D\uDCCB BelfastCM \u2014 Documentaci\u00f3n\n' + a.msg + '\nPor favor regulariz\u00e1 esta situaci\u00f3n. Fecha: ' + hoy);
            case 'licitaciones':
                return alerts.filter(a => a.id.startsWith('lic_')).map(a => '\uD83C\uDFD7 BelfastCM \u2014 Licitaci\u00f3n\n' + a.msg + '\nFecha: ' + hoy);
            case 'personalizada':
                return msgCustom.trim() ? ['\uD83D\uDCE2 BelfastCM\n' + msgCustom.trim() + '\nFecha: ' + hoy] : [];
            default: return [];
        }
    }

    async function enviarAlertas() {
        if (!waOk) { alert('Configurá WhatsApp Business API en Más → Configuración → WhatsApp'); return; }
        const destinosSelec = destinos.length > 0 ? personalConTel.filter(p => destinos.includes(p.id)) : personalConTel;
        if (destinosSelec.length === 0) { alert('No hay personal con teléfono registrado'); return; }
        const mensajes = getMensajesParaTipo(tipoAlerta);
        if (mensajes.length === 0) { alert('No hay alertas de este tipo para enviar'); return; }

        setEnviando(true);
        setResultados([]);
        const res = [];
        const mensaje = mensajes.join('\n\n');

        for (const p of destinosSelec) {
            try {
                await enviarWA(cfg.waPhoneId, cfg.waToken, p.telefono, mensaje);
                res.push({ nombre: p.nombre, tel: p.telefono, ok: true });
            } catch (e) {
                res.push({ nombre: p.nombre, tel: p.telefono, ok: false, error: e.message });
            }
            // Pequeña pausa para no saturar la API
            await new Promise(r => setTimeout(r, 300));
        }
        setResultados(res);
        setEnviando(false);
    }

    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title="Alertas WhatsApp" back onBack={() => setView("mas")} sub="Envío masivo automático" />
        <div style={{ padding: "14px 18px" }}>

            {!waOk && (<div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 12, padding: "14px 16px", marginBottom: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#B91C1C", marginBottom: 6 }}>WhatsApp no configurado</div>
                <div style={{ fontSize: 12, color: "#7F1D1D", marginBottom: 10, lineHeight: 1.5 }}>Para enviar alertas automáticas necesitás configurar la WhatsApp Business API de Meta.</div>
                <button onClick={() => setView("mas")} style={{ background: "#B91C1C", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 12, fontWeight: 700, color: "#fff", cursor: "pointer" }}>Ir a Configuración →</button>
            </div>)}

            {/* Tipo de alerta */}
            <Card style={{ padding: "16px", marginBottom: 12 }}>
                <Lbl>Tipo de alerta a enviar</Lbl>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
                    {TIPOS.map(t => {
                        const count = t.id === 'personalizada' ? (msgCustom.trim() ? 1 : 0) : getMensajesParaTipo(t.id).length;
                        return (<button key={t.id} onClick={() => setTipoAlerta(t.id)} style={{ padding: "10px 8px", borderRadius: T.rsm, border: '1.5px solid ' + tipoAlerta === t.id ? t.color : T.border, background: tipoAlerta === t.id ? t.bg : T.card, cursor: "pointer", textAlign: "left" }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: t.color }}>{t.label}</div>
                            <div style={{ fontSize: 10, color: T.muted, marginTop: 3 }}>{count} {t.id === 'personalizada' ? 'mensaje' : ('alerta' + (count !== 1 ? 's' : ''))}</div>
                        </button>);
                    })}
                </div>

                {tipoAlerta === 'personalizada' && (
                    <Field label="Mensaje a enviar">
                        <textarea value={msgCustom} onChange={e => setMsgCustom(e.target.value)} placeholder="Ej: Mañana hay inspección en EZE Terminal A. Presentarse a las 8:00hs con documentación completa." rows={4} style={{ width: "100%", background: T.bg, border: '1.5px solid ' + T.border, borderRadius: T.rsm, padding: "10px 12px", fontSize: 13, color: T.text, resize: "none" }} />
                    </Field>
                )}

                {/* Preview del mensaje */}
                {getMensajesParaTipo(tipoAlerta).length > 0 && (
                    <div style={{ background: "#ECFDF5", border: "1px solid #86EFAC", borderRadius: 10, padding: "10px 12px", marginBottom: 14 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#15803D", marginBottom: 6, textTransform: "uppercase" }}>Preview del mensaje</div>
                        <div style={{ fontSize: 12, color: "#166534", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{getMensajesParaTipo(tipoAlerta)[0]}</div>
                        {getMensajesParaTipo(tipoAlerta).length > 1 && <div style={{ fontSize: 10, color: "#15803D", marginTop: 6 }}>+ {getMensajesParaTipo(tipoAlerta).length - 1} alertas más en el mismo mensaje</div>}
                    </div>
                )}
            </Card>

            {/* Destinatarios */}
            <Card style={{ padding: "16px", marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <Lbl>Destinatarios ({destinos.length === 0 ? ('todos \u2014 ' + personalConTel.length) : destinos.length} personas)</Lbl>
                    {destinos.length > 0 && <button onClick={() => setDestinos([])} style={{ background: "none", border: "none", fontSize: 11, color: T.accent, fontWeight: 600, cursor: "pointer" }}>Seleccionar todos</button>}
                </div>
                {personalConTel.length === 0 ? (
                    <div style={{ fontSize: 12, color: T.muted, fontStyle: "italic" }}>No hay personal con número de teléfono cargado. Agregá teléfonos en la sección Personal.</div>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {personalConTel.map(p => {
                            const sel = destinos.length === 0 || destinos.includes(p.id);
                            return (<button key={p.id} onClick={() => {
                                if (destinos.length === 0) {
                                    // Estaba "todos" → deseleccionar solo este
                                    setDestinos(personalConTel.filter(x => x.id !== p.id).map(x => x.id));
                                } else if (destinos.includes(p.id)) {
                                    const nuevos = destinos.filter(id => id !== p.id);
                                    setDestinos(nuevos.length === personalConTel.length ? [] : nuevos);
                                } else {
                                    const nuevos = [...destinos, p.id];
                                    setDestinos(nuevos.length === personalConTel.length ? [] : nuevos);
                                }
                            }} style={{ display: "flex", alignItems: "center", gap: 10, background: sel ? "#ECFDF5" : T.bg, border: '1.5px solid ' + sel ? "#86EFAC" : T.border, borderRadius: T.rsm, padding: "10px 12px", cursor: "pointer", textAlign: "left" }}>
                                <div style={{ width: 20, height: 20, borderRadius: "50%", border: '2px solid ' + sel ? "#10B981" : T.border, background: sel ? "#10B981" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                                    {sel && <svg width="11" height="11" viewBox="0 0 24 24" fill="white"><path d="M4.5 12.75l6 6 9-13.5" strokeWidth="3" stroke="white" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                                </div>
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{p.nombre}</div>
                                    <div style={{ fontSize: 11, color: T.muted }}>{p.rol} · {p.telefono}</div>
                                </div>
                            </button>);
                        })}
                    </div>
                )}
            </Card>

            {/* Botón enviar */}
            <button onClick={enviarAlertas} disabled={enviando || !waOk || personalConTel.length === 0}
                style={{ width: "100%", background: enviando ? "#94A3B8" : "#25D366", border: "none", borderRadius: T.rsm, padding: "16px", fontSize: 15, fontWeight: 800, color: "#fff", cursor: enviando ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 16 }}>
                {enviando ? (<><div style={{ width: 20, height: 20, border: "2.5px solid rgba(255,255,255,.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin .8s linear infinite" }} />Enviando...</>) : (
                    <><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M1.5 4.5a3 3 0 013-3h1.372c.86 0 1.61.586 1.819 1.42l1.105 4.423a1.875 1.875 0 01-.694 1.955l-1.293.97c-.135.101-.164.249-.126.352a11.285 11.285 0 006.697 6.697c.103.038.25.009.352-.126l.97-1.293a1.875 1.875 0 011.955-.694l4.423 1.105c.834.209 1.42.959 1.42 1.82V19.5a3 3 0 01-3 3h-2.25C8.552 22.5 1.5 15.448 1.5 6.75V4.5z" /></svg>
                    Enviar por WhatsApp</>
                )}
            </button>

            {/* Resultados */}
            {resultados.length > 0 && (<Card style={{ padding: "14px 16px" }}>
                <Lbl>Resultado del envío</Lbl>
                <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
                    <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 22, fontWeight: 800, color: "#10B981" }}>{resultados.filter(r => r.ok).length}</div>
                        <div style={{ fontSize: 10, color: T.muted }}>Enviados</div>
                    </div>
                    {resultados.filter(r => !r.ok).length > 0 && <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 22, fontWeight: 800, color: "#EF4444" }}>{resultados.filter(r => !r.ok).length}</div>
                        <div style={{ fontSize: 10, color: T.muted }}>Fallidos</div>
                    </div>}
                </div>
                {resultados.map((r, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: '1px solid ' + T.border }}>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: r.ok ? "#10B981" : "#EF4444", flexShrink: 0 }} />
                        <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{r.nombre}</div>
                            {!r.ok && <div style={{ fontSize: 10, color: "#EF4444" }}>{r.error}</div>}
                        </div>
                        <div style={{ fontSize: 10, color: r.ok ? "#10B981" : "#EF4444", fontWeight: 700 }}>{r.ok ? '✓ Enviado' : '✗ Error'}</div>
                    </div>
                ))}
            </Card>)}
        </div>
    </div>);
}


// ── RECUPERAR FOTOS DEL BUCKET ────────────────────────────────────────
function RecuperarFotos({ obras, setObras, lics, setLics, personal, setPersonal }) {
    const [estado, setEstado] = useState('idle');
    const [log, setLog] = useState([]);
    function addLog(msg) { setLog(p => [...p, msg]); }

    async function recuperarTodo() {
        setEstado('cargando'); setLog([]);
        const SP = localStorage.getItem('bop_auth_empresa') === 'vv' ? 'vv_' : 'bcm_';
        addLog('🔍 Buscando todos los datos en Supabase...');

        try {
            // 1. Restaurar obras
            const rObras = await storage.get(SP+'obras');
            if (rObras?.value) {
                const obrasBase = JSON.parse(rObras.value);
                addLog(`📦 ${obrasBase.length} obras encontradas`);

                // 2. Para cada obra, buscar sus fotos en Supabase y fusionar
                const obrasConFotos = await Promise.all(obrasBase.map(async o => {
                    try {
                        const rFotos = await storage.get(SP+'fotos_'+o.id);
                        if (rFotos?.value) {
                            const fotosRemoto = JSON.parse(rFotos.value);
                            // Fusionar con fotos locales si hay
                            const localStr = localStorage.getItem(SP+'fotos_'+o.id);
                            const fotosLocal = localStr ? JSON.parse(localStr) : [];
                            const idsLocales = new Set(fotosLocal.map(f => f.id));
                            const nuevas = fotosRemoto.filter(f => !idsLocales.has(f.id));
                            const fusionadas = [...fotosLocal, ...nuevas];
                            if (fusionadas.length) {
                                addLog(`📸 Obra "${o.nombre}": ${fusionadas.length} fotos (${fotosLocal.length} locales + ${nuevas.length} remotas)`);
                                try { localStorage.setItem(SP+'fotos_'+o.id, JSON.stringify(fusionadas)); } catch {}
                                return { ...o, fotos: fusionadas, archivos: o.archivos||[], gastos: o.gastos||[], obs: o.obs||[] };
                            }
                        }
                    } catch {}
                    return { ...o, fotos: o.fotos||[], archivos: o.archivos||[], gastos: o.gastos||[], obs: o.obs||[] };
                }));

                setObras(obrasConFotos);
                try { localStorage.setItem(SP+'obras', rObras.value); } catch {}
                addLog(`✅ Obras restauradas con fotos fusionadas`);
            } else {
                addLog('⚠ No se encontraron obras en Supabase');
            }

            // 3. Restaurar licitaciones con visitas
            const rLics = await storage.get(SP+'lics');
            if (rLics?.value) {
                const licsBase = JSON.parse(rLics.value);
                const licsConVisitas = await Promise.all(licsBase.map(async l => {
                    try {
                        const rv = await storage.get(SP+'lic_vis_'+l.id);
                        if (rv?.value) {
                            const visitasRemoto = JSON.parse(rv.value);
                            const localStr = localStorage.getItem(SP+'lic_vis_'+l.id);
                            const visitasLocal = localStr ? JSON.parse(localStr) : [];
                            const idsLocales = new Set(visitasLocal.map(v => v.id));
                            const nuevas = visitasRemoto.filter(v => !idsLocales.has(v.id));
                            const fusionadas = [...visitasLocal, ...nuevas];
                            if (fusionadas.length) {
                                addLog(`📸 Licitación "${l.nombre}": ${fusionadas.length} fotos`);
                                try { localStorage.setItem(SP+'lic_vis_'+l.id, JSON.stringify(fusionadas)); } catch {}
                                return { ...l, visitas: fusionadas };
                            }
                        }
                    } catch {}
                    return { ...l, visitas: l.visitas || [] };
                }));
                setLics(licsConVisitas);
                try { localStorage.setItem(SP+'lics', rLics.value); } catch {}
                addLog(`✅ ${licsBase.length} licitaciones restauradas`);
            }

            // 4. Restaurar personal
            const rPers = await storage.get(SP+'personal');
            if (rPers?.value) {
                const d = JSON.parse(rPers.value);
                setPersonal(d);
                try { localStorage.setItem(SP+'personal', rPers.value); } catch {}
                addLog(`✅ ${d.length} personas restauradas`);
            }

        } catch(e) { addLog('❌ Error: ' + e.message); }

        addLog('🏁 Recuperación completa. Cerrá configuración para ver los datos.');
        setEstado('done');
    }

    return (<div>
        <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 12, padding: '14px', marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#1E40AF', marginBottom: 6 }}>🔄 Recuperar datos y fotos</div>
            <div style={{ fontSize: 12, color: '#1E3A8A', lineHeight: 1.7 }}>
                Busca en Supabase todas las fotos de todos los usuarios y las fusiona. Usá esto si perdiste fotos.
            </div>
        </div>
        <button onClick={recuperarTodo} disabled={estado === 'cargando'}
            style={{ width: '100%', background: estado === 'cargando' ? '#94A3B8' : '#1D4ED8', border: 'none', borderRadius: 12, padding: '14px', fontSize: 14, fontWeight: 800, color: '#fff', cursor: estado === 'cargando' ? 'not-allowed' : 'pointer', marginBottom: 14 }}>
            {estado === 'cargando' ? '⏳ Recuperando...' : '🔄 Recuperar todas las fotos y datos'}
        </button>
        {log.length > 0 && (
            <div style={{ background: '#F0FDF4', border: '1px solid #86EFAC', borderRadius: 10, padding: '12px 14px' }}>
                {log.map((l, i) => <div key={i} style={{ fontSize: 12, color: '#166534', marginBottom: 4, lineHeight: 1.5 }}>{l}</div>)}
            </div>
        )}
    </div>);
}

// ── MAS (Más opciones + Configuración) ───────────────────────────────

function Mas({ setView, setUser, user, cfg, setCfg, apiKey, setApiKey, obras, setObras, lics, setLics, empresa, onCambiarEmpresa, personal, setPersonal }) {
    const [showCfg, setShowCfg] = useState(false);
    const [cfgSection, setCfgSection] = useState('cuenta');

    const MAS_ITEMS = [
        { id: 'licitaciones', label: 'Licitaciones', color: '#3B82F6', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg> },
        { id: 'seguimiento', label: 'Seguimiento', color: '#EF4444', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg> },
        { id: 'presupuesto_materiales', label: 'Materiales', color: '#F59E0B', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" /></svg> },
        { id: 'presupuesto_subcontratos', label: 'Subcontratos', color: '#8B5CF6', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" /></svg> },
        { id: 'informes_ia', label: 'Informes IA', color: '#10B981', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21a48.309 48.309 0 01-8.135-.687c-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" /></svg> },
        { id: 'gantt', label: 'Gantt', color: '#0891B2', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg> },
        { id: 'mensajes', label: 'Mensajes', color: '#6366F1', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8.625 9.75a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" /></svg> },
        { id: 'contactos', label: 'Contactos', color: '#14B8A6', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17.982 18.725A7.488 7.488 0 0012 15.75a7.488 7.488 0 00-5.982 2.975m11.963 0a9 9 0 10-11.963 0m11.963 0A8.966 8.966 0 0112 21a8.966 8.966 0 01-5.982-2.275M15 9.75a3 3 0 11-6 0 3 3 0 016 0z" /></svg> },
        { id: 'proveedores', label: 'Proveedores', color: '#F97316', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 00-3.213-9.193 2.056 2.056 0 00-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 00-10.026 0 1.106 1.106 0 00-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12" /></svg> },
        { id: 'vigilancia', label: 'Vigilancia', color: '#1E40AF', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg> },
        { id: 'presentismo', label: 'Presentismo', color: '#DB2777', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z" /></svg> },
        { id: 'archivos', label: 'Archivos', color: '#475569', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg> },
        { id: 'info_externa', label: 'Info externa', color: '#2563EB', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253M3.157 7.582A8.959 8.959 0 003 12c0 .778.099 1.533.284 2.253" /></svg> },
        { id: 'resumen', label: 'Resumen', color: '#059669', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7.5 14.25v2.25m3-4.5v4.5m3-6.75v6.75m3-9v9M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z" /></svg> },
        { id: 'cotizacion', label: 'Cotización', color: '#0EA5E9', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> },
        { id: 'materiales_zona', label: 'Materiales', color: '#7C3AED', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM10.5 7.5v6m3-3h-6" /></svg> },
        { id: 'alertas_wa', label: 'Alertas WA', color: '#25D366', svg: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" /></svg> },
    ];

    function updCfg(patch) { setCfg(p => ({ ...p, ...patch })); }
    function setTema(id) {
        const p = THEME_PRESETS.find(x => x.id === id);
        if (!p) return;
        updCfg({ themeId: id, colors: { accent: p.accent, al: p.al, bg: p.bg, card: p.card, border: p.border, text: p.text, sub: p.sub, muted: p.muted, navy: p.navy } });
    }
    async function handleLogoUpload(key, file) { const url = await toDataUrl(file); updCfg({ [key]: url }); }
    function agregarUbicacion() {
        const actuales = cfg.ubicaciones?.length ? cfg.ubicaciones : [...DEFAULT_UBICACIONES];
        updCfg({ ubicaciones: [...actuales, { id: uid(), code: 'NUEVO', name: 'Nueva ubicación' }] });
    }
    function updUbic(id, patch) {
        const actuales = cfg.ubicaciones?.length ? cfg.ubicaciones : [...DEFAULT_UBICACIONES];
        updCfg({ ubicaciones: actuales.map(u => u.id === id ? { ...u, ...patch } : u) });
    }
    function delUbic(id) {
        const actuales = cfg.ubicaciones?.length ? cfg.ubicaciones : [...DEFAULT_UBICACIONES];
        updCfg({ ubicaciones: actuales.filter(u => u.id !== id) });
    }
    function restaurarTema() { updCfg({ themeId: 'azul', colors: { ...DEFAULT_COLORS }, fontId: 'jakarta', radiusId: 'normal' }); }

    function logout() {
        try { localStorage.removeItem('bop_auth_user'); localStorage.removeItem('bop_auth_empresa'); } catch {}
        // Recargar la página para volver al login limpio
        window.location.reload();
    }

    return (<div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
        <AppHeader title={t(cfg, 'mas_titulo')} sub={user?.nombre || user?.rol || ''} />
        <div style={{ padding: "14px 18px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
                {MAS_ITEMS.map(m => (<button key={m.id} onClick={() => setView(m.id)} style={{ background: T.card, border: '1px solid ' + T.border, borderRadius: T.rsm, padding: "14px 8px", cursor: "pointer", boxShadow: T.shadow, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 10, background: hexLight(m.color), color: m.color, display: "flex", alignItems: "center", justifyContent: "center" }}>{m.svg}</div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: T.text, textAlign: "center", lineHeight: 1.2 }}>{m.label}</div>
                </button>))}
            </div>
            <Card style={{ padding: "14px 16px", marginBottom: 10, cursor: "pointer" }} onClick={() => setShowCfg(true)}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 42, height: 42, borderRadius: 10, background: T.accentLight, color: T.accent, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" /><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    </div>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{t(cfg, 'mas_config')}</div>
                        <div style={{ fontSize: 11, color: T.muted }}>{t(cfg, 'mas_config_sub')}</div>
                    </div>
                    <span style={{ fontSize: 18, color: T.muted }}>→</span>
                </div>
            </Card>
            {onCambiarEmpresa && (
                <Card style={{ padding: "14px 16px", cursor: "pointer", marginBottom: 10 }} onClick={onCambiarEmpresa}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ width: 42, height: 42, borderRadius: 10, background: empresa === 'vv' ? '#EFF6FF' : '#DCFCE7', color: empresa === 'vv' ? '#1D4ED8' : '#16A34A', display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></svg>
                        </div>
                        <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Cambiar empresa</div>
                            <div style={{ fontSize: 11, color: T.muted }}>Ir a {empresa === 'vv' ? 'Belfast Obras' : 'V+V Construcciones'}</div>
                        </div>
                        <span style={{ fontSize: 18, color: T.muted }}>→</span>
                    </div>
                </Card>
            )}
            <Card style={{ padding: "14px 16px", cursor: "pointer" }} onClick={logout}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 42, height: 42, borderRadius: 10, background: "#FEF2F2", color: "#EF4444", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" /></svg>
                    </div>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#EF4444" }}>{t(cfg, 'mas_cerrar_sesion')}</div>
                        <div style={{ fontSize: 11, color: T.muted }}>Volver al login</div>
                    </div>
                </div>
            </Card>
        </div>
        {showCfg && (<Sheet title="Configuración" onClose={() => setShowCfg(false)}>
            <div style={{ display: "flex", gap: 6, marginBottom: 14, overflowX: "auto" }}>
                {[{ id: 'cuenta', l: 'Cuenta' }, { id: 'tema', l: 'Tema' }, { id: 'font', l: 'Fuente' }, { id: 'forma', l: 'Forma' }, { id: 'logos', l: 'Logos' }, { id: 'ubic', l: 'Ubicaciones' }, { id: 'api', l: 'API Key' }, { id: 'whatsapp', l: 'WhatsApp' }, { id: 'textos', l: 'Textos' }, { id: 'fotos', l: '📸 Fotos' }, { id: 'actualizar', l: '🔄 Actualizar' }, ...(user?.nivel === 'superadmin' ? [{ id: 'usuarios', l: '👥 Usuarios' }] : [])].map(s => (
                    <button key={s.id} onClick={() => setCfgSection(s.id)} style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 20, border: '1.5px solid ' + cfgSection === s.id ? T.accent : T.border, background: cfgSection === s.id ? T.accentLight : T.card, color: cfgSection === s.id ? T.accent : T.sub, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>{s.l}</button>
                ))}
            </div>

            {cfgSection === 'cuenta' && (<div>
                <Field label="Empresa"><TInput value={cfg.empresa || ''} onChange={e => updCfg({ empresa: e.target.value })} placeholder="Belfast Obras" /></Field>
                <Field label="Cargo"><TInput value={cfg.cargo || ''} onChange={e => updCfg({ cargo: e.target.value })} placeholder="Gerencia de Obra" /></Field>
                <FieldRow>
                    <Field label="Email IA"><TInput value={cfg.email || ''} onChange={e => updCfg({ email: e.target.value })} placeholder="ia@empresa.com" /></Field>
                    <Field label="Teléfono"><TInput value={cfg.telefono || ''} onChange={e => updCfg({ telefono: e.target.value })} placeholder="5491155556666" /></Field>
                </FieldRow>
                <Field label="Ciudad / región"><TInput value={cfg.ciudad || ''} onChange={e => updCfg({ ciudad: e.target.value })} placeholder="Buenos Aires, Argentina" /></Field>
            </div>)}

            {cfgSection === 'tema' && (<div>
                <Lbl>Tema preestablecido</Lbl>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 14 }}>
                    {THEME_PRESETS.map(p => (<button key={p.id} onClick={() => setTema(p.id)} style={{ padding: "10px 6px", borderRadius: T.rsm, border: '1.5px solid ' + cfg.themeId === p.id ? p.accent : T.border, background: cfg.themeId === p.id ? hexLight(p.accent) : T.card, cursor: "pointer" }}>
                        <div style={{ width: 20, height: 20, borderRadius: "50%", background: p.accent, margin: "0 auto 5px" }} />
                        <div style={{ fontSize: 10, fontWeight: 700, color: T.text }}>{p.label}</div>
                    </button>))}
                </div>
                <Lbl>Colores personalizados</Lbl>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {COLOR_KEYS.map(ck => (<div key={ck.k} style={{ display: "flex", alignItems: "center", gap: 8, background: T.bg, borderRadius: 8, padding: "6px 10px" }}>
                        <input type="color" value={cfg.colors?.[ck.k] || '#000000'} onChange={e => updCfg({ colors: { ...cfg.colors, [ck.k]: e.target.value } })} style={{ width: 32, height: 32, border: "none", borderRadius: 6, cursor: "pointer", padding: 0 }} />
                        <span style={{ fontSize: 11, color: T.sub, fontWeight: 600 }}>{ck.label}</span>
                    </div>))}
                </div>
                <button onClick={restaurarTema} style={{ width: "100%", marginTop: 14, background: T.bg, border: '1.5px solid ' + T.border, borderRadius: T.rsm, padding: "10px", fontSize: 12, fontWeight: 600, color: T.sub, cursor: "pointer" }}>↺ Restaurar tema por defecto</button>
            </div>)}

            {cfgSection === 'font' && (<div>
                <Lbl>Tipografía</Lbl>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    {FONTS.map(f => (<button key={f.id} onClick={() => updCfg({ fontId: f.id })} style={{ padding: "14px 10px", borderRadius: T.rsm, border: '1.5px solid ' + cfg.fontId === f.id ? T.accent : T.border, background: cfg.fontId === f.id ? T.accentLight : T.card, cursor: "pointer", textAlign: "left" }}>
                        <div style={{ fontFamily: f.value, fontSize: 16, fontWeight: 700, color: T.text }}>{f.label}</div>
                        <div style={{ fontFamily: f.value, fontSize: 11, color: T.muted, marginTop: 2 }}>Texto de ejemplo</div>
                    </button>))}
                </div>
            </div>)}

            {cfgSection === 'forma' && (<div>
                <Lbl>Forma de los elementos</Lbl>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    {RADIUS_OPTS.map(r => (<button key={r.id} onClick={() => updCfg({ radiusId: r.id })} style={{ padding: "14px 10px", borderRadius: r.r, border: '1.5px solid ' + cfg.radiusId === r.id ? T.accent : T.border, background: cfg.radiusId === r.id ? T.accentLight : T.card, cursor: "pointer", textAlign: "center" }}>
                        <div style={{ width: 40, height: 40, borderRadius: r.r, background: T.accent, margin: "0 auto 6px" }} />
                        <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{r.label}</div>
                    </button>))}
                </div>
            </div>)}

            {cfgSection === 'logos' && (<div>
                {[{ key: 'logoBelfast', l: 'Logo izquierdo' }, { key: 'logoAA2000', l: 'Logo derecho' }, { key: 'logoAsistente', l: 'Logo asistente IA' }, { key: 'logoCentral', l: 'Logo login central' }].map(lg => (
                    <div key={lg.key} style={{ marginBottom: 12 }}>
                        <Lbl>{lg.l}</Lbl>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            {cfg[lg.key] && <img src={cfg[lg.key]} alt="" style={{ width: 50, height: 50, objectFit: "contain", borderRadius: 8, border: '1px solid ' + T.border }} />}
                            <input type="file" accept="image/*" onChange={e => e.target.files[0] && handleLogoUpload(lg.key, e.target.files[0])} style={{ flex: 1, fontSize: 11 }} />
                            {cfg[lg.key] && <button onClick={() => updCfg({ [lg.key]: "" })} style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 7, padding: "5px 10px", fontSize: 10, color: "#EF4444", cursor: "pointer" }}>✕</button>}
                        </div>
                    </div>
                ))}
                <Field label="Título asistente"><TInput value={cfg.tituloAsistente || ''} onChange={e => updCfg({ tituloAsistente: e.target.value })} placeholder="Asistente BelfastCM" /></Field>
                <Field label="Subtítulo asistente"><TInput value={cfg.subtituloAsistente || ''} onChange={e => updCfg({ subtituloAsistente: e.target.value })} placeholder="Lee todos los datos de la app" /></Field>
            </div>)}

            {cfgSection === 'ubic' && (<div>
                <Field label="Etiqueta del campo (ej: Aeropuerto, Sucursal, Obra)"><TInput value={cfg.labelUbicacion || 'Aeropuerto'} onChange={e => updCfg({ labelUbicacion: e.target.value })} /></Field>
                <Lbl>Ubicaciones</Lbl>
                {(cfg.ubicaciones?.length ? cfg.ubicaciones : DEFAULT_UBICACIONES).map(u => (<div key={u.id} style={{ display: "grid", gridTemplateColumns: "60px 1fr 34px", gap: 6, marginBottom: 6, alignItems: "center" }}>
                    <input value={u.code} onChange={e => updUbic(u.id, { code: e.target.value })} placeholder="Cód" style={{ background: T.bg, border: '1.5px solid ' + T.border, borderRadius: 8, padding: "8px 10px", fontSize: 12, fontWeight: 700, color: T.text, textTransform: "uppercase" }} />
                    <input value={u.name} onChange={e => updUbic(u.id, { name: e.target.value })} placeholder="Nombre" style={{ background: T.bg, border: '1.5px solid ' + T.border, borderRadius: 8, padding: "8px 10px", fontSize: 12, color: T.text }} />
                    <button onClick={() => delUbic(u.id)} style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "6px 8px", fontSize: 12, color: "#EF4444", cursor: "pointer" }}>✕</button>
                </div>))}
                <button onClick={agregarUbicacion} style={{ width: "100%", marginTop: 8, background: T.bg, border: '1.5px dashed ' + T.border, borderRadius: T.rsm, padding: "12px", fontSize: 13, fontWeight: 700, color: T.accent, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                    <span style={{ fontSize: 18, lineHeight: 1 }}>+</span> Agregar ubicación
                </button>
            </div>)}

            {cfgSection === 'api' && (<div>
                <div style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 10, padding: "12px 14px", marginBottom: 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#1E40AF", marginBottom: 4 }}>🔑 API Key de Claude</div>
                    <div style={{ fontSize: 11, color: "#1E3A8A", lineHeight: 1.5 }}>Necesaria para usar el asistente IA, análisis de fotos e informes automáticos. Obtenela en console.anthropic.com</div>
                </div>
                <Field label="API Key">
                    <TInput value={apiKey || ''} onChange={e => setApiKey(e.target.value.trim())} placeholder="sk-ant-api03-..." />
                </Field>
                {apiKey && <div style={{ background: "#ECFDF5", border: "1px solid #86EFAC", borderRadius: 8, padding: "8px 12px", fontSize: 11, color: "#15803D", fontWeight: 600 }}>✓ API Key configurada</div>}
            </div>)}

            {cfgSection === 'whatsapp' && (<div>
                <div style={{ background: "#ECFDF5", border: "1px solid #86EFAC", borderRadius: 10, padding: "12px 14px", marginBottom: 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#15803D", marginBottom: 4 }}>📱 WhatsApp Business API — Meta</div>
                    <div style={{ fontSize: 11, color: "#166534", lineHeight: 1.6 }}>
                        Para configurar:<br/>
                        1. Andá a developers.facebook.com<br/>
                        2. Creá una app → agregá WhatsApp<br/>
                        3. Registrá tu número dedicado<br/>
                        4. Pegá las credenciales acá abajo
                    </div>
                    <a href="https://developers.facebook.com" target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                        <button style={{ marginTop: 10, background: "#15803D", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 11, fontWeight: 700, color: "#fff", cursor: "pointer" }}>Abrir Meta Developers →</button>
                    </a>
                </div>
                <Field label="Phone Number ID">
                    <TInput value={cfg.waPhoneId || ''} onChange={e => updCfg({ waPhoneId: e.target.value.trim() })} placeholder="123456789012345" />
                </Field>
                <Field label="WhatsApp Business Account ID (WABA ID)">
                    <TInput value={cfg.waWabaId || ''} onChange={e => updCfg({ waWabaId: e.target.value.trim() })} placeholder="987654321098765" />
                </Field>
                <Field label="Access Token (permanente)">
                    <TInput value={cfg.waToken || ''} onChange={e => updCfg({ waToken: e.target.value.trim() })} placeholder="EAAxxxxxx..." />
                </Field>
                {cfg.waPhoneId && cfg.waToken ? (
                    <div style={{ background: "#ECFDF5", border: "1px solid #86EFAC", borderRadius: 8, padding: "10px 12px", fontSize: 11, color: "#15803D", fontWeight: 600 }}>
                        ✓ WhatsApp configurado — podés enviar alertas desde Más → Alertas WhatsApp
                    </div>
                ) : (
                    <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 12px", fontSize: 11, color: "#92400E" }}>
                        ⚠ Completá Phone Number ID y Access Token para activar el envío automático
                    </div>
                )}
                <div style={{ marginTop: 14, background: T.bg, borderRadius: 10, padding: "12px 14px" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: T.sub, marginBottom: 6 }}>Cómo conseguir el Access Token permanente:</div>
                    <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6 }}>
                        1. Meta Business → Configuración → Usuarios del sistema<br/>
                        2. Creá un usuario del sistema (Admin)<br/>
                        3. Asignale el app BelfastCM con rol Admin<br/>
                        4. Generá token → seleccioná permisos: whatsapp_business_messaging<br/>
                        5. Sin fecha de vencimiento → copiá el token
                    </div>
                </div>
            </div>)}

            {cfgSection === 'textos' && (<div>
                <div style={{ fontSize: 11, color: T.muted, marginBottom: 10, lineHeight: 1.5 }}>Personalizá los textos que se muestran en la app. Dejá en blanco para usar el texto por defecto.</div>
                {Object.entries(DEFAULT_TEXTOS).slice(0, 30).map(([k, defVal]) => (
                    <div key={k} style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: T.sub, marginBottom: 3, fontFamily: "monospace" }}>{k}</div>
                        <input value={cfg.textos?.[k] ?? defVal} onChange={e => updCfg({ textos: { ...cfg.textos, [k]: e.target.value } })} placeholder={defVal} style={{ width: "100%", background: T.bg, border: '1.5px solid ' + T.border, borderRadius: 8, padding: "7px 10px", fontSize: 12, color: T.text }} />
                    </div>
                ))}
                <div style={{ fontSize: 11, color: T.muted, marginTop: 10, fontStyle: "italic" }}>... y muchos más. Podés editarlos todos desde el código fuente.</div>
            </div>)}

            {cfgSection === 'fotos' && (<RecuperarFotos obras={obras} setObras={setObras} lics={lics} setLics={setLics} personal={personal} setPersonal={setPersonal} />)}
            {cfgSection === 'actualizar' && (<div>
                <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 12, padding: 14, marginBottom: 14 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#1E40AF', marginBottom: 6 }}>🔄 Actualizar aplicación</div>
                    <div style={{ fontSize: 12, color: '#1E3A8A', lineHeight: 1.7 }}>Fuerza la descarga de la última versión de la app. Usá esto si ves que los cambios no aparecen.</div>
                </div>
                <button onClick={() => {
                    if ('serviceWorker' in navigator) {
                        navigator.serviceWorker.getRegistrations().then(regs => {
                            Promise.all(regs.map(r => r.unregister())).then(() => {
                                caches.keys().then(keys => {
                                    Promise.all(keys.map(k => caches.delete(k))).then(() => {
                                        window.location.reload(true);
                                    });
                                });
                            });
                        });
                    } else {
                        window.location.reload(true);
                    }
                }} style={{ width: '100%', background: '#1D4ED8', border: 'none', borderRadius: 12, padding: 14, fontSize: 14, fontWeight: 800, color: '#fff', cursor: 'pointer' }}>
                    🔄 Borrar caché y actualizar ahora
                </button>
            </div>)}
            {cfgSection === 'usuarios' && user?.nivel === 'superadmin' && (<GestionUsuarios obras={obras} />)}

            <PBtn full onClick={() => setShowCfg(false)} style={{ marginTop: 14 }}>✓ Guardar y cerrar</PBtn>
        </Sheet>)}
    </div>);
}

// ── LOGIN SCREEN ─────────────────────────────────────────────────────
function LoginScreenViejo({ onLogin, cfg, personal }) {
    const [u, setU] = useState('');
    const [p, setP] = useState('');
    const [err, setErr] = useState('');
    const [showPass, setShowPass] = useState(false);

    function login() {
        const usuario = u.trim().toLowerCase();
        const contra = p.trim();
        if (!usuario || !contra) { setErr('Completá usuario y contraseña'); return; }

        const admin = ADMIN_CREDS.find(c => c.user === usuario && c.pass === contra);
        if (admin) { onLogin(admin); return; }

        const emp = (personal || []).find(x => x.appUser === usuario && x.appPass === contra);
        if (emp) { onLogin({ ...emp, user: emp.appUser, rol: emp.rol || 'Empleado' }); return; }

        setErr('Usuario o contraseña incorrectos');
    }

    return (<div style={{ height: "100vh", display: "flex", flexDirection: "column", background: T.bg, overflow: "hidden" }}>
        <AppBrand cfg={cfg} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px" }}>
            {cfg.logoCentral ? <img src={cfg.logoCentral} alt="" style={{ width: 100, height: 100, objectFit: "contain", marginBottom: 20 }} />
                : <div style={{ width: 90, height: 90, borderRadius: 20, background: T.navy, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 20, color: "#fff", fontSize: 30, fontWeight: 800, boxShadow: "0 4px 20px rgba(0,0,0,.15)" }}>B</div>}
            <div style={{ fontSize: 22, fontWeight: 800, color: T.text, marginBottom: 4, letterSpacing: "-0.02em" }}>BelfastCM</div>
            <div style={{ fontSize: 13, color: T.muted, marginBottom: 30 }}>Construction Management</div>
            <div style={{ width: "100%", maxWidth: 340 }}>
                <Field label="Usuario">
                    <input value={u} onChange={e => { setU(e.target.value); setErr(''); }} placeholder="Usuario"
                        autoCapitalize="none" autoCorrect="off" autoComplete="username"
                        onKeyDown={e => e.key === 'Enter' && login()}
                        style={{ width: "100%", background: T.card, border: '1.5px solid ' + err ? '#FECACA' : T.border, borderRadius: T.rsm, padding: "12px 16px", fontSize: 14, color: T.text }} />
                </Field>
                <Field label="Contraseña">
                    <div style={{ position: "relative" }}>
                        <input type={showPass ? "text" : "password"} value={p} onChange={e => { setP(e.target.value); setErr(''); }}
                            placeholder="••••••••" autoComplete="current-password"
                            onKeyDown={e => e.key === 'Enter' && login()}
                            style={{ width: "100%", background: T.card, border: '1.5px solid ' + err ? '#FECACA' : T.border, borderRadius: T.rsm, padding: "12px 44px 12px 16px", fontSize: 14, color: T.text }} />
                        <button onClick={() => setShowPass(v => !v)} type="button"
                            style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: showPass ? T.accent : T.muted, padding: 4, display: "flex", alignItems: "center" }}>
                            {showPass
                                ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                                : <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" stroke="currentColor" strokeWidth="1.5" /><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" strokeWidth="1.5" /></svg>
                            }
                        </button>
                    </div>
                </Field>
                {err && <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 10, padding: "9px 14px", fontSize: 12, color: "#EF4444", marginBottom: 14, fontWeight: 600, textAlign: "center" }}>{err}</div>}
                <PBtn full onClick={login} style={{ padding: "13px", fontSize: 15 }}>Ingresar</PBtn>
                <div style={{ textAlign: "center", fontSize: 10, color: T.muted, marginTop: 20, lineHeight: 1.6 }}>
                    Demo: <b>admin</b> / <b>belfast2025</b> (administrador)<br/>
                    o <b>supervisor</b> / <b>obra2025</b>
                </div>
            </div>
        </div>
    </div>);
}

// ═══════════════════════════════════════════════════════════════════════
// ── APP PRINCIPAL ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

// Error boundary: si algo falla, muestra el error en lugar de pantalla blanca
class ErrorBoundary extends React.Component {
    constructor(props) { super(props); this.state = { hasError: false, error: null, info: null }; }
    static getDerivedStateFromError(error) { return { hasError: true, error }; }
    componentDidCatch(error, info) { console.error('[BelfastCM Error]', error, info); this.setState({ info }); }
    render() {
        if (this.state.hasError) {
            return (<div style={{ minHeight: "100vh", padding: "30px 20px", background: "#FEF2F2", fontFamily: "-apple-system, sans-serif", color: "#7F1D1D" }}>
                <div style={{ maxWidth: 600, margin: "0 auto", background: "#fff", borderRadius: 14, padding: "24px", border: "2px solid #FECACA" }}>
                    <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 8, color: "#B91C1C" }}>⚠ Error en la app</div>
                    <div style={{ fontSize: 13, color: "#7F1D1D", marginBottom: 16, lineHeight: 1.6 }}>La app encontró un error y no puede continuar. Mandale esta pantalla al desarrollador:</div>
                    <div style={{ background: "#FEF2F2", borderRadius: 8, padding: "12px 14px", fontFamily: "monospace", fontSize: 11, color: "#991B1B", marginBottom: 14, wordBreak: "break-word", whiteSpace: "pre-wrap", maxHeight: 200, overflowY: "auto", border: "1px solid #FECACA" }}>
                        <b>{this.state.error?.name || 'Error'}:</b> {this.state.error?.message || 'sin detalle'}
                        {this.state.error?.stack && <div style={{ marginTop: 10, opacity: .7, fontSize: 10 }}>{String(this.state.error.stack).split('\n').slice(0, 5).join('\n')}</div>}
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                        <button onClick={() => { try { localStorage.clear(); } catch { } location.reload(); }} style={{ flex: 1, background: "#B91C1C", color: "#fff", border: "none", borderRadius: 10, padding: "12px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                            Borrar caché y reiniciar
                        </button>
                        <button onClick={() => location.reload()} style={{ flex: 1, background: "#fff", color: "#B91C1C", border: "1.5px solid #FECACA", borderRadius: 10, padding: "12px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                            Recargar
                        </button>
                    </div>
                </div>
            </div>);
        }
        return this.props.children;
    }
}

function AppInner({ supaSession, empresa, onCambiarEmpresa }) {
    // Config base según empresa seleccionada
    const empresaConfig = empresa === 'vv' ? {
        empresa: 'V+V Construcciones',
        cargo: 'Gerencia de Obra',
        tituloAsistente: 'Asistente V+V',
        subtituloAsistente: 'Gestión de proyectos privados',
        themeId: 'verde',
        colors: { accent: '#16A34A', al: '#DCFCE7', bg: '#F0FDF4', card: '#fff', border: '#BBF7D0', text: '#0F172A', sub: '#475569', muted: '#94A3B8', navy: '#14532D' },
        textos: {
            nav_licitaciones: 'Obras',
            lic_titulo: 'Obras',
            lic_nueva: 'Nueva obra',
            lic_crear: 'Crear obra',
            lic_eliminar: 'Eliminar obra',
            dash_licitaciones: 'Obras',
            dash_nueva_lic: 'Nueva obra',
        },
    } : {};
    // Helpers de carga sincrónica desde localStorage
    function getLocalJSON(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } }
    function getLocalStr(k, def = '') { try { return localStorage.getItem(k) || def; } catch { return def; } }

    // Setear user desde sesión Supabase automáticamente
    const supaUser = supaSession?.user ? {
        id: supaSession.user.id,
        nombre: supaSession.user.email?.split('@')[0] || 'Usuario',
        email: supaSession.user.email,
        rol: 'admin',
        pass: '',
    } : null;

    const [user, setUser] = useState(() => supaUser || getLocalJSON(SP+'current_user', null));
    const [view, setView] = useState('chat');
    const [detailObraId, setDetailObraId] = useState(null);
    // Prefijo de storage según empresa (evita mezclar datos Belfast/VV)
    const SP = 'bop_';
    // Exponer SP globalmente para que componentes hijos puedan usarlo
    window.__APP_SP = SP;
    const [lics, setLics] = useState(() => {
        const licsBase = getLocalJSON(SP + 'lics', []);
        // Restaurar visitas (fotos) desde keys separadas al arrancar
        return licsBase.map(l => ({
            ...l,
            visitas: getLocalJSON(SP+'lic_vis_' + l.id, l.visitas || [])
        }));
    });
    const [obras, setObras] = useState(() => {
        const obrasBase = getLocalJSON(SP + 'obras', []);
        // Restaurar fotos desde keys separadas al arrancar
        return obrasBase.map(o => ({
            ...o,
            fotos: getLocalJSON(SP+'fotos_' + o.id, []),
            archivos: getLocalJSON(SP+'archs_' + o.id, []),
            gastos: o.gastos || []
        }));
    });
    const [personal, setPersonal] = useState(() => getLocalJSON(SP + 'personal', []));
    const [planes, setPlanes] = useState(() => getLocalJSON(SP + 'planes_semanales', []));
    const [alerts, setAlerts] = useState([]);
    const [unreadMsgs, setUnreadMsgs] = useState(0);

    // Contar mensajes no leídos para el badge del nav
    useEffect(() => {
        const myId = user?.usuario || user?.user || user?.appUser || 'anon';
        async function checkUnread() {
            try {
                const r = await storage.get(SP+'mensajes');
                if (r?.value) {
                    const msgs = JSON.parse(r.value);
                    const n = msgs.filter(m =>
                        (m.tipo === 'privado' && m.para === myId && !m.leido) ||
                        (m.tipo === 'obra' && !m.leidoPor?.includes(myId) && m.de !== myId)
                    ).length;
                    setUnreadMsgs(n);
                }
            } catch {}
        }
        checkUnread();
        const iv = setInterval(checkUnread, 5000);
        return () => clearInterval(iv);
    }, [user]);

    const [cfg, setCfg] = useState(() => {
        const saved = getLocalJSON(SP + 'cfg', {});
        const merged = { ...DEFAULT_CONFIG, ...empresaConfig, ...saved };
        // Los textos de empresa SIEMPRE tienen prioridad sobre el cfg guardado
        if (empresaConfig.textos) {
            merged.textos = { ...DEFAULT_CONFIG.textos, ...(saved.textos || {}), ...empresaConfig.textos };
        }
        return merged;
    });
    const [apiKey, setApiKey] = useState(() => getLocalStr(SP+'api_key', ''));
    const [loaded, setLoaded] = useState(false);
    const [realtimeOk, setRealtimeOk] = useState(false); // indicador de conexión en tiempo real
    const [authRequest, setAuthRequest] = useState(null);
    const [cargarState, setCargarState] = useState({ obraId: '', newFotos: [], report: '' });


    // Cargar datos al inicio — localStorage primero, luego bcm_storage como fallback
    useEffect(() => {
        (async () => {
            try {
                // Cargar cfg desde Supabase si la local es más vieja
                const cfgRemota = await storage.get("bcm_cfg");
                if (cfgRemota?.value) {
                    const parsed = JSON.parse(cfgRemota.value);
                    const { _ts, ...cfgLimpia } = parsed;
                    const localCfgStr = localStorage.getItem("bcm_cfg");
                    const localTs = localCfgStr ? (JSON.parse(localCfgStr)._ts || 0) : 0;
                    if (!localCfgStr || (_ts || 0) > localTs) {
                        setCfg({ ...DEFAULT_CONFIG, ...cfgLimpia });
                        try { localStorage.setItem("bcm_cfg", cfgRemota.value); } catch {}
                    }
                }
                // Cargar API key desde Supabase si no hay local
                const localApiKey = localStorage.getItem("bcm_api_key");
                if (!localApiKey) {
                    const remoteApiKey = await storage.get("bcm_api_key");
                    if (remoteApiKey?.value) {
                        setApiKey(remoteApiKey.value);
                        try { localStorage.setItem("bcm_api_key", remoteApiKey.value); } catch {}
                    }
                }
                // Cargar lics desde bcm_storage si localStorage vacío
                if (!getLocalJSON(SP+'lics', []).length) {
                    const r = await storage.get(SP+'lics');
                    if (r?.value) { const d = JSON.parse(r.value); if (d?.length) { setLics(d); try { localStorage.setItem(SP+'lics', r.value); } catch {} } }
                }
                // Cargar obras y restaurar fotos desde keys separadas
                const obrasLocal = getLocalJSON(SP+'obras', []);
                if (!obrasLocal.length) {
                    const r = await storage.get(SP+'obras');
                    if (r?.value) { 
                        const d = JSON.parse(r.value); 
                        if (d?.length) { 
                            const obrasConFotos = d.map(o => {
                                const fotosLocal = getLocalJSON(SP+'fotos_' + o.id, []);
                                const archivosLocal = getLocalJSON(SP+'archs_' + o.id, []);
                                return { ...o, fotos: fotosLocal, archivos: archivosLocal, gastos: o.gastos||[] };
                            });
                            setObras(obrasConFotos); 
                            try { localStorage.setItem(SP+'obras', r.value); } catch {} 
                        } 
                    }
                } else {
                    // Restaurar fotos de obras que ya están en localStorage
                    setObras(obrasLocal.map(o => {
                        const fotosLocal = getLocalJSON(SP+'fotos_' + o.id, []);
                        const archivosLocal = getLocalJSON(SP+'archs_' + o.id, []);
                        return { ...o, fotos: fotosLocal, archivos: archivosLocal, gastos: o.gastos||[] };
                    }));
                }
                // Cargar personal
                if (!getLocalJSON(SP+'personal', []).length) {
                    const r = await storage.get(SP+'personal');
                    if (r?.value) { const d = JSON.parse(r.value); if (d?.length) { setPersonal(d); try { localStorage.setItem(SP+'personal', r.value); } catch {} } }
                }
                // Cargar planes
                if (!getLocalJSON(SP+'planes_semanales', []).length) {
                    const r = await storage.get(SP+'planes_semanales');
                    if (r?.value) { const d = JSON.parse(r.value); if (d?.length) { setPlanes(d); try { localStorage.setItem(SP+'planes_semanales', r.value); } catch {} } }
                }
            } catch(e) {
                console.error('Error cargando datos:', e);
            }
            setLoaded(true); // loaded=true DESPUÉS de cargar todo
        })();
    }, []);

    // Refs para evitar sobrescribir cambios locales recientes
    const lastLocalEditRef = useRef({ lics: 0, obras: 0, personal: 0, cfg: 0 });
    function markLocalEdit(key) { lastLocalEditRef.current[key] = Date.now(); }

    // Persistir cambios — obras se guardan SIN fotos/archivos (esos van en keys separadas via upd())
    // Persistir lics SIN visitas (las fotos van en bcm_lic_vis_{id})
    useEffect(() => {
        if (!loaded) return;
        if (!lics.length) return; // NUNCA guardar vacío — pisaría datos reales
        markLocalEdit('lics');
        // Marcar inmediatamente para proteger del sync entrante
        try { (window.__lastSave = window.__lastSave||{}).__lics = Date.now(); } catch {}
        const licsSinVisitas = lics.map(l => ({ ...l, visitas: [] }));
        const json = JSON.stringify(licsSinVisitas);
        // Guardar en localStorage primero (síncrono, instantáneo)
        try { localStorage.setItem(SP+'lics', json); } catch { }
        // Luego en Supabase (async)
        storage.set(SP+'lics', json).catch(() => { });
        // Guardar visitas de cada lic en su propia key
        lics.forEach(l => {
            if (!l.visitas?.length) return;
            const key = SP+'lic_vis_' + l.id;
            const vjson = JSON.stringify(l.visitas);
            try { localStorage.setItem(key, vjson); } catch { }
            storage.set(key, vjson).catch(() => { });
        });
    }, [lics, loaded]);
    useEffect(() => {
        if (!loaded) return;
        if (!obras.length) return; // NUNCA guardar vacío
        markLocalEdit('obras');
        // Guardar obras sin fotos/archivos para no superar el límite de 5MB
        const obrasSinMedia = obras.map(o => ({ ...o, fotos: [], archivos: [] }));
        storage.set(SP+'obras', JSON.stringify(obrasSinMedia)).catch(() => { });
        try { localStorage.setItem(SP+'obras', JSON.stringify(obrasSinMedia)); } catch { }
    }, [obras, loaded]);
    useEffect(() => { if (loaded && personal.length) { markLocalEdit('personal'); storage.set(SP+'personal', JSON.stringify(personal)).catch(() => { }); try { localStorage.setItem(SP+'personal', JSON.stringify(personal)); } catch { } } }, [personal, loaded]);
    useEffect(() => { if (loaded) { markLocalEdit('cfg'); const payload = JSON.stringify({ ...cfg, _ts: Date.now() }); storage.set(SP+'cfg', payload).catch(() => { }); try { localStorage.setItem(SP+'cfg', payload); } catch { } } }, [cfg, loaded]);
    useEffect(() => { if (loaded && planes.length) { const json = JSON.stringify(planes); storage.set(SP+'planes_semanales', json).catch(() => { }); try { localStorage.setItem(SP+'planes_semanales', json); } catch { } } }, [planes, loaded]);
    useEffect(() => {
        if (!loaded) return;
        // Solo guardar si la API key tiene contenido — no sobrescribir con vacío
        if (apiKey && apiKey.trim()) {
            storage.set(SP+'api_key', apiKey).catch(() => { });
            try { localStorage.setItem(SP+'api_key', apiKey); } catch { }
        }
    }, [apiKey, loaded]);
    useEffect(() => { if (loaded && user) { storage.set(SP+'current_user', JSON.stringify(user)).catch(() => { }); try { localStorage.setItem(SP+'current_user', JSON.stringify(user)); } catch { } } }, [user, loaded]);

    // ── GUARDAR EN TABLAS REALES DE SUPABASE ────────────────────────
    const sbRef = useRef(null);
    useEffect(() => {
        (async () => {
            try {
                const { createClient: mkSB } = await import('@supabase/supabase-js');
                sbRef.current = mkSB(SUPA_URL, SUPA_KEY);
            } catch {}
        })();
    }, []);

    // Guardar obras en tabla obras
    useEffect(() => {
        if (!loaded || !sbRef.current || !obras.length) return;
        const EID = '00000000-0000-0000-0000-000000000001';
        obras.forEach(async o => {
            try {
                await sbRef.current.from('obras').upsert({
                    id: o.id, empresa_id: EID,
                    nombre: o.nombre, estado: o.estado || 'curso',
                    avance: o.avance || 0, fecha_cierre: o.cierre || null,
                    ubicacion: o.ap || '', monto: o.monto || '',
                    pagado: o.pagado || '', notas: o.notas || '',
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'id' });
            } catch {}
        });
    }, [obras, loaded]);

    // Guardar personal en tabla personal
    useEffect(() => {
        if (!loaded || !sbRef.current || !personal.length) return;
        const EID = '00000000-0000-0000-0000-000000000001';
        personal.forEach(async p => {
            try {
                await sbRef.current.from('personal').upsert({
                    id: p.id, empresa_id: EID,
                    nombre: p.nombre, rol: p.rol || '',
                    telefono: p.telefono || '', dni: p.dni || '',
                    activo: true,
                }, { onConflict: 'id' });
            } catch {}
        });
    }, [personal, loaded]);

    // Guardar licitaciones en tabla licitaciones
    useEffect(() => {
        if (!loaded || !sbRef.current || !lics.length) return;
        const EID = '00000000-0000-0000-0000-000000000001';
        lics.forEach(async l => {
            try {
                await sbRef.current.from('licitaciones').upsert({
                    id: l.id, empresa_id: EID,
                    nombre: l.nombre, estado: l.estado || 'pendiente',
                    monto: l.monto || '', fecha: l.fecha || null,
                    ubicacion: l.ap || '', notas: l.notas || '',
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'id' });
            } catch {}
        });
    }, [lics, loaded]);

    // Guardar planes en tabla planes_semanales
    useEffect(() => {
        if (!loaded || !sbRef.current || !planes.length) return;
        const EID = '00000000-0000-0000-0000-000000000001';
        planes.forEach(async p => {
            try {
                await sbRef.current.from('planes_semanales').upsert({
                    id: p.id, empresa_id: EID,
                    obra_id: p.obra || null,
                    semana: p.semana || null,
                    dias: p.dias || {},
                    notas: p.notas || '',
                }, { onConflict: 'id' });
            } catch {}
        });
    }, [planes, loaded]);

    // ── SYNC TIEMPO REAL ─────────────────────────────────────────────────
    // Usa Supabase Realtime (postgres_changes) para notificaciones instantáneas.
    // Cuando dispositivo A guarda algo, dispositivo B lo recibe en < 1 segundo.
    // Polling de respaldo cada 10s por si Realtime falla.
    useEffect(() => {
        if (!loaded || !user) return;

        // Keys de medios (fotos/archivos) — hay que buscarlas por prefijo
        const MEDIA_PREFIXES = [SP+'fotos_', SP+'archs_', SP+'lic_vis_'];
        // Timestamp de la última vez que YO guardé algo (para no pisar mi propio cambio)
        const myLastSave = { lics: 0, obras: 0, personal: 0, cfg: 0 };
        const PROTECT_MS = 15000; // 15s protección post-guardado propio

        // Función central: aplicar datos remotos a la UI
        async function applyRemoteKey(key, value) {
            const now = Date.now();
            try {
                if (key === SP+'lics' && now - myLastSave.lics > PROTECT_MS) {
                    // Verificar que el local no fue actualizado recientemente
                    const localStr = storage.getLocal(SP+'lics')?.value;
                    if (localStr === value) return; // ya está actualizado
                    const licsRemota = JSON.parse(value);
                    setLics(cur => {
                        // Fusionar por ID: mantener visitas locales y agregar lics nuevas del remoto
                        const merged = licsRemota.map(l => {
                            const local = cur.find(x => x.id === l.id);
                            return { ...l, visitas: local?.visitas?.length ? local.visitas : l.visitas || [] };
                        });
                        // Agregar lics locales que no están en remoto (recién creadas)
                        const idsRemoto = new Set(licsRemota.map(l => l.id));
                        const soloLocales = cur.filter(l => !idsRemoto.has(l.id));
                        return [...merged, ...soloLocales];
                    });
                    try { localStorage.setItem(key, value); } catch {}
                }
                else if (key === SP+'obras' && now - myLastSave.obras > PROTECT_MS) {
                    const obrasRemota = JSON.parse(value);
                    setObras(cur => {
                        const merged = obrasRemota.map(o => {
                            const local = cur.find(x => x.id === o.id);
                            if (!local) return { ...o, fotos: [], archivos: [] };
                            // Fusionar arrays por ID — nunca perder datos de ningún usuario
                            const mergeById = (a, b) => {
                                const ids = new Set((a||[]).map(x => x.id));
                                return [...(a||[]), ...(b||[]).filter(x => !ids.has(x.id))];
                            };
                            return {
                                ...o,
                                // fotos y archivos se sincronizan por keys separadas
                                fotos: local.fotos || [],
                                archivos: local.archivos || [],
                                // obs, informes, gastos: fusionar por ID
                                obs: mergeById(local.obs, o.obs),
                                informes: mergeById(local.informes, o.informes),
                                gastos: mergeById(local.gastos, o.gastos),
                                // datos básicos: usar el más reciente (el que viene del server)
                                avance: o.avance,
                                estado: o.estado,
                                nombre: o.nombre,
                                sector: o.sector,
                                cierre: o.cierre,
                                inicio: o.inicio,
                                monto: o.monto,
                            };
                        });
                        // Agregar obras locales que no están en remoto (recién creadas)
                        const idsRemoto = new Set(obrasRemota.map(o => o.id));
                        const soloLocales = cur.filter(o => !idsRemoto.has(o.id));
                        return [...merged, ...soloLocales];
                    });
                    try { localStorage.setItem(key, value); } catch {}
                }
                else if (key === SP+'personal' && now - myLastSave.personal > PROTECT_MS) {
                    const remoto = JSON.parse(value);
                    setPersonal(cur => {
                        // Fusionar: actualizar existentes + agregar nuevos
                        const idsRemoto = new Set(remoto.map(p => p.id));
                        const soloLocales = cur.filter(p => !idsRemoto.has(p.id));
                        return [...remoto, ...soloLocales];
                    });
                    try { localStorage.setItem(key, value); } catch {}
                }
                else if (key === SP+'cfg') {
                    // Config siempre se sincroniza — sin protección
                    const nv = JSON.parse(value); setCfg({ ...DEFAULT_CONFIG, ...nv });
                    try { localStorage.setItem(key, value); } catch {}
                }
                // Fotos de obras — FUSIONAR por ID y resolver base64 de Supabase
                else if (key.startsWith(SP+'fotos_')) {
                    const obraId = key.replace(SP+'fotos_', '');
                    const fotosRemoto = JSON.parse(value);
                    // Resolver fotos que necesitan cargar base64 desde Supabase
                    Promise.all(fotosRemoto.map(async f => {
                        if (f.url && (f.url.startsWith('data:') || mediaStorage.isRemoteUrl(f.url))) return f;
                        // URL vacía o inválida — intentar cargar desde fotodata_xxx
                        try {
                            const local = localStorage.getItem(`fotodata_${f.id}`);
                            if (local) return { ...f, url: local };
                            const r = await storage.get(`fotodata_${f.id}`);
                            if (r?.value) {
                                try { localStorage.setItem(`fotodata_${f.id}`, r.value); } catch {}
                                return { ...f, url: r.value };
                            }
                        } catch {}
                        return f;
                    })).then(fotosResueltas => {
                        setObras(cur => cur.map(o => {
                            if (o.id !== obraId) return o;
                            const fotosLocal = o.fotos || [];
                            const idsLocales = new Set(fotosLocal.map(f => f.id));
                            const nuevas = fotosResueltas.filter(f => !idsLocales.has(f.id));
                            if (!nuevas.length) return o;
                            const fusionadas = [...fotosLocal, ...nuevas];
                            try { localStorage.setItem(key, JSON.stringify(fusionadas)); } catch {}
                            return { ...o, fotos: fusionadas };
                        }));
                    });
                }
                // Archivos de obras — FUSIONAR por ID
                else if (key.startsWith(SP+'archs_')) {
                    const obraId = key.replace(SP+'archs_', '');
                    const archivosRemoto = JSON.parse(value);
                    setObras(cur => cur.map(o => {
                        if (o.id !== obraId) return o;
                        const archLocal = o.archivos || [];
                        const idsLocales = new Set(archLocal.map(f => f.id));
                        const nuevos = archivosRemoto.filter(f => !idsLocales.has(f.id));
                        const fusionados = [...archLocal, ...nuevos];
                        try { localStorage.setItem(key, JSON.stringify(fusionados)); } catch {}
                        return { ...o, archivos: fusionados };
                    }));
                }
                // Visitas de licitaciones — FUSIONAR por ID
                else if (key.startsWith(SP+'lic_vis_')) {
                    const licId = key.replace(SP+'lic_vis_', '');
                    const visitasRemoto = JSON.parse(value);
                    setLics(cur => cur.map(l => {
                        if (l.id !== licId) return l;
                        const visitasLocal = l.visitas || [];
                        const idsLocales = new Set(visitasLocal.map(v => v.id));
                        const nuevas = visitasRemoto.filter(v => !idsLocales.has(v.id));
                        const fusionadas = [...visitasLocal, ...nuevas];
                        try { localStorage.setItem(key, JSON.stringify(fusionadas)); } catch {}
                        return { ...l, visitas: fusionadas };
                    }));
                }
                else if (key === SP+'planes_semanales') {
                    const nv = JSON.parse(value);
                    setPlanes(nv);
                    try { localStorage.setItem(key, value); } catch {}
                }
            } catch { }
        }

        // Función de sync completo — polling cada 5s
        async function syncAll() {
            try {
                const [rLics, rObras, rPers, rCfg] = await Promise.all([
                    storage.get(SP+'lics'),
                    storage.get(SP+'obras'),
                    storage.get(SP+'personal'),
                    storage.get(SP+'cfg'),
                ]);
                if (rLics?.value) { const loc = storage.getLocal(SP+'lics'); if (loc?.value !== rLics.value) await applyRemoteKey(SP+'lics', rLics.value); }
                if (rObras?.value) { const loc = storage.getLocal(SP+'obras'); if (loc?.value !== rObras.value) await applyRemoteKey(SP+'obras', rObras.value); }
                if (rPers?.value) { const loc = storage.getLocal(SP+'personal'); if (loc?.value !== rPers.value) await applyRemoteKey(SP+'personal', rPers.value); }
                if (rCfg?.value) { const loc = storage.getLocal(SP+'cfg'); if (loc?.value !== rCfg.value) await applyRemoteKey(SP+'cfg', rCfg.value); }

                // Sync fotos de obras — verificar cada obra activa
                const obrasActuales = JSON.parse(storage.getLocal(SP+'obras')?.value || '[]');
                for (const o of obrasActuales.slice(0, 10)) {
                    try {
                        const rFotos = await storage.get(SP+'fotos_'+o.id);
                        if (rFotos?.value) {
                            const loc = storage.getLocal(SP+'fotos_'+o.id);
                            if (loc?.value !== rFotos.value) {
                                await applyRemoteKey(SP+'fotos_'+o.id, rFotos.value);
                            }
                        }
                    } catch { }
                }
            } catch { }
        }

        // Supabase Realtime — escucha cambios en bcm_storage en tiempo real
        let realtimeChannel = null;
        let wsCleanup = null;

        function connectRealtime() {
            try {
                // Supabase Realtime via WebSocket
                const wsUrl = SUPA_URL.replace('https://', 'wss://') + '/realtime/v1/websocket?apikey=' + SUPA_KEY + '&vsn=1.0.0';
                const ws = new WebSocket(wsUrl);
                let heartbeat = null;

                ws.onopen = () => {
                    setRealtimeOk(true);
                    // Suscribirse a cambios en la tabla bcm_storage
                    ws.send(JSON.stringify({
                        topic: 'realtime:public:bcm_storage',
                        event: 'phx_join',
                        payload: { config: { postgres_changes: [{ event: '*', schema: 'public', table: 'bcm_storage' }] } },
                        ref: '1'
                    }));
                    // Heartbeat cada 25s para mantener la conexión
                    heartbeat = setInterval(() => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: 'hb' }));
                        }
                    }, 25000);
                };

                ws.onmessage = (evt) => {
                    try {
                        const msg = JSON.parse(evt.data);
                        // Cambio en bcm_storage
                        if (msg.event === 'postgres_changes' && msg.payload?.data) {
                            const { record, old_record, type } = msg.payload.data;
                            const changedKey = record?.key || old_record?.key;
                            const changedValue = record?.value;
                            if (changedKey && changedValue && type !== 'DELETE') {
                                applyRemoteKey(changedKey, changedValue);
                            }
                        }
                    } catch { }
                };

                ws.onclose = () => {
                    setRealtimeOk(false);
                    clearInterval(heartbeat);
                    // Reconectar en 3s si la conexión se cayó
                    setTimeout(() => { if (!wsCleanup?.closed) connectRealtime(); }, 3000);
                };

                ws.onerror = () => { ws.close(); };

                wsCleanup = { ws, closed: false, close: () => { wsCleanup.closed = true; clearInterval(heartbeat); ws.close(); } };
            } catch {
                // Si WebSocket falla, solo usar polling
            }
        }

        // SYNC ACTIVADO — polling cada 5s + Realtime WebSocket
        connectRealtime();
        syncAll();
        const iv = setInterval(syncAll, 5000);
        const onFocus = () => syncAll();
        window.addEventListener('focus', onFocus);
        window.addEventListener('online', () => { syncAll(); connectRealtime(); });

        // Interceptar el storage.set original para marcar mis propios cambios
        const origSet = storage.set.bind(storage);
        storage.set = async (key, value) => {
            if (key === SP+'lics') myLastSave.lics = Date.now();
            else if (key === SP+'obras') myLastSave.obras = Date.now();
            else if (key === SP+'personal') myLastSave.personal = Date.now();
            else if (key === SP+'cfg') myLastSave.cfg = Date.now();
            return origSet(key, value);
        };

        return () => {
            if (wsCleanup) wsCleanup.close();
            clearInterval(iv);
            window.removeEventListener('focus', onFocus);
            storage.set = origSet; // restaurar
        };
    }, [loaded, user]);

    // Generar alertas automáticas
    useEffect(() => {
        const out = [];
        const hoy = new Date(); hoy.setHours(0,0,0,0);

        // 1. Documentos vencidos o por vencer (con fecha cargada)
        personal.forEach(p => {
            Object.entries(p.docs || {}).forEach(([did, doc]) => {
                if (doc?.vence) {
                    const d = daysSince(doc.vence);
                    const docLabel = DOC_TYPES.find(x => x.id === did)?.label || did;
                    if (d < 0) out.push({ id: 'doc_' + p.id + '_' + did, msg: '\uD83D\uDCC4 ' + p.nombre + ': ' + docLabel + ' vencido hace ' + Math.abs(d) + ' d\u00eda' + (Math.abs(d) !== 1 ? 's' : ''), prioridad: 'alta' });
                    else if (d <= 14) out.push({ id: 'doc_' + p.id + '_' + did, msg: '\uD83D\uDCC4 ' + p.nombre + ': ' + docLabel + ' vence en ' + d + ' d\u00eda' + (d !== 1 ? 's' : ''), prioridad: d <= 3 ? 'alta' : 'media' });
                }
            });
            // 2. Documentos obligatorios sin cargar
            DOC_TYPES.forEach(dt => {
                const doc = p.docs?.[dt.id];
                if (!doc) {
                    out.push({ id: 'docfalta_' + p.id + '_' + dt.id, msg: '\uD83D\uDCCB ' + p.nombre + ': le falta cargar ' + dt.label, prioridad: 'media' });
                }
            });
        });

        // 3. Obras con alto % pagado vs avance
        obras.forEach(o => {
            const lic = lics.find(l => l.id === o.lic_id);
            const presup = parseMontoNum(lic?.monto || o.monto);
            const pagado = parseMontoNum(o.pagado || 0);
            if (presup > 0 && pagado / presup > 0.9 && o.avance < 90) {
                out.push({ id: `pag_${o.id}`, msg: `💰 ${o.nombre}: ${Math.round(pagado / presup * 100)}% pagado pero solo ${o.avance}% de avance`, prioridad: 'alta' });
            }
        });

        // 4. Proyectos en estado "visitar" (pendientes de visita)
        lics.filter(l => l.estado === 'visitar').forEach(l => {
            out.push({ id: `lic_visitar_${l.id}`, msg: `🏗 Proyecto pendiente de visita: "${l.nombre}"`, prioridad: 'media' });
        });

        // 5. Proyectos en estado "presupuesto" con fecha límite pasada o próxima
        lics.filter(l => l.estado === 'presupuesto' && l.fecha).forEach(l => {
            try {
                const partes = l.fecha.split('/');
                if (partes.length === 3) {
                    const año = partes[2].length === 2 ? '20' + partes[2] : partes[2];
                    const fechaLic = new Date(parseInt(año), parseInt(partes[1]) - 1, parseInt(partes[0]));
                    fechaLic.setHours(0,0,0,0);
                    const diffDias = Math.ceil((fechaLic - hoy) / (1000 * 60 * 60 * 24));
                    if (diffDias < 0) {
                        out.push({ id: `lic_atrasada_${l.id}`, msg: `⚠ Presentación atrasada hace ${Math.abs(diffDias)} día${Math.abs(diffDias) !== 1 ? 's' : ''}: "${l.nombre}"`, prioridad: 'alta' });
                    } else if (diffDias <= 5) {
                        out.push({ id: `lic_proxima_${l.id}`, msg: `⏰ Presentación en ${diffDias} día${diffDias !== 1 ? 's' : ''}: "${l.nombre}"`, prioridad: 'alta' });
                    } else if (diffDias <= 14) {
                        out.push({ id: `lic_proxima_${l.id}`, msg: `📅 Presentación en ${diffDias} días: "${l.nombre}"`, prioridad: 'media' });
                    }
                }
            } catch { }
        });

        // 6. Proyectos presentadas sin novedad (más de 30 días)
        lics.filter(l => l.estado === 'presentada' && l.fecha).forEach(l => {
            try {
                const partes = l.fecha.split('/');
                if (partes.length === 3) {
                    const año = partes[2].length === 2 ? '20' + partes[2] : partes[2];
                    const fechaLic = new Date(parseInt(año), parseInt(partes[1]) - 1, parseInt(partes[0]));
                    const diffDias = Math.ceil((hoy - fechaLic) / (1000 * 60 * 60 * 24));
                    if (diffDias > 30) {
                        out.push({ id: `lic_sin_novedad_${l.id}`, msg: `🔍 Sin novedad hace ${diffDias} días: "${l.nombre}" (presentada)`, prioridad: 'media' });
                    }
                }
            } catch { }
        });

        setAlerts(out);
    }, [personal, obras, lics]);

    function requireAuth(action, context) {
        if (isDirectivo(user)) { action(); return; }
        setAuthRequest({ action, context });
    }

    function handleAuthSuccess(authUser) {
        if (authRequest) { authRequest.action(); setAuthRequest(null); }
    }

    // Gate de login
    if (!loaded) return (<div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F1F5F9" }}>
        <div style={{ width: 40, height: 40, border: "3px solid #E2E8F0", borderTopColor: "#1D4ED8", borderRadius: "50%", animation: "spin .8s linear infinite" }} />
    </div>);

    if (!user) return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0F172A' }}>
            <div style={{ color: '#fff', fontSize: 14 }}>Cargando sesión...</div>
        </div>
    );

    // Si es cliente, mostrar solo su obra
    if (user?.nivel === 'cliente') {
        return (<>
            <style>{css}</style>
            <ClienteView user={user} obras={obras} onLogout={() => { try { localStorage.removeItem('bop_auth_user'); localStorage.removeItem('bop_auth_empresa'); } catch {} window.location.reload(); }} />
        </>);
    }

    const showNav = !['login'].includes(view);
    const isEmpleado = !isDirectivo(user);

    return (<>
        <style>{css}</style>
        <style>{buildThemeCSS(cfg)}</style>
        <div style={{ width: "100%", maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: T.bg, display: "flex", flexDirection: "column", position: "relative", color: T.text, fontFamily: "var(--font), sans-serif" }}>
            <AppBrand cfg={cfg} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", paddingBottom: showNav ? 72 : 0 }}>
                {view === 'dashboard' && <Dashboard lics={lics} obras={obras} personal={personal} alerts={alerts} setView={setView} setDetailObraId={setDetailObraId} requireAuth={requireAuth} cfg={cfg} customIcons={cfg.customIcons || {}} planes={planes} setPlanes={setPlanes} />}
                {view === 'obras' && <Obras obras={obras} setObras={setObras} lics={lics} detailId={detailObraId} setDetailId={setDetailObraId} requireAuth={requireAuth} cfg={cfg} apiKey={apiKey} />}
                {view === 'licitaciones' && <Licitaciones lics={lics} setLics={setLics} requireAuth={requireAuth} cfg={cfg} obras={obras} setObras={setObras}  />}
                {view === 'personal' && <Personal personal={personal} setPersonal={setPersonal} obras={obras} cfg={cfg} />}
                {view === 'cargar' && <CargarView obras={obras} setObras={setObras} cargarState={cargarState} setCargarState={setCargarState} apiKey={apiKey} />}
                {view === 'chat' && <Chat lics={lics} setLics={setLics} obras={obras} setObras={setObras} personal={personal} setPersonal={setPersonal} planes={planes} setPlanes={setPlanes} alerts={alerts} cfg={cfg} apiKey={apiKey} setView={setView} SP={SP} />}
                {view === 'mas' && <Mas setView={setView} setUser={setUser} user={user} cfg={cfg} setCfg={setCfg} apiKey={apiKey} setApiKey={setApiKey} obras={obras} setObras={setObras} lics={lics} setLics={setLics} empresa={empresa} onCambiarEmpresa={onCambiarEmpresa} personal={personal} setPersonal={setPersonal} />}
                {view === 'presupuesto_materiales' && <PresupuestoView tipo="materiales" setView={setView} />}
                {view === 'presupuesto_subcontratos' && <PresupuestoView tipo="subcontratos" setView={setView} />}
                {view === 'seguimiento' && <Seguimiento alerts={alerts} setAlerts={setAlerts} setView={setView} />}
                {view === 'archivos' && <Archivos setView={setView} />}
                {view === 'vigilancia' && <PanelVigilancia setView={setView} />}
                {view === 'presentismo' && <Presentismo personal={personal} setPersonal={setPersonal} obras={obras} setObras={setObras} currentUser={user} setView={setView} />}
                {view === 'resumen' && <ResumenView lics={lics} obras={obras} personal={personal} alerts={alerts} setView={setView} />}
                {view === 'cotizacion' && <CotizacionView setView={setView} apiKey={apiKey} cfg={cfg} />}
                {view === 'materiales_zona' && <MaterialesZonaView setView={setView} apiKey={apiKey} />}
                {view === 'mensajes' && <MensajesView setView={setView} currentUser={user} personal={personal} obras={obras} />}
                {view === 'contactos' && <ContactosView setView={setView} />}
                {view === 'proveedores' && <ProveedoresView setView={setView} />}
                {view === 'info_externa' && <InfoExternaView setView={setView} cfg={cfg} />}
                {view === 'gantt' && <GanttView obras={obras} setView={setView} cfg={cfg} />}
                {view === 'informes_ia' && <InformesIA obras={obras} setObras={setObras} setView={setView} apiKey={apiKey} />}
                {view === 'alertas_wa' && <AlertasWA cfg={cfg} personal={personal} lics={lics} obras={obras} alerts={alerts} setView={setView} />}
            </div>
            {showNav && <BottomNav view={view} setView={setView} alerts={alerts} cfg={cfg} unreadMsgs={unreadMsgs} />}
            {/* Indicador de conexión en tiempo real — aparece brevemente cuando hay cambios */}
            {showNav && !realtimeOk && loaded && false && (
                <div style={{ position: "fixed", bottom: 56, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 480, zIndex: 99, pointerEvents: "none" }}>
                    <div style={{ display: "flex", justifyContent: "center" }}>
                        <div style={{ background: "rgba(239,68,68,.85)", borderRadius: 20, padding: "3px 12px", display: "flex", alignItems: "center", gap: 5 }}>
                            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff", animation: "pulse 1s infinite" }} />
                            <span style={{ fontSize: 9, fontWeight: 700, color: "#fff", letterSpacing: "0.04em" }}>
                                SIN SYNC EN TIEMPO REAL — datos locales guardados
                            </span>
                        </div>
                    </div>
                </div>
            )}
            {authRequest && <LoginModal titulo={authRequest.context || "Acceso requerido"} onSuccess={handleAuthSuccess} onClose={() => setAuthRequest(null)} />}
        </div>
    </>);
}

// Wrapper con ErrorBoundary para evitar pantallas blancas
function AppInterna({ supaSession, empresa, onCambiarEmpresa }) {
    return <ErrorBoundary><AppInner supaSession={supaSession} empresa={empresa} onCambiarEmpresa={onCambiarEmpresa} /></ErrorBoundary>;
}


// ── LOGIN ─────────────────────────────────────────────────────────
// ── GESTIÓN DE USUARIOS (solo super admin) ───────────────────────────
// ── VISTA CLIENTE ─────────────────────────────────────────────────────
// Usuario con nivel 'cliente' solo ve su obra: fotos e informes
function ClienteView({ user, obras, onLogout }) {
    const obraCliente = obras.find(o => o.id === user.obra_id) || obras[0];
    const [tabC, setTabC] = useState('fotos');

    const SUBCONTRATOS_DEFAULT = ['Interiorismo','Carpintería','Paisajismo','Electricidad','Plomería','Pintura','Vidriería','Herrería'];

    if (!obraCliente) return (
        <div style={{ minHeight: '100vh', background: '#0F172A', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16, padding: 24 }}>
            <svg width="52" height="52" viewBox="0 0 278 212" fill="none" stroke="#fff" strokeWidth="5.5" strokeLinejoin="miter">
                <polygon points="8,84 98,84 126,54 36,54" /><path d="M8,84 L8,200 L98,200 L98,174 L52,174 L52,132 L98,132 L98,117 L57,117 L57,88 L98,88 L98,84 Z" />
                <polygon points="100,54 100,200 190,200 190,54" /><rect x="112" y="66" width="66" height="42" />
                <polygon points="192,76 192,200 270,200 270,130 246,96 246,76" /><rect x="204" y="136" width="42" height="42" />
            </svg>
            <div style={{ color: '#fff', fontSize: 16, fontWeight: 700, textAlign: 'center' }}>No hay proyectos asignados aún</div>
            <div style={{ color: '#94A3B8', fontSize: 13, textAlign: 'center' }}>El equipo de Belfast te asignará tu proyecto pronto</div>
            <button onClick={onLogout} style={{ marginTop: 16, background: 'transparent', border: '1px solid #475569', borderRadius: 10, padding: '10px 20px', color: '#94A3B8', fontSize: 13, cursor: 'pointer' }}>Cerrar sesión</button>
        </div>
    );

    const fotos = (obraCliente.fotos || []).slice().reverse().slice(0, 20);
    const informes = obraCliente.informes || [];
    const faltantesDoc = obraCliente.faltantes_doc || [];
    const faltantesDef = obraCliente.faltantes_def || [];
    const subcontratos = obraCliente.subcontratos || [];

    const TABS = [
        { id: 'fotos', label: '📸 Fotos' },
        { id: 'informes', label: '📋 Informes' },
        { id: 'doc', label: '📄 Documentación' },
        { id: 'def', label: '❓ Definiciones' },
        { id: 'subs', label: '🔨 Subcontratos' },
    ];

    return (
        <div style={{ maxWidth: 480, margin: '0 auto', minHeight: '100vh', background: T.bg, fontFamily: 'system-ui, sans-serif' }}>
            {/* Header */}
            <div style={{ background: T.navy, padding: '20px 20px 16px', color: '#fff' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                    <svg width="30" height="30" viewBox="0 0 278 212" fill="none" stroke="#fff" strokeWidth="6" strokeLinejoin="miter">
                        <polygon points="8,84 98,84 126,54 36,54" /><path d="M8,84 L8,200 L98,200 L98,174 L52,174 L52,132 L98,132 L98,117 L57,117 L57,88 L98,88 L98,84 Z" />
                        <polygon points="100,54 100,200 190,200 190,54" /><rect x="112" y="66" width="66" height="42" />
                        <polygon points="192,76 192,200 270,200 270,130 246,96 246,76" /><rect x="204" y="136" width="42" height="42" />
                    </svg>
                    <div>
                        <div style={{ fontSize: 14, fontWeight: 800 }}>BelfastCM</div>
                        <div style={{ fontSize: 10, color: '#94A3B8' }}>Portal de Clientes</div>
                    </div>
                </div>
                <div style={{ fontSize: 10, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Tu proyecto</div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>{obraCliente.nombre}</div>
                {(obraCliente.sector || obraCliente.direccion) && <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 2 }}>{obraCliente.sector || obraCliente.direccion}</div>}
                <div style={{ marginTop: 12, background: '#1E293B', borderRadius: 8, height: 8 }}>
                    <div style={{ height: 8, borderRadius: 8, background: '#34D399', width: `${obraCliente.avance || 0}%`, transition: 'width .5s' }} />
                </div>
                <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 5 }}>Avance: {obraCliente.avance || 0}%</div>
            </div>

            {/* Tabs scroll horizontal */}
            <div style={{ display: 'flex', background: T.card, borderBottom: `1px solid ${T.border}`, overflowX: 'auto' }}>
                {TABS.map(t => (
                    <button key={t.id} onClick={() => setTabC(t.id)} style={{ flexShrink: 0, padding: '12px 14px', border: 'none', background: 'none', fontSize: 12, fontWeight: tabC === t.id ? 700 : 500, color: tabC === t.id ? T.accent : T.muted, borderBottom: `2px solid ${tabC === t.id ? T.accent : 'transparent'}`, cursor: 'pointer', whiteSpace: 'nowrap' }}>{t.label}</button>
                ))}
            </div>

            <div style={{ padding: 16, paddingBottom: 40 }}>

                {/* FOTOS */}
                {tabC === 'fotos' && (<>
                    {fotos.length === 0 && <div style={{ textAlign: 'center', padding: '50px 0', color: T.muted, fontSize: 14 }}>📸 Las fotos de tu proyecto aparecerán acá</div>}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        {fotos.map(f => (
                            <div key={f.id} style={{ borderRadius: 12, overflow: 'hidden', aspectRatio: '1', background: T.border }}>
                                <img src={f.url} alt={f.nombre} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => e.target.style.display='none'} />
                            </div>
                        ))}
                    </div>
                    {fotos.length > 0 && <div style={{ fontSize: 11, color: T.muted, textAlign: 'center', marginTop: 10 }}>{fotos.length} foto{fotos.length !== 1 ? 's' : ''} más recientes</div>}
                </>)}

                {/* INFORMES */}
                {tabC === 'informes' && (<>
                    {informes.length === 0 && <div style={{ textAlign: 'center', padding: '50px 0', color: T.muted, fontSize: 14 }}>📋 Los informes de avance aparecerán acá</div>}
                    {informes.slice().reverse().map(inf => (
                        <div key={inf.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: '14px 16px', marginBottom: 10 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 4 }}>{inf.titulo || 'Informe'}</div>
                            <div style={{ fontSize: 12, color: T.sub, lineHeight: 1.6 }}>{inf.texto}</div>
                            <div style={{ fontSize: 10, color: T.muted, marginTop: 8 }}>{inf.fecha}</div>
                        </div>
                    ))}
                </>)}

                {/* FALTANTES DOC */}
                {tabC === 'doc' && (<>
                    <div style={{ fontSize: 12, color: T.muted, marginBottom: 12 }}>Documentos pendientes de entrega</div>
                    {faltantesDoc.length === 0 && <div style={{ textAlign: 'center', padding: '50px 0', color: '#10B981', fontSize: 14, fontWeight: 700 }}>✅ Sin faltantes de documentación</div>}
                    {faltantesDoc.map((f, i) => (
                        <div key={i} style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '12px 14px', marginBottom: 8, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                            <div style={{ fontSize: 16, flexShrink: 0 }}>📄</div>
                            <div>
                                <div style={{ fontSize: 13, fontWeight: 700, color: '#B91C1C' }}>{f.titulo}</div>
                                {f.nota && <div style={{ fontSize: 11, color: '#7F1D1D', marginTop: 3 }}>{f.nota}</div>}
                            </div>
                        </div>
                    ))}
                </>)}

                {/* FALTANTES DEF */}
                {tabC === 'def' && (<>
                    <div style={{ fontSize: 12, color: T.muted, marginBottom: 12 }}>Definiciones pendientes del cliente</div>
                    {faltantesDef.length === 0 && <div style={{ textAlign: 'center', padding: '50px 0', color: '#10B981', fontSize: 14, fontWeight: 700 }}>✅ Sin definiciones pendientes</div>}
                    {faltantesDef.map((f, i) => (
                        <div key={i} style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 10, padding: '12px 14px', marginBottom: 8, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                            <div style={{ fontSize: 16, flexShrink: 0 }}>❓</div>
                            <div>
                                <div style={{ fontSize: 13, fontWeight: 700, color: '#92400E' }}>{f.titulo}</div>
                                {f.nota && <div style={{ fontSize: 11, color: '#78350F', marginTop: 3 }}>{f.nota}</div>}
                            </div>
                        </div>
                    ))}
                </>)}

                {/* SUBCONTRATOS */}
                {tabC === 'subs' && (<>
                    <div style={{ fontSize: 12, color: T.muted, marginBottom: 12 }}>Especialidades asignadas al proyecto</div>
                    {subcontratos.length === 0 && <div style={{ textAlign: 'center', padding: '50px 0', color: T.muted, fontSize: 14 }}>🔨 Los subcontratos asignados aparecerán acá</div>}
                    {subcontratos.map((s, i) => (
                        <div key={i} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: '14px 16px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{ width: 40, height: 40, borderRadius: 10, background: T.accentLight, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>🔨</div>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{s.nombre}</div>
                                {s.empresa && <div style={{ fontSize: 11, color: T.muted }}>{s.empresa}</div>}
                                {s.estado && <div style={{ fontSize: 10, background: s.estado === 'activo' ? '#ECFDF5' : '#F1F5F9', color: s.estado === 'activo' ? '#10B981' : T.muted, borderRadius: 20, padding: '2px 8px', display: 'inline-block', marginTop: 4, fontWeight: 700 }}>{s.estado}</div>}
                            </div>
                        </div>
                    ))}
                </>)}

            </div>

            <div style={{ padding: '0 16px 24px', textAlign: 'center' }}>
                <button onClick={onLogout} style={{ background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 20px', color: T.muted, fontSize: 13, cursor: 'pointer' }}>Cerrar sesión</button>
            </div>
        </div>
    );
}

function GestionUsuarios({ obras = [] }) {
    const [usuarios, setUsuarios] = React.useState([]);
    const [cargando, setCargando] = React.useState(true);

    React.useEffect(() => {
        cargarUsuarios().then(u => { setUsuarios(u); setCargando(false); });
    }, []);

    async function cambiarEmpresa(id, empresa) {
        const nuevos = usuarios.map(u => u.id === id ? { ...u, empresa } : u);
        setUsuarios(nuevos);
        await guardarUsuarios(nuevos);
    }

    async function cambiarNivel(id, nivel) {
        const nuevos = usuarios.map(u => u.id === id ? { ...u, nivel } : u);
        setUsuarios(nuevos);
        await guardarUsuarios(nuevos);
    }

    async function eliminarUsuario(id, nombre) {
        if (!window.confirm(`¿Eliminar a ${nombre}?`)) return;
        const nuevos = usuarios.filter(u => u.id !== id);
        setUsuarios(nuevos);
        await guardarUsuarios(nuevos);
    }

    async function resetPass(id, nombre) {
        const nueva = window.prompt(`Nueva contraseña para ${nombre}:`);
        if (!nueva || nueva.length < 6) { alert('Mínimo 6 caracteres'); return; }
        const nuevos = usuarios.map(u => u.id === id ? { ...u, passHash: hashPass(nueva) } : u);
        setUsuarios(nuevos);
        await guardarUsuarios(nuevos);
        alert('Contraseña actualizada ✓');
    }

    if (cargando) return <div style={{ textAlign: 'center', padding: '20px', color: T.muted }}>Cargando...</div>;

    return (<div>
        <div style={{ background: T.accentLight, border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 12, color: T.accent }}>
            <b>{usuarios.length}/{MAX_USUARIOS}</b> usuarios registrados
        </div>
        {usuarios.length === 0 && <div style={{ textAlign: 'center', padding: '20px', color: T.muted, fontSize: 13 }}>Sin usuarios registrados aún</div>}
        {usuarios.map(u => (
            <div key={u.id} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: T.rsm, padding: '12px 14px', marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{u.nombre}</div>
                        <div style={{ fontSize: 11, color: T.muted }}>@{u.usuario} · Registrado: {u.creado}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 5 }}>
                        <button onClick={() => resetPass(u.id, u.nombre)} style={{ background: T.accentLight, border: `1px solid ${T.border}`, borderRadius: 7, padding: '5px 8px', fontSize: 10, fontWeight: 700, color: T.accent, cursor: 'pointer' }}>🔑</button>
                        <button onClick={() => eliminarUsuario(u.id, u.nombre)} style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 7, padding: '5px 8px', fontSize: 10, fontWeight: 700, color: '#EF4444', cursor: 'pointer' }}>✕</button>
                    </div>
                </div>
                <div style={{ marginTop: 8 }}>
                    <Lbl>Nivel</Lbl>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 5 }}>
                        {[['empleado', '👷 Empleado'], ['directivo', '👔 Directivo'], ['cliente', '👤 Cliente']].map(([val, lbl]) => (
                            <button key={val} onClick={() => cambiarNivel(u.id, val)}
                                style={{ padding: '7px 4px', borderRadius: 8, border: `1.5px solid ${(u.nivel||'empleado') === val ? T.accent : T.border}`, background: (u.nivel||'empleado') === val ? T.accentLight : T.card, color: (u.nivel||'empleado') === val ? T.accent : T.sub, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                                {lbl}
                            </button>
                        ))}
                    </div>
                </div>
                <div style={{ marginTop: 8 }}>
                    <Lbl>Empresa / acceso</Lbl>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 5 }}>
                        {[['belfast', '🔵 Belfast'], ['vv', '🟢 V+V'], ['ambas', '⚡ Ambas']].map(([val, lbl]) => (
                            <button key={val} onClick={() => cambiarEmpresa(u.id, val)}
                                style={{ padding: '7px 4px', borderRadius: 8, border: `1.5px solid ${u.empresa === val ? T.accent : T.border}`, background: u.empresa === val ? T.accentLight : T.card, color: u.empresa === val ? T.accent : T.sub, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                                {lbl}
                            </button>
                        ))}
                    </div>
                    {/* Selector de obra para clientes */}
                    {u.nivel === 'cliente' && obras.length > 0 && (
                        <div style={{ marginTop: 8 }}>
                            <Lbl>Obra asignada</Lbl>
                            <select value={u.obra_id || ''} onChange={async e => {
                                const nuevos = usuarios.map(x => x.id === u.id ? { ...x, obra_id: e.target.value } : x);
                                setUsuarios(nuevos);
                                await guardarUsuarios(nuevos);
                            }} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${T.border}`, fontSize: 13, color: T.text, background: T.bg }}>
                                <option value="">— Sin asignar —</option>
                                {obras.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
                            </select>
                        </div>
                    )}
                </div>
            </div>
        ))}
    </div>);
}

// ── LOGIN CON SISTEMA PROPIO ─────────────────────────────────────────
// Máximo 8 usuarios. Se guardan en Supabase tabla bcm_storage key 'bop_usuarios'
// Cada usuario: { id, usuario, passHash, nombre, empresa ('belfast'|'vv'|'ambas'), creado }
// El super admin puede ver y gestionar todos los usuarios

const SUPER_ADMIN = { usuario: 'sebastian', pass: 'Valentina22', empresa: 'belfast', nombre: 'Sebastián', nivel: 'superadmin' };
const MAX_USUARIOS = 8;

// Hash simple (no criptográfico pero suficiente para uso interno)
function hashPass(pass) {
    let h = 0;
    for (let i = 0; i < pass.length; i++) { h = Math.imul(31, h) + pass.charCodeAt(i) | 0; }
    return 'h' + Math.abs(h).toString(36);
}

async function cargarUsuarios() {
    try {
        const r = await storage.get('bop_usuarios');
        if (r?.value) return JSON.parse(r.value);
    } catch {}
    return [];
}

async function guardarUsuarios(usuarios) {
    const json = JSON.stringify(usuarios);
    try { localStorage.setItem('bop_usuarios', json); } catch {}
    await storage.set('bop_usuarios', json).catch(() => {});
}

function LoginScreen({ onLogin }) {
    const T2 = { navy: '#0F172A', accent: '#1D4ED8', bg: '#F8FAFC', text: '#1E293B', muted: '#94A3B8', border: '#E2E8F0', card: '#fff' };
    const [modo, setModo] = React.useState('login'); // 'login' | 'registro'
    const [usuario, setUsuario] = React.useState('');
    const [pass, setPass] = React.useState('');
    const [passConfirm, setPassConfirm] = React.useState('');
    const [nombre, setNombre] = React.useState('');
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState('');
    const [showPass, setShowPass] = React.useState(false);

    async function login() {
        if (!usuario.trim() || !pass.trim()) { setError('Completá usuario y contraseña'); return; }
        setLoading(true); setError('');
        // Verificar super admin
        if (usuario.trim().toLowerCase() === SUPER_ADMIN.usuario && pass === SUPER_ADMIN.pass) {
            onLogin({ id: 'superadmin', usuario: SUPER_ADMIN.usuario, nombre: SUPER_ADMIN.nombre, empresa: SUPER_ADMIN.empresa, nivel: 'superadmin' });
            return;
        }
        // Verificar usuarios registrados
        const usuarios = await cargarUsuarios();
        const u = usuarios.find(x => x.usuario.toLowerCase() === usuario.trim().toLowerCase() && x.passHash === hashPass(pass));
        if (u) { onLogin(u); }
        else { setError('Usuario o contraseña incorrectos'); }
        setLoading(false);
    }

    async function registrar() {
        if (!usuario.trim() || !pass.trim() || !nombre.trim()) { setError('Completá todos los campos'); return; }
        if (pass !== passConfirm) { setError('Las contraseñas no coinciden'); return; }
        if (pass.length < 6) { setError('La contraseña debe tener al menos 6 caracteres'); return; }
        setLoading(true); setError('');
        const usuarios = await cargarUsuarios();
        if (usuarios.length >= MAX_USUARIOS) { setError('Límite de usuarios alcanzado. Contactá al administrador.'); setLoading(false); return; }
        if (usuarios.find(x => x.usuario.toLowerCase() === usuario.trim().toLowerCase())) { setError('Ese usuario ya existe'); setLoading(false); return; }
        // Nuevo usuario — empresa 'belfast' por defecto (el admin puede cambiarla)
        const nuevo = { id: uid(), usuario: usuario.trim().toLowerCase(), passHash: hashPass(pass), nombre: nombre.trim(), empresa: 'belfast', nivel: 'empleado', creado: new Date().toLocaleDateString('es-AR') };
        await guardarUsuarios([...usuarios, nuevo]);
        onLogin(nuevo);
        setLoading(false);
    }

    return (
        <div style={{ minHeight: '100vh', background: T2.navy, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <div style={{ width: '100%', maxWidth: 380, background: T2.card, borderRadius: 20, padding: '36px 28px', boxShadow: '0 30px 60px rgba(0,0,0,.4)' }}>
                <div style={{ textAlign: 'center', marginBottom: 28 }}>
                    <svg width="52" height="52" viewBox="0 0 278 212" fill="none" stroke="#111" strokeWidth="5.5" strokeLinejoin="miter" style={{ marginBottom: 10 }}>
                        <polygon points="8,84 98,84 126,54 36,54" />
                        <path d="M8,84 L8,200 L98,200 L98,174 L52,174 L52,132 L98,132 L98,117 L57,117 L57,88 L98,88 L98,84 Z" />
                        <polygon points="100,54 100,200 190,200 190,54" />
                        <rect x="112" y="66" width="66" height="42" />
                        <polygon points="192,76 192,200 270,200 270,130 246,96 246,76" />
                        <rect x="204" y="136" width="42" height="42" />
                    </svg>
                    <div style={{ fontSize: 20, fontWeight: 800, color: T2.text }}>BelfastCM</div>
                    <div style={{ fontSize: 12, color: T2.muted, marginTop: 3 }}>Construction Management</div>
                </div>

                {/* Tabs login/registro */}
                <div style={{ display: 'flex', background: T2.bg, borderRadius: 10, padding: 3, marginBottom: 20 }}>
                    {[['login','Ingresar'],['registro','Registrarse']].map(([m,l]) => (
                        <button key={m} onClick={() => { setModo(m); setError(''); }} style={{ flex: 1, padding: '8px', borderRadius: 8, border: 'none', background: modo === m ? T2.card : 'transparent', color: modo === m ? T2.accent : T2.muted, fontSize: 13, fontWeight: modo === m ? 700 : 500, cursor: 'pointer', boxShadow: modo === m ? '0 1px 3px rgba(0,0,0,.1)' : 'none' }}>{l}</button>
                    ))}
                </div>

                {/* Campos */}
                {modo === 'registro' && (
                    <div style={{ marginBottom: 14 }}>
                        <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T2.muted, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Nombre completo</label>
                        <input value={nombre} onChange={e => { setNombre(e.target.value); setError(''); }} placeholder="Ej: Juan García" onKeyDown={e => e.key === 'Enter' && registrar()}
                            style={{ width: '100%', padding: '12px 14px', fontSize: 14, border: '1.5px solid ' + T2.border, borderRadius: 10, color: T2.text, background: T2.bg, outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                )}
                <div style={{ marginBottom: 14 }}>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T2.muted, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Usuario</label>
                    <input value={usuario} onChange={e => { setUsuario(e.target.value); setError(''); }} placeholder="tu_usuario" autoCapitalize="none" autoCorrect="off" onKeyDown={e => e.key === 'Enter' && (modo === 'login' ? login() : registrar())}
                        style={{ width: '100%', padding: '12px 14px', fontSize: 14, border: '1.5px solid ' + T2.border, borderRadius: 10, color: T2.text, background: T2.bg, outline: 'none', boxSizing: 'border-box' }} />
                </div>
                <div style={{ marginBottom: modo === 'registro' ? 14 : 22, position: 'relative' }}>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T2.muted, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Contraseña</label>
                    <input type={showPass ? 'text' : 'password'} value={pass} onChange={e => { setPass(e.target.value); setError(''); }} placeholder="••••••••" onKeyDown={e => e.key === 'Enter' && (modo === 'login' ? login() : registrar())}
                        style={{ width: '100%', padding: '12px 44px 12px 14px', fontSize: 14, border: '1.5px solid ' + T2.border, borderRadius: 10, color: T2.text, background: T2.bg, outline: 'none', boxSizing: 'border-box' }} />
                    <button onClick={() => setShowPass(v => !v)} type="button" style={{ position: 'absolute', right: 12, top: 34, background: 'none', border: 'none', cursor: 'pointer', color: T2.muted, padding: 4 }}>
                        {showPass ? '🙈' : '👁'}
                    </button>
                </div>
                {modo === 'registro' && (
                    <div style={{ marginBottom: 22 }}>
                        <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: T2.muted, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Confirmar contraseña</label>
                        <input type={showPass ? 'text' : 'password'} value={passConfirm} onChange={e => { setPassConfirm(e.target.value); setError(''); }} placeholder="••••••••" onKeyDown={e => e.key === 'Enter' && registrar()}
                            style={{ width: '100%', padding: '12px 14px', fontSize: 14, border: `1.5px solid ${passConfirm && pass !== passConfirm ? '#FECACA' : T2.border}`, borderRadius: 10, color: T2.text, background: T2.bg, outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                )}

                {error && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: '#DC2626', marginBottom: 16, textAlign: 'center', fontWeight: 600 }}>{error}</div>}

                <button onClick={modo === 'login' ? login : registrar} disabled={loading}
                    style={{ width: '100%', padding: 14, background: loading ? T2.muted : T2.accent, color: '#fff', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer' }}>
                    {loading ? 'Procesando...' : modo === 'login' ? 'Ingresar' : 'Crear cuenta'}
                </button>

                {modo === 'registro' && (
                    <div style={{ marginTop: 14, background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 10, padding: '10px 14px', fontSize: 12, color: '#92400E', textAlign: 'center', lineHeight: 1.5 }}>
                        ⚠ Al registrarte accedés a <b>BelfastCM</b> por defecto.<br/>
                        El administrador puede cambiar tu empresa y permisos.
                    </div>
                )}
            </div>
        </div>
    );
}

// ── EMPRESAS DISPONIBLES ─────────────────────────────────────────────
const EMPRESAS = [
    {
        id: 'belfast',
        nombre: 'Belfast Obras',
        subtitulo: 'Construction Management · AA2000',
        color: '#1D4ED8',
        bg: '#EFF6FF',
        icon: (
            <svg width="48" height="48" viewBox="0 0 278 212" fill="none" stroke="currentColor" strokeWidth="6" strokeLinejoin="miter">
                <polygon points="8,84 98,84 126,54 36,54" />
                <path d="M8,84 L8,200 L98,200 L98,174 L52,174 L52,132 L98,132 L98,117 L57,117 L57,88 L98,88 L98,84 Z" />
                <polygon points="100,54 100,200 190,200 190,54" />
                <rect x="112" y="66" width="66" height="42" />
                <polygon points="192,76 192,200 270,200 270,130 246,96 246,76" />
                <rect x="204" y="136" width="42" height="42" />
            </svg>
        )
    },
    {
        id: 'vv',
        nombre: 'V+V Construcciones',
        subtitulo: 'Proyectos y obras privadas',
        color: '#16A34A',
        bg: '#DCFCE7',
        icon: (
            <svg width="48" height="48" viewBox="0 0 278 212" fill="none" stroke="currentColor" strokeWidth="6" strokeLinejoin="miter">
                <polygon points="8,84 98,84 126,54 36,54" />
                <path d="M8,84 L8,200 L98,200 L98,174 L52,174 L52,132 L98,132 L98,117 L57,117 L57,88 L98,88 L98,84 Z" />
                <line x1="98" y1="84" x2="126" y2="54" />
                <rect x="120" y="6" width="150" height="194" />
                <rect x="138" y="22" width="114" height="72" />
                <rect x="179" y="128" width="21" height="72" />
            </svg>
        )
    }
];

// ── SELECTOR DE EMPRESA ──────────────────────────────────────────────
function SelectorEmpresa({ session, onSelect, onLogout }) {
    const T2 = { navy: '#0F172A', accent: '#1D4ED8', bg: '#F8FAFC', text: '#1E293B', muted: '#94A3B8', border: '#E2E8F0', card: '#fff' };
    const email = session?.user?.email || '';

    const defaultLogos = { belfast: '', vv: '', belfastNombre: '', vvNombre: '', belfastSub: '', vvSub: '' };
    const [logos, setLogos] = React.useState(() => {
        try {
            const saved = localStorage.getItem('bcm_selector_logos');
            return saved ? JSON.parse(saved) : defaultLogos;
        } catch { return defaultLogos; }
    });
    const [editando, setEditando] = React.useState(false);

    // Cargar logos desde Supabase si localStorage está vacío
    React.useEffect(() => {
        if (logos.belfast || logos.vv || logos.belfastNombre) return; // ya tiene datos
        storage.get('bcm_selector_logos').then(r => {
            if (r?.value) {
                const d = JSON.parse(r.value);
                setLogos(d);
                try { localStorage.setItem('bcm_selector_logos', r.value); } catch {}
            }
        }).catch(() => {});
    }, []);

    function guardarLogos(nuevos) {
        setLogos(nuevos);
        try { localStorage.setItem('bcm_selector_logos', JSON.stringify(nuevos)); } catch {}
        storage.set('bcm_selector_logos', JSON.stringify(nuevos)).catch(() => {});
    }

    async function handleLogoUpload(key, file) {
        const reader = new FileReader();
        reader.onload = e => guardarLogos({ ...logos, [key]: e.target.result });
        reader.readAsDataURL(file);
    }

    const empresasConLogos = EMPRESAS.map(emp => ({
        ...emp,
        logoCustom: emp.id === 'belfast' ? logos.belfast : logos.vv,
        nombre: emp.id === 'belfast' ? (logos.belfastNombre || emp.nombre) : (logos.vvNombre || emp.nombre),
        subtitulo: emp.id === 'belfast' ? (logos.belfastSub || emp.subtitulo) : (logos.vvSub || emp.subtitulo),
    }));

    return (
        <div style={{ minHeight: '100vh', background: T2.navy, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <div style={{ width: '100%', maxWidth: 400 }}>
                {/* Header */}
                <div style={{ textAlign: 'center', marginBottom: 32 }}>
                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,.5)', marginBottom: 6 }}>Bienvenido</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 4 }}>{email}</div>
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,.4)' }}>Seleccioná a qué empresa querés ingresar</div>
                </div>

                {/* Cards de empresa */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
                    {empresasConLogos.map(emp => (
                        <button key={emp.id} onClick={() => onSelect(emp.id)}
                            style={{ background: T2.card, border: `2px solid ${T2.border}`, borderRadius: 18, padding: '20px 24px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 18, textAlign: 'left', transition: 'all .15s', boxShadow: '0 4px 20px rgba(0,0,0,.15)' }}
                            onMouseEnter={e => { e.currentTarget.style.borderColor = emp.color; e.currentTarget.style.transform = 'translateY(-2px)'; }}
                            onMouseLeave={e => { e.currentTarget.style.borderColor = T2.border; e.currentTarget.style.transform = 'none'; }}>
                            <div style={{ width: 64, height: 64, borderRadius: 16, background: emp.bg, color: emp.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                                {emp.logoCustom
                                    ? <img src={emp.logoCustom} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 6 }} />
                                    : emp.icon}
                            </div>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 17, fontWeight: 800, color: T2.text, marginBottom: 3 }}>{emp.nombre}</div>
                                <div style={{ fontSize: 12, color: T2.muted }}>{emp.subtitulo}</div>
                            </div>
                            <div style={{ color: emp.color, fontSize: 22, fontWeight: 300 }}>→</div>
                        </button>
                    ))}
                </div>

                {/* Botones inferiores */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <button onClick={() => setEditando(v => !v)} style={{ background: 'none', border: '1px solid rgba(255,255,255,.2)', borderRadius: 8, color: 'rgba(255,255,255,.5)', fontSize: 11, cursor: 'pointer', padding: '6px 12px' }}>
                        ✏️ Personalizar logos
                    </button>
                    <button onClick={onLogout} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.4)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>
                        Cerrar sesión
                    </button>
                </div>

                {/* Panel de edición de logos */}
                {editando && (
                    <div style={{ background: 'rgba(255,255,255,.05)', borderRadius: 16, padding: '20px', marginTop: 16, border: '1px solid rgba(255,255,255,.1)' }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 16 }}>Personalizar pantalla de empresas</div>
                        {EMPRESAS.map(emp => (
                            <div key={emp.id} style={{ marginBottom: 20 }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,.6)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                                    {emp.nombre}
                                </div>
                                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                                    <div style={{ width: 52, height: 52, borderRadius: 12, background: emp.bg, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                        {(emp.id === 'belfast' ? logos.belfast : logos.vv)
                                            ? <img src={emp.id === 'belfast' ? logos.belfast : logos.vv} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 4 }} />
                                            : <div style={{ color: emp.color }}>{emp.icon}</div>}
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <input
                                            type="file" accept="image/*"
                                            onChange={e => e.target.files[0] && handleLogoUpload(emp.id, e.target.files[0])}
                                            style={{ display: 'none' }}
                                            id={`logo-upload-${emp.id}`}
                                        />
                                        <label htmlFor={`logo-upload-${emp.id}`} style={{ display: 'block', background: 'rgba(255,255,255,.1)', border: '1px solid rgba(255,255,255,.2)', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#fff', cursor: 'pointer', textAlign: 'center', marginBottom: 6 }}>
                                            📷 Subir logo
                                        </label>
                                        {(emp.id === 'belfast' ? logos.belfast : logos.vv) && (
                                            <button onClick={() => guardarLogos({ ...logos, [emp.id]: '' })} style={{ width: '100%', background: 'rgba(239,68,68,.2)', border: '1px solid rgba(239,68,68,.4)', borderRadius: 8, padding: '6px', fontSize: 11, color: '#FCA5A5', cursor: 'pointer' }}>
                                                ✕ Quitar logo
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <input
                                    value={emp.id === 'belfast' ? (logos.belfastNombre || '') : (logos.vvNombre || '')}
                                    onChange={e => guardarLogos({ ...logos, [emp.id === 'belfast' ? 'belfastNombre' : 'vvNombre']: e.target.value })}
                                    placeholder={`Nombre (${emp.nombre})`}
                                    style={{ width: '100%', background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.15)', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: '#fff', marginBottom: 6, boxSizing: 'border-box' }}
                                />
                                <input
                                    value={emp.id === 'belfast' ? (logos.belfastSub || '') : (logos.vvSub || '')}
                                    onChange={e => guardarLogos({ ...logos, [emp.id === 'belfast' ? 'belfastSub' : 'vvSub']: e.target.value })}
                                    placeholder={`Subtítulo (${emp.subtitulo})`}
                                    style={{ width: '100%', background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.15)', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: 'rgba(255,255,255,.7)', boxSizing: 'border-box' }}
                                />
                            </div>
                        ))}
                        <button onClick={() => setEditando(false)} style={{ width: '100%', background: '#1D4ED8', border: 'none', borderRadius: 10, padding: '11px', fontSize: 13, fontWeight: 700, color: '#fff', cursor: 'pointer', marginTop: 4 }}>
                            ✓ Listo
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

// ── WRAPPER PRINCIPAL ─────────────────────────────────────────────
export default function App() {
    const [authUser, setAuthUser] = useState(() => {
        try { const s = localStorage.getItem('bop_auth_user'); return s ? JSON.parse(s) : null; } catch { return null; }
    });
    const [empresa, setEmpresa] = useState(() => {
        try { return localStorage.getItem('bop_auth_empresa') || null; } catch { return null; }
    });
    const [cargando, setCargando] = useState(false);

    function handleLogin(user) {
        // Guardar sesión en localStorage
        try { localStorage.setItem('bop_auth_user', JSON.stringify(user)); } catch {}
        setAuthUser(user);
        // Si tiene acceso a una sola empresa, entrar directo
        if (user.empresa !== 'ambas') {
            try { localStorage.setItem('bop_auth_empresa', user.empresa); } catch {}
            setEmpresa(user.empresa);
        }
    }

    function handleLogout() {
        try { localStorage.removeItem('bop_auth_user'); localStorage.removeItem('bop_auth_empresa'); } catch {}
        setAuthUser(null);
        setEmpresa(null);
    }

    function handleSelectEmpresa(emp) {
        try { localStorage.setItem('bop_auth_empresa', emp); } catch {}
        setEmpresa(emp);
    }

    function handleCambiarEmpresa() {
        if (authUser?.empresa === 'ambas') {
            try { localStorage.removeItem('bop_auth_empresa'); } catch {}
            setEmpresa(null);
        }
    }

    if (!authUser) return <LoginScreen onLogin={handleLogin} />;

    if (!empresa) return (
        <SelectorEmpresa
            session={{ user: { email: authUser.usuario } }}
            onSelect={handleSelectEmpresa}
            onLogout={handleLogout}
        />
    );

    return (
        <AppInterna
            supaSession={{ user: { id: authUser.id, email: authUser.usuario } }}
            empresa={empresa}
            authUser={authUser}
            onCambiarEmpresa={handleCambiarEmpresa}
        />
    );
}

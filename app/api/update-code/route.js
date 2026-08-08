import { NextResponse } from 'next/server';
import { isAuthorized } from '../../../lib/api-auth';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GITHUB_REPO_OWNER || 'sebas622';
const REPO_NAME = process.env.GITHUB_REPO_NAME || 'belfast-final';
const BRANCH = 'main';
const PRODUCTION_URL = process.env.PRODUCTION_URL || 'https://belfast-final.vercel.app';
const PREVIEW_URL_TEMPLATE = process.env.PREVIEW_URL_TEMPLATE || '';

// Solo se permiten escrituras dentro de estos prefijos y con estas extensiones.
const ALLOWED_PREFIXES = ['app/', 'lib/'];
const ALLOWED_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.css'];
const MAX_CONTENT_BYTES = 512 * 1024;

function isValidFilePath(filePath) {
    if (typeof filePath !== 'string' || filePath.length > 255) return false;
    if (!/^[A-Za-z0-9._/-]+$/.test(filePath)) return false;
    if (filePath.startsWith('/') || filePath.includes('..') || filePath.includes('//')) return false;
    if (!ALLOWED_PREFIXES.some(p => filePath.startsWith(p))) return false;
    return ALLOWED_EXTENSIONS.some(e => filePath.endsWith(e));
}

export async function POST(request) {
    // Esta ruta escribe código en el repo y dispara un deploy: requiere token
    // de administrador y estar habilitada explícitamente.
    if (process.env.ENABLE_CODE_UPDATES !== 'true') {
        return NextResponse.json({ error: 'Función deshabilitada' }, { status: 403 });
    }
    if (!isAuthorized(request)) {
        return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }
    if (!GITHUB_TOKEN) {
        return NextResponse.json({ error: 'Falta configuración del servidor' }, { status: 500 });
    }

    try {
        const { filePath, content, message, preview } = await request.json();

        if (!filePath || typeof content !== 'string' || !content) {
            return NextResponse.json({ error: 'filePath y content son requeridos' }, { status: 400 });
        }
        if (!isValidFilePath(filePath)) {
            return NextResponse.json({ error: 'filePath no permitido' }, { status: 400 });
        }
        if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
            return NextResponse.json({ error: 'content demasiado grande' }, { status: 413 });
        }
        const commitMessage = typeof message === 'string' ? message.slice(0, 200) : '';

        // Si es preview, crear rama separada en vez de main
        const targetBranch = preview ? `preview/${Date.now()}` : BRANCH;

        // Si es preview, primero crear la rama
        if (preview) {
            // Obtener SHA de main
            const mainRes = await fetch(
                `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/main`,
                { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'BelfastCM' } }
            );
            const mainData = await mainRes.json();
            const mainSha = mainData.object?.sha;

            // Crear rama preview
            await fetch(
                `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`,
                {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'BelfastCM' },
                    body: JSON.stringify({ ref: `refs/heads/${targetBranch}`, sha: mainSha })
                }
            );
        }

        // Obtener SHA del archivo actual
        const fileRes = await fetch(
            `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}?ref=${encodeURIComponent(targetBranch)}`,
            { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'BelfastCM' } }
        );
        const fileData = await fileRes.json();
        const currentSha = fileData.sha;

        // Subir el archivo nuevo
        const updateRes = await fetch(
            `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`,
            {
                method: 'PUT',
                headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'BelfastCM' },
                body: JSON.stringify({
                    message: commitMessage || 'Actualización automática via IA',
                    content: Buffer.from(content).toString('base64'),
                    sha: currentSha,
                    branch: targetBranch
                })
            }
        );

        if (!updateRes.ok) {
            console.error('Error GitHub:', updateRes.status);
            return NextResponse.json({ error: 'No se pudo aplicar el cambio' }, { status: 502 });
        }

        const previewUrl = preview && PREVIEW_URL_TEMPLATE
            ? PREVIEW_URL_TEMPLATE.replace('{branch}', targetBranch.replace('/', '-'))
            : PRODUCTION_URL;

        return NextResponse.json({
            ok: true,
            branch: targetBranch,
            previewUrl,
            message: preview
                ? `Cambio en rama preview. Probalo en: ${previewUrl}`
                : 'Cambio aplicado en producción.'
        });

    } catch (e) {
        console.error('Error update-code:', e);
        return NextResponse.json({ error: 'Error interno' }, { status: 500 });
    }
}

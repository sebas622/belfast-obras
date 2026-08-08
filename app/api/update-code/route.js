import { NextResponse } from 'next/server';
import { errorMessage, httpError, logError } from '../../../lib/errors';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = 'sebas622';
const REPO_NAME = 'belfast-final';
const BRANCH = 'main';

const ghHeaders = (json) => ({
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    'User-Agent': 'BelfastCM',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
});

export async function POST(request) {
    try {
        if (!GITHUB_TOKEN) {
            return NextResponse.json({ error: 'Falta configurar GITHUB_TOKEN en el servidor' }, { status: 503 });
        }

        const { filePath, content, message, preview } = await request.json();

        if (!filePath || !content) {
            return NextResponse.json({ error: 'filePath y content son requeridos' }, { status: 400 });
        }

        // Si es preview, crear rama separada en vez de main
        const targetBranch = preview ? `preview/${Date.now()}` : BRANCH;

        // Si es preview, primero crear la rama
        if (preview) {
            // Obtener SHA de main
            const mainRes = await fetch(
                `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/main`,
                { headers: ghHeaders() }
            );
            if (!mainRes.ok) throw await httpError('No se pudo leer la rama main', mainRes);
            const mainData = await mainRes.json();
            const mainSha = mainData.object?.sha;
            if (!mainSha) throw new Error('La respuesta de GitHub no incluyó el SHA de main');

            // Crear rama preview
            const branchRes = await fetch(
                `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`,
                {
                    method: 'POST',
                    headers: ghHeaders(true),
                    body: JSON.stringify({ ref: `refs/heads/${targetBranch}`, sha: mainSha })
                }
            );
            if (!branchRes.ok) throw await httpError(`No se pudo crear la rama ${targetBranch}`, branchRes);
        }

        // Obtener SHA del archivo actual (404 = archivo nuevo, se crea sin sha)
        const fileRes = await fetch(
            `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}?ref=${targetBranch}`,
            { headers: ghHeaders() }
        );
        if (!fileRes.ok && fileRes.status !== 404) {
            throw await httpError(`No se pudo leer ${filePath}`, fileRes);
        }
        const currentSha = fileRes.ok ? (await fileRes.json()).sha : undefined;

        // Subir el archivo nuevo
        const updateRes = await fetch(
            `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`,
            {
                method: 'PUT',
                headers: ghHeaders(true),
                body: JSON.stringify({
                    message: message || '🤖 Actualización automática via IA',
                    content: Buffer.from(content).toString('base64'),
                    sha: currentSha,
                    branch: targetBranch
                })
            }
        );

        if (!updateRes.ok) {
            throw await httpError(`No se pudo actualizar ${filePath}`, updateRes);
        }

        const previewUrl = preview
            ? `https://belfast-final-git-${targetBranch.replace('/', '-')}-sebas-5237s-projects.vercel.app`
            : 'https://belfast-final.vercel.app';

        return NextResponse.json({
            ok: true,
            branch: targetBranch,
            previewUrl,
            message: preview
                ? `Cambio en rama preview. Probalo en: ${previewUrl}`
                : 'Cambio aplicado en producción.'
        });

    } catch (e) {
        logError('api/update-code', e);
        return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
    }
}

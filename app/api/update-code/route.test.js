const { POST } = require('./route')

const REPO = 'https://api.github.com/repos/sebas622/belfast-final'

function makeReq(body) {
  return { json: jest.fn(async () => body) }
}

function jsonRes(body, ok = true) {
  return { ok, json: async () => body }
}

function findCall(calls, predicate) {
  return calls.find(([url, opts = {}]) => predicate(url, opts))
}

describe('POST /api/update-code', () => {
  beforeEach(() => {
    global.fetch = jest.fn()
    jest.spyOn(Date, 'now').mockReturnValue(1700000000000)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    delete global.fetch
  })

  it('devuelve 400 si falta filePath o content', async () => {
    for (const body of [{}, { filePath: 'a.js' }, { content: 'x' }]) {
      const res = await POST(makeReq(body))
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({
        error: 'filePath y content son requeridos',
      })
    }
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('commitea en main y devuelve la url de producción', async () => {
    global.fetch
      .mockResolvedValueOnce(jsonRes({ sha: 'sha-actual' })) // GET contents
      .mockResolvedValueOnce(jsonRes({ commit: {} })) // PUT contents

    const res = await POST(
      makeReq({ filePath: 'app/page.js', content: 'hola', message: 'mi commit' })
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      ok: true,
      branch: 'main',
      previewUrl: 'https://belfast-final.vercel.app',
      message: 'Cambio aplicado en producción.',
    })

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(global.fetch.mock.calls[0][0]).toBe(
      `${REPO}/contents/app/page.js?ref=main`
    )

    const [putUrl, putOpts] = global.fetch.mock.calls[1]
    expect(putUrl).toBe(`${REPO}/contents/app/page.js`)
    expect(putOpts.method).toBe('PUT')
    expect(JSON.parse(putOpts.body)).toEqual({
      message: 'mi commit',
      content: Buffer.from('hola').toString('base64'),
      sha: 'sha-actual',
      branch: 'main',
    })
  })

  it('usa el mensaje de commit por defecto', async () => {
    global.fetch
      .mockResolvedValueOnce(jsonRes({ sha: 'sha-actual' }))
      .mockResolvedValueOnce(jsonRes({}))

    await POST(makeReq({ filePath: 'a.js', content: 'x' }))

    const body = JSON.parse(global.fetch.mock.calls[1][1].body)
    expect(body.message).toBe('🤖 Actualización automática via IA')
  })

  it('crea la rama preview desde main y devuelve su url', async () => {
    global.fetch
      .mockResolvedValueOnce(jsonRes({ object: { sha: 'main-sha' } })) // GET ref main
      .mockResolvedValueOnce(jsonRes({})) // POST refs
      .mockResolvedValueOnce(jsonRes({ sha: 'file-sha' })) // GET contents
      .mockResolvedValueOnce(jsonRes({})) // PUT contents

    const res = await POST(makeReq({ filePath: 'a.js', content: 'x', preview: true }))
    const body = await res.json()

    expect(body.branch).toBe('preview/1700000000000')
    expect(body.previewUrl).toBe(
      'https://belfast-final-git-preview-1700000000000-sebas-5237s-projects.vercel.app'
    )
    expect(body.message).toContain(body.previewUrl)

    expect(global.fetch.mock.calls[0][0]).toBe(`${REPO}/git/ref/heads/main`)

    const createRef = findCall(global.fetch.mock.calls, url => url === `${REPO}/git/refs`)
    expect(JSON.parse(createRef[1].body)).toEqual({
      ref: 'refs/heads/preview/1700000000000',
      sha: 'main-sha',
    })

    expect(global.fetch.mock.calls[2][0]).toBe(
      `${REPO}/contents/a.js?ref=preview/1700000000000`
    )
    expect(JSON.parse(global.fetch.mock.calls[3][1].body).branch).toBe(
      'preview/1700000000000'
    )
  })

  it('envía el token de GitHub en cada request', async () => {
    process.env.GITHUB_TOKEN = 'token-de-prueba'
    jest.resetModules()
    const { POST: freshPOST } = require('./route')

    global.fetch
      .mockResolvedValueOnce(jsonRes({ sha: 'sha' }))
      .mockResolvedValueOnce(jsonRes({}))

    await freshPOST(makeReq({ filePath: 'a.js', content: 'x' }))

    for (const [, opts] of global.fetch.mock.calls) {
      expect(opts.headers.Authorization).toBe('Bearer token-de-prueba')
      expect(opts.headers['User-Agent']).toBe('BelfastCM')
    }
    delete process.env.GITHUB_TOKEN
  })

  it('propaga el error de GitHub como 500', async () => {
    global.fetch
      .mockResolvedValueOnce(jsonRes({ sha: 'sha' }))
      .mockResolvedValueOnce(jsonRes({ message: 'sha does not match' }, false))

    const res = await POST(makeReq({ filePath: 'a.js', content: 'x' }))
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'sha does not match' })
  })

  it('devuelve 500 si el body no es JSON válido', async () => {
    const res = await POST({
      json: jest.fn(async () => {
        throw new Error('Unexpected token')
      }),
    })
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'Unexpected token' })
  })

  it('devuelve 500 si falla la red', async () => {
    global.fetch.mockRejectedValueOnce(new Error('ECONNRESET'))
    const res = await POST(makeReq({ filePath: 'a.js', content: 'x' }))
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'ECONNRESET' })
  })
})

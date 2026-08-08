jest.mock('../../../lib/supabase', () => ({
  getServerClient: jest.fn(),
  EMPRESA_ID: 'empresa-1',
}))

const { getServerClient, EMPRESA_ID } = require('../../../lib/supabase')
const { POST } = require('./route')

function makeFile({ name = 'foto.jpg', type = 'image/jpeg', bytes = [1, 2, 3] } = {}) {
  return {
    name,
    type,
    arrayBuffer: jest.fn(async () => Uint8Array.from(bytes).buffer),
  }
}

function makeReq(fields) {
  const map = new Map(Object.entries(fields))
  return { formData: jest.fn(async () => ({ get: k => (map.has(k) ? map.get(k) : null) })) }
}

function makeSupabase({ uploadError = null, publicUrl = 'https://cdn/foto.jpg', insertError = null } = {}) {
  const upload = jest.fn(async () => ({ error: uploadError }))
  const getPublicUrl = jest.fn(() => ({ data: { publicUrl } }))
  const insert = jest.fn(async () => ({ error: insertError }))
  const storageFrom = jest.fn(() => ({ upload, getPublicUrl }))
  const from = jest.fn(() => ({ insert }))
  return { sb: { storage: { from: storageFrom }, from }, upload, getPublicUrl, insert, storageFrom, from }
}

describe('POST /api/fotos', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(Date, 'now').mockReturnValue(1700000000000)
  })

  afterEach(() => jest.restoreAllMocks())

  it('devuelve 400 si no se envió archivo', async () => {
    const res = await POST(makeReq({}))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'No se recibió archivo' })
    expect(getServerClient).not.toHaveBeenCalled()
  })

  it('sube el archivo y registra la foto de la obra', async () => {
    const mock = makeSupabase()
    getServerClient.mockReturnValue(mock.sb)

    const file = makeFile()
    const res = await POST(makeReq({ file, obraId: 'obra-9', descripcion: 'contrapiso' }))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, url: 'https://cdn/foto.jpg' })

    expect(mock.storageFrom).toHaveBeenCalledWith('bcm-media')
    const [path, buffer, opts] = mock.upload.mock.calls[0]
    expect(path).toBe(`${EMPRESA_ID}/obra-9/1700000000000.jpg`)
    expect(Buffer.isBuffer(buffer)).toBe(true)
    expect(Array.from(buffer)).toEqual([1, 2, 3])
    expect(opts).toEqual({ contentType: 'image/jpeg', upsert: false })

    expect(mock.from).toHaveBeenCalledWith('fotos')
    expect(mock.insert).toHaveBeenCalledWith({
      empresa_id: EMPRESA_ID,
      obra_id: 'obra-9',
      nombre: 'foto.jpg',
      url: 'https://cdn/foto.jpg',
      descripcion: 'contrapiso',
    })
  })

  it('usa obra "general" y descripción vacía por defecto, y guarda obra_id null', async () => {
    const mock = makeSupabase()
    getServerClient.mockReturnValue(mock.sb)

    await POST(makeReq({ file: makeFile({ name: 'plano.pdf', type: 'application/pdf' }) }))

    expect(mock.upload.mock.calls[0][0]).toBe(`${EMPRESA_ID}/general/1700000000000.pdf`)
    expect(mock.insert).toHaveBeenCalledWith(
      expect.objectContaining({ obra_id: null, descripcion: '' })
    )
  })

  it('devuelve 500 con el mensaje del error de upload', async () => {
    const mock = makeSupabase({ uploadError: new Error('bucket lleno') })
    getServerClient.mockReturnValue(mock.sb)

    const res = await POST(makeReq({ file: makeFile() }))

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'bucket lleno' })
    expect(mock.insert).not.toHaveBeenCalled()
  })

  it('devuelve 500 si el formData falla', async () => {
    const res = await POST({ formData: jest.fn(async () => { throw new Error('body inválido') }) })
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'body inválido' })
  })
})

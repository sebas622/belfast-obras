const mockCreate = jest.fn()

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } }))
})

jest.mock('../../../lib/supabase', () => ({
  getServerClient: jest.fn(),
  EMPRESA_ID: 'empresa-1',
}))

const { getServerClient, EMPRESA_ID } = require('../../../lib/supabase')
const { POST } = require('./route')

// Query builder encadenable: select().eq().eq() resuelve a { data }
function selectChain(data) {
  const self = {
    eq: jest.fn(() => self),
    then: (resolve, reject) => Promise.resolve({ data, error: null }).then(resolve, reject),
  }
  return self
}

function makeSupabase({ tables = {}, insertError = null, updateError = null } = {}) {
  const inserts = []
  const updates = []
  const from = jest.fn(table => ({
    select: jest.fn(() => selectChain(tables[table] ?? [])),
    insert: jest.fn(async row => {
      inserts.push({ table, row })
      return { error: insertError }
    }),
    update: jest.fn(row => {
      const rec = { table, row, filters: {} }
      updates.push(rec)
      const chain = {
        eq: jest.fn((col, val) => {
          rec.filters[col] = val
          return chain
        }),
        then: (resolve, reject) =>
          Promise.resolve({ error: updateError }).then(resolve, reject),
      }
      return chain
    }),
  }))
  return { sb: { from }, from, inserts, updates }
}

function aiText(text) {
  return { content: [{ type: 'text', text }] }
}

function makeReq(body) {
  return { json: jest.fn(async () => body) }
}

describe('POST /api/chat', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('devuelve el texto del modelo y sin acciones', async () => {
    const mock = makeSupabase()
    getServerClient.mockReturnValue(mock.sb)
    mockCreate.mockResolvedValue(aiText('Todo en orden.'))

    const res = await POST(makeReq({ messages: [{ role: 'user', content: 'hola' }] }))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ texto: 'Todo en orden.', acciones: [] })
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: 'hola' }],
      })
    )
  })

  it('inyecta el contexto de la base en el system prompt', async () => {
    const mock = makeSupabase({
      tables: {
        obras: [{ nombre: 'Torre A', avance: 40, estado: 'curso' }],
        personal: [{ nombre: 'Ana', rol: 'Electricista' }],
        licitaciones: [{ nombre: 'Lic 1', estado: 'presentada' }],
        alertas: [{ prioridad: 'alta', mensaje: 'Falta ART' }],
      },
    })
    getServerClient.mockReturnValue(mock.sb)
    mockCreate.mockResolvedValue(aiText('ok'))

    await POST(makeReq({ messages: [] }))

    const { system } = mockCreate.mock.calls[0][0]
    expect(system).toContain('OBRAS (1): Torre A — 40% avance, estado: curso')
    expect(system).toContain('PERSONAL (1): Ana (Electricista)')
    expect(system).toContain('LICITACIONES (1): Lic 1 — presentada')
    expect(system).toContain('ALERTAS (1): [alta] Falta ART')
  })

  it('usa textos de "Sin ..." cuando no hay datos', async () => {
    const mock = makeSupabase({
      tables: { obras: null, personal: null, licitaciones: null, alertas: null },
    })
    getServerClient.mockReturnValue(mock.sb)
    mockCreate.mockResolvedValue(aiText('ok'))

    await POST(makeReq({ messages: [] }))

    const { system } = mockCreate.mock.calls[0][0]
    expect(system).toContain('Sin obras')
    expect(system).toContain('Sin personal')
    expect(system).toContain('Sin licitaciones')
    expect(system).toContain('Sin alertas')
  })

  it('ejecuta agregar_personal y limpia el bloque ACTION del texto', async () => {
    const mock = makeSupabase()
    getServerClient.mockReturnValue(mock.sb)
    mockCreate.mockResolvedValue(
      aiText(
        'Listo, agregué a Juan.\n[[ACTION:{"tipo":"agregar_personal","nombre":"Juan Pérez","rol":"Electricista"}]]'
      )
    )

    const res = await POST(makeReq({ messages: [] }))
    const body = await res.json()

    expect(body.texto).toBe('Listo, agregué a Juan.')
    expect(body.acciones).toEqual([
      { tipo: 'agregar_personal', ok: true, nombre: 'Juan Pérez', error: undefined },
    ])
    expect(mock.inserts).toEqual([
      {
        table: 'personal',
        row: {
          empresa_id: EMPRESA_ID,
          nombre: 'Juan Pérez',
          rol: 'Electricista',
          telefono: '',
          dni: '',
          activo: true,
        },
      },
    ])
  })

  it('aplica valores por defecto al agregar personal, licitación y obra', async () => {
    const mock = makeSupabase()
    getServerClient.mockReturnValue(mock.sb)
    mockCreate.mockResolvedValue(
      aiText(
        '[[ACTION:{"tipo":"agregar_personal","nombre":"Sin Rol"}]]' +
          '[[ACTION:{"tipo":"agregar_licitacion","nombre":"Lic X"}]]' +
          '[[ACTION:{"tipo":"agregar_obra","nombre":"Obra X"}]]'
      )
    )

    const res = await POST(makeReq({ messages: [] }))
    const body = await res.json()

    expect(body.texto).toBe('')
    expect(body.acciones.map(a => a.tipo)).toEqual([
      'agregar_personal',
      'agregar_licitacion',
      'agregar_obra',
    ])
    expect(mock.inserts[0].row).toMatchObject({ rol: 'Operario', telefono: '', dni: '' })
    expect(mock.inserts[1]).toMatchObject({
      table: 'licitaciones',
      row: { nombre: 'Lic X', estado: 'pendiente', monto: '' },
    })
    expect(mock.inserts[2]).toMatchObject({
      table: 'obras',
      row: { nombre: 'Obra X', ubicacion: '', avance: 0, estado: 'curso' },
    })
  })

  it('ejecuta update_avance filtrando por obra y empresa', async () => {
    const mock = makeSupabase()
    getServerClient.mockReturnValue(mock.sb)
    mockCreate.mockResolvedValue(
      aiText('[[ACTION:{"tipo":"update_avance","obraId":"obra-7","avance":75}]]')
    )

    const res = await POST(makeReq({ messages: [] }))
    const body = await res.json()

    expect(body.acciones).toEqual([{ tipo: 'update_avance', ok: true, error: undefined }])
    expect(mock.updates).toHaveLength(1)
    expect(mock.updates[0].table).toBe('obras')
    expect(mock.updates[0].row.avance).toBe(75)
    expect(mock.updates[0].row.updated_at).toEqual(expect.any(String))
    expect(mock.updates[0].filters).toEqual({ id: 'obra-7', empresa_id: EMPRESA_ID })
  })

  it('reporta ok:false con el mensaje cuando la escritura falla', async () => {
    const mock = makeSupabase({ insertError: { message: 'RLS denied' } })
    getServerClient.mockReturnValue(mock.sb)
    mockCreate.mockResolvedValue(
      aiText('[[ACTION:{"tipo":"agregar_personal","nombre":"Juan"}]]')
    )

    const body = await (await POST(makeReq({ messages: [] }))).json()
    expect(body.acciones).toEqual([
      { tipo: 'agregar_personal', ok: false, nombre: 'Juan', error: 'RLS denied' },
    ])
  })

  it('marca la acción como unknown si el JSON es inválido', async () => {
    const mock = makeSupabase()
    getServerClient.mockReturnValue(mock.sb)
    mockCreate.mockResolvedValue(aiText('texto [[ACTION:{no-json}]]'))

    const body = await (await POST(makeReq({ messages: [] }))).json()
    expect(body.texto).toBe('texto')
    expect(body.acciones).toHaveLength(1)
    expect(body.acciones[0]).toMatchObject({ tipo: 'unknown', ok: false })
    expect(body.acciones[0].error).toEqual(expect.any(String))
  })

  it('devuelve "" si la respuesta no trae bloques de texto', async () => {
    const mock = makeSupabase()
    getServerClient.mockReturnValue(mock.sb)
    mockCreate.mockResolvedValue({ content: [{ type: 'tool_use' }] })

    const body = await (await POST(makeReq({ messages: [] }))).json()
    expect(body).toEqual({ texto: '', acciones: [] })
  })

  it('devuelve 500 si falla la llamada al modelo', async () => {
    const mock = makeSupabase()
    getServerClient.mockReturnValue(mock.sb)
    jest.spyOn(console, 'error').mockImplementation(() => {})
    mockCreate.mockRejectedValue(new Error('overloaded'))

    const res = await POST(makeReq({ messages: [] }))
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'overloaded' })
    console.error.mockRestore()
  })
})

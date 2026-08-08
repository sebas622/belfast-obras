jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn((url, key, opts) => ({ url, key, opts })),
}))

const SUPA_URL = 'https://gibfrivfjtjjijihaxwh.supabase.co'

// Cada test necesita un módulo fresco porque getClient cachea el cliente.
function loadFresh() {
  let mod
  let createClient
  jest.isolateModules(() => {
    createClient = require('@supabase/supabase-js').createClient
    createClient.mockClear()
    mod = require('./supabase')
  })
  return { ...mod, createClient }
}

describe('lib/supabase', () => {
  const originalEnv = process.env.SUPABASE_SERVICE_ROLE_KEY

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalEnv
  })

  it('EMPRESA_ID es el uuid fijo de la empresa', () => {
    expect(loadFresh().EMPRESA_ID).toBe('00000000-0000-0000-0000-000000000001')
  })

  it('getClient crea el cliente con la anon key', () => {
    const { getClient, createClient } = loadFresh()
    getClient()
    expect(createClient).toHaveBeenCalledTimes(1)
    const [url, key] = createClient.mock.calls[0]
    expect(url).toBe(SUPA_URL)
    expect(key).toMatch(/^eyJ/)
  })

  it('getClient reusa el mismo cliente (singleton)', () => {
    const { getClient, createClient } = loadFresh()
    expect(getClient()).toBe(getClient())
    expect(createClient).toHaveBeenCalledTimes(1)
  })

  it('getServerClient usa la service role key cuando está definida', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
    const { getServerClient, createClient } = loadFresh()
    getServerClient()
    const [url, key, opts] = createClient.mock.calls[0]
    expect(url).toBe(SUPA_URL)
    expect(key).toBe('service-key')
    expect(opts).toEqual({ auth: { autoRefreshToken: false, persistSession: false } })
  })

  it('getServerClient cae a la anon key si falta la service role key', () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const { getServerClient, createClient } = loadFresh()
    getServerClient()
    const [, key] = createClient.mock.calls[0]
    expect(key).toMatch(/^eyJ/)
  })

  it('getServerClient crea un cliente nuevo en cada llamada', () => {
    const { getServerClient, createClient } = loadFresh()
    expect(getServerClient()).not.toBe(getServerClient())
    expect(createClient).toHaveBeenCalledTimes(2)
  })
})

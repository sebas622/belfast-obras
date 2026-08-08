/**
 * @jest-environment jsdom
 */
import {
  PERMISO_DEFAULT,
  getPermisoEmpresa,
  isDirectivo,
  urlBase64ToUint8Array,
  uid,
  getBase64,
  getMediaType,
  daysSince,
  hexLight,
  parseMontoNum,
  formatMonto,
  parseMonto,
  distanciaMetros,
  formatDuration,
} from './utils'

describe('getPermisoEmpresa', () => {
  it('devuelve el permiso configurado del email', () => {
    expect(getPermisoEmpresa('usuario.belfast@ejemplo.com')).toBe('belfast')
    expect(getPermisoEmpresa('usuario.vv@ejemplo.com')).toBe('vv')
    expect(getPermisoEmpresa('sebas622@gmail.com')).toBe('ambas')
  })

  it('normaliza mayúsculas y espacios', () => {
    expect(getPermisoEmpresa('  Usuario.VV@Ejemplo.com ')).toBe('vv')
  })

  it('cae al permiso por defecto para emails desconocidos o vacíos', () => {
    expect(getPermisoEmpresa('desconocido@ejemplo.com')).toBe(PERMISO_DEFAULT)
    expect(getPermisoEmpresa('')).toBe(PERMISO_DEFAULT)
    expect(getPermisoEmpresa(undefined)).toBe(PERMISO_DEFAULT)
  })
})

describe('isDirectivo', () => {
  it('es true cuando el nivel es directivo', () => {
    expect(isDirectivo({ nivel: 'directivo' })).toBe(true)
  })

  it('es true para roles jerárquicos, sin importar mayúsculas', () => {
    expect(isDirectivo({ rol: 'Administrador' })).toBe(true)
    expect(isDirectivo({ rol: 'supervisor de obra' })).toBe(true)
    expect(isDirectivo({ rol: 'GERENTE' })).toBe(true)
    expect(isDirectivo({ rol: 'Director Técnico' })).toBe(true)
  })

  it('es false para operarios y para usuarios ausentes', () => {
    expect(isDirectivo({ rol: 'Electricista', nivel: 'operario' })).toBe(false)
    expect(isDirectivo({})).toBe(false)
    expect(isDirectivo(null)).toBe(false)
    expect(isDirectivo(undefined)).toBe(false)
  })
})

describe('urlBase64ToUint8Array', () => {
  it('decodifica base64url a bytes', () => {
    // 'Ma?' en base64url estándar sería 'TWE/' ; con - y _ debe traducirse igual
    expect(Array.from(urlBase64ToUint8Array('TWE_'))).toEqual([77, 97, 63])
    expect(Array.from(urlBase64ToUint8Array('++--'))).toEqual(
      Array.from(urlBase64ToUint8Array('++++'))
    )
  })

  it('agrega el padding faltante', () => {
    expect(Array.from(urlBase64ToUint8Array('QQ'))).toEqual([65])
    expect(Array.from(urlBase64ToUint8Array('QUJD'))).toEqual([65, 66, 67])
  })

  it('devuelve un Uint8Array vacío para string vacío', () => {
    const out = urlBase64ToUint8Array('')
    expect(out).toBeInstanceOf(Uint8Array)
    expect(out).toHaveLength(0)
  })
})

describe('uid', () => {
  it('genera ids alfanuméricos cortos', () => {
    expect(uid()).toMatch(/^[0-9a-z]{1,7}$/)
  })

  it('genera valores distintos', () => {
    const ids = new Set(Array.from({ length: 200 }, () => uid()))
    expect(ids.size).toBeGreaterThan(190)
  })
})

describe('getBase64 / getMediaType', () => {
  it('extrae el payload base64 de un data URL', () => {
    expect(getBase64('data:image/png;base64,AAAB')).toBe('AAAB')
  })

  it('extrae el mime type de un data URL', () => {
    expect(getMediaType('data:image/png;base64,AAAB')).toBe('image/png')
    expect(getMediaType('data:application/pdf;base64,AAAB')).toBe('application/pdf')
  })

  it('usa image/jpeg cuando no puede determinar el mime type', () => {
    expect(getMediaType('no-es-un-data-url')).toBe('image/jpeg')
  })
})

describe('daysSince', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date(2025, 0, 10, 12, 0, 0))
  })
  afterEach(() => jest.useRealTimers())

  it('devuelve 999 cuando no hay fecha', () => {
    expect(daysSince('')).toBe(999)
    expect(daysSince(null)).toBe(999)
  })

  it('devuelve días positivos para fechas futuras (dd/mm/yy)', () => {
    expect(daysSince('20/01/25')).toBe(10)
  })

  it('devuelve días negativos para fechas pasadas', () => {
    expect(daysSince('01/01/25')).toBe(-9)
  })
})

describe('hexLight', () => {
  it('aclara un color hex mezclándolo con blanco', () => {
    expect(hexLight('#000000')).toBe('#e0e0e0')
    expect(hexLight('#ffffff')).toBe('#ffffff')
  })

  it('mantiene 7 caracteres con padding de ceros', () => {
    const out = hexLight('#1D4ED8')
    expect(out).toHaveLength(7)
    expect(out).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('cae al color por defecto ante entradas inválidas', () => {
    expect(hexLight(null)).toBe('#EFF6FF')
    expect(hexLight(undefined)).toBe('#EFF6FF')
  })
})

describe('parseMontoNum', () => {
  it('convierte montos formateados a número', () => {
    expect(parseMontoNum('1.500.000 $')).toBe(1500000)
    expect(parseMontoNum('$ 250')).toBe(250)
    expect(parseMontoNum(4200)).toBe(4200)
  })

  it('devuelve 0 para valores vacíos o sin dígitos', () => {
    expect(parseMontoNum('')).toBe(0)
    expect(parseMontoNum(null)).toBe(0)
    expect(parseMontoNum(undefined)).toBe(0)
    expect(parseMontoNum('a definir')).toBe(0)
  })
})

describe('formatMonto', () => {
  it('agrupa miles con punto y agrega el signo', () => {
    expect(formatMonto('1500000')).toBe('1.500.000 $')
    expect(formatMonto('999')).toBe('999 $')
    expect(formatMonto('1000')).toBe('1.000 $')
  })

  it('ignora caracteres no numéricos', () => {
    expect(formatMonto('u$s 12.345')).toBe('12.345 $')
  })

  it('devuelve string vacío si no hay dígitos', () => {
    expect(formatMonto('')).toBe('')
    expect(formatMonto('abc')).toBe('')
  })

  it('es idempotente sobre su propia salida', () => {
    expect(formatMonto(formatMonto('1500000'))).toBe('1.500.000 $')
  })
})

describe('parseMonto', () => {
  it('deja solo los dígitos', () => {
    expect(parseMonto('1.500.000 $')).toBe('1500000')
    expect(parseMonto('abc')).toBe('')
    expect(parseMonto(123)).toBe('123')
  })
})

describe('distanciaMetros', () => {
  it('es 0 para el mismo punto', () => {
    expect(distanciaMetros(-34.6037, -58.3816, -34.6037, -58.3816)).toBe(0)
  })

  it('calcula la distancia haversine entre dos puntos', () => {
    // Obelisco → Aeroparque, ~7 km
    const d = distanciaMetros(-34.6037, -58.3816, -34.5592, -58.4156)
    expect(d).toBeGreaterThan(5500)
    expect(d).toBeLessThan(7000)
  })

  it('es simétrica', () => {
    const a = distanciaMetros(-34.6, -58.38, -34.55, -58.41)
    const b = distanciaMetros(-34.55, -58.41, -34.6, -58.38)
    expect(a).toBeCloseTo(b, 6)
  })

  it('aproxima 111 km por grado de latitud', () => {
    const d = distanciaMetros(0, 0, 1, 0)
    expect(d).toBeGreaterThan(110000)
    expect(d).toBeLessThan(112000)
  })
})

describe('formatDuration', () => {
  it('formatea horas y minutos', () => {
    expect(formatDuration(3600000)).toBe('1h 0m')
    expect(formatDuration(3600000 * 8 + 60000 * 30)).toBe('8h 30m')
    expect(formatDuration(60000 * 45)).toBe('0h 45m')
  })

  it('devuelve un guión para valores nulos, cero o negativos', () => {
    expect(formatDuration(0)).toBe('—')
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(undefined)).toBe('—')
    expect(formatDuration(-1000)).toBe('—')
  })
})

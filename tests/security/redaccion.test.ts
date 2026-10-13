/**
 * H-01: la clave de TMDB no puede salir en el mensaje de un fallo.
 *
 * El sitio publica su clave en el bundle y el plugin la lee en ejecución: aquí se
 * sirve una clave conocida y se fuerzan los dos caminos de fallo —un estado que
 * no es 2xx y un corte de red—. El motor redacta por **nombre de clave**, así que
 * una credencial dentro de una cadena sólo la quita quien la escribe.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { espiarFetch, opcionesDePrueba, type Espia } from './apoyo'

const proveedor = (await import('../../providers/cuevana3')).default

const CLAVE = 'abcdef0123456789abcdef0123456789'
const BUNDLE = `var x = { ADSKEY: atob("${Buffer.from(CLAVE).toString('base64')}") };`
const PAGINA = '<html><body><script src="/f0/1d9/tr/smartlinks/uno.js"></script></body></html>'

let espia: Espia | undefined

function montar(tmdb: () => Response): Espia {
  const montado = espiarFetch((url) => {
    if (url.pathname === '/inicio') return new Response(PAGINA)
    if (url.pathname === '/f0/1d9/tr/smartlinks/uno.js') return new Response(BUNDLE)
    if (url.host === 'api.themoviedb.org') return tmdb()

    return undefined
  })

  espia = montado
  return montado
}

afterEach(() => {
  espia?.restaurar()
  espia = undefined
})

describe('la clave de TMDB no viaja en el error', () => {
  test('ni con un estado que no es 2xx', async () => {
    const { fetch } = montar(() => new Response('{"status_code":7}', { status: 401 }))

    const fallo = await proveedor.search('avatar', opcionesDePrueba(fetch)).catch((causa) => causa)

    expect(String(fallo)).not.toContain(CLAVE)
    expect(String(fallo)).toContain('[redactado]')
  })

  test('ni con un corte de red', async () => {
    const { fetch } = montar(() => {
      throw new TypeError('fetch failed')
    })

    const fallo = await proveedor.search('avatar', opcionesDePrueba(fetch)).catch((causa) => causa)

    expect(String(fallo)).not.toContain(CLAVE)
    expect(String(fallo)).toContain('[redactado]')
  })

  test('el mensaje sigue diciendo dónde falló', async () => {
    const { fetch } = montar(() => new Response('nada', { status: 429 }))

    const fallo = String(
      await proveedor.search('avatar', opcionesDePrueba(fetch)).catch((causa) => causa),
    )

    // Sin el motivo, el mensaje no sirve para arreglar nada: lo que se quita es la
    // credencial, no el diagnóstico.
    expect(fallo).toContain('api.themoviedb.org')
    expect(fallo).toContain('429')
  })
})

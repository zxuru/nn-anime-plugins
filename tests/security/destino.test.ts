/**
 * H-02 y H-04: la guarda de destino y el tope de cuerpo de un plugin real
 * (`pelisplushd`), con la red interceptada en la capacidad del motor.
 *
 * La base queda en su valor público de fábrica, que es el caso normal, así que la
 * relajación por base interna está apagada y la rama que **bloquea** se ejercita
 * de verdad. La última prueba enciende la relajación y comprueba que el camino
 * local sigue funcionando.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { espiarFetch, opcionesDePrueba, type Espia } from './apoyo'

const proveedor = (await import('../../providers/pelisplushd')).default

const ref = (value: string) => ({ providerId: 'pelisplushd', value })
const M3U8 = 'https://cdn.example/master.m3u8'
const GRANDE = 9 * 1024 * 1024
/** El tope que el plugin declara a la capacidad en cada petición. */
const TOPE = 8 * 1024 * 1024

const BUSQUEDA = `<!doctype html>
<form role="search"><input type="text" name="s"></form>
<a href="/pelicula/avatar" data-title="VER Avatar Online Gratis HD" data-src="/img/avatar.jpg">
  <img src="/img/avatar.jpg" alt="Avatar">
</a>`

const FICHA = `<!doctype html><head>
<meta property="og:title" content="Avatar">
<meta property="og:description" content="Una película.">
<meta property="og:image" content="https://img.example/avatar.jpg">
</head><body></body>`

const EMBED = `<html><body><script>playServerVast('https://vidhide.example/mirror')</script></body></html>`
const ESPEJO = `var sources = [{file: "${M3U8}"}];`

/**
 * Un embed **público** que publica un espejo interno: así se ejercita la guarda
 * del espejo (`medioDelEspejo`), que es otra comprobación distinta de la del
 * `<iframe>` y que sin este caso no medía ninguna prueba. La dirección lleva
 * `vidhide` porque es la forma que reconoce el atajo del sitio, y sin eso el
 * plugin ni siquiera llega a pedir el espejo.
 */
const EMBED_ESPEJO_INTERNO = `<html><body><script>playServerVast('http://127.0.0.1:9999/vidhide')</script></body></html>`

/** El `video[0]` de cada capítulo de la serie falsa. */
const CAPITULOS: Readonly<Record<string, string>> = {
  '1': 'http://127.0.0.1:9999/embed',
  '2': 'http://169.254.169.254/latest/meta-data/',
  '3': 'http://[::ffff:7f00:1]:9999/embed',
  '4': 'https://cdn.example/embed',
  '5': 'http://127.0.0.1:8080/embed',
  '6': 'https://cdn.example/embed-espejo-interno',
}

function montar(): Espia {
  return espiarFetch((url) => {
    if (url.pathname === '/search') return { body: BUSQUEDA }
    if (url.pathname === '/pelicula/avatar') return { body: FICHA }
    if (url.pathname === '/pelicula/grande') return { body: 'x'.repeat(GRANDE) }
    if (url.pathname === '/embed') return { body: EMBED }
    if (url.pathname === '/embed-espejo-interno') return { body: EMBED_ESPEJO_INTERNO }
    if (url.pathname === '/mirror') return { body: ESPEJO }

    const embed = CAPITULOS[url.pathname.split('/').at(-1) ?? '']
    if (url.pathname.startsWith('/serie/') && embed !== undefined) {
      return { body: `<html><script>video[0] = '${embed}';</script></body>` }
    }

    return undefined
  })
}

afterEach(() => {
  delete process.env.NN_ANIME_PELISPLUS_URL
})

describe('el lector sigue leyendo', () => {
  test('la búsqueda devuelve la ficha del buscador', async () => {
    const { fetch } = montar()
    const aciertos = await proveedor.search('avatar', opcionesDePrueba(fetch))

    expect(aciertos).toHaveLength(1)
    expect(aciertos[0]?.ref.value).toBe('pelicula/avatar')
    expect(aciertos[0]?.title).toBe('Avatar')
  })

  test('la ficha sale del `og:`', async () => {
    const { fetch } = montar()
    const ficha = await proveedor.getAnime(ref('pelicula/avatar'), opcionesDePrueba(fetch))

    expect(ficha.title).toBe('Avatar')
    expect(ficha.kind).toBe('movie')
  })
})

describe('un destino interno no se pide', () => {
  for (const [numero, host] of [
    ['1', '127.0.0.1'],
    ['2', '169.254.169.254'],
    ['3', '::ffff:7f00:1'],
  ] as const) {
    test(`el embed a ${host} se descarta`, async () => {
      const { fetch, pedidas } = montar()

      await expect(
        proveedor.resolveStream(
          { episodeRef: ref(`serie/x/temporada/1/capitulo/${numero}`), mode: 'sub' },
          opcionesDePrueba(fetch),
        ),
      ).rejects.toThrow('destino interno')

      expect(pedidas.some((pedida) => pedida.includes(host))).toBe(false)
    })
  }

  /**
   * La **otra** guarda, que es una comprobación distinta: el `<iframe>` es
   * público y el espejo que publica es interno. Quitar la comprobación de
   * `medioDelEspejo` no dejaba ninguna prueba en rojo —lo midió una mutación—, y
   * es la que evita que un sitio comprometido mande la petición a la red de casa.
   */
  test('el espejo interno se descarta aunque el embed sea público', async () => {
    const { fetch, pedidas } = montar()

    await expect(
      proveedor.resolveStream(
        { episodeRef: ref('serie/x/temporada/1/capitulo/6'), mode: 'sub' },
        opcionesDePrueba(fetch),
      ),
    ).rejects.toThrow('destino interno')

    expect(pedidas.some((pedida) => pedida.includes('127.0.0.1'))).toBe(false)
  })
})

describe('el camino público sigue entero', () => {
  test('devuelve el manifiesto con el `Referer` final del espejo', async () => {
    const { fetch } = montar()
    const fuentes = await proveedor.resolveStream(
      { episodeRef: ref('serie/x/temporada/1/capitulo/4'), mode: 'sub' },
      opcionesDePrueba(fetch),
    )

    expect(fuentes[0]?.url).toBe(M3U8)
    expect(fuentes[0]?.kind).toBe('hls')
    // La dirección **final** del espejo, que es la que él mismo comprueba, y no
    // la del enlace que se pidió. Con el `Response` de la API web esta prueba veía
    // la rama de reserva —`url` venía vacía en un `Response` construido a mano—;
    // con la capacidad la dirección final siempre está, que es lo de producción.
    expect(fuentes[0]?.headers?.Referer).toBe('https://vidhide.example/mirror')
  })
})

describe('el cuerpo tiene tope', () => {
  test('un cuerpo de 9 MiB se corta', async () => {
    const { fetch } = montar()

    await expect(
      proveedor.getAnime(ref('pelicula/grande'), opcionesDePrueba(fetch)),
    ).rejects.toThrow('se corta')
  })

  /**
   * El corte por `content-length` ya no lo hace el plugin: esa cabecera no cruza
   * la capacidad, que es la que corta —contando bytes— mientras llega el cuerpo.
   * Lo que este repositorio puede seguir midiendo es que el plugin **declare** su
   * tope en cada petición; el corte del motor se prueba en `media-proxy`.
   */
  test('el plugin declara su tope en cada petición', async () => {
    const { fetch, peticiones } = montar()
    await proveedor.getAnime(ref('pelicula/avatar'), opcionesDePrueba(fetch))

    expect(peticiones.length).toBeGreaterThan(0)
    expect(peticiones.every((peticion) => peticion.maxBytes === TOPE)).toBe(true)
  })
})

describe('la base interna es una decisión explícita', () => {
  test('apuntada a la máquina, el camino local funciona', async () => {
    process.env.NN_ANIME_PELISPLUS_URL = 'http://127.0.0.1:8080'
    const { fetch } = montar()

    const fuentes = await proveedor.resolveStream(
      { episodeRef: ref('serie/x/temporada/1/capitulo/5'), mode: 'sub' },
      opcionesDePrueba(fetch),
    )

    expect(fuentes[0]?.url).toBe(M3U8)
  })
})

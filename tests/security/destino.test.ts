/**
 * H-02 y H-04: la guarda de destino y el tope de cuerpo de un plugin real
 * (`pelisplushd`), con la red interceptada.
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

/** El `video[0]` de cada capítulo de la serie falsa. */
const CAPITULOS: Readonly<Record<string, string>> = {
  '1': 'http://127.0.0.1:9999/embed',
  '2': 'http://169.254.169.254/latest/meta-data/',
  '3': 'http://[::ffff:7f00:1]:9999/embed',
  '4': 'https://cdn.example/embed',
  '5': 'http://127.0.0.1:8080/embed',
}

let espia: Espia | undefined

function montar(): Espia {
  const montado = espiarFetch((url) => {
    if (url.pathname === '/search') return new Response(BUSQUEDA)
    if (url.pathname === '/pelicula/avatar') return new Response(FICHA)
    if (url.pathname === '/pelicula/grande') return new Response('x'.repeat(GRANDE))
    if (url.pathname === '/pelicula/declarado') {
      return new Response('corto', { headers: { 'content-length': String(GRANDE) } })
    }
    if (url.pathname === '/embed') return new Response(EMBED)
    if (url.pathname === '/mirror') return new Response(ESPEJO)

    const embed = CAPITULOS[url.pathname.split('/').at(-1) ?? '']
    if (url.pathname.startsWith('/serie/') && embed !== undefined) {
      return new Response(`<html><script>video[0] = '${embed}';</script></body>`)
    }

    return undefined
  })

  espia = montado
  return montado
}

afterEach(() => {
  espia?.restaurar()
  espia = undefined
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
})

describe('el camino público sigue entero', () => {
  test('devuelve el manifiesto con el `Referer` del embed', async () => {
    const { fetch } = montar()
    const fuentes = await proveedor.resolveStream(
      { episodeRef: ref('serie/x/temporada/1/capitulo/4'), mode: 'sub' },
      opcionesDePrueba(fetch),
    )

    expect(fuentes[0]?.url).toBe(M3U8)
    expect(fuentes[0]?.kind).toBe('hls')
    expect(fuentes[0]?.headers?.Referer).toBe('https://cdn.example/embed')
  })
})

describe('el cuerpo tiene tope', () => {
  test('un cuerpo de 9 MiB se corta', async () => {
    const { fetch } = montar()

    await expect(
      proveedor.getAnime(ref('pelicula/grande'), opcionesDePrueba(fetch)),
    ).rejects.toThrow('se corta')
  })

  test('lo que declare `content-length` por encima del tope no se lee', async () => {
    const { fetch } = montar()

    await expect(
      proveedor.getAnime(ref('pelicula/declarado'), opcionesDePrueba(fetch)),
    ).rejects.toThrow('declara')
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

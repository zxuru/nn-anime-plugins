/**
 * Proveedor de PelisPlusHD (pelisplushd.bz): películas, series y doramas.
 *
 * El sitio no tiene API JSON: la búsqueda, la ficha y la lista de capítulos son
 * HTML, y el enlace de video está detrás de una cadena de tres cerrojos. Este
 * archivo hace las cuatro cosas **sin ejecutar JavaScript del sitio**: el
 * empaquetador `eval(function(p,a,c,k,e,d){…})` se interpreta, no se evalúa.
 *
 * De dónde sale cada decisión: el estudio `docs/estudio-busqueda-ani-cli-mx.md`
 * del repositorio de la aplicación, que lee el `ani-cli-mx-core` línea a línea.
 * Lo que aquí es una hipótesis —el marcado exacto de las tarjetas de búsqueda y
 * de la lista de capítulos— está marcado como tal, porque el estudio se hizo sin
 * una sola petición de red.
 *
 * Lo que este plugin **no** hace: no guarda credenciales, no descarga ni aloja
 * contenido, y no toca ningún archivo de la máquina de quien lo copia.
 */

import { createDecipheriv, createHash } from 'node:crypto'
import type { CallOptions, Provider, ProviderResponse } from '@nn-anime/provider-sdk'

/*
 * Los tipos del dominio, nombrados aquí y no importados de `@nn-anime/core`.
 *
 * El SDK no reexporta la superficie del dominio —el contrato la comprueba por
 * estructura—, así que un plugin que vive fuera del repositorio no puede
 * importarla. Se derivan de los mismos schemas que validan las respuestas.
 */
type Acierto = ProviderResponse<'search'>[number]
type Ficha = ProviderResponse<'getAnime'>
type Episodio = ProviderResponse<'getEpisodes'>[number]
type Fuente = ProviderResponse<'resolveStream'>[number]
type PeticionStream = Parameters<Provider['resolveStream']>[0]
type Referencia = PeticionStream['episodeRef']

const ID = 'pelisplushd'

/**
 * La dirección del sitio, con su puerta trasera.
 *
 * Estos dominios se caen y renacen con otro sufijo cada pocos meses, así que la
 * constante es el valor de hoy y la variable de entorno existe para repuntarla
 * sin editar el archivo. Se valida: una dirección que no sea http(s) no vale
 * como base y se ignora, en vez de construir rutas contra cualquier cosa.
 */
const BASE_POR_DEFECTO = 'https://pelisplushd.bz'
const VARIABLE_DE_ENTORNO = 'NN_ANIME_PELISPLUS_URL'

/** El sitio devuelve 403 sin referrer: no es una cabecera opcional. */
const AGENTE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0'

/** Lo que se usa si el llamante no sugiere nada. */
const TIMEOUT_POR_DEFECTO_MS = 8000

/**
 * El plazo del resolutor, que es más largo que el de una búsqueda.
 *
 * Resolver un enlace son hasta seis peticiones encadenadas —página, embed,
 * espejo, manifiesto— y el `timeoutMs` del contrato es una **sugerencia**: la
 * ruta de stream no impone ninguna carrera, así que acortar aquí sólo sirve para
 * fallar en un sitio que sí funciona. Cada petición lleva su propio plazo, que es
 * lo que evita que una colgada se lleve por delante a las demás.
 */
const TIMEOUT_RESOLUTOR_MS = 20_000

/** Intentos de la prueba de trabajo. El mismo tope que usa `ani-cli-mx-core`. */
const POW_LIMITE = 200_000

/** El alfabeto de los índices del empaquetador, en el orden en que los lee. */
const DIGITOS = '0123456789abcdefghijklmnopqrstuvwxyz'

const ENTIDADES: Readonly<Record<string, string>> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  times: '×',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  uuml: 'ü',
  ntilde: 'ñ',
  iquest: '¿',
  iexcl: '¡',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
}

/* ------------------------------------------------------------------ la base */

function base(): string {
  const entorno = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env
  const declarada = entorno?.[VARIABLE_DE_ENTORNO]?.trim()
  if (declarada === undefined || declarada === '') return BASE_POR_DEFECTO

  try {
    const url = new URL(declarada)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return BASE_POR_DEFECTO

    return declarada.replace(/\/+$/, '')
  } catch {
    // Una dirección mal escrita no puede dejar el plugin apuntando a la nada:
    // se ignora y se sigue con la de fábrica.
    return BASE_POR_DEFECTO
  }
}

/* --------------------------------------------------------------- texto y HTML */

/** Une la cancelación del motor con el plazo de esta petición. */
function senalDe(opciones: CallOptions, ms: number): AbortSignal {
  const plazo = AbortSignal.timeout(ms > 0 ? ms : TIMEOUT_POR_DEFECTO_MS)
  const unir = (AbortSignal as unknown as { any?: (senales: AbortSignal[]) => AbortSignal }).any

  return typeof unir === 'function' ? unir([opciones.signal, plazo]) : plazo
}

interface ExtraDePeticion {
  readonly metodo?: string
  readonly referer?: string
}

/** Lo que se le dice a quien se encuentre un dominio caído, que es lo normal aquí. */
const SUGERENCIA = `si el sitio se mudó, apunta el dominio nuevo en ${VARIABLE_DE_ENTORNO}`

/**
 * Una petición al sitio que falla con el estado y la ruta, no con un `fetch` roto.
 *
 * Dos guardas que no son adorno, porque este sitio se cae y se muda:
 *
 * 1. **Un error de red se cuenta con la dirección delante.** Un «The operation
 *    timed out» a secas no dice a quién se le pidió ni qué hacer; el mensaje
 *    nombra la base y la variable de entorno que la cambia.
 * 2. **Si una página del propio sitio acaba en otro host, se dice.** Es lo que
 *    hacen los dominios retirados y las páginas de aparcamiento: contestan 200 y
 *    redirigen. Sin esa comprobación, la búsqueda devuelve cero fichas y el
 *    síntoma es «no encuentra nada», que es justo lo que no se puede depurar.
 *    Sólo se mira en las peticiones al sitio: los espejos de video redirigen a
 *    otro host por diseño y eso es legítimo.
 */
async function pedir(
  url: string,
  opciones: CallOptions,
  extra: ExtraDePeticion = {},
  ms = TIMEOUT_POR_DEFECTO_MS,
): Promise<Response> {
  let respuesta: Response
  try {
    respuesta = await fetch(url, {
      method: extra.metodo ?? 'GET',
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'es-ES,es;q=0.9',
        'user-agent': AGENTE,
        referer: extra.referer ?? `${base()}/`,
      },
      signal: senalDe(opciones, ms),
    })
  } catch (causa) {
    // La cancelación del usuario no es un dominio caído: se deja pasar tal cual.
    if (causa instanceof Error && causa.name === 'AbortError') throw causa

    const motivo = causa instanceof Error ? causa.message : String(causa)
    throw new Error(`no se pudo contactar con ${url}: ${motivo}; ${SUGERENCIA}`)
  }

  // El host se mira antes que el estado: una página de retirada puede contestar
  // 404 en su destino, y lo que hay que contarle a quien lo sufre es que el
  // dominio ya no es el sitio, no el 404 de una dirección que él no pidió.
  verificarMismoHost(url, respuesta)
  if (!respuesta.ok) throw new Error(`PelisPlusHD respondió ${respuesta.status} en ${url}`)

  return respuesta
}

/** Que una página del sitio siga en el sitio, y no en la de quien lo retiró. */
function verificarMismoHost(url: string, respuesta: Response): void {
  let pedido: URL
  let servido: URL
  try {
    pedido = new URL(url)
    servido = new URL(respuesta.url)
  } catch {
    return
  }

  if (pedido.host !== new URL(base()).host) return
  if (servido.host === pedido.host) return

  throw new Error(
    `${pedido.host} ya no sirve el sitio: redirige a ${servido.host}; ${SUGERENCIA}`,
  )
}

/** Texto de un HTML: entidades resueltas y espacios colapsados. */
function limpio(valor: string): string {
  return valor
    .replace(/&#x([0-9a-f]+);/gi, (_todo, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_todo, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (todo, nombre: string) => ENTIDADES[nombre.toLowerCase()] ?? todo)
    .replace(/\s+/g, ' ')
    .trim()
}

/** El valor de un atributo, en cualquier punto del bloque, sin comillas dobles. */
function atributo(bloque: string, nombre: string): string | undefined {
  const encontrado = new RegExp(`${nombre}\\s*=\\s*"([^"]*)"`, 'i').exec(bloque)?.[1]
  if (encontrado === undefined) return undefined

  const valor = limpio(encontrado)
  return valor === '' ? undefined : valor
}

/** Una dirección del sitio sólo se acepta si es http o https con host. */
function comoUrl(valor: string | undefined): string | undefined {
  if (valor === undefined) return undefined

  const absoluta = valor.startsWith('//') ? `https:${valor}` : valor
  const conBase = absoluta.startsWith('/') ? `${base()}${absoluta}` : absoluta

  try {
    const url = new URL(conBase)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/** El año en un texto, si lo lleva: sin él la fila de temporadas se ordena por título. */
function anioEn(valor: string | undefined): number | undefined {
  if (valor === undefined) return undefined

  const encontrado = /\b(19\d{2}|20\d{2})\b/.exec(valor)?.[1]
  const numero = Number(encontrado)

  return Number.isInteger(numero) && numero > 1900 ? numero : undefined
}

/* ------------------------------------------------------------------ búsqueda */

/** Una fila del buscador, ya con el tipo deducido de la ruta del enlace. */
interface Fila {
  readonly kind: 'movie' | 'tv'
  readonly slug: string
  readonly title: string
  readonly year?: number
  readonly coverUrl?: string
}

/**
 * Las fichas del listado de resultados.
 *
 * El sitio envuelve cada resultado en un `<a href>` con la ruta del título, el
 * título largo en `data-title` y la portada en un `img` perezoso. Se corta por
 * cada `<a ` y se lee su contenido hasta el cierre, en vez de recorrer el
 * documento con una expresión regular que se lleve por delante dos fichas.
 *
 * **Hipótesis**: el marcado exacto sale de las expresiones de `ani-cli-mx-core`
 * (`:3046-3055`), que sí se leen el HTML real. Si un día devuelve cero filas,
 * `search` lo dice en vez de contestar que no hay nada.
 */
function filasDe(html: string): readonly Fila[] {
  const salida: Fila[] = []
  const vistos = new Set<string>()

  for (const trozo of html.split(/<a\s/i).slice(1)) {
    const cierre = trozo.indexOf('</a>')
    const ancla = cierre < 0 ? trozo : trozo.slice(0, cierre)

    const href = atributo(ancla, 'href')
    if (href === undefined) continue

    const ruta = /(?:^|\/)(pelicula|serie)\/([^"'?#/]+)/.exec(href)
    if (ruta === null) continue

    const slug = ruta[2] ?? ''
    const tipo = ruta[1] === 'pelicula' ? 'movie' : 'tv'
    const clave = `${tipo}/${slug}`
    if (slug === '' || vistos.has(clave)) continue

    const declarado = /^VER\s+(.*?)\s+Online Gratis HD$/i.exec(atributo(ancla, 'data-title') ?? '')
    const titulo = declarado?.[1] ?? slug.replace(/-/g, ' ')
    if (titulo === '') continue

    vistos.add(clave)
    const portada = comoUrl(atributo(ancla, 'data-src') ?? atributo(ancla, 'src'))
    const anio = anioEn(declarado?.[1]) ?? anioEn(/\b(?:19\d{2}|20\d{2})\b/.exec(limpio(ancla))?.[0])

    salida.push({
      kind: tipo,
      slug,
      title: titulo,
      ...(anio === undefined ? {} : { year: anio }),
      ...(portada === undefined ? {} : { coverUrl: portada }),
    })
  }

  return salida
}

/* -------------------------------------------------------------------- ficha */

function esPelicula(valor: string): boolean {
  return valor.startsWith('pelicula/')
}

/** El tipo que el contrato entiende: aquí no hay dorama, un dorama es una serie. */
function tipoDelContrato(valor: string): 'movie' | 'tv' {
  return esPelicula(valor) ? 'movie' : 'tv'
}

/** El `slug` de una referencia: `serie/lo-que-sea/temporada/2` da `lo-que-sea`. */
function slugDe(valor: string): string {
  return valor.split('/')[1] ?? valor
}

/**
 * Los capítulos de una serie, tal como los publica su página.
 *
 * El sitio enlaza cada capítulo como `/serie/<slug>/temporada/<N>/capitulo/<M>`,
 * que es exactamente lo que busca `ani-cli-mx-core` para construir su lista
 * (`:3398-3403`). Se devuelve el par temporada/capítulo, sin inventar nada: si la
 * página no lista ningún capítulo, la lista sale vacía y quien llama decide.
 */
function capitulosDe(html: string, slug: string): readonly { season: number; chapter: number }[] {
  const patron = new RegExp(`/serie/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/temporada/(\\d+)/capitulo/(\\d+)`, 'g')
  const vistos = new Set<string>()
  const salida: { season: number; chapter: number }[] = []

  for (const encontrado of html.matchAll(patron)) {
    const temporada = Number(encontrado[1])
    const capitulo = Number(encontrado[2])
    if (!Number.isInteger(temporada) || !Number.isInteger(capitulo)) continue

    const clave = `${temporada}:${capitulo}`
    if (vistos.has(clave)) continue

    vistos.add(clave)
    salida.push({ season: temporada, chapter: capitulo })
  }

  return salida.sort((a, b) => a.season - b.season || a.chapter - b.chapter)
}

/** Los géneros, que el sitio enlaza como `/genero/<slug>`. */
function generosDe(html: string): readonly string[] {
  const vistos = new Set<string>()
  const salida: string[] = []

  for (const encontrado of html.matchAll(/\/genero\/([a-z0-9-]+)/gi)) {
    const slug = encontrado[1] ?? ''
    if (slug === '' || vistos.has(slug)) continue

    vistos.add(slug)
    const palabras = slug.replace(/-/g, ' ')
    salida.push(palabras.charAt(0).toUpperCase() + palabras.slice(1))
  }

  return salida
}

/* ------------------------------------------------------- enlaces de video */

function sha256Hex(texto: string): string {
  return createHash('sha256').update(texto).digest('hex')
}

/**
 * La prueba de trabajo: el nonce decimal más pequeño cuyo `sha256(challenge+nonce)`
 * empieza por `difficulty` ceros **hexadecimales**.
 *
 * Es la misma cuenta que hace `ani-cli-mx-core:2528-2553`. En JavaScript son unas
 * décimas de segundo para 200 000 intentos, así que se hace aquí mismo en vez de
 * repartirlo en trozos: un plugin no tiene a quién ceder el turno.
 */
function resolverPow(challenge: string, difficulty: number): number | undefined {
  const prefijo = '0'.repeat(difficulty)

  for (let nonce = 0; nonce <= POW_LIMITE; nonce += 1) {
    if (sha256Hex(`${challenge}${nonce}`).startsWith(prefijo)) return nonce
  }

  return undefined
}

/**
 * El enlace del espejo, descifrado.
 *
 * El criptograma viene en base64: los 16 primeros bytes son el IV y el resto el
 * cuerpo. La clave es un SHA-256, en bytes, de `challenge ‖ nonce ‖ salt`
 * (`ani-cli-mx-core:2557-2578`). El resultado es la URL del espejo, que tiene que
 * empezar por http; cualquier otra cosa es un descifrado que salió mal y se trata
 * como tal.
 */
function descifrar(
  cifrado: string,
  challenge: string,
  nonce: number,
  salt: string,
): string | undefined {
  let crudo: Buffer
  try {
    crudo = Buffer.from(cifrado.replace(/\\\//g, '/'), 'base64')
  } catch {
    return undefined
  }

  if (crudo.length <= 16) return undefined

  try {
    const iv = crudo.subarray(0, 16)
    const cuerpo = crudo.subarray(16)
    const clave = createHash('sha256').update(`${challenge}${nonce}${salt}`).digest()
    const descifrador = createDecipheriv('aes-256-cbc', clave, iv)
    const salida = Buffer.concat([descifrador.update(cuerpo), descifrador.final()])
      .toString('utf8')
      .replace(/[\r\n]/g, '')

    return /^https?:\/\//.test(salida) ? salida : undefined
  } catch {
    // Un relleno que no cuadra no es una excepción que deba salir del plugin: es
    // un espejo que no sirve y se prueba el siguiente.
    return undefined
  }
}

interface Idioma {
  readonly etiqueta: string
  readonly bloque: string
}

/**
 * El bloque de un idioma del embed.
 *
 * El embed trae un objeto por idioma —`LAT`, `ESP`, `SUB`— con su `file_id` y sus
 * espejos. Se pide el que corresponde al modo (`dub` quiere audio latino o
 * castellano; `sub` quiere subtitulado) y, si no está, se prueba el respaldo. Si
 * tampoco, devuelve `undefined` y el resolutor lo dice.
 */
function idiomaDe(embed: string, modo: string): Idioma | undefined {
  const disponibles = new Set(
    [...embed.matchAll(/"video_language":"([A-Z]+)"/g)].map((encontrado) => encontrado[1] ?? ''),
  )
  const orden =
    modo === 'dub' ? ['LAT', 'ESP', 'SUB'] : ['SUB', 'LAT', 'ESP']
  const plano = embed.replaceAll('\n', '')

  for (const etiqueta of orden) {
    if (!disponibles.has(etiqueta)) continue

    // El objeto del idioma se localiza por su marca: el embed mete todos los
    // idiomas seguidos y hay que quedarse con el trozo de uno solo.
    const trozos = plano.split('{"file_id":')
    const bloque = trozos.find((trozo) => trozo.includes(`"video_language":"${etiqueta}"`))
    if (bloque !== undefined) return { etiqueta, bloque }
  }

  return undefined
}

/** El enlace cifrado de un espejo dentro del bloque de un idioma. */
function enlaceDelEspejo(bloque: string, espejo: string): string | undefined {
  const lista = /"sortedEmbeds":\[([^\]]*)\]/.exec(bloque)?.[1]
  if (lista === undefined) return undefined

  for (const entrada of lista.split('},{')) {
    if (!entrada.includes(`"servername":"${espejo}"`)) continue

    const enlace = /"link":"([^"]+)"/.exec(entrada)?.[1]
    if (enlace !== undefined) return enlace
  }

  return undefined
}

/**
 * El desempaquetador de `eval(function(p,a,c,k,e,d){…})`, sin evaluarlo.
 *
 * Es el clásico de Dean Edwards: un cuerpo con tokens, el alfabeto en base `a` y
 * un diccionario separado por `|`. Se interpreta aquí igual que en
 * `ani-cli-mx-core:2632-2691`: se busca el `}('`, se leen `',<radix>,<count>,'`, se
 * parte el diccionario por `'.split('|')` y se sustituye cada token por la entrada
 * que le corresponde. Un token fuera de rango se deja tal cual.
 */
function desempaquetar(html: string): string | undefined {
  const marca = html.indexOf("}('")
  if (marca < 0) return undefined

  const resto = html.slice(marca + 3)
  const meta = /',(\d+),(\d+),'/.exec(resto)
  if (meta === null || meta.index === undefined) return undefined

  const radix = Number(meta[1])
  const count = Number(meta[2])
  if (!Number.isInteger(radix) || radix < 2 || !Number.isInteger(count)) return undefined

  const cuerpo = resto.slice(0, meta.index)
  const cola = resto.slice(meta.index + meta[0].length)
  const fin = cola.indexOf("'.split('|')")
  if (fin < 0) return undefined

  const diccionario = cola.slice(0, fin).split('|')
  let salida = ''
  let token = ''

  for (let indice = 0; indice <= cuerpo.length; indice += 1) {
    const caracter = cuerpo[indice] ?? ''

    if (/[0-9a-zA-Z]/.test(caracter)) {
      token += caracter
      continue
    }

    if (token !== '') {
      let valor = 0
      let valido = true
      for (const digito of token) {
        const posicion = DIGITOS.indexOf(digito.toLowerCase())
        if (posicion < 0 || posicion >= radix) {
          valido = false
          break
        }

        valor = valor * radix + posicion
      }

      const palabra = valido ? (diccionario[valor] ?? '') : ''
      salida += valido && valor < count && palabra !== '' ? palabra : token
      token = ''
    }

    salida += caracter
  }

  return salida.replace(/\\'/g, "'").replace(/\\\\/g, '\\')
}

/** La primera dirección reproducible del texto: un manifiesto manda sobre un archivo. */
function primerMedio(texto: string): { url: string; kind: 'hls' | 'file' } | undefined {
  const hls = /https?:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/.exec(texto)?.[0]
  if (hls !== undefined) return { url: hls, kind: 'hls' }

  const archivo = /https?:\/\/[^"'\s<>\\]+\.(?:mp4|mkv|webm)[^"'\s<>\\]*/.exec(texto)?.[0]
  if (archivo !== undefined) return { url: archivo, kind: 'file' }

  return undefined
}

/**
 * El reproductor de la página del episodio.
 *
 * La asignación es `video[N] = '<algo>'`, y ese algo puede ser la dirección pelada
 * o el `<iframe>` entero: aquí se aceptan las dos formas, igual que hace el plugin
 * de jkanime con sus reproductores. Se prefiere la que apunta a la plataforma de
 * embeds —lo que exige `ani-cli-mx-core:2742`— y sólo si no hay ninguna se cae a la
 * primera dirección: un iframe que no es el bueno es mejor que decir que la página
 * no tiene reproductor sin haberla mirado entera.
 */
function reproductorDe(pagina: string): string | undefined {
  const valores = [...pagina.matchAll(/video\[\d+\]\s*=\s*'([^']*)'/gi)].map((uno) => uno[1] ?? '')
  const direcciones = valores
    .map((valor) => (/src\s*=\s*"([^"]+)"/i.exec(valor)?.[1] ?? valor).trim())
    .filter((valor) => /^https?:\/\//i.test(valor))

  return direcciones.find((url) => url.includes('embed69')) ?? direcciones[0]
}

/**
 * El enlace del espejo ya descifrado.
 *
 * Se pide con el referrer del embed y **siguiendo redirecciones**: la dirección
 * final es la que hay que mandar como referrer del manifiesto, porque el espejo
 * comprueba de dónde viene la petición y no a dónde apuntaba el enlace
 * (`ani-cli-mx-core:2693-2709`). El cuerpo trae el empaquetador; si no lo trae, se
 * busca el `.m3u8` directamente, que es lo que hace un espejo que ya no empaqueta.
 */
async function medioDelEspejo(
  url: string,
  referer: string,
  opciones: CallOptions,
): Promise<{ fuente: Fuente; refererFinal: string } | undefined> {
  const respuesta = await pedir(url, opciones, { referer }, TIMEOUT_RESOLUTOR_MS)
  const html = await respuesta.text()
  const cuerpo = desempaquetar(html) ?? html
  const medio = primerMedio(cuerpo)
  if (medio === undefined) return undefined

  return {
    fuente: {
      url: medio.url,
      kind: medio.kind,
      // El proxy reenvía esta cabecera al upstream y no la deja llegar al
      // navegador: es la forma de que el `Referer` obligatorio no se filtre.
      headers: { Referer: respuesta.url === '' ? referer : respuesta.url },
    },
    refererFinal: respuesta.url === '' ? referer : respuesta.url,
  }
}

/* ------------------------------------------------------------------ proveedor */

const proveedor: Provider = {
  id: ID,
  name: 'PelisPlusHD',
  apiVersion: '1',
  /*
   * Películas y series, en español latino y castellano. Sin `trending` ni `feed`:
   * el sitio tiene portada de novedades, pero no se ha estudiado su marcado y
   * declarar una capacidad que no está probada ofrece un botón que no lleva a
   * ninguna parte.
   */
  capabilities: { search: true, sub: true, dub: true, trending: false, feed: false },

  /**
   * La búsqueda es una sola petición: el tipo ya viene en la ruta de cada enlace.
   *
   * `ani-cli-mx` necesita saber el tipo **antes** de buscar y gasta hasta tres
   * peticiones más por cada serie para distinguir un dorama de una serie
   * (`ani-cli-mx-core:3030-3068`). Aquí no hace falta: el dorama es una serie más
   * y el tipo viaja en el resultado.
   */
  async search(query, opciones) {
    const url = `${base()}/search?${new URLSearchParams({ s: query }).toString()}`
    const html = await (await pedir(url, opciones)).text()
    const filas = filasDe(html)

    // Cero filas con el buscador delante no es «no hay nada»: es un cambio de
    // marcado, y decirlo es la diferencia entre un plugin que se arregla y uno
    // que parece vacío para siempre.
    if (filas.length === 0 && /name="s"|<form[^>]*search/i.test(html)) {
      throw new Error('PelisPlusHD no devolvió ninguna ficha; el marcado del buscador cambió')
    }

    return filas.map((fila): Acierto => ({
      ref: { providerId: ID, value: `${fila.kind === 'movie' ? 'pelicula' : 'serie'}/${fila.slug}` },
      title: fila.title,
      kind: fila.kind,
      ...(fila.coverUrl === undefined ? {} : { coverUrl: fila.coverUrl }),
      ...(fila.year === undefined ? {} : { year: fila.year }),
    }))
  },

  /**
   * La ficha del título y, de paso, cuántos capítulos declara.
   *
   * El tipo sale de la referencia y no de la página: es el dato que el plugin ya
   * tenía al buscar, y volver a deducirlo en la ficha es donde se pierde.
   */
  async getAnime(ref, opciones): Promise<Ficha> {
    const html = await (await pedir(`${base()}/${ref.value}`, opciones)).text()

    const titulo =
      /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i.exec(html)?.[1] ??
      /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]
    const limpioTitulo = titulo === undefined ? '' : limpio(titulo.replace(/<[^>]*>/g, ''))
    if (limpioTitulo === '') throw new Error(`la ficha de ${ref.value} no trae título`)

    const portada = comoUrl(
      /<meta[^>]+property="og:image"[^>]+content="([^"]*)"/i.exec(html)?.[1],
    )
    const sinopsis = limpio(
      /<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i.exec(html)?.[1] ?? '',
    )
    const anio = anioEn(/\/(?:year|anio|año)\/(\d{4})/i.exec(html)?.[1]) ?? anioEn(limpioTitulo)
    const capitulos = esPelicula(ref.value) ? [] : capitulosDe(html, slugDe(ref.value))

    return {
      ref,
      title: limpioTitulo,
      kind: tipoDelContrato(ref.value),
      ...(portada === undefined ? {} : { coverUrl: portada }),
      ...(sinopsis === '' ? {} : { synopsis: sinopsis }),
      ...(anio === undefined ? {} : { year: anio }),
      ...(capitulos.length === 0 ? {} : { episodeCount: capitulos.length }),
      genres: [...generosDe(html)],
      // El sitio no publica estudios en ninguna de sus páginas.
      studios: [],
    }
  },

  /**
   * Los capítulos de una serie, y el único «episodio» de una película.
   *
   * Una película se reproduce sin lista: el contrato exige un `episodeRef` para
   * pedir un stream (`packages/core/src/schema.ts`), así que se le da un episodio
   * con número 1, que es lo que ya hace el proveedor de ejemplo.
   *
   * La numeración de una serie es **corrida** entre temporadas y el par
   * temporada/capítulo va en el título, porque `Episode` no tiene campo de
   * temporada y el número se usa como identidad de la fila: dos temporadas con un
   * «capítulo 1» cada una serían el mismo episodio para la interfaz.
   */
  async getEpisodes(ref, opciones): Promise<readonly Episodio[]> {
    if (esPelicula(ref.value)) {
      return [{ ref: { providerId: ID, value: ref.value }, animeRef: ref, number: 1, mode: 'sub' }]
    }

    const html = await (await pedir(`${base()}/${ref.value}`, opciones)).text()
    const capitulos = capitulosDe(html, slugDe(ref.value))
    if (capitulos.length === 0) {
      throw new Error(
        `PelisPlusHD no listó ningún capítulo de ${ref.value}; la página cambió o el título no existe`,
      )
    }

    return capitulos.map((capitulo, indice): Episodio => ({
      ref: {
        providerId: ID,
        value: `${ref.value}/temporada/${capitulo.season}/capitulo/${capitulo.chapter}`,
      },
      animeRef: ref,
      number: indice + 1,
      title: `T${capitulo.season} E${capitulo.chapter}`,
      mode: 'sub',
    }))
  },

  /**
   * El enlace de video, que es donde está todo el trabajo del sitio.
   *
   * La cadena, en orden: página del episodio → embed → (atajo de Vidhide o
   * prueba de trabajo + descifrado) → espejo empaquetado → manifiesto. Cada paso
   * se cae solo: si el atajo no está, se hace la prueba; si un espejo no da
   * enlace, se prueba el siguiente; y el motivo del último fallo se cuenta en el
   * mensaje, porque «no dio fuente» a secas no se puede arreglar desde fuera.
   */
  async resolveStream(peticion, opciones): Promise<readonly Fuente[]> {
    const url = `${base()}/${peticion.episodeRef.value}`
    const pagina = await (await pedir(url, opciones)).text()

    const embed = reproductorDe(pagina)
    if (embed === undefined) {
      throw new Error(`la página de ${peticion.episodeRef.value} no trae ningún reproductor`)
    }

    const embedUrl = comoUrl(embed)
    if (embedUrl === undefined) throw new Error('el reproductor del sitio no es una dirección válida')

    const embedHtml = await (await pedir(embedUrl, opciones, { referer: url })).text()

    // Atajo: algunos episodios publican el host directamente, sin cerrojos.
    const directo = /playServerVast\('(https?:\/\/[^']*vidhide[^']*)'\)/i.exec(embedHtml)?.[1]
    if (directo !== undefined) {
      const conReferer = await medioDelEspejo(directo, embedUrl, opciones)
      if (conReferer !== undefined) return [conReferer.fuente]

      throw new Error('el host de Vidhide no publicó ningún archivo reproducible')
    }

    const challenge = /POW_CHALLENGE\s*=\s*'([^']+)'/i.exec(embedHtml)?.[1]
    const difficulty = Number(/POW_DIFFICULTY\s*=\s*(\d+)/i.exec(embedHtml)?.[1])
    const salt = /POW_SALT\s*=\s*'([^']+)'/i.exec(embedHtml)?.[1]
    if (challenge === undefined || salt === undefined || !Number.isInteger(difficulty)) {
      throw new Error('el embed no trae la prueba de trabajo ni un enlace directo; el sitio cambió')
    }

    const nonce = resolverPow(challenge, difficulty)
    if (nonce === undefined) {
      throw new Error(
        `la prueba de trabajo de PelisPlusHD no se resolvió en ${POW_LIMITE} intentos de ${difficulty} ceros`,
      )
    }

    const idioma = idiomaDe(embedHtml, peticion.mode)
    if (idioma === undefined) throw new Error('el embed no publica ningún idioma utilizable')

    // El espejo que suele servir primero depende del idioma, y el estudio lo deja
    // escrito: subtitulado va mejor por Streamwish y el audio por Vidhide.
    const espejos = idioma.etiqueta === 'SUB' ? ['streamwish', 'vidhide'] : ['vidhide', 'streamwish']
    const fallos: string[] = []

    for (const espejo of espejos) {
      try {
        const cifrado = enlaceDelEspejo(idioma.bloque, espejo)
        if (cifrado === undefined) {
          fallos.push(`${espejo}: sin enlace en el embed`)
          continue
        }

        const descifrado = descifrar(cifrado, challenge, nonce, salt)
        if (descifrado === undefined) {
          fallos.push(`${espejo}: el enlace no se pudo descifrar`)
          continue
        }

        const medio = await medioDelEspejo(descifrado, embedUrl, opciones)
        if (medio === undefined) {
          fallos.push(`${espejo}: el espejo no publicó ningún archivo`)
          continue
        }

        return [
          {
            ...medio.fuente,
            headers: { ...(medio.fuente.headers ?? {}), Referer: medio.refererFinal },
          },
        ]
      } catch (causa) {
        // Un espejo caído no puede dejar el episodio sin el otro, pero su motivo
        // se guarda: cuando no queda ninguno, es lo único que explica qué pasó.
        fallos.push(`${espejo}: ${causa instanceof Error ? causa.message : String(causa)}`)
      }
    }

    throw new Error(
      `PelisPlusHD no dio ninguna fuente para ${peticion.episodeRef.value} (${idioma.etiqueta}: ${fallos.join('; ')})`,
    )
  },
}

export default proveedor

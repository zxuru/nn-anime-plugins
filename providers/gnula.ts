/**
 * Proveedor de Gnula (www2.gnula.one): películas en español latino.
 *
 * Gnula es un WordPress de toda la vida, y eso aquí es una ventaja: la búsqueda
 * es un `?s=`, la ficha llega pintada en el HTML y los reproductores están en
 * `<iframe>`, cada uno con la etiqueta del audio que lleva. No hay API, ni
 * JavaScript que interpretar, ni nada que ejecutar del sitio.
 *
 * La parte interesante es cómo publica los idiomas. La página de una película
 * agrupa sus reproductores por **opción**, y cada grupo lleva delante su etiqueta
 * —`opción 1, Latino, HD`, `opción 2, Castellano, HD`, `opción 3, Subtitulado,
 * HD`— antes de la lista de `<iframe>` que le corresponden. Eso es exactamente lo
 * que el contrato llama `mode`: aquí no hay que adivinar si un enlace es latino o
 * subtitulado, porque el sitio lo dice. El plugin respeta ese orden según lo que
 * pida quien llama: audio latino primero para `dub`, subtitulado primero para
 * `sub`, y el resto como respaldo.
 *
 * Lo que este plugin **no** hace: no guarda credenciales, no descarga ni aloja
 * contenido, no ejecuta JavaScript del sitio y no toca ningún archivo de la
 * máquina de quien lo copia.
 *
 * Medido en vivo contra el sitio y contra sus reproductores; en `REPRODUCTORES`
 * está dicho, uno por uno, cuál se resuelve y cuál no, porque un reproductor que
 * se anuncia y no da enlace es peor que uno que no está.
 */

import { createDecipheriv } from 'node:crypto'
import type { CallOptions, PluginFetch, PluginResponse, Provider, ProviderResponse } from '@nn-anime/provider-sdk'

/*
 * Los tipos del dominio, nombrados aquí y no importados de `@nn-anime/core`: el
 * SDK no reexporta la superficie del dominio, así que un plugin que vive fuera
 * del repositorio los deriva de los mismos schemas que validan las respuestas.
 */
type Acierto = ProviderResponse<'search'>[number]
type Ficha = ProviderResponse<'getAnime'>
type Episodio = ProviderResponse<'getEpisodes'>[number]
type Fuente = ProviderResponse<'resolveStream'>[number]

const ID = 'gnula'

/** La dirección del sitio, con su puerta trasera: estos dominios se mudan. */
const BASE_POR_DEFECTO = 'https://www2.gnula.one'
const VARIABLE_DE_ENTORNO = 'NN_ANIME_GNULA_URL'

const AGENTE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0'

/**
 * Los anfitriones que no son reproductores sino **selectores**, y que hay que
 * abrir para saber qué reproductores ofrecen.
 *
 * `links.cuevana.ac` publica una página con una pestaña por idioma y, dentro, un
 * botón por servidor; su dirección real viaja en un `go_to_player('…')`, no en el
 * `<iframe>` que enseñó Gnula. Los enlaces de descarga que también aparecen ahí
 * (1fichier, gofile, megaup…) **no** se tocan: no son streams y resolverlos sería
 * pedirle a un servidor de archivos algo que no da.
 */
const SELECTORES = /(?:^|\.)links\.cuevana\.ac$/i

const RUIDO = /(?:^|\.)(?:gnula\.one|facebook\.com|youtube\.com|youtu\.be|google\.com|twitter\.com|disqus\.com)$/i

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
    // Una dirección mal escrita no puede dejar el plugin apuntando a la nada.
    return BASE_POR_DEFECTO
  }
}

// ---------------------------------------------------------------------------
// Guardas de red, de credenciales y de tamaño
// ---------------------------------------------------------------------------

/**
 * Credenciales que viajan dentro de una dirección.
 *
 * El motor que carga este plugin redacta **por nombre de clave**, así que una
 * credencial metida dentro de una cadena no la ve nadie más que quien la escribe:
 * el testigo de un espejo o la firma de un manifiesto acabarían en el mensaje de
 * un fallo y de ahí a una captura de pantalla. Se quitan aquí, que es el único
 * sitio que construye ese texto.
 */
const CREDENCIAL_EN_URL = /([?&](?:api_key|apikey|key|token|expires|asn|signature|sig|hash|auth)=)[^&#\s]*/gi

function sinCredenciales(url: string): string {
  return url.replace(CREDENCIAL_EN_URL, '$1[redactado]')
}

/**
 * Destinos que un reproductor de internet no necesita y una página hostil sí.
 *
 * La dirección de la siguiente petición la elige el contenido del sitio —el
 * `<iframe>` de la ficha, el espejo al que apunta Voe, el botón del selector—,
 * así que sin esta guarda una página comprometida puede hacer que el plugin pida
 * `http://127.0.0.1:8080/…`, un servicio de la red de casa o la metadata de la
 * nube, desde la máquina de quien lo copia. El proxy del motor tiene su propia
 * comprobación de destinos, pero no cubre estas peticiones: el plugin no pasa por
 * él.
 *
 * Es una comprobación **literal**, aunque `new URL` normaliza las formas raras de
 * escribir una dirección (`127.1`, `2130706433`, `0x7f.1`) y por eso no se
 * escapan. Un nombre que resuelva a una dirección interna sí la esquiva: resolver
 * y fijar la dirección no está al alcance de un `fetch`, y por eso la guarda
 * completa vive en el motor, que resuelve y mira todas las respuestas del DNS.
 */
const HOST_INTERNO =
  /^(?:(?:[\w-]+\.)+(?:localhost|local|internal|home\.arpa)\.?|localhost\.?|0\.0\.0\.0|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})$/i

/**
 * Si un anfitrión es de la red interna.
 *
 * Un literal IPv6 se rechaza entero: no aparece en la dirección de un
 * reproductor, y las formas que envuelven una IPv4 —la mapeada `::ffff:7f00:1`,
 * la de NAT64, la de 6to4— son justo las que se escapan de una lista literal.
 */
function esHostInterno(hostname: string): boolean {
  return hostname.includes(':') || HOST_INTERNO.test(hostname)
}

/** Si el propio sitio configurado vive en la red interna. */
function baseEsInterna(): boolean {
  try {
    return esHostInterno(new URL(base()).hostname)
  } catch {
    return false
  }
}

/** Si la dirección la eligió el contenido del sitio, ¿se puede pedir? */
function destinoDeContenidoAceptable(url: string): boolean {
  let analizada: URL
  try {
    analizada = new URL(url)
  } catch {
    return false
  }

  if (analizada.protocol !== 'http:' && analizada.protocol !== 'https:') return false
  if (!esHostInterno(analizada.hostname)) return true

  // Apuntar el plugin a un sitio de prueba en la propia máquina es una forma
  // legítima de trabajar, y en ese caso la red interna *es* el sitio, no un
  // desvío. La guarda se relaja sólo entonces.
  return baseEsInterna()
}

/**
 * Una referencia del motor convertida en ruta.
 *
 * Las referencias llegan como cadenas opacas y lo que no puede llegar es un `..`
 * que mueva la petición a otra ruta del sitio ni un `?` o un `#` que le cambien la
 * consulta. `encodeURIComponent` solo no basta: los puntos no se codifican.
 */
function rutaDe(valor: string): string {
  const tramos = valor.split('/')
  if (/[?#\\\u0000-\u001f]/.test(valor) || tramos.some((tramo) => tramo === '.' || tramo === '..')) {
    throw new Error(`la referencia '${valor}' no es una ruta válida`)
  }

  return tramos.map((tramo) => encodeURIComponent(tramo)).join('/')
}

/**
 * Tope del cuerpo que el plugin **pide** a la capacidad, en bytes.
 *
 * El motor aplica el suyo por debajo y corta mientras llega; este es el que
 * declara el plugin para que el corte sea el de siempre. Un sitio hostil puede
 * contestar con gigabytes, y materializarlos en el proceso que sirve la
 * aplicación es justo lo que este número evita.
 */
const TOPE_CUERPO_BYTES = 8 * 1024 * 1024

/**
 * El texto de una respuesta, ya descomprimido y ya acotado por el motor.
 *
 * El tope lo aplica la capacidad —`maxBytes` en cada petición— y llega contado
 * en bytes, así que esta cuenta de caracteres es la **segunda** defensa y no la
 * única: si el motor dejara de cortar, el plugin sigue cortando por su cuenta.
 */
async function cuerpo(respuesta: PluginResponse): Promise<string> {
  if (respuesta.body.length > TOPE_CUERPO_BYTES) {
    throw new Error(`la respuesta pasa de ${TOPE_CUERPO_BYTES} caracteres y se corta`)
  }

  return respuesta.body
}

/* --------------------------------------------------------------- texto y HTML */

/**
 * La puerta a la red de esta llamada.
 *
 * Sale de `CallOptions.fetch`, la capacidad que el motor pone **siempre**: es la
 * que aplica la lista blanca de destinos, resuelve el nombre una vez, fija la
 * dirección a la que se conecta y acota el cuerpo. Antes esto era el `fetch`
 * global y el plazo lo ponía el plugin; ahora lo pone el motor, por petición.
 *
 * Falla cerrado si no está —un motor viejo, o una prueba que no la ponga— en vez
 * de caer al `fetch` global, que se saltaría la política de destinos: que un
 * plugin la use tiene que ser una decisión visible, no un descuido.
 */
function redDe(opciones: CallOptions): PluginFetch {
  const red = opciones.fetch
  if (red === undefined) {
    throw new Error('este motor no ofrece la capacidad de red; actualiza nn-anime')
  }

  return red
}

/** Un estado 2xx, que es lo que el `Response` de la API web llamaba `ok`. */
function esEstadoOk(respuesta: PluginResponse): boolean {
  return respuesta.status >= 200 && respuesta.status < 300
}

/** Lo que se le dice a quien se encuentre un dominio caído, que aquí es lo normal. */
const SUGERENCIA = `si el sitio se mudó, apunta el dominio nuevo en ${VARIABLE_DE_ENTORNO}`

/**
 * Una petición que falla con el estado y la dirección delante, no con un `fetch` roto.
 *
 * `referer` no se manda nunca por defecto: los reproductores de esta familia
 * rechazan la petición cuando viene con el `Referer` del sitio que los incrusta
 * («Video embed restricted for this domain» es literalmente lo que contesta
 * Uqload), y sólo quien sepa que un anfitrión concreto lo necesita debe pedirlo.
 */
async function pedir(
  url: string,
  opciones: CallOptions,
  extra: {
    readonly referer?: string
    readonly acepta?: string
    /** Un estado que no sea 2xx no siempre es un fallo: una API puede explicarlo en su cuerpo. */
    readonly tolerarEstado?: boolean
  } = {},
): Promise<PluginResponse> {
  let respuesta: PluginResponse
  try {
    respuesta = await redDe(opciones)(url, {
      headers: {
        accept: extra.acepta ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'es-MX,es;q=0.9',
        'user-agent': AGENTE,
        ...(extra.referer === undefined ? {} : { referer: extra.referer }),
      },
      maxBytes: TOPE_CUERPO_BYTES,
    })
  } catch (causa) {
    if (opciones.signal.aborted) throw causa

    const motivo = causa instanceof Error ? causa.message : String(causa)
    throw new Error(`no se pudo contactar con ${sinCredenciales(url)}: ${motivo}; ${SUGERENCIA}`)
  }

  if (!esEstadoOk(respuesta) && extra.tolerarEstado !== true) {
    throw new Error(
      `${new URL(url).host} respondió ${respuesta.status} en ${sinCredenciales(url)}`,
    )
  }

  return respuesta
}

/** Texto de un HTML: entidades resueltas, etiquetas fuera y espacios colapsados. */
function limpio(valor: string): string {
  return valor
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_todo, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_todo, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (todo, nombre: string) => ENTIDADES[nombre.toLowerCase()] ?? todo)
    .replace(/\s+/g, ' ')
    .trim()
}

/** El valor de un atributo, en cualquier punto del bloque. */
function atributo(bloque: string, nombre: string): string | undefined {
  const encontrado = new RegExp(`${nombre}\\s*=\\s*"([^"]*)"`, 'i').exec(bloque)?.[1]
  if (encontrado === undefined) return undefined

  const valor = limpio(encontrado)
  return valor === '' ? undefined : valor
}

/** Una dirección sólo se acepta si es http o https con host. */
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

/* ------------------------------------------------------------------ búsqueda */

/** Una fila del buscador, ya con el año y los géneros que publica la fila. */
interface Fila {
  readonly slug: string
  readonly title: string
  readonly year?: number
  readonly coverUrl?: string
  readonly genres: readonly string[]
}

/**
 * Las fichas del listado de resultados.
 *
 * Cada resultado es un `<a>` a la ficha del título con una portada dentro, y esa
 * portada lleva tres datos: el nombre en `alt`, y en `title` el nombre, el año y
 * los géneros con el formato que usa el tema —`Avatar (2009) [HD 1080p] - Acción,
 * Aventura, Ciencia ficción`—. En la ficha no hay géneros por ninguna parte, así
 * que este atributo es la única fuente que el sitio publica, y por eso `getAnime`
 * vuelve a pasar por aquí.
 */
function filasDe(html: string): readonly Fila[] {
  const salida: Fila[] = []
  const vistos = new Set<string>()

  for (const trozo of html.split(/<a\s/i).slice(1)) {
    const cierre = trozo.indexOf('</a>')
    const ancla = cierre < 0 ? trozo : trozo.slice(0, cierre)

    const href = atributo(ancla, 'href')
    if (href === undefined) continue

    const ruta = /\/movie\/([^"'?#/]+)\/?/.exec(href)
    const slug = ruta?.[1]
    if (slug === undefined || vistos.has(slug)) continue

    const imagen = /<img[^>]*>/i.exec(ancla)?.[0]
    if (imagen === undefined) continue

    const titulo = atributo(imagen, 'alt')
    if (titulo === undefined) continue

    vistos.add(slug)
    const declarado = atributo(imagen, 'title') ?? ''
    const anio = Number(/\(\s*(\d{4})\s*\)/.exec(declarado)?.[1])
    // Los géneros van después del **último** ` - `: el nombre del título también
    // puede llevar un guion («The King's Avatar: For the Glory» no, pero «Título -
    // Segunda parte» sí), y quedarse con el primer corte devolvería medio título
    // como si fuera un género.
    const partes = declarado.split(/\s+-\s+/)
    const generos = (partes.length > 1 ? (partes[partes.length - 1] ?? '') : '')
      .split(',')
      .map((genero) => genero.trim())
      .filter((genero) => genero !== '')
    const portada = comoUrl(atributo(imagen, 'data-lazyload') ?? atributo(imagen, 'src'))

    salida.push({
      slug,
      title: titulo,
      ...(Number.isInteger(anio) && anio > 1900 ? { year: anio } : {}),
      ...(portada === undefined ? {} : { coverUrl: portada }),
      genres: generos,
    })
  }

  return salida
}

/** El `slug` de una referencia: `movie/avatar` da `avatar`. */
function slugDe(valor: string): string {
  const trozos = valor.split('/').filter((trozo) => trozo !== '')
  const ultimo = trozos[trozos.length - 1] ?? ''

  return ultimo === 'movie' ? '' : ultimo
}

/* -------------------------------------------------------------------- ficha */

/**
 * La ficha de una película, leída de su propia página.
 *
 * El tema publica el título y el año en el `title` del enlace del encabezado
 * (`Ver Batman: El caballero de la noche asciende (2012)  online`) y, debajo de la
 * portada, una línea con el título, el título original, el año y la sinopsis,
 * separados por barras. Es lo único que da la página: no hay etiquetas `og:`, ni
 * reparto, ni estudios, ni géneros.
 */
interface Detalle {
  readonly title: string
  readonly titleAlt?: string
  readonly year?: number
  readonly coverUrl?: string
  readonly synopsis?: string
}

function detalleDe(html: string, slug: string): Detalle {
  const encabezado = /title="Ver\s+([\s\S]*?)\s*\(\s*(\d{4})\s*\)\s*online"/i.exec(html)
  const linea = /<p>\s*<strong>([\s\S]*?)<\/strong>\s*\|\s*<strong>([\s\S]*?)<\/strong>\s*\|\s*<strong>\s*(\d{4})\s*<\/strong>\s*\|([\s\S]*?)<\/p>/i.exec(
    html,
  )

  // Tres fuentes, de la más rica a la más pobre, y se toma la primera que traiga
  // algo: el encabezado y la línea de datos pueden existir y venir vacíos, y un
  // `??` no distingue «no está» de «está en blanco», que aquí es lo mismo.
  const crudo = [
    encabezado?.[1],
    linea?.[1],
    /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s*[–—-]\s*G\s*Nula\s*$/i, ''),
  ].map((valor) => (valor === undefined ? '' : limpio(valor)))

  const titulo = crudo.find((valor) => valor !== '') ?? ''
  if (titulo === '') throw new Error(`la ficha de ${slug} no trae título`)

  const original = linea?.[2] === undefined ? undefined : limpio(linea[2])
  const anio = Number(encabezado?.[2] ?? linea?.[3])
  const sinopsis = linea?.[4] === undefined ? undefined : limpio(linea[4])

  // La portada de la ficha es la que lleva «Poster de» en el `alt`, y no las
  // carátulas de la barra lateral, que son del mismo tamaño y del mismo sitio.
  const conAlt = [...html.matchAll(/<img[^>]*>/gi)]
    .map((encontrado) => encontrado[0])
    .find((imagen) => /alt\s*=\s*"Poster de /i.test(imagen))
  const portada = comoUrl(
    atributo(conAlt ?? '', 'src') ?? atributo(conAlt ?? '', 'data-lazyload'),
  )

  return {
    title: titulo,
    ...(original === undefined || original === titulo ? {} : { titleAlt: original }),
    ...(Number.isInteger(anio) && anio > 1900 ? { year: anio } : {}),
    ...(portada === undefined ? {} : { coverUrl: portada }),
    ...(sinopsis === undefined || sinopsis === '' ? {} : { synopsis: sinopsis }),
  }
}

/**
 * Los géneros, que sólo publica el listado.
 *
 * La ficha no los lleva: el tema los escribe en el `title` de cada fila del
 * listado, y ahí siguen. Se busca el título exacto y se acepta la fila **cuyo
 * `slug` coincide**, que es una comparación exacta y no un parecido: si el
 * buscador no devuelve esa ficha, el título se queda sin géneros y no se inventa
 * ninguno. Un fallo aquí no puede tumbar la ficha entera, así que se traga.
 */
async function generosDe(slug: string, titulo: string, opciones: CallOptions): Promise<readonly string[]> {
  try {
    const html = await cuerpo(
      await pedir(`${base()}/?${new URLSearchParams({ s: titulo }).toString()}`, opciones),
    )

    return filasDe(html).find((fila) => fila.slug === slug)?.genres ?? []
  } catch {
    return []
  }
}

/* ------------------------------------------------------- enlaces de video */

/**
 * El desempaquetador de `eval(function(p,a,c,k,e,d){…})`, sin evaluarlo.
 *
 * Es el clásico de Dean Edwards, el mismo que ya interpreta el proveedor de
 * PelisPlusHD: un cuerpo con tokens, el alfabeto en base `a` y un diccionario
 * separado por `|`. Se copia aquí en vez de importarlo de un archivo hermano para
 * que este plugin siga siendo **un solo archivo** que se puede copiar suelto, que
 * es como se instalan.
 */
const DIGITOS = '0123456789abcdefghijklmnopqrstuvwxyz'

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
 * Uqload: el reproductor que sí se resuelve.
 *
 * Su página trae el clásico empaquetador con la lista `sources` dentro, así que
 * basta con desempaquetarlo y leer la primera dirección. La petición va **sin
 * `Referer`**: con el del sitio que lo incrusta contesta «Video embed restricted
 * for this domain», y con el suyo propio también. El manifiesto que devuelve no
 * exige ninguna cabecera, así que la fuente viaja limpia.
 */
async function resolverUqload(url: string, opciones: CallOptions): Promise<Fuente | undefined> {
  const html = await cuerpo(await pedir(url, opciones))

  const desempaquetado = desempaquetar(html) ?? html
  const declarado = /sources\s*:\s*\[\s*\{\s*file\s*:\s*"([^"]+)"/i.exec(desempaquetado)?.[1]
  const medio =
    declarado === undefined
      ? primerMedio(desempaquetado)
      : { url: declarado.replace(/\\\//g, '/'), kind: 'hls' as const }

  return medio === undefined ? undefined : { url: medio.url, kind: medio.kind }
}

/**
 * Voe: el reproductor que se disfraza de tres sitios distintos.
 *
 * `voe.sx/e/<id>` no reproduce nada: contesta una página mínima cuyo único
 * contenido es un `window.location.href = '<espejo>'`, y el espejo cambia de
 * dominio cada pocos días. En el espejo sí está el reproductor, y publica sus
 * datos en un `<script type="application/json">` **ofuscados**: el texto va
 * rotado con ROT13, salpicado de marcas de dos caracteres que hay que borrar, y
 * lo que queda es un base64 que, decodificado, hay que desplazar carácter a
 * carácter y leer del revés para llegar al JSON de verdad. Todo eso es aritmética
 * de cadenas, así que se deshace aquí; lo que **no** se hace es ejecutar el
 * cargador del sitio.
 *
 * El decodificador es una transcripción de su `loader.a40897e.js`; si algún día
 * cambia el orden de los pasos, el síntoma es el mismo que el de un espejo caído
 * —no hay `source`— y el mensaje lo dice.
 */
function rotarVoe(texto: string): string {
  let salida = ''

  for (const caracter of texto) {
    const codigo = caracter.charCodeAt(0)
    if (codigo >= 0x41 && codigo <= 0x5a) salida += String.fromCharCode(((codigo - 0x41 + 13) % 26) + 0x41)
    else if (codigo >= 0x61 && codigo <= 0x7a) salida += String.fromCharCode(((codigo - 0x61 + 13) % 26) + 0x61)
    else salida += caracter
  }

  return salida
}

const MARCAS_VOE = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'] as const

function descodificarVoe(crudo: string): Record<string, unknown> | undefined {
  try {
    let marcado = rotarVoe(crudo)
    for (const marca of MARCAS_VOE) marcado = marcado.split(marca).join('_')

    const primera = Buffer.from(marcado.split('_').join(''), 'base64').toString('latin1')
    let desplazado = ''
    for (const caracter of primera) {
      desplazado += String.fromCharCode(caracter.charCodeAt(0) - 3)
    }

    const alReves = [...desplazado].reverse().join('')
    const datos: unknown = JSON.parse(Buffer.from(alReves, 'base64').toString('utf8'))

    return typeof datos === 'object' && datos !== null ? (datos as Record<string, unknown>) : undefined
  } catch {
    // Un descifrado que no cuadra no es una excepción que deba salir del plugin:
    // es un espejo que no sirve y se prueba el siguiente.
    return undefined
  }
}

/** El espejo al que apunta la página mínima de Voe, si lo dice. */
function redireccionDeVoe(html: string): string | undefined {
  const metas = [
    // `window.location.href = '<espejo>'` es la forma que usa hoy. El espacio
    // alrededor del `=` es opcional en el código que se genere mañana, así que lo
    // es también aquí; darlo por hecho fue exactamente el fallo que tuvo esta
    // función la primera vez.
    ...html.matchAll(/location\.(?:href\s*=\s*|replace\s*\(\s*)['"](https?:\/\/[^'"]+)['"]/gi),
    ...html.matchAll(/http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/gi),
  ]

  for (const encontrado of metas) {
    const destino = comoUrl(encontrado[1])
    if (destino === undefined || new URL(destino).hostname === 'voe.sx') continue

    // El espejo lo nombra la página: si apunta a la red interna, no se sigue.
    if (!destinoDeContenidoAceptable(destino)) continue

    return destino
  }

  return undefined
}

async function resolverVoe(url: string, opciones: CallOptions): Promise<Fuente | undefined> {
  let pagina = url

  // Un salto al espejo y, como mucho, un segundo por si el espejo vuelve a
  // moverse: el bucle existe por el salto, no para reintentar un sitio caído.
  for (let paso = 0; paso < 3; paso += 1) {
    const html = await cuerpo(await pedir(pagina, opciones))

    const bruto = /<script type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1]
    if (bruto !== undefined) {
      let lista: unknown
      try {
        lista = JSON.parse(bruto)
      } catch {
        return undefined
      }

      const primero = Array.isArray(lista) ? lista[0] : lista
      const datos = typeof primero === 'string' ? descodificarVoe(primero) : undefined
      const fuente = datos?.['source'] ?? datos?.['direct_access_url']
      if (typeof fuente !== 'string' || fuente === '') return undefined

      return { url: fuente, kind: fuente.includes('.m3u8') ? 'hls' : 'file' }
    }

    const siguiente = redireccionDeVoe(html)
    if (siguiente === undefined) return undefined

    pagina = siguiente
  }

  return undefined
}

/**
 * Filemoon: el reproductor que se guarda la dirección en una caja fuerte.
 *
 * No publica el enlace en ninguna parte: su API devuelve una **caja cerrada** —un
 * `iv`, un `payload` cifrado y treinta trozos de clave— y quien quiera el video
 * tiene que abrirla. La cerradura es AES-GCM y la clave sale de los trozos, pero
 * sólo de **dos**: la `version` que viene en la respuesta elige dos índices —ella
 * y `31 - version`— y los otros veintiocho son señuelos del mismo tamaño, puestos
 * para que copiarlos todos no sirva de nada.
 *
 * El descifrado se hace aquí con `node:crypto`, que es lo que ya usa el proveedor
 * de PelisPlusHD para su AES-CBC: no se ejecuta nada del sitio. El algoritmo no se
 * adivina, se lee de la propia respuesta (la longitud de la clave decide si es
 * AES-128, 192 o 256), y por eso funciona aunque cambien de versión.
 */
function desdeBase64Url(valor: string): Buffer {
  const normal = valor.replace(/-/g, '+').replace(/_/g, '/')
  const relleno = normal.length % 4 === 0 ? '' : '='.repeat(4 - (normal.length % 4))

  return Buffer.from(normal + relleno, 'base64')
}

interface CajaFilemoon {
  readonly version?: string | number
  readonly iv?: string
  readonly payload?: string
  readonly key_parts?: readonly string[]
}

interface FuenteFilemoon {
  readonly url?: string
  readonly label?: string
  readonly height?: number
  readonly bitrate_kbps?: number
}

function abrirCajaFilemoon(caja: CajaFilemoon): readonly FuenteFilemoon[] | undefined {
  try {
    const partes = Array.isArray(caja.key_parts) ? caja.key_parts : []
    if (partes.length === 0 || caja.iv === undefined || caja.payload === undefined) return undefined

    const version = Number(String(caja.version ?? '').trim())
    const indices = [version, 31 - version].filter(
      (numero) => Number.isInteger(numero) && numero >= 1 && numero <= partes.length,
    )

    // Sin versión utilizable se prueban todas: es peor no intentarlo que leer la
    // caja con la llave equivocada, porque un fallo aquí sólo cuesta un intento.
    const elegidas = (indices.length > 0 ? indices : partes.map((_, posicion) => posicion + 1))
      .map((numero) => partes[numero - 1])
      .filter((parte): parte is string => typeof parte === 'string' && parte !== '')
    if (elegidas.length === 0) return undefined

    const clave = Buffer.concat(elegidas.map(desdeBase64Url))
    // Tres ramas con el nombre literal y no una variable: es lo que hace que
    // `node:crypto` devuelva el descifrador de GCM, que es el único que tiene
    // `setAuthTag`. Con el nombre en una variable, el tipo se queda en el
    // descifrador genérico y la etiqueta no se puede pasar.
    const iv = desdeBase64Url(caja.iv)
    const descifrador =
      clave.length === 16
        ? createDecipheriv('aes-128-gcm', clave, iv)
        : clave.length === 24
          ? createDecipheriv('aes-192-gcm', clave, iv)
          : clave.length === 32
            ? createDecipheriv('aes-256-gcm', clave, iv)
            : undefined
    if (descifrador === undefined) return undefined

    const bruto = desdeBase64Url(caja.payload)
    // Los últimos 16 bytes no son cuerpo: son la etiqueta de autenticación, y
    // `node:crypto` la quiere aparte.
    if (bruto.length <= 16) return undefined

    descifrador.setAuthTag(bruto.subarray(bruto.length - 16))
    const claro = Buffer.concat([
      descifrador.update(bruto.subarray(0, bruto.length - 16)),
      descifrador.final(),
    ]).toString('utf8')

    const datos = JSON.parse(claro) as { sources?: readonly FuenteFilemoon[] }

    return datos.sources
  } catch {
    // Una etiqueta que no cuadra no es una excepción que deba salir del plugin:
    // es una caja que no se pudo abrir y se prueba el reproductor siguiente.
    return undefined
  }
}

async function resolverFilemoon(url: string, opciones: CallOptions): Promise<Fuente | undefined> {
  const enlace = new URL(url)
  const codigo = /\/(?:e|d|v)\/([A-Za-z0-9]+)/.exec(enlace.pathname)?.[1]
  if (codigo === undefined) return undefined

  // La API se pide al **mismo espejo** que sirvió el embed, no a uno fijo: el
  // sitio reparte los mismos códigos entre `filemoon.to` y `filemoon.sx`, y cada
  // espejo contesta por los suyos. Se usa el `hostname` y no el `host` para que el
  // puerto que traiga la dirección no se cuele en la petición: los espejos están
  // en el 443 y un puerto lo elige quien escribe el `<iframe>`.
  const respuesta = await pedir(
    `${enlace.protocol}//${enlace.hostname}/api/videos/${codigo}`,
    opciones,
    { referer: url, acepta: 'application/json', tolerarEstado: true },
  )
  let datos: { playback?: CajaFilemoon }
  try {
    datos = JSON.parse(await cuerpo(respuesta)) as { playback?: CajaFilemoon }
  } catch {
    datos = {}
  }

  if (datos.playback === undefined) throw new Error(`la API respondió ${respuesta.status} sin caja`)

  const fuentes = (abrirCajaFilemoon(datos.playback) ?? []).filter(
    (fuente): fuente is FuenteFilemoon & { url: string } =>
      typeof fuente.url === 'string' && fuente.url !== '',
  )
  if (fuentes.length === 0) return undefined

  // La caja trae una entrada por calidad —1080p, 720p, 480p— y cada una es su
  // propio manifiesto. Se elige la mejor y se dice cuál es, que es lo que la
  // interfaz enseña; el selector de la aplicación es de servidores, no de calidades.
  const mejor = [...fuentes].sort(
    (a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate_kbps ?? 0) - (a.bitrate_kbps ?? 0),
  )[0]
  if (mejor === undefined) return undefined

  return {
    url: mejor.url,
    kind: mejor.url.includes('.m3u8') ? 'hls' : 'file',
    ...(mejor.label === undefined || mejor.label === '' ? {} : { quality: mejor.label }),
  }
}

/**
 * Los reproductores que ofrece una página selectora.
 *
 * `links.cuevana.ac` no reproduce: enseña una pestaña por idioma y un botón por
 * servidor, y la dirección de cada uno viaja en un `go_to_player('…')` del
 * `onclick`. Es la única forma de ver reproductores que Gnula no publica en su
 * propia lista —Voe, Filemoon, Mixdrop—, porque el `<iframe>` que enseña apunta
 * al selector, no al reproductor.
 *
 * Los enlaces de descarga que también salen ahí (1fichier, gofile, megaup…) no se
 * leen: no son streams.
 */
async function servidoresDeSelector(url: string, opciones: CallOptions): Promise<readonly string[]> {
  const html = await cuerpo(await pedir(url, opciones))

  return [
    ...new Set(
      [...html.matchAll(/go_to_player\s*\(\s*['"]([^'"]+)['"]/gi)]
        .map((encontrado) => comoUrl(encontrado[1]))
        .filter((destino): destino is string => destino !== undefined)
        // Los botones los escribe la página del selector: a la red interna no se va.
        .filter((destino) => destinoDeContenidoAceptable(destino)),
    ),
  ]
}

/**
 * La tabla de reproductores, por anfitrión.
 *
 * `casa` reconoce el anfitrión y `resolver` intenta sacarle un enlace. Los que
 * están sin `resolver` se declaran igualmente para poder decir **por qué** no se
 * usan, que es lo que convierte un «no dio fuente» en algo que se puede arreglar:
 * un reproductor bloqueado y uno que cambió de formato se arreglan de forma
 * distinta. `Waaw` y `player.cuevana.ac` son el mismo motor y el mismo muro: su
 * página pide un clic de verdad —`isTrusted`— sobre una imagen de captcha.
 */
const REPRODUCTORES: readonly {
  readonly nombre: string
  readonly casa: RegExp
  readonly resolver?: (url: string, opciones: CallOptions) => Promise<Fuente | undefined>
  readonly motivo?: string
}[] = [
  {
    nombre: 'Uqload',
    casa: /(?:^|\.)uqload\.(?:com|vc|to|io|co|net)$/i,
    resolver: resolverUqload,
  },
  {
    nombre: 'Voe',
    casa: /(?:^|\.)voe\.sx$/i,
    resolver: resolverVoe,
  },
  {
    nombre: 'Filemoon',
    casa: /(?:^|\.)filemoon\.(?:to|sx|ws|com|in|nl|st)$/i,
    resolver: resolverFilemoon,
  },
  {
    nombre: 'Waaw',
    casa: /(?:^|\.)(?:waaw\.to|waaw\.in|player\.cuevana\.ac)$/i,
    motivo: 'su captcha exige un clic de verdad, que una petición no puede dar',
  },
  {
    nombre: 'Mixdrop',
    casa: /(?:^|\.)(?:mixdrop\.(?:ch|sx|ag|to|bz|ps)|mxdrop\.top|m1xdrop\.com)$/i,
    motivo: 'su revelado exige un token de reCAPTCHA v3',
  },
  {
    nombre: 'Upstream',
    casa: /(?:^|\.)upstream\.to$/i,
    motivo: 'presenta un certificado propio y contesta un bloqueo de DDoS-Guard',
  },
  {
    nombre: 'Streamz',
    casa: /(?:^|\.)streamz\.ws$/i,
    motivo: 'esta máquina no consigue ni abrirle la conexión',
  },
  {
    nombre: 'Doodstream',
    casa: /(?:^|\.)(?:dood\.(?:so|ws|yt|pm|la|li)|doods\.pro|d000d\.com|ds2play\.com)$/i,
    motivo: 'esta máquina no consigue ni abrirle la conexión',
  },
  {
    nombre: 'Vtube',
    casa: /(?:^|\.)vtube\.to$/i,
    motivo: 'esta máquina no consigue ni abrirle la conexión',
  },
]

/*
 * Los reproductores de arriba sin `resolver` están declarados a propósito, y no
 * son relleno: sin ellos el mensaje de un fallo dice «sin resolutor conocido»,
 * que no distingue «no lo hemos mirado» de «está bloqueado y por esto». Con
 * ellos, quien lea el error sabe si el problema es su red, un captcha o un
 * reproductor que nadie ha estudiado todavía — que es la diferencia entre poder
 * arreglarlo y no poder.
 */

/* -------------------------------------------------- las opciones y sus idiomas */

interface Opcion {
  /** El idioma que el sitio declara para este grupo, en minúsculas. */
  readonly idioma: string
  readonly embeds: readonly string[]
}

/**
 * Los grupos de reproductores de una ficha, con su idioma.
 *
 * El bloque es `<div class="iframes">` y dentro hay un `<em>` por opción
 * —`opción 1, Latino, HD`— seguido de los `<iframe>` de esa opción. Se corta el
 * bloque contando `<div>` para no llevarse por delante el resto de la página, y
 * se parte por los `<em>`: lo que hay entre uno y el siguiente pertenece a ese
 * idioma. La pestaña de descarga no tiene `<iframe>`, así que no entra sola.
 */
function opcionesDe(html: string): readonly Opcion[] {
  const inicio = html.indexOf('<div class="iframes">')
  if (inicio < 0) return []

  // El final del bloque, contando aperturas y cierres de `<div>`.
  let profundidad = 0
  let fin = html.length
  for (const encontrado of html.slice(inicio).matchAll(/<div\b|<\/div>/gi)) {
    const indice = inicio + (encontrado.index ?? 0)
    profundidad += encontrado[0].toLowerCase() === '<div' ? 1 : -1
    if (profundidad === 0) {
      fin = indice
      break
    }
  }

  const bloque = html.slice(inicio, fin)
  const partes = [...bloque.matchAll(/<em>([\s\S]*?)<\/em>/gi)]

  const salida: Opcion[] = []
  for (const [indice, parte] of partes.entries()) {
    const desde = (parte.index ?? 0) + parte[0].length
    const hasta = partes[indice + 1]?.index ?? bloque.length
    const etiqueta = limpio(parte[1] ?? '').toLowerCase()

    // La descarga no es una opción de reproducción.
    if (/descarga|download/.test(etiqueta)) continue

    const embeds: string[] = []
    for (const iframe of bloque.slice(desde, hasta).matchAll(/<iframe\b[^>]*>/gi)) {
      // WP Rocket deja la dirección real en `data-lazy-src` y un `about:blank` en
      // `src`; el `<noscript>` de al lado repite la buena, y por eso se aceptan
      // las dos formas.
      const declarada =
        atributo(iframe[0], 'data-lazy-src') ?? atributo(iframe[0], 'data-src') ?? atributo(iframe[0], 'src')
      const url = comoUrl(declarada)
      if (url === undefined) continue

      try {
        if (RUIDO.test(new URL(url).hostname)) continue
      } catch {
        continue
      }

      embeds.push(url)
    }

    if (embeds.length > 0) salida.push({ idioma: etiqueta, embeds })
  }

  return salida
}

/** El idioma de un grupo, en una palabra: lo que el modo necesita comparar. */
function idiomaDe(etiqueta: string): 'latino' | 'castellano' | 'subtitulado' | 'otro' {
  if (/latino|lat\b|latin/.test(etiqueta)) return 'latino'
  if (/castellano|espa[nñ]a|esp\b/.test(etiqueta)) return 'castellano'
  if (/subtitul|sub\b|vose|original/.test(etiqueta)) return 'subtitulado'

  return 'otro'
}

/**
 * El orden en que se prueban los grupos según lo que se haya pedido.
 *
 * El sitio dice el idioma de cada grupo, así que no hay nada que adivinar: quien
 * pide doblaje quiere latino y, si no lo hay, castellano; quien pide subtítulos
 * quiere el grupo subtitulado y, si no lo hay, cualquiera sirve —el audio latino
 * con el que el sitio dobla una película subtitulada sigue siendo lo que hay—.
 */
function ordenar(opciones: readonly Opcion[], modo: string): readonly Opcion[] {
  const preferencia =
    modo === 'dub'
      ? ['latino', 'castellano', 'subtitulado', 'otro']
      : ['subtitulado', 'latino', 'castellano', 'otro']

  return [...opciones].sort(
    (a, b) => preferencia.indexOf(idiomaDe(a.idioma)) - preferencia.indexOf(idiomaDe(b.idioma)),
  )
}

/* ------------------------------------------------------------------ proveedor */

const proveedor: Provider = {
  id: ID,
  name: 'Gnula',
  apiVersion: '1',
  /*
   * Películas, y dobladas y subtituladas: el sitio etiqueta sus opciones por
   * audio —Latino, Castellano, Subtitulado— y las tres existen en su catálogo.
   * Sin tendencias ni feed: tiene portada de novedades, pero este archivo no ha
   * estudiado su marcado y declarar una capacidad que no está probada ofrece un
   * botón que no lleva a ninguna parte.
   */
  capabilities: { search: true, sub: true, dub: true, trending: false, feed: false },

  /**
   * La búsqueda es una sola petición, y el sitio no pagina los resultados.
   *
   * El buscador es un `GET` con `?s=`, y el tema contesta la lista entera dentro
   * de la misma tabla, encabezada por la palabra `Busqueda:`. Ese encabezado es
   * el que se usa para **acotar** el parseo: la página trae además la barra
   * lateral con las novedades, que son otras sesenta fichas con el mismo marcado,
   * y leerlas sería devolver el catálogo entero como si fueran resultados.
   *
   * No hay tipo que deducir: este sitio sólo publica películas —las series viven
   * en otro dominio suyo— así que todo lo que sale de aquí es `movie`.
   */
  async search(query, opciones) {
    const texto = query.trim()
    if (texto === '') return []

    const url = `${base()}/?${new URLSearchParams({ s: texto }).toString()}`
    const html = await cuerpo(await pedir(url, opciones))

    // Sin el encabezado, esto no es una página de resultados: es un cambio de
    // plantilla, y decirlo es la diferencia entre un plugin que se arregla y uno
    // que parece vacío para siempre.
    const encabezado = /Busqueda\s*:/i.exec(html)
    if (encabezado?.index === undefined) {
      throw new Error('Gnula no devolvió una página de resultados; el marcado del buscador cambió')
    }

    return filasDe(html.slice(encabezado.index)).map((fila): Acierto => ({
      ref: { providerId: ID, value: `movie/${fila.slug}` },
      title: fila.title,
      kind: 'movie',
      ...(fila.coverUrl === undefined ? {} : { coverUrl: fila.coverUrl }),
      ...(fila.year === undefined ? {} : { year: fila.year }),
    }))
  },

  /**
   * La ficha, de su página, más los géneros del listado.
   *
   * Son dos peticiones y no una porque el sitio reparte el dato: el título, el
   * año, la portada y la sinopsis están en la ficha; los géneros, sólo en el
   * `title` de las filas del listado. La segunda se traga cualquier fallo, así que
   * un buscador caído deja la ficha sin géneros en vez de sin ficha.
   */
  async getAnime(ref, opciones): Promise<Ficha> {
    const slug = slugDe(ref.value)
    if (slug === '') throw new Error(`la referencia '${ref.value}' no nombra ninguna película`)

    const html = await cuerpo(await pedir(`${base()}/movie/${rutaDe(slug)}/`, opciones))
    const detalle = detalleDe(html, slug)
    const generos = await generosDe(slug, detalle.title, opciones)

    return {
      ref,
      title: detalle.title,
      kind: 'movie',
      ...(detalle.titleAlt === undefined ? {} : { titleAlt: detalle.titleAlt }),
      ...(detalle.coverUrl === undefined ? {} : { coverUrl: detalle.coverUrl }),
      ...(detalle.synopsis === undefined ? {} : { synopsis: detalle.synopsis }),
      ...(detalle.year === undefined ? {} : { year: detalle.year }),
      genres: [...generos],
      // El sitio no publica estudios en ninguna de sus páginas.
      studios: [],
    }
  },

  /**
   * El único «episodio» de una película.
   *
   * El contrato exige un `episodeRef` para pedir un stream, así que una película
   * se reproduce sin lista: se le da un episodio con número 1, que es lo que ya
   * hacen los otros proveedores de películas de este repositorio.
   */
  async getEpisodes(ref, opciones): Promise<readonly Episodio[]> {
    void opciones
    if (slugDe(ref.value) === '') {
      throw new Error(`la referencia '${ref.value}' no nombra ninguna película`)
    }

    return [{ ref: { providerId: ID, value: ref.value }, animeRef: ref, number: 1, mode: 'sub' }]
  },

  /**
   * El enlace de video: se elige el grupo del idioma pedido y se resuelve.
   *
   * Cada grupo trae sus reproductores en el orden en que el sitio los publica, y
   * el sitio publica primero el que mejor le funciona. Así que se respeta ese
   * orden dentro del grupo y se prueban los grupos en el orden del modo: latino
   * antes que castellano para `dub`, subtitulado antes que nada para `sub`.
   *
   * La lista no es fija: uno de los `<iframe>` del sitio no es un reproductor
   * sino un **selector** —una página con un botón por servidor—, y hay que abrirlo
   * para saber qué ofrece. Cuando aparece uno, sus servidores se ponen **en su
   * sitio** de la cola, no al final: el orden del sitio es el que dice qué
   * conviene intentar primero, y meterlos al final lo rompería.
   *
   * Si un reproductor no da enlace, se pasa al siguiente; el motivo de cada fallo
   * se guarda y se cuenta al final, porque «no dio ninguna fuente» a secas no se
   * puede arreglar desde fuera.
   */
  async resolveStream(peticion, opciones): Promise<readonly Fuente[]> {
    const slug = slugDe(peticion.episodeRef.value)
    if (slug === '') throw new Error(`la referencia '${peticion.episodeRef.value}' no nombra ninguna película`)

    const html = await cuerpo(
      await pedir(`${base()}/movie/${rutaDe(slug)}/`, opciones),
    )

    const opcionesDeIdioma = opcionesDe(html)
    if (opcionesDeIdioma.length === 0) {
      throw new Error(
        `la ficha de ${slug} no trae ningún reproductor; el marcado de la página cambió o la película no existe`,
      )
    }

    const fallos: string[] = []
    // El mismo reproductor puede estar en dos grupos —Uqload sale en latino y en
    // castellano, apuntando a archivos distintos—, así que se lleva cuenta de lo
    // ya intentado para no pedir dos veces lo mismo ni repetir el mismo motivo en
    // el mensaje final.
    const intentados = new Set<string>()

    // La cola, ya en el orden del modo pedido.
    const cola = ordenar(opcionesDeIdioma, peticion.mode).flatMap((grupo) => [...grupo.embeds])

    // El tope existe porque un selector puede llevar a otro selector: sin él, dos
    // páginas que se apunten entre sí serían un bucle infinito.
    for (let indice = 0; indice < cola.length && intentados.size < 24; indice += 1) {
      const embed = cola[indice] ?? ''
      if (embed === '' || intentados.has(embed)) continue
      intentados.add(embed)

      let anfitrion: string
      try {
        anfitrion = new URL(embed).hostname
      } catch {
        continue
      }

      // El `<iframe>` lo eligió el sitio: si apunta a la red interna, no se pide.
      if (!destinoDeContenidoAceptable(embed)) {
        const motivo = `${anfitrion}: apunta a un destino interno; se descarta`
        if (!fallos.includes(motivo)) fallos.push(motivo)
        continue
      }

      // Un selector no reproduce: publica sus reproductores en un
      // `go_to_player('…')`, uno por servidor. Se abren y se ponen en su sitio.
      if (SELECTORES.test(anfitrion)) {
        try {
          const servidores = await servidoresDeSelector(embed, opciones)
          if (servidores.length === 0) {
            const motivo = `${anfitrion}: el selector no publicó ningún servidor`
            if (!fallos.includes(motivo)) fallos.push(motivo)
            continue
          }

          cola.splice(indice + 1, 0, ...servidores)
        } catch (causa) {
          fallos.push(
            `${anfitrion}: ${causa instanceof Error ? causa.message : String(causa)}`,
          )
        }

        continue
      }

      const reproductor = REPRODUCTORES.find((uno) => uno.casa.test(anfitrion))
      if (reproductor === undefined) {
        const motivo = `${anfitrion}: sin resolutor conocido`
        if (!fallos.includes(motivo)) fallos.push(motivo)
        continue
      }

      if (reproductor.resolver === undefined) {
        const motivo = `${anfitrion}: ${reproductor.motivo ?? 'no se sabe resolver'}`
        if (!fallos.includes(motivo)) fallos.push(motivo)
        continue
      }

      try {
        const fuente = await reproductor.resolver(embed, opciones)
        if (fuente === undefined) {
          fallos.push(`${reproductor.nombre}: ${anfitrion} no publicó ningún archivo`)
          continue
        }

        return [fuente]
      } catch (causa) {
        fallos.push(
          `${reproductor.nombre}: ${causa instanceof Error ? causa.message : String(causa)}`,
        )
      }
    }

    throw new Error(
      `Gnula no dio ninguna fuente para ${peticion.episodeRef.value} (${fallos.join('; ')})`,
    )
  },
}

export default proveedor

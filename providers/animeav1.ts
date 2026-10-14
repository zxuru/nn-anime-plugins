/**
 * Proveedor de AnimeAV1 (animeav1.com).
 *
 * El sitio es una aplicación de SvelteKit y **no tiene una API pública del
 * catálogo**: la única ruta JSON pensada para el navegador es `POST /api/search`.
 * Todo lo demás —el detalle, los episodios y los servidores de cada episodio—
 * viaja en los `__data.json` que SvelteKit sirve junto a cada página:
 *
 *   GET /media/<slug>/__data.json             -> { media }
 *   GET /media/<slug>/<episodio>/__data.json  -> { media, episode, embeds, downloads }
 *   GET /__data.json                          -> { featured, latestEpisodes, ... }
 *   GET /catalogo/__data.json                 -> { results, pagination, ... }
 *
 * Ese JSON no es un objeto corriente. SvelteKit serializa con `devalue`, que
 * aplana el árbol en una lista y sustituye **cada valor por su índice** dentro de
 * ella. `desaplanar` es el lector de ese formato: sin él, `{"media":1}` no dice
 * nada, y el JSON sólo se puede consumir después de rehidratarlo.
 *
 * Los «embeds» del sitio son páginas de terceros (Voe, Byse, MP4Upload...), no
 * archivos de video. El único que entrega un HLS directo es el que el sitio llama
 * `HLS`: un reproductor propio cuya playlist está en `/m3u8/<id>` y responde con
 * `access-control-allow-origin: *`. Para los demás se intenta el camino barato
 * —buscar una `.m3u8` o un `.mp4` en el HTML del embed— y, si no aparece, se
 * descarta: esta aplicación reproduce HLS y archivos progresivos, no iframes.
 *
 * Un plugin se ejecuta sin sandbox y con los permisos de quien lo copia. Ver
 * SECURITY.md antes de confiar en uno.
 */

import type {
  CallOptions,
  PluginFetch,
  PluginRequest,
  PluginResponse,
  Provider,
} from '@nn-anime/provider-sdk'

/**
 * La referencia, escrita aquí y no importada del SDK.
 *
 * `@nn-anime/provider-sdk` no la reexporta en su superficie pública —el
 * contrato la declara y el compilador la comprueba por estructura—, así que un
 * plugin que quiera nombrar el tipo en sus propias funciones lo declara. Es la
 * misma forma, y por eso sigue encajando.
 */
interface Referencia {
  readonly providerId: string
  readonly value: string
}

const ID = 'animeav1'
const BASE = 'https://animeav1.com'
const CDN = 'https://cdn.animeav1.com'
const ZILLA = 'https://player.zilla-networks.com'

/**
 * El sitio está detrás de Cloudflare y responde 403 a clientes sin pinta de
 * navegador. No es una firma ni un token: basta con identificarse.
 */
const AGENTE =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/* ------------------------------------------------------------------ devalue */

/**
 * Rehidrata el formato de `devalue`.
 *
 * La lista `datos` guarda los valores y cada referencia es el índice de uno de
 * ellos. Los índices negativos son los valores que no se pueden expresar en
 * JSON: `-1` es `undefined`, `-2` un hueco de array, `-3` `NaN`, `-4` y `-5` los
 *infinitos y `-6` el cero negativo. Los tipos con marca —`Date`, `Set`, `Map`,
 * `BigInt`— se guardan como un array que empieza por su nombre.
 *
 * Se memoiza antes de bajar a los hijos, no después: un árbol con una referencia
 * repetida se resolvería dos veces, y uno con un ciclo no terminaría nunca.
 */
function desaplanar(datos: readonly unknown[]): unknown {
  const resueltos = new Map<number, unknown>()

  function hidratar(indice: number): unknown {
    switch (indice) {
      case -1:
      case -2:
        return undefined
      case -3:
        return Number.NaN
      case -4:
        return Number.POSITIVE_INFINITY
      case -5:
        return Number.NEGATIVE_INFINITY
      case -6:
        return -0
      default:
        break
    }

    if (resueltos.has(indice)) return resueltos.get(indice)

    const valor = datos[indice]

    if (Array.isArray(valor)) {
      const marca = valor[0]
      if (marca === 'Date') return new Date(String(valor[1]))
      if (marca === 'BigInt') return BigInt(String(valor[1]))
      if (marca === 'Set') {
        // Se memoiza **antes** de bajar, igual que las listas: un `Set` que se
        // contenga a sí mismo, si no, no termina nunca.
        const conjunto: unknown[] = []
        resueltos.set(indice, conjunto)
        for (const elemento of valor.slice(1)) conjunto.push(hidratar(elemento as number))

        return conjunto
      }
      if (marca === 'Map') {
        const mapa = new Map<unknown, unknown>()
        resueltos.set(indice, mapa)
        for (let i = 1; i + 1 < valor.length; i += 2) {
          mapa.set(hidratar(valor[i] as number), hidratar(valor[i + 1] as number))
        }

        return mapa
      }

      const lista: unknown[] = []
      resueltos.set(indice, lista)
      for (const elemento of valor) lista.push(hidratar(elemento as number))

      return lista
    }

    if (typeof valor === 'object' && valor !== null) {
      // Sin prototipo, a propósito: las claves las elige el JSON del sitio, y una
      // clave `__proto__` fijaría el prototipo de este objeto y colaría valores
      // heredados por las comprobaciones `!== undefined` de más arriba.
      const objeto: Record<string, unknown> = Object.create(null)
      resueltos.set(indice, objeto)
      for (const [clave, referencia] of Object.entries(valor)) {
        objeto[clave] = hidratar(referencia as number)
      }

      return objeto
    }

    return valor
  }

  return hidratar(0)
}

/* ------------------------------------------------------------------- red */

interface DocumentoDatos {
  readonly type?: string
  readonly nodes?: readonly ({
    readonly type?: string
    readonly data?: readonly unknown[]
  } | null)[]
}

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

/** Una petición al sitio que falla con el estado y la ruta, no con un `fetch` roto. */
async function pedir(
  ruta: string,
  opciones: CallOptions,
  init: PluginRequest = {},
): Promise<unknown> {
  const respuesta = await redDe(opciones)(`${BASE}${ruta}`, {
    ...init,
    headers: {
      accept: 'application/json, text/html;q=0.8',
      'accept-language': 'es-ES,es;q=0.9',
      'user-agent': AGENTE,
      ...(init.headers ?? {}),
    },
    maxBytes: TOPE_CUERPO_BYTES,
  })

  if (!esEstadoOk(respuesta)) throw new Error(`AnimeAV1 respondió ${respuesta.status} en ${ruta}`)

  const crudo = await cuerpo(respuesta)
  try {
    return JSON.parse(crudo) as unknown
  } catch {
    throw new Error(`AnimeAV1 no devolvió JSON en ${ruta}`)
  }
}

/**
 * Destinos que un reproductor de internet no necesita y una página hostil sí.
 *
 * La dirección del embed la elige el JSON del sitio, así que sin esta guarda una
 * página comprometida puede hacer que el plugin pida `http://127.0.0.1:8080/…`,
 * un servicio de la red de casa o la metadata de la nube, desde la máquina de
 * quien lo copia. El proxy del motor tiene su propia comprobación de destinos,
 * pero no cubre estas peticiones: el plugin no pasa por él.
 *
 * Es una comprobación **literal**, aunque `new URL` normaliza las formas raras de
 * escribir una dirección (`127.1`, `2130706433`, `0x7f.1`) y por eso no se
 * escapan. Un nombre que resuelva a una dirección interna sí la esquiva:
 * resolver y fijar la dirección no está al alcance de un `fetch`, y por eso la
 * guarda completa vive en el motor, que resuelve y mira todas las respuestas del
 * DNS.
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

/** Si la dirección la eligió el contenido del sitio, ¿se puede pedir? */
function destinoDeContenidoAceptable(url: string): boolean {
  let analizada: URL
  try {
    analizada = new URL(url)
  } catch {
    return false
  }

  if (analizada.protocol !== 'http:' && analizada.protocol !== 'https:') return false

  return !esHostInterno(analizada.hostname)
}

/** Una dirección sólo se acepta si es http o https con host. */
function comoUrl(valor: string | undefined): string | undefined {
  if (valor === undefined) return undefined

  try {
    const url = new URL(valor)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * Una referencia del motor convertida en ruta.
 *
 * Las referencias llegan como cadenas opacas y terminan dentro de una ruta: lo
 * que no puede llegar es un `..` que mueva la petición a otra ruta del sitio ni
 * un `?` o un `#` que le cambien la consulta. `encodeURIComponent` solo no basta:
 * los puntos no se codifican.
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

/**
 * Los datos de una página, ya rehidratados.
 *
 * SvelteKit parte la respuesta por nodos —el layout primero, la página al
 * final— y los vacíos van en `null`. Se lee el **último con datos**, que es el de
 * la página; coger el primero devolvería el layout y un objeto con sólo el
 * usuario.
 */
async function datosDe(ruta: string, opciones: CallOptions): Promise<Record<string, unknown>> {
  const documento = (await pedir(`${ruta}/__data.json`, opciones)) as DocumentoDatos
  const nodos = documento.nodes ?? []

  for (let i = nodos.length - 1; i >= 0; i--) {
    const nodo = nodos[i]
    if (nodo == null || !Array.isArray(nodo.data)) continue

    const hidratado = desaplanar(nodo.data)

    return typeof hidratado === 'object' && hidratado !== null
      ? (hidratado as Record<string, unknown>)
      : {}
  }

  throw new Error(`AnimeAV1 no devolvió datos en ${ruta}`)
}

/* --------------------------------------------------------------- respuestas */

interface GeneroCrudo {
  readonly name?: string
}

interface MediaCruda {
  readonly id?: number | string
  readonly title?: string
  readonly slug?: string
  readonly aka?: Record<string, string>
  readonly synopsis?: string | null
  readonly poster?: string | null
  readonly backdrop?: string | null
  readonly status?: number
  readonly startDate?: string | null
  readonly episodesCount?: number
  readonly genres?: readonly GeneroCrudo[]
  readonly category?: { readonly slug?: string } | null
  readonly episodes?: readonly { readonly id?: number; readonly number?: number }[]
}

interface EmbedCrudo {
  readonly server?: string
  readonly url?: string
}

interface DatosEpisodio {
  readonly media?: MediaCruda
  readonly episode?: { readonly number?: number; readonly variants?: Record<string, number> }
  readonly embeds?: Record<string, readonly EmbedCrudo[]>
}

/**
 * El entero con el que el sitio dice en qué punto está una serie.
 *
 * Se comprobó contra la etiqueta que el propio sitio pinta al lado del título:
 * `0` sale como «Finalizado», `1` como «Próximamente» y `2` como «En emisión».
 * Cualquier otro valor es desconocido y se omite: inventar un estado es peor que
 * no decir ninguno.
 */
function estadoDe(codigo: number | undefined): 'airing' | 'finished' | 'upcoming' | undefined {
  if (codigo === 0) return 'finished'
  if (codigo === 1) return 'upcoming'
  if (codigo === 2) return 'airing'

  return undefined
}

/** El `slug` de la categoría, que es el tipo de título en el vocabulario del sitio. */
function tipoDe(slug: string | undefined): 'tv' | 'movie' | 'ova' | 'ona' | 'special' | undefined {
  const tipos = {
    'tv-anime': 'tv',
    pelicula: 'movie',
    ova: 'ova',
    ona: 'ona',
    especial: 'special',
  } as const

  return slug === undefined ? undefined : tipos[slug as keyof typeof tipos]
}

/** Texto utilizable, o nada: el sitio usa `null` y cadenas vacías indistintamente. */
function texto(valor: unknown): string | undefined {
  if (typeof valor !== 'string') return undefined
  const limpio = valor.trim()

  return limpio === '' ? undefined : limpio
}

function anio(fecha: unknown): number | undefined {
  const valor = texto(fecha)
  const numero = valor === undefined ? Number.NaN : Number(valor.slice(0, 4))

  return Number.isInteger(numero) && numero > 1900 ? numero : undefined
}

/**
 * La portada.
 *
 * El campo `poster` del JSON viene `null` en todo lo que se ha mirado, pero la
 * imagen existe siempre en el CDN con el id del título, que es la misma regla que
 * usa el propio sitio al pintar las tarjetas. Si algún día llega un `poster` de
 * verdad, gana ése.
 */
function portada(media: MediaCruda): string | undefined {
  const declarada = texto(media.poster) ?? texto(media.backdrop)
  if (declarada !== undefined) {
    return comoUrl(declarada.startsWith('http') ? declarada : `${BASE}${declarada}`)
  }

  return media.id === undefined
    ? undefined
    : `${CDN}/covers/${encodeURIComponent(String(media.id))}.jpg`
}

function refAnime(slug: string): Referencia {
  return { providerId: ID, value: slug }
}

/** Una fila del catálogo o de la búsqueda: el sitio usa la misma forma en las dos. */
interface FilaCruda {
  readonly id?: string
  readonly title?: string
  readonly slug?: string
}

/** Una fila del sitio ya convertida, o nada si le falta el título o el slug. */
function aResultado(fila: FilaCruda) {
  const titulo = texto(fila.title)
  const slug = texto(fila.slug)
  if (titulo === undefined || slug === undefined) return undefined

  const id = texto(fila.id)

  return {
    ref: refAnime(slug),
    title: titulo,
    ...(id === undefined ? {} : { coverUrl: `${CDN}/covers/${encodeURIComponent(id)}.jpg` }),
  }
}

function aResultados(filas: readonly FilaCruda[]) {
  const salida = []
  for (const fila of filas) {
    const resultado = aResultado(fila)
    if (resultado !== undefined) salida.push(resultado)
  }

  return salida
}

/** `<slug>#<episodio>`, la forma que el motor guarda en el historial. */
function refEpisodio(slug: string, numero: number): Referencia {
  return { providerId: ID, value: `${slug}#${numero}` }
}

function partirEpisodio(valor: string): { slug: string; numero: number } | undefined {
  const [slug, numeroCrudo] = valor.split('#')
  const numero = Number(numeroCrudo)

  if (slug === undefined || slug === '' || !Number.isInteger(numero) || numero < 1) return undefined

  return { slug, numero }
}

function slugDe(ref: Referencia): string {
  return ref.value.split('#')[0] ?? ref.value
}

/* ------------------------------------------------------- resolución de fuentes */

/** El id de la playlist del reproductor propio: `/play/<32 hex>` y `/m3u8/<32 hex>`. */
const PLAYLIST_ZILLA = /\/play\/([0-9a-f]{32})/i

interface FuenteEncontrada {
  readonly url: string
  readonly kind: 'hls' | 'file'
  readonly headers?: Record<string, string>
}

/**
 * El HLS propio del sitio, sin salir a la red.
 *
 * La página del reproductor carga `https://player.zilla-networks.com/m3u8/<id>`,
 * y ese `<id>` es el mismo que el embed trae en `/play/<id>`. No hay firma que
 * calcular: la dirección se deduce.
 */
function fuenteZilla(url: string): FuenteEncontrada | undefined {
  const coincidencia = PLAYLIST_ZILLA.exec(url)
  if (coincidencia === null) return undefined

  return { url: `${ZILLA}/m3u8/${coincidencia[1]}`, kind: 'hls' }
}

/**
 * Busca un archivo reproducible en la página de un embed ajeno.
 *
 * Es el camino barato y falla a menudo: algunos servidores redirigen a un espejo,
 * otros cargan el video por JavaScript y unos cuantos piden un token. Cuando no
 * aparece nada se descarta en silencio, porque el siguiente servidor de la lista
 * puede sí tenerlo, y un error por cada intento fallido taparía el bueno.
 */
async function fuenteDeEmbed(
  url: string,
  opciones: CallOptions,
): Promise<FuenteEncontrada | undefined> {
  // La dirección del embed la eligió el sitio: si apunta a la red interna, no se
  // pide y se pasa al siguiente.
  if (!destinoDeContenidoAceptable(url)) return undefined

  let html: string
  try {
    const respuesta = await redDe(opciones)(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'es-ES,es;q=0.9',
        referer: `${BASE}/`,
        'user-agent': AGENTE,
      },
      maxBytes: TOPE_CUERPO_BYTES,
    })

    if (!esEstadoOk(respuesta)) return undefined
    html = await cuerpo(respuesta)
  } catch {
    return undefined
  }

  // Los reproductores incrustan la dirección escapada dentro de un JSON, así que
  // se quitan las barras invertidas antes de buscarla.
  const plano = html.replaceAll('\\/', '/')

  // El tipo se decide por la ruta de la dirección y no por el texto que la
  // rodea: `www.mp4upload.com` lleva `.mp4` en el nombre del host, y una
  // búsqueda por substring tomaría la hoja de estilos del reproductor por un
  // video.
  let archivo: FuenteEncontrada | undefined
  for (const candidata of plano.match(/https?:\/\/[^\s"'<>\\]+/g) ?? []) {
    // La dirección se normaliza antes de devolverla: el motor la valida igual,
    // pero un plugin no debe entregar una cadena que no ha mirado.
    const limpia = comoUrl(candidata)
    if (limpia === undefined) continue

    const ruta = new URL(limpia).pathname.toLowerCase()
    const cabeceras = { Referer: `${origenDe(url)}/` }
    if (ruta.endsWith('.m3u8')) return { url: limpia, kind: 'hls', headers: cabeceras }
    if (archivo === undefined && /\.(mp4|mkv|webm)$/.test(ruta)) {
      archivo = { url: limpia, kind: 'file', headers: cabeceras }
    }
  }

  return archivo
}

function origenDe(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return BASE
  }
}

/* ------------------------------------------------------------------ proveedor */

const proveedor: Provider = {
  id: ID,
  name: 'AnimeAV1',
  apiVersion: '1',
  // El sitio publica subtitulado y doblaje, y la home trae una lista curada.
  // No publica novedades con fecha propia, así que `feed` va en falso.
  capabilities: { search: true, sub: true, dub: true, trending: true, feed: false },

  /**
   * La búsqueda es la única ruta JSON del sitio, y es un `POST`: la consulta va
   * en el cuerpo, no en la URL.
   *
   * Con el cuerpo vacío el sitio contesta 400 —«No haz ingresado una consulta de
   * búsqueda»—, y el motor sí llama con la consulta vacía: al abrir la pestaña de
   * búsqueda sin `?q=` busca «todo», que es lo que hace un proveedor que sepa
   * listar su catálogo. Esta ruta no sabe, así que para una consulta en blanco se
   * devuelve la primera página de `/catalogo`, que es el mismo significado.
   */
  async search(query, opciones) {
    if (query.trim() === '') {
      const catalogo = (await datosDe('/catalogo', opciones)) as {
        results?: readonly FilaCruda[]
      }

      return aResultados(catalogo.results ?? [])
    }

    const filas = (await pedir('/api/search', opciones, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    })) as readonly FilaCruda[]

    return aResultados(filas)
  },

  async getAnime(ref, opciones) {
    const datos = await datosDe(`/media/${rutaDe(slugDe(ref))}`, opciones)
    const media = datos.media as MediaCruda | undefined
    if (media === undefined) throw new Error(`AnimeAV1 no tiene el título ${ref.value}`)

    const titulo = texto(media.title)
    if (titulo === undefined) throw new Error('AnimeAV1 devolvió un título sin nombre')

    const generos = (media.genres ?? [])
      .map((genero) => texto(genero.name))
      .filter((nombre): nombre is string => nombre !== undefined)

    const tituloAlt = texto(media.aka?.['en-us'])
    const caratula = portada(media)
    const estreno = anio(media.startDate)
    const tipo = tipoDe(media.category?.slug)
    const sinopsis = texto(media.synopsis)
    const estado = estadoDe(media.status)
    const episodios = media.episodes?.length ?? media.episodesCount

    return {
      ref,
      title: titulo,
      ...(tituloAlt === undefined ? {} : { titleAlt: tituloAlt }),
      ...(caratula === undefined ? {} : { coverUrl: caratula }),
      ...(estreno === undefined ? {} : { year: estreno }),
      ...(tipo === undefined ? {} : { kind: tipo }),
      ...(sinopsis === undefined ? {} : { synopsis: sinopsis }),
      ...(estado === undefined ? {} : { status: estado }),
      ...(episodios === undefined || episodios < 0 ? {} : { episodeCount: episodios }),
      genres: generos,
      // El sitio no publica estudios en ninguna de sus respuestas.
      studios: [],
    }
  },

  /**
   * Los episodios vienen dentro del detalle del título, con su número.
   *
   * Cada episodio se anuncia como subtitulado porque la lista del detalle no dice
   * qué variantes tiene cada uno —eso sólo aparece al abrir el episodio— y el
   * subtitulado es el que está en casi todos. El doblaje se resuelve al
   * reproducir, que es donde el dato existe.
   */
  async getEpisodes(ref, opciones) {
    const datos = await datosDe(`/media/${rutaDe(slugDe(ref))}`, opciones)
    const media = datos.media as MediaCruda | undefined
    if (media === undefined) throw new Error(`AnimeAV1 no tiene el título ${ref.value}`)

    const episodios = []
    for (const crudo of media.episodes ?? []) {
      if (crudo.number === undefined) continue

      episodios.push({
        ref: refEpisodio(slugDe(ref), crudo.number),
        animeRef: ref,
        number: crudo.number,
        mode: 'sub' as const,
      })
    }

    return episodios
  },

  /**
   * Los servidores del episodio, resueltos a algo que se pueda reproducir.
   *
   * Se pide el modo elegido y, si ese episodio no lo tiene, se usa el otro antes
   * que fallar: hay títulos que sólo están doblados, y devolver un error porque
   * el reproductor empieza en subtitulado dejaría la serie inaccesible. La
   * preferencia se respeta siempre que exista.
   */
  async resolveStream(peticion, opciones) {
    const partes = partirEpisodio(peticion.episodeRef.value)
    if (partes === undefined) {
      throw new Error(`la referencia ${peticion.episodeRef.value} no lleva un episodio`)
    }

    const datos = (await datosDe(
      `/media/${rutaDe(partes.slug)}/${partes.numero}`,
      opciones,
    )) as DatosEpisodio

    const embeds = datos.embeds ?? {}
    const pedido = peticion.mode.toUpperCase()
    const alterno = pedido === 'SUB' ? 'DUB' : 'SUB'
    const lista = embeds[pedido]?.length ? embeds[pedido] : (embeds[alterno] ?? [])

    const fuentes: FuenteEncontrada[] = []
    for (const embed of lista) {
      const url = texto(embed.url)
      if (url === undefined) continue

      const propia = fuenteZilla(url)
      if (propia !== undefined) {
        fuentes.push(propia)
        continue
      }

      const ajena = await fuenteDeEmbed(url, opciones)
      if (ajena !== undefined) fuentes.push(ajena)
    }

    const vistas = new Set<string>()
    const salida = []
    for (const fuente of fuentes) {
      if (vistas.has(fuente.url)) continue
      vistas.add(fuente.url)

      salida.push({
        url: fuente.url,
        kind: fuente.kind,
        ...(fuente.headers === undefined ? {} : { headers: fuente.headers }),
      })
    }

    if (salida.length === 0) {
      const servidores = lista
        .map((embed) => texto(embed.server))
        .filter((nombre): nombre is string => nombre !== undefined)

      throw new Error(
        `AnimeAV1 no dio ninguna fuente reproducible para ${peticion.episodeRef.value}` +
          (servidores.length === 0 ? '' : ` (servidores: ${servidores.join(', ')})`),
      )
    }

    return salida
  },

  /** La home del sitio trae su propia lista de destacados. */
  async getTrending(opciones) {
    const datos = await datosDe('', opciones)
    const destacados = (datos.featured ?? []) as readonly MediaCruda[]

    const resultados = []
    for (const media of destacados) {
      const titulo = texto(media.title)
      const slug = texto(media.slug)
      if (titulo === undefined || slug === undefined) continue

      const caratula = portada(media)
      const estreno = anio(media.startDate)
      const tipo = tipoDe(media.category?.slug)

      resultados.push({
        ref: refAnime(slug),
        title: titulo,
        ...(caratula === undefined ? {} : { coverUrl: caratula }),
        ...(estreno === undefined ? {} : { year: estreno }),
        ...(tipo === undefined ? {} : { kind: tipo }),
      })
    }

    return resultados
  },
}

export default proveedor

/**
 * Proveedor de AnimeX (animex.one): anime subtitulado y doblado en inglés.
 *
 * Es la única fuente de las que usa `ani-cli-mx` que tiene **API de verdad**: el
 * catálogo va por GraphQL y los episodios, los servidores y los enlaces por REST en
 * `pp.animex.one`. No hay HTML que parsear en ninguna parte, y eso quita de en
 * medio la mitad de los fallos de un plugin: cuando algo cambia, cambia el nombre
 * de un campo y el contrato lo dice, en vez de devolver una lista vacía.
 *
 * Lo que se comprobó en vivo el 12 de octubre de 2026, antes de escribir esto:
 *
 *   POST https://graphql.animex.one/graphql   searchAnime y anime
 *   GET  https://pp.animex.one/rest/api/episodes?id=<id>
 *   GET  https://pp.animex.one/rest/api/servers?id=<id>&epNum=<n>&type=sub|dub
 *   GET  https://pp.animex.one/rest/api/sources?id=<id>&epNum=<n>&type=<t>&providerId=<p>
 *
 * La API REST devuelve, por fuente, la `url`, su `quality`, su `type` MIME y las
 * cabeceras que hay que usar. Dos cosas que se midieron y condicionan el código:
 * el host del manifiesto **ata el token al `User-Agent` que pidió el token**, así
 * que el plugin declara el mismo agente que usa para hablar con la API; y las
 * pistas de subtítulos del JSON **no se devuelven**, porque su host contesta 403
 * desde Cloudflare a cualquier petición que salga de aquí.
 *
 * Un plugin se ejecuta con tus permisos y sin sandbox. Ver SECURITY.md antes de
 * confiar en uno.
 */

import type { CallOptions, PluginFetch, PluginResponse, Provider, ProviderResponse } from '@nn-anime/provider-sdk'

/*
 * Los tipos del dominio, derivados de los schemas de respuesta del SDK: el
 * contrato se comprueba por estructura y este archivo vive fuera del repositorio
 * de la aplicación, donde `@nn-anime/core` no se resuelve.
 */
type Acierto = ProviderResponse<'search'>[number]
type Ficha = ProviderResponse<'getAnime'>
type Episodio = ProviderResponse<'getEpisodes'>[number]
type Fuente = ProviderResponse<'resolveStream'>[number]
type PeticionStream = Parameters<Provider['resolveStream']>[0]

const ID = 'animex'
const GQL = 'https://graphql.animex.one/graphql'
const API = 'https://pp.animex.one'
const REFR = 'https://animex.one'

/**
 * El sitio es un proxy de AniList: el catálogo, las portadas y las sinopsis vierten
 * de ahí, y las peticiones van sin credencial alguna. AniList no exige nada, pero
 * la API sí distingue de dónde viene la petición.
 */
const AGENTE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0'


/** Cuántos resultados se piden al buscador. El de ani-cli-mx pide 12. */
const LIMITE_BUSQUEDA = 24

/** Los campos que se piden al catálogo, en un solo sitio para que no divergan. */
const CAMPOS = `
  id
  titleRomaji
  titleEnglish
  episodeCount
  seasonYear
  format
  status
  duration
  description
  coverImage
  genres
  studios
`

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
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  uuml: 'ü',
  ntilde: 'ñ',
  iquest: '¿',
  iexcl: '¡',
}

/* ------------------------------------------------------------------- red */

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

interface ExtraDePeticion {
  readonly metodo?: 'GET' | 'POST'
  readonly cuerpo?: string
}

async function pedir(
  url: string,
  opciones: CallOptions,
  extra: ExtraDePeticion = {},
): Promise<string> {
  const respuesta = await redDe(opciones)(url, {
    method: extra.metodo ?? 'GET',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': AGENTE,
      // La API contesta 403 sin decir de dónde viene la petición: el referrer y el
      // origen del sitio no son opcionales.
      referer: `${REFR}/`,
      origin: REFR,
    },
    ...(extra.cuerpo === undefined ? {} : { body: extra.cuerpo }),
    maxBytes: TOPE_CUERPO_BYTES,
  })

  if (!esEstadoOk(respuesta)) throw new Error(`AnimeX respondió ${respuesta.status} en ${url}`)

  return await cuerpo(respuesta)
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

/** Una consulta al catálogo. Un error de GraphQL se cuenta con su mensaje. */
async function consultar(
  documento: string,
  variables: Record<string, unknown>,
  opciones: CallOptions,
): Promise<Record<string, unknown>> {
  const crudo = await pedir(GQL, opciones, {
    metodo: 'POST',
    cuerpo: JSON.stringify({ query: documento, variables }),
  })

  let json: { data?: unknown; errors?: readonly { message?: string }[] }
  try {
    json = JSON.parse(crudo) as typeof json
  } catch {
    throw new Error('AnimeX devolvió algo que no es JSON en el catálogo')
  }

  const errores = json.errors ?? []
  if (errores.length > 0) {
    const motivo = errores.map((error) => error.message ?? 'sin mensaje').join('; ')
    throw new Error(`AnimeX rechazó la consulta: ${motivo}`)
  }

  if (typeof json.data !== 'object' || json.data === null) {
    throw new Error('AnimeX devolvió una respuesta sin datos')
  }

  return json.data as Record<string, unknown>
}

/** Una lectura de la API REST, que también es JSON. */
async function leerJson(url: string, opciones: CallOptions): Promise<unknown> {
  const crudo = await pedir(url, opciones)
  try {
    return JSON.parse(crudo)
  } catch {
    throw new Error(`AnimeX devolvió algo que no es JSON en ${url}`)
  }
}

/* ------------------------------------------------------- campos del catálogo */

function texto(valor: unknown): string | undefined {
  if (typeof valor !== 'string') return undefined
  const limpio = valor.trim()

  return limpio === '' ? undefined : limpio
}

function numero(valor: unknown): number | undefined {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : undefined
}

function objeto(valor: unknown): Record<string, unknown> | undefined {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : undefined
}

/** Texto de una sinopsis de AniList: trae HTML, entidades y la fuente al final. */
function sinHtml(valor: unknown): string | undefined {
  const crudo = texto(valor)
  if (crudo === undefined) return undefined

  const limpio = crudo
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_todo, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_todo, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (todo, nombre: string) => ENTIDADES[nombre.toLowerCase()] ?? todo)
    .replace(/\s+/g, ' ')
    .trim()

  return limpio === '' ? undefined : limpio
}

/** Una dirección de una portada, sólo si es http o https. */
function comoUrl(valor: unknown): string | undefined {
  const crudo = texto(valor)
  if (crudo === undefined) return undefined

  try {
    const url = new URL(crudo)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/** La portada: el catálogo da tres tamaños y se prefiere el grande. */
function portadaDe(fila: Record<string, unknown>): string | undefined {
  const imagenes = objeto(fila.coverImage)
  if (imagenes === undefined) return undefined

  return (
    comoUrl(imagenes.extraLarge) ?? comoUrl(imagenes.large) ?? comoUrl(imagenes.medium)
  )
}

/**
 * El vocabulario del catálogo al del contrato.
 *
 * AniList llama `TV_SHORT` y `SPECIAL` a cosas que aquí son especiales, y `ONA` no
 * es `OVA`: son el mismo tipo de entrega por otra puerta. Lo que no se reconoce
 * cae en `tv`, que es lo que más abunda y lo que menos miente.
 */
function tipoDe(format: unknown): 'tv' | 'movie' | 'ova' | 'ona' | 'special' {
  switch (texto(format)?.toUpperCase()) {
    case 'MOVIE':
      return 'movie'
    case 'OVA':
      return 'ova'
    case 'ONA':
      return 'ona'
    case 'SPECIAL':
    case 'TV_SHORT':
      return 'special'
    default:
      return 'tv'
  }
}

function estadoDe(status: unknown): 'airing' | 'finished' | 'upcoming' | undefined {
  switch (texto(status)?.toUpperCase()) {
    case 'RELEASING':
      return 'airing'
    case 'FINISHED':
      return 'finished'
    case 'NOT_YET_RELEASED':
      return 'upcoming'

    // `CANCELLED` y `HIATUS` existen en el catálogo y el contrato no los nombra:
    // inventar un estado es peor que no decir ninguno.
    default:
      return undefined
  }
}

function listaDeTextos(valor: unknown): readonly string[] {
  if (!Array.isArray(valor)) return []

  return valor
    .map((uno) => texto(uno))
    .filter((uno): uno is string => uno !== undefined)
}

function filaDe(crudo: unknown): Record<string, unknown> | undefined {
  return objeto(crudo)
}

function aResultado(fila: Record<string, unknown>): Acierto | undefined {
  const ref = texto(fila.id)
  if (ref === undefined) return undefined

  const romaji = texto(fila.titleRomaji)
  const ingles = texto(fila.titleEnglish)
  const titulo = ingles ?? romaji
  if (titulo === undefined) return undefined

  const portada = portadaDe(fila)
  const anio = numero(fila.seasonYear)

  return {
    ref: { providerId: ID, value: ref },
    title: titulo,
    ...(romaji === undefined || romaji === titulo ? {} : { titleAlt: romaji }),
    ...(portada === undefined ? {} : { coverUrl: portada }),
    ...(anio === undefined ? {} : { year: anio }),
    kind: tipoDe(fila.format),
  }
}

/* --------------------------------------------------------------- episodios */

function refEpisodio(anime: string, numeroEpisodio: number): { providerId: string; value: string } {
  return { providerId: ID, value: `${anime}#${numeroEpisodio}` }
}

function partirEpisodio(valor: string): { anime: string; numero: number } | undefined {
  const corte = valor.lastIndexOf('#')
  if (corte <= 0) return undefined

  const anime = valor.slice(0, corte)
  const numeroEpisodio = Number(valor.slice(corte + 1))

  if (anime === '' || !Number.isInteger(numeroEpisodio) || numeroEpisodio < 0) return undefined

  return { anime, numero: numeroEpisodio }
}

interface EpisodioCrudo {
  readonly number?: unknown
  readonly titles?: unknown
  readonly img?: unknown
}

/** El título de un episodio: el catálogo da un mapa por idioma y se prefiere el inglés. */
function tituloDeEpisodio(fila: EpisodioCrudo): string | undefined {
  const titulos = objeto(fila.titles)
  if (titulos === undefined) return undefined

  return texto(titulos.en) ?? texto(titulos['x-jat']) ?? texto(titulos.ja)
}

/* ------------------------------------------------------------------ fuentes */

interface ServidorCrudo {
  readonly id?: unknown
  readonly default?: unknown
}

/** Los proveedores que el sitio ofrece para un episodio, el de por defecto primero. */
function proveedoresDe(crudo: unknown, tipo: 'sub' | 'dub'): readonly string[] {
  const objetoRespuesta = objeto(crudo)
  if (objetoRespuesta === undefined) return []

  const clave = tipo === 'dub' ? 'dubProviders' : 'subProviders'
  const lista = objetoRespuesta[clave]
  if (!Array.isArray(lista)) return []

  const servidores = lista
    .map((uno) => objeto(uno) as ServidorCrudo | undefined)
    .filter((uno): uno is ServidorCrudo => uno !== undefined)

  const porDefecto = servidores.filter((uno) => uno.default === true)
  const resto = servidores.filter((uno) => uno.default !== true)

  return [...porDefecto, ...resto]
    .map((uno) => texto(uno.id))
    .filter((uno): uno is string => uno !== undefined)
}

interface FuenteCruda {
  readonly url?: unknown
  readonly quality?: unknown
  readonly type?: unknown
}

/** El tipo de flujo: la API dice el MIME, y manda sobre la extensión de la URL. */
function claseDe(fuente: FuenteCruda): 'hls' | 'file' {
  const mime = texto(fuente.type)?.toLowerCase() ?? ''
  if (mime.includes('mpegurl') || mime.includes('m3u8')) return 'hls'

  const url = texto(fuente.url)?.toLowerCase() ?? ''
  if (url.includes('.m3u8')) return 'hls'
  if (/\.(mp4|mkv|webm)(\?|$)/.test(url)) return 'file'

  // Una lista HLS disfrazada —el sitio publica `…/deeznuts.txt?token=…`— no se
  // distingue por la extensión; el MIME ya la delató arriba, y si tampoco viniera,
  // esto se trata como archivo progresivo, que es lo que el reproductor prueba.
  return 'file'
}

/**
 * Los nombres de cabecera que la API puede dictar para pedir el medio.
 *
 * Son las que el host del manifiesto mira —el `Referer` y el agente— y ninguna
 * más. Sin esta lista, un `Host`, un `Cookie` o un `Authorization` los elegiría
 * el tercero que contesta a la API, no este plugin, y ninguno de los tres hace
 * falta para reproducir. Añadir uno nuevo es una línea.
 */
const CABECERAS_QUE_SE_REENVIAN: ReadonlySet<string> = new Set([
  'referer',
  'referrer',
  'origin',
  'user-agent',
  'accept',
  'accept-language',
  'range',
])

/** Las cabeceras que la API exige para esa fuente, si exige alguna. */
function cabecerasDe(crudo: unknown): Readonly<Record<string, string>> {
  const objetoCabeceras = objeto(crudo)
  if (objetoCabeceras === undefined) return {}

  const salida: Record<string, string> = {}
  for (const [clave, valor] of Object.entries(objetoCabeceras)) {
    if (!CABECERAS_QUE_SE_REENVIAN.has(clave.toLowerCase())) continue

    const limpio = texto(valor)
    if (limpio !== undefined) salida[clave] = limpio
  }

  return salida
}

/**
 * Las cabeceras con las que hay que pedir el archivo de video.
 *
 * La API suele devolver `{}` y el host del manifiesto **ata el token al
 * `User-Agent` con el que se pidió ese token**: medido, la misma URL responde 200
 * si el agente de la petición al manifiesto es el mismo que el de la petición a la
 * API, y 403 si no lo es —o si falta—. Por eso, cuando la API no dice ninguna
 * cabecera, se declara aquí el mismo agente que usa este archivo para hablar con
 * ella; si la API sí las manda, ésas son las buenas y no se toca ninguna.
 */
function cabecerasDeMedio(crudo: unknown): Readonly<Record<string, string>> {
  const declaradas = cabecerasDe(crudo)
  const tieneAgente = Object.keys(declaradas).some((clave) => clave.toLowerCase() === 'user-agent')

  return tieneAgente ? declaradas : { ...declaradas, 'User-Agent': AGENTE }
}

/* ------------------------------------------------------------------ proveedor */

const proveedor: Provider = {
  id: ID,
  name: 'AnimeX',
  apiVersion: '1',
  /*
   * `trending` en falso aunque el catálogo tenga ordenaciones: no se ha medido
   * ninguna, y una capacidad declarada sin comprobar ofrece un botón que no lleva a
   * ninguna parte. `feed` tampoco: no hay lista de novedades con fecha.
   */
  capabilities: { search: true, sub: true, dub: true, trending: false, feed: false },

  /**
   * La búsqueda es una consulta al catálogo, y `searchAnime` está pensado para
   * esto: coincide por título en romaji, en inglés y en sinónimos.
   */
  async search(query, opciones): Promise<readonly Acierto[]> {
    const datos = await consultar(
      `query Buscar($query: String!, $limit: Int) { searchAnime(query: $query, limit: $limit) { items { ${CAMPOS} } } }`,
      { query, limit: LIMITE_BUSQUEDA },
      opciones,
    )

    const conexion = objeto(datos.searchAnime)
    const items = conexion?.items
    const lista = Array.isArray(items) ? items : []

    return lista
      .map((uno) => aResultado(filaDe(uno) ?? {}))
      .filter((uno): uno is Acierto => uno !== undefined)
  },

  /**
   * La ficha sale del mismo catálogo, por identificador: no hay que abrir ninguna
   * página del sitio ni adivinar un slug.
   */
  async getAnime(ref, opciones): Promise<Ficha> {
    const datos = await consultar(
      `query Ficha($id: String) { anime(id: $id) { ${CAMPOS} } }`,
      { id: ref.value },
      opciones,
    )

    const fila = filaDe(datos.anime)
    const titulo = texto(fila?.titleEnglish) ?? texto(fila?.titleRomaji)
    if (fila === undefined || titulo === undefined) {
      throw new Error(`AnimeX no tiene el título ${ref.value}`)
    }

    const romaji = texto(fila.titleRomaji)
    const portada = portadaDe(fila)
    const sinopsis = sinHtml(fila.description)
    const anio = numero(fila.seasonYear)
    const episodios = numero(fila.episodeCount)
    const estado = estadoDe(fila.status)

    return {
      ref,
      title: titulo,
      ...(romaji === undefined || romaji === titulo ? {} : { titleAlt: romaji }),
      ...(portada === undefined ? {} : { coverUrl: portada }),
      ...(sinopsis === undefined ? {} : { synopsis: sinopsis }),
      ...(anio === undefined ? {} : { year: anio }),
      ...(episodios === undefined || episodios < 0 ? {} : { episodeCount: episodios }),
      ...(estado === undefined ? {} : { status: estado }),
      kind: tipoDe(fila.format),
      genres: [...listaDeTextos(fila.genres)],
      studios: [...listaDeTextos(fila.studios)],
    }
  },

  /**
   * La lista de episodios de la API REST, que trae el número y el título.
   *
   * Se anuncia como subtitulado porque la lista no distingue variantes: el doblaje
   * se resuelve al reproducir, que es donde el dato existe. Es la misma decisión
   * que toma el plugin de AnimeAV1.
   */
  async getEpisodes(ref, opciones): Promise<readonly Episodio[]> {
    const crudo = await leerJson(`${API}/rest/api/episodes?id=${encodeURIComponent(ref.value)}`, opciones)
    if (!Array.isArray(crudo)) {
      throw new Error(`AnimeX no listó episodios de ${ref.value}`)
    }

    const salida: Episodio[] = []
    for (const uno of crudo) {
      const fila = objeto(uno) as EpisodioCrudo | undefined
      const numeroEpisodio = numero(fila?.number)
      if (fila === undefined || numeroEpisodio === undefined) continue

      const titulo = tituloDeEpisodio(fila)
      salida.push({
        ref: refEpisodio(ref.value, numeroEpisodio),
        animeRef: ref,
        number: numeroEpisodio,
        ...(titulo === undefined ? {} : { title: titulo }),
        mode: 'sub',
      })
    }

    if (salida.length === 0) {
      throw new Error(`AnimeX no dio ningún episodio de ${ref.value}`)
    }

    return salida.sort((a, b) => a.number - b.number)
  },

  /**
   * Los enlaces del episodio, en dos pasos: qué servidores hay y qué da cada uno.
   *
   * Se prueba el servidor que el sitio marca por defecto y, si no da enlace, los
   * siguientes. Los fallos se acumulan: cuando no queda ninguno, el motivo de cada
   * uno es lo único que explica qué pasó.
   */
  async resolveStream(peticion: PeticionStream, opciones): Promise<readonly Fuente[]> {
    const partes = partirEpisodio(peticion.episodeRef.value)
    if (partes === undefined) {
      throw new Error(`la referencia ${peticion.episodeRef.value} no lleva un episodio`)
    }

    const tipo = peticion.mode === 'dub' ? 'dub' : 'sub'
    const id = encodeURIComponent(partes.anime)
    const servidores = await leerJson(
      `${API}/rest/api/servers?id=${id}&epNum=${partes.numero}&type=${tipo}`,
      opciones,
    )

    const proveedores = proveedoresDe(servidores, tipo)
    if (proveedores.length === 0) {
      throw new Error(
        `AnimeX no publica servidores ${tipo} para ${peticion.episodeRef.value}`,
      )
    }

    const fallos: string[] = []
    for (const proveedorId of proveedores) {
      try {
        const crudo = await leerJson(
          `${API}/rest/api/sources?id=${id}&epNum=${partes.numero}&type=${tipo}&providerId=${encodeURIComponent(proveedorId)}`,
          opciones,
        )
        const respuesta = objeto(crudo)
        const fuentes = Array.isArray(respuesta?.sources) ? (respuesta.sources as unknown[]) : []
        const cabeceras = cabecerasDeMedio(respuesta?.headers)

        /*
         * Las pistas de texto del `tracks` **no** se devuelven, y es una decisión
         * medidas las dos cosas: el contrato no deja dar cabeceras por pista —así
         * que no hay forma de mandarle al host su `User-Agent`— y ese host
         * (`f0ja7.zhaevor.top`) contesta 403 «Website Access Blocked» desde
         * Cloudflare a cualquier petición que salga de aquí, con o sin agente. Una
         * pista que nunca carga es un botón que no lleva a ninguna parte; el día que
         * ese host las sirva, volver a leerlas es el `tracks` del mismo JSON.
         */
        const salida: Fuente[] = []
        for (const una of fuentes) {
          const fuente = objeto(una) as FuenteCruda | undefined
          const url = comoUrl(fuente?.url)
          if (fuente === undefined || url === undefined) continue

          const calidad = texto(fuente.quality)
          salida.push({
            url,
            kind: claseDe(fuente),
            // `auto` no es una calidad: es «la que sea», y decirla sería prometer
            // algo que no se sabe.
            ...(calidad === undefined || calidad.toLowerCase() === 'auto' ? {} : { quality: calidad }),
            headers: cabeceras,
          })
        }

        if (salida.length > 0) return salida
        fallos.push(`${proveedorId}: no dio ningún enlace`)
      } catch (causa) {
        fallos.push(`${proveedorId}: ${causa instanceof Error ? causa.message : String(causa)}`)
      }
    }

    throw new Error(
      `AnimeX no dio ninguna fuente para ${peticion.episodeRef.value} (${fallos.join('; ')})`,
    )
  },
}

export default proveedor

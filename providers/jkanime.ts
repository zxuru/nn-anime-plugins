/**
 * Proveedor de jkanime para nn-anime.
 *
 * Vive en `~/.config/nn-anime/providers/` y no en el repositorio: nn-anime no
 * incluye scrapers y este archivo sí lo es. Se copia, se reinicia y basta.
 *
 * Sólo hay `import type`, y el único módulo que se nombra es
 * `@nn-anime/provider-sdk`: los tipos se borran al ejecutar, que es lo que
 * permite cargar este archivo desde el directorio del usuario, donde el paquete
 * no se resuelve.
 *
 * Tres cosas del sitio condicionan el código:
 *
 * 1. **La lista de episodios no está en el HTML de la ficha.** Se pide por POST
 *    a `ajax/episodes/{id}/{página}` con el token CSRF de la ficha **y su misma
 *    cookie de sesión**: Laravel compara los dos, así que una petición sin la
 *    pareja responde 419 y no hay lista. Por eso `getEpisodes` lee la ficha una
 *    vez y reutiliza token y galletas en todas las páginas.
 * 2. **Los reproductores son iframes firmados y caducan.** El servidor `um`
 *    publica un `.m3u8` con su firma y su hora de caducidad, y `jk` un MP4 detrás
 *    de una redirección temporal. Se resuelven en **cada** reproducción y no se
 *    guardan en ninguna caché: un enlace de ayer no sirve hoy.
 * 3. **La portada da fechas relativas**, no marcas de tiempo: «Ayer», «Viernes
 *    09». Sólo se convierte la etiqueta cuando no admite dos lecturas; cuando la
 *    admite, la entrada va sin fecha y conserva el orden de la fuente, que es lo
 *    que el contrato pide en vez de inventar una fecha.
 */

import type { CallOptions, Provider, ProviderResponse } from '@nn-anime/provider-sdk'

/*
 * Los tipos del dominio, nombrados aquí y no importados de `@nn-anime/core`.
 *
 * El SDK no reexporta la superficie del dominio —el contrato la comprueba por
 * estructura—, así que un plugin que vive fuera del repositorio no puede
 * importarla. Se derivan de los mismos schemas que validan las respuestas: lo
 * que el SDK acepta y lo que este archivo declara son la misma forma, no dos.
 */
type Acierto = ProviderResponse<'search'>[number]
type Ficha = ProviderResponse<'getAnime'>
type Episodio = ProviderResponse<'getEpisodes'>[number]
type Fuente = ProviderResponse<'resolveStream'>[number]
type Novedad = ProviderResponse<'getFeed'>[number]
type PeticionStream = Parameters<Provider['resolveStream']>[0]
type Referencia = PeticionStream['episodeRef']

const ID = 'jkanime'
const BASE = 'https://jkanime.net'
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Lo que se usa si el llamante no sugiere nada. */
const TIMEOUT_POR_DEFECTO_MS = 8000
/** El paginador de Laravel sirve 16 por página: `last_page` se lee, no se supone. */
const EPISODIOS_POR_PAGINA = 16
/** Series de más de mil episodios existen; esto acota el trabajo por si el sitio miente. */
const TOPE_EPISODIOS = 2000
/** Páginas en vuelo a la vez: la lista de una serie larga no puede costar un minuto. */
const PAGINAS_EN_PARALELO = 5

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
  deg: '°',
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

/** Quita acentos y pasa a minúsculas: el sitio escribe «Pelicula» y «Película». */
function normaliza(valor: string): string {
  return valor
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
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

/** El primer grupo que capture `patron`, ya limpio. */
function busca(html: string, patron: RegExp): string | undefined {
  const encontrado = patron.exec(html)?.[1]
  if (encontrado === undefined) return undefined

  const valor = limpio(encontrado)
  return valor === '' ? undefined : valor
}

/** Una dirección del sitio sólo se acepta si es http o https con host. */
function comoUrl(valor: string | undefined): string | undefined {
  if (valor === undefined) return undefined

  try {
    const url = new URL(valor)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

const TIPOS: Readonly<Record<string, 'tv' | 'movie' | 'ova' | 'ona' | 'special'>> = {
  serie: 'tv',
  pelicula: 'movie',
  ova: 'ova',
  ona: 'ona',
  especial: 'special',
}

function tipoDe(valor: string | undefined): 'tv' | 'movie' | 'ova' | 'ona' | 'special' | undefined {
  return valor === undefined ? undefined : TIPOS[normaliza(valor)]
}

const ESTADOS: Readonly<Record<string, 'airing' | 'finished' | 'upcoming'>> = {
  'en emision': 'airing',
  'en emisión': 'airing',
  concluido: 'finished',
  finalizado: 'finished',
  proximamente: 'upcoming',
  próximamente: 'upcoming',
}

function estadoDe(valor: string | undefined): 'airing' | 'finished' | 'upcoming' | undefined {
  return valor === undefined ? undefined : ESTADOS[normaliza(valor)]
}

/**
 * Rutas del sitio que no son títulos.
 *
 * Un listado comparte página con enlaces a secciones, y una de esas direcciones
 * convertida en `ref` sería una ficha que no existe: `getAnime` pediría
 * `/genero/accion/` y devolvería un catálogo entero como si fuera un título.
 */
const RUTAS: ReadonlySet<string> = new Set([
  'aplicacion',
  'ajax',
  'buscar',
  'comunidad',
  'dash',
  'directorio',
  'estrenos',
  'genero',
  'guardado',
  'historial',
  'horario',
  'idioma',
  'jkplayer',
  'notificaciones',
  'pedidos',
  'studio',
  'temporada',
  'top',
])

/** El `slug` de la primera ruta de una URL del sitio: `/naruto/1/` da `naruto`. */
function slugDe(url: string | undefined): string | undefined {
  if (url === undefined) return undefined

  const encontrado = /^https?:\/\/jkanime\.net\/([a-z0-9][a-z0-9-]*)(?:\/|$)/.exec(url)?.[1]
  if (encontrado === undefined || RUTAS.has(encontrado)) return undefined

  return encontrado
}

// ---------------------------------------------------------------------------
// Guardas de red, de credenciales y de tamaño
// ---------------------------------------------------------------------------

/**
 * Credenciales que viajan dentro de una dirección.
 *
 * El motor que carga este plugin redacta **por nombre de clave**, así que una
 * credencial metida dentro de una cadena no la ve nadie más que quien la
 * escribe: la firma de un `.m3u8` o el testigo de un espejo acabarían en el
 * mensaje de un fallo y de ahí a una captura de pantalla. Se quitan aquí, que es
 * el único sitio que construye ese texto.
 */
const CREDENCIAL_EN_URL = /([?&](?:api_key|apikey|key|token|expires|asn|signature|sig|hash|auth)=)[^&#\s]*/gi

function sinCredenciales(url: string): string {
  return url.replace(CREDENCIAL_EN_URL, '$1[redactado]')
}

/**
 * Destinos que un reproductor de internet no necesita y una página hostil sí.
 *
 * La dirección de la siguiente petición la elige el contenido del sitio —el
 * `<iframe>` del reproductor—, así que sin esta guarda una página comprometida
 * puede hacer que el plugin pida `http://127.0.0.1:8080/…`, un servicio de la
 * red de casa o la metadata de la nube, desde la máquina de quien lo copia. El
 * proxy del motor tiene su propia comprobación de destinos, pero no cubre estas
 * peticiones: el plugin no pasa por él.
 *
 * Es una comprobación **literal**, aunque `new URL` normaliza las formas raras
 * de escribir una dirección (`127.1`, `2130706433`, `0x7f.1`) y por eso no se
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

/**
 * Una referencia del motor convertida en ruta.
 *
 * Las referencias llegan como cadenas opacas, y lo que no puede llegar es un
 * `..` que mueva la petición a otra ruta del sitio ni un `?` o un `#` que le
 * cambien la consulta: la petición del paginador viaja con la cookie de sesión y
 * el token CSRF. Cada tramo se codifica y los tramos `.` y `..` se rechazan.
 */
function rutaDe(valor: string): string {
  const tramos = valor.split('/')
  if (/[?#\\\u0000-\u001f]/.test(valor) || tramos.some((tramo) => tramo === '.' || tramo === '..')) {
    throw new Error(`la referencia '${valor}' no es una ruta válida`)
  }

  return tramos.map((tramo) => encodeURIComponent(tramo)).join('/')
}

/**
 * Tope del cuerpo de una respuesta.
 *
 * Un sitio hostil puede contestar con gigabytes y `text()` los materializa
 * enteros en el proceso que sirve la aplicación. Ocho megas son más que
 * cualquier ficha o listado de este sitio, y menos que lo que hace daño. La
 * cabecera `content-length` se mira como aviso, pero la cuenta que manda es la
 * de los bytes que llegan: puede faltar o venir comprimida.
 */
const TOPE_CUERPO_BYTES = 8 * 1024 * 1024

/** El texto de una respuesta, cortando si pasa del tope. */
async function cuerpo(respuesta: Response): Promise<string> {
  const declarado = Number(respuesta.headers.get('content-length') ?? '')
  if (Number.isFinite(declarado) && declarado > TOPE_CUERPO_BYTES) {
    throw new Error(`la respuesta declara ${declarado} bytes y el tope es ${TOPE_CUERPO_BYTES}`)
  }

  const lector = respuesta.body?.getReader()
  if (lector === undefined) return ''

  const trozos: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await lector.read()
    if (done === true) break
    if (value === undefined) continue

    total += value.byteLength
    if (total > TOPE_CUERPO_BYTES) {
      // Se corta sin terminar de leer y se suelta el cuerpo, para no dejar la
      // conexión abierta con el sitio.
      await lector.cancel().catch(() => undefined)
      throw new Error(`la respuesta pasa de ${TOPE_CUERPO_BYTES} bytes y se corta`)
    }

    trozos.push(value)
  }

  const unido = new Uint8Array(total)
  let desplazamiento = 0
  for (const trozo of trozos) {
    unido.set(trozo, desplazamiento)
    desplazamiento += trozo.byteLength
  }

  return new TextDecoder().decode(unido)
}

interface Peticion {
  readonly metodo?: string
  readonly cuerpo?: string
  readonly galletas?: string
  readonly referer?: string
}

/** Cuánto se deja de pedirle al sitio después de un 429. */
const PAUSA_429_MS = 65_000

/**
 * Hasta cuándo no se le pide nada al sitio.
 *
 * El sitio limita por ráfaga y responde 429: seguir insistiendo alarga el
 * castigo y convierte un episodio sin fuente en un episodio sin fuente durante
 * media hora. Con la pausa, la siguiente petición ni sale —y el error dice
 * cuándo se reanuda— en vez de gastar el turno en otro 429.
 */
let reanudarEn = 0

/**
 * Una petición al sitio, con el timeout del contrato aplicado **a cada una**.
 *
 * El timeout del contrato es por llamada, no por petición: una lista de
 * episodios son varias. Se aplica a cada petición para que una que se cuelgue no
 * se lleve por delante a las demás, y `AbortSignal.any` conserva la cancelación
 * del usuario, que llega en `options.signal`.
 */
async function pedir(
  url: string,
  options: CallOptions,
  peticion: Peticion = {},
): Promise<Response> {
  const espera = reanudarEn - Date.now()
  if (espera > 0) {
    throw new Error(
      `jkanime está limitando las peticiones; se reanuda en ${Math.ceil(espera / 1000)} s`,
    )
  }

  const ms = options.timeoutMs > 0 ? options.timeoutMs : TIMEOUT_POR_DEFECTO_MS
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(ms)])
  const cabeceras: Record<string, string> = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'es-ES,es;q=0.9',
  }

  if (peticion.cuerpo !== undefined) cabeceras['content-type'] = 'application/x-www-form-urlencoded'
  if (peticion.galletas !== undefined) cabeceras.cookie = peticion.galletas
  if (peticion.referer !== undefined) cabeceras.referer = peticion.referer

  const respuesta = await fetch(url, {
    method: peticion.metodo ?? 'GET',
    headers: cabeceras,
    ...(peticion.cuerpo === undefined ? {} : { body: peticion.cuerpo }),
    redirect: 'follow',
    signal,
  })

  if (respuesta.status === 429) {
    reanudarEn = Date.now() + PAUSA_429_MS

    throw new Error(
      `jkanime respondió 429 en ${sinCredenciales(url)}; no se le pedirá nada en ${PAUSA_429_MS / 1000} s`,
    )
  }

  if (!respuesta.ok) {
    throw new Error(`jkanime respondió ${respuesta.status} en ${sinCredenciales(url)}`)
  }

  return respuesta
}

/** Las galletas de una respuesta como `nombre=valor; nombre=valor`. */
function galletasDe(respuesta: Response): string {
  return respuesta.headers
    .getSetCookie()
    .map((galleta) => galleta.split(';')[0] ?? '')
    .filter((par) => par.includes('='))
    .join('; ')
}

function objetosDe(crudo: unknown, clave: string): readonly unknown[] {
  if (typeof crudo !== 'object' || crudo === null) return []

  const valor = Reflect.get(crudo, clave)
  return Array.isArray(valor) ? valor : []
}

function numeroDe(crudo: unknown, clave: string): number | undefined {
  if (typeof crudo !== 'object' || crudo === null) return undefined

  const valor = Reflect.get(crudo, clave)
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : undefined
}

function cadenaDe(crudo: unknown, clave: string): string | undefined {
  if (typeof crudo !== 'object' || crudo === null) return undefined

  const valor = Reflect.get(crudo, clave)
  return typeof valor === 'string' && valor.trim() !== '' ? valor : undefined
}

// ---------------------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------------------

/**
 * Las tarjetas de un listado de resultados.
 *
 * Se recorta primero al contenedor de resultados: la misma página lleva
 * secciones con la misma tarjeta —recomendaciones, lo último añadido— y sin el
 * recorte una búsqueda devolvería la mitad de la portada. Después se parte por
 * `class="anime__item"` y se lee cada tarjeta por separado, en vez de recorrer
 * el documento entero con una expresión regular: un título con un `<h5>` dentro
 * no puede llevarse por delante al título de la tarjeta siguiente.
 */
function tarjetas(html: string): readonly Acierto[] {
  const salida: Acierto[] = []
  const contenedor = html.slice(html.indexOf('page_directorio'))
  const recorte = contenedor.indexOf('</section>')

  for (const bloque of (recorte < 0 ? contenedor : contenedor.slice(0, recorte))
    .split('class="anime__item"')
    .slice(1)) {
    const url = /<a\s+href="([^"]+)"/.exec(bloque)?.[1]
    const slug = slugDe(url)
    const titulo = busca(bloque, /<h5><a[^>]*>([\s\S]*?)<\/a><\/h5>/)
    if (slug === undefined || titulo === undefined) continue

    const portada = comoUrl(/data-setbg="([^"]+)"/.exec(bloque)?.[1])
    const tipo = tipoDe(busca(bloque, /<li class="anime">([\s\S]*?)<\/li>/))

    salida.push({
      ref: { providerId: ID, value: slug },
      title: titulo,
      ...(portada === undefined ? {} : { coverUrl: portada }),
      ...(tipo === undefined ? {} : { kind: tipo }),
    })
  }

  return salida
}

// ---------------------------------------------------------------------------
// Ficha
// ---------------------------------------------------------------------------

/** Los nombres de un `<li>` de la ficha: «Generos:» y «Studios:» son listas de enlaces. */
function enlacesDe(html: string, etiqueta: string): readonly string[] {
  const bloque = new RegExp(`<li>\\s*<span>${etiqueta}:</span>([\\s\\S]*?)</li>`).exec(html)?.[1]
  if (bloque === undefined) return []

  return [...bloque.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)]
    .map((encontrado) => limpio(encontrado[1] ?? ''))
    .filter((nombre) => nombre !== '')
}

function detalle(ref: Referencia, html: string): Ficha {
  const titulo =
    busca(html, /anime_info[\s\S]{0,400}?<h3>([\s\S]*?)<\/h3>/) ??
    busca(html, /<meta property="og:title" content="([^"]*)"/)
  if (titulo === undefined) throw new Error(`la ficha de ${ref.value} no trae título`)

  const portada =
    comoUrl(/<meta property="og:image" content="([^"]*)"/.exec(html)?.[1]) ??
    comoUrl(/class="movpic"[^>]*>\s*<img src="([^"]+)"/.exec(html)?.[1])
  const sinopsis = busca(html, /<p class="scroll">([\s\S]*?)<\/p>/)
  const tipo = tipoDe(busca(html, /rel="tipo"><span>Tipo:<\/span>\s*([^<]*)/))
  const estado = estadoDe(busca(html, /class="enemision [a-z]+">([\s\S]*?)<\/div>/))
  const episodios = Number.parseInt(busca(html, /Episodios:<\/span>\s*(\d+)/) ?? '', 10)
  const anio = Number.parseInt(/temporada\/[^"]*">[^<]*?(\d{4})<\/a>/.exec(html)?.[1] ?? '', 10)

  return {
    ref,
    title: titulo,
    ...(portada === undefined ? {} : { coverUrl: portada }),
    ...(sinopsis === undefined ? {} : { synopsis: sinopsis }),
    ...(tipo === undefined ? {} : { kind: tipo }),
    ...(estado === undefined ? {} : { status: estado }),
    ...(Number.isInteger(anio) && anio > 1900 ? { year: anio } : {}),
    ...(Number.isInteger(episodios) && episodios > 0 ? { episodeCount: episodios } : {}),
    genres: [...enlacesDe(html, 'Generos')],
    studios: [...enlacesDe(html, 'Studios')],
  }
}

// ---------------------------------------------------------------------------
// Episodios
// ---------------------------------------------------------------------------

interface Sesion {
  readonly id: string
  readonly token: string
  readonly galletas: string
}

/** El id numérico, el token CSRF y las galletas: la pareja que exige el POST. */
function sesionDe(html: string, galletas: string): Sesion {
  const id = busca(html, /id="guardar-anime"[^>]*data-anime="(\d+)"/)
  const token = busca(html, /name="csrf-token" content="([^"]+)"/)
  if (id === undefined || token === undefined) {
    throw new Error('la ficha no trae id de anime o token CSRF; el sitio cambió')
  }

  return { id, token, galletas }
}

async function listadoDeEpisodios(
  sesion: Sesion,
  anime: string,
  pagina: number,
  options: CallOptions,
): Promise<unknown> {
  const url = `${BASE}/ajax/episodes/${sesion.id}/${pagina}`
  const respuesta = await pedir(url, options, {
    metodo: 'POST',
    cuerpo: new URLSearchParams({ _token: sesion.token }).toString(),
    galletas: sesion.galletas,
    referer: `${BASE}/${rutaDe(anime)}/`,
  })

  const crudo = await cuerpo(respuesta)
  try {
    return JSON.parse(crudo) as unknown
  } catch {
    throw new Error(`jkanime no devolvió JSON en ${sinCredenciales(url)}`)
  }
}

function episodiosDe(crudo: unknown, anime: string): readonly Episodio[] {
  const salida: Episodio[] = []

  for (const fila of objetosDe(crudo, 'data')) {
    const numero = numeroDe(fila, 'number')
    // Sin exigir entero: el sitio numera los recopilatorios con decimales, y
    // descartarlos perdía el episodio sin decirlo. Tampoco se rellena un hueco:
    // lo que la fuente no numera no existe.
    if (numero === undefined || numero < 0) continue

    const titulo = cadenaDe(fila, 'title')
    salida.push({
      // El valor es la ruta del episodio: es lo único que hace falta para volver
      // a pedir su reproductor, y no depende de que el id del sitio siga igual.
      ref: { providerId: ID, value: `${anime}/${numero}` },
      animeRef: { providerId: ID, value: anime },
      number: numero,
      ...(titulo === undefined ? {} : { title: limpio(titulo) }),
      mode: 'sub',
    })
  }

  return salida
}

// ---------------------------------------------------------------------------
// Reproducción
// ---------------------------------------------------------------------------

/** Los `src` de los iframes de la página del episodio, ya absolutos. */
function reproductores(html: string): readonly string[] {
  const salida: string[] = []

  for (const encontrado of html.matchAll(/video\[\d+\]\s*=\s*'([^']*)'/g)) {
    const src = /src="([^"]+)"/.exec(encontrado[1] ?? '')?.[1]
    if (src === undefined) continue

    const url = comoUrl(src.startsWith('/') ? `${BASE}${src}` : src)
    if (url !== undefined) salida.push(url)
  }

  return salida
}

/**
 * El nombre del servidor de un reproductor, para poder nombrarlo en un fallo.
 *
 * Un fallo sin decir de qué servidor vino no sirve para nada: «no dio fuente»
 * con cuatro iframes en la página no dice cuál de los cuatro hay que mirar.
 */
function servidorDe(url: string): string {
  const partes = new URL(url).pathname.split('/').filter((parte) => parte !== '')

  return partes.at(-1) ?? url
}

/** El texto de una causa, que no tiene por qué ser un `Error`. */
function motivoDe(causa: unknown): string {
  return causa instanceof Error ? causa.message : String(causa)
}

/**
 * Lo que hay detrás de un iframe de reproductor.
 *
 * `um` y `umv` devuelven una página con el `.m3u8` firmado dentro; `jk`, un MP4
 * en `jkplayers.com` detrás de una redirección temporal. Se distingue por host y
 * no por el orden de los reproductores: una página de `um` también lleva
 * direcciones de anuncios, y colar una de ésas como fuente sería peor que no
 * ofrecer nada.
 */
async function fuenteDeJugador(
  url: string,
  referer: string,
  options: CallOptions,
): Promise<Fuente | undefined> {
  // El `<iframe>` lo eligió el sitio: si apunta a la red interna, no se pide.
  if (!destinoDeContenidoAceptable(url)) {
    throw new Error('el reproductor apunta a un destino interno o no es http(s); se descarta')
  }

  const html = await cuerpo(await pedir(url, options, { referer }))

  const hls = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/.exec(html)?.[0]
  if (hls !== undefined) {
    const firmado = comoUrl(hls)
    if (firmado !== undefined) return { url: firmado, kind: 'hls' }
  }

  const mp4 = /url:\s*'(https:\/\/jkplayers\.com\/stream\/jkmedia\/[^']+)'/.exec(html)?.[1]
  if (mp4 !== undefined) {
    const directo = comoUrl(mp4)
    if (directo !== undefined) return { url: directo, kind: 'file' }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Portada: tendencias y novedades
// ---------------------------------------------------------------------------

/** El `#N` y las tarjetas de `/top`. */
function tendencias(html: string): readonly Acierto[] {
  const salida: Acierto[] = []

  for (const bloque of html.split('class="col toplist').slice(1)) {
    const url = /<a href="([^"]+)"/.exec(bloque)?.[1]
    const slug = slugDe(url)
    const titulo = busca(bloque, /<h5 class="card-title">([\s\S]*?)<\/h5>/)
    if (slug === undefined || titulo === undefined) continue

    const portada = comoUrl(/<img class="card-img-top" src="([^"]+)"/.exec(bloque)?.[1])
    salida.push({
      ref: { providerId: ID, value: slug },
      title: titulo,
      ...(portada === undefined ? {} : { coverUrl: portada }),
    })
  }

  return salida
}

const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']

/**
 * La fecha de una etiqueta de la portada, si no admite dos lecturas.
 *
 * «Ayer» es exacto. «Viernes 09» trae dos datos —el día de la semana y el del
 * mes— y se acepta sólo si los dos coinciden en una misma fecha de los últimos
 * catorce días: sin esa comprobación, la etiqueta de un mes cerrado se leería
 * como la de este mes y la fila de novedades mentiría con fechas creíbles.
 *
 * La hora es el mediodía UTC a propósito: el orden de la fila no depende de la
 * zona horaria de quien mira, y ningún huso razonable convierte ese mediodía en
 * otro día.
 */
function fechaDeEtiqueta(etiqueta: string, ahora: Date): string | undefined {
  const texto = normaliza(etiqueta)

  if (texto === 'ayer') return mediodia(new Date(ahora.getTime() - 86_400_000))

  const encontrado = /^(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\s+(\d{1,2})$/.exec(
    texto,
  )
  if (encontrado === null) return undefined

  const indice = DIAS.indexOf(encontrado[1] ?? '')
  const numero = Number.parseInt(encontrado[2] ?? '', 10)
  if (indice < 0 || !Number.isInteger(numero)) return undefined

  for (let atras = 0; atras <= 14; atras += 1) {
    const candidato = new Date(ahora.getTime() - atras * 86_400_000)
    if (candidato.getDay() === indice && candidato.getDate() === numero) return mediodia(candidato)
  }

  // Una fecha del futuro —el día aún no ha llegado esta semana— no es una fecha
  // de publicación: la entrada va sin ella.
  return undefined
}

function mediodia(fecha: Date): string {
  return new Date(
    Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate(), 12, 0, 0),
  ).toISOString()
}

/**
 * Las novedades de la portada: lo último añadido, con su episodio.
 *
 * La entrada apunta al **título**, no al episodio: es lo que la home necesita
 * para pintar una tarjeta, y el título del anime ya lo devuelve `getAnime` con
 * el mismo `ref`, así que la caché y la ficha no pueden discrepar.
 *
 * Una serie con treinta episodios recientes ocupa treinta tarjetas de la
 * portada. Se queda la primera de cada título, que es la más nueva.
 */
function novedades(html: string, ahora: Date): readonly Novedad[] {
  const salida: Novedad[] = []
  const vistos = new Set<string>()
  const tarjeta =
    /<a href="(https:\/\/jkanime\.net\/[^"]+)"><div class="d-thumb"><img class="card-img-top" src="([^"]*)" data-animepic="([^"]*)" alt="([^"]*)"><div class="badges badges-top"><span class="badge badge-primary">([^<]*)<\/span><span class="badge ml-2 badge-secondary"><i[^>]*><\/i> ([^<]*)<\/span>/g

  for (const encontrado of html.matchAll(tarjeta)) {
    const slug = slugDe(limpio(encontrado[1] ?? ''))
    const titulo = limpio((encontrado[4] ?? '').replace(/\s+-\s+\d+\s*$/, ''))
    if (slug === undefined || titulo === '' || vistos.has(slug)) continue

    vistos.add(slug)
    const portada = comoUrl(limpio(encontrado[3] ?? ''))
    const publicada = fechaDeEtiqueta(limpio(encontrado[6] ?? ''), ahora)

    salida.push({
      ref: { providerId: ID, value: slug },
      title: titulo,
      ...(portada === undefined ? {} : { coverUrl: portada }),
      ...(publicada === undefined ? {} : { publishedAt: publicada }),
    })
  }

  return salida
}

// ---------------------------------------------------------------------------
// La ficha y su sesión
// ---------------------------------------------------------------------------

/**
 * La ficha del título y la sesión que exige el paginador.
 *
 * El `POST` de `ajax/episodes` compara el token CSRF con su cookie, así que las
 * dos cosas se piden juntas y se devuelven juntas: separarlas invita a pasar una
 * sin la otra, que es el 419 que ya costó un rato entender.
 *
 * El HTML se devuelve también porque la ficha es la única que declara cuántos
 * episodios tiene el título, y eso es el `total` de la página.
 */
async function fichaYSesion(
  anime: string,
  options: CallOptions,
): Promise<{ readonly sesion: Sesion; readonly html: string }> {
  const ficha = await pedir(`${BASE}/${rutaDe(anime)}/`, options)
  const html = await cuerpo(ficha)

  return { sesion: sesionDe(html, galletasDe(ficha)), html }
}

/** Cuántos episodios declara la ficha, si los declara. */
function totalDeFicha(html: string): number | undefined {
  const total = Number.parseInt(busca(html, /Episodios:<\/span>\s*(\d+)/) ?? '', 10)

  return Number.isInteger(total) && total > 0 ? total : undefined
}

// ---------------------------------------------------------------------------
// El proveedor
// ---------------------------------------------------------------------------

const jkanime: Provider = {
  id: ID,
  name: 'JkAnime',
  apiVersion: '1',
  // `dub` en falso porque el sitio es subtitulado: declararlo ofrecería un botón
  // que no lleva a ninguna parte. `episodePages` en verdadero porque el
  // paginador del sitio permite pedir una página, un número y el último sin
  // traer el catálogo entero: una serie de mil doscientos episodios son 76
  // peticiones si se pide la lista completa, y esa ráfaga es la que responde 429.
  capabilities: {
    search: true,
    sub: true,
    dub: false,
    trending: true,
    feed: true,
    episodePages: true,
  },

  async search(query, options) {
    const html = await cuerpo(
      await pedir(`${BASE}/buscar/${encodeURIComponent(query)}/`, options),
    )

    return tarjetas(html)
  },

  async getAnime(ref, options) {
    const html = await cuerpo(await pedir(`${BASE}/${rutaDe(ref.value)}/`, options))

    return detalle(ref, html)
  },

  async getEpisodes(ref, options) {
    const ficha = await pedir(`${BASE}/${rutaDe(ref.value)}/`, options)
    const sesion = sesionDe(await cuerpo(ficha), galletasDe(ficha))
    const primera = await listadoDeEpisodios(sesion, ref.value, 1, options)
    const ultima = Math.max(1, numeroDe(primera, 'last_page') ?? 1)
    const tope = Math.min(ultima, Math.ceil(TOPE_EPISODIOS / EPISODIOS_POR_PAGINA))

    const paginas: number[] = []
    for (let pagina = 2; pagina <= tope; pagina += 1) paginas.push(pagina)

    const resto: unknown[] = []
    for (let inicio = 0; inicio < paginas.length; inicio += PAGINAS_EN_PARALELO) {
      const lote = paginas.slice(inicio, inicio + PAGINAS_EN_PARALELO)
      resto.push(
        ...(await Promise.all(
          lote.map((pagina) => listadoDeEpisodios(sesion, ref.value, pagina, options)),
        )),
      )
    }

    // El orden de llegada depende del paralelismo, así que se ordena por número:
    // la interfaz pinta la tira en el orden en que se la den.
    const episodios = [primera, ...resto]
      .flatMap((crudo) => episodiosDe(crudo, ref.value))
      .sort((a, b) => a.number - b.number)

    return episodios
  },

  /**
   * Una página del selector.
   *
   * Dos peticiones —la ficha para el token y la página— en vez de las 76 de una
   * serie larga. `hasMore` sale de `last_page`, que el sitio publica, y no de que
   * la página venga llena: en el borde del catálogo una página puede venir corta
   * sin ser la última.
   */
  async getEpisodesPage(ref, page, options) {
    // La página la elige quien llama y termina en la ruta del paginador: o es un
    // entero positivo, o no se pide nada.
    if (!Number.isInteger(page) || page < 1) {
      throw new Error(`la página ${page} no es un número de página`)
    }

    const { sesion, html } = await fichaYSesion(ref.value, options)
    const crudo = await listadoDeEpisodios(sesion, ref.value, page, options)
    const ultima = Math.max(1, numeroDe(crudo, 'last_page') ?? 1)
    // El paginador de Laravel no siempre publica el total; la ficha sí, y ya
    // está leída. Sin ninguno de los dos, el rótulo no promete un total.
    const total = numeroDe(crudo, 'total') ?? totalDeFicha(html)

    return {
      episodes: episodiosDe(crudo, ref.value),
      page,
      hasMore: page < ultima,
      ...(total === undefined ? {} : { total }),
    }
  },

  /**
   * El episodio que se pidió por número.
   *
   * No se pide ninguna página: el sitio direcciona el episodio por su número
   * —`/{anime}/{número}/`— así que la referencia se construye. Lo único que se
   * comprueba es que el número no pase del total que la ficha declara; un hueco
   * de numeración dentro del rango lo dirá el sitio al resolver el stream, que es
   * quien sabe si ese episodio existe.
   */
  async getEpisode(ref, number, options) {
    const { html } = await fichaYSesion(ref.value, options)
    const total = totalDeFicha(html)

    if (total !== undefined && number > total) {
      throw new Error(
        `jkanime no tiene el episodio ${number} de ${ref.value}: la ficha dice ${total}`,
      )
    }

    return {
      ref: { providerId: ID, value: `${ref.value}/${number}` },
      animeRef: ref,
      number,
      mode: 'sub',
    }
  },

  /**
   * El último episodio del título.
   *
   * Es el mayor de la última página, y no el último de la lista que llegue: el
   * orden del paginador no está prometido. Con una sola página no se pide dos
   * veces la misma.
   */
  async getLatestEpisode(ref, options) {
    const { sesion } = await fichaYSesion(ref.value, options)
    const primera = await listadoDeEpisodios(sesion, ref.value, 1, options)
    const ultima = Math.max(1, numeroDe(primera, 'last_page') ?? 1)
    const crudo =
      ultima === 1 ? primera : await listadoDeEpisodios(sesion, ref.value, ultima, options)
    // La lista se copia antes de ordenar: lo que devuelve el lector es de sólo
    // lectura.
    const ultimo = [...episodiosDe(crudo, ref.value)]
      .sort((a, b) => a.number - b.number)
      .at(-1)

    if (ultimo === undefined) throw new Error(`jkanime no dio ningún episodio de ${ref.value}`)

    return ultimo
  },

  async resolveStream(request: PeticionStream, options) {
    const url = `${BASE}/${rutaDe(request.episodeRef.value)}/`
    const html = await cuerpo(await pedir(url, options))
    const fuentes: Fuente[] = []
    const vistos = new Set<string>()
    /**
     * Lo que dijo cada servidor que no dio fuente.
     *
     * Se acumula en vez de callarse. Antes cada fallo se tiraba a la basura y,
     * si ninguno servía, la lista vacía salía como un éxito: el 429 del sitio
     * —el motivo real, y el único que se puede contar— llegaba a la interfaz
     * convertido en «el proveedor no dio ninguna fuente».
     */
    const fallos: string[] = []

    for (const reproductor of reproductores(html)) {
      const servidor = servidorDe(reproductor)

      try {
        const fuente = await fuenteDeJugador(reproductor, url, options)
        if (fuente === undefined) {
          fallos.push(`${servidor}: sin archivo reproducible`)
          continue
        }

        // Dos servidores pueden devolver el mismo flujo con firmas distintas; la
        // firma cambia, el flujo no, así que la clave ignora la cadena de consulta.
        const clave = fuente.url.split('?')[0] ?? fuente.url
        if (vistos.has(clave)) continue

        vistos.add(clave)
        fuentes.push(fuente)
      } catch (causa) {
        // Un servidor caído no puede dejar el episodio sin los otros, pero su
        // motivo se guarda: cuando no queda ninguno, es lo único que explica qué
        // pasó.
        fallos.push(`${servidor}: ${motivoDe(causa)}`)
      }
    }

    if (fuentes.length === 0) {
      throw new Error(
        `jkanime no dio ninguna fuente para ${request.episodeRef.value}` +
          (fallos.length === 0
            ? ' (la página del episodio no trae reproductores; el sitio cambió o está bloqueando)'
            : ` (${fallos.join('; ')})`),
      )
    }

    return fuentes
  },

  async getTrending(options) {
    const html = await cuerpo(await pedir(`${BASE}/top`, options))

    return tendencias(html)
  },

  async getFeed(options) {
    const html = await cuerpo(await pedir(BASE, options))

    return novedades(html, new Date())
  },
}

export default jkanime

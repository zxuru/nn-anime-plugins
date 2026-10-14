/**
 * Proveedor de Cuevana 3 (cuevana3play.pro): películas y series en español.
 *
 * El sitio es un **escaparate de TMDB**: su catálogo, su buscador y sus fichas
 * se pintan en el navegador pidiendo a `api.themoviedb.org` con una clave que el
 * propio sitio publica en su JavaScript, y la URL de cada título es el
 * identificador de TMDB disfrazado con una sustitución de dígitos
 * (`/pelicula/avatar-a11pp` es TMDB `76600`). El video no lo sirve el sitio: la
 * página de reproducción construye la dirección de cada uno de sus seis
 * servidores a partir de ese mismo identificador y los mete en un `<iframe>`.
 *
 * Eso decide el diseño de este archivo: se habla el mismo idioma que el sitio
 * —TMDB— para buscar y para la ficha, y se le piden los enlaces a los servidores
 * que el sitio declara, en su mismo orden. Nada de esto ejecuta JavaScript del
 * sitio: la clave de TMDB se **lee en tiempo de ejecución** del propio bundle del
 * sitio (nunca se guarda ni se escribe aquí), el disfraz del identificador se
 * descifra con una tabla, y cada servidor se resuelve con peticiones y
 * expresiones regulares.
 *
 * Lo que este plugin **no** hace: no guarda credenciales, no descarga ni aloja
 * contenido, y no toca ningún archivo de la máquina de quien lo copia.
 *
 * Medido en vivo: el 13 de octubre de 2026, contra el sitio y contra sus seis
 * servidores. Lo que se pudo resolver de punta a punta —y lo que no— está dicho
 * servidor por servidor en `SERVIDORES`, porque un servidor que se anuncia y no
 * se resuelve es peor que uno que no está.
 */

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

const ID = 'cuevana3'

/** La dirección del sitio, con su puerta trasera: estos dominios se mudan. */
const BASE_POR_DEFECTO = 'https://cuevana3play.pro'
const VARIABLE_DE_ENTORNO = 'NN_ANIME_CUEVANA3_URL'

/**
 * La página de la que se lee la clave de TMDB.
 *
 * No vale la portada: la portada es una *landing* y no carga el bundle de
 * anuncios donde vive esa clave. Las de listado sí, y `/inicio` es la más estable
 * de ellas. La segunda es el respaldo por si la primera cambia de forma.
 */
const PAGINAS_DE_CLAVE = ['/inicio', '/ultimas-peliculas'] as const

/** TMDB es la fuente del sitio para el catálogo, no un añadido de este plugin. */
const TMDB = 'https://api.themoviedb.org/3'
const IMAGENES_TMDB = 'https://image.tmdb.org/t/p/w500'

const AGENTE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0'

/** El idioma con el que el propio sitio pide a TMDB: español latinoamericano. */
const IDIOMA = 'es-MX'

/**
 * El disfraz del identificador de TMDB, tal como lo escribe el sitio.
 *
 * Son tres tablas: la página de la ficha usa la «alterna» para enlazar y la de
 * reproducción prueba las tres al leer, porque los enlaces viejos sobreviven con
 * la tabla con la que se crearon. Aquí se escribe con la alterna —para que una
 * referencia se pueda pegar tal cual en el sitio— y se lee con las tres.
 */
const TABLA_ALTERNA: Readonly<Record<string, string>> = {
  0: 'p',
  1: 's',
  2: 'v',
  3: 'k',
  4: 'd',
  5: '6',
  6: '1',
  7: 'a',
  8: '9',
  9: '3',
}

const TABLAS: readonly Readonly<Record<string, string>>[] = [
  // «primaria»: la que usa la página de reproducción al escribir.
  { 0: 'z', 1: '9', 2: '3', 3: '7', 4: 'g', 5: 'a', 6: 'i', 7: 'm', 8: 'v', 9: 'q' },
  TABLA_ALTERNA,
  // «legacy»: enlaces de antes de que hubiera tablas con nombre.
  { 0: 'f', 1: '7', 2: '3', 3: '8', 4: 'u', 5: 'C', 6: 'b', 7: '5', 8: '2', 9: 'W' },
]

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
 * Credenciales que viajan dentro de una dirección, y que no pueden salir en el
 * texto de un fallo.
 *
 * Aquí no es un detalle: la clave de TMDB va en la consulta de cada petición, así
 * que un 401, un 429 o un corte de red bastaban para que el mensaje de error
 * llevara la clave dentro. El motor que carga este plugin redacta **por nombre de
 * clave**, y su propio registro avisa de que una credencial metida dentro de una
 * cadena no la ve nadie más que quien la escribe: la responsabilidad es de este
 * archivo. La firma del manifiesto de VixSrc viaja igual —`token`, `expires`— y
 * tampoco debe acabar en una captura de pantalla.
 */
const CREDENCIAL_EN_URL = /([?&](?:api_key|apikey|key|token|expires|asn|signature|sig|hash|auth)=)[^&#\s]*/gi

function sinCredenciales(url: string): string {
  return url.replace(CREDENCIAL_EN_URL, '$1[redactado]')
}

/**
 * Destinos que un reproductor de internet no necesita y una página hostil sí.
 *
 * La dirección de la siguiente petición la elige el contenido del sitio —el
 * `<script src>` del bundle, la dirección del reproductor que devuelve su API—,
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
 * Una dirección sólo se acepta si es http o https con host.
 *
 * El esquema se comprueba aquí y no en el motor por lo mismo que se redacta la
 * clave aquí: `new URL(valor, base)` convierte `javascript:` y `data:` en una
 * dirección perfectamente válida, y lo que este archivo devuelve no debería
 * depender de que otro lo revise.
 */
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

/* ------------------------------------------------------------------ peticiones */

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
  readonly referer?: string
  readonly cabeceras?: Readonly<Record<string, string>>
  /**
   * Un estado que no sea 2xx no siempre es un fallo del transporte.
   *
   * La API de MoviesAPI contesta 404 con un JSON que dice «Movie not yet
   * encoded»: es un título que está en su catálogo y todavía no tiene archivo, y
   * ese motivo es justo lo que hay que contarle a quien lo sufre, no un «respondió
   * 404» que parece un error del plugin.
   */
  readonly tolerarEstado?: boolean
}

/** Lo que se le dice a quien se encuentre un dominio caído, que aquí es lo normal. */
const SUGERENCIA = `si el sitio se mudó, apunta el dominio nuevo en ${VARIABLE_DE_ENTORNO}`

/**
 * Una petición que falla con el estado y la dirección delante, no con un `fetch` roto.
 *
 * Un «The operation timed out» a secas no dice a quién se le pidió ni qué hacer;
 * el mensaje nombra el host y la variable de entorno que lo cambia. La
 * cancelación del usuario no es un dominio caído y se deja pasar tal cual.
 */
async function pedir(
  url: string,
  opciones: CallOptions,
  extra: ExtraDePeticion = {},
  acepta = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
): Promise<PluginResponse> {
  let respuesta: PluginResponse
  try {
    respuesta = await redDe(opciones)(url, {
      headers: {
        accept: acepta,
        'accept-language': 'es-MX,es;q=0.9',
        'user-agent': AGENTE,
        ...(extra.referer === undefined ? {} : { referer: extra.referer }),
        ...extra.cabeceras,
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

/* --------------------------------------------------------------- el disfraz */

/**
 * El identificador de TMDB, disfrazado como lo escribe el sitio.
 *
 * Cada dígito se sustituye por el carácter que le toca en la tabla, y algunas
 * entradas de la tabla son **otro dígito** (en la alterna, el 5 es `6` y el 6 es
 * `1`), así que un identificador puede salir entero de cifras: `56` da `61`. Sin
 * una marca, `61` no se distinguiría de un identificador que ya venía disfrazado,
 * y por eso el sitio le pone una `x` delante cuando eso pasa. Ninguna tabla
 * escribe una `x`, así que la marca nunca se confunde con un dígito.
 */
function disfrazar(id: number): string {
  const cifras = String(id)
  const letras = [...cifras].map((cifra) => TABLA_ALTERNA[cifra] ?? cifra).join('')

  return /^\d+$/.test(letras) ? `x${letras}` : letras
}

/**
 * El identificador de TMDB, desdisfrazado.
 *
 * Se prueban las tres tablas en orden, igual que la página de reproducción del
 * sitio: la primera que devuelva sólo dígitos es la que se usó. Devuelve
 * `undefined` cuando ninguna vale, que es un enlace que ya no significa nada.
 */
function desdisfrazar(token: string): number | undefined {
  const limpio = token.startsWith('x') && token.length > 1 ? token.slice(1) : token

  for (const tabla of TABLAS) {
    const inversa = new Map(Object.entries(tabla).map(([cifra, letra]) => [letra, cifra]))
    let salida = ''
    let vale = true

    for (const letra of limpio) {
      const cifra = inversa.get(letra)
      if (cifra === undefined) {
        vale = false
        break
      }

      salida += cifra
    }

    if (vale && /^\d+$/.test(salida)) {
      const numero = Number(salida)
      if (Number.isSafeInteger(numero) && numero > 0) return numero
    }
  }

  return undefined
}

/** El `slug` de un título, tal como lo escribe el sitio en sus direcciones. */
function aSlug(titulo: string): string {
  return titulo
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/* ------------------------------------------------------------------- la clave */

/**
 * La clave de TMDB que el sitio publica en su propio JavaScript.
 *
 * El sitio la lleva ofuscada en base64 dentro del bundle de su reproductor de
 * anuncios, que aparece enlazado en las páginas de listado. Aquí se lee de ahí
 * **en cada arranque del proceso y no se escribe en ninguna parte**: es la misma
 * regla que se pone este repositorio —nada de credenciales guardadas— y además
 * es lo único que sobrevive a que el sitio la cambie.
 *
 * Se busca el bundle por su dirección en la página, no por su nombre: los
 * nombres llevan una marca de compilación y cambian.
 */
async function claveTmdb(opciones: CallOptions): Promise<string> {
  const fallos: string[] = []

  const anfitrion = new URL(base()).host

  for (const pagina of PAGINAS_DE_CLAVE) {
    const html = await cuerpo(await pedir(`${base()}${pagina}`, opciones))

    const bundles = [
      ...new Set(
        [...html.matchAll(/<script[^>]+src="([^"]+)"/gi)]
          .map((encontrado) => encontrado[1] ?? '')
          .filter((src) => src.includes('smartlinks') && !src.includes('load-smartlinks')),
      ),
    ]

    for (const src of bundles) {
      let direccion: URL
      try {
        direccion = new URL(src, `${base()}/`)
      } catch {
        fallos.push(`${sinCredenciales(src)}: no es una dirección`)
        continue
      }

      // El bundle sale de un `<script src>` de la página: se lee del propio sitio
      // y de ningún otro. Los suyos son rutas de su host —medido—, así que un
      // `<script src="https://otro.example/…">` no se pide.
      if (direccion.host !== anfitrion || !destinoDeContenidoAceptable(direccion.href)) {
        fallos.push(`${sinCredenciales(src)}: no es un bundle del sitio`)
        continue
      }

      let bundle: string
      try {
        bundle = await cuerpo(await pedir(direccion.href, opciones))
      } catch (causa) {
        fallos.push(
          `${sinCredenciales(src)}: ${causa instanceof Error ? causa.message : String(causa)}`,
        )
        continue
      }

      const codificada = /ADSKEY\s*:\s*atob\(\s*"([^"]+)"\s*\)/.exec(bundle)?.[1]
      if (codificada === undefined) continue

      const clave = Buffer.from(codificada, 'base64').toString('utf8').trim()
      if (/^[0-9a-f]{32}$/.test(clave)) return clave

      fallos.push(`${src}: la clave no tiene forma de clave`)
    }
  }

  throw new Error(
    `Cuevana 3 ya no publica su clave de TMDB en las páginas de listado` +
      `${fallos.length === 0 ? '' : ` (${fallos.join('; ')})`}; el buscador necesita esa clave`,
  )
}

/* ------------------------------------------------------------------ TMDB */

interface RespuestaTmdb {
  readonly results?: readonly FilaTmdb[]
  readonly [clave: string]: unknown
}

interface FilaTmdb {
  readonly id?: number
  readonly title?: string
  readonly name?: string
  readonly release_date?: string
  readonly first_air_date?: string
  readonly poster_path?: string | null
  readonly overview?: string
  readonly number_of_episodes?: number
  readonly seasons?: readonly { season_number?: number }[]
  readonly genres?: readonly { name?: string }[]
  readonly production_companies?: readonly { name?: string }[]
  readonly episodes?: readonly { episode_number?: number; name?: string }[]
}

/** Una consulta a TMDB, con la clave que se acaba de leer. */
async function tmdb(
  ruta: string,
  clave: string,
  opciones: CallOptions,
  parametros: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const url = `${TMDB}${ruta}?${new URLSearchParams({
    api_key: clave,
    language: IDIOMA,
    ...parametros,
  }).toString()}`

  const respuesta = await pedir(url, opciones, {}, 'application/json')
  const crudo = await cuerpo(respuesta)
  try {
    return JSON.parse(crudo) as Record<string, unknown>
  } catch {
    throw new Error('TMDB devolvió algo que no es JSON')
  }
}

/** La portada de TMDB, que es la que el sitio enseña. */
function portada(ruta: string | null | undefined): string | undefined {
  return typeof ruta === 'string' && ruta !== '' ? `${IMAGENES_TMDB}${ruta}` : undefined
}

/** El año de una fecha de TMDB (`2012-07-20`), si lo trae. */
function anioDe(fecha: string | undefined): number | undefined {
  const anio = Number(/^(\d{4})/.exec(fecha ?? '')?.[1])

  return Number.isInteger(anio) && anio > 1900 ? anio : undefined
}

/* --------------------------------------------------------------- referencias */

interface Referencia {
  readonly kind: 'movie' | 'tv'
  readonly id: number
  readonly slug: string
  readonly season?: number
  readonly episode?: number
}

/** La referencia que este plugin escribe: `pelicula/avatar-a11pp`. */
function aReferencia(kind: 'movie' | 'tv', titulo: string, id: number): string {
  return `${kind === 'movie' ? 'pelicula' : 'serie'}/${aSlug(titulo) || 'titulo'}-${disfrazar(id)}`
}

/**
 * Una referencia leída, o el motivo por el que no se pudo leer.
 *
 * El último tramo del segundo trozo es el identificador disfrazado; lo que hay
 * antes es el `slug`, que sólo sirve para que la referencia se pueda leer a ojo y
 * pegar en el sitio.
 */
function leerReferencia(valor: string): Referencia {
  const trozos = valor.split('/').filter((trozo) => trozo !== '')
  const primero = trozos[0] ?? ''
  if (primero !== 'pelicula' && primero !== 'serie') {
    throw new Error(`la referencia '${valor}' no dice si es película o serie`)
  }

  const segundo = trozos[1] ?? ''
  const corte = segundo.lastIndexOf('-')
  const token = corte < 0 ? segundo : segundo.slice(corte + 1)
  const id = desdisfrazar(token)
  if (id === undefined) {
    throw new Error(`la referencia '${valor}' no lleva un identificador de TMDB legible`)
  }

  const season = trozos[2] === 'temporada' ? Number(trozos[3]) : undefined
  const episode = trozos[4] === 'episodio' ? Number(trozos[5]) : undefined

  return {
    kind: primero === 'pelicula' ? 'movie' : 'tv',
    id,
    slug: corte < 0 ? '' : segundo.slice(0, corte),
    ...(Number.isInteger(season) ? { season } : {}),
    ...(Number.isInteger(episode) ? { episode } : {}),
  }
}

/* ------------------------------------------------- los servidores del sitio */

/**
 * La tabla de servidores, copiada del bundle del propio sitio.
 *
 * El sitio no publica esta lista en su HTML: la tiene en el JavaScript de su
 * página de reproducción, y la usa para construir la dirección del `<iframe>` de
 * cada servidor a partir del identificador de TMDB. Aquí se replica para poder
 * saltarse el `<iframe>`: un reproductor dentro de otro no lo puede abrir `mpv`,
 * y lo que este contrato pide es un archivo o un manifiesto.
 *
 * Los seis están declarados —con el orden y los nombres del sitio— aunque sólo se
 * intenten los que este archivo sabe resolver. Los que no, llevan su `motivo`
 * escrito: sin él, el fallo diría «2 de 6» y quien lo lea no sabría si los otros
 * cuatro no se han mirado o si están cerrados con llave. Lo están, y de tres
 * maneras distintas:
 *
 * - **VidCore y VidFast** son el mismo Next.js ofuscado. No tienen una ruta de
 *   API que devuelva las fuentes: la lista es el cuerpo de un `POST` cuyo token
 *   lo emite el servidor, y ese cuerpo lo descifra un **intérprete de bytecode**
 *   que vive dentro de la propia página. Sin ejecutarlo no hay lista.
 * - **VidSrc** sí se resolvió de punta a punta en el estudio: su cadena termina
 *   en un manifiesto que contesta 200, pero la lista de enlaces viene cifrada y
 *   la descifra un **módulo WebAssembly que sirve el propio sitio**. Se puede
 *   instanciar desde Node (el módulo no importa nada), y aun así **no se hace**:
 *   este plugin no ejecuta código de terceros, y un WASM opaco que no se puede
 *   interrumpir es justo lo que esa regla evita.
 * - **EmbedMaster** también se destapó: su «reto» de Cloudflare **no valida
 *   nada** —un `POST` con el campo vacío devuelve el reproductor entero—, pero
 *   las fuentes viven en un bloque de 636 KB que descifra un paquete de 30 KB de
 *   cripto ofuscada. Es el mismo caso que los dos primeros: haría falta ejecutar
 *   su código.
 */
const SERVIDORES: readonly {
  readonly nombre: string
  readonly embed: (r: Referencia) => string
  readonly servido?: boolean
  readonly motivo?: string
}[] = [
  {
    nombre: 'MoviesAPI',
    servido: true,
    embed: (r) =>
      r.kind === 'movie'
        ? `https://moviesapi.to/movie/${r.id}`
        : `https://moviesapi.to/tv/${r.id}/${r.season ?? 1}/${r.episode ?? 1}`,
  },
  {
    nombre: 'VidCore',
    motivo: 'su lista de enlaces sólo la descifra un intérprete de bytecode que vive en su página',
    embed: (r) =>
      r.kind === 'movie'
        ? `https://vidcore.io/movie/${r.id}`
        : `https://vidcore.io/tv/${r.id}/${r.season ?? 1}/${r.episode ?? 1}`,
  },
  {
    nombre: 'YapGrid',
    servido: true,
    embed: (r) =>
      r.kind === 'movie'
        ? `https://yapgrid.com/embed/movie/${r.id}`
        : `https://yapgrid.com/embed/tv/${r.id}/${r.season ?? 1}/${r.episode ?? 1}`,
  },
  {
    nombre: 'VidFast',
    motivo: 'su lista de enlaces sólo la descifra un intérprete de bytecode que vive en su página',
    embed: (r) =>
      r.kind === 'movie'
        ? `https://vidfast.vc/movie/${r.id}`
        : `https://vidfast.vc/tv/${r.id}/${r.season ?? 1}/${r.episode ?? 1}`,
  },
  {
    nombre: 'VidSrc',
    motivo:
      'su lista viene cifrada y sólo la descifra un WebAssembly del propio sitio; este plugin no ejecuta código ajeno',
    embed: (r) =>
      r.kind === 'movie'
        ? `https://vidsrc-embed.ru/embed/movie/${r.id}`
        : `https://vidsrc-embed.ru/embed/tv/${r.id}/${r.season ?? 1}/${r.episode ?? 1}`,
  },
  {
    nombre: 'EmbedMaster',
    motivo: 'sus fuentes las descifra un paquete de cripto ofuscada que corre en su página',
    embed: (r) =>
      r.kind === 'movie'
        ? `https://embedmaster.link/movie/${r.id}`
        : `https://embedmaster.link/tv/${r.id}/${r.season ?? 1}/${r.episode ?? 1}`,
  },
]

/**
 * La clave del reproductor «vidora», que MoviesAPI publica en su bundle.
 *
 * Igual que la de TMDB en el sitio: se lee en tiempo de ejecución del propio
 * JavaScript de MoviesAPI y no se guarda. No está en su portada —la portada es
 * otra página— sino en el paquete de la ficha, así que se pide la ficha del
 * propio título que se va a resolver. Se recuerda **dentro del proceso** para no
 * volver a bajarse un paquete de un megabyte en cada episodio; el contrato ya
 * avisa de que ese estado no sobrevive a un reinicio, y no hace falta que lo haga.
 */
let claveVidoraEnMemoria: string | undefined

/** El hexadecimal largo que se manda en la cabecera, dicho de tres maneras. */
function buscarClaveVidora(bundle: string): string | undefined {
  // Lo normal: `"x-player-key":fz`. El nombre de la variable lo elige el
  // minificador, así que se lee el nombre y luego su valor; buscar el valor a
  // ojo sería atarse a un nombre que cambia en cada compilación.
  const identificador = /["'`]x-player-key["'`]\s*:\s*([A-Za-z_$][\w$]*)/.exec(bundle)?.[1]
  if (identificador !== undefined) {
    const escapado = identificador.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const asignada = new RegExp(
      `(?:^|[,;{(\\s])(?:var\\s+|let\\s+|const\\s+)?${escapado}\\s*=\\s*["'\`]([0-9a-f]{32,128})["'\`]`,
      'i',
    ).exec(bundle)

    if (asignada?.[1] !== undefined) return asignada[1]
  }

  // Y si algún día la escriben en línea, o justo al lado, también vale.
  const enLinea = /["'`]x-player-key["'`]\s*:\s*["'`]([0-9a-f]{32,128})["'`]/i.exec(bundle)?.[1]
  if (enLinea !== undefined) return enLinea

  const cerca = /x-player-key["'`\s:]{0,40}["'`]([0-9a-f]{64})["'`]/i.exec(bundle)?.[1]
  if (cerca !== undefined) return cerca

  // Último recurso, y sólo si no hay duda: un único hexadecimal de 64 en todo el
  // paquete. Con dos candidatos no se elige: adivinar aquí es mandar una clave
  // equivocada y culpar al servidor.
  const todos = [...new Set([...bundle.matchAll(/["'`]([0-9a-f]{64})["'`]/gi)].map((uno) => uno[1]))]

  return todos.length === 1 ? todos[0] : undefined
}

async function claveVidora(referencia: Referencia, opciones: CallOptions): Promise<string> {
  if (claveVidoraEnMemoria !== undefined) return claveVidoraEnMemoria

  const ruta = referencia.kind === 'movie' ? `/movie/${referencia.id}` : `/tv/${referencia.id}`
  const html = await cuerpo(await pedir(`https://moviesapi.to${ruta}`, opciones))

  const bundles = [
    ...new Set(
      [...html.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/gi)]
        .map((encontrado) => encontrado[1] ?? '')
        // Una dirección rara en un `<script src>` no puede tumbar la resolución:
        // se descarta y se sigue con las demás.
        .flatMap((src) => {
          try {
            const url = new URL(src, 'https://moviesapi.to/')
            return url.host === 'moviesapi.to' ? [url.href] : []
          } catch {
            return []
          }
        }),
    ),
  ]

  for (const bundle of bundles) {
    const clave = buscarClaveVidora(await cuerpo(await pedir(bundle, opciones)))
    if (clave !== undefined) {
      claveVidoraEnMemoria = clave
      return clave
    }
  }

  throw new Error('MoviesAPI ya no publica la clave de su reproductor en el JavaScript de su ficha')
}

/**
 * Un enlace de reproducción, resuelto desde un servidor del sitio.
 *
 * MoviesAPI no pide que se abra su reproductor: su propia página llama a una API
 * en JSON que devuelve el manifiesto ya hecho, y esa llamada es la que se hace
 * aquí. El manifiesto exige el `Referer` de MoviesAPI —sin él contesta 403— y esa
 * cabecera viaja en la fuente para que el proxy la reenvíe sin que llegue al
 * navegador.
 */
async function resolverMoviesApi(
  referencia: Referencia,
  opciones: CallOptions,
): Promise<Fuente | undefined> {
  const clave = await claveVidora(referencia, opciones)
  const ruta =
    referencia.kind === 'movie'
      ? `/api/vidora/v1/movie/${referencia.id}`
      : `/api/vidora/v1/tv/${referencia.id}/${referencia.season ?? 1}/${referencia.episode ?? 1}`

  const respuesta = await pedir(
    `https://moviesapi.to${ruta}`,
    opciones,
    {
      referer: 'https://moviesapi.to/',
      cabeceras: { origin: 'https://moviesapi.to', 'x-player-key': clave },
      tolerarEstado: true,
    },
    'application/json',
  )

  let datos: {
    result?: boolean
    message?: string
    sources?: readonly { url?: string }[]
  }
  try {
    datos = JSON.parse(await cuerpo(respuesta)) as typeof datos
  } catch {
    datos = {}
  }

  // La dirección la publica la API: se normaliza antes de devolverla. El motor la
  // valida igual, pero un plugin no debe entregar una cadena que no ha mirado.
  const url = comoUrl(datos.sources?.find((fuente) => typeof fuente.url === 'string')?.url)
  if (url === undefined) {
    // El sitio dice «Movie not yet encoded» cuando el título está en su catálogo
    // pero todavía no tiene archivo: eso no es un fallo del plugin y se cuenta.
    throw new Error(datos.message ?? `la API respondió ${respuesta.status} sin fuentes`)
  }

  return { url, kind: 'hls', headers: { Referer: 'https://moviesapi.to/' } }
}

/**
 * VixSrc, el motor que YapGrid usa por defecto.
 *
 * El tercer servidor del sitio es YapGrid, que a su vez no reproduce: elige
 * entre sus propios motores —CastleTV, VixSrc, VaPlayer…— y el que trae puesto
 * por defecto es VixSrc. Así que aquí se va directo al motor y se le pide el
 * manifiesto, que es lo que YapGrid acabaría reproduciendo de todas formas.
 *
 * La cadena son tres pasos y ninguno ejecuta nada: la API da la dirección de su
 * reproductor, ese reproductor publica en su HTML el manifiesto **con sus
 * parámetros de firma**, y el manifiesto se pide con ellos. El `h=1` no es
 * decorativo: sin él contesta 403. Los segmentos y los manifiestos hijos no
 * piden ninguna cabecera, así que la fuente sale limpia.
 *
 * Lo que este motor sirve es el **audio original** con pistas de subtítulos
 * —medido en Avatar: The Way of Water, italiano e inglés, sin español—, así que
 * es un respaldo y no la primera opción para quien busca latino.
 */
async function resolverVixsrc(
  referencia: Referencia,
  opciones: CallOptions,
): Promise<Fuente | undefined> {
  const tipo =
    referencia.kind === 'movie'
      ? `movie/${referencia.id}`
      : `tv/${referencia.id}/${referencia.season ?? 1}/${referencia.episode ?? 1}`
  const pagina = `https://vixsrc.to/${tipo}`

  const respuesta = await pedir(
    `https://vixsrc.to/api/${tipo}`,
    opciones,
    { referer: pagina, tolerarEstado: true },
    'application/json',
  )
  let datos: { src?: string; error?: string }
  try {
    datos = JSON.parse(await cuerpo(respuesta)) as { src?: string; error?: string }
  } catch {
    datos = {}
  }

  if (typeof datos.src !== 'string') {
    throw new Error(datos.error ?? `la API respondió ${respuesta.status} sin dirección`)
  }

  // La dirección la da la API y `new URL(valor, base)` acepta `javascript:` y
  // `data:` sin pestañear, así que el esquema se comprueba antes de pedirla, y el
  // destino también: una API comprometida no manda este plugin a la red interna.
  let embed: string | undefined
  try {
    embed = comoUrl(new URL(datos.src, 'https://vixsrc.to/').href)
  } catch {
    embed = undefined
  }

  if (embed === undefined || !destinoDeContenidoAceptable(embed)) {
    throw new Error('el reproductor no publicó una dirección que se pueda pedir')
  }

  const html = await cuerpo(await pedir(embed, opciones, { referer: pagina }))

  const marca = html.indexOf('window.masterPlaylist')
  if (marca < 0) throw new Error('el reproductor no publicó su manifiesto; el marcado cambió')

  const bloque = html.slice(marca, marca + 1400)
  // Las claves del objeto van entrecomilladas unas veces y desnudas otras
  // —`'token': '…'` pero `url: '…'`—, así que las comillas son opcionales en las
  // cuatro.
  const url = /['"]?url['"]?\s*:\s*'([^']+)'/.exec(bloque)?.[1]
  const token = /['"]?token['"]?\s*:\s*'([^']+)'/.exec(bloque)?.[1]
  const expires = /['"]?expires['"]?\s*:\s*'([^']+)'/.exec(bloque)?.[1]
  const asn = /['"]?asn['"]?\s*:\s*'([^']*)'/.exec(bloque)?.[1]
  if (url === undefined || token === undefined || expires === undefined) {
    throw new Error('el reproductor publicó un manifiesto sin firma')
  }

  // La lista de servidores trae dos puertas al mismo manifiesto; se elige la que
  // el propio reproductor deja marcada como activa.
  let lista: readonly { url?: string; active?: boolean }[] = []
  try {
    lista = JSON.parse(/window\.streams\s*=\s*(\[[\s\S]*?\]);/.exec(html)?.[1] ?? '[]')
  } catch {
    lista = []
  }

  const declarada = (lista.find((uno) => uno.active === true) ?? lista[0])?.url
  const puerta = comoUrl(typeof declarada === 'string' ? declarada : undefined)
  if (puerta === undefined) {
    throw new Error('el reproductor no publicó ninguna dirección de manifiesto')
  }

  const firma = new URLSearchParams({ token, expires, h: '1', lang: 'en' })
  if (asn !== undefined && asn !== '') firma.set('asn', asn)

  return { url: `${puerta}${puerta.includes('?') ? '&' : '?'}${firma.toString()}`, kind: 'hls' }
}

/** El resolutor de cada servidor declarado como `servido`. */
const RESOLUTORES: Readonly<Record<string, (r: Referencia, o: CallOptions) => Promise<Fuente | undefined>>> = {
  MoviesAPI: resolverMoviesApi,
  YapGrid: resolverVixsrc,
}

/* ------------------------------------------------------------------ proveedor */

const proveedor: Provider = {
  id: ID,
  name: 'Cuevana 3',
  apiVersion: '1',
  /*
   * Películas y series. Subtitulado sí: los servidores de este sitio entregan el
   * audio original con subtítulos en español (`&sub=es`, `&ds_lang=es`), no un
   * doblaje. Declarar `dub` ofrecería un botón que promete latino y da subtítulos.
   */
  capabilities: { search: true, sub: true, dub: false, trending: false, feed: false },

  /**
   * La búsqueda, contra el mismo TMDB que consulta el sitio.
   *
   * El buscador del sitio es JavaScript puro: su página `?q=` llega vacía al
   * cliente, así que no hay HTML que rastrear. Se piden las dos mitades —cine y
   * televisión— a la vez, y cada resultado viaja ya con su tipo, que es lo que
   * evita la petición extra que hace falta cuando el tipo no viene en el listado.
   */
  async search(query, opciones) {
    const texto = query.trim()
    if (texto === '') return []

    const clave = await claveTmdb(opciones)
    const [cine, television] = await Promise.all([
      tmdb('/search/movie', clave, opciones, { query: texto, include_adult: 'false' }),
      tmdb('/search/tv', clave, opciones, { query: texto, include_adult: 'false' }),
    ])

    const salida: Acierto[] = []
    // La clave lleva el tipo: los identificadores de TMDB son dos secuencias
    // distintas —cine y televisión— y el 1399 de una no es el de la otra, así que
    // deduplicar sólo por número tiraría una serie por culpa de una película.
    const vistos = new Set<string>()

    const anadir = (filas: readonly FilaTmdb[] | undefined, kind: 'movie' | 'tv'): void => {
      for (const fila of filas ?? []) {
        const id = fila.id
        const titulo = (kind === 'movie' ? fila.title : fila.name)?.trim()
        if (typeof id !== 'number' || titulo === undefined || titulo === '') continue
        if (vistos.has(`${kind}:${id}`)) continue

        vistos.add(`${kind}:${id}`)
        const anio = anioDe(kind === 'movie' ? fila.release_date : fila.first_air_date)
        const imagen = portada(fila.poster_path)

        salida.push({
          ref: { providerId: ID, value: aReferencia(kind, titulo, id) },
          title: titulo,
          kind,
          ...(imagen === undefined ? {} : { coverUrl: imagen }),
          ...(anio === undefined ? {} : { year: anio }),
        })
      }
    }

    anadir((cine as RespuestaTmdb).results, 'movie')
    anadir((television as RespuestaTmdb).results, 'tv')

    return salida
  },

  /**
   * La ficha, de TMDB y no de la página del sitio.
   *
   * La página del título llega al cliente como un armazón: su título, su portada
   * y su sinopsis los escribe el navegador después de preguntarle a TMDB. Leerla
   * con un `fetch` devolvería las etiquetas genéricas, así que se le pregunta a la
   * misma fuente que el sitio, con el mismo idioma.
   */
  async getAnime(ref, opciones): Promise<Ficha> {
    const referencia = leerReferencia(ref.value)
    const clave = await claveTmdb(opciones)
    const datos = (await tmdb(
      `/${referencia.kind}/${referencia.id}`,
      clave,
      opciones,
    )) as FilaTmdb & Record<string, unknown>

    const titulo = (referencia.kind === 'movie' ? datos.title : datos.name)?.trim()
    if (titulo === undefined || titulo === '') {
      throw new Error(
        `TMDB no tiene ficha para ${referencia.kind} ${referencia.id}; el título pudo retirarse`,
      )
    }

    const anio = anioDe(
      referencia.kind === 'movie'
        ? (datos.release_date as string | undefined)
        : (datos.first_air_date as string | undefined),
    )
    const imagen = portada(datos.poster_path)
    const sinopsis = typeof datos.overview === 'string' ? datos.overview.trim() : ''
    const generos = (datos.genres ?? [])
      .map((genero) => genero.name?.trim() ?? '')
      .filter((nombre) => nombre !== '')
    const estudios = (datos.production_companies ?? [])
      .map((empresa) => empresa.name?.trim() ?? '')
      .filter((nombre) => nombre !== '')

    return {
      ref,
      title: titulo,
      kind: referencia.kind,
      ...(imagen === undefined ? {} : { coverUrl: imagen }),
      ...(sinopsis === '' ? {} : { synopsis: sinopsis }),
      ...(anio === undefined ? {} : { year: anio }),
      ...(referencia.kind === 'tv' && typeof datos.number_of_episodes === 'number'
        ? { episodeCount: datos.number_of_episodes }
        : {}),
      genres: generos,
      studios: estudios,
    }
  },

  /**
   * Los episodios: una película es un episodio, y una serie es su catálogo entero.
   *
   * La numeración de una serie es **corrida** entre temporadas y el par
   * temporada/capítulo va en el título, porque `Episode` no tiene campo de
   * temporada y el número es la identidad de la fila: dos temporadas con un
   * «capítulo 1» cada una serían el mismo episodio para la interfaz. El par sí
   * viaja en la referencia, que es lo que el resolutor necesita después.
   */
  async getEpisodes(ref, opciones): Promise<readonly Episodio[]> {
    const referencia = leerReferencia(ref.value)

    if (referencia.kind === 'movie') {
      return [{ ref: { providerId: ID, value: ref.value }, animeRef: ref, number: 1, mode: 'sub' }]
    }

    const clave = await claveTmdb(opciones)
    const ficha = (await tmdb(`/tv/${referencia.id}`, clave, opciones)) as FilaTmdb
    const temporadas = (ficha.seasons ?? [])
      .map((temporada) => temporada.season_number)
      .filter((numero): numero is number => typeof numero === 'number' && numero > 0)
      .sort((a, b) => a - b)

    if (temporadas.length === 0) {
      throw new Error(`TMDB no lista ninguna temporada de la serie ${referencia.id}`)
    }

    const salida: Episodio[] = []

    for (const temporada of temporadas) {
      const detalle = (await tmdb(
        `/tv/${referencia.id}/season/${temporada}`,
        clave,
        opciones,
        {},
      )) as FilaTmdb

      for (const episodio of detalle.episodes ?? []) {
        const numero = episodio.episode_number
        if (typeof numero !== 'number') continue

        const nombre = episodio.name?.trim() ?? ''
        const generico = new RegExp(`^(?:Episode|Episodio)\\s*${numero}$`, 'i').test(nombre)

        salida.push({
          ref: {
            providerId: ID,
            value: `${ref.value}/temporada/${temporada}/episodio/${numero}`,
          },
          animeRef: ref,
          number: salida.length + 1,
          title: nombre === '' || generico ? `T${temporada} E${numero}` : `T${temporada} E${numero} · ${nombre}`,
          mode: 'sub',
        })
      }
    }

    if (salida.length === 0) {
      throw new Error(`TMDB no listó ningún episodio de la serie ${referencia.id}`)
    }

    return salida
  },

  /**
   * El enlace de video, que es donde está todo el trabajo.
   *
   * El sitio no sirve el video: monta un `<iframe>` por servidor. Un reproductor
   * dentro de otro no lo abre `mpv`, así que se visita cada servidor que este
   * archivo sabe resolver y se devuelve el manifiesto de verdad. Cada servidor se
   * cae solo: el motivo de cada fallo se guarda y se cuenta al final, porque «no
   * dio ninguna fuente» a secas no se puede arreglar desde fuera.
   *
   * El `mode` que llega **no se mira, y es a propósito**: los dos servidores que
   * se resuelven entregan el audio original con subtítulos, sin ofrecer doblaje,
   * así que no hay nada que elegir. Mirarlo daría a entender que hay una versión
   * doblada esperando detrás, y es justo lo que `capabilities.dub` ya dice que no.
   */
  async resolveStream(peticion, opciones): Promise<readonly Fuente[]> {
    const referencia = leerReferencia(peticion.episodeRef.value)
    const fallos: string[] = []

    for (const servidor of SERVIDORES) {
      if (servidor.servido !== true) continue

      const resolver = RESOLUTORES[servidor.nombre]
      if (resolver === undefined) continue

      try {
        const fuente = await resolver(referencia, opciones)
        if (fuente === undefined) {
          fallos.push(`${servidor.nombre}: no dio ningún archivo`)
          continue
        }

        return [fuente]
      } catch (causa) {
        fallos.push(`${servidor.nombre}: ${causa instanceof Error ? causa.message : String(causa)}`)
      }
    }

    const declarados = SERVIDORES.filter((servidor) => servidor.servido !== true)
    const sinResolver = declarados
      .map((servidor) => `${servidor.nombre}: ${servidor.motivo ?? 'sin resolutor'}`)
      .join('; ')

    throw new Error(
      `Cuevana 3 no dio ninguna fuente para ${peticion.episodeRef.value} ` +
        `(intentados ${SERVIDORES.length - declarados.length} de ${SERVIDORES.length} servidores: ` +
        `${fallos.join('; ') || 'ninguno'} · no intentados — ${sinResolver})`,
    )
  },
}

export default proveedor
